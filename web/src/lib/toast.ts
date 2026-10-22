import { useSyncExternalStore } from "react"

export interface Toast {
  id: number
  kind: "error" | "info"
  title: string
  body?: string
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function push(kind: Toast["kind"], title: string, body?: string) {
  const id = nextId++
  toasts = [...toasts.slice(-3), { id, kind, title, body }]
  emit()
  setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000)
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  error: (title: string, body?: string) => push("error", title, body),
  info: (title: string, body?: string) => push("info", title, body),
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
