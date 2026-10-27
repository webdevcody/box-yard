// The task page header, three calm rows: the breadcrumb, the title with the actions that matter right now
// (Merge PR, Stop / Mark done / Retry, ⋯), and one meta row (status · PR · files · previews · context).
// Everything else (model and route, times, box, branch, id, full context numbers) is in the ⋯ details popover.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation } from "wouter"
import {
  ChevronRight,
  Check,
  CheckCircle2,
  CircleStop,
  Copy,
  ExternalLink,
  Globe,
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
import { Button, META_CHIP, NewTabLink, StatusDot, TimeAgo, cx, timeAgo } from "./ui"
import { FilesChip } from "./TaskFiles"
import { MergePrButton, MergePrChip, MergePrMenuItem } from "./MergePr"
import { badgeStatus } from "../lib/prState"
import { pushStateLine } from "../lib/pushState"
import { CONTEXT_WARN_PCT, ContextMeter, ContextMiniBar, contextPct } from "./ContextMeter"
import type { Artifact, PreviewLink, Project, Schedule, Task } from "../../../shared/types"
import { RUNNER_LABEL, isLocalRunnerBox } from "../../../shared/runner"
import { gpuBoxIndex, isGpuBox } from "../../../shared/runpod"
import { isDockerBox } from "../../../shared/docker"
import { confirmDialog } from "../lib/confirm"
import { copyIdOnClick, lastProjectTab, projectCrumbHref } from "../lib/breadcrumb"
import { QueuedLink } from "./QueuedMessages"
import { PlacementHeaderChip } from "./PlacementChip"

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
  const primary = primaryAction(task.status)

  return (
    <header className="mb-4 space-y-1">
      <Breadcrumb task={task} project={project} />
      <div className="flex items-start gap-2 sm:items-center">
        <h1 className="line-clamp-2 min-w-0 flex-1 text-lg leading-snug font-semibold tracking-tight wrap-anywhere text-zinc-50 max-sm:pt-1.5 sm:truncate" title={task.title}>
          {task.title}
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <MergePrButton task={task} placement="actions" />
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
      <TaskMetaRow task={task} project={project} files={files} />
    </header>
  )
}

/**
 * The one meta row, always in this order so nothing jumps as the task moves along: status · PR · files ·
 * previews, then where it runs and the context reading at the far right. Placement is right-aligned beside the
 * context, so its text changing (queued → placed → archived) never moves the chips, and chips appearing never move
 * it. On phones it is two lines at most: status, placement and context, then the chips, which scroll sideways
 * inside their line. Everything else (model, times, branch, id, full context numbers) is in the ⋯ details.
 */
export function TaskMetaRow({ task, project, files }: { task: Task; project: Project | undefined; files: Artifact[] }) {
  const hasChips = Boolean(task.prUrl) || files.length > 0 || task.previews.length > 0
  return (
    <div data-testid="task-meta" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
      <StatusDot status={badgeStatus(task)} title={`Active ${timeAgo(task.updatedAt)}`} className="min-h-7 sm:mr-1">
        {task.pendingCount > 0 && (
          <span className="font-normal text-zinc-500">
            · <QueuedLink taskId={task.id} count={task.pendingCount} />
          </span>
        )}
      </StatusDot>
      {hasChips && (
        <div data-testid="task-chips" className="flex items-center gap-2 max-sm:order-last max-sm:w-full max-sm:overflow-x-auto max-sm:[scrollbar-width:none] sm:contents">
          <MergePrChip task={task} className={META_CHIP} />
          <FilesChip taskId={task.id} projectId={task.projectId} files={files} />
          {task.previews.map((p) => (
            <PreviewChip key={p.port} preview={p} />
          ))}
        </div>
      )}
      <span className="ml-auto inline-flex min-w-0 items-center gap-2">
        <PlacementHeaderChip task={task} project={project} />
        <ContextSlot task={task} />
      </span>
    </div>
  )
}

/** The context bar and "58%"; from 75% it turns amber (red from 90%) and offers Compact right there. */
function ContextSlot({ task }: { task: Task }) {
  const compact = useCompactTask()
  const pct = contextPct(task.contextTokens, task.contextWindow)
  const canCompact = task.turnCount > 0 && task.status !== "failed"
  const busy = task.compacting || task.compactPending
  if (pct === null && !busy) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <ContextMiniBar tokens={task.contextTokens} window={task.contextWindow} hint="How much of this agent's context window is used. Compact from the ⋯ menu when it gets high." />
      {busy ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Loader2 className="h-3 w-3 animate-spin" /> {task.compacting ? "Compacting…" : "Compact queued"}
        </span>
      ) : (
        pct !== null &&
        pct >= CONTEXT_WARN_PCT &&
        canCompact && (
          <button
            type="button"
            onClick={() => compact.mutate(task.id)}
            title="Summarise the conversation to free up context"
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 whitespace-nowrap text-amber-300 hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none sm:min-h-0 sm:px-1"
          >
            <Minimize2 className="h-3 w-3" /> Compact
          </button>
        )
      )}
    </span>
  )
}

/** "box-yard › task_…" above the title: the project (on the tab used last) and the task id, which copies on click. */
function Breadcrumb({ task, project }: { task: Task; project: Project | undefined }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const crumb = "rounded focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-zinc-500">
      {project ? (
        <Link href={projectCrumbHref(project.id, lastProjectTab(project.id))} className={cx(crumb, "min-w-0 truncate py-1 hover:text-zinc-300 hover:underline sm:py-0")}>
          {project.name}
        </Link>
      ) : (
        <Link href="/" className={cx(crumb, "shrink-0 py-1 hover:text-zinc-300 hover:underline sm:py-0")}>
          Yard
        </Link>
      )}
      <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" aria-hidden />
      <span className="relative shrink-0">
        <Link
          href={`/tasks/${task.id}`}
          aria-current="page"
          title={`${task.title}\nClick to copy the id`}
          className={cx(crumb, "py-1 font-mono text-[11px] text-zinc-400 hover:text-zinc-200 sm:py-0")}
          onClick={async (e) => {
            // Plain clicks copy; Cmd/Ctrl and middle clicks keep the link and open the task in a new tab.
            const result = await copyIdOnClick(e, task.id)
            if (result === "copied") setCopied(true)
            else if (result === "failed") toast.error("Couldn't copy", "The browser blocked clipboard access.")
          }}
        >
          {task.id}
        </Link>
        {copied && (
          <span role="status" className="absolute top-full left-1/2 z-20 mt-1 -translate-x-1/2 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-zinc-200 shadow-lg">
            <Check className="mr-0.5 inline h-3 w-3 text-emerald-400" /> Copied
          </span>
        )}
      </span>
    </nav>
  )
}

/** A preview the agent registered (report_preview) or Cody opened: opens in a new tab. */
function PreviewChip({ preview }: { preview: PreviewLink }) {
  return (
    <NewTabLink
      href={preview.url}
      title={preview.label}
      className={cx(META_CHIP, "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100")}
    >
      <Globe className="h-3 w-3 text-sky-400" /> Preview :{preview.port} <ExternalLink className="h-3 w-3 opacity-60" />
    </NewTabLink>
  )
}

/** Closes on Escape (focus goes back to the trigger) and on a click outside. */
export function usePopover() {
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
      e.preventDefault()
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

export const menuItemBase = "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:outline-none sm:min-h-0 sm:py-1.5"
export const menuItem = cx(menuItemBase, "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus-visible:bg-zinc-800")

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
          className="absolute top-full right-0 z-30 mt-1 w-[calc(100vw-2rem)] max-w-96 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 text-sm shadow-2xl"
        >
          <div className="px-2 pt-1.5 pb-2.5 text-xs text-zinc-400">
            <p className="mb-2 text-sm leading-snug font-medium wrap-anywhere text-zinc-100">{task.title}</p>
            <dl className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
              <Detail label="Task">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{task.id}</span>
                <CopyButton text={task.id} label="Copy task id" />
              </Detail>
              {task.branch && (
                <Detail label="Branch">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300" title={task.branch}>
                    {task.branch}
                  </span>
                  <CopyButton text={task.branch} label="Copy branch name" />
                </Detail>
              )}
              <Detail label="Box">
                {isLocalRunnerBox(task.boxId) ? (
                  <span className="min-w-0 truncate text-amber-200">This computer (unsandboxed)</span>
                ) : isGpuBox(task.boxId) ? (
                  <span className="min-w-0 truncate text-zinc-300">Its project's RunPod GPU pod #{gpuBoxIndex(task.boxId)}</span>
                ) : isDockerBox(task.boxId) ? (
                  <span className="min-w-0 truncate text-zinc-300">Its project's Docker container</span>
                ) : task.boxId ? (
                  <Link href={`/boxes#${encodeURIComponent(task.boxId)}`} className="min-w-0 truncate text-zinc-300 hover:underline" onClick={() => setOpen(false)}>
                    {task.boxId}
                  </Link>
                ) : (
                  <span>{task.lastArchivedAt ? "archived" : "no box yet"}</span>
                )}
              </Detail>
              {task.runsOn && (
                <Detail label="Runs on">
                  <span className={cx("min-w-0 truncate", task.runsOn === "local" ? "text-amber-200" : "text-zinc-300")} data-testid="task-runs-on">
                    {RUNNER_LABEL[task.runsOn]} · this task only
                  </span>
                </Detail>
              )}
              {task.pushState && <PushDetail push={task.pushState} />}
              {(task.model || task.effort) && (
                <Detail label="Model">
                  <span className="min-w-0 truncate text-zinc-300">{[task.model, task.effort ? `${task.effort} effort` : ""].filter(Boolean).join(" · ")}</span>
                </Detail>
              )}
              {(task.routingRule || task.routingReason) && (
                <Detail label="Route" top>
                  <span className="min-w-0 py-0.5 leading-snug wrap-anywhere">
                    {task.routingRule && <span className="text-zinc-300">{task.routingRule}</span>}
                    {task.routingRule && task.routingReason && " · "}
                    {task.routingReason}
                  </span>
                </Detail>
              )}
              <Detail label="Active">
                <span className="text-zinc-300">
                  <TimeAgo ts={task.updatedAt} />
                </span>
                <span>
                  · {task.turnCount} turn{task.turnCount === 1 ? "" : "s"}
                </span>
              </Detail>
              <Detail label="Created">
                <span className="text-zinc-300">
                  <TimeAgo ts={task.createdAt} />
                </span>
              </Detail>
              {task.scheduleId && (
                <Detail label="Schedule">
                  <Link href="/schedules" className="min-w-0 truncate text-yard-400 hover:underline" onClick={() => setOpen(false)}>
                    {schedule ? schedule.name : "a deleted schedule"}
                  </Link>
                </Detail>
              )}
            </dl>
            <ContextMeter
              className="mt-2.5 border-t border-zinc-800/80 pt-2.5"
              tokens={task.contextTokens}
              window={task.contextWindow}
              compacting={task.compacting}
              queued={task.compactPending}
              canCompact={task.turnCount > 0 && task.status !== "failed"}
              onCompact={() => compact.mutate(task.id)}
            />
          </div>

          <div className="border-t border-zinc-800/80 pt-1.5">
            <button type="button" role="switch" aria-checked={showTools} className={menuItem} onClick={() => onShowTools(!showTools)}>
              <Wrench className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1">Show tool calls</span>
              <span className={cx("relative h-4 w-7 rounded-full transition", showTools ? "bg-yard-500" : "bg-zinc-700")} aria-hidden>
                <span className={cx("absolute top-0.5 h-3 w-3 rounded-full bg-zinc-950 transition-all", showTools ? "left-3.5" : "left-0.5")} />
              </span>
            </button>
            {portOpen ? (
              <OpenPortForm taskId={task.id} onDone={() => setOpen(false)} />
            ) : (
              <button type="button" className={menuItem} onClick={() => setPortOpen(true)}>
                <Plug className="h-3.5 w-3.5 text-zinc-500" /> Open a port…
              </button>
            )}
            <MergePrMenuItem task={task} onPicked={() => setOpen(false)} />
            {primary !== "done" && task.status !== "done" && (
              <button
                type="button"
                className={menuItem}
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
              className={cx(menuItemBase, "text-red-300 hover:bg-red-500/10 hover:text-red-200 focus-visible:bg-red-500/10")}
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

/** One label/value pair in the details grid; the value cell holds text plus an optional copy button. */
/** The last turn-end push: whether the task's code is on origin, so its box can go without losing it. */
function PushDetail({ push }: { push: NonNullable<Task["pushState"]> }) {
  const line = pushStateLine(push)
  return (
    <Detail label="Git" top>
      <span className="min-w-0 py-0.5 leading-snug wrap-anywhere" data-testid="push-state">
        <span className={line.tone === "ok" ? "text-zinc-300" : line.tone === "warn" ? "text-amber-300" : undefined}>{line.text}</span> · <TimeAgo ts={push.at} />
      </span>
    </Detail>
  )
}

function Detail({ label, top, children }: { label: string; top?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={cx("text-zinc-500", top && "self-start py-0.5")}>{label}</dt>
      <dd className="flex min-h-6 min-w-0 items-center gap-1">{children}</dd>
    </>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none sm:h-6 sm:w-6"
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
          window.open(link.url, "_blank", "noopener")
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
