import { useEffect, useState } from "react"
import { Link, useLocation } from "wouter"
import { CheckCheck, ChevronDown, ChevronRight } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNotifications } from "../lib/queries"
import { markRead, unreadCount } from "../lib/notifications"
import { followAppLink } from "../lib/linkify"
import { useStoredFlag } from "./TaskHeader"
import { STATUS, cx, timeAgo } from "./ui"

/** How many notifications the sidebar shows; the rest are a "View all" away. */
const SHOWN = 8

/**
 * The sidebar's "Recent" list: the last few tasks that finished or need Cody. It reads the notifications
 * query on its own, so a new notification re-renders this section and not the whole sidebar.
 */
export function RecentActivity({ onNavigate }: { onNavigate?: () => void }) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const { data } = useNotifications()
  const [collapsed, setCollapsed] = useStoredFlag("boxyard:recent-collapsed")
  const now = useNow(30_000)
  const items = data?.slice(0, SHOWN) ?? []
  const unread = unreadCount(data)

  return (
    <section className="shrink-0 border-t border-zinc-900 px-2 pt-2 pb-1.5" aria-label="Recent activity">
      <div className="flex items-center gap-1 px-2 pb-1">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="-ml-1 flex items-center gap-1 rounded text-[11px] font-semibold tracking-wider text-zinc-500 uppercase hover:text-zinc-300"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Recent
          {unread > 0 && (
            <span className="ml-1 rounded-full bg-yard-500 px-1.5 text-[10px] font-bold tracking-normal text-zinc-950" title={`${unread} unread`}>
              {unread}
            </span>
          )}
        </button>
        {!collapsed && (
          <span className="ml-auto flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markRead(qc, { all: true })}
                title="Mark all read"
                aria-label="Mark all read"
                className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </button>
            )}
            <Link href="/?tab=recent" onClick={onNavigate} className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
              View all
            </Link>
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="scroll-thin max-h-[min(13rem,28vh)] space-y-px overflow-y-auto">
          {items.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-600">Finished tasks show up here.</div>}
          {items.map((n) => {
            const href = `/tasks/${n.taskId}`
            return (
              <a
                key={n.id}
                href={href}
                onClick={(e) => {
                  followAppLink(e, href, navigate)
                  void markRead(qc, { taskId: n.taskId })
                  onNavigate?.()
                }}
                title={[`${n.title} · ${STATUS[n.status].label}`, n.projectName, n.summary].filter(Boolean).join("\n")}
                className={cx(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs transition hover:bg-zinc-900",
                  n.readAt ? "text-zinc-500 hover:text-zinc-300" : "font-semibold text-zinc-100",
                )}
              >
                <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[n.status].dot)} />
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                <span className="shrink-0 font-normal text-zinc-600">{timeAgo(n.createdAt, now).replace(" ago", "")}</span>
              </a>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** The current time, refreshed every `ms`, for relative times in a list (one timer, not one per row). */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
