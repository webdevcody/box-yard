import type { BudgetSettings, CloudSpend, CostRates } from "../shared/types.js"
import type { Store } from "./store.js"

// Settings › Daily cloud limit: what boxes may cost per day (Upstash bills the CPU they use). At 80% Box Yard says
// so; at 100% no new box is made until midnight or a raise ("Raise today's limit"), and running work goes on.

/** Today's raises: { day: "2026-10-27", usd: 10 }, read only on that local day. */
export const CLOUD_RAISE_KEY = "cloud_limit_raise"
const DAY_MS = 24 * 60 * 60 * 1000

export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local calendar day, "2026-10-27". */
export function localDay(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "$1.20", "$0.04", "$12" */
export const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/** What raises added to today's limit; 0 on any other day. */
export function todaysRaise(store: Pick<Store, "getKv">, now = Date.now()): number {
  try {
    const v = JSON.parse(store.getKv(CLOUD_RAISE_KEY) ?? "null") as { day?: unknown; usd?: unknown } | null
    return v && v.day === localDay(now) && typeof v.usd === "number" && v.usd > 0 ? v.usd : 0
  } catch {
    return 0
  }
}

/**
 * "Raise today's limit": one more day's worth (Settings' daily limit) on top of today's limit, or of today's spend if
 * that's past it already (boxes that ran on go over a little), so a raise always leaves room for new boxes. It lapses
 * at local midnight. Returns the new total raise. Nothing to raise without a daily limit.
 */
export function raiseToday(store: Pick<Store, "getKv" | "setKv">, budget: BudgetSettings, todayUsd: number, now = Date.now()): number {
  if (budget.dailyUsd <= 0) return 0
  const limit = budget.dailyUsd + todaysRaise(store, now)
  // The new limit is max(limit, todayUsd) + dailyUsd, so the raise on top of Settings' limit is:
  const raised = Math.round(Math.max(limit, todayUsd) * 100) / 100
  store.setKv(CLOUD_RAISE_KEY, JSON.stringify({ day: localDay(now), usd: raised }))
  return raised
}

/** Box spend today and over 30 days against the limits. `month: false` skips the 30-day sum while there's no monthly limit. */
export function cloudSpend(store: Pick<Store, "getKv" | "boxSpendSince">, budget: BudgetSettings, rates: CostRates, now = Date.now(), opts: { month?: boolean } = {}): CloudSpend {
  const today = store.boxSpendSince(startOfLocalDay(now), rates).totals
  const wantMonth = opts.month ?? budget.monthlyUsd > 0
  const month = wantMonth ? store.boxSpendSince(now - 30 * DAY_MS, rates).totals : null
  const raisedUsd = budget.dailyUsd > 0 ? todaysRaise(store, now) : 0
  const dailyLimitUsd = budget.dailyUsd > 0 ? budget.dailyUsd + raisedUsd : 0
  const monthlyLimitUsd = budget.monthlyUsd > 0 ? budget.monthlyUsd : 0
  const monthUsd = month?.costUsd ?? 0
  const over = (used: number, limit: number, share: number) => limit > 0 && used >= limit * share - 1e-9
  const blockedReason = over(today.costUsd, dailyLimitUsd, 1)
    ? `today's cloud spend is ${usd(today.costUsd)} of its ${usd(dailyLimitUsd)} limit`
    : month && over(monthUsd, monthlyLimitUsd, 1)
      ? `cloud spend over the last 30 days is ${usd(monthUsd)} of its ${usd(monthlyLimitUsd)} monthly limit`
      : null
  const warning = over(today.costUsd, dailyLimitUsd, 0.8) || (month !== null && over(monthUsd, monthlyLimitUsd, 0.8))
  return {
    todayUsd: today.costUsd,
    dailyLimitUsd,
    raisedUsd,
    monthUsd,
    monthlyLimitUsd,
    state: blockedReason ? "reached" : warning ? "warning" : "ok",
    blockedReason,
    source: today.source,
  }
}
