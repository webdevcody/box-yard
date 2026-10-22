import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import Database from "better-sqlite3"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import { migrate } from "../server/db.js"
import type { ChatMessage, Schedule, ScheduleRun } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
  clock: { now: number }
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, schedulerTickMs: 60_000, defaultTimezone: "UTC" })
  const clock = { now: Date.parse("2026-10-22T08:58:00Z") }
  const yard = createBoxYard(config, { webDir: "/nonexistent", now: () => clock.now })
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

const idle = (r: Running) => waitFor(async () => !(await call<{ orchestratorBusy: boolean }>(r, "GET", "/api/health")).orchestratorBusy, "orchestrator idle")
const runs = (r: Running) => call<ScheduleRun[]>(r, "GET", "/api/schedule-runs")
const chat = (r: Running) => call<ChatMessage[]>(r, "GET", "/api/chat")

describe("orchestrator schedules", () => {
  it("fires, injects a labeled message into the chat and records the run", async () => {
    const r = await start()
    const s = await call<Schedule>(r, "POST", "/api/schedules", { name: "Morning digest", cron: "0 9 * * *", prompt: "summarize open PRs" })
    expect(s.target).toBe("orchestrator")
    expect(s.projectId).toBeNull()

    r.clock.now = Date.parse("2026-10-22T09:00:05Z")
    r.yard.scheduler.tick()
    const run = await waitFor(async () => (await runs(r)).find((x) => x.status === "done"), "run to finish")
    expect(run.scheduleId).toBe(s.id)
    expect(run.prompt).toBe("[Scheduled: Morning digest] summarize open PRs")

    const msg = (await chat(r)).find((m) => m.id === run.chatMessageId)!
    expect(msg.role).toBe("user")
    expect(msg.content).toBe("[Scheduled: Morning digest] summarize open PRs")
    expect(msg.meta).toMatchObject({ scheduleId: s.id, scheduleRunId: run.id })
    // The orchestrator answered it.
    expect((await chat(r)).some((m) => m.role === "assistant")).toBe(true)

    const after = (await call<Schedule[]>(r, "GET", "/api/schedules"))[0]!
    expect(after.runCount).toBe(1)
    expect(after.nextRunAt).toBe(Date.parse("2026-10-23T09:00:00Z"))
    expect(await call<ScheduleRun[]>(r, "GET", `/api/schedules/${s.id}/runs`)).toHaveLength(1)
  })

  it("queues behind a running turn, never overlaps turns, and honors allow_overlap", async () => {
    const r = await start()
    const s = await call<Schedule>(r, "POST", "/api/schedules", { name: "Digest", cron: "0 9 * * *", prompt: "digest" })
    const busyTurn = (await call<ChatMessage>(r, "POST", "/api/chat", { content: "status [slow]" })).id
    await waitFor(() => r.yard.orchestrator.busy, "orchestrator busy")

    r.clock.now = Date.parse("2026-10-22T09:00:05Z")
    r.yard.scheduler.tick()
    const queued = (await runs(r))[0]!
    expect(queued.status).toBe("queued")
    expect(queued.chatMessageId).toBeNull()
    // Not injected while Cody's message is being handled.
    expect((await chat(r)).some((m) => m.meta?.scheduleId)).toBe(false)

    // Next day's run: the previous scheduled prompt is still queued, so it is skipped.
    r.clock.now = Date.parse("2026-10-23T09:00:05Z")
    r.yard.scheduler.tick()
    expect(await runs(r)).toHaveLength(1)
    expect((await call<Schedule[]>(r, "GET", "/api/schedules"))[0]!.lastSkipReason).toMatch(/still queued or running/)

    const done = await waitFor(async () => (await runs(r)).find((x) => x.id === queued.id && x.status === "done"), "queued run delivered")
    await idle(r)
    const messages = await chat(r)
    const order = messages.filter((m) => m.id === busyTurn || m.id === done.chatMessageId).map((m) => m.id)
    expect(order).toEqual([busyTurn, done.chatMessageId])
    // Cody's message was answered before the scheduled one was injected.
    const firstAnswer = messages.findIndex((m) => m.role === "assistant")
    expect(firstAnswer).toBeGreaterThan(messages.findIndex((m) => m.id === busyTurn))
    expect(firstAnswer).toBeLessThan(messages.findIndex((m) => m.id === done.chatMessageId))

    // With overlap allowed, a second prompt queues even while one is queued.
    await call(r, "PATCH", `/api/schedules/${s.id}`, { allowOverlap: true, prompt: "digest [slow]" })
    r.clock.now = Date.parse("2026-10-24T09:00:05Z")
    r.yard.scheduler.tick()
    r.clock.now = Date.parse("2026-10-25T09:00:05Z")
    r.yard.scheduler.tick()
    expect((await runs(r)).length).toBe(3)
    await waitFor(async () => (await runs(r)).every((x) => x.status === "done"), "all runs done")
    expect((await chat(r)).filter((m) => m.meta?.scheduleId)).toHaveLength(3)
  })

  it("run now queues a manual run", async () => {
    const r = await start()
    const s = await call<Schedule>(r, "POST", "/api/schedules", { name: "Ping", cron: "@daily", prompt: "ping" })
    const run = await call<ScheduleRun>(r, "POST", `/api/schedules/${s.id}/run`)
    expect(run.reason).toBe("manual")
    await waitFor(async () => (await runs(r))[0]?.status === "done", "manual run done")
  })

  it("rejects a project on an orchestrator schedule and a missing project on a project schedule", async () => {
    const r = await start()
    const p = await call<{ id: string }>(r, "POST", "/api/projects", { name: "ops" })
    const bad = (body: object) => fetch(`${r.base}/api/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    expect((await bad({ target: "orchestrator", projectId: p.id, name: "x", cron: "@daily", prompt: "x" })).status).toBe(400)
    expect((await bad({ target: "project", name: "x", cron: "@daily", prompt: "x" })).status).toBe(400)
  })
})

describe("schedules migration", () => {
  it("keeps existing schedules as project schedules and allows orchestrator ones", () => {
    const dir = tmpDir()
    const db = new Database(`${dir}/old.sqlite`)
    db.pragma("foreign_keys = ON")
    // Build the schema as it was before this change (migrations 1 and 2), then add data.
    migrateUpTo(db, 2)
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'ops', 1, 1)").run()
    db.prepare(
      `INSERT INTO schedules (id, project_id, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, run_count, created_at, updated_at)
       VALUES ('s1', 'p1', 'Old', '0 9 * * *', 'UTC', 'do it', 1, 'skip', 1, 5, 3, 1, 1)`,
    ).run()
    migrate(db)
    const row = db.prepare("SELECT * FROM schedules WHERE id = 's1'").get() as Record<string, unknown>
    expect(row).toMatchObject({ target: "project", project_id: "p1", name: "Old", catch_up: "skip", allow_overlap: 1, next_run_at: 5, run_count: 3 })
    // project_id is nullable now, and project deletion still cascades.
    db.prepare("INSERT INTO schedules (id, target, project_id, name, cron, prompt, created_at, updated_at) VALUES ('s2', 'orchestrator', NULL, 'O', '@daily', 'x', 1, 1)").run()
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run()
    expect((db.prepare("SELECT id FROM schedules").all() as { id: string }[]).map((x) => x.id)).toEqual(["s2"])
    db.close()
  })
})

/** Apply only the first `n` migrations by running migrate against a connection that stops early. */
function migrateUpTo(db: Database.Database, n: number) {
  const real = db.exec.bind(db)
  let applied = 0
  // migrate() execs one migration at a time; swallow everything after the nth.
  db.exec = ((sql: string) => {
    if (/^\s*CREATE TABLE IF NOT EXISTS _migrations/.test(sql)) return real(sql)
    if (applied >= n) throw new Error("stop")
    applied++
    return real(sql)
  }) as typeof db.exec
  try {
    migrate(db)
  } catch (err) {
    if ((err as Error).message !== "stop") throw err
  } finally {
    db.exec = real
  }
}

describe("schedule MCP tools", () => {
  it("create, list, update, run now, list runs and delete work for both kinds", async () => {
    const r = await start()
    await call(r, "POST", "/api/projects", { name: "ops" })
    const { server: mcp } = { server: buildMcpServer({ store: r.yard.store, tasks: r.yard.tasks, hub: r.yard.hub, artifacts: null as never, publicUrl: () => "", scheduler: r.yard.scheduler }) }
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    const use = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { text: res.content[0]!.text, isError: Boolean(res.isError) }
    }
    const json = (t: string) => JSON.parse(t)

    // Project omitted -> orchestrator schedule.
    const o = json((await use("create_schedule", { name: "Digest", cron: "0 9 * * *", prompt: "summarize PRs" })).text)
    expect(o).toMatchObject({ name: "Digest", target: "orchestrator" })
    expect(o.project).toBeUndefined()
    // Project given -> project schedule.
    const p = json((await use("create_schedule", { project: "ops", name: "Triage", cron: "0 10 * * *", prompt: "triage" })).text)
    expect(p).toMatchObject({ target: "project", project: "ops" })
    // Explicit target.
    const o2 = json((await use("create_schedule", { target: "orchestrator", name: "Remind", cron: "@weekly", prompt: "remind me" })).text)
    expect(o2.target).toBe("orchestrator")
    // Conflicts are errors.
    expect((await use("create_schedule", { target: "orchestrator", project: "ops", name: "X", cron: "@daily", prompt: "x" })).isError).toBe(true)
    expect((await use("create_schedule", { target: "project", name: "X", cron: "@daily", prompt: "x" })).isError).toBe(true)

    expect(json((await use("list_schedules", {})).text).map((s: { name: string }) => s.name)).toEqual(["Digest", "Triage", "Remind"])
    expect(json((await use("list_schedules", { target: "orchestrator" })).text).map((s: { name: string }) => s.name)).toEqual(["Digest", "Remind"])
    expect(json((await use("list_schedules", { project: "ops" })).text).map((s: { name: string }) => s.name)).toEqual(["Triage"])
    expect(json((await use("list_schedules", { project: "none" })).text)).toHaveLength(2)

    expect(json((await use("update_schedule", { schedule: "Digest", enabled: false, prompt: "new prompt" })).text)).toMatchObject({ enabled: false, prompt: "new prompt" })
    expect(json((await use("update_schedule", { schedule: "Triage", cron: "0 11 * * *" })).text).cron).toBe("0 11 * * *")

    // Run now: a chat run for the orchestrator one, a task for the project one.
    const orun = json((await use("run_schedule_now", { schedule: "Remind" })).text)
    expect(orun).toMatchObject({ reason: "manual", schedule: "Remind" })
    const prun = json((await use("run_schedule_now", { schedule: "Triage" })).text)
    expect(prun.project).toBe("ops")
    await waitFor(async () => (await runs(r)).every((x) => x.status === "done"), "orchestrator run done")
    const oruns = json((await use("list_schedule_runs", { schedule: "Remind" })).text)
    expect(oruns).toHaveLength(1)
    expect(oruns[0]).toMatchObject({ status: "done", schedule: "Remind" })
    expect(oruns[0].chatMessage).toBeTruthy()
    expect(json((await use("list_schedule_runs", { schedule: "Triage" })).text)).toHaveLength(1)

    expect((await use("delete_schedule", { schedule: "Digest" })).isError).toBe(false)
    expect((await use("delete_schedule", { schedule: "Triage" })).isError).toBe(false)
    expect(json((await use("list_schedules", {})).text).map((s: { name: string }) => s.name)).toEqual(["Remind"])
    await idle(r)
  })

  it("the orchestrator creates an orchestrator schedule from chat", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { content: 'oschedule "0 9 * * *": Morning digest -- summarize open PRs' })
    const s = await waitFor(async () => (await call<Schedule[]>(r, "GET", "/api/schedules"))[0], "schedule from chat")
    expect(s).toMatchObject({ target: "orchestrator", projectId: null, name: "Morning digest", prompt: "summarize open PRs" })
    await idle(r)
  })
})
