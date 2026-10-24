// Zen mode: the Coordinator chat alone, full screen and centered, at /zen. The URL is the only memory of the
// mode: a reload of /zen stays in Zen, a plain load of / never enters it. Entering pushes a history entry, so
// browser back leaves; Esc and the exit button go back too when Zen was entered from inside the app.
import { useEffect } from "react"
import { navigate, useLocationProperty } from "wouter/use-browser-location"
import { isModalOpen } from "../components/Modal"

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

/** Back to where Zen was entered from; a /zen that was opened directly goes to the Yard instead. */
export function leaveZen() {
  if (!isZenPath(location.pathname)) return
  if ((history.state as { zenFrom?: boolean } | null)?.zenFrom) history.back()
  else navigate("/", { replace: true })
}

export const toggleZen = () => (isZenPath(location.pathname) ? leaveZen() : enterZen())

/**
 * Mounted once (App): the shortcut toggles Zen from anywhere, typing included. In Zen, Esc leaves, but only
 * once nothing else wants it: an open modal (the palette, settings, the file preview) closes first, and
 * handlers that use Esc themselves (dictation, menus) call preventDefault.
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
      leaveZen()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zen])
}
