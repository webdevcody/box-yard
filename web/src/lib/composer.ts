/**
 * How tall the message box may grow before it scrolls: 45% of the viewport, kept between
 * 160 and 480px. The expand toggle allows 75% of the viewport instead.
 */
export function composerMaxHeight(viewport: number, expanded = false): number {
  if (expanded) return Math.max(160, Math.round(viewport * 0.75))
  return Math.min(480, Math.max(160, Math.round(viewport * 0.45)))
}
