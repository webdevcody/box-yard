// The Zen header's running-tasks badge and its dropdown: which tasks count as running, how many, in what order,
// and how long each has run. Pure, so it is unit tested.
import type { Task, TaskStatus } from "../../../shared/types"

/**
 * Tasks with an agent turn running or about to run. needs_input doesn't count: its turn has ended and it waits on
 * the owner (the Inbox has those). waiting doesn't either: it's held on another agent, not running.
 */
export const RUNNING_STATUSES: readonly TaskStatus[] = ["working", "starting", "queued"]

export const isRunning = (t: Pick<Task, "status">) => RUNNING_STATUSES.includes(t.status)

export const runningCount = (tasks: readonly Pick<Task, "status">[] | undefined) => (tasks ? tasks.filter(isRunning).length : 0)

/** The badge's text: "99+" past two digits, so it keeps its width. */
export const countLabel = (n: number) => (n > 99 ? "99+" : String(n))

/** Since when it has run: its turn's start, else (queued, or a turn still being set up) when its status last changed. */
export const runningSince = (t: Pick<Task, "turnStartedAt" | "updatedAt">) => t.turnStartedAt ?? t.updatedAt

/**
 * The dropdown's order: oldest task first. Created-at never changes, so a status change (queued → working) never
 * moves a row: a re-sort only adds the tasks that started and drops the ones that stopped.
 */
export const compareRunning = (a: Pick<Task, "createdAt" | "id">, b: Pick<Task, "createdAt" | "id">) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)

/** "<1m", "12m", "1h 5m", "2d 3h". */
export function elapsedLabel(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return "<1m"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}
