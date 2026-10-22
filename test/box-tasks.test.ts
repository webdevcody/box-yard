import { describe, expect, it } from "vitest"
import { shortDuration, splitBoxTasks } from "../web/src/lib/boxTasks.js"
import type { Task, TaskStatus } from "../shared/types.js"

let n = 0
function task(status: TaskStatus, createdAt: number, over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `task_t${String(n).padStart(6, "0")}`,
    projectId: "prj_demo01",
    title: `Task ${n}`,
    prompt: "",
    status,
    boxId: "box-1",
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
    createdAt,
    updatedAt: createdAt,
    ...over,
  }
}

describe("splitBoxTasks", () => {
  it("puts working, starting and needs-input agents first and collapses done/idle ones", () => {
    const done = task("done", 1)
    const working = task("working", 2)
    const idle = task("idle", 3)
    const needs = task("needs_input", 4)
    const starting = task("starting", 5)
    const { active, finished } = splitBoxTasks([done, working, idle, needs, starting])
    expect(active.map((t) => t.status)).toEqual(["working", "needs_input", "starting"])
    expect(finished.map((t) => t.status)).toEqual(["idle", "done"])
  })

  it("treats failed and pr_ready as finished", () => {
    const { active, finished } = splitBoxTasks([task("failed", 1), task("pr_ready", 2)])
    expect(active).toEqual([])
    expect(finished).toHaveLength(2)
  })

  it("orders by createdAt only, so status and updatedAt changes never reorder rows", () => {
    const a = task("working", 10)
    const b = task("needs_input", 20)
    const before = splitBoxTasks([b, a]).active.map((t) => t.id)
    const after = splitBoxTasks([{ ...a, status: "needs_input", updatedAt: 99 }, { ...b, status: "working", updatedAt: 5 }]).active.map((t) => t.id)
    expect(before).toEqual([a.id, b.id])
    expect(after).toEqual(before)
  })

  it("shows the newest finished agents first", () => {
    const old = task("done", 1)
    const recent = task("done", 9)
    expect(splitBoxTasks([old, recent]).finished.map((t) => t.id)).toEqual([recent.id, old.id])
  })

  it("returns empty lists for a box with no agents", () => {
    expect(splitBoxTasks([])).toEqual({ active: [], finished: [] })
  })
})

describe("shortDuration", () => {
  it("formats compact durations", () => {
    const m = 60_000
    expect(shortDuration(10_000)).toBe("<1m")
    expect(shortDuration(-5)).toBe("<1m")
    expect(shortDuration(45 * m)).toBe("45m")
    expect(shortDuration(2 * 60 * m)).toBe("2h")
    expect(shortDuration(3 * 24 * 60 * m)).toBe("3d")
  })
})
