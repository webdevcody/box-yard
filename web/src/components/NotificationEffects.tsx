import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useNotifications } from "../lib/queries"
import { markRead, unreadCount, viewingTaskId } from "../lib/notifications"

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb)
  return () => document.removeEventListener("visibilitychange", cb)
}
const isVisible = () => document.visibilityState === "visible"

/**
 * Side effects of notifications, with no UI: the unread count in the tab title, and opening a task
 * (in a visible tab) marks its notifications read.
 */
export function NotificationEffects() {
  const qc = useQueryClient()
  const [location] = useLocation()
  const { data } = useNotifications()
  const visible = useSyncExternalStore(subscribeVisibility, isVisible)
  const unread = unreadCount(data)

  useEffect(() => {
    document.title = unread ? `(${unread}) Box Yard` : "Box Yard"
  }, [unread])

  const viewing = visible ? viewingTaskId(location) : null
  const viewingHasUnread = Boolean(viewing && data?.some((n) => n.taskId === viewing && !n.readAt))
  useEffect(() => {
    if (viewing && viewingHasUnread) void markRead(qc, { taskId: viewing })
  }, [qc, viewing, viewingHasUnread])

  return null
}
