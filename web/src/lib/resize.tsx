import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEvent } from "react"
import { cx } from "../components/ui"

type Options = {
  /** localStorage key the width is saved under */
  key: string
  defaultWidth: number
  min: number
  max: number
  /** which edge of the panel the handle sits on: "right" grows the panel when dragged right */
  edge: "left" | "right"
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

function load({ key, defaultWidth, min, max }: Options) {
  const n = Number(localStorage.getItem(key))
  return Number.isFinite(n) && n > 0 ? clamp(n, min, max) : defaultWidth
}

/** A panel width the user can drag, persisted in localStorage. Spread `handle` props onto <ResizeHandle>. */
export function useResizable(opts: Options) {
  const { key, defaultWidth, min, max, edge } = opts
  const [width, setWidth] = useState(() => load(opts))
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: 0 })
  const latest = useRef(width)
  latest.current = width

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
    return () => document.body.classList.remove("resizing")
  }, [dragging])

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, w: latest.current }
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

/** Slim drag strip on a panel border. `className` picks the breakpoint (e.g. "lg:block") where the panel sits beside the content. */
export function ResizeHandle({ dragging, edge, className, ...events }: HandleProps & { className: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize, double-click to reset"
      {...events}
      className={cx(
        "absolute inset-y-0 z-20 hidden w-1.5 cursor-col-resize touch-none transition-colors hover:bg-yard-500/40",
        className,
        edge === "right" ? "-right-[3px]" : "-left-[3px]",
        dragging && "bg-yard-500/60",
      )}
    />
  )
}
