import { describe, expect, it } from "vitest"
import {
  RECENT_WINDOW_MS,
  inYardTab,
  olderFinishedCount,
  parseYardTab,
  recentlyFinished,
  yardCounts,
  yardTasks,
  type YardTab,
} from "../web/src/lib/yardTasks.js"
import { TASK_STATUSES, type Task, type TaskStatus } from "../shared/types.js"

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
    previews: [],
    question: null,
    summary: null,
    error: null,
    turnCount: 0,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    createdAt: NOW - 48 * HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  }
}

const tabsOf = (t: Task, older = false) => (["active", "needs_you", "recent", "all"] as YardTab[]).filter((tab) => inYardTab(t, tab, NOW, older))

describe("yard tabs", () => {
  it("puts each status (finished an hour ago) in the right tabs", () => {
    const where = Object.fromEntries(TASK_STATUSES.map((s) => [s, tabsOf(task(s))]))
    expect(where).toEqual({
      queued: ["active", "all"],
      starting: ["active", "all"],
      working: ["active", "all"],
      waiting: ["active", "all"],
      needs_input: ["needs_you", "all"],
      idle: ["recent", "all"],
      pr_ready: ["needs_you", "recent", "all"],
      done: ["recent", "all"],
      failed: ["needs_you", "recent", "all"],
    })
  })

  it("keeps Recent to the last 24h unless older ones are asked for", () => {
    const edge = task("done", { updatedAt: NOW - RECENT_WINDOW_MS })
    const stale = task("done", { updatedAt: NOW - RECENT_WINDOW_MS - 1 })
    const staleWorking = task("working", { updatedAt: NOW - 72 * HOUR })
    expect(inYardTab(edge, "recent", NOW)).toBe(true)
    expect(inYardTab(stale, "recent", NOW)).toBe(false)
    expect(inYardTab(stale, "recent", NOW, true)).toBe(true)
    // An old, still running task is active, never recent.
    expect(tabsOf(staleWorking, true)).toEqual(["active", "all"])
    // Needs you and pr_ready don't expire.
    expect(inYardTab(task("pr_ready", { updatedAt: NOW - 30 * 24 * HOUR }), "needs_you", NOW)).toBe(true)
    expect(olderFinishedCount([edge, stale, staleWorking], NOW)).toBe(1)
  })

  it("counts every tab, with Recent limited to 24h", () => {
    const tasks = [
      task("working"),
      task("queued"),
      task("needs_input"),
      task("pr_ready"),
      task("failed", { updatedAt: NOW - 30 * HOUR }),
      task("done"),
      task("done", { updatedAt: NOW - 25 * HOUR }),
      task("idle"),
    ]
    expect(yardCounts(tasks, NOW)).toEqual({ active: 2, needs_you: 3, recent: 3, all: 8 })
  })

  it("orders Active and Recent by last activity, newest first", () => {
    const a = task("working", { updatedAt: NOW - 3 * HOUR })
    const b = task("queued", { updatedAt: NOW - HOUR })
    const c = task("starting", { updatedAt: NOW - 2 * HOUR })
    expect(yardTasks([a, b, c], { tab: "active", now: NOW })).toEqual([b, c, a])

    const d = task("done", { updatedAt: NOW - 5 * HOUR })
    const e = task("failed", { updatedAt: NOW - HOUR })
    const old = task("idle", { updatedAt: NOW - 40 * HOUR })
    expect(yardTasks([old, d, e, a], { tab: "recent", now: NOW })).toEqual([e, d])
    expect(yardTasks([old, d, e, a], { tab: "recent", now: NOW, older: true })).toEqual([e, d, old])
  })

  it("puts questions before failures before PRs in Needs you", () => {
    const pr = task("pr_ready", { updatedAt: NOW })
    const failed = task("failed")
    const ask = task("needs_input", { updatedAt: NOW - 10 * HOUR })
    expect(yardTasks([pr, failed, ask], { tab: "needs_you", now: NOW })).toEqual([ask, failed, pr])
  })

  it("searches All by title, summary and project name", () => {
    const a = task("done", { title: "Dark mode", projectId: "p1" })
    const b = task("working", { title: "Login fix", projectId: "p2" })
    const projectName = (id: string) => (id === "p2" ? "Survive the night" : "Box Yard")
    expect(yardTasks([a, b], { tab: "all", now: NOW, query: "dark", projectName })).toEqual([a])
    expect(yardTasks([a, b], { tab: "all", now: NOW, query: "survive login", projectName })).toEqual([b])
    expect(yardTasks([a, b], { tab: "all", now: NOW, query: "", sort: "attention", projectName })).toEqual([b, a])
  })

  it("strips the last five finished tasks, newest first, regardless of age", () => {
    const finished = Array.from({ length: 7 }, (_, i) => task("done", { updatedAt: NOW - i * 10 * HOUR }))
    const strip = recentlyFinished([task("working", { updatedAt: NOW }), ...finished.reverse()])
    expect(strip.map((t) => t.updatedAt)).toEqual([0, 1, 2, 3, 4].map((i) => NOW - i * 10 * HOUR))
  })

  it("falls back to Active for unknown URL values", () => {
    expect(parseYardTab(null)).toBe("active")
    expect(parseYardTab("recent")).toBe("recent")
    expect(parseYardTab("bogus")).toBe("active")
  })
})
