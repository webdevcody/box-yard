import { describe, expect, it } from "vitest"
import { filterCounts, matchesQuery, parseFilter, parseSort, sortTasks, visibleTasks } from "../web/src/lib/projectTasks.js"
import type { Task, TaskStatus } from "../shared/types.js"

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
    createdAt: n,
    updatedAt: n,
    ...over,
  }
}

describe("project task list", () => {
  it("hides done tasks by default and counts every filter", () => {
    const tasks = [task("done"), task("working"), task("needs_input"), task("pr_ready"), task("failed"), task("idle"), task("done")]
    const counts = filterCounts(tasks, "")
    expect(counts).toEqual({ open: 5, needs_you: 1, active: 2, pr_ready: 1, failed: 1, done: 2, all: 7 })
    const open = visibleTasks(tasks, { filter: "open", query: "", sort: "attention" })
    expect(open.map((t) => t.status)).toEqual(["needs_input", "failed", "working", "pr_ready", "idle"])
  })

  it("searches title and summary, falling back to the prompt", () => {
    const a = task("working", { title: "Dark mode toggle", summary: "Added a switch to the header" })
    const b = task("idle", { title: "Fix login", prompt: "Sessions expire too early" })
    expect(matchesQuery(a, "dark")).toBe(true)
    expect(matchesQuery(a, "HEADER switch")).toBe(true)
    expect(matchesQuery(a, "dark login")).toBe(false)
    expect(matchesQuery(b, "expire")).toBe(true)
    expect(matchesQuery(b, "   ")).toBe(true)
    expect(filterCounts([a, b], "dark").open).toBe(1)
  })

  it("sorts by attention, last activity or creation", () => {
    const old = task("needs_input", { createdAt: 1, updatedAt: 10 })
    const fresh = task("working", { createdAt: 5, updatedAt: 50 })
    const mid = task("pr_ready", { createdAt: 9, updatedAt: 30 })
    expect(sortTasks([fresh, mid, old], "attention")).toEqual([old, fresh, mid])
    expect(sortTasks([old, mid, fresh], "recent")).toEqual([fresh, mid, old])
    expect(sortTasks([old, fresh, mid], "newest")).toEqual([mid, fresh, old])
  })

  it("falls back to the defaults for unknown URL values", () => {
    expect(parseFilter(null)).toBe("open")
    expect(parseFilter("done")).toBe("done")
    expect(parseFilter("nope")).toBe("open")
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("")).toBe("attention")
  })
})
