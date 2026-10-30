// The chat switcher's seams (components/ChatSwitcher.tsx): the Coordinator or Captain title in a chat header opens a
// menu of every chat, and picking one opens it with its composer focused, so Cody can type to it right away.
//
// The picked chat may not be on screen yet (a Captain tab the navigation is about to render, the Coordinator drawer
// sliding in), so the switcher leaves a request here and each chat takes its own when it mounts or hears about it.
import { useEffect, type RefObject } from "react"

/** App opens the Coordinator drawer on this (docked or in Zen it's already on screen). */
export const OPEN_COORDINATOR_EVENT = "box-yard:open-coordinator"
const FOCUS_EVENT = "box-yard:focus-composer"
/** A request nobody took by then (the page never showed that chat) is dropped, so it can't steal focus later. */
const PENDING_MS = 5000

let pending: { chat: string; at: number } | null = null

/** Focus `chat`'s composer (COORDINATOR_CHAT or a project id) now if it's mounted, or when it mounts. */
export function focusComposer(chat: string) {
  pending = { chat, at: Date.now() }
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: chat }))
}

/** Show the Coordinator: App opens its drawer when it isn't docked. */
export const openCoordinator = () => window.dispatchEvent(new Event(OPEN_COORDINATOR_EVENT))

/** A chat's half: focuses `box` when the switcher picked `chat`. */
export function useComposerFocus(chat: string, box: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const take = () => {
      if (!pending || pending.chat !== chat) return
      if (Date.now() - pending.at > PENDING_MS) return void (pending = null)
      const el = box.current
      if (!el) return
      pending = null
      // A frame later: a drawer opening on the same event has started to slide in, so focusing doesn't scroll to it.
      requestAnimationFrame(() => el.focus({ preventScroll: true }))
    }
    take()
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === chat) take()
    }
    window.addEventListener(FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_EVENT, onFocus)
  }, [chat, box])
}
