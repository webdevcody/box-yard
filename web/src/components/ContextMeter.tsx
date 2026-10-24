import { Loader2, Minimize2 } from "lucide-react"
import { Button, cx } from "./ui"

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}m`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function contextPct(tokens: number | null, window: number | null): number | null {
  return tokens !== null && window ? Math.min(100, Math.round((tokens / window) * 100)) : null
}

export function contextLabel(tokens: number | null, window: number | null): string {
  if (tokens === null) return "Context: not measured yet"
  return window ? `${formatTokens(tokens)} / ${formatTokens(window)} · ${contextPct(tokens, window)}%` : `${formatTokens(tokens)} tokens`
}

export const CONTEXT_HINT = "How much of this agent's context window is used. Compact when it gets high."

/** Context use only gets loud near the limit: amber from 75%, red from 90%. Below that it stays muted. */
export const CONTEXT_WARN_PCT = 75
export const CONTEXT_DANGER_PCT = 90

export function contextTone(pct: number | null): { bar: string; text: string } {
  if (pct !== null && pct >= CONTEXT_DANGER_PCT) return { bar: "bg-red-500", text: "text-red-300" }
  if (pct !== null && pct >= CONTEXT_WARN_PCT) return { bar: "bg-amber-400", text: "text-amber-300" }
  return { bar: "bg-zinc-500", text: "text-zinc-500" }
}

/**
 * A tiny bar and the percentage ("58%"). The full reading ("Context 576k / 1m · 58%") is the tooltip and
 * the accessible name. Not clickable; Compact lives in the ⋯ menu (and next to it in the task header when high).
 */
export function ContextMiniBar({ tokens, window, hint = CONTEXT_HINT, className }: { tokens: number | null; window: number | null; hint?: string; className?: string }) {
  const pct = contextPct(tokens, window)
  if (pct === null) return null
  const tone = contextTone(pct)
  const label = `Context ${contextLabel(tokens, window)}`
  return (
    <span title={`${label}. ${hint}`} className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap tabular-nums", tone.text, className)} data-testid="context-mini">
      <span aria-hidden className="block h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        <span className={cx("block h-full rounded-full", tone.bar)} style={{ width: `${Math.max(pct, 4)}%` }} />
      </span>
      {/* Room for "100%", so the width holds as the number grows. */}
      <span aria-hidden className="min-w-[4ch]">{pct}%</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** "84k / 1m · 8%" with a small bar and a Compact button. */
export function ContextMeter({
  tokens,
  window,
  compacting,
  queued,
  canCompact = true,
  onCompact,
  className,
}: {
  tokens: number | null
  window: number | null
  compacting: boolean
  /** A compaction is waiting for the current turn to end. */
  queued: boolean
  canCompact?: boolean
  onCompact: () => void
  className?: string
}) {
  const pct = contextPct(tokens, window)
  const bar = pct === null ? "bg-zinc-600" : pct >= CONTEXT_WARN_PCT ? contextTone(pct).bar : "bg-yard-500"
  const label = contextLabel(tokens, window)
  return (
    <div className={cx("flex items-center gap-2 text-xs text-zinc-400", className)} data-testid="context-meter">
      <div className="min-w-0">
        <div className="whitespace-nowrap tabular-nums" title={CONTEXT_HINT}>
          {label}
        </div>
        <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-zinc-800">
          <div className={cx("h-full rounded-full transition-all", bar)} style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
      <Button
        size="sm"
        variant="subtle"
        onClick={onCompact}
        disabled={!canCompact || compacting || queued}
        title="Summarise the conversation to free up context. If a turn is running, it compacts right after."
      >
        {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Minimize2 className="h-3.5 w-3.5" />}
        {compacting ? "Compacting…" : queued ? "Compact queued" : "Compact"}
      </Button>
    </div>
  )
}
