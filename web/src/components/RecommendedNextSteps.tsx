import { Sparkles } from "lucide-react"
import { NEXT_STEPS_META_KEY } from "../../../shared/nextSteps"
import { cx } from "./ui"

export function nextStepsFromMeta(meta: Record<string, unknown> | null | undefined): string[] {
  const value = meta?.[NEXT_STEPS_META_KEY]
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4) : []
}

export function RecommendedNextSteps({
  steps,
  onPick,
  className,
}: {
  steps: string[]
  onPick: (step: string) => void
  className?: string
}) {
  if (!steps.length) return null
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
