import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react"
import { Link } from "wouter"
import { FolderGit2, FolderOpen } from "lucide-react"
import type { Project } from "../../../shared/types"
import { useReorderProjects } from "../lib/queries"
import { applyOrder, dropIndex, movedAnnouncement, moveItem, shiftFor } from "../lib/projectOrder"
import { onSuspend } from "../lib/resume"
import { cx } from "./ui"
import { IS_MAC } from "./CommandPalette"

/** A sidebar row: Yard, Inbox… and each project. */
export const navItem = (active: boolean) =>
  cx(
    "flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition lg:min-h-0 lg:px-2.5 lg:py-1.5",
    active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
  )

/** A mouse drag starts after this many pixels, so a plain click still navigates. */
const MOUSE_SLOP = 4
/** Touch drags start with a long press; moving further than this first means the finger is scrolling. */
const TOUCH_SLOP = 8
const LONG_PRESS_MS = 350
/** How long rows take to slide aside and the dropped row to settle into its slot. */
const SETTLE_MS = 160
const EDGE = 32

const HINT_ID = "project-reorder-hint"
const ALT = IS_MAC ? "Option" : "Alt"

interface Drag {
  id: string
  ids: string[]
  from: number
  to: number
  /** How far the held row has moved from its own slot (pointer travel plus list scroll). */
  dy: number
  /** Distance between two rows' tops, and where the held row started (for the placeholder). */
  pitch: number
  top: number
  height: number
  /** Dropped or cancelled: everything slides into place before the order is committed. */
  settling: boolean
}

interface Press {
  id: string
  pointerId: number
  touch: boolean
  x: number
  y: number
  scroll: number
  el: HTMLElement
  timer: number
  active: boolean
  lastY: number
}

/**
 * The sidebar's project rows, in the owner's saved order. Drag a row to move it (a long press on touch, so scrolling
 * is never hijacked), or focus it and press Alt+↑/↓. Rows slide aside with transforms only, so nothing else in the
 * sidebar moves, and the new order is committed in the same render that drops the transforms.
 */
export const ProjectList = memo(function ProjectList({
  projects,
  location,
  active,
  attention,
  onNavigate,
  onCreate,
}: {
  projects: Project[] | undefined
  location: string
  active: ReadonlyMap<string, number>
  attention: ReadonlySet<string>
  onNavigate?: () => void
  onCreate: () => void
}) {
  const { mutate: save } = useReorderProjects()
  // The order just dropped, shown until the cache catches up (the mutation writes it a few microtasks later).
  const [optimistic, setOptimistic] = useState<string[] | null>(null)
  useEffect(() => setOptimistic(null), [projects])
  const list = optimistic && projects ? applyOrder(projects, optimistic) : projects
  const listRef = useRef(list)
  listRef.current = list

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const press = useRef<Press | null>(null)
  const swallowClick = useRef(false)
  const rows = useRef(new Map<string, HTMLAnchorElement>())
  const scroller = useRef<HTMLDivElement>(null)
  const refocus = useRef<string | null>(null)
  const frame = useRef(0)
  const [announcement, setAnnouncement] = useState("")

  const update = (d: Drag | null) => {
    dragRef.current = d
    setDrag(d)
  }

  /** Save a new order: shown at once, rolled back with a toast if the server refuses. */
  const commit = useCallback(
    (ids: string[], moved: Project, position: number) => {
      setOptimistic(ids)
      setAnnouncement(movedAnnouncement(moved.name, position + 1, ids.length))
      save(ids, { onError: () => setOptimistic(null) })
    },
    [save],
  )

  useLayoutEffect(() => {
    if (!refocus.current) return
    rows.current.get(refocus.current)?.focus()
    refocus.current = null
  })

  // ---------------------------------------------------------------- pointer and touch

  const endPress = useCallback(() => {
    const p = press.current
    if (!p) return
    window.clearTimeout(p.timer)
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (p.el.hasPointerCapture?.(p.pointerId)) p.el.releasePointerCapture(p.pointerId)
    press.current = null
  }, [])

  const finish = useCallback(
    (drop: boolean) => {
      const d = dragRef.current
      endPress()
      if (!d || d.settling) return
      const to = drop ? d.to : d.from
      update({ ...d, to, dy: (to - d.from) * d.pitch, settling: true })
      window.setTimeout(() => {
        const current = listRef.current ?? []
        const ids = current.map((p) => p.id)
        const moved = current.find((p) => p.id === d.id)
        if (to !== d.from && moved && ids.join() === d.ids.join()) commit(moveItem(ids, d.from, to), moved, to)
        update(null)
      }, SETTLE_MS)
    },
    [commit, endPress],
  )

  /** Where the held row is now, from the pointer and how far the list has scrolled since the press. */
  const track = useCallback((clientY: number) => {
    const p = press.current
    const d = dragRef.current
    if (!p || !d || d.settling) return
    p.lastY = clientY
    const dy = clientY - p.y + (scroller.current?.scrollTop ?? 0) - p.scroll
    const lo = -d.from * d.pitch
    const hi = (d.ids.length - 1 - d.from) * d.pitch
    const clamped = Math.max(lo, Math.min(hi, dy))
    update({ ...d, dy: clamped, to: dropIndex(d.from, clamped, d.pitch, d.ids.length) })
  }, [])

  // Near the list's top or bottom edge, a held row scrolls the list (only while it is there).
  const autoscroll = useCallback(() => {
    if (frame.current) return
    const step = () => {
      const el = scroller.current
      const p = press.current
      frame.current = 0
      if (!el || !p?.active || el.scrollHeight <= el.clientHeight) return
      const box = el.getBoundingClientRect()
      const speed = p.lastY < box.top + EDGE ? -6 : p.lastY > box.bottom - EDGE ? 6 : 0
      const before = el.scrollTop
      if (speed) el.scrollTop += speed
      if (el.scrollTop === before) return
      track(p.lastY)
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [track])

  const start = useCallback(() => {
    const p = press.current
    const current = listRef.current
    if (!p || !current || current.length < 2) return
    const from = current.findIndex((x) => x.id === p.id)
    const el = rows.current.get(p.id)
    if (from < 0 || !el) return
    const first = rows.current.get(current[0]!.id)!
    const second = rows.current.get(current[1]!.id)!
    p.active = true
    swallowClick.current = true
    try {
      p.el.setPointerCapture(p.pointerId)
    } catch {
      // The pointer is already gone; pointerup ends the press.
    }
    if (p.touch) navigator.vibrate?.(10)
    update({
      id: p.id,
      ids: current.map((x) => x.id),
      from,
      to: from,
      dy: 0,
      pitch: second.offsetTop - first.offsetTop,
      top: el.offsetTop,
      height: el.offsetHeight,
      settling: false,
    })
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current
      if (!p || e.pointerId !== p.pointerId) return
      if (p.active) {
        e.preventDefault()
        track(e.clientY)
        autoscroll()
        return
      }
      const far = Math.hypot(e.clientX - p.x, e.clientY - p.y)
      if (p.touch && far > TOUCH_SLOP) endPress()
      else if (!p.touch && far > MOUSE_SLOP) start()
    }
    const onUp = (e: PointerEvent) => {
      const p = press.current
      if (!p || e.pointerId !== p.pointerId) return
      if (p.active) {
        finish(true)
        // Only the click this release makes is swallowed (touch ones can trail the release).
        window.setTimeout(() => (swallowClick.current = false), p.touch ? 400 : 0)
      } else endPress()
    }
    const onCancel = (e: PointerEvent) => {
      const p = press.current
      if (!p || e.pointerId !== p.pointerId) return
      if (p.active) finish(false)
      else endPress()
    }
    // Once a long press has picked a row up, the finger moves it instead of scrolling the page.
    const onTouchMove = (e: TouchEvent) => {
      if (press.current?.active && e.cancelable) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && press.current?.active) {
        e.preventDefault()
        finish(false)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("touchmove", onTouchMove, { passive: false })
    window.addEventListener("keydown", onKey)
    // A press can't outlive the page going to the background: iOS may never send its pointerup, and a press
    // left active would keep cancelling every touchmove, so nothing in the app would scroll.
    const offSuspend = onSuspend(() => press.current && (press.current.active ? finish(false) : endPress()))
    return () => {
      offSuspend()
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("keydown", onKey)
      endPress()
    }
  }, [autoscroll, endPress, finish, start, track])

  const onPointerDown = (e: ReactPointerEvent<HTMLAnchorElement>, id: string) => {
    swallowClick.current = false
    // Another finger while a press is held: that press lost its pointerup (a system gesture took it). Drop it.
    const stale = press.current
    if (stale && stale.pointerId !== e.pointerId) {
      if (stale.active) finish(false)
      else endPress()
    }
    if (press.current || dragRef.current) return
    // Modified clicks open a new tab or window: leave them to the link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const touch = e.pointerType !== "mouse"
    press.current = {
      id,
      pointerId: e.pointerId,
      touch,
      x: e.clientX,
      y: e.clientY,
      lastY: e.clientY,
      scroll: scroller.current?.scrollTop ?? 0,
      el: e.currentTarget,
      active: false,
      timer: touch ? window.setTimeout(start, LONG_PRESS_MS) : 0,
    }
  }

  // ---------------------------------------------------------------- keyboard

  const onKeyDown = (e: ReactKeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    e.preventDefault()
    e.stopPropagation()
    const current = listRef.current
    if (!current || dragRef.current) return
    const to = index + (e.key === "ArrowUp" ? -1 : 1)
    const moved = current[index]!
    if (to < 0 || to >= current.length) {
      setAnnouncement(`${moved.name} is already ${to < 0 ? "first" : "last"}`)
      return
    }
    refocus.current = moved.id
    commit(moveItem(current.map((p) => p.id), index, to), moved, to)
  }

  // ---------------------------------------------------------------- render

  const rowStyle = (index: number, id: string): CSSProperties | undefined => {
    if (!drag) return undefined
    const transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, transition: drag.settling ? transition : "none", zIndex: 10, position: "relative" }
    const shift = shiftFor(index, drag.from, drag.to)
    return { transform: shift ? `translateY(${shift * drag.pitch}px)` : undefined, transition }
  }

  return (
    <div
      ref={scroller}
      className="scroll-thin flex-1 overflow-y-auto px-2"
      onClick={onNavigate}
      onClickCapture={(e) => {
        // The click that ends a drag isn't a navigation.
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {list?.length === 0 && (
        <button onClick={onCreate} className="min-h-11 w-full rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-left text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300">
          No projects yet. Create one, or just ask the Coordinator.
        </button>
      )}
      <div className="relative space-y-0.5">
        {drag && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 rounded-lg border border-dashed border-yard-500/60 bg-yard-500/5"
            style={{ top: drag.top, height: drag.height, transform: `translateY(${(drag.to - drag.from) * drag.pitch}px)`, transition: `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)` }}
          />
        )}
        {list?.map((p, i) => {
          const href = `/projects/${p.id}`
          const n = active.get(p.id) ?? 0
          const held = drag?.id === p.id
          return (
            <Link
              key={p.id}
              href={href}
              ref={(el: HTMLAnchorElement | null) => {
                if (el) rows.current.set(p.id, el)
                else rows.current.delete(p.id)
              }}
              draggable={false}
              aria-describedby={HINT_ID}
              onPointerDown={(e: ReactPointerEvent<HTMLAnchorElement>) => onPointerDown(e, p.id)}
              onKeyDown={(e: ReactKeyboardEvent<HTMLAnchorElement>) => onKeyDown(e, i)}
              onContextMenu={(e: ReactMouseEvent) => press.current?.touch && e.preventDefault()}
              style={rowStyle(i, p.id)}
              className={cx(
                navItem(location.startsWith(href)),
                "select-none [-webkit-touch-callout:none]",
                held && "cursor-grabbing bg-zinc-800 text-zinc-50 shadow-lg ring-1 shadow-black/40 ring-zinc-700",
              )}
            >
              {p.repo ? <FolderGit2 className="h-4 w-4 shrink-0" /> : <FolderOpen className="h-4 w-4 shrink-0" />}
              <span className="truncate">{p.name}</span>
              {attention.has(p.id) && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-400" title="A task needs you" />}
              {!attention.has(p.id) && n > 0 && <span className="ml-auto text-xs text-sky-400">{n}</span>}
            </Link>
          )
        })}
      </div>
      <span id={HINT_ID} className="sr-only">
        Drag to reorder, or press {ALT}+Up or {ALT}+Down.
      </span>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
})
