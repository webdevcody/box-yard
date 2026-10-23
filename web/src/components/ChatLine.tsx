// One Coordinator-style chat message: user bubbles, markdown replies with next-step chips,
// tool calls (ToolLine) and notices. Shared by the Coordinator panel and the project Captain tab.
import { memo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import { AlarmClock, AlertTriangle, ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react"
import { AppLink, Markdown, cx } from "./ui"
import { useEntityIndex } from "../lib/entities"
import { toolMentions } from "../lib/linkify"
import { CAPTAIN_TOOLS, captainToolView, isLongMessage } from "../lib/captainTranscript"
import { AttachmentList } from "./Attachments"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
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
        <span className="min-w-0 truncate font-mono">{m.content}</span>
        <span className="shrink-0 text-zinc-600">·</span>
        {v.href ? (
          <AppLink href={v.href} className="shrink-0 text-zinc-400 hover:text-zinc-200 hover:underline">
            {v.project!.label} Captain
          </AppLink>
        ) : (
          <span className="shrink-0">{projectRef ?? "project"} Captain</span>
        )}
        {!open && v.message && <span className="min-w-0 truncate text-zinc-600">· {v.message.replace(/\s+/g, " ")}</span>}
        {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-600" aria-label="Waiting for the Captain" />}
        <ChevronRight className={cx("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <div className="mt-1.5 mb-1 ml-1.5 space-y-2.5 border-l border-zinc-800 pl-3">
          {v.message && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-sky-400/90 uppercase">Sent to the Captain</div>
              <CollapsibleMarkdown className="text-sm text-zinc-300">{v.message}</CollapsibleMarkdown>
            </div>
          )}
          {v.waits && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-yard-400/90 uppercase">
                Captain replied{v.finished === false ? " (still working)" : ""}
              </div>
              {v.reply ? (
                <CollapsibleMarkdown className="text-sm text-zinc-300">{v.reply}</CollapsibleMarkdown>
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
      <span className="min-w-0 truncate font-mono">{m.content}</span>
      {mentions.length > 0 && (
        <span className="truncate text-zinc-600">
          ·{" "}
          {mentions.map((t, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {t.ref ? (
                <AppLink href={t.ref.href} className="text-zinc-400 hover:text-zinc-200 hover:underline">
                  {t.text.slice(0, 60)}
                </AppLink>
              ) : (
                t.text.slice(0, 60)
              )}
            </span>
          ))}
        </span>
      )}
      {detail && <span className="truncate text-zinc-600">· {String(detail).slice(0, 60)}</span>}
    </div>
  )
})

const NOTICE_CLASS = "rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-xs text-zinc-400"

/**
 * A task notice: clicking it opens the task (Cmd/Ctrl or middle click in a new tab). Not an <a>: the notice's
 * own links (a PR, a preview) would nest inside it and the outer link would swallow their clicks.
 */
function NoticeCard({ taskId, children }: { taskId: string; children: ReactNode }) {
  const [, navigate] = useLocation()
  const href = `/tasks/${taskId}`
  const open = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a")) return
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
      className={cx(NOTICE_CLASS, "cursor-pointer hover:opacity-90 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none")}
    >
      {children}
    </div>
  )
}

export const ChatLine = memo(function ChatLine({ m, onFollowUp }: { m: ChatMessage; onFollowUp: (message: string) => void }) {
  if (m.role === "user" && m.meta?.scheduleId) {
    // A prompt injected by a Coordinator schedule, not typed by Cody.
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className="max-w-[85%] min-w-0 rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-sky-300 uppercase">
            <AlarmClock className="h-3 w-3" /> Scheduled
          </div>
          {m.content}
        </div>
      </div>
    )
  }
  if (m.role === "user") {
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className={cx("max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100", m.meta?.pending ? "opacity-70" : "")}>
          {m.content}
          <AttachmentList files={m.meta?.attachments} />
        </div>
      </div>
    )
  }
  if (m.role === "tool") return <ToolLine m={m} />
  if (m.role === "notice") {
    const taskId = m.meta?.taskId as string | undefined
    const body = <Markdown>{m.content}</Markdown>
    return taskId ? (
      <NoticeCard taskId={taskId}>{body}</NoticeCard>
    ) : (
      <div className={NOTICE_CLASS}>{body}</div>
    )
  }
  if (m.role === "error") {
    return (
      <div className="flex gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">{m.content}</div>
      </div>
    )
  }
  return (
    <div className="text-sm text-zinc-200">
      <Markdown>{m.content}</Markdown>
      <RecommendedNextSteps steps={nextStepsFromMeta(m.meta)} onPick={onFollowUp} />
    </div>
  )
})
