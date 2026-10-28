// The cloud meter's words (CloudMeter.tsx): today's box spend against the daily cloud limit, and each box's state.
import type { CloudBox, CloudSpend, CloudStatus } from "../../../shared/types"

/** "$10", "$3.10", "<$0.01" */
export function dollars(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01"
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

/** "$0.42/h" */
export const perHour = (n: number) => `${dollars(Math.round(n * 100) / 100)}/h`

/** Share of today's limit used, 0-100 (rounded down, so 99.6% isn't "100%" before the limit); null without a limit. */
export function limitPct(spend: CloudSpend): number | null {
  if (spend.dailyLimitUsd <= 0) return null
  return Math.min(100, Math.floor((spend.todayUsd / spend.dailyLimitUsd) * 100))
}

/** "$3.10 of $10", or "$3.10 today" without a daily limit. */
export const todayLine = (spend: CloudSpend) => (spend.dailyLimitUsd > 0 ? `${dollars(spend.todayUsd)} of ${dollars(spend.dailyLimitUsd)}` : `${dollars(spend.todayUsd)} today`)

/** "2 running · 1 idle", with starting boxes when there are any; "No boxes" when there are none. */
export function countsLine(boxes: CloudStatus["boxes"]): string {
  if (boxes.total === 0) return "No boxes"
  const parts = [`${boxes.running} running`, `${boxes.idle} idle`]
  if (boxes.creating > 0) parts.push(`${boxes.creating} starting`)
  return parts.join(" · ")
}

/** "7 new boxes" */
export const newBoxes = (n: number) => `${n} new ${n === 1 ? "box" : "boxes"}`

/** The chip's full reading, for its accessible name and tooltip. */
export function meterLabel(s: CloudStatus): string {
  const limit = s.spend.dailyLimitUsd > 0 ? `${todayLine(s.spend)} today's cloud limit` : `${dollars(s.spend.todayUsd)} today, no daily limit`
  const state = s.spend.state === "reached" ? ". New boxes wait" : s.spend.state === "warning" ? ". Near today's limit" : ""
  const fanout = s.fanout.wanted > 0 ? `. ${newBoxes(s.fanout.wanted)} wait for your OK` : ""
  return `Cloud boxes: ${countsLine(s.boxes)} · ${perHour(s.hourlyUsd)} now · ${limit}${state}${fanout}`
}

/** The chip's tone: the spend's, or amber while new boxes wait for an OK. */
export const meterState = (s: CloudStatus): CloudSpend["state"] => (s.spend.state === "ok" && s.fanout.wanted > 0 ? "warning" : s.spend.state)

/** Chip colours: calm, amber from 80% of a limit, rose at it. */
export const METER_TONE: Record<CloudSpend["state"], string> = {
  ok: "border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20",
  reached: "border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
}

/** The bar's fill for the same states. */
export const BAR_TONE: Record<CloudSpend["state"], string> = { ok: "bg-sky-500", warning: "bg-amber-400", reached: "bg-rose-500" }

/** "in 12 min", "in 1 h 5 min", "any moment" */
export function inMinutes(at: number, now: number): string {
  const min = Math.ceil((at - now) / 60_000)
  if (min <= 0) return "any moment"
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `in ${h} h ${min % 60} min` : `in ${h} h`
}

/** What a box is doing, and for an idle one when the idle sweep deletes it (or why it's kept). */
export function boxState(b: CloudBox, now: number): { text: string; tone: "busy" | "idle" | "held" | "muted" } {
  if (b.status === "creating") return { text: "Starting", tone: "muted" }
  if (b.status === "deleting") return { text: "Deleting", tone: "muted" }
  if (b.status === "lost") return { text: "Lost: not answering", tone: "held" }
  if (b.runningTurns > 0) return { text: b.runningTurns === 1 ? "Running 1 turn" : `Running ${b.runningTurns} turns`, tone: "busy" }
  if (b.idleHeld) return { text: `Idle, kept: ${b.idleHeld}`, tone: "held" }
  if (b.deletesAt !== null) return { text: `Idle, deleted ${inMinutes(b.deletesAt, now)}`, tone: "idle" }
  return { text: "Idle", tone: "idle" }
}
