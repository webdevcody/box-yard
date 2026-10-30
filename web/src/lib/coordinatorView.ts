// The Coordinator chat's cards (components/CoordinatorCards.tsx): "Tasks only", which this browser remembers, and for
// this page's life the card to open and scroll to ("Show its card") and the message to show in its card (a link to a
// chat message, like a schedule run's or a card's "From your message").
import { useSyncExternalStore } from "react"
import { localFlag } from "./localFlag"

// The Timeline view is gone (cards only): a browser that remembered it forgets it.
try {
  localStorage.removeItem("boxyard:coordinator-timeline")
} catch {}

// The Cards view's "Tasks only": the task cards without the card under them, the Coordinator's under "All" and a
// project's Captain's with a project picked. This browser remembers two choices: one for "All", one shared by every
// project (hiding one Captain hides them all, so the bar's pills don't each carry a state of their own).
const tasksOnly = localFlag("boxyard:cards-tasks-only")
const captainTasksOnly = localFlag("boxyard:cards-tasks-only-project")
/** "Tasks only" under "All" (`project` false) or with a project picked. */
export function useTasksOnly(project = false) {
  const all = tasksOnly.use()
  const picked = captainTasksOnly.use()
  return project ? picked : all
}
/**
 * Hide (or show again) the Coordinator card, or with `project` the Captain's. Sending to either shows its card, so its
 * answer is in view.
 */
export function setTasksOnly(on: boolean, project = false) {
  if (project) captainTasksOnly.set(on)
  else tasksOnly.set(on)
}

let focus: string | null = null
let message: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const emit = () => {
  for (const l of listeners) l()
}

/** The Cards view, with this card open and in view. */
export function showCard(key: string) {
  focus = key
  emit()
}

/** The card to open and scroll to, until the Cards view has. */
export const useFocusCard = () => useSyncExternalStore(subscribe, () => focus, () => focus)

export function clearFocusCard() {
  if (focus === null) return
  focus = null
  emit()
}

/** Show this message in its card: the card that holds it pages back to it and scrolls to it (CoordinatorCards). */
export function showMessage(id: string) {
  message = id
  emit()
}

/** The message a card should page back to and scroll to, until one has. */
export const useShownMessage = () => useSyncExternalStore(subscribe, () => message, () => message)

/** Done with it (or with `id`, if it's still the one asked for). */
export function clearShownMessage(id?: string) {
  if (message === null || (id !== undefined && message !== id)) return
  message = null
  emit()
}
