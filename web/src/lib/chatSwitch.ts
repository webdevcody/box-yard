// The chat switcher's seams (components/ChatSwitcher.tsx): the Coordinator or Captain title in a chat header opens a
// menu of every chat, and picking one opens it with its composer focused, so Cody can type to it right away.
//
// The picked chat may not be on screen yet (a Captain tab the navigation is about to render, the Coordinator drawer
// sliding in), so the switcher leaves a request here and each chat takes its own when it mounts or hears about it.
import { useEffect, type RefObject } from "react"
import { normalizeQuery, scoreText } from "./paletteRank"

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

/** A word-initials match ("stn" → "survive-the-night") ranks between a prefix and a word start. */
const INITIALS_SCORE = 700
/** Aliases count less than the name, as in the palette (FIELD_WEIGHT.alias). */
const ALIAS_WEIGHT = 0.75

/**
 * The switcher's filter: the chats whose name matches `query`, best first (lib/paletteRank.ts's tiers: exact, prefix,
 * word start, substring, then a fuzzy subsequence), with word initials ("stn" → "survive-the-night") just under a
 * prefix; a tie keeps the menu's order. An empty query keeps them all, in order. `aliases` match too, a little
 * weaker ("All" for the Coordinator, as the project bar says).
 */
export function rankChats<T extends { label: string; aliases?: readonly string[] }>(items: readonly T[], query: string): T[] {
  const q = normalizeQuery(query)
  if (!q) return [...items]
  const scored: { item: T; score: number; at: number }[] = []
  items.forEach((item, at) => {
    let score = scoreName(item.label, q)
    for (const alias of item.aliases ?? []) {
      const s = scoreName(alias, q)
      if (s !== null && (score === null || s * ALIAS_WEIGHT > score)) score = s * ALIAS_WEIGHT
    }
    if (score !== null) scored.push({ item, score, at })
  })
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.item)
}

function scoreName(name: string, q: string): number | null {
  const s = scoreText(name, q)
  const initials = name
    .toLowerCase()
    .split(/[\s\-_/.:]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
  if (q.length >= 2 && !q.includes(" ") && initials.startsWith(q)) return Math.max(s ?? 0, INITIALS_SCORE)
  return s
}

/**
 * The project picker's hotkey: P, with no modifier, from anywhere but a text field, opens the Coordinator's chat
 * switcher with its filter focused. Free of the other hotkeys: ⌘K/Ctrl+K and "/" (palette), 1-4 (Yard tabs), ←/→ and
 * Z (file preview), ⌥⇧Z (Zen), ⌥⇧V (voice), Alt/Ctrl(+Shift)+Space (dictation), Ctrl+N/P (palette rows, in its field).
 */
export const PROJECT_PICKER_KEY_LABEL = "P"
export function isProjectPickerKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented" | "repeat" | "isComposing" | "target">) {
  if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat || e.isComposing) return false
  const el = e.target instanceof Element ? e.target : null
  return !el?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]")
}
