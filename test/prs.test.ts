import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { PR_BATCH, PR_MAX_BACKOFF_MS, PR_REPORT_FRESH_MS, PrTracker, RATE_FLOOR, parsePrUrl, type PrChange } from "../server/prs.js"
import type { TaskStatus } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

type Gh = { state: "OPEN" | "CLOSED" | "MERGED"; isDraft?: boolean; mergedAt?: string | null; mergedBy?: { login: string } | null }

/** A fake GitHub GraphQL endpoint: PRs by "owner/name#number", plus a log of what each request asked for. */
function fakeGithub() {
  const prs = new Map<string, Gh>()
  const calls: { token: string; asked: string[] }[] = []
  let remaining = 4000
  let fail: Response | null = null
  /** Answers for one token only ("Bearer <token>"), like a revoked project token. */
  const failFor = new Map<string, Response>()
  /** Repos ("owner/name") a token can't see: GitHub answers NOT_FOUND for them. */
  const hidden = new Map<string, Set<string>>()
  const fetch = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string | number> }
    const n = Object.keys(variables).filter((k) => k.startsWith("p")).length
    const asked = Array.from({ length: n }, (_, i) => `${variables[`o${i}`]}/${variables[`n${i}`]}#${variables[`p${i}`]}`)
    const token = String((init.headers as Record<string, string>).Authorization)
    calls.push({ token, asked })
    if (fail) return fail.clone()
    if (failFor.has(token)) return failFor.get(token)!.clone()
    const data: Record<string, unknown> = { rateLimit: { remaining, resetAt: new Date(Date.now() + 30 * 60_000).toISOString() } }
    const errors: unknown[] = []
    asked.forEach((key, i) => {
      const repo = key.split("#")[0]!
      if (hidden.get(token)?.has(repo)) {
        data[`p${i}`] = null
        errors.push({ type: "NOT_FOUND", path: [`p${i}`], message: `Could not resolve to a Repository with the name '${repo}'.` })
      } else data[`p${i}`] = prs.has(key) ? { pullRequest: prs.get(key) } : null
    })
    return new Response(JSON.stringify({ data, ...(errors.length ? { errors } : {}) }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  return {
    prs,
    calls,
    fetch,
    hidden,
    setRemaining: (n: number) => (remaining = n),
    failWith: (res: Response | null) => (fail = res),
    failFor: (token: string, res: Response | null) => (res ? failFor.set(`Bearer ${token}`, res) : failFor.delete(`Bearer ${token}`)),
  }
}

function setup(opts: { token?: (projectId: string) => string | null; now?: () => number; autoDone?: () => boolean } = {}) {
  const store = new Store(openDb(tmpDir()))
  const gh = fakeGithub()
  const changes: PrChange[] = []
  const logs: string[] = []
  const project = store.createProject({ name: "site" })
  const tracker = new PrTracker({ store, token: opts.token ?? (() => "tok"), fetch: gh.fetch, now: opts.now, autoDone: opts.autoDone, onChange: (c) => changes.push(c), log: (m) => logs.push(m) })
  const task = (n: number, status: TaskStatus = "pr_ready", extra: Parameters<Store["updateTask"]>[1] = {}) => {
    const t = store.createTask({ projectId: project.id, title: `Task ${n}`, prompt: "p" })
    store.updateTask(t.id, { status, prUrl: `https://github.com/acme/site/pull/${n}`, ...extra }, { quiet: true })
    return t.id
  }
  return { store, gh, changes, tracker, task, project, logs }
}

describe("parsePrUrl", () => {
  it("reads GitHub pull request URLs", () => {
    expect(parsePrUrl("https://github.com/webdevcody/box-yard/pull/23")).toEqual({ owner: "webdevcody", name: "box-yard", number: 23 })
    expect(parsePrUrl("https://github.com/a/b/pull/7/files")).toEqual({ owner: "a", name: "b", number: 7 })
    expect(parsePrUrl("https://gitlab.com/a/b/-/merge_requests/1")).toBeNull()
    expect(parsePrUrl(null)).toBeNull()
  })
})

describe("PR state tracking", () => {
  it("open → merged moves a pr_ready task to done and notifies", async () => {
    const { store, gh, changes, tracker, task } = setup()
    const id = task(23)
    gh.prs.set("acme/site#23", { state: "OPEN" })
    await tracker.pollAll()
    expect(store.getTask(id)).toMatchObject({ status: "pr_ready", prState: "open" })
    expect(store.listNotifications()).toHaveLength(0)

    gh.prs.set("acme/site#23", { state: "MERGED", mergedAt: "2026-10-22T12:00:00Z", mergedBy: { login: "cody" } })
    await tracker.pollAll()
    expect(store.getTask(id)).toMatchObject({ status: "done", prState: "merged", prMergedAt: Date.parse("2026-10-22T12:00:00Z"), prMergedBy: "cody" })
    expect(changes.at(-1)).toMatchObject({ taskId: id, prev: "open", status: "done" })
    const [n] = store.listNotifications()
    expect(n).toMatchObject({ taskId: id, status: "done", summary: "PR #23 merged by cody" })
  })

  it("closed unmerged drops pr_ready to idle without a notification", async () => {
    const { store, gh, tracker, task } = setup()
    const id = task(5, "pr_ready", { prState: "open" })
    gh.prs.set("acme/site#5", { state: "CLOSED" })
    await tracker.pollAll()
    expect(store.getTask(id)).toMatchObject({ status: "idle", prState: "closed" })
    expect(store.listNotifications()).toHaveLength(0)
  })

  it("leaves working and needs-input tasks alone, but still records the PR state", async () => {
    const { store, gh, tracker, task } = setup()
    const working = task(1, "working", { currentTurnId: "turn_1" })
    const asking = task(2, "needs_input")
    const finished = task(3, "done")
    gh.prs.set("acme/site#1", { state: "MERGED" })
    gh.prs.set("acme/site#2", { state: "MERGED" })
    gh.prs.set("acme/site#3", { state: "CLOSED" })
    await tracker.pollAll()
    expect(store.getTask(working)).toMatchObject({ status: "working", prState: "merged" })
    expect(store.getTask(asking)).toMatchObject({ status: "needs_input", prState: "merged" })
    expect(store.getTask(finished)).toMatchObject({ status: "done", prState: "closed" })
  })

  it("a merge moves a resting idle task to done too, but never one whose turn is running or that waits on Cody", async () => {
    const { store, gh, tracker, task, changes } = setup()
    const idle = task(1, "idle", { prState: "open" })
    const busyIdle = task(2, "idle", { prState: "open", currentTurnId: "turn_2" })
    const waiting = task(3, "waiting", { prState: "open" })
    const failed = task(4, "failed", { prState: "open" })
    for (const n of [1, 2, 3, 4]) gh.prs.set(`acme/site#${n}`, { state: "MERGED" })
    await tracker.pollAll()
    expect([idle, busyIdle, waiting, failed].map((id) => store.getTask(id)!.status)).toEqual(["done", "idle", "waiting", "failed"])
    expect(changes.find((c) => c.taskId === idle)).toMatchObject({ status: "done" })
    expect(store.listNotifications().map((n) => n.taskId)).toEqual([idle])
  })

  it("with autoDoneOnMerge off, a merge leaves a pr_ready task idle and an idle one as it is", async () => {
    let on = false
    const { store, gh, tracker, task } = setup({ autoDone: () => on })
    const ready = task(1, "pr_ready", { prState: "open" })
    const idle = task(2, "idle", { prState: "open" })
    for (const n of [1, 2]) gh.prs.set(`acme/site#${n}`, { state: "MERGED" })
    await tracker.pollAll()
    expect([ready, idle].map((id) => store.getTask(id))).toMatchObject([
      { status: "idle", prState: "merged" },
      { status: "idle", prState: "merged" },
    ])
    expect(store.listNotifications()).toHaveLength(0)
    // Read at each change, not once.
    on = true
    const later = task(3, "pr_ready", { prState: "open" })
    gh.prs.set("acme/site#3", { state: "MERGED" })
    await tracker.pollAll()
    expect(store.getTask(later)!.status).toBe("done")
  })

  it("draft PRs are tracked as draft and keep polling", async () => {
    const { store, gh, tracker, task } = setup()
    const id = task(9)
    gh.prs.set("acme/site#9", { state: "OPEN", isDraft: true })
    await tracker.pollAll()
    await tracker.pollAll()
    expect(store.getTask(id)).toMatchObject({ status: "pr_ready", prState: "draft" })
    expect(gh.calls).toHaveLength(2)
  })

  it("stops polling a PR once it is merged or closed", async () => {
    const { gh, tracker, task } = setup()
    task(1)
    task(2)
    task(3)
    gh.prs.set("acme/site#1", { state: "MERGED" })
    gh.prs.set("acme/site#2", { state: "CLOSED" })
    gh.prs.set("acme/site#3", { state: "OPEN" })
    await tracker.pollAll()
    expect(gh.calls[0]!.asked).toEqual(["acme/site#1", "acme/site#2", "acme/site#3"])
    await tracker.pollAll()
    expect(gh.calls[1]!.asked).toEqual(["acme/site#3"])
    gh.prs.set("acme/site#3", { state: "MERGED" })
    await tracker.pollAll()
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(3) // nothing left to ask about: no request at all
  })

  it("backfills old PRs quietly: no notification and no bump of the last-active time", async () => {
    const { store, gh, tracker, task } = setup()
    const old = task(1, "done")
    const before = store.getTask(old)!.updatedAt
    const stale = task(23) // pr_ready, never checked (like PR #23 in Cody's screenshot)
    gh.prs.set("acme/site#1", { state: "MERGED" })
    gh.prs.set("acme/site#23", { state: "MERGED" })
    await new Promise((r) => setTimeout(r, 5))
    await tracker.pollAll()
    expect(store.getTask(old)).toMatchObject({ status: "done", prState: "merged", updatedAt: before })
    expect(store.getTask(stale)).toMatchObject({ status: "done", prState: "merged" })
    expect(store.listNotifications()).toHaveLength(0)
  })

  it("batches PRs into one query per token, in chunks", async () => {
    const tokens: Record<string, string> = {}
    const { gh, tracker, task, store } = setup({ token: (projectId) => tokens[projectId] ?? "tok" })
    for (let i = 1; i <= PR_BATCH + 2; i++) task(i)
    const other = store.createProject({ name: "other" })
    tokens[other.id] = "tok2"
    const t = store.createTask({ projectId: other.id, title: "x", prompt: "p" })
    store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/other/pull/1" })
    await tracker.pollAll()
    expect(gh.calls.map((c) => [c.token, c.asked.length])).toEqual([
      ["Bearer tok", PR_BATCH],
      ["Bearer tok", 2],
      ["Bearer tok2", 1],
    ])
  })

  it("skips projects without a token (mock mode)", async () => {
    const { gh, tracker, task } = setup({ token: () => null })
    task(1)
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(0)
  })

  it("backs off on errors and recovers, per token", async () => {
    let now = Date.now()
    const { gh, tracker, task } = setup({ now: () => now })
    task(1)
    gh.prs.set("acme/site#1", { state: "OPEN" })
    gh.failWith(new Response("boom", { status: 502 }))
    await tracker.pollAll()
    expect(tracker.tokenHealth("tok")).toMatchObject({ failures: 1, retryAt: now + 120_000 })
    await tracker.pollAll() // backing off: no request
    expect(gh.calls).toHaveLength(1)
    for (let i = 0; i < 8; i++) {
      now = tracker.tokenHealth("tok").retryAt
      await tracker.pollAll()
    }
    expect(tracker.tokenHealth("tok").retryAt - now).toBe(PR_MAX_BACKOFF_MS)
    gh.failWith(null)
    now = tracker.tokenHealth("tok").retryAt
    await tracker.pollAll()
    expect(tracker.tokenHealth("tok")).toMatchObject({ failures: 0, retryAt: 0 })
  })

  it("one project's broken or rate-limited token never holds back another project's PRs", async () => {
    const tokens: Record<string, string> = {}
    const { store, gh, tracker, task } = setup({ token: (projectId) => tokens[projectId] ?? "tok" })
    // The broken token's PR is the oldest, so it comes first in every round.
    const other = store.createProject({ name: "other" })
    tokens[other.id] = "bad"
    const t = store.createTask({ projectId: other.id, title: "x", prompt: "p" })
    store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/other/pull/1" })
    const id = task(2, "done", { prState: "open" })
    gh.prs.set("acme/site#2", { state: "MERGED" })
    gh.failFor("bad", new Response("{}", { status: 403 })) // a secondary limit without a hint
    await tracker.pollAll()
    expect(store.getTask(id)).toMatchObject({ prState: "merged" })
    expect(tracker.tokenHealth("bad").pausedUntil).toBeGreaterThan(Date.now())
    expect(tracker.tokenHealth("tok").pausedUntil).toBe(0)

    const id2 = task(3, "idle", { prState: "open" })
    gh.prs.set("acme/site#3", { state: "MERGED" })
    gh.failFor("bad", new Response("nope", { status: 401 }))
    tracker.tokenHealth("bad").pausedUntil = 0
    await tracker.pollAll()
    expect(store.getTask(id2)).toMatchObject({ prState: "merged" })
    expect(tracker.tokenHealth("bad").failures).toBe(1)
    expect(tracker.tokenHealth("tok").failures).toBe(0)
    expect(tracker.prCheck(t.id).error).toMatch(/HTTP 401/)
  })

  it("says why it can't check a PR the token can't see, and logs it once", async () => {
    const { gh, tracker, task, logs } = setup()
    const id = task(91, "done", { prState: "open" })
    gh.hidden.set("Bearer tok", new Set(["acme/site"]))
    await tracker.pollAll()
    await tracker.pollAll()
    expect(tracker.prCheck(id)).toMatchObject({ checkedAt: null, error: expect.stringMatching(/can't see it.*NOT_FOUND/) })
    expect(logs.filter((l) => l.includes("pull/91"))).toHaveLength(1)
    gh.hidden.clear()
    gh.prs.set("acme/site#91", { state: "OPEN" })
    await tracker.pollAll()
    expect(tracker.prCheck(id)).toMatchObject({ checkedAt: expect.any(Number), error: null })
  })

  it("pauses one token until the reset when rate limited, and when the budget runs low", async () => {
    const { gh, tracker, task } = setup()
    task(1)
    gh.prs.set("acme/site#1", { state: "OPEN" })
    const reset = Math.floor(Date.now() / 1000) + 600
    gh.failWith(new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }))
    await tracker.pollAll()
    expect(tracker.tokenHealth("tok").pausedUntil).toBe(reset * 1000)
    await tracker.pollAll() // still paused: no request
    await tracker.ensureFresh(null) // not even on demand
    expect(gh.calls).toHaveLength(1)

    tracker.tokenHealth("tok").pausedUntil = 0
    gh.failWith(null)
    gh.setRemaining(RATE_FLOOR - 1)
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(2)
    expect(tracker.tokenHealth("tok").pausedUntil).toBeGreaterThan(Date.now() + 25 * 60_000)
  })

  it("wake() drops error backoffs and polls right away", async () => {
    const { gh, tracker, task, store } = setup()
    const id = task(1, "done", { prState: "open" })
    gh.failWith(new Response("offline", { status: 502 }))
    await tracker.pollAll()
    expect(tracker.tokenHealth("tok").failures).toBe(1)
    gh.failWith(null)
    gh.prs.set("acme/site#1", { state: "MERGED" })
    tracker.wake()
    await new Promise((r) => setTimeout(r, 30))
    tracker.stop()
    expect(store.getTask(id)).toMatchObject({ prState: "merged" })
    expect(tracker.tokenHealth("tok").failures).toBe(0)
  })

  it("check() asks right away (turn end), re-checks closed PRs and never asks about merged ones", async () => {
    const { store, gh, tracker, task } = setup()
    const id = task(4, "working", { currentTurnId: "turn_1", prState: "closed" })
    gh.prs.set("acme/site#4", { state: "OPEN" })
    expect(await tracker.check(id)).toBe("open") // reopened by the agent
    gh.prs.set("acme/site#4", { state: "MERGED" })
    expect(await tracker.check(id)).toBe("merged")
    expect(store.getTask(id)).toMatchObject({ status: "working", prState: "merged" }) // the turn end decides the status
    expect(await tracker.check(id)).toBe("merged")
    expect(gh.calls).toHaveLength(2)
  })

  it("refresh() coalesces calls into one request", async () => {
    const { gh, tracker, task } = setup()
    const a = task(1)
    const b = task(2)
    gh.prs.set("acme/site#1", { state: "OPEN" })
    gh.prs.set("acme/site#2", { state: "OPEN", isDraft: true })
    tracker.refresh(a, 10)
    tracker.refresh(b, 10)
    await new Promise((r) => setTimeout(r, 50))
    await tracker.pollAll() // waits behind the refresh
    expect(gh.calls[0]!.asked).toEqual(["acme/site#1", "acme/site#2"])
    tracker.stop()
  })

  it("ignores an answer for a PR the task has since replaced", () => {
    const { store, tracker, task, changes } = setup()
    const id = task(1)
    store.updateTask(id, { prUrl: "https://github.com/acme/site/pull/2" })
    tracker.apply(id, "https://github.com/acme/site/pull/1", { state: "merged", mergedAt: null, mergedBy: null })
    expect(store.getTask(id)).toMatchObject({ status: "pr_ready", prState: null })
    expect(changes).toHaveLength(0)
  })

  it("polls the PRs of done, idle and failed tasks too, not only pr_ready ones", async () => {
    const { store, gh, tracker, task, changes } = setup()
    const done = task(1, "done", { prState: "open" })
    const idle = task(2, "idle", { prState: "open" })
    const failed = task(3, "failed", { prState: "draft" })
    for (const n of [1, 2, 3]) gh.prs.set(`acme/site#${n}`, { state: "MERGED", mergedBy: { login: "cody" } })
    await tracker.pollAll()
    expect(gh.calls[0]!.asked).toEqual(["acme/site#1", "acme/site#2", "acme/site#3"])
    expect([done, idle, failed].map((id) => store.getTask(id)!.prState)).toEqual(["merged", "merged", "merged"])
    // A resting idle task moves to done (Settings' autoDoneOnMerge, on by default); failed is left alone. The change
    // still reaches the UI and hooks (onChange).
    expect(store.getTask(idle)!.status).toBe("done")
    expect(store.getTask(failed)!.status).toBe("failed")
    expect(changes.map((c) => [c.taskId, c.prev, c.info.state])).toEqual([
      [done, "open", "merged"],
      [idle, "open", "merged"],
      [failed, "draft", "merged"],
    ])
  })
})

describe("ensureFresh (before a PR state is reported)", () => {
  it("asks GitHub about states older than PR_REPORT_FRESH_MS, in one batch, and leaves fresh ones alone", async () => {
    let now = 1_000_000
    const { store, gh, tracker, task } = setup({ now: () => now })
    const a = task(1, "pr_ready", { prState: "open" })
    const b = task(2, "pr_ready", { prState: "open" })
    gh.prs.set("acme/site#1", { state: "OPEN" })
    gh.prs.set("acme/site#2", { state: "OPEN" })
    await tracker.pollAll()
    expect(tracker.prCheck(a).checkedAt).toBe(now)

    now += PR_REPORT_FRESH_MS - 1
    await tracker.ensureFresh([a, b])
    expect(gh.calls).toHaveLength(1) // still fresh: no request

    // The scheduled poll missed a merge (it was backing off, the laptop slept...): the report asks first.
    gh.prs.set("acme/site#2", { state: "MERGED", mergedBy: { login: "cody" } })
    now += 2
    await tracker.ensureFresh([a, b])
    expect(gh.calls).toHaveLength(2)
    expect(gh.calls[1]!.asked).toEqual(["acme/site#1", "acme/site#2"])
    expect(store.getTask(b)).toMatchObject({ status: "done", prState: "merged" })
    expect(tracker.prCheck(b).checkedAt).toBe(now)
  })

  it("asks even while the scheduled poll backs off, and never waits longer than the timeout", async () => {
    const { store, gh, tracker, task } = setup()
    const id = task(1, "pr_ready", { prState: "open" })
    gh.failWith(new Response("boom", { status: 502 }))
    await tracker.pollAll()
    gh.failWith(null)
    gh.prs.set("acme/site#1", { state: "MERGED" })
    await tracker.ensureFresh([id])
    expect(store.getTask(id)!.prState).toBe("merged")

    const slow = setup()
    const hung = new PrTracker({ store: slow.store, token: () => "tok", fetch: (() => new Promise(() => {})) as unknown as typeof fetch })
    const stuck = slow.task(5, "pr_ready", { prState: "open" })
    const started = Date.now()
    await hung.ensureFresh([stuck], { timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(hung.prCheck(stuck).checkedAt).toBeNull()
  })
})
