// Which Coordinator chat chips are open, for this browser session (sessionStorage), so a reload or a trip to
// another page finds them as they were. Each chip reads only its own id (useSyncExternalStore), so opening one
// re-renders that chip, not the transcript. Chips are closed unless opened.
import { useCallback, useSyncExternalStore } from "react"

const KEY = "boxyard:chat-open"
/** Enough for a long session; the oldest opened go first. */
const MAX = 400

const listeners = new Set<() => void>()
let open = load()

function load(): Set<string> {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY)
    const ids = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...open]))
  } catch {
    // Private mode or full storage: the state still holds until the page closes.
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export const isOpen = (key: string) => open.has(key)

/** Open or close these chips. */
export function setOpen(keys: readonly string[], value: boolean) {
  const next = new Set(open)
  for (const key of keys) {
    // Re-adding moves it to the end, so the cap drops the longest-open first.
    next.delete(key)
    if (value) next.add(key)
  }
  while (next.size > MAX) next.delete(next.values().next().value!)
  open = next
  save()
  for (const fn of listeners) fn()
}

/** Every chip closed again; for tests. */
export function resetChipState() {
  open = new Set()
  save()
  for (const fn of listeners) fn()
}

/** Whether this chip is open, and a toggle. */
export function useChipOpen(key: string): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => open.has(key))
  const toggle = useCallback(() => setOpen([key], !open.has(key)), [key])
  return [value, toggle]
}

/** Whether every one of these is open (a reply's "from:" line, which opens them all). */
export function useAllOpen(keys: readonly string[]): boolean {
  return useSyncExternalStore(subscribe, () => keys.length > 0 && keys.every((k) => open.has(k)))
}
