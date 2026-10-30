// One Coordinator-style chat message: user bubbles, markdown replies with next-step chips,
// tool calls (ToolLine) and notices. Shared by the Coordinator panel and the project Captain tab.
import { memo, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import { AlarmClock, AlertTriangle, Bot, ChevronDown, ChevronRight, Loader2, Webhook, Wrench } from "lucide-react"
import { AppLink, InRepo, LineIcon, Markdown, cx } from "./ui"
import { useEntityIndex } from "../lib/entities"
import { routes, toolMentions } from "../lib/linkify"
import { CAPTAIN_TOOLS, captainToolView, isLongMessage, splitNotice, type NoticeKind } from "../lib/captainTranscript"
import { NOTICE_ICON } from "./noticeIcons"
import { AttachmentList } from "./Attachments"
import { QueuedChatMessage } from "./QueuedMessages"
import { ProjectDot, TaskTile } from "./TaskIcon"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { ThreadMarkers } from "./SideThread"
import { ReplySources } from "./ReplySources"
import type { UpdateSource } from "../lib/chatUpdates"
import type { ChatMessage } from "../../../shared/types"

/** Markdown that folds behind "Show more" when it's long. */
export function CollapsibleMarkdown({ children, className }: { children: string; className?: string }) {
  const long = isLongMessage(children)
  const [open, setOpen] = useState(false)
  return (
    <div className={className}>
      {/* A mask, not an overlay, so the fade works on any bubble background. */}
      <div className={cx(long && !open && "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>
        <Markdown>{children}</Markdown>
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200"
        >
          <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

/**
 * A collapsed tool line's parts, in the order they give way on a narrow row: the preview first (flex-1 from a zero
 * basis, so it only ever takes the room that's left), then the target; the tool name never shrinks.
 */
const TOOL_NAME = "max-w-full shrink-0 truncate font-mono"
const TOOL_TARGET = "min-w-0 truncate"
const TOOL_PREVIEW = "min-w-0 flex-1 truncate"

/**
 * A send_to_captain / ask_captain / wait_for_captain call: links that project's Captain tab and
 * expands on click to the message the Coordinator sent and, for ask/wait, what the Captain replied.
 */
const CaptainToolLine = memo(function CaptainToolLine({ m }: { m: ChatMessage }) {
  const index = useEntityIndex()
  const [open, setOpen] = useState(false)
  const v = captainToolView(m.content, m.meta, index)
  const projectRef = typeof (m.meta?.input as Record<string, unknown> | undefined)?.project === "string" ? String((m.meta!.input as Record<string, unknown>).project) : null
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    setOpen((o) => !o)
  }
  // ask/wait give up after at most 4 minutes; an older line without a result never got one.
  const pending = v.waits && !m.meta?.captain && Date.now() - m.createdAt < 5 * 60_000
  return (
    <div data-testid="captain-tool" className="pl-1 text-xs text-zinc-500">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={toggle}
        className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
      >
        <Wrench className="h-3 w-3 shrink-0" />
        <span data-testid="tool-name" className={TOOL_NAME}>
          {m.content}
        </span>
        <span className="shrink-0 text-zinc-600">·</span>
        {v.href ? (
          <AppLink href={v.href} className={cx(TOOL_TARGET, "text-zinc-400 hover:text-zinc-200 hover:underline")}>
            {v.project!.label} Captain
          </AppLink>
        ) : (
          <span data-testid="tool-target" className={TOOL_TARGET}>
            {projectRef ?? "project"} Captain
          </span>
        )}
        {!open && v.message && (
          <span data-testid="tool-preview" className={cx(TOOL_PREVIEW, "text-zinc-600")}>
            · {v.message.replace(/\s+/g, " ")}
          </span>
        )}
        {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-600" aria-label="Waiting for the Captain" />}
        <ChevronRight className={cx("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <div className="mt-1.5 mb-1 ml-1.5 space-y-2.5 border-l border-zinc-800 pl-3">
          {v.message && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-sky-400/90 uppercase">Sent to the Captain</div>
              <InRepo projectId={v.project?.id}>
                <CollapsibleMarkdown className="text-sm text-zinc-300">{v.message}</CollapsibleMarkdown>
              </InRepo>
            </div>
          )}
          {v.waits && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-yard-400/90 uppercase">
                Captain replied{v.finished === false ? " (still working)" : ""}
              </div>
              {v.reply ? (
                <InRepo projectId={v.project?.id}>
                  <CollapsibleMarkdown className="text-sm text-zinc-300">{v.reply}</CollapsibleMarkdown>
                </InRepo>
              ) : (
                <div className="text-zinc-500">{pending ? "Waiting for the Captain…" : "No reply yet. The Captain reports back when it's done."}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/** A tool call, with the tasks, schedules or projects it's about linked by title. */
export const ToolLine = memo(function ToolLine({ m }: { m: ChatMessage }) {
  if (CAPTAIN_TOOLS.has(m.content)) return <CaptainToolLine m={m} />
  return <PlainToolLine m={m} />
})

const PlainToolLine = memo(function PlainToolLine({ m }: { m: ChatMessage }) {
  const index = useEntityIndex()
  const input = (m.meta?.input ?? {}) as Record<string, unknown>
  const resultId = typeof m.meta?.resultId === "string" ? m.meta.resultId : null
  const mentions = toolMentions(m.content, input, resultId, index)
  const detail = mentions.length ? null : ((input.title ?? input.name ?? input.task ?? input.project ?? "") as string)
  return (
    <div className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-zinc-500">
      <Wrench className="h-3 w-3 shrink-0" />
      <span data-testid="tool-name" className={TOOL_NAME}>
        {m.content}
      </span>
      {mentions.length > 0 && (
        <span data-testid="tool-target" className={cx(TOOL_TARGET, "text-zinc-600")}>
          ·{" "}
          {mentions.map((t, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {t.ref ? (
                <AppLink href={t.ref.href} className="text-zinc-400 hover:text-zinc-200 hover:underline">
                  {t.ref.kind === "task" && <TaskTile id={t.ref.id} bare className="mr-0.5 align-[-2px]" />}
                  {t.ref.kind === "project" && <ProjectDot projectId={t.ref.id} className="mr-1 align-[1px]" />}
                  {t.text.slice(0, 60)}
                </AppLink>
              ) : (
                t.text.slice(0, 60)
              )}
            </span>
          ))}
        </span>
      )}
      {detail && (
        <span data-testid="tool-target" className={cx(TOOL_TARGET, "text-zinc-600")}>
          · {String(detail).slice(0, 60)}
        </span>
      )}
    </div>
  )
})

export const NOTICE_CLASS = "rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-xs text-zinc-400"

/**
 * The task's project and a link to its Captain, as a quiet pair of links that starts a notice's meta line (with a
 * trailing "·" before the event). The project comes from the notice's meta or, for notices that don't carry it,
 * from the task; with neither known there's no pair.
 */
export function NoticeProject({ taskId, projectId }: { taskId: string; projectId?: string | null }) {
  const index = useEntityIndex()
  const id = projectId ?? index.byId.get(taskId)?.projectId
  const project = id ? index.byId.get(id) : undefined
  if (!id || project?.kind !== "project") return null
  const link = "rounded-sm text-zinc-500 hover:text-zinc-200 hover:underline focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
  return (
    // One line box high and top-aligned, so it sits on the meta line's first line like text.
    <span data-testid="notice-project" className="mr-1 inline-flex h-lh max-w-full items-center gap-1 align-top whitespace-nowrap">
      <AppLink href={routes.project(id)} title={`Project: ${project.label}`} className={cx("min-w-0 truncate", link)}>
        {project.label}
      </AppLink>
      <span aria-hidden className="text-zinc-700">
        ·
      </span>
      <AppLink href={`${routes.project(id)}?tab=captain`} title={`${project.label} Captain`} className={cx("inline-flex shrink-0 items-center gap-0.5", link)}>
        <Bot className="h-3 w-3" aria-hidden />
        Captain
      </AppLink>
      <span aria-hidden className="text-zinc-700">
        ·
      </span>
    </span>
  )
}

export const NOTICE_TITLE_LINK = "font-semibold text-yard-400 underline decoration-yard-400/40 underline-offset-2 hover:decoration-yard-400"

/**
 * Every notice card's layout, at every width (Cody's rule): the icon and the task title on a row of their own, so a
 * narrow panel never squeezes the title; under it a muted meta line (the project · Captain pair, then what happened);
 * then the card's own sections, like a file list with its Show all / Hide toggle in that list's header.
 * The column is the card's `@container`, so sections switch on the card's width, not the window's (the panel resizes).
 */
export function NoticeLayout({
  kind,
  title,
  taskId,
  project,
  meta,
  titleClassName = NOTICE_TITLE_LINK,
  children,
}: {
  kind: NoticeKind
  title: string | null
  /** Links the title to the task. */
  taskId?: string | null
  /** The NoticeProject pair, at the start of the meta line. */
  project?: ReactNode
  meta?: ReactNode
  /** The title link's look; the Captain tab's slim rows pass theirs. */
  titleClassName?: string
  children?: ReactNode
}) {
  const { icon, className, label } = NOTICE_ICON[kind]
  return (
    <div className="flex min-w-0 items-start gap-2 leading-relaxed">
      <LineIcon icon={icon} className={cx("h-3.5 w-3.5", className)} label={label} />
      <div data-testid="notice-body" className="@container min-w-0 flex-1">
        {title && (
          <div data-testid="notice-title" className="wrap-anywhere">
            {taskId ? (
              <AppLink href={`/tasks/${taskId}`} className={titleClassName}>
                {title}
              </AppLink>
            ) : (
              <span className="font-semibold text-zinc-200">{title}</span>
            )}
          </div>
        )}
        {(project || meta) && (
          <div data-testid="notice-meta" className="wrap-anywhere text-zinc-400">
            {project}
            {meta}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/**
 * A notice's event text, still markdown (a PR link, code), flowing inline after the project pair like one sentence.
 * Only its first paragraph is inline; a longer one (a list in a notes retro) continues as blocks below.
 */
const NoticeEvent = memo(function NoticeEvent({ children }: { children: string }) {
  if (!children) return null
  return (
    <div className="inline [&>.prose-chat]:inline [&>.prose-chat>p:first-child]:inline">
      <Markdown>{children}</Markdown>
    </div>
  )
})

/**
 * Where a shortened notice's text goes on: the task's page, which has the agent's whole reply. Stands in for the
 * server's "[truncated: … call get_task]" marker, which is meant for the model (splitNotice drops it).
 */
export function FullReplyLink({ taskId }: { taskId: string }) {
  return (
    <>
      {" "}
      <AppLink href={routes.task(taskId)} className="font-medium whitespace-nowrap text-zinc-300 hover:text-zinc-100 hover:underline">
        Read the full reply
      </AppLink>
    </>
  )
}

/**
 * A task notice: clicking it opens the task (Cmd/Ctrl or middle click in a new tab). Not an <a>: the notice's
 * own links (a PR, a preview) would nest inside it and the outer link would swallow their clicks. Its own links
 * and buttons (a "Show all" toggle) keep their clicks.
 */
export function NoticeCard({ taskId, className, children }: { taskId: string; className?: string; children: ReactNode }) {
  const [, navigate] = useLocation()
  const href = `/tasks/${taskId}`
  const open = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a, button")) return
    if ("key" in e) {
      if (e.key !== "Enter") return
    } else if (e.button > 1) return
    e.preventDefault()
    if ("button" in e && (e.button === 1 || e.metaKey || e.ctrlKey)) window.open(href, "_blank", "noopener")
    else navigate(href)
  }
  return (
    <div
      role="link"
      tabIndex={0}
      data-href={href}
      onClick={open}
      onAuxClick={open}
      onKeyDown={open}
      className={cx(NOTICE_CLASS, "cursor-pointer hover:opacity-90 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none", className)}
    >
      {children}
    </div>
  )
}

/**
 * Notices that wait on Cody or went wrong get a coloured edge: the Coordinator chat never folds them into a chip
 * (lib/chatUpdates.ts ATTENTION_KINDS), and the colour keeps them apart from the quiet chips around them.
 */
const NOTICE_ACCENT: Partial<Record<NoticeKind, string>> = {
  // `!`: NOTICE_CLASS sets the same properties.
  needs_input: "border-amber-500/40! bg-amber-500/5!",
  failed: "border-red-500/40! bg-red-950/20!",
  merge: "border-merged-fg/40! bg-merged/5!",
}

/** A notice in the Coordinator chat (and Zen): a NoticeLayout, in a NoticeCard when it's about a task. */
const NoticeLine = memo(function NoticeLine({ m }: { m: ChatMessage }) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  const n = useMemo(() => splitNotice(m.content, m.meta), [m.content, m.meta])
  const body = (
    <NoticeLayout
      kind={n.kind}
      title={n.title}
      taskId={taskId}
      project={taskId && <NoticeProject taskId={taskId} projectId={projectId} />}
      meta={
        <>
          <NoticeEvent>{n.event}</NoticeEvent>
          {n.truncated && taskId && <FullReplyLink taskId={taskId} />}
        </>
      }
    />
  )
  const accent = NOTICE_ACCENT[n.kind]
  return (
    <div id={`chat-${m.id}`} data-testid="notice-card" data-attention={accent ? n.kind : undefined} className={MESSAGE_BLOCK}>
      <InRepo taskId={taskId} projectId={projectId}>
        {taskId ? (
          <NoticeCard taskId={taskId} className={accent}>
            {body}
          </NoticeCard>
        ) : (
          <div className={cx(NOTICE_CLASS, accent)}>{body}</div>
        )}
      </InRepo>
      <MessageActions text={m.content} anchorId={m.id} />
    </div>
  )
})

/**
 * A chat message. Its root names the message (`data-chat-id`): a selection in it can start a side thread on it, and
 * the threads it has show as markers under it (SideThread.tsx; nothing outside a chat with threads).
 * `sources`: on a Coordinator reply, the updates it read (lib/chatUpdates.ts), named in a "from:" line under it.
 * `next`: whether its suggested next steps show (the Coordinator chat shows only the newest reply's).
 */
export const ChatLine = memo(function ChatLine({ m, onFollowUp, sources, next = true }: { m: ChatMessage; onFollowUp: (message: string) => void; sources?: UpdateSource[] | null; next?: boolean }) {
  return (
    <div data-chat-id={m.id}>
      <ChatLineBody m={m} onFollowUp={onFollowUp} sources={sources} next={next} />
      {m.role !== "tool" && <ThreadMarkers m={m} />}
    </div>
  )
})

function ChatLineBody({ m, onFollowUp, sources, next }: { m: ChatMessage; onFollowUp: (message: string) => void; sources?: UpdateSource[] | null; next: boolean }) {
  if (m.role === "user" && m.meta?.scheduleId) {
    // A prompt injected by a Coordinator schedule, not typed by Cody.
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className={cx(MESSAGE_BLOCK, "max-w-[85%] min-w-0 rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100")}>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-sky-300 uppercase">
            <AlarmClock className="h-3 w-3" /> Scheduled
          </div>
          {m.content}
          <MessageActions text={m.content} anchorId={m.id} />
        </div>
      </div>
    )
  }
  if (m.role === "user" && m.meta?.source === "hook") {
    // A hook's message_coordinator action (server/hooks.ts), not typed by Cody.
    const bubble = (
      <div className={cx(MESSAGE_BLOCK, "max-w-[85%] min-w-0 rounded-2xl rounded-br-md border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100")}>
        <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-teal-300 uppercase">
          <Webhook className="h-3 w-3" /> Hook: {String(m.meta.hookName ?? "")}
        </div>
        {m.content}
        {m.meta.queued !== true && <MessageActions text={m.content} anchorId={m.id} />}
      </div>
    )
    return (
      <div id={`chat-${m.id}`} className="flex flex-col items-end gap-1">
        {m.meta.queued === true ? (
          <QueuedChatMessage m={m} projectId={null} who="the Coordinator">
            {bubble}
          </QueuedChatMessage>
        ) : (
          bubble
        )}
      </div>
    )
  }
  if (m.role === "user") {
    const bubble = (
      <div className={cx(MESSAGE_BLOCK, "max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100", m.meta?.pending ? "opacity-70" : "")}>
        {m.content}
        <AttachmentList files={m.meta?.attachments} />
        {!m.meta?.pending && m.meta?.queued !== true && <MessageActions text={m.content} anchorId={m.id} />}
      </div>
    )
    return (
      <div id={`chat-${m.id}`} className="flex flex-col items-end gap-1">
        {m.meta?.queued === true ? (
          <QueuedChatMessage m={m} projectId={null} who="the Coordinator">
            {bubble}
          </QueuedChatMessage>
        ) : (
          bubble
        )}
      </div>
    )
  }
  if (m.role === "tool") return <ToolLine m={m} />
  if (m.role === "notice") return <NoticeLine m={m} />
  if (m.role === "error") {
    return (
      <div className={cx(MESSAGE_BLOCK, "flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300")}>
        <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
        <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">{m.content}</div>
        <MessageActions text={m.content} anchorId={m.id} />
      </div>
    )
  }
  return (
    <div id={`chat-${m.id}`} data-testid="chat-reply" className={cx(MESSAGE_BLOCK, "text-sm text-zinc-200")}>
      <Markdown>{m.content}</Markdown>
      {sources && <ReplySources sources={sources} />}
      {next && <RecommendedNextSteps steps={nextStepsFromMeta(m.meta)} onPick={onFollowUp} />}
      <MessageActions text={m.content} anchorId={m.id} reply />
    </div>
  )
}
