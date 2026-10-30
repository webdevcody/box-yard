// Replying inside a card of the Coordinator chat (CoordinatorCards.tsx). "This task", the default, sends straight to
// the task's agent like the task page's composer, and the chat shows what was sent (TaskManager.sentFromChat).
// "Coordinator" asks in the card's own side thread (kind "task", CardThread.tsx): read-only, with the task as its
// context, and the main chat and the Coordinator's session never see it. Each card remembers its choice for the session.
import { memo, useCallback, useRef } from "react"
import { Bot } from "lucide-react"
import { Composer } from "./Composer"
import { TaskTile } from "./TaskIcon"
import { cx } from "./ui"
import { useSendTaskMessage } from "../lib/queries"
import { newThreadIds, useAskCard } from "../lib/threads"
import { setOpen, useChipOpen } from "../lib/chipState"
import { badgeStatus } from "../lib/prState"
import type { Attachment, Task } from "../../../shared/types"

/** The box in a card: the same Composer as every chat, text only, in the card's flow instead of a sticky footer. */
const BOX = "pt-1"

/** The chipState key of a card's "send to the Coordinator" choice (closed: to the task). */
const askKey = (taskId: string) => `ask:${taskId}`

/** What the box says: where the message goes and what it does to the task. */
export function cardPlaceholder(task: Task, coordinator: boolean): string {
  if (coordinator) return "Ask the Coordinator about this…"
  const status = badgeStatus(task)
  if (status === "queued" || status === "starting" || status === "working") return "Queue another message…"
  if (status === "needs_input") return "Answer the agent…"
  if (status === "done" || status === "merged") return "Reply (reopens the task)…"
  return "Reply to this task…"
}

const TARGET =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] whitespace-nowrap focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:px-2.5"

/** The box is a `box` container: a narrow one (a 320px phone, a batch's task row) keeps the picked target's word and
 *  shows the other as its icon, so the toggle never runs under the send button. The placeholder names the target too. */
const BOX_CONTAINER = "@container/box"
const OTHER_LABEL = "@max-[18rem]/box:sr-only"

/** A task's card (or a batch's task row): This task | Coordinator. `className`: the side panel's sticky footer. */
export const CardComposer = memo(function CardComposer({ task, className = BOX }: { task: Task; className?: string }) {
  const [coordinator] = useChipOpen(askKey(task.id))
  const toTask = useSendTaskMessage(task.id)
  const ask = useAskCard()
  const panel = useRef<HTMLElement>(null)
  const submit = useCallback(
    (text: string, attachments: Attachment[]) => {
      const content = text.trim()
      if (!content) return
      // A task card's thread is anchored on its task: the same one from its own card or its batch's row.
      if (coordinator) return ask.mutateAsync({ ...newThreadIds(), anchorId: task.id, title: task.title, question: content })
      return toTask.mutateAsync({ content, attachments, inChat: true })
    },
    [coordinator, task.id, task.title, ask.mutateAsync, toTask.mutateAsync],
  )
  const pick = (ask: boolean) => setOpen([askKey(task.id)], ask)
  return (
    <div data-testid="card-composer" data-to={coordinator ? "coordinator" : "task"} className={BOX_CONTAINER}>
      <Composer
        onSubmit={submit}
        placeholder={cardPlaceholder(task, coordinator)}
        panelRef={panel}
        historyKey={coordinator ? `card-thread:${task.id}` : `task:${task.id}`}
        files={false}
        className={className}
        tools={
          <span className="flex min-w-0 items-center gap-2">
            <span role="group" aria-label="Send to" className="flex shrink-0 items-center rounded-lg border border-zinc-800 p-0.5">
              <button type="button" aria-pressed={!coordinator} onClick={() => pick(false)} title="Straight to this task's agent, like the task page's box" className={cx(TARGET, !coordinator ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200")}>
                <TaskTile id={task.id} bare />
                <span className={cx(coordinator && OTHER_LABEL)}>This task</span>
              </button>
              <button type="button" aria-pressed={coordinator} onClick={() => pick(true)} title="A read-only side thread with the Coordinator (like a reply thread), with this task as context" className={cx(TARGET, coordinator ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200")}>
                <Bot className="h-3 w-3 shrink-0 text-yard-400" aria-hidden />
                <span className={cx(!coordinator && OTHER_LABEL)}>Coordinator</span>
              </button>
            </span>
            <span data-testid="card-composer-hint" className="min-w-0 truncate text-[11px] text-zinc-600 @max-[30rem]/box:hidden">
              {coordinator ? "A side thread with the Coordinator about this task: it answers, it doesn't act" : "Goes straight to this task's agent and resumes its session"}
            </span>
          </span>
        }
      />
    </div>
  )
})

/** A batch card's own box: questions to the Coordinator about all its tasks, in the batch card's thread. Each task's row has its own CardComposer. `className`: the side panel's sticky footer. */
export const BatchComposer = memo(function BatchComposer({ cardKey, title, className = BOX }: { cardKey: string; title: string; className?: string }) {
  const ask = useAskCard()
  const panel = useRef<HTMLElement>(null)
  const submit = useCallback(
    (text: string) => {
      const content = text.trim()
      if (!content) return
      return ask.mutateAsync({ ...newThreadIds(), anchorId: cardKey, title, question: content })
    },
    [cardKey, title, ask.mutateAsync],
  )
  return (
    <div data-testid="card-composer" data-to="coordinator" className={BOX_CONTAINER}>
      <Composer
        onSubmit={submit}
        placeholder="Ask the Coordinator about these tasks…"
        panelRef={panel}
        historyKey={`card-thread:${cardKey}`}
        files={false}
        className={className}
        tools={
          <span data-testid="card-composer-hint" title="A read-only side thread with the Coordinator, with these tasks as context" className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-600">
            <Bot className="h-3 w-3 shrink-0 text-yard-400" aria-hidden />
            <span className="min-w-0 truncate">A side thread with the Coordinator: it answers, it doesn't act</span>
          </span>
        }
      />
    </div>
  )
})

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
