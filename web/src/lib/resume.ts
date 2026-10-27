// The page going away and coming back. A phone's home-screen app is never reloaded: iOS freezes it in the
// background and thaws it later, sometimes days on, with its connections dead, a touch that never ended and the
// document still scrolled where the keyboard pushed it. These hooks let each piece put itself right.
const browser = typeof document !== "undefined"

let hiddenAt: number | null = browser && document.hidden ? Date.now() : null
const resumeListeners = new Set<(awayMs: number) => void>()
const suspendListeners = new Set<() => void>()

function suspended() {
  if (hiddenAt !== null) return
  hiddenAt = Date.now()
  suspendListeners.forEach((l) => l())
}

function resumed(force = false) {
  if (hiddenAt === null && !force) return
  const away = hiddenAt === null ? 0 : Date.now() - hiddenAt
  hiddenAt = null
  resumeListeners.forEach((l) => l(away))
}

if (browser) {
  document.addEventListener("visibilitychange", () => (document.hidden ? suspended() : resumed()))
  window.addEventListener("pagehide", suspended)
  // A page restored from the back/forward cache (persisted) was frozen whole: treat it as a resume even if no
  // visibilitychange came first.
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) resumed(true)
  })
}

/** Runs when the page is shown again after being hidden, with how long it was away. Returns an unsubscribe. */
export function onResume(fn: (awayMs: number) => void): () => void {
  resumeListeners.add(fn)
  return () => resumeListeners.delete(fn)
}

/** Runs when the page is hidden (another app, the lock screen, the app switcher). Returns an unsubscribe. */
export function onSuspend(fn: () => void): () => void {
  suspendListeners.add(fn)
  return () => suspendListeners.delete(fn)
}

const isEditable = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")

/**
 * The app never scrolls the document itself (the layout is one 100dvh screen that scrolls inside), but iOS
 * scrolls it to bring a focused field above the keyboard and doesn't always scroll it back. Shifted, the
 * page draws in one place and takes taps in another. Put it back, unless a field is focused (the keyboard
 * may still be up). Returns whether it moved anything.
 */
export function resetDocumentScroll(): boolean {
  if (isEditable(document.activeElement)) return false
  let moved = false
  for (const el of [document.scrollingElement, document.documentElement, document.body]) {
    if (el && (el.scrollTop || el.scrollLeft)) {
      el.scrollTop = 0
      el.scrollLeft = 0
      moved = true
    }
  }
  if (window.scrollY || window.scrollX) {
    window.scrollTo(0, 0)
    moved = true
  }
  return moved
}

/** Waits this long after a field loses focus, for the keyboard to close (or focus to move to another field). */
const BLUR_SETTLE_MS = 400

/**
 * Mounted once (main.tsx): puts the document scroll back when the page comes back and after the keyboard
 * closes. Returns an uninstall.
 */
export function installPageGuards(): () => void {
  if (!browser) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const onFocusOut = (e: FocusEvent) => {
    if (!isEditable(e.target as Element | null)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(resetDocumentScroll, BLUR_SETTLE_MS)
  }
  document.addEventListener("focusout", onFocusOut)
  const offResume = onResume(() => resetDocumentScroll())
  return () => {
    if (timer) clearTimeout(timer)
    document.removeEventListener("focusout", onFocusOut)
    offResume()
  }
}

/** Tests only: forget that the page was hidden. */
export const resetResumeState = () => {
  hiddenAt = null
}
