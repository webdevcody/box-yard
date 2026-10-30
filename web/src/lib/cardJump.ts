// The Cards view's "N new" pill (components/CoordinatorCards.tsx NewCardsPill): which card with news it goes to next,
// and whether that card is above or below what's on screen, so its arrow points the way it will scroll.

/**
 * The card the pill goes to next: the first card with news after `last` (the one it went to before) in the cards'
 * order, wrapping to the top. `order` is every card's key top to bottom; `fresh` the ones with news, in that order.
 */
export function nextJump(order: readonly string[], fresh: readonly string[], last: string | null): string | null {
  if (!fresh.length) return null
  const at = last ? order.indexOf(last) : -1
  return fresh.find((k) => order.indexOf(k) > at) ?? fresh[0]!
}

export type JumpDirection = "up" | "down" | "here"

/**
 * Where a card is against the scroller's visible part: wholly above it, below it, or (any of it) on screen. `bottomInset`
 * is what the pill covers at the bottom, so a card hidden under it counts as below.
 */
export function jumpDirection(card: { top: number; bottom: number }, view: { top: number; bottom: number }, bottomInset = 0): JumpDirection {
  if (card.bottom <= view.top) return "up"
  if (card.top >= view.bottom - bottomInset) return "down"
  return "here"
}

/** The nearest ancestor that scrolls vertically (the chat's StickyScroll), or null. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === "auto" || y === "scroll") return p
  }
  return null
}
