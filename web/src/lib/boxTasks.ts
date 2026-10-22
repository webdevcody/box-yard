import type { Task, TaskStatus } from "../../../shared/types"

/** Agents on a box that are doing something (or waiting on someone) right now. Everything else counts as finished. */
export const ACTIVE_ON_BOX: TaskStatus[] = ["starting", "working", "needs_input", "waiting", "queued"]

/**
 * Split a box's agents into active and finished. Both lists are ordered by createdAt only, so live status
 * and timestamp updates never reorder rows: active oldest first, finished newest first.
 */
export function splitBoxTasks(tasks: Task[]): { active: Task[]; finished: Task[] } {
  const active = tasks.filter((t) => ACTIVE_ON_BOX.includes(t.status)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const finished = tasks.filter((t) => !ACTIVE_ON_BOX.includes(t.status)).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return { active, finished }
}

/** Compact duration for "up 2h": `<1m`, `45m`, `2h`, `3d`. */
export function shortDuration(ms: number) {
  const m = Math.round(Math.max(0, ms) / 60_000)
  if (m < 1) return "<1m"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}
