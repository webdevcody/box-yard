import { describe, expect, it } from "vitest"
import { isQuietRun, noopBlockers, parseOutcome, withoutQuiet, type RunEvidence } from "../shared/quiet.js"
import type { Task, TaskStatus } from "../shared/types.js"
import { inYardView, olderFinishedCount, quietCount, yardCounts, yardTasks } from "../web/src/lib/yardTasks.js"
import { filterCounts, isVisible, visibleTasks } from "../web/src/lib/projectTasks.js"
import { inInbox } from "../web/src/lib/inbox.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

const NOW = 1_000_000_000
const HOUR = 60 * 60 * 1000

let n = 0
function task(status: TaskStatus, over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `t${n}`,
    projectId: "p1",
    title: `Task ${n}`,
    prompt: "Do the thing",
    status,
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  }
}

/** A PR Merger run that found no open PRs. */
const quietRun = (over: Partial<Task> = {}) => task("done", { scheduleId: "sch_1", outcome: "noop", summary: "No open PRs, nothing to merge", ...over })

const evidence = (over: Partial<RunEvidence> = {}): RunEvidence => ({
  scheduleId: "sch_1",
  status: "done",
  prUrl: null,
  previews: 0,
  artifacts: 0,
  asked: false,
  commits: 0,
  ...over,
})

describe("noopBlockers: when the server accepts a noop mark", () => {
  it("accepts a done schedule run that left nothing behind", () => {
    expect(noopBlockers(evidence())).toEqual([])
    // Outside a git repo the runner can't count commits; that alone doesn't block.
    expect(noopBlockers(evidence({ commits: null }))).toEqual([])
  })

  it("ignores the mark when the run pushed commits, touched a PR, or published an artifact or preview", () => {
    expect(noopBlockers(evidence({ commits: 2 }))).toEqual(["it made 2 commits"])
    expect(noopBlockers(evidence({ prUrl: "https://github.com/a/b/pull/1" }))).toEqual(["it opened or updated a pull request"])
    expect(noopBlockers(evidence({ sawPr: true }))).toEqual(["it opened or updated a pull request"])
    expect(noopBlockers(evidence({ artifacts: 1 }))).toEqual(["it published an artifact"])
    expect(noopBlockers(evidence({ previews: 1 }))).toEqual(["it reported a preview"])
    expect(noopBlockers(evidence({ asked: true }))).toEqual(["it asked Cody a question"])
  })

  it("never for failed, needs-input or non-schedule runs", () => {
    for (const status of ["failed", "needs_input", "idle", "pr_ready", "waiting"] as TaskStatus[]) {
      expect(noopBlockers(evidence({ status }))).toEqual([`it ended as ${status}`])
    }
    expect(noopBlockers(evidence({ scheduleId: null }))).toEqual(["it isn't a schedule run"])
  })
})

describe("isQuietRun", () => {
  it("is a done schedule run with the noop outcome", () => {
    expect(isQuietRun(quietRun())).toBe(true)
    expect(isQuietRun(task("done", { scheduleId: "sch_1" }))).toBe(false)
    expect(isQuietRun(task("done", { outcome: "noop" }))).toBe(false)
  })

  it("never hides failed or needs-input runs, even when marked noop", () => {
    expect(isQuietRun(quietRun({ status: "failed", error: "boom" }))).toBe(false)
    expect(isQuietRun(quietRun({ status: "needs_input", question: "Which one?" }))).toBe(false)
    expect(isQuietRun(quietRun({ status: "working" }))).toBe(false)
    expect(isQuietRun(quietRun({ error: "boom" }))).toBe(false)
  })

  it("isn't quiet once the task shows a PR or a preview", () => {
    expect(isQuietRun(quietRun({ prUrl: "https://github.com/a/b/pull/1" }))).toBe(false)
    expect(isQuietRun(quietRun({ previews: [{ port: 4040, url: "https://x", label: "Port 4040" }] }))).toBe(false)
  })

  it("parses only known outcomes", () => {
    expect(parseOutcome("noop")).toBe("noop")
    expect(parseOutcome("nope")).toBeNull()
    expect(parseOutcome(null)).toBeNull()
  })

  it("withoutQuiet drops quiet runs unless shown", () => {
    const list = [quietRun(), task("done")]
    expect(withoutQuiet(list)).toHaveLength(1)
    expect(withoutQuiet(list, true)).toHaveLength(2)
  })
})

describe("the Yard hides quiet runs by default", () => {
  const quiet = quietRun()
  const failedNoop = quietRun({ status: "failed", error: "boom" })
  const normal = task("done")
  const old = quietRun({ updatedAt: NOW - 48 * HOUR })
  const all = [quiet, failedNoop, normal, old]

  it("leaves them out of Recent, All and the counts", () => {
    expect(yardTasks(all, { tab: "recent", now: NOW }).map((t) => t.id).sort()).toEqual([normal.id, failedNoop.id].sort())
    expect(yardTasks(all, { tab: "all", now: NOW }).map((t) => t.id)).not.toContain(quiet.id)
    expect(yardCounts(all, NOW)).toMatchObject({ recent: 2, all: 2 })
    expect(olderFinishedCount(all, NOW)).toBe(0)
  })

  it("the toggle shows them again", () => {
    expect(inYardView(quiet, { tab: "recent", now: NOW })).toBe(false)
    expect(inYardView(quiet, { tab: "recent", now: NOW, showQuiet: true })).toBe(true)
    expect(yardTasks(all, { tab: "all", now: NOW, showQuiet: true })).toHaveLength(4)
    expect(yardCounts(all, NOW, true)).toMatchObject({ recent: 3, all: 4 })
    expect(olderFinishedCount(all, NOW, true)).toBe(1)
    expect(quietCount(all, "recent", NOW)).toBe(1)
    expect(quietCount(all, "recent", NOW, true)).toBe(2)
    expect(quietCount(all, "all", NOW)).toBe(2)
  })

  it("keeps failed runs marked noop in Needs you", () => {
    expect(yardTasks(all, { tab: "needs_you", now: NOW }).map((t) => t.id)).toEqual([failedNoop.id])
  })
})

describe("the project Tasks tab and the Inbox", () => {
  const quiet = quietRun()
  const normal = task("done")

  it("hides quiet runs under every filter unless the toggle is on", () => {
    expect(isVisible(quiet, { filter: "all", query: "" })).toBe(false)
    expect(isVisible(quiet, { filter: "done", query: "" })).toBe(false)
    expect(isVisible(quiet, { filter: "all", query: "", showQuiet: true })).toBe(true)
    expect(filterCounts([quiet, normal], "")).toMatchObject({ all: 1, done: 1 })
    expect(filterCounts([quiet, normal], "", true)).toMatchObject({ all: 2, done: 2 })
    expect(visibleTasks([quiet, normal], { filter: "all", query: "", sort: "recent" })).toEqual([normal])
  })

  it("the Inbox never shows quiet runs but keeps failures marked noop", () => {
    expect(inInbox(quiet)).toBe(false)
    expect(inInbox(quietRun({ status: "failed", error: "boom" }))).toBe(true)
  })
})

describe("Store notifications", () => {
  it("records none for a run that lands as quiet, and one for a normal finish", () => {
    const store = new Store(openDb(tmpDir()))
    const p = store.createProject({ name: "ops" })
    const make = (id: string) => store.createTask({ id, projectId: p.id, title: id, prompt: "x", scheduleId: "sch_1" } as never)
    make("task_q")
    make("task_n")
    store.updateTask("task_q", { status: "working" })
    store.updateTask("task_n", { status: "working" })
    store.updateTask("task_q", { status: "done", outcome: "noop" })
    store.updateTask("task_n", { status: "done" })
    expect(store.listNotifications().map((x) => x.taskId)).toEqual(["task_n"])
  })
})
