import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { buildUsagePeriod, type PeriodClaudeRow } from "../server/usagePeriod.js"
import type { UsagePeriodReport } from "../shared/types.js"
import { USAGE_CATEGORIES } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const H = 3_600_000
const D = 24 * H
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const rates = () => new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates
const sum = (xs: { costUsd: number }[]) => xs.reduce((a, x) => a + x.costUsd, 0)

/** Every breakdown, the category split and the chart all add up to the period total. */
function expectReconciles(p: UsagePeriodReport) {
  for (const key of ["byProject", "byTask", "byModel", "bySource"] as const) expect(sum(p[key]), key).toBeCloseTo(p.totalCostUsd, 9)
  expect(USAGE_CATEGORIES.reduce((a, c) => a + p.categories[c].costUsd, 0)).toBeCloseTo(p.totalCostUsd, 9)
  expect(p.buckets.reduce((a, b) => a + USAGE_CATEGORIES.reduce((x, c) => x + b.costs[c], 0), 0)).toBeCloseTo(p.totalCostUsd, 9)
  expect(p.claude.costUsd + p.boxes.costUsd).toBeCloseTo(p.totalCostUsd, 9)
  expect(sum(p.boxList)).toBeCloseTo(p.boxes.costUsd, 9)
  for (const row of p.bySource) if (row.children?.length) expect(sum(row.children), `${row.key} children`).toBeCloseTo(row.costUsd, 9)
}

describe("per-run Claude cost", () => {
  it("charges each run the step in the session's running total, not the total", () => {
    const store = memStore()
    const t0 = Date.now()
    const run = (sessionId: string | null, reported: number, i: number, tokens = 1000) =>
      store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId, startedAt: t0 + i, endedAt: t0 + i, usage: { input_tokens: tokens }, costUsd: reported })
    expect(run("s1", 1, 1)).toBe(1)
    expect(run("s1", 3, 2)).toBe(2)
    expect(run("s1", 3, 3, 0)).toBe(0) // a /context probe re-reports the same total
    expect(run("s1", 6, 4)).toBeCloseTo(3, 9)
    expect(run("s2", 0.5, 5)).toBe(0.5) // other sessions are independent
    expect(run("s1", 0.25, 6)).toBe(0.25) // total went down: the CLI reset it, so this is the run's own cost
    expect(run("s1", 1.25, 7)).toBe(1)
    expect(run(null, 2, 8)).toBe(2) // no session to compare with
    const rows = store.db.prepare("SELECT cost_usd AS c, reported_cost_usd AS r FROM claude_usage ORDER BY ended_at").all() as { c: number; r: number }[]
    expect(rows.map((r) => r.r)).toEqual([1, 3, 3, 6, 0.5, 0.25, 1.25, 2])
    expect(rows.reduce((a, r) => a + r.c, 0)).toBeCloseTo(1 + 2 + 0 + 3 + 0.5 + 0.25 + 1 + 2, 9)
  })

  it("a crash that reports $0 doesn't reset the baseline", () => {
    const store = memStore()
    const t0 = Date.now()
    const run = (reported: number, i: number) =>
      store.recordClaudeUsage({ source: "task", runKind: "turn", sessionId: "s", startedAt: t0 + i, endedAt: t0 + i, durationMs: 10, usage: { input_tokens: 10 }, costUsd: reported })
    run(2, 1)
    expect(run(0, 2)).toBe(0)
    expect(run(2.5, 3)).toBeCloseTo(0.5, 9)
  })
})

describe("usage migration", () => {
  it("turns logged running totals into per-run costs, keeps legacy Captain rows as Captain spend, and survives deletes", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    migrate(db, MIGRATIONS.length - 1)
    const store = new Store(db)
    const p = store.createProject({ name: "demo" })
    const task = store.createTask({ projectId: p.id, title: "t", prompt: "t" })
    let n = 0
    const legacy = (source: string, session: string, reported: number, extra: { projectId?: string; taskId?: string } = {}) =>
      db
        .prepare(
          `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, session_id, started_at, ended_at, total_tokens, input_tokens, cost_usd)
           VALUES (?, ?, 'turn', ?, ?, ?, ?, ?, 100, 100, ?)`,
        )
        .run(`cu_${++n}`, source, extra.taskId ?? null, extra.projectId ?? null, session, 1000 + n, 1000 + n, reported)
    legacy("orchestrator", "coord", 1)
    legacy("orchestrator", "coord", 2.5)
    legacy("orchestrator", "coord", 2.5) // /context probe
    legacy("orchestrator", "coord", 4)
    legacy("orchestrator", "cap", 0.5, { projectId: p.id }) // Captain row from before source='captain'
    legacy("orchestrator", "cap", 0.75, { projectId: p.id })
    legacy("task", "task-s", 3, { projectId: p.id, taskId: task.id })
    legacy("task", "task-s", 5, { projectId: p.id, taskId: task.id })
    migrate(db)

    const rows = db.prepare("SELECT source, cost_usd AS c, reported_cost_usd AS r FROM claude_usage ORDER BY ended_at").all() as { source: string; c: number; r: number }[]
    expect(rows.map((r) => r.c)).toEqual([1, 1.5, 0, 1.5, 0.5, 0.25, 3, 2])
    expect(rows.map((r) => r.r)).toEqual([1, 2.5, 2.5, 4, 0.5, 0.75, 3, 5])
    expect(rows.filter((r) => r.source === "captain")).toHaveLength(2)

    // New runs continue from the migrated running totals.
    expect(store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId: "coord", startedAt: 2000, endedAt: 2000, usage: { input_tokens: 1 }, costUsd: 4.5 })).toBeCloseTo(0.5, 9)

    // Deleting the task and its project keeps the spend (it was ON DELETE CASCADE).
    const before = store.usagePeriod(0, 10_000, rates())
    store.deleteTask(task.id)
    store.deleteProject(p.id)
    const after = store.usagePeriod(0, 10_000, rates())
    expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd, 9)
    expect(after.categories.captains.costUsd).toBeCloseTo(0.75, 9)
    expect(after.categories.coordinator.costUsd).toBeCloseTo(4.5, 9)
    expect(after.byProject.find((r) => r.key === "deleted")?.costUsd).toBeCloseTo(5.75, 9)
    expectReconciles(after)
  })
})

describe("period report reconciliation", () => {
  /** A seeded yard: Coordinator, new and legacy Captain rows, ad-hoc tasks, schedule runs, probes, boxes, a deleted task. */
  function seeded() {
    const store = memStore()
    const now = Date.UTC(2026, 9, 23, 12)
    const from = now - 7 * D
    const a = store.createProject({ name: "alpha" })
    const b = store.createProject({ name: "beta" })
    const sch = store.createSchedule({ projectId: a.id, name: "PR Merger", cron: "0 * * * *", timezone: "UTC", prompt: "merge", nextRunAt: null })
    const t1 = store.createTask({ projectId: a.id, title: "Feature", prompt: "x", model: "claude-opus-5-5" })
    const t2 = store.createTask({ projectId: b.id, title: "Bug", prompt: "y", model: "claude-sonnet-5-5" })
    const gone = store.createTask({ projectId: b.id, title: "Deleted later", prompt: "z" })
    const truth = { coordinator: 0, captains: 0, agents: 0, schedules: 0 }
    let i = 0
    /** One session; `costs` are the true per-run costs. The CLI reports their running total. */
    const session = (cat: keyof typeof truth, opts: Partial<Parameters<Store["recordClaudeUsage"]>[0]> & { source: "task" | "orchestrator" | "captain" }, costs: number[], at: number) => {
      const id = `ses${++i}`
      let total = 0
      costs.forEach((c, k) => {
        total += c
        if (at + k * H >= from && at + k * H < now) truth[cat] += c
        store.recordClaudeUsage({ runKind: "turn", sessionId: id, model: "claude-opus-5-5", startedAt: at + k * H, endedAt: at + k * H + 60_000, usage: c ? { input_tokens: 1000, output_tokens: 100 } : null, durationMs: 60_000, costUsd: total, ...opts })
      })
    }
    // Coordinator: one session started before the period, with a /context probe (cost step 0) between turns.
    session("coordinator", { source: "orchestrator" }, [0.4, 0.6, 0, 0.8, 0, 1.1], from - 2 * H)
    session("captains", { source: "captain", projectId: a.id }, [0.2, 0.3], from + D)
    session("captains", { source: "orchestrator", projectId: b.id }, [0.15, 0.25], from + 2 * D) // legacy Captain rows
    session("agents", { source: "task", taskId: t1.id, projectId: a.id }, [2, 1.5, 3], from + 3 * D)
    session("agents", { source: "task", taskId: t2.id, projectId: b.id, model: "claude-sonnet-5-5" }, [0.9], from + 4 * D)
    session("agents", { source: "task", taskId: gone.id, projectId: b.id }, [1.2, 0.3], from + 5 * D)
    for (let k = 0; k < 5; k++) {
      const run = store.createTask({ projectId: a.id, title: `PR Merger run ${k}`, prompt: "merge", scheduleId: sch.id })
      session("schedules", { source: "task", taskId: run.id, projectId: a.id }, [0.25], from + k * D + 6 * H)
    }
    store.deleteTask(gone.id)
    // Boxes: one interval straddles the period start, so only its in-period half counts.
    store.upsertBox({ id: "box-a", provider: "local", status: "ready", created_at: from - D, last_used_at: now, size: "small", keep_alive: 0 })
    store.recordBoxUsageInterval({ boxId: "box-a", provider: "local", size: "small", keepAlive: false, startedAt: from - H, endedAt: from + H, activeMs: 2 * H, uptimeMs: 2 * H, source: "estimated" })
    store.recordBoxUsageInterval({ boxId: "box-a", provider: "local", size: "small", keepAlive: false, startedAt: from + 2 * D, endedAt: from + 2 * D + 3 * H, activeMs: 3 * H, uptimeMs: 3 * H, source: "estimated" })
    store.recordBoxUsageInterval({ boxId: "box-gone", provider: "local", size: "medium", keepAlive: true, startedAt: from + D, endedAt: from + D + 2 * H, activeMs: H, uptimeMs: 2 * H, diskBytes: 2 * 1024 ** 3, source: "estimated" })
    return { store, from, now, truth, a, b, sch, t1 }
  }

  it("every breakdown sums to the period total, with no double counting", () => {
    const { store, from, now, truth, a, b, sch, t1 } = seeded()
    const r = rates()
    const p = store.usagePeriod(from, now, r)
    expectReconciles(p)

    // Claude spend is the true per-run costs, not the sum of running totals.
    expect(p.categories.coordinator.costUsd).toBeCloseTo(truth.coordinator, 9)
    expect(p.categories.captains.costUsd).toBeCloseTo(truth.captains, 9)
    expect(p.categories.agents.costUsd).toBeCloseTo(truth.agents, 9)
    expect(p.categories.schedules.costUsd).toBeCloseTo(truth.schedules, 9)
    expect(p.claude.costUsd).toBeCloseTo(truth.coordinator + truth.captains + truth.agents + truth.schedules, 9)

    // The Coordinator's first run started before the period; its probes aren't turns.
    expect(p.categories.coordinator.turns).toBe(2)
    // Box cost: half of the straddling interval (1h active) + 3h, plus the deleted medium box.
    const smallHour = r.boxActiveCpuHourlyUsd.small
    expect(p.boxList.find((x) => x.boxId === "box-a")!.costUsd).toBeCloseTo(4 * smallHour, 9)
    expect(p.boxList.find((x) => x.boxId === "box-gone")!.live).toBe(false)

    // Projects include their tasks, schedule runs and Captain; the Coordinator is its own row.
    const proj = (id: string) => p.byProject.find((x) => x.key === id)!
    expect(proj(a.id).costUsd).toBeCloseTo(0.5 + 6.5 + 1.25, 9)
    expect(proj(b.id).costUsd).toBeCloseTo(0.4 + 0.9 + 1.5, 9)
    expect(proj("coordinator").other).toBe(true)
    expect(p.byProject.at(-1)!.key).toBe("boxes")

    // Tasks link to their task; the deleted task's spend stays on a "Deleted tasks" row.
    expect(p.byTask.find((x) => x.key === t1.id)).toMatchObject({ href: `/tasks/${t1.id}`, turns: 3, label: "Feature" })
    expect(p.byTask.find((x) => x.key === "deleted")!.costUsd).toBeCloseTo(1.5, 9)

    // Schedule runs group under their schedule.
    const schedules = p.bySource.find((x) => x.key === "schedules")!
    expect(schedules.children).toEqual([expect.objectContaining({ key: `schedule:${sch.id}`, label: "PR Merger", runs: 5, turns: 5, href: `/schedules#${sch.id}` })])
    expect(p.byModel.find((x) => x.key === "claude-sonnet-5-5")!.costUsd).toBeCloseTo(0.9, 9)
  })

  it("reconciles for any sub-range, and the ranges add up", () => {
    const { store, from, now } = seeded()
    const r = rates()
    const mid = from + 3.5 * D
    const left = store.usagePeriod(from, mid, r)
    const right = store.usagePeriod(mid, now, r)
    const whole = store.usagePeriod(from, now, r)
    for (const p of [left, right, whole]) expectReconciles(p)
    expect(left.totalCostUsd + right.totalCostUsd).toBeCloseTo(whole.totalCostUsd, 9)
  })

  it("the old all-time fields use per-run costs too", () => {
    const { store, now, truth } = seeded()
    const report = store.usageReport({ costRates: rates(), budget: { dailyUsd: 0, monthlyUsd: 0 } }, now)
    expect(report.period).toBeUndefined()
    // All-time includes the Coordinator's two runs from before the 7-day period.
    expect(report.orchestrator.costUsd).toBeCloseTo(truth.coordinator + 1, 9)
  })
})

describe("buildUsagePeriod", () => {
  const row = (over: Partial<PeriodClaudeRow>): PeriodClaudeRow => ({
    source: "task",
    projectId: "p",
    projectName: "P",
    taskId: "t",
    taskTitle: "T",
    scheduleId: null,
    scheduleName: null,
    model: "m",
    startedAt: 0,
    durationMs: 0,
    costUsd: 1,
    inputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 10,
    ...over,
  })

  it("buckets by hour for a day and by day beyond that, splitting box intervals across buckets", () => {
    const day = buildUsagePeriod({ from: 0, to: D, claude: [row({ startedAt: 90 * 60_000 })], intervals: [], liveBoxes: [] })
    expect(day.bucketMs).toBe(H)
    expect(day.buckets).toHaveLength(24)
    expect(day.buckets[1]!.costs.agents).toBe(1)

    const week = buildUsagePeriod({
      from: 0,
      to: 7 * D,
      claude: [row({ startedAt: -1 }), row({ startedAt: 7 * D })], // both outside [from, to)
      intervals: [{ boxId: "b", size: "small", keepAlive: false, startedAt: D - H, endedAt: D + H, activeMs: 2 * H, uptimeMs: 2 * H, diskBytes: null, costUsd: 2, source: "estimated" }],
      liveBoxes: [],
    })
    expect(week.bucketMs).toBe(D)
    expect(week.claude.costUsd).toBe(0)
    expect(week.buckets[0]!.costs.boxes).toBeCloseTo(1, 9)
    expect(week.buckets[1]!.costs.boxes).toBeCloseTo(1, 9)
    expectReconciles(week)
  })

  it("labels categories by source: Coordinator, Captains (new and legacy), agents, schedule runs", () => {
    const p = buildUsagePeriod({
      from: 0,
      to: D,
      claude: [
        row({ source: "orchestrator", projectId: null, taskId: null }),
        row({ source: "orchestrator", taskId: null, costUsd: 2 }),
        row({ source: "captain", taskId: null, costUsd: 4 }),
        row({ costUsd: 8 }),
        row({ scheduleId: "s", scheduleName: "S", costUsd: 16 }),
      ],
      intervals: [],
      liveBoxes: [],
    })
    expect(p.categories.coordinator.costUsd).toBe(1)
    expect(p.categories.captains.costUsd).toBe(6)
    expect(p.categories.agents.costUsd).toBe(8)
    expect(p.categories.schedules.costUsd).toBe(16)
    expectReconciles(p)
  })
})
