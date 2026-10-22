// useStableOrder: a list that sorts once and then holds still while live updates stream in.
//
// When it re-sorts:
// - on mount (navigating to the page, switching tabs) and whenever `resetKey` changes (sort, filter, search);
// - when the user clicks the Re-sort pill (`resort`);
// - while the browser tab is hidden, so you come back to a fresh order;
// - on its own only when the list is left alone: the pointer isn't over it, nothing in it has focus, its scroller
//   is at the top, and it has been IDLE_MS since the last re-sort and since the user last touched the list.
//   So cards move at most every IDLE_MS, and never while you hover, tab through or scroll the cards.
// Cards that move slide to their new spot (FLIP), unless the user prefers reduced motion.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { freshOrder, hasPending, stableView, type StableOptions, type StableView } from "./stableOrder"

export const IDLE_MS = 20_000
const KEY_ATTR = "data-stable-key"

export interface StableOrder<T> extends StableView<T> {
  /** Apply the current order now (the Re-sort pill). */
  resort: () => void
  /** Attach to the element around the cards (and the pill). Each card needs `data-stable-key={key}`. */
  listRef: (el: HTMLElement | null) => void
}

export function useStableOrder<T, K>(items: readonly T[], opts: StableOptions<T, K> & { resetKey?: unknown }): StableOrder<T> {
  const [state, setState] = useState(() => ({ frozen: freshOrder(items, opts), resetKey: opts.resetKey }))
  const [el, setEl] = useState<HTMLElement | null>(null)
  const flip = useRef<Map<string, DOMRect> | null>(null)
  const quietSince = useRef(Date.now())
  const latest = useRef({ items, opts })
  latest.current = { items, opts }

  let frozen = state.frozen
  if (!Object.is(state.resetKey, opts.resetKey)) {
    // Sort or filter changed: that is an explicit re-sort.
    flip.current = measure(el)
    frozen = freshOrder(items, opts)
    setState({ frozen, resetKey: opts.resetKey })
  }
  let view = stableView(frozen, items, opts)
  if (view.entries.length === 0 && view.newCount > 0) {
    // Nothing on screen yet (first load, or everything left): nothing can jump, so take the fresh order.
    frozen = freshOrder(items, opts)
    setState({ frozen, resetKey: opts.resetKey })
    view = stableView(frozen, items, opts)
  }

  const apply = useCallback(
    (animate: boolean) => {
      if (animate) flip.current = measure(el)
      const { items, opts } = latest.current
      setState((s) => ({ ...s, frozen: freshOrder(items, opts) }))
    },
    [el],
  )

  const resort = useCallback(() => {
    apply(true)
    // New items usually land at the top; bring it into view if the user scrolled past it.
    if (el && el.getBoundingClientRect().top < viewportTop(scrollerOf(el)))
      el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" })
  }, [apply, el])

  // FLIP: cards start where they were and slide to where they are now.
  useLayoutEffect(() => {
    const before = flip.current
    flip.current = null
    if (!before || !el) return
    for (const card of el.querySelectorAll<HTMLElement>(`[${KEY_ATTR}]`)) {
      const was = before.get(card.getAttribute(KEY_ATTR)!)
      const now = card.getBoundingClientRect()
      if (!was) {
        card.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" })
        continue
      }
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      card.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 250, easing: "cubic-bezier(0.2, 0, 0, 1)" })
    }
  })

  const pending = hasPending(view)
  useEffect(() => {
    quietSince.current = Date.now()
  }, [state.frozen])

  // Re-sort while the tab is hidden: nobody is looking, and coming back shows a fresh order.
  useEffect(() => {
    if (!pending) return
    const onVisibility = () => document.hidden && apply(false)
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [pending, apply])

  // Re-sort on its own only when the list is left alone: not hovered, not focused, scrolled to the top.
  useEffect(() => {
    if (!pending || !el) return
    const scroller = scrollerOf(el)
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = () => !el.matches(":hover") && !el.matches(":focus-within") && scroller.scrollTop < 4 && !document.hidden
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle() && apply(true), Math.max(0, quietSince.current + IDLE_MS - Date.now()))
    }
    const touched = () => {
      quietSince.current = Date.now()
      schedule()
    }
    schedule()
    const target = scroller === document.scrollingElement ? window : scroller
    el.addEventListener("pointerleave", touched)
    el.addEventListener("focusout", touched)
    target.addEventListener("scroll", touched, { passive: true })
    return () => {
      clearTimeout(timer)
      el.removeEventListener("pointerleave", touched)
      el.removeEventListener("focusout", touched)
      target.removeEventListener("scroll", touched)
    }
  }, [pending, el, apply])

  return { ...view, resort, listRef: setEl }
}

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Where each card is now, keyed by `data-stable-key`; null when there is nothing to animate. */
function measure(el: HTMLElement | null): Map<string, DOMRect> | null {
  if (!el || reducedMotion()) return null
  const rects = new Map<string, DOMRect>()
  for (const card of el.querySelectorAll<HTMLElement>(`[${KEY_ATTR}]`)) rects.set(card.getAttribute(KEY_ATTR)!, card.getBoundingClientRect())
  return rects
}

function viewportTop(scroller: HTMLElement) {
  return scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
}

/** The nearest scrolling ancestor (the main pane in the app), or the document. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === "auto" || overflowY === "scroll") return p
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}
