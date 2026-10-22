import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Loader2 } from "lucide-react"
import type { TaskStatus } from "../../../shared/types"

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ")
}

export const STATUS: Record<TaskStatus, { label: string; dot: string; chip: string }> = {
  queued: { label: "Queued", dot: "bg-zinc-500", chip: "bg-zinc-800 text-zinc-300" },
  starting: { label: "Starting", dot: "bg-sky-400 animate-pulse", chip: "bg-sky-500/10 text-sky-300" },
  working: { label: "Working", dot: "bg-sky-400 animate-pulse", chip: "bg-sky-500/10 text-sky-300" },
  needs_input: { label: "Needs you", dot: "bg-amber-400", chip: "bg-amber-500/15 text-amber-300" },
  waiting: { label: "Waiting on agent", dot: "bg-violet-400", chip: "bg-violet-500/10 text-violet-300" },
  idle: { label: "Idle", dot: "bg-zinc-400", chip: "bg-zinc-800 text-zinc-300" },
  pr_ready: { label: "PR ready", dot: "bg-emerald-400", chip: "bg-emerald-500/10 text-emerald-300" },
  done: { label: "Done", dot: "bg-emerald-600", chip: "bg-emerald-500/10 text-emerald-400" },
  failed: { label: "Failed", dot: "bg-red-500", chip: "bg-red-500/10 text-red-300" },
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS[status]
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", s.chip)}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle"
  size?: "sm" | "md"
  loading?: boolean
}

export function Button({ variant = "subtle", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" && "bg-yard-500 text-zinc-950 hover:bg-yard-400",
        variant === "subtle" && "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        variant === "danger" && "bg-red-500/10 text-red-300 hover:bg-red-500/20",
        className,
      )}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  )
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function TimeAgo({ ts }: { ts: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  return <time title={new Date(ts).toLocaleString()}>{timeAgo(ts)}</time>
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 px-6 py-12 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <div className="font-medium text-zinc-300">{title}</div>
      {children && <div className="max-w-md text-sm text-zinc-500">{children}</div>}
    </div>
  )
}

export const inputClass =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-yard-500/60 focus:outline-none focus:ring-2 focus:ring-yard-500/20"

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

/** Parse KEY=value lines into an env map. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 1) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return env
}
