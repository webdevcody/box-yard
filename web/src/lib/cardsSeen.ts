// A Coordinator chat card's "N new" (components/CoordinatorCards.tsx): what came in since Cody last had it open. This
// browser (localStorage) keeps the newest entry it saw on each card, and `since`: what was there when it first showed
// the cards, which isn't new. Each card reads only its own (useSyncExternalStore), so marking one seen re-renders
// that card and the ↓ pill, not the list.
import { useSyncExternalStore } from "react"

const KEY = "boxyard:cards-seen"
/** Enough cards for weeks; the longest-unseen go first. */
const MAX = 300

interface Seen {
  /** Null until the cards view first shows (startSeen). */
  since: number | null
  at: Record<string, number>
}

const listeners = new Set<() => void>()
let state: Seen = load()

function load(): Seen {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as Partial<Seen>) : null
    if (v && typeof v.since === "number" && v.at && typeof v.at === "object") return { since: v.since, at: v.at }
  } catch {
    // Unreadable: start over.
  }
  return { since: null, at: {} }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // Private mode or full storage: it still holds until the page closes.
  }
}

function emit() {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    state = load()
    emit()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener("storage", onStorage)
  }
}

/** The newest entry on this card Cody has seen; everything before the cards first showed counts as seen. */
export function seenAt(key: string, s: Seen = state): number {
  if (s.since === null) return Infinity
  return Math.max(s.since, s.at[key] ?? 0)
}

/** The cards first show: what's there now (up to `at`, the chat's newest entry) isn't new. */
export function startSeen(at: number) {
  if (state.since !== null) return
  state = { ...state, since: at }
  save()
  emit()
}

/** Cody saw this card up to `at`. */
export function markSeen(key: string, at: number) {
  if (at <= seenAt(key)) return
  const next = { ...state.at, [key]: at }
  const keys = Object.keys(next)
  if (keys.length > MAX) for (const k of keys.sort((a, b) => next[a]! - next[b]!).slice(0, keys.length - MAX)) delete next[k]
  state = { ...state, at: next }
  save()
  emit()
}

/** Back to a browser that never showed the cards; for tests. */
export function resetCardsSeen() {
  state = { since: null, at: {} }
  save()
  emit()
}

export const useSeenAt = (key: string) => useSyncExternalStore(subscribe, () => seenAt(key), () => Infinity)

/** The whole record, for the ↓ pill: a new object whenever a card is marked. */
export const useSeen = () => useSyncExternalStore(subscribe, () => state, () => state)
