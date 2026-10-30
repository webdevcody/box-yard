// The Coordinator chat's two views (components/CoordinatorCards.tsx): Cards, one per task, or the Timeline, every
// message in order. This browser remembers which. For this page's life, the Timeline can be narrowed to one card's
// tasks ("Show in timeline"), and the Cards view asked to open a card and scroll to it ("Back to its card").
import { useSyncExternalStore } from "react"
import { localFlag } from "./localFlag"
import { revealChatMessage } from "./reveal"

export type CoordinatorView = "cards" | "timeline"

const timeline = localFlag("boxyard:coordinator-timeline")

export const useCoordinatorView = (): CoordinatorView => (timeline.use() ? "timeline" : "cards")

/** A card's tasks, for the Timeline of just them. */
export interface TimelineCard {
  key: string
  taskIds: readonly string[]
}

let only: TimelineCard | null = null
let focus: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const emit = () => {
  for (const l of listeners) l()
}

/** Switch views. The Cards view drops the Timeline's narrowing, so coming back shows all of it. */
export function setCoordinatorView(view: CoordinatorView) {
  if (view === "cards" && only) {
    only = null
    emit()
  }
  timeline.set(view === "timeline")
}

/** The Timeline of just this card's tasks; null for all of it. */
export function showInTimeline(card: TimelineCard | null) {
  only = card
  emit()
  if (card) timeline.set(true)
}

/** The Cards view, with this card open and in view. */
export function showCard(key: string) {
  only = null
  focus = key
  emit()
  timeline.set(false)
}

/** The Timeline, scrolled to this message (a card's "From your message"). */
export function revealInTimeline(id: string) {
  timeline.set(true)
  // Two frames: the Timeline renders and starts listening for reveals.
  requestAnimationFrame(() => requestAnimationFrame(() => revealChatMessage(id)))
}

export const useTimelineCard = () => useSyncExternalStore(subscribe, () => only, () => only)

/** The card to open and scroll to, until the Cards view has. */
export const useFocusCard = () => useSyncExternalStore(subscribe, () => focus, () => focus)

export function clearFocusCard() {
  if (focus === null) return
  focus = null
  emit()
}
