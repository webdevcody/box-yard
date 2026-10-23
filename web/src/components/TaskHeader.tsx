// The task page header: one row with the title, status and the one action that matters
// right now, a quiet second row with where it lives and its links, and a "⋯" popover
// for everything else.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation } from "wouter"
import {
  AlarmClock,
  ArrowLeft,
  Box,
  Check,
  CheckCircle2,
  CircleStop,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  Globe,
  Hash,
  Loader2,
  Minimize2,
  MoreHorizontal,
  Plug,
  RefreshCcw,
  Trash2,
  Wrench,
} from "lucide-react"
import { useCloseTask, useCompactTask, useDeleteTask, useRetryTask, useStopTask } from "../lib/queries"
import { api } from "../lib/api"
import { primaryAction, type PrimaryAction } from "../lib/taskActions"
import { toast } from "../lib/toast"
import { Button, PrChip, StatusBadge, TimeAgo, cx } from "./ui"
import { ArtifactLink, PREVIEW_GROUP } from "./FileLink"
import { badgeStatus } from "../lib/prState"
import { ContextMeter, ContextMiniBar, contextPct } from "./ContextMeter"
import type { Artifact, PreviewLink, Project, Schedule, Task } from "../../../shared/types"
import { confirmDialog } from "../lib/confirm"

/** Above this much context used, a "Compact" nudge shows next to the status. */
const COMPACT_NUDGE_PCT = 60

/** A boolean saved in localStorage, so a toggle keeps its state across tasks and reloads. */
export function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) === "1")
  return [
    value,
    (v: boolean) => {
      setValue(v)
      if (v) localStorage.setItem(key, "1")
      else localStorage.removeItem(key)
    },
  ]
}

export function TaskHeader({
  task,
  project,
  schedule,
  files,
  showTools,
  onShowTools,
}: {
  task: Task
  project: Project | undefined
  schedule: Schedule | null | undefined
  files: Artifact[]
  showTools: boolean
  onShowTools: (v: boolean) => void
}) {
  const stop = useStopTask()
  const close = useCloseTask()
  const retry = useRetryTask()
  const compact = useCompactTask()
  const primary = primaryAction(task.status)
  const pct = contextPct(task.contextTokens, task.contextWindow)
  const canCompact = task.turnCount > 0 && task.status !== "failed"
  const backHref = project ? `/projects/${project.id}` : "/"

  return (
    <header className="mb-4 space-y-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h1 className="line-clamp-2 min-w-0 text-lg leading-snug font-semibold tracking-tight break-words text-zinc-50 sm:line-clamp-none sm:truncate" title={task.title}>
            {task.title}
          </h1>
          <StatusBadge status={badgeStatus(task)} />
          <ContextMiniBar tokens={task.contextTokens} window={task.contextWindow} className="hidden sm:block" />
        </div>
        <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
          {primary === "stop" && (
            <Button size="sm" variant="subtle" aria-label="Stop" onClick={() => stop.mutate(task.id)}>
              <CircleStop className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Stop</span>
            </Button>
          )}
          {primary === "done" && (
            <Button size="sm" variant="subtle" aria-label="Mark done" onClick={() => close.mutate(task.id)}>
              <CheckCircle2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Mark done</span>
            </Button>
          )}
          {primary === "retry" && (
            <Button size="sm" variant="subtle" aria-label="Retry" onClick={() => retry.mutate(task.id)}>
              <RefreshCcw className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Retry</span>
            </Button>
          )}
          <TaskMenu task={task} project={project} schedule={schedule} primary={primary} showTools={showTools} onShowTools={onShowTools} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <Link href={backHref} className="inline-flex min-h-11 max-w-48 items-center gap-1 rounded-lg pr-2 hover:text-zinc-300 sm:min-h-0">
          <ArrowLeft className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{project?.name ?? "Back"}</span>
        </Link>
        <span>
          Active <TimeAgo ts={task.updatedAt} />
        </span>
        {task.pendingCount > 0 && <span>{task.pendingCount} queued msg</span>}
        <PrChip task={task} />
        {task.previews.map((p) => (
          <PreviewChip key={p.port} preview={p} />
        ))}
        {files.length > 0 && (
          <span className="contents" {...PREVIEW_GROUP}>
            {files.map((a) => (
              <ArtifactLink key={a.id} artifact={a} className="inline-flex min-h-11 max-w-60 items-center gap-1 rounded-lg pr-2 text-yard-400 hover:underline sm:min-h-0">
                <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{a.title}</span>
              </ArtifactLink>
            ))}
          </span>
        )}
        {task.compacting || task.compactPending ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> {task.compacting ? "Compacting…" : "Compact queued"}
          </span>
        ) : (
          pct !== null &&
          pct >= COMPACT_NUDGE_PCT &&
          canCompact && (
            <button
              type="button"
              onClick={() => compact.mutate(task.id)}
              title="Summarise the conversation to free up context"
              className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-amber-300 hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none sm:min-h-0 sm:px-1"
            >
              <Minimize2 className="h-3 w-3" /> {pct}% context · Compact
            </button>
          )
        )}
      </div>
    </header>
  )
}

/** A preview the agent registered (report_preview) or Cody opened: opens in a new tab. */
function PreviewChip({ preview }: { preview: PreviewLink }) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer"
      title={preview.label}
      className="inline-flex min-h-11 items-center gap-1 rounded-md border border-sky-900/60 bg-sky-500/10 px-2 py-1 font-medium text-sky-300 transition hover:bg-sky-500/20 sm:min-h-0 sm:px-1.5 sm:py-0.5"
    >
      <Globe className="h-3 w-3" /> Preview :{preview.port} <ExternalLink className="h-3 w-3 opacity-70" />
    </a>
  )
}

/** Closes on Escape (focus goes back to the trigger) and on a click outside. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])
  return { open, setOpen, root, trigger }
}

const itemBase = "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:outline-none sm:min-h-0 sm:py-1.5"
const item = cx(itemBase, "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus-visible:bg-zinc-800")

function TaskMenu({
  task,
  project,
  schedule,
  primary,
  showTools,
  onShowTools,
}: {
  task: Task
  project: Project | undefined
  schedule: Schedule | null | undefined
  primary: PrimaryAction
  showTools: boolean
  onShowTools: (v: boolean) => void
}) {
  const { open, setOpen, root, trigger } = usePopover()
  const panel = useRef<HTMLDivElement>(null)
  const [, navigate] = useLocation()
  const [portOpen, setPortOpen] = useState(false)
  const close = useCloseTask()
  const compact = useCompactTask()
  const del = useDeleteTask()

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("button, a, input")?.focus()
    else setPortOpen(false)
  }, [open])

  return (
    <div ref={root} className="relative">
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        className="px-1.5"
        aria-label="Task details and more actions"
        title="Details and more actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Task details and actions"
          className="absolute top-full right-0 z-30 mt-1 w-[calc(100vw-2rem)] max-w-80 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 text-sm shadow-2xl"
        >
          <div className="space-y-1.5 px-2 pt-1.5 pb-2 text-xs text-zinc-400">
            {task.branch && (
              <Detail icon={<GitBranch className="h-3.5 w-3.5" />} label="Branch">
                <span className="min-w-0 flex-1 truncate font-mono" title={task.branch}>
                  {task.branch}
                </span>
                <CopyButton text={task.branch} label="Copy branch name" />
              </Detail>
            )}
            <Detail icon={<Box className="h-3.5 w-3.5" />} label="Box">
              {task.boxId ? (
                <Link href={`/boxes#${encodeURIComponent(task.boxId)}`} className="truncate text-zinc-300 hover:underline" onClick={() => setOpen(false)}>
                  {task.boxId}
                </Link>
              ) : (
                <span>{task.lastArchivedAt ? "archived" : "no box yet"}</span>
              )}
            </Detail>
            <Detail icon={<Hash className="h-3.5 w-3.5" />} label="Turns">
              <span>
                {task.turnCount} turn{task.turnCount === 1 ? "" : "s"}
                {task.effort ? ` · ${task.effort} effort` : ""}
              </span>
            </Detail>
            {task.scheduleId && (
              <Detail icon={<AlarmClock className="h-3.5 w-3.5" />} label="Schedule">
                <Link href="/schedules" className="truncate text-yard-400 hover:underline" onClick={() => setOpen(false)}>
                  {schedule ? schedule.name : "a deleted schedule"}
                </Link>
              </Detail>
            )}
            <ContextMeter
              className="pt-1"
              tokens={task.contextTokens}
              window={task.contextWindow}
              compacting={task.compacting}
              queued={task.compactPending}
              canCompact={task.turnCount > 0 && task.status !== "failed"}
              onCompact={() => compact.mutate(task.id)}
            />
          </div>

          <div className="border-t border-zinc-800/80 pt-1.5">
            <button type="button" role="switch" aria-checked={showTools} className={item} onClick={() => onShowTools(!showTools)}>
              <Wrench className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1">Show tool calls</span>
              <span className={cx("relative h-4 w-7 rounded-full transition", showTools ? "bg-yard-500" : "bg-zinc-700")} aria-hidden>
                <span className={cx("absolute top-0.5 h-3 w-3 rounded-full bg-zinc-950 transition-all", showTools ? "left-3.5" : "left-0.5")} />
              </span>
            </button>
            {portOpen ? (
              <OpenPortForm taskId={task.id} onDone={() => setOpen(false)} />
            ) : (
              <button type="button" className={item} onClick={() => setPortOpen(true)}>
                <Plug className="h-3.5 w-3.5 text-zinc-500" /> Open a port…
              </button>
            )}
            {primary !== "done" && task.status !== "done" && (
              <button
                type="button"
                className={item}
                onClick={() => {
                  close.mutate(task.id)
                  setOpen(false)
                }}
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-zinc-500" /> Mark done
              </button>
            )}
          </div>

          <div className="mt-1.5 border-t border-zinc-800/80 pt-1.5">
            <button
              type="button"
              className={cx(itemBase, "text-red-300 hover:bg-red-500/10 hover:text-red-200 focus-visible:bg-red-500/10")}
              onClick={async () => {
                setOpen(false)
                if (!(await confirmDialog({ title: "Delete task?", body: "Delete this task, its workspace and its archive?", confirmLabel: "Delete task", danger: true }))) return
                del.mutate(task.id)
                navigate(project ? `/projects/${project.id}` : "/")
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete task…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={label}>
      <span className="shrink-0 text-zinc-500" aria-label={label}>
        {icon}
      </span>
      {children}
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none sm:h-7 sm:w-7"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Couldn't copy", "The browser blocked clipboard access.")
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/** Get a public URL for any port in the task's box and open it. */
function OpenPortForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [port, setPort] = useState("")
  return (
    <form
      className="flex flex-col gap-2 px-2 py-1 sm:flex-row sm:items-center sm:gap-1"
      onSubmit={async (e) => {
        e.preventDefault()
        const n = Number(port)
        if (!n) return
        try {
          const link = await api<{ url: string }>(`/api/tasks/${taskId}/preview`, { body: { port: n } })
          window.open(link.url, "_blank")
          onDone()
        } catch (err) {
          toast.error("Couldn't open a preview", (err as Error).message)
        }
      }}
    >
      <Plug className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <input
        autoFocus
        inputMode="numeric"
        aria-label="Port"
        value={port}
        onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
        placeholder="port, e.g. 3000"
        className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-base text-zinc-100 sm:min-h-0 sm:py-1 sm:text-xs"
      />
      <Button size="sm" variant="subtle" type="submit" disabled={!port}>
        <Globe className="h-3.5 w-3.5" /> Open
      </Button>
    </form>
  )
}
