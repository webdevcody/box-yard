// Filtering, searching and sorting for the Tasks tab of a project page. Pure, so it is unit tested.
import type { Task, TaskStatus } from "../../../shared/types"
import { isQuietRun } from "../../../shared/quiet"

export const TASK_FILTERS = [
  { key: "open", label: "Open", statuses: ["needs_input", "failed", "working", "starting", "waiting", "queued", "pr_ready", "idle"] },
  { key: "needs_you", label: "Needs you", statuses: ["needs_input"] },
  { key: "active", label: "Active", statuses: ["working", "starting", "waiting", "queued", "idle"] },
  { key: "pr_ready", label: "PR ready", statuses: ["pr_ready"] },
  { key: "failed", label: "Failed", statuses: ["failed"] },
  { key: "done", label: "Done", statuses: ["done"] },
  { key: "all", label: "All", statuses: null },
] as const satisfies readonly { key: string; label: string; statuses: readonly TaskStatus[] | null }[]

export type TaskFilter = (typeof TASK_FILTERS)[number]["key"]
export const DEFAULT_FILTER: TaskFilter = "open"

export const TASK_SORTS = [
  { key: "attention", label: "Attention first" },
  { key: "recent", label: "Last active" },
  { key: "newest", label: "Newest" },
] as const

export type TaskSort = (typeof TASK_SORTS)[number]["key"]
export const DEFAULT_SORT: TaskSort = "attention"

/** Most urgent first: what needs Cody, then what broke, then live work, then work to review. */
const ATTENTION: TaskStatus[] = ["needs_input", "failed", "working", "starting", "waiting", "queued", "pr_ready", "idle", "done"]

export function parseFilter(value: string | null): TaskFilter {
  return TASK_FILTERS.find((f) => f.key === value)?.key ?? DEFAULT_FILTER
}

export function parseSort(value: string | null): TaskSort {
  return TASK_SORTS.find((s) => s.key === value)?.key ?? DEFAULT_SORT
}

export function inFilter(task: Task, filter: TaskFilter): boolean {
  const statuses = TASK_FILTERS.find((f) => f.key === filter)?.statuses
  return !statuses || (statuses as readonly TaskStatus[]).includes(task.status)
}

/**
 * Case-insensitive match of every word against the title and the summary (or the prompt, which cards show until there is a summary),
 * plus any `extra` text such as the project name.
 */
export function matchesQuery(task: Task, query: string, extra = ""): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = `${task.title}\n${task.summary ?? task.prompt}\n${extra}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The comparator behind each sort, for lists that sort themselves (useStableOrder). */
export function compareTasks(sort: TaskSort): (a: Task, b: Task) => number {
  if (sort === "newest") return (a, b) => b.createdAt - a.createdAt
  if (sort === "recent") return (a, b) => b.updatedAt - a.updatedAt
  return (a, b) => ATTENTION.indexOf(a.status) - ATTENTION.indexOf(b.status) || b.updatedAt - a.updatedAt
}

export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  return [...tasks].sort(compareTasks(sort))
}

/** Whether a task shows under the filter and search. Quiet schedule runs only show with `showQuiet`. */
export function isVisible(task: Task, opts: { filter: TaskFilter; query: string; showQuiet?: boolean }): boolean {
  return (opts.showQuiet || !isQuietRun(task)) && inFilter(task, opts.filter) && matchesQuery(task, opts.query)
}

/** How many of `tasks` match the query in each filter, for the chip counts. */
export function filterCounts(tasks: Task[], query: string, showQuiet = false): Record<TaskFilter, number> {
  const matching = tasks.filter((t) => (showQuiet || !isQuietRun(t)) && matchesQuery(t, query))
  return Object.fromEntries(TASK_FILTERS.map((f) => [f.key, matching.filter((t) => inFilter(t, f.key)).length])) as Record<TaskFilter, number>
}

export function visibleTasks(tasks: Task[], opts: { filter: TaskFilter; query: string; sort: TaskSort; showQuiet?: boolean }): Task[] {
  return sortTasks(
    tasks.filter((t) => isVisible(t, opts)),
    opts.sort,
  )
}
