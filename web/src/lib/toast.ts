import { useSyncExternalStore } from "react"
import type { TaskStatus } from "../../../shared/types"

export type ToastTone = "neutral" | "red" | "amber" | "green"

export interface Toast {
  id: number
  kind: "error" | "info" | "task"
  title: string
  body?: string
  action?: { label: string; onClick: () => void }
  /** Task toasts: where a click goes, the color, and the line under the title. */
  href?: string
  tone?: ToastTone
  status?: TaskStatus
  context?: string
  /** Runs when the toast is clicked through to `href`. */
  onOpen?: () => void
  /** Keyed toasts (`toast.progress`) are updated in place instead of stacking. */
  key?: string
  /** Shows a spinner and stays up until settled or dismissed. */
  progress?: boolean
}

interface ToastOptions {
  action?: Toast["action"]
  /** How long it stays up, in ms. */
  duration?: number
}

/** At most this many toasts are on screen; the oldest goes first. */
export const MAX_TOASTS = 3
export const TASK_TOAST_MS = 6000

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Auto-dismiss timers; paused while the pointer is over the stack. */
const timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>()
let paused = false

function arm(id: number, ms: number) {
  const t = { timer: null as ReturnType<typeof setTimeout> | null, remaining: ms, startedAt: Date.now() }
  if (!paused) t.timer = setTimeout(() => dismiss(id), ms)
  timers.set(id, t)
}

function push(toast: Omit<Toast, "id">, duration: number) {
  const id = nextId++
  const kept = toasts.slice(-(MAX_TOASTS - 1))
  for (const old of toasts) if (!kept.includes(old)) clearTimer(old.id)
  toasts = [...kept, { ...toast, id }]
  arm(id, duration)
  emit()
  return id
}

function clearTimer(id: number) {
  const t = timers.get(id)
  if (t?.timer) clearTimeout(t.timer)
  timers.delete(id)
}

export function dismiss(id: number) {
  clearTimer(id)
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.filter((t) => t.id !== id)
  // The stack is gone, so the pointer can't be over it any more.
  if (!toasts.length) paused = false
  emit()
}

/** Hold every toast on screen (pointer over the stack). */
export function pauseToasts() {
  if (paused) return
  paused = true
  const now = Date.now()
  for (const t of timers.values()) {
    if (t.timer) clearTimeout(t.timer)
    t.timer = null
    t.remaining = Math.max(0, t.remaining - (now - t.startedAt))
  }
}

export function resumeToasts() {
  if (!paused) return
  paused = false
  const now = Date.now()
  for (const [id, t] of timers) {
    t.startedAt = now
    t.timer = setTimeout(() => dismiss(id), Math.max(t.remaining, 1000))
  }
}

/** Show or update the toast for `key` (one per key). A progress toast stays up; others time out after `duration`. */
function keyed(key: string, t: Omit<Toast, "id" | "key">, duration: number | null) {
  const current = toasts.find((x) => x.key === key)
  if (!current) {
    const id = push({ ...t, key }, duration ?? 0)
    if (duration === null) clearTimer(id)
    return id
  }
  clearTimer(current.id)
  toasts = toasts.map((x) => (x.id === current.id ? { ...t, key, id: current.id } : x))
  if (duration !== null) arm(current.id, duration)
  emit()
  return current.id
}

export const toast = {
  /** Something long is running: one toast per `key`, updated as it goes, with a spinner. */
  progress: (key: string, title: string, body?: string) => keyed(key, { kind: "info", title, body, progress: true }, null),
  /** Replace the `key` toast with the outcome (or show it, when there was none). */
  settle: (key: string, kind: "info" | "error", title: string, body?: string, duration = kind === "error" ? 10_000 : 8000) => keyed(key, { kind, title, body }, duration),
  error: (title: string, body?: string, opts: ToastOptions = {}) => push({ kind: "error", title, body, action: opts.action }, opts.duration ?? 8000),
  info: (title: string, body?: string, opts: ToastOptions = {}) => push({ kind: "info", title, body, action: opts.action }, opts.duration ?? 4000),
  /** A task finished or needs Cody: clickable, colored by status. */
  task: (t: Pick<Toast, "title" | "body" | "href" | "tone" | "status" | "context" | "onOpen">, duration = TASK_TOAST_MS) =>
    push({ kind: "task", ...t }, duration),
}

/** What is on screen now (for tests; components use useToasts). */
export const currentToasts = () => toasts

export function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => toasts,
  )
}
