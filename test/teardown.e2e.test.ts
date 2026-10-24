import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Stopping Box Yard closes the database while work is still finishing: a Coordinator turn whose
// claude was just killed, or the archive a task compaction started. That work must wind down quietly,
// not throw "The database connection is not open" as an unhandled rejection that fails the whole run.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []
const rejections: unknown[] = []
const onRejection = (err: unknown) => rejections.push(err)

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  process.on("unhandledRejection", onRejection)
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) await new Promise((res) => r.server.close(() => res(null)))
  process.off("unhandledRejection", onRejection)
  rejections.length = 0
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const settle = () => new Promise((r) => setTimeout(r, 300))
const dbClosed = (errs: unknown[]) => errs.filter((e) => /database connection is not open/.test(String((e as Error)?.message ?? e)))

describe("stopping Box Yard mid-work", () => {
  it("lets a Coordinator turn cut short by stop() end without touching the closed database", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { content: "status [slow]" })
    await waitFor(() => r.yard.orchestrator.busy, "the Coordinator turn to start")
    r.yard.stop()
    await waitFor(() => !r.yard.orchestrator.busy, "the killed turn to wind down")
    await settle()
    expect(dbClosed(rejections)).toEqual([])
  })

  it("lets a Captain turn cut short by stop() end without touching the closed database", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "status [slow]" })
    await waitFor(() => r.yard.captains.state(p.id).busy, "the Captain turn to start")
    const captain = r.yard.captains.get(p.id)
    r.yard.stop()
    await waitFor(() => !captain.active, "the killed turn to wind down")
    await settle()
    expect(dbClosed(rejections)).toEqual([])
  })

  it("lets the archive a task compaction started finish after stop() without touching the closed database", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await waitFor(async () => {
      const x = await call<Task>(r, "GET", `/api/tasks/${t.id}`)
      return x.status === "done" && x.lastArchivedAt && !x.currentTurnId
    }, "the task to finish and archive")

    // Stop right after the compaction ends, while the archive it kicked off is still running.
    const archiving = (r.yard.tasks as unknown as { archiving: Set<string> }).archiving
    const broadcast = r.yard.hub.broadcast.bind(r.yard.hub)
    let stopped = false
    r.yard.hub.broadcast = (ev) => {
      broadcast(ev)
      if (!stopped && ev.type === "task.message" && /^Context compacted/.test(ev.message.content)) {
        stopped = true
        setImmediate(() => r.yard.stop())
      }
    }
    await call(r, "POST", `/api/tasks/${t.id}/compact`)
    await waitFor(() => stopped, "the compaction to finish")
    await waitFor(() => archiving.size === 0, "the post-compaction archive to wind down")
    await settle()
    expect(dbClosed(rejections)).toEqual([])
  })
})
