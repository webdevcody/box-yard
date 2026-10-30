// The Cards view's selection (components/CoordinatorCards.tsx): Select mode, and which cards are picked for Mark done.
// A store outside React, so a memo'd card re-renders only when its own pick changes.
import { useSyncExternalStore } from "react"

let selecting = false
let picked: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Select mode on, with `key`'s card picked (a card's "Select"). */
export function startSelecting(key?: string) {
  selecting = true
  if (key) picked = new Set(picked).add(key)
  emit()
}

/** Select mode off, and nothing picked. */
export function stopSelecting() {
  if (!selecting && !picked.size) return
  selecting = false
  picked = new Set()
  emit()
}

export function togglePicked(key: string) {
  const next = new Set(picked)
  if (!next.delete(key)) next.add(key)
  picked = next
  emit()
}

export function setPicked(keys: Iterable<string>) {
  picked = new Set(keys)
  emit()
}

export const useSelecting = () => useSyncExternalStore(subscribe, () => selecting)
export const usePicked = (key: string) => useSyncExternalStore(subscribe, () => picked.has(key))
export const usePickedKeys = () => useSyncExternalStore(subscribe, () => picked)
