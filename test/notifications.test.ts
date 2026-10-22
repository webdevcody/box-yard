import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { shouldNotify, TASK_STATUSES, type AppNotification, type TaskStatus } from "../shared/types.js"
import {
  BATCH_MS,
  RECENT_LIMIT,
  addNotification,
  applyRead,
  batchBreakdown,
  planToast,
  receiveNotification,
  toastContent,
  unreadCount,
  unreadIds,
  viewingTaskId,
} from "../web/src/lib/notifications.js"
import { keys } from "../web/src/lib/queries.js"
import { MAX_TOASTS, TASK_TOAST_MS, currentToasts, dismiss, pauseToasts, resumeToasts, toast } from "../web/src/lib/toast.js"
import { tmpDir } from "./helpers.js"

const note = (id: string, taskId: string, status: AppNotification["status"], createdAt = 1, readAt: number | null = null): AppNotification => ({
  id,
  taskId,
  projectId: "prj_1",
  title: `Task ${taskId}`,
  projectName: "site",
  status,
  summary: null,
  createdAt,
  readAt,
})

describe("which status changes notify", () => {
  it("running work landing on a finished or attention status", () => {
    for (const prev of ["queued", "starting", "working"] as TaskStatus[]) {
      expect(shouldNotify(prev, "done")).toBe(true)
      expect(shouldNotify(prev, "pr_ready")).toBe(true)
      expect(shouldNotify(prev, "needs_input")).toBe(true)
      expect(shouldNotify(prev, "failed")).toBe(true)
    }
  })

  it("idle only after a turn actually ran", () => {
    expect(shouldNotify("working", "idle")).toBe(true)
    expect(shouldNotify("queued", "idle")).toBe(false)
    expect(shouldNotify("starting", "idle")).toBe(false)
  })

  it("never for statuses that start work or wait, or for no change", () => {
    for (const prev of TASK_STATUSES) {
      for (const next of ["queued", "starting", "working", "waiting"] as TaskStatus[]) expect(shouldNotify(prev, next)).toBe(false)
      expect(shouldNotify(prev, prev)).toBe(false)
    }
  })

  it("never from a resting status (e.g. Cody closing an idle task)", () => {
    for (const prev of ["idle", "pr_ready", "needs_input", "failed", "waiting", "done"] as TaskStatus[])
      for (const next of ["done", "pr_ready", "needs_input", "failed", "idle"] as TaskStatus[]) expect(shouldNotify(prev, next)).toBe(false)
  })
})

describe("notifications in the store", () => {
  const setup = () => {
    const s = new Store(openDb(tmpDir()))
    const p = s.createProject({ name: "site" })
    const t = s.createTask({ projectId: p.id, title: "Fix login", prompt: "p" })
    const fired: AppNotification[] = []
    s.onNotification = (n) => fired.push(n)
    return { s, p, t, fired }
  }

  it("records one when a running task finishes, with a one-line summary", () => {
    const { s, t, fired } = setup()
    s.updateTask(t.id, { status: "working" })
    expect(fired).toHaveLength(0)
    s.updateTask(t.id, { status: "pr_ready", summary: "Opened the PR.\n\nIt   fixes login." })
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ taskId: t.id, title: "Fix login", projectName: "site", status: "pr_ready", summary: "Opened the PR. It fixes login.", readAt: null })
    expect(s.listNotifications()).toEqual(fired)
  })

  it("uses the question for needs_input and the error for failed", () => {
    const { s, t, fired } = setup()
    s.updateTask(t.id, { status: "working" })
    s.updateTask(t.id, { status: "needs_input", question: "Which DB?" })
    s.updateTask(t.id, { status: "working" })
    s.updateTask(t.id, { status: "failed", error: "x".repeat(500) })
    expect(fired.map((n) => n.status)).toEqual(["needs_input", "failed"])
    expect(fired[0]!.summary).toBe("Which DB?")
    expect(fired[1]!.summary!.length).toBe(200)
  })

  it("stays quiet for Cody's own actions and for compaction turns", () => {
    const { s, t, fired } = setup()
    s.updateTask(t.id, { status: "working" })
    s.updateTask(t.id, { status: "done" }, { quiet: true })
    s.updateTask(t.id, { status: "working", compacting: true })
    s.updateTask(t.id, { status: "pr_ready", compacting: false })
    s.updateTask(t.id, { summary: "no status change" })
    expect(fired).toHaveLength(0)
  })

  it("marks read by id, by task, or all, and only reports what changed", () => {
    const { s, p, t, fired } = setup()
    const t2 = s.createTask({ projectId: p.id, title: "Other", prompt: "p" })
    for (const id of [t.id, t2.id, t.id]) {
      s.updateTask(id, { status: "working" })
      s.updateTask(id, { status: "done" })
    }
    expect(fired).toHaveLength(3)
    expect(s.markNotificationsRead({ ids: [fired[1]!.id] }, 10)).toEqual([fired[1]!.id])
    expect(s.markNotificationsRead({ ids: [fired[1]!.id] }, 11)).toEqual([])
    expect(s.markNotificationsRead({ taskId: t.id }, 12).sort()).toEqual([fired[0]!.id, fired[2]!.id].sort())
    expect(s.markNotificationsRead({ all: true })).toEqual([])
    expect(s.listNotifications().map((n) => n.readAt).sort()).toEqual([10, 12, 12])
  })

  it("survives a reopen, and goes away with its task", () => {
    const dir = tmpDir()
    const s = new Store(openDb(dir))
    const p = s.createProject({ name: "site" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    s.updateTask(t.id, { status: "working" })
    s.updateTask(t.id, { status: "idle" })
    s.markNotificationsRead({ all: true }, 42)
    s.db.close()
    const again = new Store(openDb(dir))
    expect(again.listNotifications()).toMatchObject([{ taskId: t.id, status: "idle", readAt: 42 }])
    again.deleteTask(t.id)
    expect(again.listNotifications()).toEqual([])
  })
})

describe("toast batching", () => {
  it("one notification is one task toast", () => {
    const plan = planToast([note("n1", "a", "failed")], null)
    expect(plan).toMatchObject({ kind: "single", notification: { id: "n1" } })
    expect(toastContent(plan!)).toMatchObject({ title: "Task a", href: "/tasks/a", tone: "red", status: "failed", context: "site" })
  })

  it("a burst becomes one 'N tasks finished' toast, colored by the most urgent", () => {
    const plan = planToast([note("n1", "a", "done", 1), note("n2", "b", "needs_input", 2), note("n3", "c", "pr_ready", 3)], null)
    expect(plan).toMatchObject({ kind: "batch", status: "needs_input" })
    const content = toastContent(plan!)
    expect(content).toMatchObject({ title: "3 tasks finished", tone: "amber", href: "/?tab=recent", status: undefined })
    expect(content.body).toBe("Task c, Task b, Task a")
    expect(content.context).toBe("1 need you · 1 PR ready · 1 done")
  })

  it("keeps the newest per task and skips the viewed task and read ones", () => {
    expect(planToast([note("n1", "a", "needs_input", 1), note("n2", "a", "done", 2)], null)).toMatchObject({ kind: "single", notification: { id: "n2" } })
    expect(planToast([note("n1", "a", "done"), note("n2", "b", "done")], "a")).toMatchObject({ kind: "single", notification: { id: "n2" } })
    expect(planToast([note("n1", "a", "done")], "a")).toBeNull()
    expect(planToast([note("n1", "a", "done", 1, 5)], null)).toBeNull()
  })

  it("colors: failed red, needs input amber, PR ready green, done neutral", () => {
    const tone = (s: AppNotification["status"]) => toastContent(planToast([note("n", "a", s)], null)!).tone
    expect([tone("failed"), tone("needs_input"), tone("pr_ready"), tone("done"), tone("idle")]).toEqual(["red", "amber", "green", "neutral", "neutral"])
  })

  it("counts by status, most urgent first", () => {
    expect(batchBreakdown([note("1", "a", "done"), note("2", "b", "failed"), note("3", "c", "done")])).toBe("1 failed · 2 done")
  })

  it("reads the task id from the path", () => {
    expect(viewingTaskId("/tasks/task_abc")).toBe("task_abc")
    expect(viewingTaskId("/tasks/task_abc/x")).toBe("task_abc")
    expect(viewingTaskId("/projects/prj_1")).toBeNull()
  })
})

describe("read / unread state", () => {
  it("adds newest first, without duplicates, capped", () => {
    const list = addNotification([note("n1", "a", "done")], note("n2", "b", "done"))!
    expect(list.map((n) => n.id)).toEqual(["n2", "n1"])
    expect(addNotification(list, note("n2", "b", "done"))).toBe(list)
    expect(addNotification(undefined, note("n1", "a", "done"))).toBeUndefined()
    let long: AppNotification[] = []
    for (let i = 0; i < RECENT_LIMIT + 5; i++) long = addNotification(long, note(`n${i}`, "a", "done"))!
    expect(long).toHaveLength(RECENT_LIMIT)
  })

  it("counts unread and marks read without touching what was already read", () => {
    const list = [note("n1", "a", "done"), note("n2", "b", "failed", 1, 7), note("n3", "a", "idle")]
    expect(unreadCount(list)).toBe(2)
    expect(unreadIds(list, { taskId: "a" })).toEqual(["n1", "n3"])
    expect(unreadIds(list, { ids: ["n2", "n3"] })).toEqual(["n3"])
    expect(unreadIds(list, { all: true })).toEqual(["n1", "n3"])
    const next = applyRead(list, ["n1", "n2"], 9)!
    expect(next.map((n) => n.readAt)).toEqual([9, 7, null])
    expect(unreadCount(next)).toBe(1)
    expect(applyRead(next, ["n2"], 10)).toBe(next)
  })
})

describe("live notifications", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("window", { location: { pathname: "/" }, dispatchEvent: () => true })
    for (const t of currentToasts()) dismiss(t.id)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const client = (list: AppNotification[] = []) => {
    const qc = new QueryClient()
    qc.setQueryData(keys.notifications, list)
    return qc
  }

  it("batches a burst into one toast after a short wait", () => {
    const qc = client()
    receiveNotification(qc, note("n1", "a", "done", 1))
    receiveNotification(qc, note("n2", "b", "failed", 2))
    expect(currentToasts()).toHaveLength(0)
    vi.advanceTimersByTime(BATCH_MS)
    expect(currentToasts()).toMatchObject([{ kind: "task", title: "2 tasks finished", tone: "red" }])
    expect(unreadCount(qc.getQueryData(keys.notifications))).toBe(2)
  })

  it("no toast for the task being viewed; it is marked read at once", () => {
    ;(window as unknown as { location: { pathname: string } }).location.pathname = "/tasks/a"
    const qc = client()
    receiveNotification(qc, note("n1", "a", "done"))
    vi.advanceTimersByTime(BATCH_MS)
    expect(currentToasts()).toHaveLength(0)
    expect(unreadCount(qc.getQueryData(keys.notifications))).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications/read", expect.objectContaining({ body: JSON.stringify({ ids: ["n1"] }) }))
  })

  it("toasts auto-dismiss after ~6s, hold while hovered, and cap at three", () => {
    toast.task({ title: "a" })
    vi.advanceTimersByTime(TASK_TOAST_MS - 100)
    pauseToasts()
    vi.advanceTimersByTime(60_000)
    expect(currentToasts()).toHaveLength(1)
    resumeToasts()
    vi.advanceTimersByTime(1000)
    expect(currentToasts()).toHaveLength(0)

    for (const title of ["1", "2", "3", "4"]) toast.task({ title })
    expect(currentToasts().map((t) => t.title)).toEqual(["2", "3", "4"])
    expect(currentToasts()).toHaveLength(MAX_TOASTS)
  })
})
