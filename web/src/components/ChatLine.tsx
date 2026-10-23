// One Coordinator-style chat message: user bubbles, markdown replies with next-step chips,
// tool calls (ToolLine) and notices. Shared by the Coordinator panel and the project Captain tab.
import { memo } from "react"
import { Link } from "wouter"
import { AlarmClock, AlertTriangle, Wrench } from "lucide-react"
import { AppLink, Markdown, cx } from "./ui"
import { useEntityIndex } from "../lib/entities"
import { toolMentions } from "../lib/linkify"
import { AttachmentList } from "./Attachments"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import type { ChatMessage } from "../../../shared/types"

/** A tool call, with the tasks, schedules or projects it's about linked by title. */
export const ToolLine = memo(function ToolLine({ m }: { m: ChatMessage }) {
  const index = useEntityIndex()
  const input = (m.meta?.input ?? {}) as Record<string, unknown>
  const resultId = typeof m.meta?.resultId === "string" ? m.meta.resultId : null
  const mentions = toolMentions(m.content, input, resultId, index)
  const detail = mentions.length ? null : ((input.title ?? input.name ?? input.task ?? input.project ?? "") as string)
  return (
    <div className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-zinc-500">
      <Wrench className="h-3 w-3 shrink-0" />
      <span className="font-mono">{m.content}</span>
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

export const ChatLine = memo(function ChatLine({ m, onFollowUp }: { m: ChatMessage; onFollowUp: (message: string) => void }) {
  if (m.role === "user" && m.meta?.scheduleId) {
    // A prompt injected by a Coordinator schedule, not typed by Cody.
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100">
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
        <div className={cx("max-w-[85%] rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100", m.meta?.pending ? "opacity-70" : "")}>
          {m.content}
          <AttachmentList files={m.meta?.attachments} />
        </div>
      </div>
    )
  }
  if (m.role === "tool") return <ToolLine m={m} />
  if (m.role === "notice") {
    const taskId = m.meta?.taskId as string | undefined
    const body = (
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-xs text-zinc-400">
        {/* The whole notice already links to its task; links inside it would nest. */}
        <Markdown linkify={!taskId}>{m.content}</Markdown>
      </div>
    )
    return taskId ? (
      <Link href={`/tasks/${taskId}`} className="block hover:opacity-90">
        {body}
      </Link>
    ) : (
      body
    )
  }
  if (m.role === "error") {
    return (
      <div className="flex gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 whitespace-pre-wrap">{m.content}</div>
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
