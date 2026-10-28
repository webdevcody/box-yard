// One period of the Usage page: the total, its split by category, spend over time and
// the breakdown tables. Pure, so the reconciliation rules are tested without a database:
// every breakdown's rows (including its "other" rows) sum to the period total.
import type {
  BoxSize,
  BoxUsageTotals,
  ClaudeUsageTotals,
  UsageBreakdownRow,
  UsageBucket,
  UsageCategory,
  UsagePeriodBox,
  UsagePeriodReport,
} from "../shared/types.js"
import { USAGE_CATEGORIES, weakerSource, type UsageSource } from "../shared/types.js"

/** A claude_usage row in the period, with the names it points at. */
export interface PeriodClaudeRow {
  source: string
  projectId: string | null
  projectName: string | null
  taskId: string | null
  taskTitle: string | null
  scheduleId: string | null
  scheduleName: string | null
  model: string | null
  startedAt: number
  durationMs: number
  costUsd: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalTokens: number
}

/** A metered box interval with its cost already priced (box cost is linear in time, so a part of it costs its share). */
export interface PeriodBoxInterval {
  boxId: string
  size: BoxSize
  keepAlive: boolean
  startedAt: number
  endedAt: number
  activeMs: number
  uptimeMs: number
  diskBytes: number | null
  costUsd: number
  source: UsageSource
}

export interface PeriodInput {
  from: number
  to: number
  claude: PeriodClaudeRow[]
  intervals: PeriodBoxInterval[]
  /** Boxes that exist now. Boxes only seen in intervals are listed as gone. */
  liveBoxes: { boxId: string; size: BoxSize; keepAlive: boolean; diskBytes: number | null }[]
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Hourly buckets for a day or so, daily ones beyond that. */
export function bucketSize(from: number, to: number) {
  return to - from <= 36 * HOUR ? HOUR : DAY
}

/** Coordinator, Captain, agent or schedule run. Older Captain rows are orchestrator rows with a project id. */
export function usageCategory(r: Pick<PeriodClaudeRow, "source" | "projectId" | "scheduleId">): UsageCategory {
  if (r.source === "task") return r.scheduleId ? "schedules" : "agents"
  if (r.source === "captain" || r.projectId) return "captains"
  return "coordinator"
}

/** A run that did work. /context probes and failed starts log a row with no tokens and no cost. */
export const isTurn = (r: Pick<PeriodClaudeRow, "totalTokens" | "costUsd">) => r.totalTokens > 0 || r.costUsd > 0

const CATEGORY_LABEL: Record<UsageCategory, string> = {
  coordinator: "Coordinator",
  captains: "Captains",
  agents: "Agents (tasks)",
  schedules: "Schedule runs",
  boxes: "Boxes",
}

class Rows {
  private map = new Map<string, UsageBreakdownRow & { taskIds?: Set<string> }>()
  get(key: string, init: () => Omit<UsageBreakdownRow, "turns" | "tokens" | "costUsd">) {
    let row = this.map.get(key)
    if (!row) this.map.set(key, (row = { ...init(), turns: 0, tokens: 0, costUsd: 0 }))
    return row
  }
  add(key: string, init: () => Omit<UsageBreakdownRow, "turns" | "tokens" | "costUsd">, r: PeriodClaudeRow) {
    const row = this.get(key, init)
    row.turns += isTurn(r) ? 1 : 0
    row.tokens += r.totalTokens
    row.costUsd += r.costUsd
    if (r.taskId) (row.taskIds ??= new Set()).add(r.taskId)
    return row
  }
  addCost(key: string, init: () => Omit<UsageBreakdownRow, "turns" | "tokens" | "costUsd">, costUsd: number) {
    this.get(key, init).costUsd += costUsd
  }
  list(): UsageBreakdownRow[] {
    return [...this.map.values()]
      .map(({ taskIds, ...row }) => (taskIds && row.runs !== undefined ? { ...row, runs: taskIds.size } : row))
      .sort(byCost)
  }
}

const byCost = (a: UsageBreakdownRow, b: UsageBreakdownRow) => Number(Boolean(a.other)) - Number(Boolean(b.other)) || b.costUsd - a.costUsd || b.tokens - a.tokens

export function buildUsagePeriod(input: PeriodInput): UsagePeriodReport {
  const { from, to } = input
  const bucketMs = bucketSize(from, to)
  const count = Math.max(1, Math.min(400, Math.ceil((to - from) / bucketMs)))
  const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({ start: from + i * bucketMs, costs: zeroCosts() }))
  const bucketAt = (t: number) => buckets[Math.min(count - 1, Math.max(0, Math.floor((t - from) / bucketMs)))]!

  const claude = zeroClaude()
  const categories = Object.fromEntries(USAGE_CATEGORIES.map((c) => [c, { costUsd: 0, turns: 0, tokens: 0 }])) as UsagePeriodReport["categories"]
  const projects = new Rows()
  const tasks = new Rows()
  const models = new Rows()
  const sources = new Rows()
  const captainsByProject = new Rows()
  const schedules = new Rows()

  for (const r of input.claude) {
    if (r.startedAt < from || r.startedAt >= to) continue
    const cat = usageCategory(r)
    claude.costUsd += r.costUsd
    claude.inputTokens += r.inputTokens
    claude.cacheCreationInputTokens += r.cacheCreationInputTokens
    claude.cacheReadInputTokens += r.cacheReadInputTokens
    claude.outputTokens += r.outputTokens
    claude.totalTokens += r.totalTokens
    claude.turns += isTurn(r) ? 1 : 0
    claude.durationMs += r.durationMs
    categories[cat].costUsd += r.costUsd
    categories[cat].tokens += r.totalTokens
    categories[cat].turns += isTurn(r) ? 1 : 0
    bucketAt(r.startedAt).costs[cat] += r.costUsd

    if (cat === "coordinator") projects.add("coordinator", () => ({ key: "coordinator", label: "Coordinator", detail: "Not tied to a project", other: true, category: "coordinator" }), r)
    else if (r.projectId) projects.add(r.projectId, () => ({ key: r.projectId!, label: r.projectName ?? r.projectId!, href: `/projects/${r.projectId}` }), r)
    else projects.add("deleted", () => ({ key: "deleted", label: "Deleted projects", other: true }), r)

    if (cat === "coordinator" || cat === "captains") {
      tasks.add(cat, () => ({ key: cat, label: CATEGORY_LABEL[cat], detail: "Not a task", other: true, category: cat }), r)
    } else if (r.taskId) {
      const detail = [r.projectName, r.scheduleName ? `${r.scheduleName} run` : null].filter(Boolean).join(" · ") || null
      tasks.add(r.taskId, () => ({ key: r.taskId!, label: r.taskTitle ?? r.taskId!, detail, href: `/tasks/${r.taskId}`, category: cat }), r)
    } else tasks.add("deleted", () => ({ key: "deleted", label: "Deleted tasks", other: true, category: cat }), r)

    const model = r.model || "unknown"
    models.add(model, () => ({ key: model, label: r.model || "Unknown model" }), r)

    sources.add(cat, () => ({ key: cat, label: CATEGORY_LABEL[cat], category: cat, ...(cat === "schedules" || cat === "agents" ? { runs: 0 } : {}) }), r)
    if (cat === "captains") {
      const key = r.projectId ?? "deleted"
      captainsByProject.add(key, () => ({ key: `captain:${key}`, label: r.projectId ? `${r.projectName ?? r.projectId} Captain` : "Deleted project's Captain", href: r.projectId ? `/projects/${r.projectId}?tab=captain` : null }), r)
    }
    if (cat === "schedules") {
      const key = r.scheduleId!
      schedules.add(key, () => ({ key: `schedule:${key}`, label: r.scheduleName ?? "Deleted schedule", detail: r.projectName, href: r.scheduleName ? `/schedules#${key}` : null, runs: 0 }), r)
    }
  }

  // Boxes: each interval's share inside the period, split across the buckets it spans.
  const boxes: BoxUsageTotals = { activeMs: 0, uptimeMs: 0, diskBytes: 0, costUsd: 0, source: "actual" }
  const live = new Map(input.liveBoxes.map((b) => [b.boxId, b]))
  const perBox = new Map<string, UsagePeriodBox & { lastAt: number }>()
  for (const iv of input.intervals) {
    const span = Math.max(1, iv.endedAt - iv.startedAt)
    const start = Math.max(from, iv.startedAt)
    const end = Math.min(to, iv.endedAt)
    if (end <= start) continue
    const share = Math.min(1, (end - start) / span)
    const box =
      perBox.get(iv.boxId) ??
      perBox.set(iv.boxId, { boxId: iv.boxId, size: iv.size, keepAlive: iv.keepAlive, live: live.has(iv.boxId), activeMs: 0, uptimeMs: 0, diskBytes: null, costUsd: 0, source: "actual", lastAt: 0 }).get(iv.boxId)!
    box.activeMs += iv.activeMs * share
    box.uptimeMs += iv.uptimeMs * share
    box.costUsd += iv.costUsd * share
    box.source = weakerSource(box.source, iv.source)
    if (iv.endedAt >= box.lastAt) Object.assign(box, { lastAt: iv.endedAt, size: iv.size, keepAlive: iv.keepAlive, diskBytes: iv.diskBytes || box.diskBytes })
    for (let t = start; t < end; ) {
      const b = bucketAt(t)
      const next = Math.min(end, b.start + bucketMs > t ? b.start + bucketMs : end)
      b.costs.boxes += (iv.costUsd * (next - t)) / span
      t = next
    }
  }
  for (const b of input.liveBoxes) {
    if (!perBox.has(b.boxId)) perBox.set(b.boxId, { ...b, live: true, activeMs: 0, uptimeMs: 0, costUsd: 0, source: "estimated", lastAt: 0 })
    else {
      const box = perBox.get(b.boxId)!
      Object.assign(box, { size: b.size, keepAlive: b.keepAlive, diskBytes: b.diskBytes || box.diskBytes })
    }
  }
  const boxList = [...perBox.values()].map(({ lastAt: _, ...b }) => b).sort((a, b) => Number(b.live) - Number(a.live) || b.costUsd - a.costUsd)
  for (const b of boxList) {
    boxes.activeMs += b.activeMs
    boxes.uptimeMs += b.uptimeMs
    boxes.costUsd += b.costUsd
    if (b.uptimeMs > 0) boxes.diskBytes = Math.max(boxes.diskBytes, b.diskBytes ?? 0)
    if (b.uptimeMs > 0) boxes.source = weakerSource(boxes.source, b.source)
  }
  categories.boxes.costUsd = boxes.costUsd

  // Boxes appear in every breakdown so each one sums to the period total.
  const boxRow = (): UsageBreakdownRow => ({ key: "boxes", label: "Boxes", detail: boxes.source === "actual" ? "Shared infrastructure" : `Shared infrastructure, ${boxes.source}`, other: true, category: "boxes", turns: 0, tokens: 0, costUsd: boxes.costUsd })
  const withBoxes = (rows: UsageBreakdownRow[]) => (boxes.costUsd > 0 ? [...rows, boxRow()] : rows)
  const sourceRows = sources.list().map((row) => {
    if (row.key === "captains") return { ...row, children: captainsByProject.list() }
    if (row.key === "schedules") {
      const children = schedules.list()
      return { ...row, detail: `${children.length} ${children.length === 1 ? "schedule" : "schedules"} · ${row.runs ?? 0} runs`, children }
    }
    if (row.key === "agents") return { ...row, detail: `${row.runs ?? 0} ${row.runs === 1 ? "task" : "tasks"}` }
    return row
  })
  const boxChildren: UsageBreakdownRow[] = boxList
    .filter((b) => b.costUsd > 0)
    .map((b) => ({ key: `box:${b.boxId}`, label: b.boxId, detail: `${b.size}${b.keepAlive ? " · keep-alive" : ""}${b.live ? "" : " · deleted"}`, href: b.live ? `/boxes#${b.boxId}` : null, turns: 0, tokens: 0, costUsd: b.costUsd }))

  return {
    from,
    to,
    bucketMs,
    totalCostUsd: claude.costUsd + boxes.costUsd,
    claude,
    boxes,
    categories,
    buckets,
    byProject: withBoxes(projects.list()),
    byTask: withBoxes(tasks.list()),
    byModel: withBoxes(models.list()),
    bySource: boxes.costUsd > 0 ? [...sourceRows, { ...boxRow(), other: false, detail: `${boxChildren.length} ${boxChildren.length === 1 ? "box" : "boxes"}`, children: boxChildren }] : sourceRows,
    boxList,
  }
}

function zeroCosts(): Record<UsageCategory, number> {
  return { coordinator: 0, captains: 0, agents: 0, schedules: 0, boxes: 0 }
}

function zeroClaude(): ClaudeUsageTotals {
  return { costUsd: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, durationMs: 0 }
}
