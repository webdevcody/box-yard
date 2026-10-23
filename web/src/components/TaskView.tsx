import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { Link } from "wouter"
import { Bot, MessageCircleQuestion, Users } from "lucide-react"
import {
  newClientId,
  useArtifacts,
  useProjects,
  useSchedules,
  useSendChat,
  useSendTaskMessage,
  useTask,
  useTaskMessages,
} from "../lib/queries"
import { useEntityIndex } from "../lib/entities"
import { useTail } from "../lib/tail"
import { AppLink, Empty, Markdown, TimeAgo, cx, warmMarkdown } from "./ui"
import { StickyScroll } from "./StickyScroll"
import { Composer } from "./Composer"
import { TaskHeader, useStoredFlag } from "./TaskHeader"
import { AttachmentList } from "./Attachments"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import { SelectionToTask } from "./SelectionToTask"
import { projectContext, taskContext, type SelectionTaskSource } from "../lib/selectionTask"
import type { Attachment, TaskMessage } from "../../../shared/types"

export function TaskView({ id }: { id: string }) {
  // Only this task: other tasks' live updates don't re-render the view.
  const tasks = useTask(id)
  const projects = useProjects()
  const schedules = useSchedules()
  const artifacts = useArtifacts()
  const send = useSendTaskMessage(id)
  const sendChat = useSendChat()
  const [showTools, setShowTools] = useStoredFlag("boxyard:show-tool-calls")
  const panel = useRef<HTMLDivElement>(null)
  const task = tasks.data
  const project = projects.data?.find((p) => p.id === task?.projectId)
  const schedule = task?.scheduleId ? schedules.data?.find((s) => s.id === task.scheduleId) : null
  const submit = useCallback((content: string, attachments: Attachment[]) => send.mutate({ content, attachments }), [send.mutate])
  const sendFollowUp = useCallback((content: string) => send.mutate({ content, attachments: [] }), [send.mutate])
  const startFromSelection = useCallback(
    (content: string) => sendChat.mutate({ id: newClientId("chat"), content, attachments: [] }),
    [sendChat.mutate],
  )
  const selectionSource: SelectionTaskSource | null = project && task ? { kind: "task", project: projectContext(project)!, task: taskContext(task)! } : null

  if (tasks.isLoading) return null
  if (!task) return <Empty title="Task not found">It may have been deleted.</Empty>

  const running = task.status === "working" || task.status === "starting"
  const files = (artifacts.data ?? []).filter((a) => a.taskId === id)

  return (
    <div ref={panel} className="relative flex h-full min-w-0 flex-col">
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

      <TaskThread
        id={id}
        showTools={showTools}
        working={running ? (task.status === "starting" ? "Preparing the box…" : "Agent is working…") : null}
        selectionSource={selectionSource}
        onStartFromSelection={startFromSelection}
        onFollowUp={sendFollowUp}
      />

      <Composer
        className="sticky bottom-0 z-10 mt-3 border-t border-zinc-900 bg-zinc-950/95 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur"
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

/** The transcript. Its own component so header updates (status, context meter) don't re-render it. */
const TaskThread = memo(function TaskThread({
  id,
  showTools,
  working,
  selectionSource,
  onStartFromSelection,
  onFollowUp,
}: {
  id: string
  showTools: boolean
  working: string | null
  selectionSource: SelectionTaskSource | null
  onStartFromSelection: (prompt: string) => void
  onFollowUp: (message: string) => void
}) {
  const messages = useTaskMessages(id)
  const shown = useMemo(() => (messages.data ?? []).filter((m) => showTools || m.role !== "tool"), [messages.data, showTools])
  const tail = useTail(shown, id)

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  useEffect(() => {
    if (hidden) warmMarkdown(shown.slice(0, hidden).flatMap((m) => (m.role === "assistant" ? [m.content] : [])), index)
  }, [shown, hidden, index])

  return (
    <SelectionToTask source={selectionSource} onPrompt={onStartFromSelection}>
      <StickyScroll
        count={shown.length}
        resetKey={id}
        hidden={tail.hidden}
        onLoadEarlier={tail.loadEarlier}
        className="rounded-xl border border-zinc-900 bg-zinc-950 p-4"
        contentClassName="space-y-2.5"
      >
        {messages.isLoading && <div className="text-sm text-zinc-500">Loading transcript…</div>}
        {tail.visible.map((m) => (
          <Line key={m.id} m={m} onFollowUp={onFollowUp} />
        ))}
        {working && (
          <div className="flex items-center gap-2 pt-1 text-xs text-sky-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {working}
          </div>
        )}
      </StickyScroll>
    </SelectionToTask>
  )
})

const Line = memo(function Line({ m, onFollowUp }: { m: TaskMessage; onFollowUp: (message: string) => void }) {
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
        <div className="flex min-w-0 gap-2">
          <Bot className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="min-w-0 text-sm text-zinc-200">
            <Markdown>{m.content}</Markdown>
            <RecommendedNextSteps steps={nextStepsFromMeta(m.meta)} onPick={onFollowUp} />
          </div>
        </div>
      )
    case "tool":
      return (
        <div className={cx("overflow-x-auto pl-6 font-mono text-[11px] whitespace-nowrap", m.meta?.error ? "text-red-400/80" : "text-zinc-600")}>
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
            <AppLink href={url} className="hover:text-zinc-300 hover:underline">
              {m.content}
            </AppLink>
          ) : (
            m.content
          )}
          {time}
        </div>
      )
    }
  }
})
