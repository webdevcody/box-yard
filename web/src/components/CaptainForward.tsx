// The task page's composer, which can send a message to the project's Captain instead of the task's agent
// (lib/captainForward.ts), and the two thread lines that follow: "→ Captain" and the Captain's reply.
import { memo, useCallback, useRef, useState, type RefObject } from "react"
import { flushSync } from "react-dom"
import { Bot, X } from "lucide-react"
import { COMPOSER_FOOTER, Composer, type ComposerHandle } from "./Composer"
import { captainHref } from "./ChatSwitcher"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { AttachmentList } from "./Attachments"
import { AppLink, LineIcon, Markdown, TimeAgo, cx } from "./ui"
import { useForwardToCaptain, useOwnerName } from "../lib/queries"
import { looksLikeTaskManagement, offersCaptain } from "../lib/captainForward"
import type { Attachment, Project, Task, TaskMessage } from "../../../shared/types"

/** The composer is a `composer` container: on a narrow one (a 320px phone) the Captain chip keeps only its icon. */
const NARROW_LABEL = "@max-[22rem]/composer:sr-only"

const CHIP =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-3"

const queuedLabel = (n: number) => (n === 1 ? "1 queued message" : `${n} queued messages`)

/**
 * The task page's box. While the task is busy or has queued messages, a "Captain" chip sends the next message to the
 * project's Captain (with the task's queue) instead of queueing it for the agent; after that send it goes back to the
 * task. A draft that reads like task management gets a one-tap "Send to Captain"; nothing is ever rerouted on its own.
 */
export const TaskComposer = memo(function TaskComposer({
  task,
  project,
  panelRef,
  onSubmit,
  onForwarded,
}: {
  task: Task
  project: Project | undefined
  panelRef: RefObject<HTMLElement | null>
  /** To the task's agent (queued while it's busy). */
  onSubmit: (text: string, attachments: Attachment[]) => Promise<unknown>
  /** After a send to the Captain: scroll the thread to its line. */
  onForwarded?: () => void
}) {
  const [toCaptain, setToCaptain] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const handle = useRef<ComposerHandle>(null)
  const forward = useForwardToCaptain(task.id)
  const captain = `${project?.name ?? "project"} Captain`
  const offered = offersCaptain(task, task.pendingCount)
  const running = task.status === "working" || task.status === "starting"

  const submit = useCallback(
    (text: string, attachments: Attachment[]) => {
      setDismissed(false)
      if (!toCaptain) return onSubmit(text, attachments)
      const sending = forward.mutateAsync({ content: text, attachments })
      onForwarded?.()
      // Back to the task for the next message; a failed send keeps the Captain picked (the text is back in the box).
      sending.then(() => setToCaptain(false), () => {})
      return sending
    },
    [toCaptain, onSubmit, forward.mutateAsync, onForwarded],
  )

  const sendToCaptain = useCallback(() => {
    flushSync(() => setToCaptain(true))
    handle.current?.submit()
  }, [])

  const hint = useCallback(
    (draft: string) => {
      if (toCaptain)
        return (
          <div data-testid="captain-forward-note" className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px] text-yard-300/80">
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              To the {captain}, not the agent{task.pendingCount ? `, with this task's ${queuedLabel(task.pendingCount)}` : ""}. Its reply shows here.
            </span>
          </div>
        )
      if (!offered || dismissed || !looksLikeTaskManagement(draft)) return null
      return (
        <div role="status" data-testid="captain-suggest" className="mx-1 mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-yard-500/30 bg-yard-500/10 py-1 pr-1 pl-2 text-[11px] text-yard-200">
          <span className="min-w-0 flex-1 basis-40">
            Sounds like task management. The {captain} can act on it now; the agent only reads it {running ? "after this turn" : "when it starts"}.
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={sendToCaptain} className={cx(CHIP, "bg-yard-500/20 font-medium text-yard-100 hover:bg-yard-500/30")}>
              <Bot className="h-3.5 w-3.5" aria-hidden />
              Send to Captain
            </button>
            <button type="button" onClick={() => setDismissed(true)} aria-label="Keep it for the task" title="Keep it for the task" className={cx(CHIP, "px-1.5 text-yard-300/70 hover:text-yard-100")}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </div>
      )
    },
    [toCaptain, offered, dismissed, captain, task.pendingCount, running, sendToCaptain],
  )

  return (
    <Composer
      handleRef={handle}
      className={cx(COMPOSER_FOOTER, "mt-3 @container/composer")}
      onSubmit={submit}
      panelRef={panelRef}
      historyKey={`task:${task.id}`}
      hint={hint}
      tools={
        (offered || toCaptain) && (
          <button
            type="button"
            data-testid="captain-target"
            aria-pressed={toCaptain}
            onClick={() => setToCaptain((on) => !on)}
            title={toCaptain ? "Sending to the Captain: tap to send to the task's agent instead" : `Send this to the ${captain} instead: it can split, reprioritise or start tasks and edit this task's queue now`}
            className={cx(CHIP, toCaptain ? "bg-yard-500/15 text-yard-200 ring-1 ring-yard-500/40" : "text-zinc-500 hover:text-zinc-200")}
          >
            <Bot className="h-3.5 w-3.5 text-yard-400" aria-hidden />
            <span className={NARROW_LABEL}>{toCaptain ? "To Captain" : "Captain"}</span>
          </button>
        )
      }
      placeholder={
        toCaptain
          ? `Ask the ${captain}: split, reprioritise, the queue…`
          : task.status === "needs_input"
            ? "Answer the agent…"
            : running
              ? "Message is delivered when the current turn ends…"
              : "Send feedback or a follow-up (resumes the same session)…"
      }
    />
  )
})

/** "Cody → box-yard Captain": Cody's message sent from this chat to the Captain (TaskManager.forwardToCaptain). */
export const ToCaptainLine = memo(function ToCaptainLine({ m }: { m: TaskMessage }) {
  const ownerName = useOwnerName()
  const name = typeof m.meta?.captainName === "string" ? `${m.meta.captainName} Captain` : "Captain"
  const queued = typeof m.meta?.queued === "number" ? m.meta.queued : 0
  const pid = typeof m.meta?.captainProjectId === "string" ? m.meta.captainProjectId : null
  return (
    <div data-testid="to-captain" className={cx(MESSAGE_BLOCK, "rounded-lg border-l-2 border-dashed border-yard-500/70 bg-yard-500/5 px-3 py-2", m.meta?.pending ? "opacity-60" : "")}>
      <div className="mb-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] font-semibold text-yard-400">
        <span className="min-w-0 truncate">
          {ownerName} → {pid ? <AppLink href={captainHref(pid)} className="hover:underline">{name}</AppLink> : name}
        </span>
        <span className="font-normal text-zinc-500">
          · sent to the Captain{queued ? `, with ${queuedLabel(queued)}` : ""}
        </span>
        <span className="ml-1 text-[10px] font-normal text-zinc-600">
          <TimeAgo ts={m.createdAt} />
        </span>
      </div>
      {m.content && <div className="text-sm whitespace-pre-wrap wrap-anywhere text-zinc-200">{m.content}</div>}
      <AttachmentList files={m.meta?.attachments as Attachment[] | undefined} />
      {!m.meta?.pending && <MessageActions text={m.content} />}
    </div>
  )
})

/** The Captain's reply to a message sent from this chat (TaskManager.captainAnsweredForwards). */
export const CaptainAnswerLine = memo(function CaptainAnswerLine({ m }: { m: TaskMessage }) {
  const name = typeof m.meta?.captainName === "string" ? `${m.meta.captainName} Captain` : "Captain"
  const pid = typeof m.meta?.captainProjectId === "string" ? m.meta.captainProjectId : null
  return (
    <div data-testid="captain-answer" className={cx(MESSAGE_BLOCK, "flex min-w-0 items-start gap-2 rounded-lg bg-yard-500/5 px-3 py-2 text-sm leading-relaxed")}>
      <LineIcon icon={Bot} className="h-4 w-4 text-yard-400" />
      <div className="min-w-0 text-zinc-200 [&>.prose-chat>:first-child]:mt-0!">
        <div className="mb-0.5 text-[11px] leading-5 font-semibold text-yard-400">
          {pid ? <AppLink href={captainHref(pid)} className="hover:underline">{name}</AppLink> : name}
          <span className="font-normal text-zinc-500"> · replied</span>
          <span className="ml-2 text-[10px] font-normal text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        <Markdown>{m.content}</Markdown>
      </div>
      <MessageActions text={m.content} />
    </div>
  )
})
