// Task priority: a "high" task's next turn goes before every "normal" one waiting for a slot (on this computer, an
// Upstash box, a GPU pod or a Docker container). It only jumps the queue: running agents are never stopped, and the
// projects' own limits (agents_per_box, whole_machine) still hold. The server's scheduler and the web app's queue
// lists share this order, so they always agree on who goes next.

export const TASK_PRIORITIES = ["high", "normal"] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** The stored value (tasks.priority, NULL on old rows) as a priority: anything but "high" is normal. */
export const parsePriority = (value: unknown): TaskPriority => (value === "high" ? "high" : "normal")

/** Something waiting for a turn: its priority, and when it joined the queue (FIFO within a priority). */
export interface QueueEntry {
  priority?: TaskPriority | null
  queuedAt: number
}

/** Sort order for the queue: high before normal, then first in, first out. */
export function queueOrder(a: QueueEntry, b: QueueEntry): number {
  const rank = (e: QueueEntry) => (e.priority === "high" ? 0 : 1)
  return rank(a) - rank(b) || a.queuedAt - b.queuedAt
}
