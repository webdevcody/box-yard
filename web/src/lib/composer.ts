/**
 * How tall the message box may grow before it scrolls: 45% of the viewport, kept between
 * 160 and 480px. The expand toggle allows 75% of the viewport instead.
 */
export function composerMaxHeight(viewport: number, expanded = false): number {
  if (expanded) return Math.max(160, Math.round(viewport * 0.75))
  return Math.min(480, Math.max(160, Math.round(viewport * 0.45)))
}

/**
 * A phone or tablet: its keyboard is on screen, so the composer lets go of focus after a send.
 * Read from the pointer, not the user agent, so a touch laptop with a mouse keeps typing.
 */
export function isTouchDevice(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse), (hover: none)").matches
}
