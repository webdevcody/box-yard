import { Children, memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ComponentProps, type MouseEvent, type ReactNode } from "react"
import renderMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useLocation } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Bot, Box, Check, ChevronsUp, Copy, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, HardDrive, Loader2, type LucideIcon } from "lucide-react"
import { hintForHref, useEntityIndex } from "../lib/entities"
import { followAppLink, githubRef, linkTarget, mayHaveGithubRef, MENTIONS, remarkEntityLinks, shortGithubLabel, shortSha, splitGithubRefs, type EntityIndex, type RepoScope } from "../lib/linkify"
import { RepoContext, repoScopeKey, resolveRepoScope, useRepoScopeKey } from "../lib/repoScope"
import { FileLink, PREVIEW_GROUP } from "./FileLink"
import { TaskTile } from "./TaskIcon"
import { clickImage, imageTarget, openLightbox } from "../lib/lightbox"
import { openPreview } from "../lib/preview"
import { fetchTasks, keys } from "../lib/queries"
import { copyText } from "../lib/clipboard"
import { toast } from "../lib/toast"
import { prLabel, prStateOf, prTooltip, type BadgeStatus, type PrTask } from "../lib/prState"
import { elapsedLabel } from "../lib/runningTasks"
import type { BoxSize, PrState, Task, TaskStatus } from "../../../shared/types"
import { AGENT_CLI_LABEL, AGENT_CLI_SHORT, type AgentCli } from "../../../shared/agentCli"

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
/**
 * A row's leading icon, centred on the first line of the text beside it however the text wraps. The box is one
 * line tall (`h-lh`: the line-height it inherits), so use it in an `items-start` row that sets the text's font size
 * and leading, and keep that leading on the text's first line.
 */
export function LineIcon({ icon: Icon, className, box, label }: { icon: LucideIcon; className?: string; box?: string; label?: string }) {
  return (
    <span className={cx("flex h-lh shrink-0 items-center", box)}>
      <Icon className={className} aria-label={label} aria-hidden={label ? undefined : true} />
    </span>
  )
}

/**
 * The robot at the top left of the Coordinator and Captain chats. While the agent works it breathes (`.agent-working`
 * in styles.css, a soft fade under prefers-reduced-motion) instead of showing a "thinking…" label; screen readers get
 * "Working…" through the live region.
 */
export function AgentIcon({ busy }: { busy: boolean }) {
  return (
    <span className="flex shrink-0" title={busy ? "Working…" : undefined}>
      <Bot data-testid="agent-icon" data-busy={busy || undefined} className={cx("h-4 w-4 text-yard-400", busy && "agent-working")} aria-hidden />
      <span className="sr-only" aria-live="polite">
        {busy ? "Working…" : ""}
      </span>
    </span>
  )
}

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const s = status === "merged" ? MERGED_BADGE : STATUS[status]
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", s.chip)}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}

/** The shape every chip in the task header's meta row shares, so they line up: 44px tall on phones, 24px from sm. */
export const META_CHIP =
  "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition sm:h-6 sm:min-h-0 sm:px-1.5"

/** "Codex" on a task whose agent runs on Codex. Claude Code is the default, so it gets no chip. */
export function AgentCliChip({ cli, className }: { cli: AgentCli | undefined; className?: string }) {
  if (cli !== "codex") return null
  return (
    <span data-testid="agent-cli-chip" title={`Runs on ${AGENT_CLI_LABEL[cli]}, fixed when the task started`} className={className}>
      {AGENT_CLI_SHORT[cli]}
    </span>
  )
}

/** The quiet form of StatusBadge for header meta rows: a colored dot and the label, no pill. */
export function StatusDot({ status, title, children, className }: { status: BadgeStatus; title?: string; children?: ReactNode; className?: string }) {
  const s = status === "merged" ? MERGED_BADGE : STATUS[status]
  return (
    <span title={title} data-status={status} className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-zinc-200", className)}>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", s.dot)} aria-hidden />
      {s.label}
      {children}
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

/** A queued task that jumps the queue (shared/priority.ts): it goes before every normal task waiting for a slot. */
export const waitsHighPriority = (task: Pick<Task, "priority" | "status">) => task.priority === "high" && task.status === "queued"

const PRIORITY_TITLE = "High priority: it goes before every normal task waiting for a slot. Running tasks are never stopped for it."

/**
 * The "High priority" pill on a queued task (nothing otherwise). `compact`: the icon alone, for tight rows; the title
 * and label still say it.
 */
export function PriorityPill({ task, compact, className }: { task: Pick<Task, "priority" | "status">; compact?: boolean; className?: string }) {
  if (!waitsHighPriority(task)) return null
  return (
    <span
      data-testid="priority-pill"
      title={PRIORITY_TITLE}
      aria-label={compact ? "High priority" : undefined}
      className={cx("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-orange-500/15 text-xs font-medium text-orange-300", compact ? "p-0.5" : "py-0.5 pr-2 pl-1.5", className)}
    >
      <ChevronsUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {!compact && "High priority"}
    </span>
  )
}

/** The icon for why a queued task waits: a box when it waits for a box of its project's size, else a disk. */
export const waitIconOf = (task: { waitBoxSize?: BoxSize | null }): LucideIcon => (task.waitBoxSize ? Box : HardDrive)

export function WaitIcon({ task, className }: { task: { waitBoxSize?: BoxSize | null }; className?: string }) {
  const Icon = waitIconOf(task)
  return <Icon className={className} aria-hidden />
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
 * `activity` folds a running action into the chip ("PR #23 · merging…" with a spinner) instead of a second pill.
 */
export function PrChip({
  task,
  variant = "chip",
  className,
  activity,
}: {
  task: PrTask
  variant?: "chip" | "link"
  className?: string
  activity?: { icon: ReactNode; label: string; title: string } | null
}) {
  const state = prStateOf(task)
  if (!state || !task.prUrl) return null
  const s = PR_STYLE[state]
  const Icon = s.icon
  const tooltip = prTooltip(task)
  return (
    <NewTabLink
      href={task.prUrl}
      mark="end"
      title={(activity ? `${activity.title}\n${tooltip}` : tooltip) ?? undefined}
      data-pr-state={state}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        variant === "chip" ? cx("rounded-md border px-1.5 py-0.5 font-medium transition", s.chip) : cx("hover:underline", s.link),
        className,
      )}
    >
      {activity ? activity.icon : <Icon className={variant === "chip" ? "h-3 w-3" : "h-3.5 w-3.5"} />} {prLabel(task)}
      {activity && <span className="font-normal opacity-80">· {activity.label}</span>}
    </NewTabLink>
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
// there's one cache per index (plus one for markdown without entity links), keyed by the repo GitHub
// references link to (InRepo) and the text.
type Parser = { plugins: Options["remarkPlugins"]; cache: Map<string, ReactNode>; prefix: string }
const MARKDOWN_CACHE_MAX = 3000
const plainParser: Parser = { plugins: [remarkGfm], cache: new Map(), prefix: "" }
let linked: { index: EntityIndex | null; cache: Map<string, ReactNode>; parsers: Map<string, Parser> } = { index: null, cache: new Map(), parsers: new Map() }

function parserFor(index: EntityIndex | null, repo: RepoScope = null): Parser {
  if (!index) return plainParser
  if (linked.index !== index) linked = { index, cache: new Map(), parsers: new Map() }
  const prefix = repo ? `${repo}\u0000` : ""
  let parser = linked.parsers.get(prefix)
  if (!parser) linked.parsers.set(prefix, (parser = { plugins: [remarkGfm, [remarkEntityLinks, index, repo]], cache: linked.cache, prefix }))
  return parser
}

function parsedMarkdown(text: string, index: EntityIndex | null, repo: RepoScope = null): ReactNode {
  const { plugins, cache, prefix } = parserFor(index, repo)
  const key = prefix + text
  let out = cache.get(key)
  if (out !== undefined) {
    // Refresh its spot so the cache drops the least recently used entry first.
    cache.delete(key)
  } else {
    out = renderMarkdown({ children: text, remarkPlugins: plugins, components: MARKDOWN_COMPONENTS })
    if (cache.size >= MARKDOWN_CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  cache.set(key, out)
  return out
}

// Texts waiting to be parsed in idle time, and the index and repo to link them with.
const warmQueue = new Set<string>()
let warmIndex: EntityIndex | null = null
let warmRepo: RepoScope = null
let warming = false
const idle: (cb: (deadline?: { timeRemaining(): number }) => void) => void =
  typeof requestIdleCallback === "function" ? (cb) => requestIdleCallback(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 50)

/**
 * Parse markdown that isn't on screen yet (older messages) while the browser is idle,
 * so scrolling up into them only costs building the DOM. `repo` is the thread's useRepoScope(), as <Markdown> sees it.
 */
export function warmMarkdown(texts: string[], index: EntityIndex, repo: RepoScope = null) {
  if (warmIndex !== index || warmRepo !== repo) warmQueue.clear()
  warmIndex = index
  warmRepo = repo
  const { cache, prefix } = parserFor(index, repo)
  // Newest first: those are the next ones scrolled into.
  for (let i = texts.length - 1; i >= 0; i--) if (!cache.has(prefix + texts[i]!)) warmQueue.add(texts[i]!)
  if (warming || !warmQueue.size) return
  warming = true
  const step = (deadline?: { timeRemaining(): number }) => {
    const until = performance.now() + (deadline ? Math.min(deadline.timeRemaining(), 12) : 8)
    const { cache, prefix } = parserFor(warmIndex, warmRepo)
    for (const text of warmQueue) {
      if (performance.now() >= until) break
      warmQueue.delete(text)
      if (!cache.has(prefix + text) && cache.size < MARKDOWN_CACHE_MAX - 100) parsedMarkdown(text, warmIndex, warmRepo)
    }
    if (warmQueue.size) idle(step)
    else warming = false
  }
  idle(step)
}

/** The repo <Markdown> under this component links GitHub references to (see InRepo). */
export function useRepoScope(): RepoScope {
  const index = useEntityIndex()
  return resolveRepoScope(useRepoScopeKey(), index)
}

/**
 * Says which repo the text under it is about, so "PR #406", "#12" and "head 8269e827" in its <Markdown> and
 * <LinkedText> link there: a task's (its project's repo), a project's, or `mentions` for text that spans projects
 * (the Coordinator's replies), where each paragraph links only when the entities it mentions share one repo.
 */
export function InRepo({ taskId, projectId, mentions, children }: { taskId?: string | null; projectId?: string | null; mentions?: boolean; children: ReactNode }) {
  return <RepoContext.Provider value={repoScopeKey({ taskId, projectId, mentions })}>{children}</RepoContext.Provider>
}

/**
 * Rendered markdown, with Box Yard entity mentions and GitHub references (to the InRepo's repo) linked unless
 * `linkify` is off. Memoized on the text, and the parsed output is cached across mounts. `live` text (a reply still
 * streaming in) changes on every chunk, so it skips the cache.
 */
export const Markdown = memo(function Markdown({ children, linkify = true, live }: { children: string; linkify?: boolean; live?: boolean }) {
  const index = useEntityIndex()
  const scope = useRepoScopeKey()
  const parser = linkify ? index : null
  const repo = linkify ? resolveRepoScope(scope, index) : null
  return (
    <div className="prose-chat wrap-anywhere" {...PREVIEW_GROUP}>
      {live ? renderMarkdown({ children, remarkPlugins: parserFor(parser, repo).plugins, components: MARKDOWN_COMPONENTS }) : parsedMarkdown(children, parser, repo)}
    </div>
  )
})

/** How a link to another site looks outside `.prose-chat` (styles.css): sky and underlined. */
const EXTERNAL_TEXT_LINK = "text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-400"

/**
 * Plain text (a card's summary, a question, a chip's preview) with its GitHub references linked to the InRepo's
 * repo, for places that don't render markdown. `inLink`: it sits inside a card that is a link itself (TaskCard), so
 * each reference is a button that opens GitHub in a new tab (no nested anchors), like WaitReason's.
 */
export const LinkedText = memo(function LinkedText({ text, inLink }: { text: string; inLink?: boolean }) {
  // Most text has no reference: skip the entity index (a card grid has hundreds of these).
  return mayHaveGithubRef(text) ? <GithubRefText text={text} inLink={inLink} /> : text
})

function GithubRefText({ text, inLink }: { text: string; inLink?: boolean }) {
  const repo = useRepoScope()
  const parts = splitGithubRefs(text, repo === MENTIONS ? null : repo)
  if (parts.length === 1 && !parts[0]!.url) return text
  return parts.map((p, i) =>
    p.url ? (
      <GithubTextLink key={i} href={p.url} inLink={inLink} title={p.label ? p.text : undefined} className={EXTERNAL_TEXT_LINK}>
        {p.label ?? p.text}
      </GithubTextLink>
    ) : (
      p.text
    ),
  )
}

/** A link to a task page (`/tasks/task_…`, maybe with the origin): the task's id. */
const TASK_HREF = /^(?:https?:\/\/[^/]+)?\/tasks\/(task_[A-Za-z0-9-]{6,40})\/?$/

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href = "", title, children }) => {
    const taskId = TASK_HREF.exec(href)?.[1]
    // A whole commit SHA as the link's text reads as its short form, the whole one in its tooltip.
    const sha = typeof children === "string" && isLongSha(children) ? children : null
    return (
      <AppLink href={href} title={title ?? sha ?? undefined}>
        {/* A task link leads with the task's tile, in its project's colour. */}
        {taskId && <TaskTile id={taskId} bare className="mr-0.5 align-[-1px]" />}
        {/* A bare URL the model pasted (GFM autolinks it, text = href): "PR #154" reads better than the whole URL. */}
        {(sha && shortSha(sha)) || (typeof children === "string" && isRawUrl(children, href) && shortGithubLabel(href)) || children}
      </AppLink>
    )
  },
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  img: ({ src, alt, title }) => <ChatImage src={typeof src === "string" ? src : ""} alt={alt} title={title} />,
}

const OPEN_IMAGE = { preview: (src: string) => openPreview({ url: src }), lightbox: openLightbox }

/**
 * An image in a chat or a transcript: a click opens it in the lightbox, or in the file preview when Box Yard
 * hosts it (lib/lightbox.ts). An image inside a link stays the link's.
 */
function ChatImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const opens = imageTarget(src) !== null
  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      decoding="async"
      data-lightbox={opens || undefined}
      className={opens ? "cursor-zoom-in" : undefined}
      onClick={(e) => {
        if (!clickImage(e.nativeEvent, { src, alt }, OPEN_IMAGE)) return
        // Inside a clickable card (a notice), open the image and not the card.
        e.stopPropagation()
      }}
    />
  )
}

const isLongSha = (text: string) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(text)

const isRawUrl = (text: string, href: string) => text === href || text.replace(/\/$/, "") === href.replace(/\/$/, "")

/** A code block's text as written: markdown adds one newline after a fenced block's last line, which isn't the code's. */
export const codeBlockText = (pre: HTMLElement) => (pre.textContent ?? "").replace(/\n$/, "")

/**
 * A fenced code block with a copy button in a gutter of its own at the top right, so the button never covers the code,
 * however narrow the panel or far the block is scrolled sideways. The button shows on hover and focus, always on touch.
 */
function CodeBlock(props: ComponentProps<"pre">) {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className="code-block group/code">
      <pre ref={pre} {...props} />
      <CopyButton label="Copy code" text={() => (pre.current ? codeBlockText(pre.current) : "")} className="mt-2 mr-1.5 ml-0.5" />
    </div>
  )
}

/**
 * A small copy icon that flashes "Copied". Its icon box is one 16px line tall (`leading-4`) with 4px above, so with
 * `mt-2` it sits on the first line of a `p-3` code block. Hidden until its `group/code` is hovered, unless focused,
 * just used, or on a touch screen. `text` is read on click, so the copied text is what's on screen then.
 */
export function CopyButton({ text, label, className }: { text: string | (() => string); label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? "Copied" : label}
      data-copied={copied || undefined}
      onClick={async () => {
        if (!(await copyText(typeof text === "function" ? text() : text))) {
          toast.error("Couldn't copy", "The browser blocked clipboard access.")
          return
        }
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      }}
      className={cx(
        "relative flex shrink-0 self-start rounded-md px-1.5 py-1 text-xs leading-4 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none pointer-coarse:opacity-100",
        copied ? "opacity-100" : "opacity-0 group-hover/code:opacity-100",
        className,
      )}
    >
      <LineIcon icon={copied ? Check : Copy} className={cx("h-3.5 w-3.5", copied && "text-emerald-400")} />
      {/* Announced, and shown beside the icon while the user's eyes are on it. */}
      <span
        role="status"
        className={
          copied
            ? "pointer-events-none absolute top-1/2 right-full mr-1 -translate-y-1/2 rounded-md bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] font-medium whitespace-nowrap text-zinc-100 shadow"
            : "sr-only"
        }
      >
        {copied ? "Copied" : ""}
      </span>
    </button>
  )
}

/** How long a copy button says "Copied". */
export const COPIED_MS = 1500

/**
 * The ↗ after every link that leaves Box Yard (NewTabLink), so a link that opens another site in a new tab never
 * looks like one that stays in the app. Screen readers hear "opens in a new tab".
 */
export function ExternalMark({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      data-external-mark=""
      role="img"
      aria-label="(opens in a new tab)"
      aria-hidden={false}
      className={cx("ml-px inline-block h-[0.95em] w-[0.95em] shrink-0 align-[-0.125em] opacity-70", className)}
    />
  )
}

/** How many trailing characters of a long last word stay glued to the ↗ (a whole long URL can't stay on one line). */
const GLUE_MAX = 12

/**
 * `children` with `mark` glued to the end of the last word, in one nowrap span, so the ↗ never wraps onto a line by
 * itself. A long unbroken word (a URL) keeps only its last few characters with the mark, so it still wraps.
 */
export function glueMark(children: ReactNode, mark: ReactNode): ReactNode {
  const parts = Children.toArray(children)
  const last = parts.pop()
  if (typeof last === "string" || typeof last === "number") {
    const text = String(last)
    const space = text.search(/\s\S*$/) + 1
    let cut = Math.max(space, text.length - GLUE_MAX)
    // Never split a surrogate pair (an emoji).
    if (cut > 0 && cut < text.length && /[\uDC00-\uDFFF]/.test(text[cut]!)) cut--
    return (
      <>
        {parts}
        {text.slice(0, cut)}
        <span className="whitespace-nowrap">
          {text.slice(cut)}
          {mark}
        </span>
      </>
    )
  }
  return (
    <>
      {parts}
      <span className="whitespace-nowrap">
        {last}
        {mark}
      </span>
    </>
  )
}

/**
 * A link to another site (a GitHub PR, a preview, docs): always opens in a new tab without access to this one, ends
 * in the ↗ mark and shows its full URL on hover. `mark`: "glued" (default) for links in running text, "end" for a
 * flex chip or row (the mark is its last item), false for an icon-only button that already says where it goes.
 * Cards are often clickable themselves, so the click stops here and opens the link, not the card.
 */
export function NewTabLink({ onClick, mark = "glued", title, href, children, ...rest }: ComponentProps<"a"> & { mark?: "glued" | "end" | false }) {
  const tip = !href || (title && title.includes(href)) ? title : title ? `${title}\n${href}` : href
  return (
    <a
      {...rest}
      href={href}
      title={tip}
      target="_blank"
      rel="noopener noreferrer"
      data-external=""
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(e)
      }}
    >
      {mark === "glued" ? (
        glueMark(children, <ExternalMark />)
      ) : mark === "end" ? (
        <>
          {children}
          <ExternalMark className="h-3 w-3" />
        </>
      ) : (
        children
      )}
    </a>
  )
}

/** The task whose PR this is, as a PrState ("" when no task has it), so a PR link in text can wear its state's colors. */
function usePrStateFor(url: string): PrState | "" {
  // A string, so the link re-renders only when that PR's state changes, not on every task update.
  const select = useCallback((tasks: Task[]) => prStateOfUrl(tasks, url) ?? "", [url])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? ""
}

/** PR_STYLE's link colors, `!` so they beat `.prose-chat a` (unlayered) and a caller's own color. */
const PR_TEXT: Record<PrState, string> = {
  open: "text-emerald-400!",
  draft: "text-zinc-400!",
  merged: "text-merged-fg!",
  closed: "text-red-400/80!",
}

/** "owner/repo#12" for a GitHub PR or issue URL, lower case: "/issues/12" is the same number as "/pull/12". */
const prKey = (url: string) => {
  const ref = githubRef(url)
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : null
}
const taskWithPr = (tasks: Task[] | undefined, url: string) => {
  const key = prKey(url)
  return key ? tasks?.find((t) => t.prUrl && prKey(t.prUrl) === key) : undefined
}
function prStateOfUrl(tasks: Task[], url: string): PrState | null {
  const t = taskWithPr(tasks, url)
  return t ? prStateOf(t) : null
}

/**
 * A GitHub pull request or issue mentioned in text. A PR (or an "#12" that a task's PR has) gets the PR glyph and,
 * when a task has it, GitHub's state colors (merged is purple) like PrChip, then the ↗; hovering shows the state and
 * the URL. Any other issue is a plain NewTabLink.
 */
function GithubTextLink({
  href,
  title,
  className,
  inLink,
  children,
}: {
  href: string
  title?: string
  className?: string
  /** Inside a card that is a link: a button (NewTabButton), not a nested anchor. */
  inLink?: boolean
  children: ReactNode
}) {
  const qc = useQueryClient()
  const state = usePrStateFor(href)
  const Link = inLink ? NewTabButton : NewTabLink
  if (githubRef(href)?.kind !== "pull" && !state)
    return (
      <Link href={href} title={title} className={className}>
        {children}
      </Link>
    )
  const Icon = state ? PR_STYLE[state].icon : GitPullRequest
  const onMouseEnter = (e: MouseEvent<HTMLElement>) => {
    if (title) return
    const task = taskWithPr(qc.getQueryData<Task[]>(keys.tasks), href)
    const tip = task ? prTooltip(task) : null
    if (tip) e.currentTarget.title = tip
  }
  return (
    <Link
      href={href}
      title={title}
      data-pr-link={state || "unknown"}
      onMouseEnter={onMouseEnter}
      className={cx(
        className,
        // "⎇ PR #154 ↗" stays on one line; longer link text wraps and keeps only its last word with the ↗.
        typeof children === "string" && children.length <= 24 && "whitespace-nowrap",
        state && cx(PR_TEXT[state], "decoration-current/40! hover:decoration-current!"),
      )}
    >
      <Icon aria-hidden className="mr-0.5 inline-block h-[0.95em] w-[0.95em] align-[-0.125em]" />
      {children}
    </Link>
  )
}

/**
 * NewTabLink for inside a link card (TaskCard is an <a>): a button that reads like the link, ↗ and URL tooltip
 * included, and opens `href` in a new tab without opening the card.
 */
function NewTabButton({ href, title, className, children, ...rest }: Omit<ComponentProps<"button">, "onClick"> & { href: string }) {
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.button > 1) return
    e.preventDefault()
    e.stopPropagation()
    window.open(href, "_blank", "noopener,noreferrer")
  }
  return (
    <button
      {...rest}
      type="button"
      title={title && !title.includes(href) ? `${title}\n${href}` : (title ?? href)}
      data-external=""
      data-href={href}
      onClick={open}
      onAuxClick={open}
      className={cx("inline cursor-pointer text-left", className)}
    >
      {glueMark(children, <ExternalMark />)}
    </button>
  )
}

/**
 * A link that knows the app: in-app paths (relative or on Box Yard's own origin) navigate through the router
 * (Cmd/Ctrl/middle-click still open a tab), previewable files open in the preview modal, other files and sites
 * in a new tab. Clicks never reach a clickable card around the link. Hovering an entity link shows its title and current status.
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
  if (target.kind !== "app") {
    if (githubRef(target.href))
      return (
        <GithubTextLink href={target.href} title={title} className={className}>
          {children}
        </GithubTextLink>
      )
    return (
      <NewTabLink href={target.href} title={title} className={className}>
        {children}
      </NewTabLink>
    )
  }
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A link inside a clickable card (a notice, a row) goes where it points, not where the card does.
    e.stopPropagation()
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

/** "12m", "1h 5m": how long since `since`, on TimeAgo's shared clock. `title` leads the tooltip ("Running since"). */
export const Elapsed = memo(function Elapsed({ since, title, className }: { since: number; title: string; className?: string }) {
  const label = useSyncExternalStore(subscribeClock, () => elapsedLabel(clockTime() - since))
  return (
    <time className={className} title={`${title} ${new Date(since).toLocaleString()}`}>
      {label}
    </time>
  )
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
