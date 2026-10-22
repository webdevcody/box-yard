import { RefreshCw } from "lucide-react"
import { pendingLabel } from "../lib/stableOrder"
import { cx } from "./ui"

/**
 * "↑ 2 new" / "3 updated · Re-sort" for a list held still by useStableOrder. It floats at the top of the list
 * (sticky, zero height) so showing or hiding it never pushes the cards. `className` sets the sticky offset.
 */
export function ResortPill({ newCount, changedCount, onResort, className = "top-3" }: { newCount: number; changedCount: number; onResort: () => void; className?: string }) {
  const label = pendingLabel(newCount, changedCount)
  return (
    <div aria-live="polite" className={cx("pointer-events-none sticky z-20 flex h-0 items-start justify-center", className)}>
      {label && (
        <button
          type="button"
          onClick={onResort}
          title="Re-sort the list (it holds still while you look at it)"
          className="pointer-events-auto inline-flex -translate-y-1/2 items-center gap-1.5 rounded-full border border-yard-400/40 bg-zinc-900/95 px-3 py-1 text-xs font-medium whitespace-nowrap text-yard-300 shadow-lg shadow-black/40 backdrop-blur transition hover:border-yard-400/70 hover:text-yard-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
        >
          {label}
          {changedCount > 0 && (
            <>
              <span className="text-zinc-600">·</span>
              <RefreshCw className="h-3 w-3" /> Re-sort
            </>
          )}
        </button>
      )}
    </div>
  )
}
