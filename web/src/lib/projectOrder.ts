// The owner's project order (sidebar drag-to-reorder): pure helpers, unit tested. The order is saved on the
// server (PUT /api/projects/order); ProjectList.tsx wires these to pointer, touch and keyboard.

/** `list` in the order of `ids`. Items `ids` doesn't name keep their relative order, after the named ones. */
export function applyOrder<T extends { id: string }>(list: T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const at = (item: T, i: number) => rank.get(item.id) ?? ids.length + i
  return list
    .map((item, i) => ({ item, at: at(item, i) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.item)
}

/** A copy of `ids` with the item at `from` moved to `to`. */
export function moveItem<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = ids.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** Same ids in the same order. */
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Where a dragged row lands: the slot its middle is over. `top` is where the dragged row started (relative to the
 * first row), `dy` how far it has moved, `pitch` the distance between two rows' tops.
 */
export function dropIndex(from: number, dy: number, pitch: number, count: number): number {
  if (pitch <= 0 || count <= 1) return from
  const to = from + Math.round(dy / pitch)
  return Math.max(0, Math.min(count - 1, to))
}

/** How far the row at `index` slides while the row at `from` is held over `to`, in pitches (-1, 0 or 1). */
export function shiftFor(index: number, from: number, to: number): -1 | 0 | 1 {
  if (index === from) return 0
  if (from < to && index > from && index <= to) return -1
  if (to < from && index >= to && index < from) return 1
  return 0
}

/** What screen readers hear after a move. */
export const movedAnnouncement = (name: string, position: number, total: number) => `Moved ${name} to position ${position} of ${total}`
