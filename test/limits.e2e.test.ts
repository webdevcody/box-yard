import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { BoxInfo, Health, Project, SettingsInfo, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Pool limits (max boxes, agents per box, total agents) are saved on the server,
// win over env defaults, apply without a restart, and never kill running work.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

async function stop(r: Running) {
  running.splice(running.indexOf(r), 1)
  r.yard.stop()
  await new Promise((res) => r.server.close(() => res(null)))
}

afterEach(async () => {
  for (const r of [...running]) await stop(r)
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

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "think hard [slow]") =>
  call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const limits = (r: Running, patch: Record<string, number>) => call<SettingsInfo>(r, "PUT", "/api/agent-settings", patch)
const health = (r: Running) => call<Health>(r, "GET", "/api/health")
const until = (r: Running, id: string, status: Task["status"]) =>
  waitFor(async () => ((await getTask(r, id)).status === status ? true : null), `task ${id} to be ${status}`)

describe("pool limits", () => {
  it("are saved, beat the env defaults, and survive a restart", async () => {
    const dataDir = tmpDir()
    const r = await start({ dataDir, maxBoxes: 2, slotsPerBox: 3 })
    const before = await call<SettingsInfo>(r, "GET", "/api/agent-settings")
    expect(before.settings).toMatchObject({ maxBoxes: 2, slotsPerBox: 3, maxAgents: 0 })
    expect(before.sources.maxBoxes).not.toBe("ui")

    const saved = await limits(r, { maxBoxes: 4, maxAgents: 5 })
    expect(saved.settings).toMatchObject({ maxBoxes: 4, slotsPerBox: 3, maxAgents: 5 })
    expect(saved.sources.maxBoxes).toBe("ui")
    expect(saved.sources.slotsPerBox).not.toBe("ui")
    expect((await health(r)).pool).toEqual({ maxBoxes: 4, slotsPerBox: 3, maxAgents: 5 })

    await stop(r)
    const r2 = await start({ dataDir, maxBoxes: 2, slotsPerBox: 3 })
    const after = await call<SettingsInfo>(r2, "GET", "/api/agent-settings")
    expect(after.settings).toMatchObject({ maxBoxes: 4, slotsPerBox: 3, maxAgents: 5 })

    // Resetting hands control back to the env defaults.
    const reset = await call<SettingsInfo>(r2, "DELETE", "/api/agent-settings")
    expect(reset.settings).toMatchObject({ maxBoxes: 2, slotsPerBox: 3, maxAgents: 0 })
  })

  it("rejects values that make no sense", async () => {
    const r = await start()
    await expect(limits(r, { maxBoxes: 0 })).rejects.toThrow(/400/)
    await expect(limits(r, { slotsPerBox: 1.5 })).rejects.toThrow(/400/)
  })

  it("apply live: raising agents per box starts a waiting task without a restart", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 1 })
    const p = await project(r, "alpha")
    const t1 = await task(r, p.id, "t1")
    await until(r, t1.id, "working")
    const t2 = await task(r, p.id, "t2")
    await until(r, t2.id, "queued")

    await limits(r, { slotsPerBox: 2 })
    await until(r, t2.id, "working")
    expect((await getTask(r, t1.id)).status).toBe("working")
    await until(r, t1.id, "done")
    await until(r, t2.id, "done")
  })

  it("lowering a limit below what's in use kills nothing and only holds back new work", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const p = await project(r, "alpha")
    const t1 = await task(r, p.id, "t1")
    const t2 = await task(r, p.id, "t2")
    await until(r, t1.id, "working")
    await until(r, t2.id, "working")

    await limits(r, { slotsPerBox: 1, maxBoxes: 1 })
    const t3 = await task(r, p.id, "t3")
    await until(r, t3.id, "queued")

    const [box] = await boxes(r)
    expect(box!.slots).toBe(1)
    expect(box!.runningTurns).toBe(2) // over the limit, still running
    expect((await getTask(r, t1.id)).status).toBe("working")
    expect((await getTask(r, t2.id)).status).toBe("working")
    expect((await getTask(r, t3.id)).status).toBe("queued")

    // Once usage drops the waiting task gets its turn, and nothing failed on the way.
    for (const t of [t1, t2, t3]) await until(r, t.id, "done")
    expect((await boxes(r)).length).toBe(1)
  })

  it("max agents caps work across boxes and waits instead of killing", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    await limits(r, { maxAgents: 1 })
    const ta = await task(r, a.id, "a1")
    await until(r, ta.id, "working")
    const tb = await task(r, b.id, "b1")
    await until(r, tb.id, "queued")
    expect((await getTask(r, ta.id)).status).toBe("working")

    await until(r, ta.id, "done")
    await until(r, tb.id, "done")

    // Lifting the cap lets both run at once.
    await limits(r, { maxAgents: 0 })
    const t1 = await task(r, a.id, "a2")
    const t2 = await task(r, b.id, "b2")
    await until(r, t1.id, "working")
    await until(r, t2.id, "working")
    await until(r, t1.id, "done")
    await until(r, t2.id, "done")
  })
})
