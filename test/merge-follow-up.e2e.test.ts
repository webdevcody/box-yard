import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// What Box Yard does when a task's PR merges (server/mergeFollowUp.ts, TaskManager.followUpMerge): it closes the
// issues the PR names when it merged into another branch than the default, and moves the resting task to done,
// archived as close_task does, unless something says it should stay. A fake GitHub answers the PR tracker's GraphQL
// poll and the REST calls; the yard isn't started, so no scheduler moves the seeded tasks underneath the test.

interface FakeIssue {
  state: "open" | "closed"
  pr?: boolean
  comments: string[]
}
interface FakePr {
  state: "OPEN" | "MERGED" | "CLOSED"
  title: string
  body: string
  base: string
}

/** A fake GitHub for repo acme/site (default branch main): PRs, issues, and a log of every write. */
function fakeGithub() {
  const prs = new Map<number, FakePr>()
  const issues = new Map<number, FakeIssue>()
  const writes: string[] = []
  let failRest: number | null = null
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? "GET"
    if (url.endsWith("/graphql")) {
      const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, string | number> }
      const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
      for (const k of Object.keys(variables).filter((k) => k.startsWith("p"))) {
        const pr = prs.get(Number(variables[k]))
        data[k] = pr
          ? { pullRequest: { state: pr.state, isDraft: false, mergedAt: pr.state === "MERGED" ? "2026-10-30T09:00:00Z" : null, mergedBy: pr.state === "MERGED" ? { login: "webdevcody" } : null, headRefOid: "a".repeat(40), labels: { nodes: [] } } }
          : null
      }
      return json({ data })
    }
    if (failRest) return json({ message: "Server Error" }, failRest)
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(\/comments)?$/.exec(url)
    if (!m || `${m[1]}/${m[2]}` !== "acme/site") return json({ message: "Not Found" }, 404)
    const n = Number(m[4])
    if (m[3] === "pulls") {
      const pr = prs.get(n)
      if (!pr) return json({ message: "Not Found" }, 404)
      return json({
        number: n,
        title: pr.title,
        body: pr.body,
        state: pr.state === "OPEN" ? "open" : "closed",
        merged: pr.state === "MERGED",
        base: { ref: pr.base, repo: { full_name: "acme/site", default_branch: "main" } },
      })
    }
    // GitHub's issues API answers for PRs too, with pull_request set.
    if (prs.has(n) && !m[5] && method === "GET") return json({ number: n, state: prs.get(n)!.state === "OPEN" ? "open" : "closed", pull_request: { url: "x" } })
    const issue = issues.get(n)
    if (!issue) return json({ message: "Not Found" }, 404)
    if (m[5] && method === "POST") {
      const { body } = JSON.parse(String(init.body)) as { body: string }
      issue.comments.push(body)
      writes.push(`comment #${n}`)
      return json({ id: 1 }, 201)
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as { state: "closed"; state_reason?: string }
      issue.state = patch.state
      writes.push(`close #${n} (${patch.state_reason})`)
      return json({ number: n, state: issue.state })
    }
    return json({ number: n, state: issue.state, ...(issue.pr ? { pull_request: { url: "x" } } : {}) })
  }) as unknown as typeof globalThis.fetch
  const issue = (n: number, state: FakeIssue["state"] = "open") => issues.set(n, { state, comments: [] })
  return { prs, issues, writes, fetch, issue, failRestWith: (status: number | null) => (failRest = status) }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  gh: ReturnType<typeof fakeGithub>
  project: Project
  dataDir: string
}
const running: Running[] = []

async function setup(): Promise<Running> {
  const port = await freePort()
  const gh = fakeGithub()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch: gh.fetch, token: () => "test-token" } })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  const project = yard.store.createProject({ name: "site", repo: "https://github.com/acme/site" })
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh, project, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

let n = 70
/** A task resting with `status` and open PR #n into `base`, which GitHub says is open (as Box Yard last saw it). */
function prTask(r: Running, opts: { status?: Task["status"]; base?: string; body?: string; title?: string; project?: Project } = {}): { task: Task; pr: number } {
  const pr = ++n
  r.gh.prs.set(pr, { state: "OPEN", title: opts.title ?? "Trestle lookout", body: opts.body ?? "", base: opts.base ?? "map-4-epic" })
  const t = r.yard.store.createTask({ projectId: (opts.project ?? r.project).id, title: `Task ${pr}`, prompt: "p" })
  const url = `https://github.com/acme/site/pull/${pr}`
  r.yard.store.addTaskMessage(t.id, "event", `Opened pull request: ${url}`, { kind: "pr", url })
  r.yard.store.updateTask(t.id, { status: opts.status ?? "pr_ready", prUrl: url, prState: "open", turnCount: 1 }, { quiet: true })
  return { task: r.yard.store.getTask(t.id)!, pr }
}

/** GitHub merges these PRs and Box Yard's PR poll sees it; then whatever it queued for the issues runs. */
async function merge(r: Running, ...prs: number[]) {
  for (const pr of prs) r.gh.prs.get(pr)!.state = "MERGED"
  await r.yard.tasks.prs.pollAll()
  await r.yard.tasks.issues.run()
}

const events = (r: Running, id: string) => r.yard.store.listTaskMessages(id).filter((m) => m.role === "event").map((m) => m.content)
const status = (r: Running, t: Task) => r.yard.store.getTask(t.id)!.status
const queuedCloses = (r: Running) => (r.yard.store.db.prepare("SELECT COUNT(*) AS c FROM pr_issue_closes").get() as { c: number }).c

describe("closing the issues a merged PR names", () => {
  it("closes the open same-repo issues it names, with a comment, when it merges into a non-default branch", async () => {
    const r = await setup()
    for (const i of [5, 6, 7, 12]) r.gh.issue(i)
    r.gh.issue(9, "closed")
    const { task: t, pr } = prTask(r, {
      title: "Fixes #12: Trestle lookout",
      body: [
        "Fixes #5, closes #6 and RESOLVES: #7.",
        "Fixes acme/other#8 too.",
        "Closes #9, which was closed already.",
        "Fixes #950, a pull request.",
        "Fixes #404, which doesn't exist.",
        "Mentions #13 without a keyword.",
        "```",
        "Fixes #14 inside a code block",
        "```",
      ].join("\n"),
    })
    // The PR it names is another PR (not an issue): GitHub's issues API marks it with pull_request.
    r.gh.prs.set(950, { state: "OPEN", title: "Other", body: "", base: "main" })
    await merge(r, pr)

    expect(r.gh.writes.filter((w) => w.startsWith("close")).sort()).toEqual(["close #12 (completed)", "close #5 (completed)", "close #6 (completed)", "close #7 (completed)"])
    expect(r.gh.issues.get(5)!.comments).toEqual([`Closed by #${pr} (merged into \`map-4-epic\`).`])
    expect(r.gh.issues.get(9)).toMatchObject({ state: "closed", comments: [] })
    expect(r.gh.prs.get(950)!.state).toBe("OPEN") // never touched: it's a PR
    const ev = events(r, t.id).find((e) => e.startsWith("Closed issues"))
    expect(ev).toBe(
      `Closed issues #12, #5, #6 and #7: PR #${pr} names them and merged into map-4-epic, where GitHub doesn't close them itself. ` +
        `Left alone: acme/other#8 (another repo), #9 (already closed), #950 (a pull request) and #404 (not found).`,
    )
    expect(queuedCloses(r)).toBe(0)
  })

  it("leaves a merge into the default branch to GitHub", async () => {
    const r = await setup()
    r.gh.issue(5)
    const { task: t, pr } = prTask(r, { base: "main", body: "Fixes #5" })
    await merge(r, pr)
    expect(r.gh.writes).toEqual([])
    expect(r.gh.issues.get(5)!.state).toBe("open")
    expect(events(r, t.id).some((e) => /issue/i.test(e))).toBe(false)
  })

  it("is off for a project that turns it off, and on for one that turns it on while Settings has it off", async () => {
    const r = await setup()
    r.gh.issue(5)
    r.gh.issue(6)
    r.yard.store.updateProject(r.project.id, { closeIssuesOnMerge: false })
    const off = prTask(r, { body: "Fixes #5" })
    await merge(r, off.pr)
    expect(r.gh.writes).toEqual([])
    expect(queuedCloses(r)).toBe(0)

    await call(r, "PUT", "/api/agent-settings", { closeIssuesOnMerge: false })
    const other = await call<Project>(r, "POST", "/api/projects", { name: "other", repo: "https://github.com/acme/site" })
    expect(other).toMatchObject({ closeIssuesOnMerge: null, autoDoneOnMerge: null })
    expect(await call<Project>(r, "PATCH", `/api/projects/${other.id}`, { closeIssuesOnMerge: true })).toMatchObject({ closeIssuesOnMerge: true })
    const on = prTask(r, { body: "Fixes #6", project: r.yard.store.getProject(other.id)! })
    await merge(r, on.pr)
    expect(r.gh.writes).toEqual(["close #6 (completed)", "comment #6"])
  })

  it("keeps a merge it couldn't handle queued across a restart, and handles it once", async () => {
    const r = await setup()
    r.gh.issue(5)
    const { task: t, pr } = prTask(r, { body: "Closes #5" })
    r.gh.failRestWith(502)
    await merge(r, pr)
    expect(queuedCloses(r)).toBe(1)
    expect(r.gh.writes).toEqual([])
    r.gh.failRestWith(null)

    // A new server on the same data folder: the queued merge is still there, and start() works through it once due.
    const dataDir = r.dataDir
    r.yard.stop()
    const again = createBoxYard(testConfig({ dataDir }), { webDir: "/nonexistent", github: { fetch: r.gh.fetch, token: () => "test-token" } })
    try {
      again.store.db.prepare("UPDATE pr_issue_closes SET retry_at = 0").run()
      await again.tasks.issues.run()
      expect(r.gh.writes).toEqual(["close #5 (completed)", "comment #5"])
      expect(again.store.listTaskMessages(t.id).some((m) => m.content.startsWith("Closed issue #5:"))).toBe(true)
      // Queued again (a second merge event for the same PR): #5 is closed now, so nothing more is written.
      again.tasks.issues.queue(t.id, `https://github.com/acme/site/pull/${pr}`)
      await again.tasks.issues.run()
      expect(r.gh.writes).toEqual(["close #5 (completed)", "comment #5"])
      expect((again.store.db.prepare("SELECT COUNT(*) AS c FROM pr_issue_closes").get() as { c: number }).c).toBe(0)
    } finally {
      again.stop()
    }
  })
})

describe("Done when its PR merges", () => {
  it("moves a resting task to done and archives it as close_task does", async () => {
    const r = await setup()
    const ready = prTask(r)
    const idle = prTask(r, { status: "idle" })
    await merge(r, ready.pr, idle.pr)
    for (const { task } of [ready, idle]) {
      expect(status(r, task)).toBe("done")
      expect(events(r, task.id).at(-1)).toBe(`Moved to done: its pull request #${task.prUrl!.split("/").pop()} is merged (Settings › Done when its PR merges). Its workspace is archived and its box slot freed.`)
    }
  })

  it("leaves a busy task, one with queued messages, and one with another open PR", async () => {
    const r = await setup()
    const busy = prTask(r)
    r.yard.store.updateTask(busy.task.id, { status: "working", currentTurnId: "turn_busy01" }, { quiet: true })
    const queued = prTask(r, { status: "idle" })
    r.yard.store.queueInput(queued.task.id, "cody", "One more thing")
    const twoPrs = prTask(r)
    const otherOpen = ++n
    r.gh.prs.set(otherOpen, { state: "OPEN", title: "Follow-up", body: "", base: "map-4-epic" })
    const url = `https://github.com/acme/site/pull/${otherOpen}`
    r.yard.store.addTaskMessage(twoPrs.task.id, "event", `Opened pull request: ${url}`, { kind: "pr", url })
    // Its first PR, which it replaced with the current one, is closed: that doesn't hold it back.
    const settled = prTask(r)
    const oldPr = ++n
    r.gh.prs.set(oldPr, { state: "CLOSED", title: "First try", body: "", base: "map-4-epic" })
    r.yard.store.addTaskMessage(settled.task.id, "event", "Opened pull request", { kind: "pr", url: `https://github.com/acme/site/pull/${oldPr}` })

    await merge(r, busy.pr, queued.pr, twoPrs.pr, settled.pr)
    expect(status(r, busy.task)).toBe("working")
    expect(status(r, queued.task)).toBe("idle")
    expect(events(r, queued.task.id).at(-1)).toBe(`Not moved to done, though PR #${queued.pr} merged: it has queued messages to answer first.`)
    await waitFor(() => events(r, twoPrs.task.id).some((e) => e.startsWith("Not moved to done")), "the other PR to be checked")
    expect(status(r, twoPrs.task)).toBe("idle")
    expect(events(r, twoPrs.task.id).at(-1)).toBe(`Not moved to done, though PR #${twoPrs.pr} merged: it also opened PR #${otherOpen}, still open.`)
    await waitFor(() => status(r, settled.task) === "done", "the task whose other PR is closed to move to done")
  })

  it("never moves a task set to stay open, and does once that's turned off", async () => {
    const r = await setup()
    const { task: t, pr } = prTask(r, { status: "idle" })
    const set = await call<Task>(r, "PATCH", `/api/tasks/${t.id}`, { stayOpenOnMerge: true })
    expect(set.stayOpenOnMerge).toBe(true)
    await expect(call(r, "PATCH", `/api/tasks/${t.id}`, { stayOpenOnMerge: "yes" })).rejects.toThrow(/400/)
    await merge(r, pr)
    expect(status(r, t)).toBe("idle")
    expect(r.yard.tasks.doneMergedResting()).toBe(0)

    expect((await call<Task>(r, "PATCH", `/api/tasks/${t.id}`, { stayOpenOnMerge: false })).stayOpenOnMerge).toBe(false)
    expect(status(r, t)).toBe("done")
    expect(events(r, t.id)).toContain("Stays open when its PR merges (set by Cody): Box Yard won't move it to done.")
  })

  it("follows the project's own setting over Settings, both ways", async () => {
    const r = await setup()
    await call(r, "PATCH", `/api/projects/${r.project.id}`, { autoDoneOnMerge: false })
    const off = prTask(r)
    await merge(r, off.pr)
    expect(status(r, off.task)).toBe("idle")

    await call(r, "PUT", "/api/agent-settings", { autoDoneOnMerge: false })
    const other = r.yard.store.createProject({ name: "other", repo: "https://github.com/acme/site", autoDoneOnMerge: true })
    const on = prTask(r, { project: other })
    await merge(r, on.pr)
    expect(status(r, on.task)).toBe("done")
    expect(events(r, on.task.id).at(-1)).toMatch(/\(the project's settings › Done when its PR merges\)\. Its workspace is archived/)

    // Back to Settings (on again): the first project's merged task moves now.
    await call(r, "PUT", "/api/agent-settings", { autoDoneOnMerge: true })
    expect(status(r, off.task)).toBe("idle")
    await call(r, "PATCH", `/api/projects/${r.project.id}`, { autoDoneOnMerge: null })
    expect(status(r, off.task)).toBe("done")
  })
})
