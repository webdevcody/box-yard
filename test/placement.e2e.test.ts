import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"
import { LocalProvider } from "../server/providers/local.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Which box a task lands on: a project's tasks stay together, new projects get
// their own box while the pool has room, and boxes are shared once it's full.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}, provider?: LocalProvider): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
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

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") =>
  call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const until = (r: Running, id: string, status: Task["status"]) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === status && t.pendingCount === 0 ? t : null
  }, `task ${id} to be ${status}`)

describe("box placement", () => {
  it("gives each project its own box and keeps a project's tasks together", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")

    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(a1.boxId).toBeTruthy()
    expect(b1.boxId).toBeTruthy()
    expect(b1.boxId).not.toBe(a1.boxId)

    // Later work in a project goes back to that project's box.
    const a2 = await until(r, (await task(r, a.id, "a2")).id, "done")
    const b2 = await until(r, (await task(r, b.id, "b2")).id, "done")
    expect(a2.boxId).toBe(a1.boxId)
    expect(b2.boxId).toBe(b1.boxId)

    const list = await boxes(r)
    expect(list).toHaveLength(2)
    const byId = new Map(list.map((x) => [x.id, x]))
    expect(byId.get(a1.boxId!)!.projects).toEqual(["alpha"])
    expect(byId.get(b1.boxId!)!.projects).toEqual(["beta"])
  })

  it("keeps a box made for one project for that project, even if another project's box is still being made", async () => {
    // The first box asked for finishes last, so the second project's box is ready first.
    class SlowFirst extends LocalProvider {
      private n = 0
      override async create() {
        const delay = this.n++ === 0 ? 1500 : 0
        await new Promise((r) => setTimeout(r, delay))
        return super.create()
      }
    }
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 }, new SlowFirst(tmpDir("boxes-"), FAKE_CLAUDE))
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const ta = await task(r, a.id, "a1")
    const tb = await task(r, b.id, "b1")
    const [da, db] = await Promise.all([until(r, ta.id, "done"), until(r, tb.id, "done")])
    expect(da.boxId).not.toBe(db.boxId)
    const list = await boxes(r)
    expect(list).toHaveLength(2)
    expect(list.map((x) => x.projects.join()).sort()).toEqual(["alpha", "beta"])
  })

  it("shares boxes once the pool is full", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(b1.boxId).toBe(a1.boxId)
    const list = await boxes(r)
    expect(list).toHaveLength(1)
    expect(list[0]!.projects.sort()).toEqual(["alpha", "beta"])
  })

  it("runs parallel tasks of one project on its box until the slots are full, then adds a box", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const ids = []
    for (const n of [1, 2, 3]) ids.push((await task(r, a.id, `a${n}`, "think hard [slow]")).id)
    const done = await Promise.all(ids.map((id) => until(r, id, "done")))
    const used = new Set(done.map((t) => t.boxId))
    // Two fit on the first box; the third needed a second one.
    expect(used.size).toBe(2)
    const list = await boxes(r)
    expect(list.every((x) => x.projects.join() === "alpha")).toBe(true)
  })
})
