// Tab bucketing for the Yard view (every task across projects). Pure, so it is unit tested.
import type { Task, TaskStatus } from "../../../shared/types"
import { INBOX_STATUSES } from "./inbox"
import { compareTasks, matchesQuery, type TaskSort } from "./projectTasks"
import { isQuietRun } from "../../../shared/quiet"

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
/** Same as the Inbox: questions, pull requests and failures. */
export const NEEDS_YOU_STATUSES = INBOX_STATUSES
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

/** Quiet schedule runs (shared/quiet.ts) stay out of every tab unless `showQuiet` is on. */
export const shownInYard = (task: Task, showQuiet = false) => showQuiet || !isQuietRun(task)

/** Tab badge counts. Recent counts only the last 24h, whatever "show older" says. */
export function yardCounts(tasks: Task[], now: number, showQuiet = false): Record<YardTab, number> {
  const shown = tasks.filter((x) => shownInYard(x, showQuiet))
  return Object.fromEntries(YARD_TABS.map((t) => [t.key, shown.filter((x) => inYardTab(x, t.key, now)).length])) as Record<YardTab, number>
}

/** Finished tasks that fell out of the recent window: what "show older" would add. */
export function olderFinishedCount(tasks: Task[], now: number, showQuiet = false): number {
  return tasks.filter((t) => shownInYard(t, showQuiet) && isFinished(t) && !isRecent(t, now)).length
}

/** How many quiet runs the "Show quiet runs" toggle would bring back into `tab`. */
export function quietCount(tasks: Task[], tab: YardTab, now: number, older = false): number {
  return tasks.filter((t) => isQuietRun(t) && inYardTab(t, tab, now, older)).length
}

const newestFirst = (a: Task, b: Task) => b.updatedAt - a.updatedAt

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
  /** Include quiet schedule runs (the "Show quiet runs" toggle, off by default). */
  showQuiet?: boolean
}

/** Whether a task shows in the tab (and, on All, matches the search). */
export function inYardView(task: Task, opts: YardOptions): boolean {
  if (!shownInYard(task, opts.showQuiet)) return false
  if (!inYardTab(task, opts.tab, opts.now, opts.older)) return false
  return opts.tab !== "all" || matchesQuery(task, opts.query ?? "", opts.projectName?.(task.projectId))
}

/**
 * The order of a tab. Active and Recent are by last activity, Needs you puts questions
 * before failures before PRs, and All follows the sort picker.
 */
export function yardCompare(opts: Pick<YardOptions, "tab" | "sort">): (a: Task, b: Task) => number {
  if (opts.tab === "needs_you") return compareTasks("attention")
  if (opts.tab !== "all") return newestFirst
  return compareTasks(opts.sort ?? "attention")
}

/** The tasks a tab shows, in order. */
export function yardTasks(tasks: Task[], opts: YardOptions): Task[] {
  return tasks.filter((t) => inYardView(t, opts)).sort(yardCompare(opts))
}
