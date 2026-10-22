// Task notifications: a task finished or needs Cody. The server records them (so ones that land while the
// tab is closed still show up) and pushes each over SSE; here they become toasts, the sidebar's Recent
// list, the tab title count and, if Cody opted in, browser notifications.
import type { QueryClient } from "@tanstack/react-query"
import { navigate } from "wouter/use-browser-location"
import { api } from "./api"
import { keys } from "./queries"
import { toast, type ToastTone } from "./toast"
import type { AppNotification, NotifyStatus } from "../../../shared/types"

/** Notifications that land within this window of each other share one toast. */
export const BATCH_MS = 600
/** How many the client keeps (and asks the server for). */
export const RECENT_LIMIT = 50

export const NOTIFY_TONE: Record<NotifyStatus, ToastTone> = {
  failed: "red",
  needs_input: "amber",
  pr_ready: "green",
  done: "neutral",
  idle: "neutral",
}

/** Most urgent first. */
const SEVERITY: NotifyStatus[] = ["failed", "needs_input", "pr_ready", "done", "idle"]
const COUNT_LABEL: Record<NotifyStatus, string> = {
  failed: "failed",
  needs_input: "need you",
  pr_ready: "PR ready",
  done: "done",
  idle: "finished a turn",
}

// ------------------------------------------------------------------ pure helpers

/** Newest first, no duplicates, capped. Leaves an unloaded list alone (the fetch will bring it). */
export function addNotification(list: AppNotification[] | undefined, n: AppNotification): AppNotification[] | undefined {
  if (!list) return list
  if (list.some((x) => x.id === n.id)) return list
  return [n, ...list].slice(0, RECENT_LIMIT)
}

export function applyRead(list: AppNotification[] | undefined, ids: readonly string[], readAt: number): AppNotification[] | undefined {
  if (!list || !ids.length) return list
  const set = new Set(ids)
  let changed = false
  const next = list.map((n) => {
    if (n.readAt || !set.has(n.id)) return n
    changed = true
    return { ...n, readAt }
  })
  return changed ? next : list
}

export const unreadCount = (list: readonly AppNotification[] | undefined) => list?.reduce((k, n) => k + (n.readAt ? 0 : 1), 0) ?? 0

/** Unread ids that a mark-read request would change. */
export function unreadIds(list: readonly AppNotification[] | undefined, by: { ids?: string[]; taskId?: string; all?: boolean }): string[] {
  const want = by.ids ? new Set(by.ids) : null
  return (list ?? []).filter((n) => !n.readAt && (by.all || (by.taskId ? n.taskId === by.taskId : want?.has(n.id)))).map((n) => n.id)
}

/** The task open in the main pane, from a pathname like /tasks/task_abc. */
export function viewingTaskId(pathname: string): string | null {
  return pathname.match(/^\/tasks\/([^/?#]+)/)?.[1] ?? null
}

export type ToastPlan =
  | { kind: "single"; notification: AppNotification }
  | { kind: "batch"; items: AppNotification[]; status: NotifyStatus }

/**
 * Turn a burst of notifications into at most one toast: the newest per task, and nothing for the task
 * Cody is looking at. Several tasks become one "N tasks finished" toast colored by the most urgent.
 */
export function planToast(burst: readonly AppNotification[], viewing: string | null): ToastPlan | null {
  const latest = new Map<string, AppNotification>()
  for (const n of burst) {
    if (n.taskId === viewing || n.readAt) continue
    const prev = latest.get(n.taskId)
    if (!prev || n.createdAt >= prev.createdAt) latest.set(n.taskId, n)
  }
  const items = [...latest.values()].sort((a, b) => b.createdAt - a.createdAt)
  if (!items.length) return null
  if (items.length === 1) return { kind: "single", notification: items[0]! }
  const status = SEVERITY.find((s) => items.some((n) => n.status === s))!
  return { kind: "batch", items, status }
}

/** "1 failed · 2 done", most urgent first. */
export function batchBreakdown(items: readonly AppNotification[]): string {
  return SEVERITY.map((s) => [s, items.filter((n) => n.status === s).length] as const)
    .filter(([, k]) => k > 0)
    .map(([s, k]) => `${k} ${COUNT_LABEL[s]}`)
    .join(" · ")
}

export function toastContent(plan: ToastPlan) {
  if (plan.kind === "single") {
    const n = plan.notification
    return { title: n.title, body: n.summary ?? undefined, href: `/tasks/${n.taskId}`, tone: NOTIFY_TONE[n.status], status: n.status, context: n.projectName }
  }
  return {
    title: `${plan.items.length} tasks finished`,
    body: plan.items.map((n) => n.title).join(", "),
    href: "/?tab=recent",
    tone: NOTIFY_TONE[plan.status],
    status: undefined,
    context: batchBreakdown(plan.items),
  }
}

// ------------------------------------------------------------------ live

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible"
/** The task Cody is actually looking at: open in a visible tab. */
const seenTaskId = () => (isVisible() ? viewingTaskId(window.location.pathname) : null)

/** Mark notifications read, here at once and then on the server (which tells the other tabs). */
export async function markRead(qc: QueryClient, by: { ids?: string[]; taskId?: string; all?: boolean }) {
  const ids = unreadIds(qc.getQueryData<AppNotification[]>(keys.notifications), by)
  if (!ids.length) return
  qc.setQueryData<AppNotification[]>(keys.notifications, (list) => applyRead(list, ids, Date.now()))
  try {
    await api("/api/notifications/read", { body: by.all ? { all: true } : by.taskId ? { taskId: by.taskId } : { ids } })
  } catch {
    void qc.invalidateQueries({ queryKey: keys.notifications })
  }
}

let burst: AppNotification[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** A notification from the server event stream. */
export function receiveNotification(qc: QueryClient, n: AppNotification) {
  qc.setQueryData<AppNotification[]>(keys.notifications, (list) => addNotification(list, n))
  if (n.taskId === seenTaskId()) {
    void markRead(qc, { ids: [n.id] })
    return
  }
  burst.push(n)
  flushTimer ??= setTimeout(() => flush(qc), BATCH_MS)
}

function flush(qc: QueryClient) {
  flushTimer = null
  const plan = planToast(burst, seenTaskId())
  burst = []
  if (!plan) return
  const content = toastContent(plan)
  const taskId = plan.kind === "single" ? plan.notification.taskId : null
  toast.task({ ...content, onOpen: taskId ? () => void markRead(qc, { taskId }) : undefined })
  if (!isVisible()) showBrowserNotification(content.title, [content.context, content.body].filter(Boolean).join(" · "), content.href, () => {
    if (taskId) void markRead(qc, { taskId })
  })
}

// ------------------------------------------------------------------ browser notifications (opt-in)

const BROWSER_KEY = "boxyard:browser-notifications"

export const browserNotificationsSupported = () => typeof window !== "undefined" && "Notification" in window

export function browserNotificationsOn() {
  return browserNotificationsSupported() && localStorage.getItem(BROWSER_KEY) === "1" && Notification.permission === "granted"
}

/** Turn browser notifications on (asks for permission) or off. Returns whether they are on. */
export async function setBrowserNotifications(on: boolean): Promise<boolean> {
  if (!on || !browserNotificationsSupported()) {
    localStorage.removeItem(BROWSER_KEY)
    return false
  }
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
  if (permission !== "granted") return false
  localStorage.setItem(BROWSER_KEY, "1")
  return true
}

function showBrowserNotification(title: string, body: string, href: string, onOpen: () => void) {
  if (!browserNotificationsOn()) return
  try {
    const note = new Notification(title, { body, tag: "box-yard" })
    note.onclick = () => {
      window.focus()
      navigate(href)
      onOpen()
      note.close()
    }
  } catch {
    // Some browsers only allow notifications from a service worker; toasts still show.
  }
}
