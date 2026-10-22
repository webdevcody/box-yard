import { useSyncExternalStore } from "react"

export interface Toast {
  id: number
  kind: "error" | "info"
  title: string
  body?: string
  action?: { label: string; onClick: () => void }
}

interface ToastOptions {
  action?: Toast["action"]
  /** How long it stays up, in ms. */
  duration?: number
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function push(kind: Toast["kind"], title: string, body?: string, opts: ToastOptions = {}) {
  const id = nextId++
  toasts = [...toasts.slice(-3), { id, kind, title, body, action: opts.action }]
  emit()
  setTimeout(() => dismiss(id), opts.duration ?? (kind === "error" ? 8000 : 4000))
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  error: (title: string, body?: string, opts?: ToastOptions) => push("error", title, body, opts),
  info: (title: string, body?: string, opts?: ToastOptions) => push("info", title, body, opts),
}

export function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => toasts,
  )
}
