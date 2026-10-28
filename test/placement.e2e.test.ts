import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"
import { LocalProvider } from "../server/providers/local.js"
import { BOX_PICK_WHY, placementView } from "../shared/placement.js"
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

describe("reusing idle boxes", () => {
  const events = (r: Running, id: string) =>
    r.yard.store
      .listTaskMessages(id)
      .filter((m) => m.role === "event")
      .map((m) => m.content)
  const archived = (r: Running, id: string) => waitFor(() => r.yard.store.getTaskRow(id)?.last_archived_at ?? null, `task ${id}'s archive`)

  it("gives another project's idle box to a project that needs one, parking its workspaces in the archive", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    expect(a1.placement?.now).toMatchObject({ boxId: a1.boxId, how: "new" })
    await archived(r, a1.id)

    // Idle long enough (no wait in a test): beta gets alpha's box instead of a new one.
    r.yard.tasks.placementTuning.reuseIdleMs = 0
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(b1.boxId).toBe(a1.boxId)
    expect(b1.placement?.now).toMatchObject({ boxId: a1.boxId, how: "reused" })
    expect(placementView(b1).label).toBe(`Local box · ${a1.boxId} · small · reused idle box`)
    expect(placementView(b1).reason).toBe(BOX_PICK_WHY.reused)
    expect(await boxes(r)).toHaveLength(1)
    expect(events(r, b1.id)).toContainEqual(expect.stringMatching(new RegExp(`^Placed on box ${a1.boxId}, idle for \\d+ min, rather than making a new box\\.$`)))

    // Alpha's task left it with its workspace in the archive; the box is beta's now, and the history says why.
    const parked = await getTask(r, a1.id)
    expect(parked.boxId).toBeNull()
    expect(events(r, a1.id)).toContain(`Workspace parked in the archive: box ${a1.boxId} was idle and went to project beta. It comes back on the next message.`)
    expect(r.yard.store.getKv(`box_owner:${a1.boxId}`)).toBe(b.id)
    const reused = r.yard.tasks.history.list().find((e) => e.type === "reused")
    expect(reused).toMatchObject({ boxId: a1.boxId, actor: "scheduler", detail: "From alpha to beta; 1 workspace parked in the archive." })
    expect(reused!.reason).toMatch(/^Idle for \d+ min and beta needed a box: reusing it instead of making a new one\.$/)
    expect(reused!.projects.map((p) => p.name)).toEqual(["alpha"])

    // Alpha's next message brings its workspace back, on a new box while beta's was used a moment ago.
    r.yard.tasks.placementTuning.reuseIdleMs = 5 * 60_000
    await call(r, "POST", `/api/tasks/${a1.id}/messages`, { content: "and one more" })
    const back = await until(r, a1.id, "done")
    expect(back.boxId).toBeTruthy()
    expect(back.boxId).not.toBe(b1.boxId)
    expect(back.placement?.now?.how).toBe("new")
  })

  it("leaves a box used a moment ago to its project", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    await archived(r, a1.id)
    // Used a moment ago: a box idle less than reuseIdleMs (5 min by default) stays alpha's.
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(b1.boxId).not.toBe(a1.boxId)
    expect(b1.placement?.now?.how).toBe("new")
    expect(r.yard.tasks.history.list().some((e) => e.type === "reused")).toBe(false)
  })

  it("never gives a box to a project of another credential set", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const own = await call<Project>(r, "POST", "/api/projects", { name: "own", env: { GITHUB_TOKEN: "own-gh" } })
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    await archived(r, a1.id)
    r.yard.tasks.placementTuning.reuseIdleMs = 0
    const o1 = await until(r, (await task(r, own.id, "o1")).id, "done")
    expect(o1.boxId).not.toBe(a1.boxId)
    expect((await getTask(r, a1.id)).boxId).toBe(a1.boxId)
    expect(r.yard.tasks.history.list().some((e) => e.type === "reused")).toBe(false)
  })

  it("says a task shares a box when the pool can't grow", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(b1.boxId).toBe(a1.boxId)
    expect(b1.placement?.now?.how).toBe("shared")
    expect(placementView(b1).label).toContain("· shared box")
  })
})
