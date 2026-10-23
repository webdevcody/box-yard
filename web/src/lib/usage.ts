import type { UsageBreakdownRow, UsageCategory } from "../../../shared/types"

export function money(n: number | null | undefined, digits = 2) {
  const v = Number(n ?? 0)
  if (v > 0 && v < 0.01) return "<$0.01"
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function compactTokens(n: number | null | undefined) {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}m`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`
  return String(Math.round(v))
}

export function hours(ms: number | null | undefined) {
  return `${((ms ?? 0) / 3_600_000).toFixed(2)}h`
}

export function bytes(n: number | null | undefined) {
  if (!n) return "unknown"
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

// ---------- the /usage page


/** Category order, names and colors. Colors are the validated dark categorical slots 1-5, in this fixed order. */
export const CATEGORY_META: Record<UsageCategory, { label: string; color: string; hint: string }> = {
  coordinator: { label: "Coordinator", color: "#3987e5", hint: "The Coordinator chat and its schedules" },
  captains: { label: "Captains", color: "#d95926", hint: "Per-project Captains" },
  agents: { label: "Agents", color: "#199e70", hint: "Task turns you or the Coordinator started" },
  schedules: { label: "Schedule runs", color: "#c98500", hint: "Task turns started by a schedule" },
  boxes: { label: "Boxes", color: "#d55181", hint: "Upstash Box time and storage, estimated from your rates" },
}

export type PeriodKey = "today" | "7d" | "30d" | "custom"
export const PERIODS: { key: PeriodKey; label: string; short: string }[] = [
  { key: "today", label: "Today", short: "Today" },
  { key: "7d", label: "Last 7 days", short: "7 days" },
  { key: "30d", label: "Last 30 days", short: "30 days" },
  { key: "custom", label: "Custom range", short: "Custom" },
]

const DAY = 24 * 3_600_000

export function startOfDay(t: number) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `YYYY-MM-DD` in local time. */
export function dateInput(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Local midnight of a `YYYY-MM-DD`, or null. */
export function parseDateInput(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "")
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isNaN(t) ? null : t
}

/** Days back from local midnight, so N days means today plus the N-1 days before it. */
function daysBack(now: number, n: number) {
  const d = new Date(startOfDay(now))
  d.setDate(d.getDate() - (n - 1))
  return d.getTime()
}

/**
 * The range a period covers, in local time: from a local midnight to now, or to the end of the
 * custom range's last day. A custom range with bad or reversed dates falls back to 7 days.
 */
export function periodRange(key: PeriodKey, now: number, custom?: { from?: string | null; to?: string | null }): { key: PeriodKey; from: number; to: number } {
  if (key === "today") return { key, from: startOfDay(now), to: now }
  if (key === "30d") return { key, from: daysBack(now, 30), to: now }
  if (key === "custom") {
    const from = parseDateInput(custom?.from)
    const toDay = parseDateInput(custom?.to) ?? startOfDay(now)
    if (from !== null && from <= toDay) {
      const end = new Date(toDay)
      end.setDate(end.getDate() + 1)
      return { key, from, to: Math.min(now, end.getTime()) }
    }
  }
  return { key: key === "custom" ? "custom" : "7d", from: daysBack(now, 7), to: now }
}

/** "Oct 17 – Oct 23", or one day. */
export function rangeLabel(from: number, to: number) {
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  const last = Math.max(from, to - 1)
  return startOfDay(from) === startOfDay(last) ? fmt(from) : `${fmt(from)} – ${fmt(last)}`
}

export type BreakdownSort = "name" | "turns" | "tokens" | "cost" | "avg" | "share"

export const avgPerTurn = (r: Pick<UsageBreakdownRow, "turns" | "costUsd">) => (r.turns > 0 ? r.costUsd / r.turns : null)

/**
 * Sorted rows. Rows of the breakdown's own kind come first; "other" rows (Boxes, the
 * Coordinator in By project, deleted things) stay at the bottom so the top N is real.
 */
export function sortBreakdown(rows: UsageBreakdownRow[], sort: BreakdownSort, dir: "asc" | "desc"): UsageBreakdownRow[] {
  const value = (r: UsageBreakdownRow): number | string => {
    if (sort === "name") return r.label.toLowerCase()
    if (sort === "turns") return r.turns
    if (sort === "tokens") return r.tokens
    if (sort === "avg") return avgPerTurn(r) ?? -1
    return r.costUsd
  }
  const sign = dir === "asc" ? 1 : -1
  const cmp = (a: UsageBreakdownRow, b: UsageBreakdownRow) => {
    const x = value(a)
    const y = value(b)
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)
    return c * sign || b.costUsd - a.costUsd
  }
  return [...rows.filter((r) => !r.other).sort(cmp), ...rows.filter((r) => r.other).sort((a, b) => b.costUsd - a.costUsd)]
}

/** Percent of the total, one decimal under 10%. */
export function pct(part: number, total: number) {
  if (!(total > 0)) return "0%"
  const p = (part / total) * 100
  if (p > 0 && p < 0.1) return "<0.1%"
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`
}

/** A round axis maximum and its ticks (0 included), about `count` steps. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const top = Math.ceil(max / step - 1e-9) * step
  const out: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

/** Axis money: $0, $5, $12.50, $1.2k. */
export function axisMoney(v: number) {
  if (v >= 1000) return `$${+(v / 1000).toFixed(1)}k`
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`
}
