import { describe, expect, it } from "vitest"
import { boxAttention, boxBusyReason, boxFilterCounts, diskTone, filterBoxes, nowRunning, parseBoxFilter, poolSummary, rootTone, statusCounts } from "../web/src/lib/boxOverview"
import type { BoxCleanup, BoxInfo, Task, TaskStatus } from "../shared/types"

const MB = 1024 * 1024
const GB = 1024 * MB

const box = (id: string, over: Partial<BoxInfo> = {}): BoxInfo => ({
  id,
  provider: "upstash",
  status: "ready",
  size: "small",
  keepAlive: false,
  slots: 2,
  runningTurns: 0,
  residentTasks: [],
  projects: [],
  activeMs: 0,
  uptimeMs: 0,
  diskBytes: null,
  diskFreeBytes: 3 * GB,
  diskTotalBytes: 5 * GB,
  diskCheckedAt: 1,
  diskLow: false,
  cleanup: null,
  operation: null,
  estimatedCostUsd: 0.1,
  usageSource: "estimated",
  createdAt: 1,
  lastUsedAt: 1,
  ...over,
})

const cleanup = (over: Partial<BoxCleanup> = {}): BoxCleanup => ({
  boxId: "b",
  reason: "low-disk",
  status: "done",
  startedAt: 1,
  finishedAt: 2,
  targetFreeBytes: GB,
  freeBefore: 500 * MB,
  freeAfter: 501 * MB,
  totalBytes: 5 * GB,
  freedBytes: MB,
  steps: [],
  enough: false,
  error: null,
  ...over,
})

let n = 0
const task = (status: TaskStatus, createdAt: number): Task =>
  ({ id: `task_${++n}`, title: `Task ${n}`, status, createdAt, boxId: "b", projectId: "p" }) as Task

describe("box attention", () => {
  it("is empty for a healthy box", () => {
    expect(boxAttention(box("a"))).toEqual([])
  })

  it("flags low disk, red when almost full, and mentions a cleanup that fell short", () => {
    const low = boxAttention(box("a", { diskFreeBytes: 542 * MB, diskLow: true, cleanup: cleanup() }))
    expect(low.map((r) => [r.key, r.level])).toEqual([["disk", "warn"]])
    expect(low[0]!.short).toBe("Low on disk: 542 MB free")
    expect(low[0]!.detail).toContain("the last cleanup still left it short of 1.0 GB")
    expect(boxAttention(box("a", { diskFreeBytes: 100 * MB, diskLow: true }))[0]!.level).toBe("error")
  })

  it("flags a low root disk (/tmp, home) on its own", () => {
    const low = boxAttention(box("a", { rootFreeBytes: 380 * MB, rootTotalBytes: 5 * GB }))
    expect(low.map((r) => [r.key, r.level, r.short])).toEqual([["root", "warn", "Root disk low: 380 MB free"]])
    expect(low[0]!.detail).toContain("380 MB free of 5.0 GB")
    expect(boxAttention(box("a", { rootFreeBytes: 100 * MB, rootTotalBytes: 5 * GB }))[0]!.level).toBe("error")
    expect(boxAttention(box("a", { rootFreeBytes: 2 * GB, rootTotalBytes: 5 * GB }))).toEqual([])
    expect(boxAttention(box("a", { status: "lost", rootFreeBytes: 100 * MB, rootTotalBytes: 5 * GB })).map((r) => r.key)).toEqual(["lost"])
    expect(rootTone(box("a", { rootFreeBytes: 380 * MB, rootTotalBytes: 5 * GB }))).toBe("warn")
    expect(rootTone(box("a"))).toBe("unknown")
  })

  it("flags a lost box, a failed cleanup and too many agents", () => {
    expect(boxAttention(box("a", { status: "lost" })).map((r) => r.key)).toEqual(["lost"])
    expect(boxAttention(box("a", { status: "deleting" })).map((r) => [r.key, r.short])).toEqual([["deleting", "Delete didn't go through yet"]])
    expect(boxAttention(box("a", { cleanup: cleanup({ status: "failed", error: "ssh timeout" }) }))[0]!.detail).toBe("Cleanup failed: ssh timeout")
    expect(boxAttention(box("a", { runningTurns: 3 })).map((r) => r.key)).toEqual(["over"])
  })

  it("colors the disk meter by how low it is", () => {
    expect(diskTone(box("a"))).toBe("ok")
    expect(diskTone(box("a", { diskFreeBytes: 542 * MB, diskLow: true }))).toBe("warn")
    expect(diskTone(box("a", { diskFreeBytes: 100 * MB }))).toBe("error")
    expect(diskTone(box("a", { diskFreeBytes: null, diskTotalBytes: null }))).toBe("unknown")
  })
})

describe("box filters", () => {
  const boxes = [
    box("busy-low", { runningTurns: 1, diskFreeBytes: 400 * MB, diskLow: true }),
    box("idle", {}),
    box("busy", { runningTurns: 2 }),
    box("lost", { status: "lost" }),
  ]

  it("keeps the server's order inside every filter", () => {
    expect(filterBoxes(boxes, "all").map((b) => b.id)).toEqual(["busy-low", "idle", "busy", "lost"])
    expect(filterBoxes(boxes, "busy").map((b) => b.id)).toEqual(["busy-low", "busy"])
    expect(filterBoxes(boxes, "idle").map((b) => b.id)).toEqual(["idle", "lost"])
    expect(filterBoxes(boxes, "attention").map((b) => b.id)).toEqual(["busy-low", "lost"])
  })

  it("counts each filter and reads unknown params as All", () => {
    expect(boxFilterCounts(boxes)).toEqual({ all: 4, busy: 2, idle: 2, attention: 2 })
    expect(parseBoxFilter("attention")).toBe("attention")
    expect(parseBoxFilter("nope")).toBe("all")
    expect(parseBoxFilter(null)).toBe("all")
  })

  it("sums the pool's cost and attention count", () => {
    const s = poolSummary(boxes)
    expect(s.costUsd).toBeCloseTo(0.4, 9)
    expect(s.attention).toBe(2)
  })
})

describe("running now", () => {
  it("is null when nothing is active", () => {
    expect(nowRunning([task("done", 1), task("idle", 2)])).toBeNull()
  })

  it("prefers a working agent over one waiting on someone, and counts the rest", () => {
    const waiting = task("needs_input", 1)
    const working = task("working", 2)
    const r = nowRunning([waiting, working, task("queued", 3), task("done", 4)])!
    expect(r.task).toBe(working)
    expect(r.more).toBe(2)
    expect(nowRunning([waiting])!.task).toBe(waiting)
  })
})

describe("clear/delete helpers", () => {
  it("groups a box's tasks by status in status order", () => {
    expect(statusCounts([{ status: "done" }, { status: "working" }, { status: "done" }, { status: "idle" }])).toEqual([
      { status: "working", count: 1 },
      { status: "idle", count: 1 },
      { status: "done", count: 2 },
    ])
  })

  it("says why the box's actions are disabled", () => {
    expect(boxBusyReason({ operation: null, cleanup: null })).toBeNull()
    expect(boxBusyReason({ operation: "delete", cleanup: null })).toBe("This box is being deleted")
    expect(boxBusyReason({ operation: null, cleanup: cleanup({ status: "running", reason: "manual" }) })).toBe("A disk cleanup is running on this box")
    expect(boxBusyReason({ operation: null, cleanup: cleanup({ status: "running", reason: "clear" }) })).toBe("This box is being cleared")
  })
})
