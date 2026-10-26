import { afterEach, describe, expect, it } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { PrTracker, type LivePr } from "../server/prs.js"
import { prStatusLine, workerSystemPrompt } from "../server/prompts.js"
import { inputTrigger, prMark, quietAgentWake, taskTrigger, turnTrigger } from "../server/turnTrigger.js"
import { hookMismatch, normalizeFilters, type HookSubject } from "../shared/hooks.js"
import type { Project } from "../shared/types.js"
import { testConfig } from "./helpers.js"

describe("a turn's trigger", () => {
  it("names each input source", () => {
    expect(["cody", "cody:merge", "orchestrator", "captain:prj_a1b2c3", "hook:hook_1", "agent:task_1", "system"].map(inputTrigger)).toEqual([
      "cody",
      "cody",
      "coordinator",
      "captain",
      "hook",
      "agent",
      "system",
    ])
    expect(taskTrigger({ source: "captain:prj_a1b2c3", schedule_id: null })).toBe("captain")
    expect(taskTrigger({ source: null, schedule_id: "sch_1" })).toBe("schedule")
    expect(taskTrigger({ source: null, schedule_id: null })).toBe("cody")
  })

  it("is an agent wake only when every message came from other agents (mixed queues count as the highest sender)", () => {
    const t = (sources: string[], carried: Parameters<typeof turnTrigger>[1]["carried"] = null) => turnTrigger(sources, { carried, fallback: "system" })
    expect(t(["agent:task_a", "agent:task_b"])).toBe("agent")
    expect(t(["agent:task_a", "cody"])).toBe("cody")
    expect(t(["captain:prj_x", "agent:task_a"])).toBe("captain")
    expect(t(["agent:task_a", "orchestrator", "hook:h"])).toBe("coordinator")
    expect(t(["agent:task_a", "hook:h"])).toBe("hook")
    // Box Yard's own message (a retry button, an undeliverable reply) makes it a normal turn.
    expect(t(["agent:task_a", "system"])).toBe("system")
    // A bare "Continue." has nothing queued.
    expect(t([])).toBe("system")
    // A retry keeps the retried turn's trigger, and its own "continue" notice doesn't count.
    expect(t(["system"], "agent")).toBe("agent")
    expect(t(["system", "cody"], "agent")).toBe("cody")
    // A first turn is whoever started the task, plus anything queued with it.
    expect(t(["orchestrator"], "coordinator")).toBe("coordinator")
  })

  it("is quiet only for an agent wake that rests with the PR as it was", () => {
    const pr = prMark({ pr_url: "https://github.com/a/b/pull/1", pr_state: "open" })
    const base = { trigger: "agent" as const, status: "idle", sawPr: false, prBefore: pr, prAfter: pr }
    expect(quietAgentWake(base)).toBe(true)
    expect(quietAgentWake({ ...base, status: "done" })).toBe(true)
    expect(quietAgentWake({ ...base, status: "pr_ready" })).toBe(true)
    expect(quietAgentWake({ ...base, trigger: "cody" })).toBe(false)
    expect(quietAgentWake({ ...base, trigger: undefined })).toBe(false)
    expect(quietAgentWake({ ...base, status: "failed" })).toBe(false)
    expect(quietAgentWake({ ...base, status: "needs_input" })).toBe(false)
    // A push or a new PR, a PR that merged or closed during the turn.
    expect(quietAgentWake({ ...base, sawPr: true })).toBe(false)
    expect(quietAgentWake({ ...base, prBefore: "", prAfter: pr })).toBe(false)
    expect(quietAgentWake({ ...base, prAfter: prMark({ pr_url: "https://github.com/a/b/pull/1", pr_state: "merged" }) })).toBe(false)
  })
})

describe("hooks and agent wakes", () => {
  const subject = (over: Partial<HookSubject> = {}): HookSubject => ({
    trigger: "task.finished",
    projectId: "prj_a",
    title: "T",
    prompt: "P",
    source: "cody",
    status: "idle",
    prUrl: null,
    prState: null,
    prLabels: [],
    quiet: false,
    ...over,
  })
  const hook = (filters = {}, trigger: HookSubject["trigger"] = "task.finished") => ({ enabled: true, trigger, projectId: null, filters })

  it("skips a task.finished from a quiet agent wake unless the hook includes agent wakes", () => {
    expect(hookMismatch(hook(), subject())).toBeNull()
    expect(hookMismatch(hook(), subject({ agentWake: true }))).toBe("only another agent's message started the turn")
    expect(hookMismatch(hook({ includeAgentWakes: true }), subject({ agentWake: true }))).toBeNull()
    // Other triggers aren't affected (task.pr_ready fires once per head commit anyway).
    expect(hookMismatch(hook({}, "task.pr_ready"), subject({ trigger: "task.pr_ready", agentWake: true, prUrl: "u", prState: "open" }))).toBeNull()
  })

  it("keeps the flag through normalizeFilters only when it's on", () => {
    expect(normalizeFilters({ includeAgentWakes: true })).toEqual({ includeAgentWakes: true })
    expect(normalizeFilters({ includeAgentWakes: false })).toEqual({})
  })
})

describe("the PR status line", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const pr = (over: Partial<LivePr> = {}): LivePr => ({
    url: "https://github.com/acme/site/pull/76",
    number: 76,
    state: "open",
    mergedAt: null,
    mergedBy: null,
    headSha: "abcdef0123456789abcdef0123456789abcdef01",
    checkedAt: now,
    source: "github",
    ...over,
  })

  it("says a merged PR isn't waiting for review and new work goes on the base branch", () => {
    const line = prStatusLine(pr({ state: "merged", mergedAt: Date.parse("2026-10-26T09:15:00Z"), mergedBy: "webdevcody" }), { baseBranch: "main", now })
    expect(line).toBe(
      "Pull request status (from Box Yard; checked on GitHub as this turn started): #76 https://github.com/acme/site/pull/76 is MERGED at 2026-10-26 09:15 UTC by webdevcody, head commit abcdef012345. " +
        "It is not waiting for review: don't say it is. Never push to its branch again; base any new work on main (a new branch and a new PR).",
    )
    expect(prStatusLine(pr({ state: "merged", source: "fresh" }), { baseBranch: "develop", now })).toMatch(/^Pull request status \(from Box Yard; merged is final\): .* is MERGED, head .*base any new work on develop/)
  })

  it("says how fresh an open PR's state is, and asks for gh pr view when GitHub didn't answer", () => {
    expect(prStatusLine(pr(), { baseBranch: "main", now })).toBe(
      "Pull request status (from Box Yard; checked on GitHub as this turn started): #76 https://github.com/acme/site/pull/76 is OPEN, not merged, head commit abcdef012345.",
    )
    expect(prStatusLine(pr({ source: "fresh", checkedAt: now - 20_000 }), { baseBranch: "main", now })).toContain("(from Box Yard; checked on GitHub under a minute ago)")
    expect(prStatusLine(pr({ source: "fallback", checkedAt: now - 12 * 60_000 }), { baseBranch: "main", now })).toBe(
      "Pull request status (from Box Yard; GitHub didn't answer just now; this is Box Yard's last check, 12 min ago): #76 https://github.com/acme/site/pull/76 is OPEN, not merged, head commit abcdef012345. " +
        "Check it with `gh pr view 76 --json state,mergedAt,headRefOid` before saying anything about its status.",
    )
    expect(prStatusLine(pr({ state: "draft" }), { baseBranch: "main", now })).toContain("is OPEN as a draft, not merged")
    expect(prStatusLine(pr({ state: "closed" }), { baseBranch: "main", now })).toContain("is CLOSED without merging, head commit abcdef012345. It is not waiting for review.")
    expect(prStatusLine(pr({ state: null, headSha: null, source: "fallback", checkedAt: null }), { baseBranch: "main", now })).toBe(
      "Pull request status (from Box Yard; GitHub couldn't be checked just now; this is Box Yard's last known state): #76 https://github.com/acme/site/pull/76 is in an unknown state. " +
        "Check it with `gh pr view 76 --json state,mergedAt,headRefOid` before saying anything about its status.",
    )
  })

  it("is backed by a system prompt rule for repo projects", () => {
    const project = { name: "site", repo: "acme/site", baseBranch: "main", description: "" } as Project
    const prompt = workerSystemPrompt({ project, task: { id: "task_1", title: "T" }, branch: "boxyard/t", port: 4010 })
    expect(prompt).toContain("Never claim a pull request's status (open, waiting for review, merged) from memory.")
    expect(prompt).toContain("`gh pr view <number> --json state,mergedAt,headRefOid`")
    expect(prompt).toContain("never push to its branch again: base any new work on main (a new branch and a new PR)")
  })
})

describe("PrTracker.live", () => {
  const yards: BoxYard[] = []
  afterEach(() => {
    for (const y of yards.splice(0)) y.stop()
  })

  function setup(fetch: typeof globalThis.fetch) {
    const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
    yards.push(yard)
    yard.tasks.stop()
    const project = yard.store.createProject({ name: "site", repo: "acme/site" })
    const task = yard.store.createTask({ projectId: project.id, title: "T", prompt: "P", branch: "boxyard/t" })
    yard.store.updateTask(task.id, { prUrl: "https://github.com/acme/site/pull/5", prState: "open", prHeadSha: "1".repeat(40) }, { quiet: true })
    const tracker = new PrTracker({ store: yard.store, token: () => "t", fetch })
    return { yard, task, tracker }
  }
  const answer = (state: string) =>
    new Response(JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() }, p0: { pullRequest: { state, isDraft: false, mergedAt: null, mergedBy: null, headRefOid: "2".repeat(40) } } } }), {
      status: 200,
    })

  it("doesn't wait past its timeout for a GitHub that hangs, and falls back to the last known state", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch
    const { task, tracker } = setup(hang)
    const started = Date.now()
    const live = await tracker.live(task.id, { timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(live).toMatchObject({ number: 5, state: "open", headSha: "1".repeat(40), source: "fallback", checkedAt: null })
    tracker.stop()
  })

  it("asks GitHub once, then uses the fresh answer, and never asks about a merged PR", async () => {
    let calls = 0
    const { yard, task, tracker } = setup((async () => (calls++, answer("OPEN"))) as unknown as typeof fetch)
    expect(await tracker.live(task.id)).toMatchObject({ source: "github", state: "open", headSha: "2".repeat(40) })
    expect(await tracker.live(task.id)).toMatchObject({ source: "fresh", state: "open" })
    expect(calls).toBe(1)
    yard.store.updateTask(task.id, { prState: "merged" }, { quiet: true })
    expect(await tracker.live(task.id, { freshMs: 0 })).toMatchObject({ source: "fresh", state: "merged" })
    expect(calls).toBe(1)
  })
})
