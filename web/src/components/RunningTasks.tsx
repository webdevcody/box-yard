// The Zen header's running-tasks badge: a number beside the Coordinator's robot counting the tasks that are
// queued, starting or working (lib/runningTasks). A tap opens all of them in a scrolling dropdown: the title (to
// the task's page), its project, status, where it runs, how long it has run, and its PR.
import { memo, useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from "react"
import { useProjects, useRunningCount, useTasks } from "../lib/queries"
import { compareRunning, countLabel, isRunning, runningSince } from "../lib/runningTasks"
import { badgeStatus } from "../lib/prState"
import { placementView } from "../../../shared/placement"
import type { Task } from "../../../shared/types"
import { PLACE_ICON, placeTone, placementTitle } from "./PlacementChip"
import { usePopover } from "./TaskHeader"
import { useStableTasks } from "./TaskGrid"
import { ResortPill } from "./ResortPill"
import { AppLink, Elapsed, PrChip, StatusBadge, cx } from "./ui"

const NO_TASKS: Task[] = []

/**
 * The badge. It re-renders only when the count changes (useRunningCount). Its button is always a 44px tap target,
 * pulled in by -mx-3 so it takes only the circle's 20px of the row, 8px from the robot and the title; the circle
 * grows inside it ("99+"), so a count going 0 → 1 or 9 → 10 never moves the title. Dimmed at 0.
 */
export const RunningTasksBadge = memo(function RunningTasksBadge() {
  const count = useRunningCount().data ?? 0
  const { open, setOpen, root, trigger } = usePopover()
  const label = `${count} running task${count === 1 ? "" : "s"}`
  return (
    <div ref={root} className="flex shrink-0">
      <button
        ref={trigger}
        type="button"
        data-testid="running-badge"
        data-count={count}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: show them`}
        title={`${label} (queued, starting or working)`}
        onClick={() => setOpen(!open)}
        className="group -mx-3 grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-none"
      >
        <span
          className={cx(
            "h-5 min-w-5 rounded-full px-1 text-center text-[11px] leading-5 font-semibold tabular-nums ring-1 transition-colors ring-inset group-focus-visible:ring-2 group-focus-visible:ring-yard-500",
            count ? "bg-yard-400/15 text-yard-400 ring-yard-400/50 group-hover:bg-yard-400/25" : "text-zinc-600 ring-zinc-800 group-hover:text-zinc-400",
            open && "ring-2",
          )}
        >
          {countLabel(count)}
        </span>
      </button>
      {open && <RunningList trigger={trigger} />}
    </div>
  )
})

const PANEL_MAX_W = 416
const PANEL_MAX_H = 384

/**
 * The dropdown. Fixed, so Zen's header (overflow-hidden for its scrollbar gutter) doesn't clip it; it stays inside
 * usePopover's root, so Esc and a press outside close it. Rows hold their order while updates stream in
 * (useStableTasks): a task that stops dims in place, and new ones wait behind the "↑ new" pill.
 */
function RunningList({ trigger }: { trigger: RefObject<HTMLButtonElement | null> }) {
  const tasks = useTasks()
  const projects = useProjects()
  const stable = useStableTasks(tasks.data ?? NO_TASKS, { compare: compareRunning, include: isRunning, resetKey: null })
  const names = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])
  const running = (tasks.data ?? NO_TASKS).filter(isRunning).length
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  useLayoutEffect(() => {
    const place = () => {
      const t = trigger.current?.getBoundingClientRect()
      if (!t) return
      const vw = document.documentElement.clientWidth || window.innerWidth
      const width = Math.min(PANEL_MAX_W, vw - 16)
      setStyle({ left: Math.max(8, Math.min(t.left, vw - 8 - width)), top: t.bottom + 4, width, maxHeight: Math.max(160, Math.min(PANEL_MAX_H, window.innerHeight - t.bottom - 16)) })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [trigger])
  return (
    <div
      role="dialog"
      aria-label="Running tasks"
      data-testid="running-list"
      style={style}
      className="@container fixed z-30 flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-xs shadow-2xl"
    >
      <div className="flex items-baseline gap-2 border-b border-zinc-900 px-3 py-2">
        <span className="font-medium text-zinc-200 tabular-nums">{running} running</span>
        <span className="min-w-0 truncate text-zinc-500">queued, starting or working</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={stable.listRef}>
          <ResortPill newCount={stable.newCount} changedCount={stable.changedCount} onResort={stable.resort} className="top-5" />
          {stable.entries.length === 0 ? (
            <p className="px-3 py-4 text-center text-zinc-500">{tasks.isLoading ? "Loading…" : "No tasks running."}</p>
          ) : (
            <ul className="divide-y divide-zinc-900">
              {stable.entries.map(({ item: t, stale }) => (
                <RunningRow key={t.id} task={t} project={names.get(t.projectId)} stale={stale} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/** The title gets the whole row; status, project, place, time and PR wrap on the line below. */
const RunningRow = memo(function RunningRow({ task, project, stale }: { task: Task; project: string | undefined; stale: boolean }) {
  const v = placementView(task)
  const Icon = PLACE_ICON[v.kind]
  return (
    <li data-stable-key={task.id} data-testid="running-row" className={cx("px-3 py-2 transition-opacity", stale && "opacity-50")}>
      <AppLink href={`/tasks/${task.id}`} className="block truncate text-sm font-medium text-zinc-100 hover:text-yard-400 hover:underline">
        {task.title}
      </AppLink>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-zinc-500">
        <StatusBadge status={badgeStatus(task)} />
        {project && <span className="max-w-[12rem] min-w-0 truncate text-zinc-400">{project}</span>}
        <span role="img" aria-label={`Runs on: ${v.label}`} title={placementTitle(v)} className={cx("inline-flex min-w-0 items-center gap-1", placeTone(v))}>
          <Icon className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate @max-xs:hidden">{v.short}</span>
        </span>
        <Elapsed since={runningSince(task)} title={task.turnStartedAt ? "This turn started" : "In this state since"} className="tabular-nums" />
        <PrChip task={task} className="text-[11px]" />
      </div>
    </li>
  )
})
