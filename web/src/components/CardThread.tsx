// A task card's questions to the Coordinator (CardComposer's "Coordinator" target): the card's side thread (kind
// "task", server/sideThreads.ts), read-only and never in the main chat. Its lines sit among the card's entries in time
// order (CoordinatorCards.tsx), Cody's as "to the Coordinator" bubbles and the answers as "Coordinator · side thread".
import { memo } from "react"
import { AlertTriangle, Bot, Search } from "lucide-react"
import { WorkingLine } from "./CardComposer"
import { SENT_LABEL, USER_BUBBLE } from "./ChatLine"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { LineIcon, Markdown, TimeAgo, cx } from "./ui"
import { useThreadStream } from "../lib/threads"
import type { SideThread, SideThreadMessage } from "../../../shared/types"

/** "🤖 Coordinator · side thread  2m ago" over an answer. */
function AnswerHead({ at }: { at?: number }) {
  return (
    <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-zinc-500">
      <Bot className="h-3 w-3 shrink-0 text-yard-400" aria-hidden />
      <span className="shrink-0 font-medium text-zinc-300">Coordinator</span>
      <span className="min-w-0 truncate" title="A read-only side thread: the main chat doesn't see it">
        · side thread
      </span>
      {at !== undefined && <TimeAgo ts={at} />}
    </div>
  )
}

/** One line of a card's thread. */
export const CardThreadLine = memo(function CardThreadLine({ m }: { m: SideThreadMessage }) {
  if (m.role === "user")
    return (
      <div data-testid="card-thread-question" className="flex flex-col items-end gap-1">
        <div className={SENT_LABEL}>
          <Bot className="h-3 w-3 shrink-0 text-yard-400" aria-hidden />
          to the Coordinator
        </div>
        <div className={cx(MESSAGE_BLOCK, USER_BUBBLE, m.meta?.pending ? "opacity-70" : "")}>{m.content}</div>
      </div>
    )
  if (m.role === "tool")
    return (
      <div className="flex items-start gap-1.5 pl-1 text-xs text-zinc-500">
        <LineIcon icon={Search} className="h-3.5 w-3.5" />
        <span className="min-w-0 wrap-anywhere">
          Looked up <span className="font-mono text-zinc-400">{m.content}</span>
        </span>
      </div>
    )
  if (m.role === "error")
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
        <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">{m.content}</div>
      </div>
    )
  return (
    <div data-testid="card-thread-answer" className={cx(MESSAGE_BLOCK, "text-sm text-zinc-200")}>
      <AnswerHead at={m.createdAt} />
      <Markdown>{m.content}</Markdown>
      <MessageActions text={m.content} />
    </div>
  )
})

/** Under the card's entries while the Coordinator answers: its words as they stream, or "••• The Coordinator is working". */
export function CardThreadLive({ thread }: { thread: SideThread }) {
  const stream = useThreadStream(thread.id).data
  if (stream)
    return (
      <div data-testid="card-thread-streaming" className="text-sm text-zinc-200">
        <AnswerHead />
        <Markdown live>{stream}</Markdown>
      </div>
    )
  return thread.busy ? <WorkingLine who="The Coordinator" /> : null
}
