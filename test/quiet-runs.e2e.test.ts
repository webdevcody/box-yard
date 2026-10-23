import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { AppNotification, Project, Schedule, Task, TaskMessage } from "../shared/types.js"
import { isQuietRun } from "../shared/quiet.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Quiet schedule runs end to end: a run marked noop (mark_done outcome "noop") is stored as quiet and
// sends no notification and no Captain/Coordinator notice, unless the run did something after all.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  clock: { now: number }
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, schedulerTickMs: 60_000, defaultTimezone: "UTC", ...overrides })
  const clock = { now: Date.now() }
  const yard = createBoxYard(config, { webDir: "/nonexistent", qstash: null, now: () => clock.now })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, clock }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const RESTING = new Set(["done", "failed", "needs_input", "idle", "pr_ready"])

let runs = 0

/** Start a run of a new schedule with this prompt and wait for its turn to end. */
async function runOnce(r: Running, project: Project, prompt: string) {
  // The name stays marker-free: other agents' titles show up in each worker's prompt.
  const s = await call<Schedule>(r, "POST", "/api/schedules", { projectId: project.id, name: `Check ${++runs}`, cron: "@daily", prompt })
  const started = await call<Task>(r, "POST", `/api/schedules/${s.id}/run`)
  const task = await waitFor(async () => {
    const t = await call<Task>(r, "GET", `/api/tasks/${started.id}`)
    return RESTING.has(t.status) && t.turnCount > 0 && !r.yard.store.getTaskRow(t.id)?.current_turn_id ? t : null
  }, `run ${prompt} to finish`)
  return { schedule: s, task }
}

const notices = (r: Running, taskId: string) => ({
  captain: r.yard.store.db
    .prepare("SELECT content, seen_by_captain AS seen FROM captain_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?")
    .all(taskId) as { content: string; seen: number }[],
  coordinator: r.yard.store.db
    .prepare("SELECT content, seen_by_orchestrator AS seen FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?")
    .all(taskId) as { content: string; seen: number }[],
})

describe("quiet schedule runs", () => {
  it("files a noop run as quiet: no notification, no notices, a transcript event, and still in the schedule's runs", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })

    const { schedule, task } = await runOnce(r, p, "merge open PRs [noop]")
    expect(task.status).toBe("done")
    expect(task.outcome).toBe("noop")
    expect(isQuietRun(task)).toBe(true)

    // Not in notifications (the sidebar Recent, toasts, voice and the tab count all read these).
    const list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list.filter((n) => n.taskId === task.id)).toEqual([])

    // No "is done" notice, and the start notice is dropped for the Captain and the Coordinator.
    const n = notices(r, task.id)
    expect([...n.captain, ...n.coordinator].some((m) => m.content.includes("is done"))).toBe(false)
    expect(n.captain.every((m) => m.seen === 1)).toBe(true)
    expect(n.coordinator.every((m) => m.seen === 1)).toBe(true)
    expect(r.yard.store.unseenCaptainNoticeTasks(p.id)).not.toContain(task.id)
    expect(r.yard.store.unseenNoticeTasks()).not.toContain(task.id)

    // The transcript says why.
    const msgs = await call<TaskMessage[]>(r, "GET", `/api/tasks/${task.id}/messages`)
    expect(msgs.some((m) => m.role === "event" && m.meta?.kind === "quiet")).toBe(true)

    // The schedule's history keeps it.
    const runs = await call<Task[]>(r, "GET", `/api/schedules/${schedule.id}/runs`)
    expect(runs.map((t) => t.id)).toContain(task.id)
  }, 30_000)

  it("a normal run still notifies and tells the Captain", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const { task } = await runOnce(r, p, "write a haiku")
    expect(task.status).toBe("done")
    expect(task.outcome).toBeNull()
    expect(isQuietRun(task)).toBe(false)
    const list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list.some((x) => x.taskId === task.id && x.status === "done")).toBe(true)
    expect(notices(r, task.id).captain.some((m) => m.content.includes("is done"))).toBe(true)
  }, 30_000)

  it("never hides failed or needs-input runs, even when marked noop", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })

    const failed = (await runOnce(r, p, "check things [noop] [fail]")).task
    expect(failed.status).toBe("failed")
    expect(failed.outcome).toBeNull()
    expect(isQuietRun(failed)).toBe(false)

    const asked = (await runOnce(r, p, "check things [noop] [ask]")).task
    expect(asked.status).toBe("needs_input")
    expect(asked.outcome).toBeNull()
    expect(isQuietRun(asked)).toBe(false)

    const list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list.some((x) => x.taskId === failed.id && x.status === "failed")).toBe(true)
    expect(list.some((x) => x.taskId === asked.id && x.status === "needs_input")).toBe(true)
    expect(notices(r, asked.id).captain.some((m) => m.content.includes("needs you"))).toBe(true)
  }, 40_000)

  it("ignores the noop mark when the run published an artifact or a preview", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })

    const art = (await runOnce(r, p, "report [noop] [artifact]")).task
    expect(art.status).toBe("done")
    expect(art.outcome).toBeNull()
    const artMsgs = await call<TaskMessage[]>(r, "GET", `/api/tasks/${art.id}/messages`)
    expect(artMsgs.some((m) => m.role === "event" && m.content.includes("isn't quiet") && m.content.includes("artifact"))).toBe(true)

    const prev = (await runOnce(r, p, "demo [noop] [preview]")).task
    expect(prev.outcome).toBeNull()
    expect(isQuietRun(prev)).toBe(false)

    const list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list.some((x) => x.taskId === art.id)).toBe(true)
  }, 40_000)

  it("ignores the noop mark on a task that wasn't started by a schedule", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "One-off", prompt: "look around [noop]" })
    const done = await waitFor(async () => {
      const x = await call<Task>(r, "GET", `/api/tasks/${t.id}`)
      return x.status === "done" ? x : null
    }, "the task to finish")
    expect(done.outcome).toBeNull()
  }, 30_000)
})
