import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../server/db.js"
import { Store } from "../server/store.js"
import { compareRunning, countLabel, elapsedLabel, isRunning, runningCount, runningSince } from "../web/src/lib/runningTasks.js"
import { freshOrder, stableView } from "../web/src/lib/stableOrder.js"
import { TASK_STATUSES, type Task, type TaskStatus } from "../shared/types.js"

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
    waitReason: null,
    waitBoxSize: null,
    waitFor: [],
    turnCount: 0,
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
    runsOn: null,
    createdAt: n * 1000,
    updatedAt: n * 1000,
    ...over,
  }
}

describe("running tasks", () => {
  it("counts queued, starting and working, and nothing else", () => {
    const running = TASK_STATUSES.filter((status) => isRunning({ status }))
    expect(running.sort()).toEqual(["queued", "starting", "working"])
    // needs_input waits on the owner and waiting is held on another agent: neither has a turn running.
    expect(isRunning({ status: "needs_input" })).toBe(false)
    expect(isRunning({ status: "waiting" })).toBe(false)
    expect(runningCount(TASK_STATUSES.map((s) => task(s)))).toBe(3)
    expect(runningCount([task("working"), task("working"), task("idle"), task("pr_ready")])).toBe(2)
    expect(runningCount([])).toBe(0)
    expect(runningCount(undefined)).toBe(0)
  })

  it("caps the badge's text at 99+", () => {
    expect(countLabel(0)).toBe("0")
    expect(countLabel(7)).toBe("7")
    expect(countLabel(99)).toBe("99")
    expect(countLabel(100)).toBe("99+")
  })

  it("times a run from its turn's start, else from its last status change", () => {
    expect(runningSince(task("working", { turnStartedAt: 5_000, updatedAt: 9_000 }))).toBe(5_000)
    expect(runningSince(task("queued", { turnStartedAt: null, updatedAt: 9_000 }))).toBe(9_000)
    expect(runningSince(task("queued", { updatedAt: 9_000 }))).toBe(9_000)
  })

  it("says how long in minutes, hours and days", () => {
    expect(elapsedLabel(-5)).toBe("<1m")
    expect(elapsedLabel(59_000)).toBe("<1m")
    expect(elapsedLabel(60_000)).toBe("1m")
    expect(elapsedLabel(59 * 60_000)).toBe("59m")
    expect(elapsedLabel(60 * 60_000)).toBe("1h")
    expect(elapsedLabel(65 * 60_000)).toBe("1h 5m")
    expect(elapsedLabel(24 * 3600_000)).toBe("1d")
    expect(elapsedLabel(27 * 3600_000 + 59 * 60_000)).toBe("1d 3h")
  })

  it("lists running tasks oldest first, and a status change never moves a row", () => {
    const a = task("queued", { createdAt: 3_000 })
    const b = task("working", { createdAt: 1_000 })
    const c = task("idle", { createdAt: 2_000 })
    const d = task("starting", { createdAt: 2_000, id: "t0" })
    const opts = { key: (t: Task) => t.id, compare: compareRunning, include: isRunning }
    const frozen = freshOrder([a, b, c, d], opts)
    expect(frozen.map((t) => t.id)).toEqual([b.id, d.id, a.id])

    // a starts, d starts working, b finishes: nothing moves, b dims in place, nothing waits for a re-sort but b.
    const live = [{ ...a, status: "working" as const }, { ...b, status: "pr_ready" as const }, c, { ...d, status: "working" as const }]
    const view = stableView(frozen, live, opts)
    expect(view.entries.map((e) => [e.item.id, e.stale])).toEqual([
      [b.id, true],
      [d.id, false],
      [a.id, false],
    ])
    expect(view.changedCount).toBe(1)
    expect(view.newCount).toBe(0)
    expect(freshOrder(live, opts).map((t) => t.id)).toEqual([d.id, a.id])
  })
})

describe("Task.turnStartedAt", () => {
  it("is the running turn's start, and null between turns", () => {
    const db = new Database(":memory:")
    try {
      migrate(db)
      const store = new Store(db)
      const p = store.createProject({ name: "box-yard" })
      const t = store.createTask({ projectId: p.id, title: "t", prompt: "x" })
      expect(store.getTask(t.id)!.turnStartedAt).toBeNull()
      // Claimed but the turn's ledger row isn't written yet: still null (the badge falls back to updatedAt).
      store.updateTask(t.id, { status: "starting", currentTurnId: "turn-1" })
      expect(store.getTask(t.id)!.turnStartedAt).toBeNull()
      const before = Date.now()
      store.startTaskTurn({ id: "turn-1", taskId: t.id, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null })
      const at = store.getTask(t.id)!.turnStartedAt!
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(Date.now())
      store.updateTask(t.id, { status: "idle", currentTurnId: null })
      expect(store.getTask(t.id)!.turnStartedAt).toBeNull()
    } finally {
      db.close()
    }
  })
})
