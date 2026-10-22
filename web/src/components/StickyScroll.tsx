import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown } from "lucide-react"
import { cx } from "./ui"

const NEAR_BOTTOM_PX = 80

// A scroll container that follows new content only while the user is at (or near) the bottom.
// `count` is the number of items; `resetKey` changes when the content is swapped (e.g. another task).
export function StickyScroll({
  count,
  resetKey,
  className,
  contentClassName,
  children,
}: {
  count: number
  resetKey?: string
  className?: string
  contentClassName?: string
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const lastCount = useRef(count)
  const [away, setAway] = useState(false)
  const [unread, setUnread] = useState(0)

  const toBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    stuck.current = near
    setAway(!near)
    if (near) setUnread(0)
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

  // Content grew (new items, streaming text, expanding output): follow only if pinned to the bottom.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stuck.current) toBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const added = count - lastCount.current
    lastCount.current = count
    if (added > 0 && !stuck.current) setUnread((n) => n + added)
  }, [count])

  const jump = () => {
    stuck.current = true
    setAway(false)
    setUnread(0)
    toBottom("smooth")
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto", className)}>
        <div ref={content} className={contentClassName}>
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
