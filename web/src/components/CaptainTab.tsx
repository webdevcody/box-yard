// The project page's Captain tab: the Captain's transcript as a chat, like the Coordinator panel.
// A slim header (status, model, context + Compact, last active, ⋯ menu), the thread with task
// notices folded into one-line rows, and the shared Composer to message the Captain directly.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react"
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  GitMerge,
  GitPullRequest,
  Info,
  MessageCircleQuestion,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  NotebookPen,
  Paperclip,
  UserRound,
  Users,
  Webhook,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import {
  newClientId,
  useAgentSettings,
  useCaptainCompactions,
  useCaptainMessages,
  useCaptainState,
  useCompactCaptain,
  useSendCaptainMessage,
} from "../lib/queries"
import { useTail } from "../lib/tail"
import { useEntityIndex } from "../lib/entities"
import { captainRows, groupLabel, parseNotice, plainText, stripFrontMatter, type CaptainNoticeItem, type CaptainRow, type NoticeKind } from "../lib/captainTranscript"
import { AppLink, Button, LineIcon, Markdown, TimeAgo, cx, warmMarkdown } from "./ui"
import { ChatLine, CollapsibleMarkdown } from "./ChatLine"
import { AttachmentList } from "./Attachments"
import { captainSourceOf } from "../../../shared/captain"
import { Composer } from "./Composer"
import { ContextMeter, ContextMiniBar, formatTokens } from "./ContextMeter"
import { StickyScroll } from "./StickyScroll"
import { Modal } from "./Modal"
import { PREVIEW_GROUP } from "./FileLink"
import { PublishedRow } from "./PublishedNotices"
import { menuItem, usePopover } from "./TaskHeader"
import type { Attachment, CaptainCompaction, CaptainMessage, CaptainSource, CaptainState, Project } from "../../../shared/types"

const NO_MESSAGES: CaptainMessage[] = []

const NOTICE_ICON: Record<NoticeKind, { icon: LucideIcon; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: "text-emerald-400", label: "Done" },
  failed: { icon: XCircle, className: "text-red-400", label: "Failed" },
  needs_input: { icon: MessageCircleQuestion, className: "text-amber-400", label: "Needs you" },
  pr: { icon: GitPullRequest, className: "text-emerald-400", label: "Pull request" },
  merge: { icon: GitMerge, className: "text-merged-fg", label: "Merge requested" },
  hook: { icon: Webhook, className: "text-teal-300", label: "Hook fired" },
  artifact: { icon: Paperclip, className: "text-zinc-400", label: "File published" },
  message: { icon: MessageSquare, className: "text-sky-400", label: "Update" },
  warning: { icon: AlertTriangle, className: "text-amber-400", label: "Warning" },
  compaction: { icon: Minimize2, className: "text-zinc-500", label: "Compacted" },
  notes: { icon: NotebookPen, className: "text-amber-300", label: "Project notes" },
  info: { icon: Info, className: "text-zinc-500", label: "Notice" },
}

export function CaptainTab({ project }: { project: Project }) {
  const state = useCaptainState(project.id)
  const messages = useCaptainMessages(project.id)
  const send = useSendCaptainMessage(project.id)
  const panel = useRef<HTMLElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setOpenGroups(new Set()), [project.id])

  const submit = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      const content = text.trim()
      if (!content && !attachments.length) return
      send.mutate({ id: newClientId("chat"), content, attachments })
      box.current?.focus()
    },
    [send.mutate],
  )
  const toggleGroup = useCallback(
    (id: string) =>
      setOpenGroups((prev) => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    [],
  )

  const list = messages.data ?? NO_MESSAGES
  const rows = useMemo(() => captainRows(list), [list])
  const tail = useTail(rows, project.id)

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  useEffect(() => {
    if (hidden) warmMarkdown(rows.slice(0, hidden).flatMap((r) => (r.type === "message" && r.message.role === "assistant" ? [r.message.content] : [])), index)
  }, [rows, hidden, index])

  const busy = Boolean(state.data?.busy)
  const lastActive = Math.max(list.at(-1)?.createdAt ?? 0, state.data?.usage.updatedAt ?? 0) || null

  return (
    <section
      ref={panel}
      data-testid="captain-chat"
      // Open at the bottom: the shared Composer's own border-t and bottom padding end the card, as in ChatPanel.
      className="relative flex min-h-[32rem] flex-1 flex-col overflow-hidden rounded-t-xl border border-b-0 border-zinc-900 bg-zinc-950"
    >
      <CaptainHeader projectId={project.id} state={state.data} lastActive={lastActive} />
      {state.data?.error && (
        <div className="flex gap-2 border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{state.data.error}</span>
        </div>
      )}

      <StickyScroll
        count={list.length}
        resetKey={project.id}
        hidden={tail.hidden}
        onLoadEarlier={tail.loadEarlier}
        className="px-3 py-4 sm:px-4"
        contentClassName="mx-auto max-w-3xl space-y-3"
      >
        {list.length === 0 && !messages.isLoading && <EmptyCaptain project={project} onPick={submit} />}
        {tail.visible.map((row) => (
          <Row key={row.id} row={row} open={openGroups.has(row.id)} onToggle={toggleGroup} onFollowUp={submit} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1 py-1 text-xs text-sky-400" aria-live="polite">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400/70" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
            Captain is working…
          </div>
        )}
      </StickyScroll>

      <Composer onSubmit={submit} placeholder={busy ? "Queue another message…" : "Message the Captain…"} textareaRef={box} panelRef={panel} />
    </section>
  )
}

function EmptyCaptain({ project, onPick }: { project: Project; onPick: (text: string) => void }) {
  const suggestions = [`What's open in ${project.name}?`, "Summarize what the agents finished today", "Which tasks need me?"]
  return (
    <div className="space-y-3 pt-6 text-center">
      <Bot className="mx-auto h-8 w-8 text-zinc-600" />
      <p className="text-sm text-zinc-400">No Captain history yet. Message the Captain or ask the Coordinator to route project work here.</p>
      <div className="mx-auto max-w-md space-y-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="block w-full rounded-lg border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

const Row = memo(function Row({
  row,
  open,
  onToggle,
  onFollowUp,
}: {
  row: CaptainRow
  open: boolean
  onToggle: (id: string) => void
  onFollowUp: (message: string) => void
}) {
  if (row.type === "message")
    return row.message.role === "user" ? <InboundMessage m={row.message} /> : <ChatLine m={row.message} onFollowUp={onFollowUp} />
  if (row.type === "notice") return <NoticeRow m={row.message} />
  if (row.type === "files") return <PublishedRow group={row.group} />
  return <NoticeGroup id={row.id} items={row.items} messages={row.messages} open={open} onToggle={onToggle} />
})

const INBOUND: Record<CaptainSource, { label: string; icon: LucideIcon; box: string; head: string }> = {
  cody: { label: "You", icon: UserRound, box: "rounded-br-md bg-yard-500/15", head: "text-yard-300" },
  coordinator: { label: "From Coordinator", icon: Bot, box: "rounded-bl-md border border-sky-500/25 bg-sky-500/5", head: "text-sky-300" },
  schedule: { label: "Scheduled", icon: AlarmClock, box: "rounded-bl-md border border-violet-500/25 bg-violet-500/5", head: "text-violet-300" },
  hook: { label: "Hook", icon: Webhook, box: "rounded-bl-md border border-teal-500/25 bg-teal-500/5", head: "text-teal-300" },
  agent: { label: "From task", icon: Users, box: "rounded-bl-md border border-amber-500/25 bg-amber-500/5", head: "text-amber-300" },
}

/** "From task <title>" for an agent's message_captain: the title links to the task, and a waiting agent says so. */
function AgentSource({ meta }: { meta: CaptainMessage["meta"] }) {
  const taskId = typeof meta?.taskId === "string" ? meta.taskId : null
  const title = typeof meta?.taskTitle === "string" && meta.taskTitle.trim() ? meta.taskTitle : (taskId ?? "unknown task")
  const wait = typeof meta?.waitSeconds === "number" ? meta.waitSeconds : 0
  const held = typeof meta?.heldUntil === "number"
  return (
    <>
      <span className="shrink-0">From task</span>
      {taskId ? (
        <AppLink href={`/tasks/${taskId}`} className="min-w-0 truncate font-semibold tracking-normal normal-case hover:underline" title={`${title} (${taskId})`}>
          {title}
        </AppLink>
      ) : (
        <span className="min-w-0 truncate tracking-normal normal-case">{title}</span>
      )}
      {(held || wait > 0) && (
        <span
          className="shrink-0 rounded bg-amber-500/15 px-1 font-normal tracking-normal normal-case"
          title={held ? "The Captain's loop guard held this repeated message back for a while" : `The agent waited up to ${wait} s mid-turn for a reply`}
        >
          {held ? "held by loop guard" : `waits ${wait}s`}
        </span>
      )}
    </>
  )
}

/** A message to the Captain, labelled by who sent it: Cody (right), the Coordinator or a schedule (left). Long ones fold. */
const InboundMessage = memo(function InboundMessage({ m }: { m: CaptainMessage }) {
  const source = captainSourceOf(m)
  const s = INBOUND[source]
  const Icon = s.icon
  const tool = typeof m.meta?.tool === "string" ? m.meta.tool : null
  return (
    <div id={`captain-${m.id}`} data-testid="captain-inbound" data-source={source} className={cx("flex", source === "cody" && "justify-end")}>
      <div className={cx("max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-sm text-zinc-100", s.box, m.meta?.pending ? "opacity-70" : "")}>
        <div className={cx("mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase", s.head)}>
          <Icon className="h-3 w-3 shrink-0" />{" "}
          {source === "agent" ? <AgentSource meta={m.meta} /> : source === "hook" && typeof m.meta?.hookName === "string" ? `Hook: ${m.meta.hookName}` : s.label}
          {tool && <span className="min-w-0 truncate font-mono font-normal tracking-normal normal-case opacity-70">· {tool}</span>}
          <span className="ml-auto pl-2 font-normal tracking-normal normal-case text-zinc-500">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        {m.content && <CollapsibleMarkdown>{m.content}</CollapsibleMarkdown>}
        <AttachmentList files={m.meta?.attachments} />
      </div>
    </div>
  )
})

/** One task notice on one line: status icon, linked task title, a plain summary and the time. Click to see all of it. */
const NoticeRow = memo(function NoticeRow({ m }: { m: CaptainMessage }) {
  const [full, setFull] = useState(false)
  const n = useMemo(() => parseNotice(m.content, m.meta), [m.content, m.meta])
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const { icon: Icon, className, label } = NOTICE_ICON[n.kind]
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    setFull((v) => !v)
  }
  return (
    <div
      id={`captain-${m.id}`}
      role="button"
      tabIndex={0}
      aria-expanded={full}
      title={full ? undefined : plainText(m.content)}
      onClick={toggle}
      onKeyDown={toggle}
      className={cx(
        "flex min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900/60 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none",
      )}
      {...PREVIEW_GROUP}
    >
      <LineIcon icon={Icon} className={cx("h-3.5 w-3.5", className)} label={label} />
      <div className={cx("min-w-0 flex-1", full ? "whitespace-normal wrap-anywhere" : "truncate")}>
        {n.title &&
          (taskId ? (
            <AppLink href={`/tasks/${taskId}`} className="font-medium text-zinc-200 hover:underline">
              {n.title}
            </AppLink>
          ) : (
            <span className="font-medium text-zinc-200">{n.title}</span>
          ))}
        {n.title && n.summary.length > 0 && <span className="text-zinc-600"> · </span>}
        {n.summary.map((s, i) =>
          "href" in s ? (
            <AppLink key={i} href={s.href} className="text-yard-400 hover:underline">
              {s.label}
            </AppLink>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      <span className="shrink-0 text-[11px] text-zinc-600">
        <TimeAgo ts={m.createdAt} />
      </span>
    </div>
  )
})

/** Consecutive notices folded into "4 task updates", with their icons and titles as a preview. */
const NoticeGroup = memo(function NoticeGroup({
  id,
  items,
  messages,
  open,
  onToggle,
}: {
  id: string
  items: CaptainNoticeItem[]
  messages: CaptainMessage[]
  open: boolean
  onToggle: (id: string) => void
}) {
  const parsed = useMemo(() => messages.map((m) => parseNotice(m.content, m.meta)), [messages])
  const kinds = [...new Set(parsed.map((p) => p.kind))].slice(0, 4)
  const titles = [...new Set(parsed.flatMap((p) => (p.title ? [p.title] : [])))]
  const last = messages.at(-1)!
  return (
    <div data-testid="notice-group" className="rounded-lg border border-zinc-900 bg-zinc-900/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(id)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-900/60 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
      >
        <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex shrink-0 gap-0.5">
          {kinds.map((k) => {
            const { icon: Icon, className } = NOTICE_ICON[k]
            return <Icon key={k} className={cx("h-3.5 w-3.5", className)} />
          })}
        </span>
        <span className="shrink-0 font-medium text-zinc-300">{groupLabel(messages, items.length)}</span>
        {titles.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-zinc-600">
            · {titles.slice(0, 2).join(", ")}
            {titles.length > 2 ? ` +${titles.length - 2}` : ""}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-1 text-[11px] text-zinc-600">
          <TimeAgo ts={last.createdAt} />
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 border-t border-zinc-900 px-1 py-1">
          {items.map((item) => (item.type === "files" ? <PublishedRow key={item.id} group={item.group} /> : <NoticeRow key={item.id} m={item.message} />))}
        </div>
      )}
    </div>
  )
})

function StatusPill({ state }: { state: CaptainState | undefined }) {
  const s = !state
    ? { label: "…", dot: "bg-zinc-600" }
    : state.error
      ? { label: "Error", dot: "bg-red-500" }
      : state.compacting
        ? { label: "Compacting", dot: "bg-violet-400 animate-pulse" }
        : state.busy
          ? { label: "Working", dot: "bg-sky-400 animate-pulse" }
          : { label: "Idle", dot: "bg-zinc-400" }
  return (
    // The same quiet dot-and-label as the task header's status (StatusDot).
    <span data-testid="captain-status" className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-zinc-200">
      <span className={cx("h-2 w-2 shrink-0 rounded-full", s.dot)} aria-hidden />
      {s.label}
    </span>
  )
}

function CaptainHeader({ projectId, state, lastActive }: { projectId: string; state: CaptainState | undefined; lastActive: number | null }) {
  const compact = useCompactCaptain(projectId)
  const settings = useAgentSettings().data?.settings
  const model = settings ? `${settings.orchestratorModel} · ${settings.orchestratorEffort} effort` : null
  const meter: MeterProps = {
    tokens: state?.usage.tokens ?? null,
    window: state?.usage.window ?? null,
    compacting: state?.compacting ?? false,
    queued: Boolean(state?.compactQueued) || compact.isPending,
    canCompact: Boolean(state),
    onCompact: () => compact.mutate(),
  }
  return (
    // Like the task header: name, status and a small context reading; model, last active and the full meter are in ⋯.
    <header className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 sm:px-4">
      <Bot className="h-4 w-4 shrink-0 text-yard-400" />
      <span className="text-sm font-semibold text-zinc-100">Captain</span>
      <StatusPill state={state} />
      <div className="ml-auto flex items-center gap-1">
        <ContextMiniBar tokens={meter.tokens} window={meter.window} hint="How much of the Captain's context window is used. Compact from the ⋯ menu when it gets high." className="mr-1" />
        <CaptainMenu projectId={projectId} meter={meter} model={model} lastActive={lastActive} />
      </div>
    </header>
  )
}

type MeterProps = Omit<ComponentProps<typeof ContextMeter>, "className">

function CaptainMenu({ projectId, meter, model, lastActive }: { projectId: string; meter: MeterProps; model: string | null; lastActive: number | null }) {
  const { open, setOpen, root, trigger } = usePopover()
  const [history, setHistory] = useState(false)
  const compactions = useCaptainCompactions(projectId)
  const count = compactions.data?.length ?? 0
  return (
    <div ref={root} className="relative">
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        className="px-1.5"
        aria-label="Captain menu"
        title="More"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Captain actions"
          className="absolute top-full right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 text-sm shadow-2xl"
        >
          <div className="space-y-1 border-b border-zinc-800/80 px-2 pt-1.5 pb-2.5 text-xs text-zinc-500">
            {model && (
              <p className="truncate" title="The Captain runs on the Coordinator's model and effort (Settings → Coordinator)">
                <span className="text-zinc-300">{model}</span>
              </p>
            )}
            {lastActive && (
              <p>
                Active <TimeAgo ts={lastActive} />
              </p>
            )}
            <ContextMeter className="pt-1.5" {...meter} />
          </div>
          <button
            type="button"
            autoFocus
            className={cx(menuItem, "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent")}
            disabled={count === 0}
            onClick={() => {
              setOpen(false)
              setHistory(true)
            }}
          >
            <Archive className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">{count === 0 ? "No compactions yet" : "Compaction history"}</span>
            {count > 0 && <span className="rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-400 tabular-nums">{count}</span>}
          </button>
        </div>
      )}
      {history && <CompactionHistory compactions={compactions.data ?? []} onClose={() => setHistory(false)} />}
    </div>
  )
}

/** The Captain's compaction summaries, newest first; the newest is open. */
function CompactionHistory({ compactions, onClose }: { compactions: CaptainCompaction[]; onClose: () => void }) {
  const list = useMemo(() => [...compactions].reverse(), [compactions])
  const [openFile, setOpenFile] = useState<string | null>(list[0]?.file ?? null)
  return (
    <Modal onClose={onClose} size="xl" title="Captain compaction history" description="Context summaries this Captain wrote before compacting. They're separate from task compactions.">
      {list.length === 0 ? (
        <p className="text-sm text-zinc-500">No compactions yet.</p>
      ) : (
        <ol className="space-y-2">
          {list.map((c) => {
            const open = openFile === c.file
            return (
              <li key={c.file} className="rounded-xl border border-zinc-800 bg-zinc-900/30">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenFile(open ? null : c.file)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-zinc-900/60"
                >
                  <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")} />
                  <span className="text-zinc-200">{new Date(c.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span className="text-xs text-zinc-500">
                    <TimeAgo ts={c.at} />
                  </span>
                  <span className="ml-auto text-xs text-zinc-500 tabular-nums">
                    {c.tokensBefore !== null ? formatTokens(c.tokensBefore) : "?"} → {c.tokensAfter !== null ? formatTokens(c.tokensAfter) : "?"} tokens
                  </span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{c.trigger}</span>
                </button>
                {open && (
                  <div className="border-t border-zinc-800 px-4 py-3 text-sm text-zinc-300">
                    <Markdown>{stripFrontMatter(c.content)}</Markdown>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </Modal>
  )
}
