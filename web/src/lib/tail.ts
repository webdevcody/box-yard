import { useCallback, useMemo, useReducer, useRef } from "react"

/** Index of the first item to render: the pinned one, or the newest `initial` items if it's gone. */
export function tailStart(items: { id: string }[], pinnedId: string | null, initial: number): number {
  const at = pinnedId ? items.findIndex((m) => m.id === pinnedId) : -1
  return at >= 0 ? at : Math.max(0, items.length - initial)
}

/**
 * Render only the newest part of a long list and grow it towards older items on
 * demand (StickyScroll calls `loadEarlier` as you scroll near the top).
 *
 * The first shown item is pinned by id, so new items arriving at the end never
 * push older ones out from under someone who is reading. A new `resetKey`
 * (another task) starts over from the newest `initial` items, and so does a
 * pinned item that's gone (e.g. tool calls hidden).
 */
export function useTail<T extends { id: string }>(items: T[], resetKey: unknown, initial = 60, step = 50) {
  const pinned = useRef<{ key: unknown; id: string | null }>({ key: resetKey, id: null })
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  if (pinned.current.key !== resetKey) pinned.current = { key: resetKey, id: null }

  const start = tailStart(items, pinned.current.id, initial)
  pinned.current.id = items[start]?.id ?? null

  const latest = useRef({ items, start })
  latest.current = { items, start }

  const visible = useMemo(() => (start ? items.slice(start) : items), [items, start])

  /** Show `step` more older items. */
  const loadEarlier = useCallback(() => {
    const { items, start } = latest.current
    if (!start) return
    pinned.current.id = items[Math.max(0, start - step)]!.id
    rerender()
  }, [step])

  /** Make sure the item with this id is rendered. Returns false if it isn't in the list at all. */
  const reveal = useCallback((id: string) => {
    const { items, start } = latest.current
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return false
    if (idx < start) {
      pinned.current.id = items[Math.max(0, idx - 5)]!.id
      rerender()
    }
    return true
  }, [])

  return { visible, hidden: start, loadEarlier, reveal }
}
