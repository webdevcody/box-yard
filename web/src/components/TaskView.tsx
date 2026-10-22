import { useRef, useState } from "react"
import { Link, useLocation } from "wouter"
import {
  AlarmClock,
  ArrowLeft,
  Bot,
  Box,
  CircleStop,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  MessageCircleQuestion,
  RefreshCcw,
  Trash2,
  Users,
  Wrench,
  CheckCircle2,
} from "lucide-react"
import {
  useArtifacts,
  useCloseTask,
  useCompactTask,
  useDeleteTask,
  useProjects,
  useRetryTask,
  useSchedules,
  useSendTaskMessage,
  useStopTask,
  useTaskMessages,
  useTasks,
} from "../lib/queries"
import { api } from "../lib/api"
import { toast } from "../lib/toast"
import { Button, Empty, Markdown, StatusBadge, TimeAgo, cx } from "./ui"
import { StickyScroll } from "./StickyScroll"
import { Composer } from "./Composer"
import { ContextMeter } from "./ContextMeter"
import { AttachmentList } from "./Attachments"
import type { Attachment, TaskMessage } from "../../../shared/types"

export function TaskView({ id }: { id: string }) {
  const tasks = useTasks()
  const projects = useProjects()
  const schedules = useSchedules()
  const messages = useTaskMessages(id)
  const artifacts = useArtifacts()
  const send = useSendTaskMessage(id)
  const stop = useStopTask()
  const close = useCloseTask()
  const retry = useRetryTask()
  const compact = useCompactTask()
  const del = useDeleteTask()
  const [, navigate] = useLocation()
  const [draft, setDraft] = useState("")
  const [port, setPort] = useState("")
  const [showTools, setShowTools] = useState(false)
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
      <div className="mb-4">
        <Link href={project ? `/projects/${project.id}` : "/"} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
          <ArrowLeft className="h-3.5 w-3.5" /> {project?.name ?? "Back"}
        </Link>
        <div className="mt-1 flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-zinc-50">{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500">
          {task.scheduleId && (
            <Link href="/schedules" className="inline-flex items-center gap-1 text-yard-400 hover:underline">
              <AlarmClock className="h-3.5 w-3.5" /> {schedule ? `Schedule: ${schedule.name}` : "From a deleted schedule"}
            </Link>
          )}
          {task.branch && (
            <span className="inline-flex items-center gap-1 font-mono">
              <GitBranch className="h-3.5 w-3.5" /> {task.branch}
            </span>
          )}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:underline">
              <GitPullRequest className="h-3.5 w-3.5" /> Pull request
            </a>
          )}
          {task.previews.map((p) => (
            <a key={p.port} href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-400 hover:underline">
              <Globe className="h-3.5 w-3.5" /> {p.label} <ExternalLink className="h-3 w-3" />
            </a>
          ))}
          {files.map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-yard-400 hover:underline">
              <FileText className="h-3.5 w-3.5" /> {a.title}
            </a>
          ))}
          <span className="inline-flex items-center gap-1" title="Worker box">
            <Box className="h-3.5 w-3.5" /> {task.boxId ?? (task.lastArchivedAt ? "archived" : "no box yet")}
          </span>
          <span>{task.turnCount} turns</span>
        </div>
        <ContextMeter
          className="mt-3"
          tokens={task.contextTokens}
          window={task.contextWindow}
          compacting={task.compacting}
          queued={task.compactPending}
          canCompact={task.turnCount > 0 && task.status !== "failed"}
          onCompact={() => compact.mutate(id)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {running && (
            <Button size="sm" variant="subtle" onClick={() => stop.mutate(id)}>
              <CircleStop className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
          {task.status === "failed" && (
            <Button size="sm" variant="subtle" onClick={() => retry.mutate(id)}>
              <RefreshCcw className="h-3.5 w-3.5" /> Retry
            </Button>
          )}
          {task.status !== "done" && (
            <Button size="sm" variant="subtle" onClick={() => close.mutate(id)}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark done
            </Button>
          )}
          <form
            className="flex items-center gap-1"
            onSubmit={async (e) => {
              e.preventDefault()
              const n = Number(port)
              if (!n) return
              try {
                const link = await api<{ url: string }>(`/api/tasks/${id}/preview`, { body: { port: n } })
                window.open(link.url, "_blank")
                setPort("")
              } catch (err) {
                toast.error("Couldn't open a preview", (err as Error).message)
              }
            }}
          >
            <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="port" className="w-16 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs" />
            <Button size="sm" variant="ghost" type="submit" disabled={!port}>
              <Globe className="h-3.5 w-3.5" /> Preview
            </Button>
          </form>
          <Button size="sm" variant="ghost" onClick={() => setShowTools((v) => !v)}>
            <Wrench className="h-3.5 w-3.5" /> {showTools ? "Hide" : "Show"} tool calls
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              if (confirm("Delete this task, its workspace and its archive?")) {
                del.mutate(id)
                navigate(project ? `/projects/${project.id}` : "/")
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

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
