import { afterEach, describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { Hub } from "../server/hub.js"
import { Scheduler } from "../server/scheduler.js"
import { QStash, signLikeQStash, verifyQStashSignature } from "../server/qstash.js"
import type { TaskManager } from "../server/tasks.js"
import type { TaskStatus, UiEvent } from "../shared/types.js"
import { testConfig, tmpDir } from "./helpers.js"

const utc = (s: string) => Date.parse(`${s}Z`)

/** A scheduler over a real store, with a stand-in task manager and a clock we control. */
function setup(opts: { qstash?: QStash | null; publicUrl?: string } = {}) {
  const store = new Store(openDb(tmpDir()))
  const hub = new Hub()
  const events: UiEvent[] = []
  hub.broadcast = (e) => void events.push(e)
  const notices: string[] = []
  const tasks = {
    createTask: (input: Parameters<TaskManager["createTask"]>[0]) => store.createTask(input),
    notice: (content: string) => void notices.push(content),
  } as unknown as TaskManager
  const clock = { now: utc("2026-10-22T08:58") }
  const config = testConfig({ schedulerTickMs: 15_000, defaultTimezone: "UTC", publicUrl: opts.publicUrl ?? "" })
  const scheduler = new Scheduler({ config, store, tasks, hub, qstash: opts.qstash ?? null, now: () => clock.now })
  const project = store.createProject({ name: "ops" })
  const runs = (id: string) => store.listTasks().filter((t) => t.scheduleId === id)
  const setStatus = (taskId: string, status: TaskStatus) => store.updateTask(taskId, { status })
  cleanups.push(() => (scheduler.stop(), hub.close()))
  return { store, scheduler, clock, project, runs, setStatus, notices, events }
}

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((f) => f()))

describe("scheduler", () => {
  it("plans the next run and starts a task when it is due, once", async () => {
    const { scheduler, clock, project, runs, notices, events } = setup()
    const s = await scheduler.create({ projectId: project.id, name: "Triage", cron: "0 9 * * *", prompt: "Triage new issues" })
    expect(s.nextRunAt).toBe(utc("2026-10-22T09:00"))
    expect(events.some((e) => e.type === "schedule")).toBe(true)

    scheduler.tick()
    expect(runs(s.id)).toHaveLength(0)

    clock.now = utc("2026-10-22T09:00:05")
    scheduler.tick()
    scheduler.tick()
    const tasks = runs(s.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe("Triage · Oct 22, 09:00")
    expect(tasks[0]!.prompt).toContain("Triage new issues")
    expect(tasks[0]!.prompt).toContain('run #1 of the Box Yard schedule "Triage"')
    expect(notices[0]).toContain('Schedule "Triage" in ops started a run')

    const after = scheduler.list()[0]!
    expect(after.runCount).toBe(1)
    expect(after.lastTaskId).toBe(tasks[0]!.id)
    expect(after.nextRunAt).toBe(utc("2026-10-23T09:00"))
  })

  it("catches up once after downtime, and tells the agent about the previous run", async () => {
    const { scheduler, clock, project, runs, store, setStatus } = setup()
    const s = await scheduler.create({ projectId: project.id, name: "Hourly", cron: "0 * * * *", prompt: "Check the site" })
    clock.now = utc("2026-10-22T09:00:10")
    scheduler.tick()
    const first = runs(s.id)[0]!
    setStatus(first.id, "done")
    store.updateTask(first.id, { summary: "All green." })

    // Down from 9:01 until 14:20: five runs (10:00 to 14:00) were missed.
    clock.now = utc("2026-10-22T14:20")
    scheduler.tick()
    const all = runs(s.id)
    expect(all).toHaveLength(2)
    const catchUp = all.find((t) => t.id !== first.id)!
    expect(catchUp.prompt).toContain("missed 5 runs")
    expect(catchUp.prompt).toContain(`previous run was task ${first.id}`)
    expect(catchUp.prompt).toContain("All green.")
    expect(scheduler.list()[0]!.nextRunAt).toBe(utc("2026-10-22T15:00"))
  })

  it("skips missed runs when catch-up is off", async () => {
    const { scheduler, clock, project, runs } = setup()
    const s = await scheduler.create({ projectId: project.id, name: "Report", cron: "0 * * * *", prompt: "x", catchUp: "skip" })
    clock.now = utc("2026-10-22T12:30")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(0)
    const after = scheduler.list()[0]!
    expect(after.lastSkipReason).toMatch(/Skipped 4 missed runs/)
    expect(after.nextRunAt).toBe(utc("2026-10-22T13:00"))
  })

  it("doesn't overlap runs unless allowed", async () => {
    const { scheduler, clock, project, runs } = setup()
    const s = await scheduler.create({ projectId: project.id, name: "Busy", cron: "*/5 * * * *", prompt: "x" })
    clock.now = utc("2026-10-22T09:00")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(1) // still queued
    clock.now = utc("2026-10-22T09:05")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(1)
    expect(scheduler.list()[0]!.lastSkipReason).toMatch(/previous run is still going/)

    await scheduler.update(s.id, { allowOverlap: true })
    clock.now = utc("2026-10-22T09:10")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(2)
  })

  it("pauses, resumes without replaying, runs on demand and deletes", async () => {
    const { scheduler, clock, project, runs, events } = setup()
    const s = await scheduler.create({ projectId: project.id, name: "Paused", cron: "0 9 * * *", prompt: "x" })
    await scheduler.update(s.id, { enabled: false })
    expect(scheduler.list()[0]!.nextRunAt).toBeNull()
    clock.now = utc("2026-10-25T12:00")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(0)
    const resumed = await scheduler.update("Paused", { enabled: true })
    expect(resumed.nextRunAt).toBe(utc("2026-10-26T09:00"))

    const manual = scheduler.runNow(s.id)
    expect(manual.scheduleId).toBe(s.id)
    expect(manual.prompt).toContain("started this run by hand")
    expect(scheduler.list()[0]!.nextRunAt).toBe(utc("2026-10-26T09:00"))

    await scheduler.remove(s.id)
    expect(scheduler.list()).toHaveLength(0)
    expect(events.some((e) => e.type === "schedule.deleted")).toBe(true)
    expect(runs(s.id)).toHaveLength(1) // past runs stay
  })

  it("rejects bad input", async () => {
    const { scheduler, project } = setup()
    await expect(scheduler.create({ projectId: project.id, name: "x", cron: "nope", prompt: "x" })).rejects.toThrow(/5 fields/)
    await expect(scheduler.create({ projectId: project.id, name: "x", cron: "0 0 30 2 *", prompt: "x" })).rejects.toThrow(/never runs/)
    await expect(scheduler.create({ projectId: project.id, name: "x", cron: "@daily", timezone: "Nope/Zone", prompt: "x" })).rejects.toThrow(/time zone/)
    await expect(scheduler.create({ projectId: "prj_missing", name: "x", cron: "@daily", prompt: "x" })).rejects.toThrow(/not found/)
  })
})

describe("QStash", () => {
  const KEY = "sig_current_test"

  function fakeQStash() {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body as string | undefined })
      const id = (init.headers as Record<string, string>)["Upstash-Schedule-Id"]
      return new Response(init.method === "POST" ? JSON.stringify({ scheduleId: id }) : "", { status: 200 })
    }) as unknown as typeof fetch
    return { client: new QStash("qs_token", "https://qstash.test", fetchImpl), calls }
  }

  it("creates, pauses and deletes the matching QStash schedule", async () => {
    const q = fakeQStash()
    const { scheduler, project } = setup({ qstash: q.client, publicUrl: "https://yard.example.com/" })
    const s = await scheduler.create({ projectId: project.id, name: "Daily", cron: "@daily", timezone: "America/New_York", prompt: "x" })
    expect(q.calls[0]!.method).toBe("POST")
    expect(q.calls[0]!.url).toBe(`https://qstash.test/v2/schedules/https://yard.example.com/qstash/schedules/${s.id}`)
    expect(q.calls[0]!.headers["Upstash-Cron"]).toBe("CRON_TZ=America/New_York 0 0 * * *")
    expect(q.calls[0]!.headers.Authorization).toBe("Bearer qs_token")
    expect(scheduler.list()[0]!.qstashId).toBe(`boxyard-${s.id}`)
    expect(scheduler.mode).toBe("qstash")

    await scheduler.update(s.id, { enabled: false })
    expect(q.calls[1]!.method).toBe("DELETE")
    expect(scheduler.list()[0]!.qstashId).toBeNull()
    await scheduler.update(s.id, { enabled: true })
    await scheduler.remove(s.id)
    expect(q.calls.map((c) => c.method)).toEqual(["POST", "DELETE", "POST", "DELETE"])
  })

  it("a QStash delivery and the local timer start the run only once", async () => {
    const q = fakeQStash()
    const { scheduler, clock, project, runs } = setup({ qstash: q.client, publicUrl: "https://yard.example.com" })
    const s = await scheduler.create({ projectId: project.id, name: "Ping", cron: "0 9 * * *", prompt: "x" })
    clock.now = utc("2026-10-22T08:59:30") // QStash can be a little early
    expect(scheduler.fireFromQStash(s.id)).toBe("started")
    expect(scheduler.fireFromQStash(s.id)).toBe("not-due")
    clock.now = utc("2026-10-22T09:00:10")
    scheduler.tick()
    expect(runs(s.id)).toHaveLength(1)
    expect(scheduler.list()[0]!.nextRunAt).toBe(utc("2026-10-23T09:00"))
    expect(scheduler.fireFromQStash("sch_gone")).toBe("gone")
  })

  it("verifies signatures", () => {
    const url = "https://yard.example.com/qstash/schedules/sch_1"
    const body = JSON.stringify({ scheduleId: "sch_1" })
    const sig = signLikeQStash({ key: KEY, url, body })
    expect(verifyQStashSignature({ signature: sig, body, url, keys: [KEY] })).toBeNull()
    expect(verifyQStashSignature({ signature: sig, body, url, keys: ["other", KEY] })).toBeNull()
    expect(verifyQStashSignature({ signature: sig, body, url, keys: ["wrong"] })).toBe("bad signature")
    expect(verifyQStashSignature({ signature: sig, body: "{}", url, keys: [KEY] })).toMatch(/body/)
    expect(verifyQStashSignature({ signature: sig, body, url: url + "x", keys: [KEY] })).toMatch(/signed for/)
    expect(verifyQStashSignature({ signature: undefined, body, url, keys: [KEY] })).toMatch(/missing/)
    expect(verifyQStashSignature({ signature: sig, body, url, keys: [KEY], now: Date.now() + 3600_000 })).toMatch(/expired/)
    expect(verifyQStashSignature({ signature: sig, body, url, keys: [] })).toMatch(/not configured/)
  })
})
