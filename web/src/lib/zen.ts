// Zen mode: the Coordinator chat alone, full screen and centered, at /zen. Entering pushes a history entry, so
// browser back leaves; Esc and the exit button go back too when Zen was entered from inside the app.
//
// Where Box Yard opens (Settings › Coordinator › Start in Zen mode, on by default): a new tab or window that opens
// on / with nothing after it lands in Zen. That's the only time Box Yard enters Zen on its own, once per tab.
// After that the URL is the memory: a reload of /zen stays in Zen and a reload of / stays on the Yard, so leaving
// Zen sticks for the tab. Deep links (/tasks/…, /projects/…, /boxes, ?settings=…) always open their own page.
import { useEffect, useLayoutEffect, useState } from "react"
import { navigate, useLocationProperty } from "wouter/use-browser-location"
import { isModalOpen } from "../components/Modal"
import { keepScrollOnNextBack } from "./scrollMemory"
import { closeZenPanel, zenPanelState } from "./zenPanel"

export const ZEN_PATH = "/zen"

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Alt+Shift+Z toggles Zen (by key position, like the voice toggle's Alt+Shift+V, since Option changes the
 * letter on macOS). Free of the other hotkeys: ⌘K and "/" (palette), Alt+Shift+V (voice), Alt/Ctrl(+Shift)+Space
 * (dictation), 1-4 (Yard tabs), ←/→ and Z (file preview, no modifiers), Ctrl+N/P (palette rows).
 */
export const isZenShortcut = (e: Pick<KeyboardEvent, "altKey" | "shiftKey" | "metaKey" | "ctrlKey" | "code">) =>
  e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyZ"

export const ZEN_SHORTCUT_LABEL = IS_MAC ? "⌥⇧Z" : "Alt+Shift+Z"

/** Marks the history entry Zen pushed, so leaving can go back to the page it came from. */
const ZEN_STATE = { zenFrom: true }

export const isZenPath = (path: string) => path === ZEN_PATH

/** Re-renders only when Zen turns on or off, not on every navigation. */
export const useZen = () => useLocationProperty(() => isZenPath(location.pathname))

export function enterZen() {
  if (isZenPath(location.pathname)) return
  navigate(ZEN_PATH, { state: ZEN_STATE })
}

/**
 * Back to where Zen was entered from; a /zen that was opened directly goes to the Yard instead. Like entering, it
 * keeps the chat where it is: only the browser's own Back puts the page's old scroll position back.
 */
export function leaveZen() {
  if (!isZenPath(location.pathname)) return
  if ((history.state as { zenFrom?: boolean } | null)?.zenFrom) {
    keepScrollOnNextBack()
    history.back()
  } else navigate("/", { replace: true })
}

export const toggleZen = () => (isZenPath(location.pathname) ? leaveZen() : enterZen())

/**
 * Mounted once (App): the shortcut toggles Zen from anywhere, typing included. In Zen, Esc closes the side panel
 * (lib/zenPanel.ts) and then leaves, but only once nothing else wants it: an open modal (the palette, settings, the
 * file preview) closes first, and handlers that use Esc themselves (dictation, menus, a side thread) call
 * preventDefault or stop it.
 */
export function useZenHotkeys(zen: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isZenShortcut(e)) {
        e.preventDefault()
        if (!e.repeat) toggleZen()
        return
      }
      if (!zen || e.key !== "Escape" || e.defaultPrevented || e.isComposing || isModalOpen()) return
      e.preventDefault()
      if (zenPanelState()) closeZenPanel()
      else leaveZen()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zen])
}

/** Set once this tab has opened Box Yard, so a reload never moves it into Zen. */
const LANDED_KEY = "box-yard:landed"
/** The last Start in Zen mode value this browser saw, so a new tab can decide before settings load. */
const START_KEY = "box-yard:start-in-zen"

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key)
  } catch {
    return null
  }
}
const write = (store: () => Storage, key: string, value: string) => {
  try {
    store().setItem(key, value)
  } catch {}
}

/** The page a tab opened on is the bare home page: no path, query (?settings=…) or hash. */
export const isBareHome = (loc: Pick<Location, "pathname" | "search" | "hash">) => loc.pathname === "/" && !loc.search && !loc.hash

/** Remembers Start in Zen mode for the next new tab. */
export const rememberStartInZen = (on: boolean) => write(() => localStorage, START_KEY, on ? "1" : "0")

/**
 * Mounted once (App), before sign-in is known. `startInZen` is the saved setting: undefined while it loads (pass
 * false if it can't load). Returns false while a new tab on / waits to decide; App renders nothing until then, so
 * the Yard never flashes before Zen, and a new browser never enters Zen against a setting it hasn't seen yet.
 * Every other first load (a deep link, a reload) is decided at once: it stays where it is.
 */
export function useZenLanding(startInZen: boolean | undefined): boolean {
  const [pending, setPending] = useState(() => read(() => sessionStorage, LANDED_KEY) !== "1" && isBareHome(location))
  const remembered = read(() => localStorage, START_KEY)
  const decided = startInZen ?? (remembered === null ? undefined : remembered === "1")
  useEffect(() => {
    if (startInZen !== undefined) rememberStartInZen(startInZen)
  }, [startInZen])
  useLayoutEffect(() => {
    if (pending && decided === undefined) return
    write(() => sessionStorage, LANDED_KEY, "1")
    if (!pending) return
    // Replace, so back from this Zen leaves Box Yard instead of landing on / and bouncing back in.
    if (decided && isBareHome(location)) navigate(ZEN_PATH, { replace: true })
    setPending(false)
  }, [pending, decided])
  return !pending
}
