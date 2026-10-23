import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown } from "lucide-react"
import { cx } from "./ui"

const NEAR_BOTTOM_PX = 80

// Start loading earlier items this far before the top is reached.
const LOAD_EARLIER_MARGIN_PX = 800

// A scroll container that follows new content only while the user is at (or near) the bottom.
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
  const lastTop = useRef(0)
  const lastCount = useRef(count)
  const [away, setAway] = useState(false)
  const [unread, setUnread] = useState(0)
  const sentinel = useRef<HTMLButtonElement>(null)
  // Scroll metrics captured just before older items are added above.
  const beforePrepend = useRef<{ height: number; top: number; hidden: number } | null>(null)

  const toBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    const up = el.scrollTop < lastTop.current
    lastTop.current = el.scrollTop
    // Only scrolling up unpins. The viewport shrinking (a growing composer) can leave a late scroll
    // event off the bottom; the resize observer below pulls the list back down.
    if (near) stuck.current = true
    else if (up) stuck.current = false
    setAway(!stuck.current)
    if (stuck.current) setUnread(0)
  }, [])

  // Opening or switching to another list starts at the bottom.
  useLayoutEffect(() => {
    stuck.current = true
    lastCount.current = count
    setAway(false)
    setUnread(0)
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Content grew (new items, streaming text, expanding output) or the viewport shrank (a growing
  // composer below it): follow only if pinned to the bottom.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stuck.current) toBottom()
    })
    ro.observe(el)
    if (scroller.current) ro.observe(scroller.current)
    return () => ro.disconnect()
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
    if (!stuck.current) el.scrollTop = prev.top + (el.scrollHeight - prev.height)
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
    stuck.current = true
    setAway(false)
    setUnread(0)
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
