import { memo, useSyncExternalStore, type ButtonHTMLAttributes, type ComponentProps, type MouseEvent, type ReactNode } from "react"
import renderMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, type LucideIcon } from "lucide-react"
import { hintForHref, useEntityIndex } from "../lib/entities"
import { followAppLink, linkTarget, remarkEntityLinks, type EntityIndex } from "../lib/linkify"
import { FileLink, PREVIEW_GROUP } from "./FileLink"
import { prLabel, prStateOf, prTooltip, type BadgeStatus, type PrTask } from "../lib/prState"
import type { PrState, TaskStatus } from "../../../shared/types"

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

/** The pill for a task that is done because its PR merged (see badgeStatus in lib/prState). */
export const MERGED_BADGE = { label: "Merged", dot: "bg-merged", chip: "bg-merged/15 text-merged-fg" }

/** Pass `badgeStatus(task)` to show a purple Merged pill instead of Done when the task's PR merged. */
export function StatusBadge({ status }: { status: BadgeStatus }) {
  const s = status === "merged" ? MERGED_BADGE : STATUS[status]
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", s.chip)}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}

/** Marks a quiet schedule run (the agent found nothing to do; shared/quiet.ts). */
export function QuietPill({ className }: { className?: string }) {
  return (
    <span
      title="Quiet run: the agent found nothing to do and changed nothing, so it's hidden from Recent and notifications."
      className={cx("inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400", className)}
    >
      Quiet
    </span>
  )
}

/** GitHub's PR colors and icons: open green, draft gray, merged purple, closed red. */
export const PR_STYLE: Record<PrState, { icon: LucideIcon; chip: string; link: string }> = {
  open: { icon: GitPullRequest, chip: "border-emerald-900/60 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20", link: "text-emerald-400" },
  draft: { icon: GitPullRequestDraft, chip: "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800", link: "text-zinc-400" },
  merged: { icon: GitMerge, chip: "border-merged/50 bg-merged/15 text-merged-fg hover:bg-merged/25", link: "text-merged-fg" },
  closed: { icon: GitPullRequestClosed, chip: "border-red-900/60 bg-red-500/10 text-red-300/80 hover:bg-red-500/15", link: "text-red-400/80" },
}

/**
 * A task's pull request: "PR #23", "Draft #23", "Merged #23" or "Closed #23" in GitHub's colors. `chip` is the
 * bordered pill (task header), `link` the plain inline link (card footers). Renders nothing without a PR.
 */
export function PrChip({ task, variant = "chip", className }: { task: PrTask; variant?: "chip" | "link"; className?: string }) {
  const state = prStateOf(task)
  if (!state || !task.prUrl) return null
  const s = PR_STYLE[state]
  const Icon = s.icon
  return (
    <a
      href={task.prUrl}
      target="_blank"
      rel="noreferrer"
      title={prTooltip(task) ?? undefined}
      data-pr-state={state}
      // Cards are links themselves: open the PR, not the task.
      onClick={(e) => e.stopPropagation()}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        variant === "chip" ? cx("rounded-md border px-1.5 py-0.5 font-medium transition", s.chip) : cx("hover:underline", s.link),
        className,
      )}
    >
      <Icon className={variant === "chip" ? "h-3 w-3" : "h-3.5 w-3.5"} /> {prLabel(task)}
    </a>
  )
}

type ButtonProps = ComponentProps<"button"> & {
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
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:min-w-0",
        size === "sm" ? "px-3 py-2 text-xs sm:px-2.5 sm:py-1" : "px-3.5 py-2 text-sm",
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

// Parsed markdown by source text. Long threads re-mount messages (switching tasks, loading earlier ones),
// and parsing + GFM + entity links is the most expensive part of rendering a message. Linked output
// depends on the entity index, which only changes when an entity is added, removed or renamed, so
// there's one cache per index (plus one for markdown without entity links).
type Parser = { plugins: Options["remarkPlugins"]; cache: Map<string, ReactNode> }
const MARKDOWN_CACHE_MAX = 3000
const plainParser: Parser = { plugins: [remarkGfm], cache: new Map() }
let linkedParser: Parser & { index: EntityIndex | null } = { index: null, plugins: [], cache: new Map() }

function parserFor(index: EntityIndex | null): Parser {
  if (!index) return plainParser
  if (linkedParser.index !== index) linkedParser = { index, plugins: [remarkGfm, [remarkEntityLinks, index]], cache: new Map() }
  return linkedParser
}

function parsedMarkdown(text: string, index: EntityIndex | null): ReactNode {
  const { plugins, cache } = parserFor(index)
  let out = cache.get(text)
  if (out !== undefined) {
    // Refresh its spot so the cache drops the least recently used entry first.
    cache.delete(text)
  } else {
    out = renderMarkdown({ children: text, remarkPlugins: plugins, components: MARKDOWN_COMPONENTS })
    if (cache.size >= MARKDOWN_CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  cache.set(text, out)
  return out
}

// Texts waiting to be parsed in idle time, and the index to link them with.
const warmQueue = new Set<string>()
let warmIndex: EntityIndex | null = null
let warming = false
const idle: (cb: (deadline?: { timeRemaining(): number }) => void) => void =
  typeof requestIdleCallback === "function" ? (cb) => requestIdleCallback(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 50)

/**
 * Parse markdown that isn't on screen yet (older messages) while the browser is idle,
 * so scrolling up into them only costs building the DOM.
 */
export function warmMarkdown(texts: string[], index: EntityIndex) {
  if (warmIndex !== index) warmQueue.clear()
  warmIndex = index
  const { cache } = parserFor(index)
  // Newest first: those are the next ones scrolled into.
  for (let i = texts.length - 1; i >= 0; i--) if (!cache.has(texts[i]!)) warmQueue.add(texts[i]!)
  if (warming || !warmQueue.size) return
  warming = true
  const step = (deadline?: { timeRemaining(): number }) => {
    const until = performance.now() + (deadline ? Math.min(deadline.timeRemaining(), 12) : 8)
    const { cache } = parserFor(warmIndex)
    for (const text of warmQueue) {
      if (performance.now() >= until) break
      warmQueue.delete(text)
      if (!cache.has(text) && cache.size < MARKDOWN_CACHE_MAX - 100) parsedMarkdown(text, warmIndex)
    }
    if (warmQueue.size) idle(step)
    else warming = false
  }
  idle(step)
}

/**
 * Rendered markdown, with Box Yard entity mentions linked unless `linkify` is off. Memoized on the
 * text, and the parsed output is cached across mounts. `live` text (a reply still streaming in)
 * changes on every chunk, so it skips the cache.
 */
export const Markdown = memo(function Markdown({ children, linkify = true, live }: { children: string; linkify?: boolean; live?: boolean }) {
  const index = useEntityIndex()
  const parser = linkify ? index : null
  return (
    <div className="prose-chat break-words" {...PREVIEW_GROUP}>
      {live ? renderMarkdown({ children, remarkPlugins: parserFor(parser).plugins, components: MARKDOWN_COMPONENTS }) : parsedMarkdown(children, parser)}
    </div>
  )
})

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href = "", title, children }) => (
    <AppLink href={href} title={title}>
      {children}
    </AppLink>
  ),
}

/**
 * A link that knows the app: in-app paths navigate through the router (Cmd/Ctrl/middle-click still open a tab),
 * previewable files open in the preview modal, other files and sites in a new tab. Hovering an entity link shows its title and current status.
 */
export function AppLink({ href, title, className, children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const target = linkTarget(href, window.location.origin)
  const onMouseEnter = (e: MouseEvent<HTMLAnchorElement>) => {
    if (title || target.kind === "external") return
    const hint = hintForHref(qc, target.href, (s) => STATUS[s].label)
    if (hint) e.currentTarget.title = hint
  }
  if (target.kind === "file")
    return (
      <FileLink href={target.href} title={title} className={className} onMouseEnter={onMouseEnter}>
        {children}
      </FileLink>
    )
  if (target.kind !== "app")
    return (
      <a href={target.href} title={title} className={className} target="_blank" rel="noopener noreferrer" onMouseEnter={onMouseEnter}>
        {children}
      </a>
    )
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!followAppLink(e, target.href, navigate)) return
    // pushState doesn't fire hashchange; pages that scroll to #id listen for it.
    if (target.href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"))
  }
  return (
    <a href={target.href} title={title} className={className} onClick={onClick} onMouseEnter={onMouseEnter}>
      {children}
    </a>
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

// One shared clock for every <TimeAgo>, instead of a timer per instance (a long thread has hundreds).
let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

/** The shared clock's time; fresh when nothing is ticking yet (the first mount). */
function clockTime() {
  if (!clockTimer) clockNow = Date.now()
  return clockNow
}

function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      clockListeners.forEach((l) => l())
    }, 30_000)
  }
  return () => {
    clockListeners.delete(listener)
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/** "4m ago" that updates itself. Re-renders only when its label changes. */
export const TimeAgo = memo(function TimeAgo({ ts }: { ts: number }) {
  const label = useSyncExternalStore(subscribeClock, () => timeAgo(ts, clockTime()))
  return <time title={new Date(ts).toLocaleString()}>{label}</time>
})

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
  "w-full min-h-11 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-yard-500/60 focus:outline-none focus:ring-2 focus:ring-yard-500/20 sm:min-h-0 sm:text-sm"

const SELECT_SIZE = {
  md: "min-h-11 rounded-lg py-2 pr-9 pl-3 text-base sm:min-h-0 sm:text-sm",
  sm: "select-sm min-h-11 rounded-md py-2 pr-8 pl-3 text-sm sm:min-h-0 sm:py-1 sm:pr-7 sm:pl-2 sm:text-xs",
}

/** Native <select> with our own chevron, inset from the right edge, and room so long options never run under it. Pass width via className. */
export function Select({ size = "md", className, ...props }: Omit<ComponentProps<"select">, "size"> & { size?: keyof typeof SELECT_SIZE }) {
  return (
    <select
      {...props}
      className={cx(
        "select-chevron cursor-pointer border border-zinc-800 bg-zinc-900 text-zinc-100 hover:border-zinc-700 focus:border-yard-500/60 focus:ring-2 focus:ring-yard-500/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        SELECT_SIZE[size],
        className,
      )}
    />
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">{label}</span>
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
