// Replying inside a card of the Coordinator chat (CoordinatorCards.tsx): the box sends straight to the card's task,
// like the task page's composer, and the chat shows what was sent (TaskManager.sentFromChat). A gone box isn't a
// failure (sending restores the task from its archive or a recap). Only when the server refuses the message does it
// go to the Coordinator instead, with the task's id and the reason (lib/reroute.ts), and the card says so.
import { memo, useCallback, useRef, useState } from "react"
import { CornerUpRight } from "lucide-react"
import { Composer } from "./Composer"
import { TaskTile } from "./TaskIcon"
import { cx } from "./ui"
import { newClientId, refused, useSendChat, useSendTaskMessage } from "../lib/queries"
import { reroutedMessage } from "../lib/reroute"
import { setChatProjectFilter, useChatProjectFilter } from "../lib/projectBar"
import { badgeStatus } from "../lib/prState"
import type { Attachment, Task } from "../../../shared/types"

/** The box in a card: the same Composer as every chat, text only, in the card's flow instead of a sticky footer. */
const BOX = "pt-1"

/** What the box says: what a message does to the task. */
export function cardPlaceholder(task: Task): string {
  const status = badgeStatus(task)
  if (status === "queued" || status === "starting" || status === "working") return "Queue another message…"
  if (status === "needs_input") return "Answer the agent…"
  if (status === "done" || status === "merged") return "Reply (reopens the task)…"
  return "Reply to this task…"
}

/**
 * Sending a reply to `task` from the chat: straight to it, or to the Coordinator when it refuses (lib/reroute.ts).
 * `rerouted`: why the last one went to the Coordinator, until the next one goes through. A card's box and the chat's
 * docked box (DockComposer.tsx) share it.
 */
export function useCardSend(task: Task | null) {
  const toTask = useSendTaskMessage(task?.id ?? "", { quiet: refused })
  const toCoordinator = useSendChat()
  const [rerouted, setRerouted] = useState<{ taskId: string; reason: string } | null>(null)
  const submit = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      const content = text.trim()
      if (!content || !task) return
      try {
        await toTask.mutateAsync({ content, attachments, inChat: true })
        setRerouted(null)
      } catch (err) {
        if (!refused(err)) throw err
        const reason = (err as Error).message
        // Thrown again when the Coordinator can't take it either: the Composer puts the text back.
        await toCoordinator.mutateAsync({ id: newClientId("chat"), content: reroutedMessage(task, reason, content) })
        setRerouted({ taskId: task.id, reason })
      }
    },
    [task, toTask.mutateAsync, toCoordinator.mutateAsync],
  )
  return { submit, rerouted: rerouted && rerouted.taskId === task?.id ? rerouted.reason : null }
}

/** A task's card (or a batch's task row). `className`: the side panel's sticky footer. */
export const CardComposer = memo(function CardComposer({ task, className = BOX }: { task: Task; className?: string }) {
  const panel = useRef<HTMLElement>(null)
  const { submit, rerouted } = useCardSend(task)
  return (
    <div data-testid="card-composer" className="@container/box">
      <Composer
        onSubmit={submit}
        placeholder={cardPlaceholder(task)}
        panelRef={panel}
        historyKey={`task:${task.id}`}
        files={false}
        className={className}
        tools={
          <span data-testid="card-composer-hint" title="Goes straight to this task's agent and resumes its session" className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-600 @max-[18rem]/box:hidden">
            <TaskTile id={task.id} bare />
            <span className="min-w-0 truncate">To this task</span>
          </span>
        }
      />
      {rerouted !== null && <Rerouted reason={rerouted} />}
    </div>
  )
})

/** Under a card's box: its last reply went to the Coordinator, why, and (behind a project filter) the way to it. */
export function Rerouted({ reason }: { reason: string }) {
  const filtered = useChatProjectFilter() !== null
  const show = () => {
    setChatProjectFilter(null)
    requestAnimationFrame(() => document.getElementById("card-coordinator")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }))
  }
  return (
    <div data-testid="card-rerouted" role="status" className="flex items-start gap-1.5 px-1 pt-1 text-[11.5px] text-amber-300/90">
      <CornerUpRight className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 wrap-anywhere">
        This task couldn't take it ({reason}), so it went to the Coordinator.
        {filtered && (
          <>
            {" "}
            <button type="button" onClick={show} className={cx("text-yard-400 underline-offset-2 hover:underline pointer-coarse:min-h-11")}>
              Show
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/** "••• The Hollow is working": someone is answering in this card. */
export function WorkingLine({ who }: { who: string }) {
  return (
    <div data-testid="card-working" className="flex min-w-0 items-center gap-2 py-0.5 text-[11.5px] text-zinc-500">
      <span aria-hidden className="flex shrink-0 gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-[5px] w-[5px] animate-bounce rounded-full bg-yard-400" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      <span className="min-w-0 truncate">{who} is working</span>
    </div>
  )
}
