// A yes/no remembered by this browser (localStorage), readable from React and kept in sync across tabs.
import { useSyncExternalStore } from "react"

export function localFlag(key: string) {
  const listeners = new Set<() => void>()
  const read = () => {
    try {
      return localStorage.getItem(key) === "1"
    } catch {
      return false
    }
  }
  const set = (on: boolean) => {
    try {
      if (on) localStorage.setItem(key, "1")
      else localStorage.removeItem(key)
    } catch {}
    for (const fn of listeners) fn()
  }
  const subscribe = (fn: () => void) => {
    listeners.add(fn)
    window.addEventListener("storage", fn)
    return () => {
      listeners.delete(fn)
      window.removeEventListener("storage", fn)
    }
  }
  const use = () => useSyncExternalStore(subscribe, read, () => false)
  return { read, set, use }
}
