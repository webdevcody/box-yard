import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown } from "lucide-react"
import { cx } from "./ui"

// "At the bottom" means within a pixel of it (fractional scroll positions on zoomed or high-DPI
// screens), so even a 1px nudge up counts as leaving it.
const BOTTOM_SLOP_PX = 1

// Start loading earlier items this far before the top is reached.
const LOAD_EARLIER_MARGIN_PX = 800

// Keys that scroll a page up. Shift+Space too.
const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"])

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")

// True if something between `target` and `root` (a code block, a tool output) can scroll up itself
// and would take the wheel or swipe instead of the list.
function innerCanScrollUp(target: EventTarget | null, root: HTMLElement) {
  for (let n = target instanceof Element ? target : null; n && n !== root; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true
  }
  return false
}

// A scroll container that follows new content only while the user is at the very bottom.
// Any scroll up by the user (wheel, trackpad, touch, PageUp/↑/Home, scrollbar drag) unpins at once,
// and it stays unpinned, with the view held still, until they come back to the very bottom or
// press "Jump to latest". Our own scrollTop writes never count as the user scrolling.
// `count` is the number of items; `resetKey` changes when the content is swapped (e.g. another task).
// With `hidden` > 0 (older items not rendered yet), scrolling near the top calls `onLoadEarlier`,
// and the view stays on the same content while they are added above it.
export function StickyScroll({
  count,
  resetKey,
  hidden = 0,
  onLoadEarlier,
  className,
  contentClassName,
  children,
}: {
  count: number
  resetKey?: string
  hidden?: number
  onLoadEarlier?: () => void
  className?: string
  contentClassName?: string
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  // The scrollTop we last saw or wrote. A scroll event that lands here again is our own write.
  const lastTop = useRef(0)
  const lastCount = useRef(count)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  // The last pointerdown was inside this list, so keys pressed on <body> scroll it.
  const pointerInside = useRef(false)
  // A row near the top of the view and its offset, to hold it still while unpinned.
  const anchor = useRef<{ node: Element; top: number } | null>(null)
  const [away, setAway] = useState(false)
  const [unread, setUnread] = useState(0)
  const sentinel = useRef<HTMLButtonElement>(null)
  // Scroll metrics captured just before older items are added above.
  const beforePrepend = useRef<{ height: number; top: number; hidden: number } | null>(null)

  // Write scrollTop ourselves, remembering where it landed so the scroll event it fires is ignored.
  const setTop = (el: HTMLElement, top: number) => {
    el.scrollTop = top
    lastTop.current = el.scrollTop
  }

  const toBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scroller.current
    if (!el) return
    if (behavior === "auto") setTop(el, el.scrollHeight)
    else el.scrollTo({ top: el.scrollHeight, behavior })
  }

  // Remember the first row that reaches into the view and where it sits.
  const markAnchor = () => {
    const el = scroller.current
    const rows = content.current?.children
    if (!el || !rows?.length) return void (anchor.current = null)
    const viewTop = el.getBoundingClientRect().top
    let lo = 0
    let hi = rows.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid]!.getBoundingClientRect().bottom > viewTop) hi = mid
      else lo = mid + 1
    }
    const node = rows[lo]!
    anchor.current = { node, top: node.getBoundingClientRect().top - viewTop }
  }

  const pin = () => {
    stuck.current = true
    anchor.current = null
    setAway(false)
    setUnread(0)
  }

  const unpin = () => {
    const el = scroller.current
    // A list that fits has nowhere to scroll.
    if (!el || el.scrollHeight - el.clientHeight < BOTTOM_SLOP_PX) return
    if (stuck.current) {
      stuck.current = false
      setAway(true)
    }
    markAnchor()
  }

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    const moved = top - lastTop.current
    lastTop.current = top
    // Our own write (or nothing moved): it says nothing about what the user wants.
    if (moved === 0) return
    const atBottom = el.scrollHeight - top - el.clientHeight < BOTTOM_SLOP_PX
    // Back at the very bottom re-pins, and so does the browser pulling scrollTop down to a shorter
    // list's bottom. Any other move up is the user leaving it.
    if (atBottom) {
      if (!stuck.current) pin()
    } else if (moved < 0) unpin()
    else if (!stuck.current) markAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Read the user's intent straight from their input, ahead of the scroll it causes, so a stream
  // delta landing in between can't snap the view back down.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !e.ctrlKey && !innerCanScrollUp(e.target, el)) unpin()
    }
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]
      touchStart.current = t ? { x: t.clientX, y: t.clientY } : null
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      const from = touchStart.current
      if (!t || !from) return
      const dx = t.clientX - from.x
      const dy = t.clientY - from.y
      // A finger moving down drags the content up.
      if (dy > 0 && dy >= Math.abs(dx) && !innerCanScrollUp(e.target, el)) unpin()
    }
    const onPointerDown = () => {
      pointerInside.current = true
    }
    const onDocPointerDown = () => {
      pointerInside.current = false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) || isEditable(e.target)) return
      const t = e.target
      if ((t instanceof Node && el.contains(t)) || ((t === document.body || t === document) && pointerInside.current)) unpin()
    }
    const passive = { passive: true }
    el.addEventListener("wheel", onWheel, passive)
    el.addEventListener("touchstart", onTouchStart, passive)
    el.addEventListener("touchmove", onTouchMove, passive)
    el.addEventListener("pointerdown", onPointerDown)
    // Capture runs before the list's own listener, which then sets it back for clicks inside.
    document.addEventListener("pointerdown", onDocPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("pointerdown", onDocPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opening or switching to another list starts at the bottom.
  useLayoutEffect(() => {
    lastCount.current = count
    pin()
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Content grew (new items, streaming text, expanding output) or the viewport shrank (a growing
  // composer below it). Pinned: follow the bottom. Unpinned: hold the row being read where it is,
  // for browsers without scroll anchoring (Safari) and changes theirs skips.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const box = scroller.current
      if (!box) return
      if (stuck.current) return toBottom()
      const a = anchor.current
      if (!a || !a.node.isConnected) return markAnchor()
      const shift = a.node.getBoundingClientRect().top - box.getBoundingClientRect().top - a.top
      if (Math.abs(shift) >= 1) setTop(box, box.scrollTop + shift)
      markAnchor()
    })
    ro.observe(el)
    if (scroller.current) ro.observe(scroller.current)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const added = count - lastCount.current
    lastCount.current = count
    if (added > 0 && !stuck.current) setUnread((n) => n + added)
  }, [count])

  const loadEarlier = useCallback(() => {
    const el = scroller.current
    if (!el || !onLoadEarlier) return
    beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop, hidden }
    onLoadEarlier()
  }, [onLoadEarlier, hidden])

  // Keep what's on screen in place when older items appear above it.
  useLayoutEffect(() => {
    const el = scroller.current
    const prev = beforePrepend.current
    if (!el || !prev || prev.hidden === hidden) return
    beforePrepend.current = null
    if (stuck.current) return
    setTop(el, prev.top + (el.scrollHeight - prev.height))
    markAnchor()
  })

  // Load earlier items before the reader reaches the top.
  useEffect(() => {
    const el = sentinel.current
    const root = scroller.current
    if (!el || !root || !hidden) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadEarlier(), {
      root,
      rootMargin: `${LOAD_EARLIER_MARGIN_PX}px 0px 0px 0px`,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hidden, loadEarlier])

  const jump = () => {
    pin()
    toBottom("smooth")
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className={cx("scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto", className)}>
        <div ref={content} className={contentClassName}>
          {hidden > 0 && (
            <button
              ref={sentinel}
              type="button"
              onClick={loadEarlier}
              className="block w-full py-1 text-center text-xs text-zinc-500 hover:text-zinc-300"
            >
              Show {hidden} earlier message{hidden === 1 ? "" : "s"}
            </button>
          )}
          {children}
        </div>
      </div>
      {away && (
        <button
          onClick={jump}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg hover:bg-zinc-800"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Jump to latest"}
        </button>
      )}
    </div>
  )
}
