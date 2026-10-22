// In-app replacement for window.confirm(): `await confirmDialog({...})` resolves true/false.
// One request shows at a time; <ConfirmHost> (mounted once in App) renders it with the shared Modal.
import { useSyncExternalStore } from "react"

export interface ConfirmRequest {
  title: string
  body?: string
  /** The confirm button's label, e.g. "Delete project". */
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button for destructive actions. */
  danger?: boolean
}

interface Pending extends ConfirmRequest {
  id: number
  resolve: (ok: boolean) => void
}

let queue: Pending[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...request, id: nextId++, resolve }]
    emit()
  })
}

/** Answers the request on screen and shows the next one, if any. */
export function settleConfirm(id: number, ok: boolean) {
  const item = queue.find((q) => q.id === id)
  if (!item) return
  queue = queue.filter((q) => q !== item)
  item.resolve(ok)
  emit()
}

export function currentConfirm(): Pending | undefined {
  return queue[0]
}

export function useCurrentConfirm() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    currentConfirm,
  )
}
