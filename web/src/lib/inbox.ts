// "Mark done" from an inbox card: the same close as "Mark done" in the task view
// (POST /api/tasks/:id/close, status → done). The card leaves the inbox at once,
// and the close is only sent once the undo window has passed, because closing
// archives the workspace and can't be taken back. Undo keeps the previous status.
import { useSyncExternalStore } from "react"
import type { Task, TaskStatus } from "../../../shared/types"
import { isQuietRun } from "../../../shared/quiet"

export const INBOX_STATUSES: readonly TaskStatus[] = ["needs_input", "pr_ready", "failed"]
export const UNDO_MS = 5000

let pending: ReadonlySet<string> = new Set()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function setPending(next: Set<string>) {
  pending = next
  listeners.forEach((l) => l())
}

function release(taskId: string) {
  const next = new Set(pending)
  next.delete(taskId)
  setPending(next)
}

/** In the inbox: needs Cody, and not marked done (even if the close hasn't been sent yet). */
export function inInbox(task: Task, closing: ReadonlySet<string> = pending): boolean {
  return INBOX_STATUSES.includes(task.status) && !isQuietRun(task) && !closing.has(task.id)
}

/** Hide the task from the inbox now and run `commit` after `delay` unless undone. Returns false if already pending. */
export function deferClose(taskId: string, commit: () => Promise<unknown>, delay = UNDO_MS): boolean {
  if (pending.has(taskId)) return false
  setPending(new Set(pending).add(taskId))
  timers.set(
    taskId,
    setTimeout(() => {
      timers.delete(taskId)
      // Stay hidden until the close lands (the task is then done) or fails (the card comes back).
      commit()
        .catch(() => {})
        .finally(() => release(taskId))
    }, delay),
  )
  return true
}

/** Put the card back in the inbox. Returns false if the close was already sent. */
export function undoClose(taskId: string): boolean {
  const timer = timers.get(taskId)
  if (!timer) return false
  clearTimeout(timer)
  timers.delete(taskId)
  release(taskId)
  return true
}

/** Send every pending close right away (the page is going away). */
export function flushCloses(send: (taskId: string) => void) {
  for (const [taskId, timer] of timers) {
    clearTimeout(timer)
    send(taskId)
  }
  timers.clear()
}

export function usePendingCloses(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => pending,
  )
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () =>
    flushCloses((taskId) => void fetch(`/api/tasks/${taskId}/close`, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {})),
  )
}
