import type { MouseEvent } from "react"
import { navigate } from "wouter/use-browser-location"
import { Loader2, X } from "lucide-react"
import { dismiss, isCritical, pauseToasts, resumeToasts, useToasts, type Toast, type ToastTone } from "../lib/toast"
import { followAppLink } from "../lib/linkify"
import { StatusBadge, cx } from "./ui"

const TONE: Record<ToastTone, string> = {
  neutral: "border-l-zinc-500",
  red: "border-l-red-500",
  amber: "border-l-amber-400",
  green: "border-l-emerald-400",
}

/**
 * The one toast stack, bottom right of the main pane. Only this component subscribes to the toast store,
 * so a toast coming or going re-renders nothing else. Hovering the stack holds every toast.
 * `quiet` (Zen mode) shows only critical toasts, top right below the chat header, clear of the composer.
 */
export function Toasts({ className, quiet = false }: { className?: string; quiet?: boolean }) {
  const all = useToasts()
  const toasts = quiet ? all.filter(isCritical) : all
  if (!toasts.length) return null
  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={pauseToasts}
      onMouseLeave={resumeToasts}
      data-quiet={quiet || undefined}
      className={cx(
        "pointer-events-none z-50 flex w-[22rem] max-w-[calc(100%-2rem)] flex-col items-end gap-2",
        quiet ? "fixed top-[calc(env(safe-area-inset-top)+4.5rem)] right-[max(1rem,env(safe-area-inset-right))]" : "absolute right-4 bottom-4",
        className,
      )}
    >
      {toasts.map((t) => (t.kind === "task" ? <TaskToast key={t.id} t={t} /> : <PlainToast key={t.id} t={t} />))}
    </div>
  )
}

function TaskToast({ t }: { t: Toast }) {
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // Plain click: navigate in place. Cmd/Ctrl/middle click: the browser opens a new tab.
    followAppLink(e, t.href!, navigate)
    t.onOpen?.()
    dismiss(t.id)
  }
  return (
    <div
      data-toast="task"
      className={cx(
        "pointer-events-auto relative w-full overflow-hidden rounded-lg border border-l-4 border-zinc-800 bg-zinc-900 text-sm text-zinc-100 shadow-xl transition hover:bg-zinc-800/80",
        TONE[t.tone ?? "neutral"],
      )}
    >
      <a href={t.href} onClick={open} onAuxClick={(e) => e.button === 1 && open(e)} className="block py-2.5 pr-8 pl-3 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none">
        <div className="truncate font-medium">{t.title}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-400">
          {t.status && <StatusBadge status={t.status} />}
          {t.context && <span className="truncate">{t.context}</span>}
        </div>
        {t.body && <div className="mt-1 truncate text-xs text-zinc-400">{t.body}</div>}
      </a>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(t.id)}
        className="absolute top-2 right-2 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function PlainToast({ t }: { t: Toast }) {
  return (
    <div
      onClick={() => dismiss(t.id)}
      className={cx(
        "pointer-events-auto max-w-md cursor-pointer rounded-lg border px-4 py-2.5 text-sm shadow-xl",
        t.kind === "error" ? "border-red-900 bg-red-950 text-red-100" : "border-zinc-800 bg-zinc-900 text-zinc-100",
      )}
    >
      <div className="flex items-center gap-3">
        {t.progress && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-300" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t.title}</div>
          {t.body && <div className="mt-0.5 truncate text-xs opacity-80">{t.body}</div>}
        </div>
        {t.action && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              t.action!.onClick()
              dismiss(t.id)
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-yard-400 hover:bg-zinc-800 hover:text-yard-300 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
          >
            {t.action.label}
          </button>
        )}
      </div>
    </div>
  )
}
