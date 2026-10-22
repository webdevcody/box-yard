// Tab bucketing for the Yard view (every task across projects). Pure, so it is unit tested.
import type { Task, TaskStatus } from "../../../shared/types"
import { matchesQuery, sortTasks, type TaskSort } from "./projectTasks"

export const YARD_TABS = [
  { key: "active", label: "Active" },
  { key: "needs_you", label: "Needs you" },
  { key: "recent", label: "Recent" },
  { key: "all", label: "All" },
] as const

export type YardTab = (typeof YARD_TABS)[number]["key"]
export const DEFAULT_YARD_TAB: YardTab = "active"

/** Finished tasks count as recent for this long. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Live work. `waiting` (on another agent) is mid-task, so it counts as active too. */
export const ACTIVE_STATUSES: TaskStatus[] = ["working", "starting", "waiting", "queued"]
export const NEEDS_YOU_STATUSES: TaskStatus[] = ["needs_input", "pr_ready", "failed"]
/** A turn ended and nothing is running. `updatedAt` is when that happened. */
export const FINISHED_STATUSES: TaskStatus[] = ["done", "idle", "pr_ready", "failed"]

export function parseYardTab(value: string | null): YardTab {
  return YARD_TABS.find((t) => t.key === value)?.key ?? DEFAULT_YARD_TAB
}

export const isFinished = (task: Task) => FINISHED_STATUSES.includes(task.status)

/** Finished within the recent window (or ever, with `older`). */
export function isRecent(task: Task, now: number, older = false): boolean {
  return isFinished(task) && (older || now - task.updatedAt <= RECENT_WINDOW_MS)
}

export function inYardTab(task: Task, tab: YardTab, now: number, older = false): boolean {
  switch (tab) {
    case "active":
      return ACTIVE_STATUSES.includes(task.status)
    case "needs_you":
      return NEEDS_YOU_STATUSES.includes(task.status)
    case "recent":
      return isRecent(task, now, older)
    case "all":
      return true
  }
}

/** Tab badge counts. Recent counts only the last 24h, whatever "show older" says. */
export function yardCounts(tasks: Task[], now: number): Record<YardTab, number> {
  return Object.fromEntries(YARD_TABS.map((t) => [t.key, tasks.filter((x) => inYardTab(x, t.key, now)).length])) as Record<YardTab, number>
}

/** Finished tasks that fell out of the recent window: what "show older" would add. */
export function olderFinishedCount(tasks: Task[], now: number): number {
  return tasks.filter((t) => isFinished(t) && !isRecent(t, now)).length
}

const newestFirst = (a: Task, b: Task) => b.updatedAt - a.updatedAt

/** The last few finished tasks, newest first, for the strip on top of the Active tab. */
export function recentlyFinished(tasks: Task[], limit = 5): Task[] {
  return tasks.filter(isFinished).sort(newestFirst).slice(0, limit)
}

export interface YardOptions {
  tab: YardTab
  now: number
  /** Recent tab: include finished tasks older than 24h. */
  older?: boolean
  /** All tab: search words, matched against title, summary and the project name. */
  query?: string
  /** All tab: order, as in the project Tasks tab. */
  sort?: TaskSort
  projectName?: (projectId: string) => string | undefined
}

/**
 * The tasks a tab shows, in order. Active and Recent are by last activity, Needs you
 * puts questions before failures before PRs, and All is searchable and sortable.
 */
export function yardTasks(tasks: Task[], opts: YardOptions): Task[] {
  const list = tasks.filter((t) => inYardTab(t, opts.tab, opts.now, opts.older))
  if (opts.tab === "needs_you") return sortTasks(list, "attention")
  if (opts.tab !== "all") return list.sort(newestFirst)
  const query = opts.query ?? ""
  return sortTasks(
    list.filter((t) => matchesQuery(t, query, opts.projectName?.(t.projectId))),
    opts.sort ?? "attention",
  )
}
