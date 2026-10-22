// Stable list order: sort once, then let live updates change cards in place without moving them.
// The pure half (this file) is unit tested; useStableOrder.ts wires it to React and the DOM.

export interface StableOptions<T, K> {
  /** Identity of an item across updates. */
  key: (item: T) => K
  /** The order to apply on (re-)sort. */
  compare: (a: T, b: T) => number
  /** Whether an item belongs in the list right now (filter, search…). Defaults to everything. */
  include?: (item: T) => boolean
}

export interface StableEntry<T> {
  /** The live item: render this, so status, summary and times stay current. */
  item: T
  /** The item as it was when the order was frozen, e.g. to group by its old status. */
  was: T
  /** No longer matches `include`: it stays in place (dimmed) until the next re-sort. */
  stale: boolean
}

export interface StableView<T> {
  entries: StableEntry<T>[]
  /** Matching items that weren't in the list when it was frozen. Not shown until re-sort. */
  newCount: number
  /** Shown items a re-sort would move or drop. */
  changedCount: number
}

/** The order a re-sort applies: matching items, sorted. */
export function freshOrder<T, K>(items: readonly T[], opts: StableOptions<T, K>): T[] {
  const include = opts.include ?? (() => true)
  return items.filter(include).sort(opts.compare)
}

/** Lay the live `items` out in the `frozen` order. Items that are gone are skipped (and come back in place if they return). */
export function stableView<T, K>(frozen: readonly T[], items: readonly T[], opts: StableOptions<T, K>): StableView<T> {
  const include = opts.include ?? (() => true)
  const live = new Map(items.map((i) => [opts.key(i), i]))
  const entries: StableEntry<T>[] = []
  for (const was of frozen) {
    const item = live.get(opts.key(was))
    if (item) entries.push({ item, was, stale: !include(item) })
  }

  const fresh = freshOrder(items, opts)
  const shown = new Set(frozen.map(opts.key))
  const rank = new Map(fresh.map((i, n) => [opts.key(i), n]))
  const kept = entries.filter((e) => !e.stale).map((e) => rank.get(opts.key(e.item))!)
  const stale = entries.length - kept.length
  return {
    entries,
    newCount: fresh.filter((i) => !shown.has(opts.key(i))).length,
    // The fewest cards that have to move: everything outside the longest run already in order.
    changedCount: stale + kept.length - longestIncreasing(kept),
  }
}

/** True when a re-sort would change what's on screen. */
export function hasPending(view: StableView<unknown>): boolean {
  return view.newCount > 0 || view.changedCount > 0
}

/** Length of the longest strictly increasing subsequence (patience sorting, O(n log n)). */
export function longestIncreasing(xs: readonly number[]): number {
  const tails: number[] = []
  for (const x of xs) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid]! < x) lo = mid + 1
      else hi = mid
    }
    tails[lo] = x
  }
  return tails.length
}

/** "↑ 2 new", "3 updated", "2 new · 3 updated", or "" when nothing is pending. */
export function pendingLabel(newCount: number, changedCount: number): string {
  if (!changedCount) return newCount ? `↑ ${newCount} new` : ""
  return [newCount && `${newCount} new`, `${changedCount} updated`].filter(Boolean).join(" · ")
}
