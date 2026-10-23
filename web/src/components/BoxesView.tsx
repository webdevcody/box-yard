import { useEffect, useState } from "react"
import { Link } from "wouter"
import { AlertTriangle, Boxes, ChevronRight, ExternalLink, Globe, HardDrive, Info, Settings, Sparkles, X } from "lucide-react"
import { useAgentSettings, useBoxes, useCleanBox, useHealth, useProjects, useTasks } from "../lib/queries"
import { CAPACITY_NOTICE_KEY, capacityNotice, capacityNoticeText, showCapacityNotice } from "../lib/capacity"
import { useHash, useScrollToHash } from "../lib/hash"
import { shortDuration, splitBoxTasks } from "../lib/boxTasks"
import { bytes, hours, money } from "../lib/usage"
import { cleanupLine, diskMeter } from "../lib/diskCleanup"
import { formatBytes } from "../../../shared/disk"
import { Button, Empty, PrChip, StatusBadge, cx, timeAgo } from "./ui"
import { badgeStatus } from "../lib/prState"
import { useOpenSettings } from "./SettingsDialog"
import { agentCapacity, type BoxCleanup, type BoxInfo, type Task } from "../../../shared/types"

const RUNNING: Task["status"][] = ["working", "starting"]

const BOX_STATUS: Record<BoxInfo["status"], { label: string; chip: string }> = {
  creating: { label: "Starting", chip: "bg-sky-500/10 text-sky-300" },
  ready: { label: "Running", chip: "bg-emerald-500/10 text-emerald-300" },
  lost: { label: "Error", chip: "bg-red-500/10 text-red-300" },
  deleting: { label: "Deleting", chip: "bg-zinc-800 text-zinc-300" },
}

function Stat({ label, value, max }: { label: string; value: number; max: number }) {
  const over = value > max
  return (
    <div className={cx("rounded-xl border bg-zinc-900/40 px-4 py-2.5", over ? "border-amber-500/40" : "border-zinc-800/80")}>
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</span>
        <span className="text-lg font-semibold text-zinc-50 tabular-nums">
          {value}
          <span className="text-zinc-500"> / {max}</span>
        </span>
        <Meter used={value} total={max} className="ml-auto w-24" />
      </div>
      {over && <div className="mt-1 text-xs font-medium text-amber-300">Over limit: running work continues, nothing new is placed until usage drops.</div>}
    </div>
  )
}

/** A thin bar; segmented when there are few enough slots to count at a glance. */
function Meter({ used, total, className, warn, label }: { used: number; total: number; className?: string; warn?: boolean; label?: string }) {
  const cells = Math.max(total, used)
  if (warn !== undefined)
    return (
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} className={cx("h-1.5 overflow-hidden rounded-sm bg-zinc-700", className)}>
        <div className={cx("h-full", warn ? "bg-amber-400" : "bg-yard-500")} style={{ width: `${total ? Math.min(100, (used / total) * 100) : 0}%` }} />
      </div>
    )
  if (cells > 0 && cells <= 6)
    return (
      <div className={cx("flex gap-0.5", className)}>
        {Array.from({ length: cells }, (_, i) => (
          <div key={i} className={cx("h-1.5 flex-1 rounded-sm", i < used ? (i < total ? "bg-yard-500" : "bg-amber-400") : "bg-zinc-700")} />
        ))}
      </div>
    )
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-sm bg-zinc-700", className)}>
      <div className={cx("h-full", used > total ? "bg-amber-400" : "bg-yard-500")} style={{ width: `${total ? Math.min(100, (used / total) * 100) : 0}%` }} />
    </div>
  )
}

export function BoxesView() {
  const boxes = useBoxes()
  const tasks = useTasks()
  const projects = useProjects()
  const health = useHealth()
  useScrollToHash(Boolean(boxes.data), "box-")
  const hash = useHash()
  const openSettings = useOpenSettings()

  const pool = health.data?.pool
  const list = boxes.data ?? []
  const all = tasks.data ?? []
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id
  const running = all.filter((t) => t.boxId && RUNNING.includes(t.status)).length
  const queued = all.filter((t) => t.status === "queued").sort((a, b) => a.updatedAt - b.updatedAt)

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Boxes</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Worker boxes on {health.data?.provider ?? "…"} and the agents running on them.
          </p>
        </div>
        <button onClick={() => openSettings("limits")} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg text-sm text-sky-400 hover:underline sm:min-h-0">
          <Settings className="h-3.5 w-3.5" /> Edit limits
        </button>
      </header>

      <CapacityNotice onEdit={() => openSettings("limits")} />

      {pool && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat label="Boxes" value={list.length} max={pool.maxBoxes} />
          <Stat label="Agents running" value={running} max={agentCapacity(pool)} />
        </div>
      )}

      {boxes.isLoading ? null : list.length === 0 ? (
        <Empty icon={<Boxes className="h-8 w-8" />} title="No boxes yet">
          Boxes are created when a task needs one.
        </Empty>
      ) : (
        <div className="space-y-3">
          {list.map((box) => (
            <BoxCard key={box.id} box={box} highlighted={hash === box.id} tasks={all.filter((t) => t.boxId === box.id)} projectName={projectName} />
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Waiting for a slot <span className="text-zinc-600">{queued.length}</span>
        </h2>
        {queued.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing is waiting. Every task has a slot.</p>
        ) : (
          <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/80 bg-zinc-900/40">
            {queued.map((t) => (
              <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} note={t.waitReason} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(CAPACITY_NOTICE_KEY)
  } catch {
    return null
  }
}

/** One-time notice when per-box capacity is below the old defaults (2 agents, 12 resident folders). */
function CapacityNotice({ onEdit }: { onEdit: () => void }) {
  const settings = useAgentSettings()
  const [dismissed, setDismissed] = useState(readDismissed)
  const notice = settings.data ? capacityNotice(settings.data.settings) : null
  if (!showCapacityNotice(notice, dismissed)) return null
  const dismiss = () => {
    try {
      localStorage.setItem(CAPACITY_NOTICE_KEY, notice.key)
    } catch {}
    setDismissed(notice.key)
  }
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-100" data-testid="capacity-notice">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Each {notice.workerSize} box now {capacityNoticeText(notice)}.
        </div>
        <div className="mt-1 text-sky-200/70">
          Pool limits now default by worker size, so fewer agents share a box and older workspaces are parked sooner. Add boxes, pick a larger size or raise the limits if you
          want the old capacity back.{" "}
          <button onClick={onEdit} className="text-sky-300 underline-offset-2 hover:underline">
            Edit limits
          </button>
        </div>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" title="Dismiss" className="-m-1 h-7 w-7 shrink-0 rounded-md p-1 text-sky-300 hover:bg-sky-500/20">
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}

function TaskRow({ task, projectName, muted, note }: { task: Task; projectName: string; muted?: boolean; note?: string | null }) {
  return (
    <Link href={`/tasks/${task.id}`} className="group flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
      <div className="min-w-0 flex-1">
        <div className="sm:flex sm:items-baseline sm:gap-3">
          <div className={cx("truncate", muted ? "text-zinc-400" : "text-zinc-100")} title={task.title}>
            {task.title}
          </div>
          <div className="shrink-0 truncate text-xs text-zinc-500">{projectName}</div>
        </div>
        {note && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-300/90" data-testid="wait-reason">
            <HardDrive className="h-3 w-3 shrink-0" />
            <span className="truncate">{note}</span>
          </div>
        )}
      </div>
      <PrChip task={task} variant="link" className="hidden text-xs sm:inline-flex" />
      <StatusBadge status={badgeStatus(task)} />
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
    </Link>
  )
}

function BoxTimes({ createdAt, lastUsedAt }: { createdAt: number; lastUsedAt: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="whitespace-nowrap text-xs text-zinc-500">
      <span title={`Up since ${new Date(createdAt).toLocaleString()}`}>up {shortDuration(Date.now() - createdAt)}</span>
      {" · "}
      <span title={`Last active ${new Date(lastUsedAt).toLocaleString()}`}>active {timeAgo(lastUsedAt)}</span>
    </span>
  )
}

function BoxCard({ box, tasks, projectName, highlighted }: { box: BoxInfo; tasks: Task[]; projectName: (id: string) => string; highlighted: boolean }) {
  const st = BOX_STATUS[box.status]
  const [showFinished, setShowFinished] = useState(false)
  const { active, finished } = splitBoxTasks(tasks)
  const previews = tasks.flatMap((t) => t.previews.map((p) => ({ ...p, taskTitle: t.title })))
  const over = box.runningTurns > box.slots
  return (
    <div
      id={`box-${box.id}`}
      className={cx(
        "scroll-mt-6 rounded-xl border bg-zinc-900/40 p-4 transition",
        highlighted ? "border-yard-500/60 ring-2 ring-yard-500/20" : "border-zinc-800/80",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="truncate font-mono text-sm font-medium text-zinc-100" title={box.id}>
            {box.id}
          </span>
          <span className="text-xs text-zinc-500">{box.provider}</span>
          <span className="text-xs text-zinc-500">{box.size}</span>
          <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", st.chip)}>{st.label}</span>
          <span className="flex items-center gap-2 text-xs whitespace-nowrap">
            <span className={over ? "font-medium text-amber-300" : "text-zinc-300"}>
              {box.runningTurns}/{box.slots} agents busy
            </span>
            <Meter used={box.runningTurns} total={box.slots} className="w-16" />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:ml-auto">
          {box.projects.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {box.projects.map((p) => (
                <span key={p} className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-xs text-zinc-300">
                  {p}
                </span>
              ))}
            </div>
          )}
          <BoxTimes createdAt={box.createdAt} lastUsedAt={box.lastUsedAt} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-zinc-800/70 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-500">
        <span title="Estimated active CPU time tracked by Box Yard">
          active {hours(box.activeMs)}
        </span>
        <DiskUse box={box} />
        <span title={box.usageSource === "actual" ? "Provider usage data was available." : "Estimated from Box Yard runtime and disk probes."}>
          {money(box.estimatedCostUsd)} {box.usageSource}
        </span>
        {box.keepAlive && <span className="text-yard-300">keep-alive</span>}
        {box.status === "ready" && <CleanUpButton box={box} />}
      </div>

      {box.diskLow && box.status === "ready" && (
        <div role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span>Low on disk. New tasks go to other boxes while it cleans up; they wait here only when no other box has room.</span>
        </div>
      )}
      {box.cleanup && <CleanupReport cleanup={box.cleanup} />}

      <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800/80">
        {active.length === 0 ? (
          <div className="px-3 py-2 text-xs text-zinc-500">No agents running</div>
        ) : (
          <div className="divide-y divide-zinc-800/80">
            {active.map((t) => (
              <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} />
            ))}
          </div>
        )}
        {finished.length > 0 && (
          <>
            <button
              onClick={() => setShowFinished((v) => !v)}
              aria-expanded={showFinished}
            className="flex min-h-11 w-full items-center gap-1.5 border-t border-zinc-800/80 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 sm:min-h-0 sm:py-1.5"
            >
              <ChevronRight className={cx("h-3.5 w-3.5 transition", showFinished && "rotate-90")} />
              {finished.length} finished
            </button>
            {showFinished && (
              <div className="divide-y divide-zinc-800/80 border-t border-zinc-800/80">
                {finished.map((t) => (
                  <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} muted />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {previews.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {previews.map((p) => (
            <a
              key={`${p.port}-${p.url}`}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              title={p.taskTitle}
              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-sky-400 hover:border-sky-500/40 hover:text-sky-300 sm:min-h-0"
            >
              <Globe className="h-3.5 w-3.5" /> {p.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** Free and total space on the box's work disk, from its last df. */
function DiskUse({ box }: { box: BoxInfo }) {
  const disk = diskMeter(box)
  if (!disk)
    return (
      <span title="Current disk use, including task folders and local snapshots when visible">
        disk {bytes(box.diskBytes)}
      </span>
    )
  const checked = box.diskCheckedAt ? ` Checked ${timeAgo(box.diskCheckedAt)}.` : ""
  return (
    <span className={cx("flex items-center gap-2 whitespace-nowrap", disk.low && "font-medium text-amber-300")} title={`${formatBytes(disk.used)} used.${checked}`} data-testid="disk-use">
      <HardDrive className="h-3.5 w-3.5" />
      {disk.label}
      <Meter used={disk.used} total={disk.total} warn={disk.low} label="Disk used" className="w-16" />
    </span>
  )
}

function CleanUpButton({ box }: { box: BoxInfo }) {
  const clean = useCleanBox()
  const running = box.cleanup?.status === "running"
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={running || clean.isPending}
      onClick={() => clean.mutate(box.id)}
      className="-my-1 ml-auto"
      title="Free disk in safe steps: partial clones, caches, ignored build output of resting tasks, git gc. Done workspaces are parked only if the box is still low. Uncommitted work is never touched."
    >
      {!running && !clean.isPending && <Sparkles className="h-3.5 w-3.5" />}
      {running ? "Cleaning up…" : "Clean up now"}
    </Button>
  )
}

/** The running cleanup, or the last one, with what each step freed. */
function CleanupReport({ cleanup }: { cleanup: BoxCleanup }) {
  const [open, setOpen] = useState(false)
  const ran = cleanup.steps.filter((s) => s.freedBytes > 0 || s.removed.length > 0 || (s.skipped && s.skipped !== "enough room already"))
  const when = cleanup.status === "running" ? null : timeAgo(cleanup.finishedAt ?? cleanup.startedAt)
  const tone = cleanup.status === "failed" || (cleanup.status === "done" && cleanup.targetFreeBytes !== null && !cleanup.enough) ? "text-amber-300" : cleanup.status === "running" ? "text-sky-300" : "text-zinc-400"
  return (
    <div className="mt-2 rounded-lg border border-zinc-800/70 bg-zinc-950/30 text-xs" data-testid="cleanup-report">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!ran.length}
        className="flex min-h-11 w-full items-center gap-1.5 px-3 py-2 text-left disabled:cursor-default sm:min-h-0"
      >
        {ran.length > 0 ? <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 text-zinc-500 transition", open && "rotate-90")} /> : <Sparkles className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
        <span className={cx("min-w-0 flex-1", tone)}>{cleanupLine(cleanup)}</span>
        {when && <span className="shrink-0 text-zinc-600">{when}</span>}
      </button>
      {open && ran.length > 0 && (
        <ol className="space-y-1 border-t border-zinc-800/70 px-3 py-2">
          {ran.map((s) => (
            <li key={s.key} className="flex gap-3">
              <span className="w-16 shrink-0 text-right text-zinc-300 tabular-nums">{formatBytes(s.freedBytes)}</span>
              <span className="min-w-0 flex-1 text-zinc-400">
                {s.label}
                {s.skipped && <span className="text-zinc-600"> · {s.skipped}</span>}
                {s.removed.length > 0 && <span className="block truncate text-zinc-600" title={s.removed.join("\n")}>{s.removed.join(", ")}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
