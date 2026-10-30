// The small "⏱ 8.4 s" chip under a Coordinator or Captain reply and on a task's "Turn N finished" line: the turn's
// total time. A click opens where it went (turn_timings, shared/turnTimings.ts): a stage bar, the stages, the model
// and tool calls, and the tokens. The timing is fetched when it's opened, never with the transcript.
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Timer } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"
import { Modal } from "./Modal"
import { trapKeys, useNarrow } from "./NewTask"
import { cx } from "./ui"
import { formatMs, TURN_STAGES, type TurnStageKey, type TurnTiming } from "../../../shared/turnTimings"

/** The turn_timings id and total a message's meta carries, or null when it has none. */
export function timingOf(meta: Record<string, unknown> | null | undefined): { id: string; ms: number | null } | null {
  const id = meta?.timingId
  if (typeof id !== "string" || !id) return null
  return { id, ms: typeof meta?.timingMs === "number" ? meta.timingMs : null }
}

export const TurnTimingChip = memo(function TurnTimingChip({ id, ms, className }: { id: string; ms: number | null; className?: string }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="turn-timing"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Where this turn's time went"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className={cx(
          "inline-flex shrink-0 items-center gap-1 rounded-sm text-[11px] text-zinc-500 tabular-nums hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none aria-expanded:text-zinc-300 [@media(pointer:coarse)]:min-h-8",
          className,
        )}
      >
        <Timer className="h-3 w-3 shrink-0" aria-hidden />
        {ms === null ? "timing" : formatMs(ms)}
      </button>
      {open && <TimingPopover id={id} trigger={trigger} onClose={() => setOpen(false)} />}
    </>
  )
})

const WIDTH = 368

/**
 * Fixed-position style that hangs the panel from the trigger's left edge, inside the window, below it or above it when
 * there's more room there. Placed again when `content` changes (the timing loads) and on scroll and resize.
 */
function usePlacement(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, on: boolean, content: unknown): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  useLayoutEffect(() => {
    if (!on) return
    const place = () => {
      const t = trigger.current?.getBoundingClientRect()
      const el = panel.current
      if (!t || !el) return
      const vw = document.documentElement.clientWidth || window.innerWidth
      const vh = window.innerHeight
      const width = Math.min(WIDTH, vw - 16)
      const left = Math.max(8, Math.min(t.left, vw - 8 - width))
      const below = vh - t.bottom - 14
      const above = t.top - 14
      setStyle(el.scrollHeight > below && above > below ? { left, width, bottom: vh - t.top + 6, maxHeight: above } : { left, width, top: t.bottom + 6, maxHeight: below })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [on, trigger, panel, content])
  return style
}

function TimingPopover({ id, trigger, onClose }: { id: string; trigger: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const narrow = useNarrow()
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const q = useQuery({ queryKey: ["turn-timing", id], queryFn: () => api<TurnTiming>(`/api/turn-timings/${encodeURIComponent(id)}`), staleTime: Infinity })
  const pos = usePlacement(trigger, panel, !narrow, q.data ?? q.isError)

  useEffect(() => {
    if (narrow) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current()
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [narrow, trigger])
  useEffect(() => panel.current?.focus({ preventScroll: true }), [])

  const body = q.data ? (
    <TimingDetail t={q.data} />
  ) : (
    <div className="py-2 text-xs text-zinc-500">{q.isError ? "Couldn't load this turn's timing (kept 30 days)." : "Loading…"}</div>
  )
  if (narrow)
    return (
      <Modal placement="sheet" title="Turn timing" onClose={() => onClose()} bodyClassName="px-4 pt-3 pb-4">
        {body}
      </Modal>
    )
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Turn timing"
      data-testid="turn-timing-popover"
      tabIndex={-1}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) =>
        trapKeys(e, panel.current, () => {
          onClose()
          trigger.current?.focus()
        })
      }
      className="scroll-thin fixed z-40 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs shadow-2xl shadow-black/50 focus:outline-none"
    >
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Turn timing</div>
      {body}
    </div>,
    document.body,
  )
}

/** The bar's segments, in the order they happen; the rest of the total (gaps between steps) is left unfilled. */
const BAR: { key: TurnStageKey; color: string }[] = [
  { key: "queueMs", color: "bg-zinc-500" },
  { key: "setupMs", color: "bg-violet-400" },
  { key: "startupMs", color: "bg-sky-400" },
  { key: "modelMs", color: "bg-yard-400" },
  { key: "toolMs", color: "bg-teal-400" },
  { key: "tailMs", color: "bg-pink-400" },
]
const COLOR = Object.fromEntries(BAR.map((b) => [b.key, b.color])) as Partial<Record<TurnStageKey, string>>
const HINT = Object.fromEntries(TURN_STAGES.map((s) => [s.key, s.hint])) as Record<TurnStageKey, string>
const LABEL = Object.fromEntries(TURN_STAGES.map((s) => [s.key, s.label])) as Record<TurnStageKey, string>

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function TimingDetail({ t }: { t: TurnTiming }) {
  const total = Math.max(1, t.totalMs)
  const tools = t.steps.filter((s) => s.k === "tool").sort((a, b) => b.ms - a.ms)
  const detail: Partial<Record<TurnStageKey, string>> = {
    startupMs: [t.processMs !== null && `process ${formatMs(t.processMs)}`, t.mcpMs !== null && `MCP ${formatMs(t.mcpMs)}`].filter(Boolean).join(" · "),
    modelMs: `${t.modelCalls} call${t.modelCalls === 1 ? "" : "s"}${t.apiMs ? ` · API ${formatMs(t.apiMs)}` : ""}`,
    // With more than one call, the Slowest tools list names them.
    toolMs: `${t.toolCalls} call${t.toolCalls === 1 ? "" : "s"}${tools.length === 1 ? ` · ${tools[0]!.name ?? "?"}` : ""}`,
  }
  const rows = (["queueMs", "setupMs", "startupMs", "firstTokenMs", "modelMs", "toolMs", "tailMs"] as const).filter((k) => t[k] !== null && !(k === "toolMs" && !t.toolCalls))
  const who = [t.role === "task" ? "Task turn" : t.role === "captain" ? "Captain turn" : "Coordinator turn", t.trigger && `from ${t.trigger}`, t.model, t.effort && `${t.effort} effort`, t.resumed && "resumed"].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-zinc-500">{who}</div>
      <div data-testid="timing-bar" className="flex h-2 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        {BAR.map(({ key, color }) => {
          const v = t[key]
          return typeof v === "number" && v > 0 ? <div key={key} className={color} style={{ width: `${(v / total) * 100}%` }} title={`${LABEL[key]} ${formatMs(v)}`} /> : null
        })}
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 gap-y-1">
        {rows.map((k) => (
          <div key={k} className="contents" title={HINT[k]}>
            <dt className="flex items-center gap-1.5 text-zinc-400">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", COLOR[k] ?? "bg-transparent")} />
              {LABEL[k]}
            </dt>
            <dd className="min-w-0 truncate text-zinc-500">{detail[k]}</dd>
            <dd className="text-right text-zinc-200 tabular-nums">{formatMs(t[k])}</dd>
          </div>
        ))}
        <div className="col-span-3 border-t border-zinc-800" />
        <div className="contents" title={HINT.totalMs}>
          <dt className="font-medium text-zinc-300">Total</dt>
          <dd className="min-w-0 truncate text-zinc-500">{t.ok ? "" : "didn't finish cleanly"}</dd>
          <dd className="text-right font-medium text-zinc-100 tabular-nums">{formatMs(t.totalMs)}</dd>
        </div>
      </dl>
      <div data-testid="timing-tokens" className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-500 tabular-nums">
        <span>in {tokens(t.inputTokens)}</span>
        <span>out {tokens(t.outputTokens)}</span>
        <span title="Prompt tokens read from the prompt cache">cache read {tokens(t.cacheReadTokens)}</span>
        <span title="Prompt tokens written to the prompt cache, and how many of them for 1 hour rather than 5 minutes">
          cache write {tokens(t.cacheWriteTokens)}
          {(t.cacheWrite1hTokens ?? 0) > 0 && ` (${t.cacheWrite1hTokens === t.cacheWriteTokens ? "" : `${tokens(t.cacheWrite1hTokens!)} `}1h)`}
        </span>
        {t.contextTokens !== null && <span>context {tokens(t.contextTokens)}</span>}
      </div>
      {tools.length > 1 && (
        <div className="text-zinc-500">
          <div className="mb-0.5 text-zinc-400">Slowest tools</div>
          {tools.slice(0, 4).map((s, i) => (
            <div key={i} className="flex justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[11px]">{s.name ?? "?"}</span>
              <span className="shrink-0 tabular-nums">{formatMs(s.ms)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
