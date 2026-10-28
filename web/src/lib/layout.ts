// The padding around every page in the main column (App.tsx), and its undo for pages whose chat runs to the bottom.

/** Inset of the page container in the main column. */
export const PAGE_PADDING = "px-4 py-4 sm:px-6 sm:py-6"

/**
 * For a full-height page whose last child is a chat (the project Captain tab): grow by the page's bottom
 * padding and pull it back with a negative margin, so its Composer sits flush with the window bottom
 * like the Coordinator panel's (Captain tab, task page). Must stay in step with PAGE_PADDING's bottom padding.
 */
export const PAGE_BLEED_BOTTOM = "-mb-4 h-[calc(100%+1rem)] sm:-mb-6 sm:h-[calc(100%+1.5rem)]"

/** The Coordinator panel's width limits, and the narrowest main column it may squeeze the page to. */
export const CHAT_MIN = 320
export const CHAT_MAX = 600
export const MAIN_MIN = 560
/** Where the projects sidebar stops being a drawer (Tailwind's lg). */
const SIDEBAR_DOCKED = 1024

/**
 * Whether the Coordinator panel sits docked beside the page, and how wide. It docks whenever the sidebar is
 * docked and the main column still gets MAIN_MIN beside a CHAT_MIN panel, so a zoomed-in laptop (1440 px at
 * 125% is 1152 CSS px) keeps the resizable panel. The saved width shrinks to fit (it isn't overwritten);
 * below that it's a drawer.
 */
export function coordinatorDock(viewport: number, sidebar: number, saved: number): { docked: boolean; width: number; max: number } {
  const max = Math.min(CHAT_MAX, viewport - sidebar - MAIN_MIN)
  const docked = viewport >= SIDEBAR_DOCKED && max >= CHAT_MIN
  return { docked, width: Math.max(CHAT_MIN, Math.min(saved, max)), max: Math.max(CHAT_MIN, max) }
}

/** The room an open side thread asks for beside the docked Coordinator, and the narrowest it may squeeze the page to. */
export const THREAD_ROOM = 416
export const MAIN_MIN_THREAD = 320

/**
 * The docked Coordinator's width while a side thread is open: wider by THREAD_ROOM (the panel slides left and the
 * thread takes the right), as far as the page keeps MAIN_MIN_THREAD; never narrower than without it.
 */
export function threadDockWidth(viewport: number, sidebar: number, width: number): number {
  return Math.max(width, Math.min(width + THREAD_ROOM, viewport - sidebar - MAIN_MIN_THREAD))
}
