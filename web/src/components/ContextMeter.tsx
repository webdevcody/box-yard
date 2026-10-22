import { Loader2, Minimize2 } from "lucide-react"
import { Button, cx } from "./ui"

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}m`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
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
  const pct = tokens !== null && window ? Math.min(100, Math.round((tokens / window) * 100)) : null
  const bar = pct === null ? "bg-zinc-600" : pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-yard-500"
  const label =
    tokens === null
      ? "Context: not measured yet"
      : window
        ? `${formatTokens(tokens)} / ${formatTokens(window)} · ${pct}%`
        : `${formatTokens(tokens)} tokens`
  return (
    <div className={cx("flex items-center gap-2 text-xs text-zinc-400", className)} data-testid="context-meter">
      <div className="min-w-0">
        <div className="whitespace-nowrap tabular-nums" title="Tokens in the Claude session's context window">
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
