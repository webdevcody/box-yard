import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react"
import { ArrowDown } from "lucide-react"
import { cx } from "./ui"
import { takeSpot, watchScroll, type LiveSpot } from "../lib/scrollMemory"

// "At the bottom" means within a pixel of it (fractional scroll positions on zoomed or high-DPI
// screens), so even a 1px nudge up counts as leaving it.
const BOTTOM_SLOP_PX = 1

// Start loading earlier items this far before the top is reached.
const LOAD_EARLIER_MARGIN_PX = 800

// After Back/Forward, hold the restored row in place this long while late layout (markdown, images) settles.
const RESTORE_SETTLE_MS = 1000
// Give up on a restore whose list never shows the row (or any content) within this long.
const RESTORE_GIVE_UP_MS = 10_000

// After a send or "Jump to latest", check every frame until the list has sat at the bottom this many frames in a
// row (late layout: the sent message, the composer shrinking back), and give up after this many.
const SETTLE_FRAMES = 20
const SETTLE_MAX_FRAMES = 300
// A glide that hasn't moved for this many frames while short of the bottom has stopped there: finish it.
const STALL_FRAMES = 3

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

/** What a chat view calls after a send: `scrollToEnd()` re-pins the list and glides to the bottom. */
export type StickyScrollHandle = { scrollToEnd: () => void }

// A scroll container that follows new content only while the user is at the very bottom.
// Any scroll up by the user (wheel, trackpad, touch, PageUp/↑/Home, scrollbar drag) unpins at once,
// and it stays unpinned, with the view held still, until they come back to the very bottom or
// press "Jump to latest". Our own scrollTop writes never count as the user scrolling.
// `count` is the number of items; `resetKey` changes when the content is swapped (e.g. another task).
// With `hidden` > 0 (older items not rendered yet), scrolling near the top calls `onLoadEarlier`,
// and the view stays on the same content while they are added above it. `onTrim` is called when items arrive
// while the view is pinned to the bottom, so the list can stop rendering old items again (useTail's `trim`).
// With `restoreKey`, browser Back/Forward to a page puts the list back where it was when that page was left
// (lib/scrollMemory.ts): at the bottom if it was pinned there, else with the same row at the same height.
// `handle.scrollToEnd()` (after a send) re-pins it and smooth-scrolls to the bottom, even from far up.
// `overlay` floats bottom-center over the list, beside "Jump to latest" (the Coordinator cards' "↓ N new"), above
// everything in it (sticky headers included), with room left under the last row so it covers nothing at the bottom.
export function StickyScroll({
  handle,
  count,
  resetKey,
  restoreKey,
  hidden = 0,
  onLoadEarlier,
  onTrim,
  className,
  contentClassName,
  overlay,
  children,
}: {
  handle?: Ref<StickyScrollHandle>
  count: number
  resetKey?: string
  restoreKey?: string
  hidden?: number
  onLoadEarlier?: () => void
  onTrim?: () => void
  className?: string
  contentClassName?: string
  overlay?: ReactNode
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
  // A spot from Back/Forward being put back: `since` it started, `found` when its row (or content) first showed.
  const restoring = useRef<{ spot: LiveSpot; since: number; found: number } | null>(null)
  // Gliding to the bottom after a send: growth follows with a smooth scroll until the bottom is reached.
  const gliding = useRef(false)
  // Checking each frame that a glide really reaches the bottom (see settleFrame).
  const settle = useRef<{ frames: number; quiet: number; still: number; last: number } | null>(null)
  const latest = useRef({ hidden, onLoadEarlier, onTrim })
  latest.current = { hidden, onLoadEarlier, onTrim }

  // Write scrollTop ourselves, remembering where it landed so the scroll event it fires is ignored.
  const setTop = (el: HTMLElement, top: number) => {
    el.scrollTop = top
    lastTop.current = el.scrollTop
  }

  const toBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scroller.current
    if (!el) return
    // Under prefers-reduced-motion a glide is a jump.
    if (behavior === "auto" || reducedMotion()) return setTop(el, el.scrollHeight)
    // From far up, jump to a screen above the bottom and glide only that last stretch.
    const near = el.scrollHeight - 2 * el.clientHeight
    if (el.scrollTop < near) setTop(el, near)
    el.scrollTo({ top: el.scrollHeight, behavior })
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

  // Where the list is now, to come back to: pinned, or the rows at the top of the view.
  const capture = (): LiveSpot => {
    const el = scroller.current
    if (!el) return { bottom: true, fromBottom: 0 }
    const fromBottom = el.scrollHeight - el.scrollTop
    if (stuck.current) return { bottom: true, fromBottom }
    markAnchor()
    const a = anchor.current
    if (!a) return { bottom: false, fromBottom }
    const spot: LiveSpot = { bottom: false, fromBottom, node: a.node, nodeOffset: a.top }
    // A row with an id (a message) finds the same place after a remount, when the element itself is gone.
    const rows = [...content.current!.children]
    const at = rows.indexOf(a.node)
    const withId = rows.slice(at).find((r) => r.id) ?? rows.slice(0, at).reverse().find((r) => r.id)
    if (withId) {
      spot.id = withId.id
      spot.offset = withId.getBoundingClientRect().top - el.getBoundingClientRect().top
    }
    return spot
  }

  const startRestore = (spot: LiveSpot) => {
    restoring.current = { spot, since: performance.now(), found: 0 }
    applyRestore()
  }

  // Put the restoring spot back. Runs again on every layout change until it has held for RESTORE_SETTLE_MS.
  const applyRestore = () => {
    const r = restoring.current
    const el = scroller.current
    const box = content.current
    if (!r || !el || !box) return
    const now = performance.now()
    if (now - (r.found || r.since) > (r.found ? RESTORE_SETTLE_MS : RESTORE_GIVE_UP_MS)) return void (restoring.current = null)
    const { spot } = r
    if (spot.bottom) {
      restoring.current = null
      pin()
      return toBottom()
    }
    const byId = spot.id ? document.getElementById(spot.id) : null
    const row =
      spot.node?.isConnected && box.contains(spot.node)
        ? { node: spot.node, offset: spot.nodeOffset ?? 0 }
        : byId && box.contains(byId)
          ? { node: byId, offset: spot.offset ?? 0 }
          : null
    if (row) {
      setTop(el, el.scrollTop + row.node.getBoundingClientRect().top - el.getBoundingClientRect().top - row.offset)
    } else {
      const { hidden, onLoadEarlier } = latest.current
      // The row is in the older part that isn't rendered yet: render more (the prepend keeps the view), then retry.
      if (spot.id && hidden > 0 && onLoadEarlier) return loadEarlier()
      // Nothing to show yet (the messages are loading): wait for them.
      if (el.scrollHeight - el.clientHeight < BOTTOM_SLOP_PX) return
      setTop(el, el.scrollHeight - spot.fromBottom)
    }
    r.found ||= now
    if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX) return
    stuck.current = false
    setAway(true)
    markAnchor()
  }

  const pin = () => {
    stuck.current = true
    anchor.current = null
    setAway(false)
    setUnread(0)
  }

  const unpin = () => {
    gliding.current = false
    settle.current = null
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
    // Mid-restore, a move the user didn't make (the browser clamping a list that got shorter) is put right.
    if (restoring.current) return applyRestore()
    const atBottom = el.scrollHeight - top - el.clientHeight < BOTTOM_SLOP_PX
    // Back at the very bottom re-pins, and so does the browser pulling scrollTop down to a shorter
    // list's bottom. Any other move up is the user leaving it.
    if (atBottom) {
      gliding.current = false
      if (!stuck.current) pin()
      // Mid-glide, a move up the user didn't make (scroll anchoring as rows are trimmed above) isn't them leaving.
    } else if (moved < 0 && !settle.current) unpin()
    else if (!stuck.current) markAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Read the user's intent straight from their input, ahead of the scroll it causes, so a stream
  // delta landing in between can't snap the view back down.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      restoring.current = null
      if (e.deltaY < 0 && !e.ctrlKey && !innerCanScrollUp(e.target, el)) unpin()
    }
    const onTouchStart = (e: TouchEvent) => {
      restoring.current = null
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
      restoring.current = null
      // A scrollbar drag only shows up as scroll events: let them unpin.
      settle.current = null
      pointerInside.current = true
    }
    const onDocPointerDown = () => {
      pointerInside.current = false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) || isEditable(e.target)) return
      const t = e.target
      if ((t instanceof Node && el.contains(t)) || ((t === document.body || t === document) && pointerInside.current)) {
        restoring.current = null
        unpin()
      }
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

  // Opening or switching to another list starts at the bottom, unless Back/Forward brought it back to a spot.
  useLayoutEffect(() => {
    lastCount.current = count
    const spot = restoreKey ? takeSpot(restoreKey) : null
    if (spot) return startRestore(spot)
    if (restoring.current) return applyRestore()
    pin()
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Take this list's spot when the page changes, and go back to it on Back/Forward while mounted.
  useEffect(() => {
    if (!restoreKey) return
    return watchScroll({
      key: restoreKey,
      capture: () => {
        restoring.current = null
        return capture()
      },
      // The page renders after this: its layout effects (or the next frame) put the spot back.
      restore: (spot) => {
        restoring.current = { spot, since: performance.now(), found: 0 }
        requestAnimationFrame(applyRestore)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreKey])

  // Each render may be the restored page's new layout (Zen's wider column, the messages arriving).
  useLayoutEffect(() => {
    if (restoring.current) applyRestore()
  })

  // Content grew (new items, streaming text, expanding output) or the viewport shrank (a growing
  // composer below it). Pinned: follow the bottom. Unpinned: hold the row being read where it is,
  // for browsers without scroll anchoring (Safari) and changes theirs skips.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const box = scroller.current
      if (!box) return
      if (restoring.current) return applyRestore()
      if (stuck.current) return toBottom(gliding.current ? "smooth" : "auto")
      const a = anchor.current
      if (!a || !a.node.isConnected) return markAnchor()
      const shift = a.node.getBoundingClientRect().top - box.getBoundingClientRect().top - a.top
      if (Math.abs(shift) >= 1) setTop(box, box.scrollTop + shift)
      markAnchor()
    })
    ro.observe(el)
    if (scroller.current) ro.observe(scroller.current)
    // iOS Safari: the on-screen keyboard opening or closing (after a send) changes only the visual
    // viewport, which the observer doesn't see. Pinned, land on the bottom once it has resized.
    const vv = window.visualViewport
    const onViewport = () => {
      if (stuck.current && !restoring.current) toBottom(gliding.current ? "smooth" : "auto")
    }
    vv?.addEventListener("resize", onViewport)
    return () => {
      ro.disconnect()
      vv?.removeEventListener("resize", onViewport)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const added = count - lastCount.current
    lastCount.current = count
    if (added > 0 && !stuck.current) setUnread((n) => n + added)
    // Pinned to the bottom, rows dropped from the top don't move anything on screen.
    if (added > 0 && stuck.current && !restoring.current) latest.current.onTrim?.()
  }, [count])

  const loadEarlier = useCallback(() => {
    const el = scroller.current
    const { hidden, onLoadEarlier } = latest.current
    if (!el || !onLoadEarlier) return
    beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop, hidden }
    onLoadEarlier()
  }, [])

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

  // One frame of a glide's check. A smooth scroll aims at the bottom as it was when it started; layout that lands
  // mid-glide (the sent message, the composer shrinking back, a queued row) retargets it from the resize observer,
  // but Safari drops a retarget while it's animating and the glide stops short. So until the list has sat at the
  // bottom for SETTLE_FRAMES, a glide that has stopped short of it is finished with a jump.
  const settleFrame = (s: NonNullable<typeof settle.current>) => {
    const el = scroller.current
    if (settle.current !== s) return
    if (!el || !stuck.current || restoring.current || ++s.frames > SETTLE_MAX_FRAMES) return void (settle.current = null)
    if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX) {
      gliding.current = false
      s.still = 0
      if (++s.quiet >= SETTLE_FRAMES) return void (settle.current = null)
    } else {
      s.quiet = 0
      s.still = el.scrollTop === s.last ? s.still + 1 : 0
      if (s.still >= STALL_FRAMES) {
        gliding.current = false
        toBottom()
      }
    }
    s.last = el.scrollTop
    requestAnimationFrame(() => settleFrame(s))
  }

  // Re-pin and glide to the bottom, then make sure it gets there.
  const glide = () => {
    restoring.current = null
    pin()
    gliding.current = true
    const s = { frames: 0, quiet: 0, still: 0, last: -1 }
    settle.current = s
    return s
  }

  const jump = () => {
    const s = glide()
    toBottom("smooth")
    requestAnimationFrame(() => settleFrame(s))
  }

  // After a send. Pinning makes the sent message's layout (the resize observer above) carry the list
  // to it whenever it renders; the frame covers a message that's already laid out, and settleFrame
  // lands it on the true bottom once layout settles. Scrolling up again unpins as usual, so the
  // streaming reply doesn't pull the view back down.
  useImperativeHandle(
    handle,
    () => ({
      scrollToEnd: () => {
        const s = glide()
        requestAnimationFrame(() => {
          if (settle.current === s && stuck.current) toBottom("smooth")
          settleFrame(s)
        })
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return (
    <div className="group/sticky relative flex min-h-0 flex-1 flex-col">
      {/* relative z-0: the list is its own stacking context, so what's inside it (the cards' sticky z-20 headers, their
          menus) stays under the overlay, whatever its z-index. */}
      <div ref={scroller} onScroll={onScroll} className={cx("scroll-thin relative z-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto", className)}>
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
        {/* Room under the last row while the overlay shows something, so at the bottom it covers nothing. */}
        <div aria-hidden data-testid="overlay-room" className="hidden h-12 group-has-[[data-overlay]>*]/sticky:block pointer-coarse:h-16" />
      </div>
      {(away || overlay) && (
        <div data-overlay className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 *:pointer-events-auto">
          {overlay}
          {away && (
            <button
              onClick={jump}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-zinc-100 shadow-lg hover:bg-zinc-800"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Jump to latest"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
