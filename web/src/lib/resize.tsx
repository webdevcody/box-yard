import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEvent } from "react"
import { cx } from "../components/ui"
import { onSuspend } from "./resume"

type Options = {
  /** localStorage key the width is saved under */
  key: string
  defaultWidth: number
  min: number
  max: number
  /** which edge of the panel the handle sits on: "right" grows the panel when dragged right */
  edge: "left" | "right"
  /** a tighter max for now (the room left in the window); the saved width isn't clamped to it until a drag */
  limit?: number
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

function load({ key, defaultWidth, min, max }: Options) {
  const n = Number(localStorage.getItem(key))
  return Number.isFinite(n) && n > 0 ? clamp(n, min, max) : defaultWidth
}

/** A panel width the user can drag, persisted in localStorage. Spread `handle` props onto <ResizeHandle>. */
export function useResizable(opts: Options) {
  const { key, defaultWidth, min, edge } = opts
  const max = Math.max(min, Math.min(opts.max, opts.limit ?? opts.max))
  const [width, setWidth] = useState(() => load(opts))
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: 0 })
  const latest = useRef(width)
  latest.current = width
  const maxRef = useRef(max)
  maxRef.current = max

  const save = (w: number) => {
    try {
      if (w === defaultWidth) localStorage.removeItem(key)
      else localStorage.setItem(key, String(w))
    } catch {
      /* storage unavailable: the width just won't persist */
    }
  }

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add("resizing")
    // A drag whose pointerup never came (the page went to the background) ends there.
    const offSuspend = onSuspend(() => setDragging(false))
    return () => {
      offSuspend()
      document.body.classList.remove("resizing")
    }
  }, [dragging])

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // Start from the width on screen, which may be the saved one shrunk to fit.
    start.current = { x: e.clientX, w: clamp(latest.current, min, maxRef.current) }
    setDragging(true)
  }, [])

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    const dx = e.clientX - start.current.x
    setWidth(clamp(start.current.w + (edge === "right" ? dx : -dx), min, max))
  }

  const stop = () => {
    if (!dragging) return
    setDragging(false)
    save(latest.current)
  }

  const reset = () => {
    setWidth(defaultWidth)
    save(defaultWidth)
  }

  const handle = { dragging, edge, onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop, onDoubleClick: reset }
  return { width, handle }
}

type HandleProps = ReturnType<typeof useResizable>["handle"]

/**
 * Slim drag strip on a panel border. `className` picks the breakpoint (e.g. "lg:block") where the panel sits beside the
 * content. `inside` keeps the strip within the panel, for a panel that clips its overflow.
 */
export function ResizeHandle({ dragging, edge, className, inside, ...events }: HandleProps & { className: string; inside?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize, double-click to reset"
      {...events}
      className={cx(
        "absolute inset-y-0 z-20 hidden w-1.5 cursor-col-resize touch-none transition-colors hover:bg-yard-500/40",
        className,
        edge === "right" ? (inside ? "right-0" : "-right-[3px]") : inside ? "left-0" : "-left-[3px]",
        dragging && "bg-yard-500/60",
      )}
    />
  )
}

/** An element's width in px, kept current while it's mounted; undefined until measured. */
export function useElementWidth(el: Element | null | undefined): number | undefined {
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}
