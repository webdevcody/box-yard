// A task this browser marked done stays done in the tasks cache: while the close is on its way, and after it lands,
// against anything older that arrives late. On a slow network (a phone over Tailscale) an SSE update sent before the
// close can come in after its answer, and a /api/tasks fetch that started before it (a reconnect refetches everything)
// can land after it; either would bring the card back. A copy the server made after the close (Cody messaged the
// task, so it's back at work) goes through.
import type { Task } from "../../../shared/types"

/** How long a landed close guards its task: late copies arrive within seconds. */
const GUARD_MS = 60_000

/** Closes on their way (or in their undo window), with the task as it was before, for Undo and a failure. */
const sending = new Map<string, Task | null>()
/** The server's done copy's updatedAt, and when it landed here. */
const landed = new Map<string, { updatedAt: number; at: number }>()

/** The task is marked done here and its POST /close is coming (`before`: the task as it was; the first one is kept). */
export function closeSent(taskId: string, before?: Task) {
  if (!sending.get(taskId)) sending.set(taskId, before ?? null)
  landed.delete(taskId)
}

/** A server copy that says done: copies older than it are stale. */
function floor(task: Task) {
  const was = landed.get(task.id)
  if (!was || task.updatedAt > was.updatedAt) landed.set(task.id, { updatedAt: task.updatedAt, at: Date.now() })
}

/** The POST's answer: the task is done on the server. */
export function closeLanded(task: Task) {
  if (task.status !== "done") return
  sending.delete(task.id)
  floor(task)
}

/** The close failed or was undone: the task is whatever the server says again. Returns the task as it was before. */
export function closeFailed(taskId: string): Task | undefined {
  const before = sending.get(taskId) ?? undefined
  sending.delete(taskId)
  landed.delete(taskId)
  return before
}

/**
 * Whether a server copy of a task is older than a close this browser made, so the cached (done) copy stays. A done
 * copy also records the close as landed (it may come by SSE before the POST's answer).
 */
export function staleAfterClose(incoming: Task): boolean {
  if (incoming.status === "done") {
    if (sending.has(incoming.id) || landed.has(incoming.id)) floor(incoming)
    return false
  }
  // Marked done here and the server hasn't answered yet (or the undo window is open): nothing it sent counts yet.
  if (sending.has(incoming.id)) return true
  const guard = landed.get(incoming.id)
  if (!guard) return false
  if (Date.now() - guard.at > GUARD_MS) {
    landed.delete(incoming.id)
    return false
  }
  // A copy written after the close (a message reopened it) is news; one from before it, or the same moment, isn't.
  if (incoming.updatedAt > guard.updatedAt) {
    landed.delete(incoming.id)
    return false
  }
  return true
}

/** A fetched task list with the tasks this browser closed kept as cached, where the fetch is older than the close. */
export function keepClosed(list: Task[], cached: readonly Task[] | undefined): Task[] {
  if (!cached || (!sending.size && !landed.size)) return list
  let out: Task[] | null = null
  list.forEach((t, i) => {
    if (!staleAfterClose(t)) return
    const mine = cached.find((c) => c.id === t.id)
    if (!mine) return
    out ??= list.slice()
    out[i] = mine
  })
  return out ?? list
}

/** Tests: forget every close. */
export function resetClosedTasks() {
  sending.clear()
  landed.clear()
}
