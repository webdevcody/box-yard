import { useRef, useState } from "react"
import { Link } from "wouter"
import { Bot, MessageCircleQuestion, Users } from "lucide-react"
import {
  useArtifacts,
  useProjects,
  useSchedules,
  useSendTaskMessage,
  useTaskMessages,
  useTasks,
} from "../lib/queries"
import { Empty, Markdown, TimeAgo, cx } from "./ui"
import { StickyScroll } from "./StickyScroll"
import { Composer } from "./Composer"
import { TaskHeader, useStoredFlag } from "./TaskHeader"
import { AttachmentList } from "./Attachments"
import type { Attachment, TaskMessage } from "../../../shared/types"

export function TaskView({ id }: { id: string }) {
  const tasks = useTasks()
  const projects = useProjects()
  const schedules = useSchedules()
  const messages = useTaskMessages(id)
  const artifacts = useArtifacts()
  const send = useSendTaskMessage(id)
  const [draft, setDraft] = useState("")
  const [showTools, setShowTools] = useStoredFlag("boxyard:show-tool-calls")
  const panel = useRef<HTMLDivElement>(null)
  const task = tasks.data?.find((t) => t.id === id)
  const project = projects.data?.find((p) => p.id === task?.projectId)
  const schedule = task?.scheduleId ? schedules.data?.find((s) => s.id === task.scheduleId) : null

  if (tasks.isLoading) return null
  if (!task) return <Empty title="Task not found">It may have been deleted.</Empty>

  const running = task.status === "working" || task.status === "starting"
  const files = (artifacts.data ?? []).filter((a) => a.taskId === id)
  const shown = (messages.data ?? []).filter((m) => showTools || m.role !== "tool")

  const submit = (attachments: Attachment[]) => {
    if (!draft.trim() && !attachments.length) return
    send.mutate({ content: draft.trim(), attachments })
    setDraft("")
  }

  return (
    <div ref={panel} className="relative flex h-full flex-col">
      <TaskHeader task={task} project={project} schedule={schedule} files={files} showTools={showTools} onShowTools={setShowTools} />

      {task.status === "needs_input" && task.question && (
        <div className="mb-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100">
          <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <div className="text-xs font-semibold tracking-wide text-amber-400 uppercase">The agent needs you</div>
            <div className="mt-1 text-sm">{task.question}</div>
          </div>
        </div>
      )}
      {task.status === "failed" && task.error && (
        <div className="mb-4 rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm whitespace-pre-wrap text-red-200">{task.error}</div>
      )}

      <StickyScroll count={shown.length} resetKey={id} className="rounded-xl border border-zinc-900 bg-zinc-950 p-4" contentClassName="space-y-2.5">
        {messages.isLoading && <div className="text-sm text-zinc-500">Loading transcript…</div>}
        {shown.map((m) => (
          <Line key={m.id} m={m} />
        ))}
        {running && (
          <div className="flex items-center gap-2 pt-1 text-xs text-sky-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {task.status === "starting" ? "Preparing the box…" : "Agent is working…"}
          </div>
        )}
      </StickyScroll>

      <Composer
        className="mt-3"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        panelRef={panel}
        placeholder={
          task.status === "needs_input"
            ? "Answer the agent…"
            : running
              ? "Message is delivered when the current turn ends…"
              : "Send feedback or a follow-up (resumes the same session)…"
        }
      />
    </div>
  )
}

function Line({ m }: { m: TaskMessage }) {
  const time = (
    <span className="ml-2 text-[10px] text-zinc-600">
      <TimeAgo ts={m.createdAt} />
    </span>
  )
  switch (m.role) {
    case "user":
      return (
        <div className={cx("rounded-lg border-l-2 border-yard-500 bg-yard-500/5 px-3 py-2", m.meta?.pending ? "opacity-60" : "")}>
          <div className="mb-0.5 text-[11px] font-semibold text-yard-400">
            {m.meta?.kind === "task_prompt" ? "Task" : m.meta?.source === "orchestrator" ? "Orchestrator" : "Cody"}
            {time}
          </div>
          {m.content && <div className="text-sm whitespace-pre-wrap text-zinc-200">{m.content}</div>}
          <AttachmentList files={m.meta?.attachments} />
        </div>
      )
    case "assistant":
      return (
        <div className="flex gap-2">
          <Bot className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="min-w-0 text-sm text-zinc-200">
            <Markdown>{m.content}</Markdown>
          </div>
        </div>
      )
    case "tool":
      return (
        <div className={cx("truncate pl-6 font-mono text-[11px]", m.meta?.error ? "text-red-400/80" : "text-zinc-600")}>
          {m.meta?.error ? "✗ " : "› "}
          {m.content}
        </div>
      )
    case "agent":
      return (
        <div className="flex gap-2 rounded-lg bg-violet-500/5 px-3 py-2 text-sm text-violet-200">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
          <div className="min-w-0">
            {typeof m.meta?.from === "string" && (
              <Link href={`/tasks/${m.meta.from}`} className="mb-0.5 block text-[11px] font-semibold text-violet-400 hover:underline">
                From {String(m.meta.fromTitle ?? m.meta.from)}
              </Link>
            )}
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        </div>
      )
    default: {
      const url = typeof m.meta?.url === "string" ? m.meta.url : null
      return (
        <div className="pl-6 text-xs text-zinc-500">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="hover:text-zinc-300 hover:underline">
              {m.content}
            </a>
          ) : (
            m.content
          )}
          {time}
        </div>
      )
    }
  }
}
