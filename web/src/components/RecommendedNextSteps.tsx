import { Sparkles } from "lucide-react"
import { NEXT_STEPS_META_KEY } from "../../../shared/nextSteps"
import { cx } from "./ui"

export function nextStepsFromMeta(meta: Record<string, unknown> | null | undefined): string[] {
  const value = meta?.[NEXT_STEPS_META_KEY]
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4) : []
}

/**
 * A reply's next steps. As chips after "✨ Next", or with `actions` (a reply in a card, components/CoordinatorCards.tsx)
 * as its answer buttons: the first a primary one, each the card's whole width when it's narrow (a container query on
 * the card), and 44px tall under a finger, so answering "Shall I restart?" is one thumb tap.
 */
export function RecommendedNextSteps({
  steps,
  onPick,
  className,
  actions = false,
}: {
  steps: string[]
  onPick: (step: string) => void
  className?: string
  actions?: boolean
}) {
  if (!steps.length) return null
  if (actions)
    return (
      <div role="group" aria-label="Next steps" data-testid="answer-buttons" className={cx("mt-2 flex flex-wrap gap-1.5", className)}>
        {steps.map((step, i) => (
          <button
            key={step}
            type="button"
            onClick={() => onPick(step)}
            data-primary={i === 0 || undefined}
            className={cx(
              "inline-flex min-h-9 grow basis-full items-center justify-center rounded-lg border px-3 py-1.5 text-center text-[13px] font-medium wrap-anywhere transition focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:min-h-11 @min-[30rem]:grow-0 @min-[30rem]:basis-auto",
              i === 0 ? "border-yard-400 bg-yard-400 text-zinc-950 hover:bg-yard-300" : "border-zinc-700 bg-zinc-900/70 text-zinc-200 hover:border-yard-500/50 hover:bg-yard-500/10 hover:text-yard-100",
            )}
          >
            {step}
          </button>
        ))}
      </div>
    )
  return (
    <div className={cx("mt-2 flex flex-wrap gap-1.5", className)} aria-label="Recommended next steps">
      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-medium text-zinc-500">
        <Sparkles className="h-3 w-3" /> Next
      </span>
      {steps.map((step) => (
        <button
          key={step}
          type="button"
          onClick={() => onPick(step)}
          className="max-w-full rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-left text-xs wrap-anywhere text-zinc-300 transition hover:border-yard-500/50 hover:bg-yard-500/10 hover:text-yard-100 focus:ring-2 focus:ring-yard-500 focus:outline-none"
        >
          {step}
        </button>
      ))}
    </div>
  )
}
