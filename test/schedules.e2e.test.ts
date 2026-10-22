import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { QStash, signLikeQStash } from "../server/qstash.js"
import type { Config } from "../server/config.js"
import type { ChatMessage, Project, Schedule, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Schedules end to end: real server, task manager, local boxes and the fake claude.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  clock: { now: number }
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}, qstash: QStash | null = null): Promise<Running> {
  const port = overrides.port ?? (await freePort())
  const config = testConfig({ port, schedulerTickMs: 60_000, defaultTimezone: "UTC", ...overrides })
  const clock = { now: Date.now() }
  const yard = createBoxYard(config, { webDir: "/nonexistent", qstash, now: () => clock.now })
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

const doneTask = (r: Running, id: string) =>
  waitFor(async () => {
    const t = await call<Task>(r, "GET", `/api/tasks/${id}`)
    return t.status === "done" ? t : null
  }, `task ${id} to finish`)

describe("schedules end to end", () => {
  it("creates a schedule, fires it on time, streams the run like any task, and deletes it", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })

    const preview = await call<{ ok: boolean; description: string; next: number[] }>(r, "GET", "/api/schedules/preview?cron=0%209%20*%20*%201-5&timezone=UTC")
    expect(preview.ok).toBe(true)
    expect(preview.description).toBe("Weekdays at 09:00")
    expect(preview.next).toHaveLength(5)
    const bad = await call<{ ok: boolean; error: string }>(r, "GET", "/api/schedules/preview?cron=nope")
    expect(bad.ok).toBe(false)

    const s = await call<Schedule>(r, "POST", "/api/schedules", {
      projectId: p.id,
      name: "Haiku drop",
      cron: "*/5 * * * *",
      prompt: "write a haiku [artifact]",
    })
    expect(s.enabled).toBe(true)
    expect(s.nextRunAt).toBeGreaterThan(r.clock.now)

    // Time passes; the timer finds the run due.
    r.clock.now = s.nextRunAt! + 1000
    r.yard.scheduler.tick()
    const runs = await call<Task[]>(r, "GET", `/api/schedules/${s.id}/runs`)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.scheduleId).toBe(s.id)
    const done = await doneTask(r, runs[0]!.id)
    expect(done.summary).toContain("mock agent")

    // The run's transcript is there to stream, like any task.
    const messages = await call<TaskMessage[]>(r, "GET", `/api/tasks/${done.id}/messages`)
    expect(messages.some((m) => m.role === "assistant")).toBe(true)
    expect(messages[0]!.content).toContain('schedule "Haiku drop"')

    // Run now, then pause, then delete. Past runs stay.
    const manual = await call<Task>(r, "POST", `/api/schedules/${s.id}/run`)
    await doneTask(r, manual.id)
    const paused = await call<Schedule>(r, "PATCH", `/api/schedules/${s.id}`, { enabled: false })
    expect(paused.nextRunAt).toBeNull()
    expect((await call<Schedule[]>(r, "GET", "/api/schedules"))[0]!.runCount).toBe(2)
    await call(r, "DELETE", `/api/schedules/${s.id}`)
    expect(await call<Schedule[]>(r, "GET", "/api/schedules")).toHaveLength(0)
    expect((await call<Task[]>(r, "GET", "/api/tasks")).filter((t) => t.scheduleId === s.id)).toHaveLength(2)

    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.some((m) => m.role === "notice" && m.content.includes('Schedule "Haiku drop"'))).toBe(true)
  })

  it("validates input and removes schedules with their project", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const res = await fetch(`${r.base}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: p.id, name: "x", cron: "61 * * * *", prompt: "x" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/out of range/)
    await call(r, "POST", "/api/schedules", { projectId: p.id, name: "x", cron: "@daily", prompt: "x" })
    await call(r, "DELETE", `/api/projects/${p.id}`)
    expect(await call<Schedule[]>(r, "GET", "/api/schedules")).toHaveLength(0)
  })

  it("the orchestrator creates and deletes schedules through MCP tools", async () => {
    const r = await start()
    await call(r, "POST", "/api/projects", { name: "ops" })
    await call(r, "POST", "/api/chat", { content: 'schedule ops "0 9 * * 1-5": Morning triage -- triage new issues' })
    const created = await waitFor(async () => (await call<Schedule[]>(r, "GET", "/api/schedules"))[0], "schedule from chat")
    expect(created.name).toBe("Morning triage")
    expect(created.cron).toBe("0 9 * * 1-5")
    expect(created.prompt).toBe("triage new issues")
    await waitFor(async () => !(await call<{ orchestratorBusy: boolean }>(r, "GET", "/api/health")).orchestratorBusy, "orchestrator idle")
    await call(r, "POST", "/api/chat", { content: "delete schedule Morning triage" })
    await waitFor(async () => (await call<Schedule[]>(r, "GET", "/api/schedules")).length === 0, "schedule deleted from chat")
    await waitFor(async () => !(await call<{ orchestratorBusy: boolean }>(r, "GET", "/api/health")).orchestratorBusy, "orchestrator idle")
  })

  it("fires from a signed QStash delivery and rejects unsigned ones", async () => {
    const key = "sig_test_key"
    const calls: string[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`)
      const id = (init.headers as Record<string, string>)["Upstash-Schedule-Id"]
      return new Response(init.method === "POST" ? JSON.stringify({ scheduleId: id }) : "", { status: 200 })
    }) as unknown as typeof fetch
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const r = await start({ port, publicUrl, qstashToken: "qs", qstashCurrentSigningKey: key }, new QStash("qs", "https://qstash.test", fakeFetch))
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const s = await call<Schedule>(r, "POST", "/api/schedules", { projectId: p.id, name: "Nightly", cron: "@daily", prompt: "write a haiku" })
    expect(calls[0]).toBe(`POST https://qstash.test/v2/schedules/${publicUrl}/qstash/schedules/${s.id}`)
    expect((await call<{ scheduler: string }>(r, "GET", "/api/health")).scheduler).toBe("qstash")

    const url = `${publicUrl}/qstash/schedules/${s.id}`
    const body = JSON.stringify({ scheduleId: s.id })
    const unsigned = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })
    expect(unsigned.status).toBe(401)

    r.clock.now = s.nextRunAt! + 500
    const fire = () =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Upstash-Signature": signLikeQStash({ key, url, body }) }, body })
    const first = await fire()
    expect(await first.json()).toEqual({ result: "started" })
    // A retry (or the local timer) doesn't start a second run.
    expect(await (await fire()).json()).toEqual({ result: "not-due" })
    r.yard.scheduler.tick()
    const runs = await call<Task[]>(r, "GET", `/api/schedules/${s.id}/runs`)
    expect(runs).toHaveLength(1)
    await doneTask(r, runs[0]!.id)
  })
})
