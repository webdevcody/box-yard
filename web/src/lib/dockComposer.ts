// The Coordinator chat's docked composer (components/DockComposer.tsx). In a narrow chat (a phone, a slim panel) the
// cards have no box of their own: the one box at the bottom, in thumb reach, sends to the card Cody opened last, and
// its "To" line says so. `docked` is the chat column's width (measured, a container and not the viewport); `target`
// the card's key, set when a card opens and cleared when it closes. Kept outside React state, so a change re-renders
// only the box and the cards, never the chat around them.
import { useSyncExternalStore } from "react"

let docked = false
let target: string | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The chat column is narrow: its cards' replies go through the box at the bottom. */
export function setDocked(value: boolean) {
  if (value === docked) return
  docked = value
  emit()
}
export const useDocked = () => useSyncExternalStore(subscribe, () => docked)

/** The card the docked box sends to (its key), or null for the chat's own (the Coordinator, or the picked Captain). */
export function setDockTarget(key: string | null) {
  if (key === target) return
  target = key
  emit()
}
export const dockTarget = () => target
export const useDockTarget = () => useSyncExternalStore(subscribe, () => target)

/** Tests: as a fresh page has it. */
export function resetDock() {
  docked = false
  target = null
  emit()
}

/** The chat column's width under which the box docks: 32rem, as a container query would read it. */
export const DOCK_BELOW_PX = 512
