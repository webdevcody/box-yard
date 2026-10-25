import { afterEach, describe, expect, it } from "vitest"
import path from "node:path"
import type { Server } from "node:http"
import Database from "better-sqlite3"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Store } from "../server/store.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A project's own box settings (Project › Settings › Boxes): box size, agents per box, tasks per box and max boxes,
// each falling back to the global one (Settings › Boxes & limits). Where projects share a box, the stricter limit
// wins, both when placement picks a box and when the turn claims its slot. Agents per box replaced the old
// "heavy tasks" setting: one-per-box and whole-box both became 1.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []
const dbs: Database.Database[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, archiveWorkspaces: false, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    // Stop the [hang] turns so nothing outlives the database.
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const db of dbs.splice(0)) db.close()
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const project = (r: Running, name: string, settings: Partial<Pick<Project, "agentsPerBox" | "tasksPerBox" | "maxBoxes">> = {}) =>
  call<Project>(r, "POST", "/api/projects", { name, ...settings })
const patch = (r: Running, id: string, body: Record<string, unknown>) => call<Project>(r, "PATCH", `/api/projects/${id}`, body)
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const stop = (r: Running, id: string) => call<Task>(r, "POST", `/api/tasks/${id}/stop`)
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return ok(t) ? t : null
  }, `task ${id} ${what}`)
const working = (r: Running, id: string) => until(r, id, (t) => t.status === "working", "to be working")
const done = (r: Running, id: string) => until(r, id, (t) => t.status === "done" && t.pendingCount === 0, "to be done")
const waits = (r: Running, id: string) => until(r, id, (t) => t.status === "queued" && Boolean(t.waitReason), "to say why it waits")
/** A long-running agent ([hang] keeps the fake turn going until it's stopped). */
const hang = async (r: Running, projectId: string, title: string) => working(r, (await task(r, projectId, title, "keep going [hang]")).id)
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
const inUse = (r: Running, boxId: string) => r.yard.store.slotsInUse(boxId)

/** Fail the test if a box ever runs more agents than the strictest Agents per box of the projects running there. */
function watchLimits(r: Running) {
  const over: string[] = []
  const orig = r.yard.hub.broadcast.bind(r.yard.hub)
  r.yard.hub.broadcast = (ev) => {
    for (const b of r.yard.store.listBoxes()) {
      const rows = r.yard.store.listTaskRows({ boxId: b.id }).filter((t) => t.current_turn_id || t.status === "starting" || t.status === "working")
      const caps = rows.map((t) => r.yard.store.projectBoxLimits(t.project_id).agentsPerBox ?? Infinity)
      if (rows.length > Math.min(...caps)) over.push(`${b.id}: ${rows.length} running, a project there allows ${Math.min(...caps)}`)
    }
    return orig(ev)
  }
  return over
}

type ToolRes = { content: { text: string }[]; isError?: boolean }

/** An in-process MCP client as the Coordinator or as one project's Captain. */
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  return { client, tool }
}

describe("project box settings: API", () => {
  it("are unset by default, round-trip over REST, and null goes back to the global one", async () => {
    const r = await start()
    const a = await project(r, "alpha")
    expect(a).toMatchObject({ boxSize: null, agentsPerBox: null, tasksPerBox: null, maxBoxes: null })
    expect(a).not.toHaveProperty("heavyTasks")
    expect(await project(r, "beta", { agentsPerBox: 2, maxBoxes: 3 })).toMatchObject({ agentsPerBox: 2, tasksPerBox: null, maxBoxes: 3 })

    expect(await patch(r, a.id, { boxSize: "large", agentsPerBox: 1, tasksPerBox: 4, maxBoxes: 2 })).toMatchObject({ boxSize: "large", agentsPerBox: 1, tasksPerBox: 4, maxBoxes: 2 })
    // Other edits leave them alone.
    expect(await patch(r, a.id, { name: "alpha 2" })).toMatchObject({ name: "alpha 2", boxSize: "large", agentsPerBox: 1, tasksPerBox: 4, maxBoxes: 2 })
    expect((await call<Project[]>(r, "GET", "/api/projects")).find((p) => p.id === a.id)).toMatchObject({ agentsPerBox: 1, tasksPerBox: 4, maxBoxes: 2 })
    // null clears one: the global setting applies again.
    expect(await patch(r, a.id, { boxSize: null, agentsPerBox: null, maxBoxes: null })).toMatchObject({ boxSize: null, agentsPerBox: null, tasksPerBox: 4, maxBoxes: null })
    expect(r.yard.store.projectBoxLimits(a.id)).toEqual({ agentsPerBox: null, tasksPerBox: 4, maxBoxes: null })

    for (const bad of [{ agentsPerBox: 0 }, { agentsPerBox: 21 }, { agentsPerBox: 1.5 }, { agentsPerBox: "2" }, { tasksPerBox: 0 }, { maxBoxes: 101 }, { maxBoxes: -1 }]) {
      await expect(patch(r, a.id, bad), JSON.stringify(bad)).rejects.toThrow(/400/)
    }
    await expect(project(r, "gamma", { agentsPerBox: 0 })).rejects.toThrow(/400/)
    expect(r.yard.store.projectBoxLimits(a.id)).toEqual({ agentsPerBox: null, tasksPerBox: 4, maxBoxes: null })
  })

  it("MCP: the Coordinator sets any project's, a Captain only its own, and list_projects says where each comes from", async () => {
    const r = await start({ maxBoxes: 3 })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const coordinator = await mcpAs(r, { kind: "coordinator" })

    const set = await coordinator.tool("update_project", { project: "alpha", box_size: "large", agents_per_box: 1, tasks_per_box: 5, max_boxes: 2 })
    expect(set.isError).not.toBe(true)
    expect(r.yard.store.getProject(a.id)).toMatchObject({ boxSize: "large", agentsPerBox: 1, tasksPerBox: 5, maxBoxes: 2 })
    const listed = JSON.parse((await coordinator.tool("list_projects")).content[0]!.text) as { id: string; boxSettings: Record<string, string> }[]
    expect(listed.find((p) => p.id === a.id)!.boxSettings).toEqual({
      boxSize: "large (this project)",
      agentsPerBox: "1: each agent alone on a box (this project)",
      tasksPerBox: "5 (this project)",
      maxBoxes: "2 (this project; it uses 0 boxes now)",
    })
    const beta = listed.find((p) => p.id === b.id)!.boxSettings
    expect(beta.boxSize).toMatch(/^global: \w+ \(Settings › Worker size\)$/)
    expect(beta.agentsPerBox).toBe("global: 2 (Settings › Agents per box)")
    expect(beta.maxBoxes).toBe("global: only the pool's Max boxes (3)")

    // null clears, and what's left out stays.
    expect((await coordinator.tool("update_project", { project: "alpha", agents_per_box: null })).isError).not.toBe(true)
    expect(r.yard.store.getProject(a.id)).toMatchObject({ boxSize: "large", agentsPerBox: null, tasksPerBox: 5, maxBoxes: 2 })
    expect((await coordinator.tool("update_project", { project: "alpha", max_boxes: 0 })).isError).toBe(true)

    // A Captain sets its own project's box settings (its project by default), and only those.
    const captain = await mcpAs(r, { kind: "captain", projectId: a.id })
    const tools = (await captain.client.listTools()).tools
    const schema = tools.find((t) => t.name === "update_project")!.inputSchema.properties!
    expect(Object.keys(schema).sort()).toEqual(["agents_per_box", "box_size", "gpu_max_hourly_usd", "max_boxes", "project", "tasks_per_box"])
    expect((await captain.tool("update_project", { agents_per_box: 3, max_boxes: null })).isError).not.toBe(true)
    expect(r.yard.store.getProject(a.id)).toMatchObject({ name: "alpha", agentsPerBox: 3, tasksPerBox: 5, maxBoxes: null })
    await captain.tool("update_project", { project: "alpha", name: "renamed", description: "x", tasks_per_box: 6 })
    expect(r.yard.store.getProject(a.id)).toMatchObject({ name: "alpha", description: "", tasksPerBox: 6 })
    const denied = await captain.tool("update_project", { project: "beta", agents_per_box: 1 })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]!.text).toMatch(/^Out of scope: .*You are the Captain for project "alpha"/)
    expect(r.yard.store.getProject(b.id)!.agentsPerBox).toBeNull()
    // Its list_projects shows only its project.
    expect((JSON.parse((await captain.tool("list_projects")).content[0]!.text) as Project[]).map((p) => p.id)).toEqual([a.id])
  })
})

describe("project box settings: placement on shared boxes", () => {
  it("Agents per box 1: each of the project's agents has a box to itself, and nothing joins it meanwhile", async () => {
    const r = await start({ maxBoxes: 2, slotsPerBox: 3 })
    const over = watchLimits(r)
    const heavy = await project(r, "heavy", { agentsPerBox: 1 })
    const light = await project(r, "light")
    const h1 = await hang(r, heavy.id, "h1")
    const l1 = await hang(r, light.id, "l1")
    expect(l1.boxId).not.toBe(h1.boxId)

    // Both boxes run an agent and the pool is full: another heavy agent waits, with the reason.
    const h2 = await task(r, heavy.id, "h2")
    expect((await waits(r, h2.id)).waitReason).toMatch(/^Waiting: heavy runs each of its agents alone on a box, and box \S+ has an agent running$/)
    // Another project's agent doesn't join the heavy box either, though it has free slots.
    const l2 = await hang(r, light.id, "l2")
    expect(l2.boxId).toBe(l1.boxId)
    await sleep(300)
    expect(inUse(r, h1.boxId!)).toBe(1)

    // Once the light box is free, h2 has it to itself.
    await stop(r, l1.id)
    await stop(r, l2.id)
    expect((await done(r, h2.id)).boxId).toBe(l1.boxId)
    expect(over).toEqual([])
  })

  it("keeps other projects' agents off a box while an Agents per box 1 agent runs there, with the reason", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 3 })
    const heavy = await project(r, "heavy", { agentsPerBox: 1 })
    const light = await project(r, "light")
    const h1 = await hang(r, heavy.id, "h1")
    const l1 = await task(r, light.id, "l1")
    expect((await waits(r, l1.id)).waitReason).toBe(`Waiting: box ${h1.boxId} is running an agent of heavy, which runs its agents alone on a box`)
    await stop(r, h1.id)
    expect((await done(r, l1.id)).boxId).toBe(h1.boxId)
  })

  it("the stricter limit wins on a shared box, whichever project's agent came first", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 4 })
    const over = watchLimits(r)
    const alpha = await project(r, "alpha", { agentsPerBox: 2 })
    const beta = await project(r, "beta", { agentsPerBox: 3 })
    const a1 = await hang(r, alpha.id, "a1")
    const box = a1.boxId!
    const b1 = await hang(r, beta.id, "b1")
    expect(b1.boxId).toBe(box)

    // alpha allows 2 while its agent runs, though beta allows 3 and the box 4.
    const b2 = await task(r, beta.id, "b2", "keep going [hang]")
    expect((await waits(r, b2.id)).waitReason).toBe(`Waiting: box ${box} is running an agent of alpha, which allows at most 2 agents on a box`)
    expect((await boxes(r)).find((b) => b.id === box)!.projectLimit).toEqual({ slots: 2, project: "alpha" })

    // alpha's agent stops: beta's own 3 applies.
    await stop(r, a1.id)
    expect((await working(r, b2.id)).boxId).toBe(box)
    const b3 = await hang(r, beta.id, "b3")
    expect(b3.boxId).toBe(box)
    const b4 = await task(r, beta.id, "b4")
    expect((await waits(r, b4.id)).waitReason).toBe(`Waiting: beta runs at most 3 agents on a box, and box ${box} has 3 agents running`)
    expect((await boxes(r)).find((b) => b.id === box)!.projectLimit).toEqual({ slots: 3, project: "beta" })

    // And the other way round: alpha's next agent won't make a fourth.
    const a2 = await task(r, alpha.id, "a2")
    expect((await waits(r, a2.id)).waitReason).toBe(`Waiting: alpha runs at most 2 agents on a box, and box ${box} has 3 agents running`)
    await sleep(300)
    expect(inUse(r, box)).toBe(3)
    expect(over).toEqual([])
  })

  it("claims a slot under the stricter limit in one step, the old heavy_tasks value included", () => {
    const r = { yard: createBoxYard(testConfig({ maxBoxes: 2 }), { webDir: "/nonexistent" }) } as Running
    try {
      const store = r.yard.store
      const alpha = store.createProject({ name: "alpha", agentsPerBox: 1 })
      const beta = store.createProject({ name: "beta" })
      const gamma = store.createProject({ name: "gamma", agentsPerBox: 2 })
      for (const id of ["box_shared1", "box_shared2"]) store.upsertBox({ id, provider: "local", status: "ready", created_at: 1, last_used_at: 1, size: "large", keep_alive: 0, usage_source: "estimated" })
      const t = (projectId: string, title: string) => store.createTask({ projectId, title, prompt: "x" }).id
      const claim = (id: string, box: string) => store.claimTurnSlot(id, box, 4, { status: "starting", currentTurnId: `turn-${id}` })
      const [a1, a2, b1, b2, b3, g1] = [t(alpha.id, "a1"), t(alpha.id, "a2"), t(beta.id, "b1"), t(beta.id, "b2"), t(beta.id, "b3"), t(gamma.id, "g1")]

      // beta first: alpha's agent may not join (its own 1), another beta may.
      expect(claim(b1, "box_shared1")).toBe(true)
      expect(claim(a1, "box_shared1")).toBe(false)
      expect(store.projectSlotCap("box_shared1", a1)).toBe(1)
      // gamma joins (2 running), then beta can't make a third while gamma runs there.
      expect(claim(g1, "box_shared1")).toBe(true)
      expect(claim(b2, "box_shared1")).toBe(false)
      expect(store.slotsInUse("box_shared1")).toBe(2)

      // alpha first: nothing joins it.
      expect(claim(a1, "box_shared2")).toBe(true)
      expect(claim(b2, "box_shared2")).toBe(false)
      expect(claim(a2, "box_shared2")).toBe(false)
      expect(store.slotsInUse("box_shared2")).toBe(1)
      // The losers are untouched.
      for (const id of [a2, b2]) expect(store.getTaskRow(id)).toMatchObject({ current_turn_id: null, box_id: null, status: "queued" })

      // A project row still on the old heavy_tasks column (agents_per_box unset) counts as 1.
      store.db.prepare("UPDATE projects SET agents_per_box = NULL, heavy_tasks = 'whole-box' WHERE id = ?").run(gamma.id)
      expect(store.projectBoxLimits(gamma.id).agentsPerBox).toBe(1)
      expect(store.projectSlotCap("box_shared1", b3)).toBe(1)
      expect(claim(b3, "box_shared1")).toBe(false)
    } finally {
      r.yard.stop()
    }
  })

  it("a project's Max boxes: it waits for its own boxes, while other projects still get new ones", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 1 })
    const alpha = await project(r, "alpha", { maxBoxes: 1 })
    const light = await project(r, "light")
    const a1 = await hang(r, alpha.id, "a1")
    const a2 = await task(r, alpha.id, "a2")
    expect((await waits(r, a2.id)).waitReason).toBe("Waiting for a free slot: alpha is at its limit of 1 box")

    const l1 = await hang(r, light.id, "l1")
    expect(l1.boxId).not.toBe(a1.boxId)
    await sleep(300)
    expect(r.yard.store.listBoxes()).toHaveLength(2)
    expect((await getTask(r, a2.id)).status).toBe("queued")

    await stop(r, a1.id)
    expect((await done(r, a2.id)).boxId).toBe(a1.boxId)
  })

  it("a fan-out never makes more boxes than the project's Max boxes, and raising it lets more come", async () => {
    const r = await start({ maxBoxes: 5, slotsPerBox: 1 })
    const alpha = await project(r, "alpha", { maxBoxes: 2 })
    const ids = await Promise.all([1, 2, 3, 4].map(async (n) => (await task(r, alpha.id, `t${n}`, "keep going [hang]")).id))
    await waitFor(async () => (await Promise.all(ids.map((id) => getTask(r, id)))).filter((t) => t.status === "working").length === 2, "two to work")
    await sleep(500)
    expect(r.yard.store.listBoxes()).toHaveLength(2)
    const queued = (await Promise.all(ids.map((id) => getTask(r, id)))).filter((t) => t.status === "queued")
    expect(queued).toHaveLength(2)
    for (const t of queued) expect(t.waitReason).toBe("Waiting for a free slot: alpha is at its limit of 2 boxes")

    await patch(r, alpha.id, { maxBoxes: 3 })
    await waitFor(async () => (await Promise.all(ids.map((id) => getTask(r, id)))).filter((t) => t.status === "working").length === 3, "a third to work")
    await sleep(300)
    expect(r.yard.store.listBoxes()).toHaveLength(3)
  })

  it("Agents per box: a batch asks for a box per waiting agent", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 3 })
    const heavy = await project(r, "heavy", { agentsPerBox: 1 })
    const ids = await Promise.all(["h1", "h2", "h3"].map(async (t) => (await task(r, heavy.id, t, "keep going [hang]")).id))
    const all = await Promise.all(ids.map((id) => working(r, id)))
    expect(new Set(all.map((t) => t.boxId)).size).toBe(3)
  })

  it("Tasks per box: the stricter one keeps task folders spread over boxes", async () => {
    const r = await start({ maxBoxes: 2, slotsPerBox: 3, maxResidentPerBox: 12 })
    const alpha = await project(r, "alpha", { tasksPerBox: 1 })
    const a1 = await done(r, (await task(r, alpha.id, "a1")).id)
    const a2 = await done(r, (await task(r, alpha.id, "a2")).id)
    expect(a2.boxId).not.toBe(a1.boxId)
  })

  it("falls back to the global settings, and clearing an override goes back to them", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const alpha = await project(r, "alpha", { agentsPerBox: 1 })
    const a1 = await hang(r, alpha.id, "a1")
    const a2 = await task(r, alpha.id, "a2", "keep going [hang]")
    expect((await waits(r, a2.id)).waitReason).toMatch(/^Waiting: alpha runs each of its agents alone on a box/)

    // Cleared: the global Agents per box (2) applies straight away.
    await patch(r, alpha.id, { agentsPerBox: null })
    expect((await working(r, a2.id)).boxId).toBe(a1.boxId)
    const a3 = await task(r, alpha.id, "a3")
    expect((await waits(r, a3.id)).waitReason).toBe("Waiting for a free slot: every box is full and the pool is at its limit")
    expect(inUse(r, a1.boxId!)).toBe(2)
  })
})

describe("project box settings: heavy_tasks migration", () => {
  const migration = MIGRATIONS.findIndex((m) => m.includes("agents_per_box"))
  // Every heavy_tasks value a project can hold: the three the app wrote, unset, and ones it never wrote (main read
  // those as off, so they stay on the global setting).
  const HEAVY: [id: string, heavy: string | null, agentsPerBox: number | null][] = [
    ["prj_off", "off", null],
    ["prj_one", "one-per-box", 1],
    ["prj_whole", "whole-box", 1],
    ["prj_unset", null, null],
    ["prj_empty", "", null],
    ["prj_bogus", "WHOLE-BOX", null],
  ]

  function oldDb() {
    const dir = tmpDir()
    const old = new Database(path.join(dir, "box-yard.sqlite"))
    migrate(old, migration)
    const insert = old.prepare("INSERT INTO projects (id, name, created_at, updated_at, heavy_tasks) VALUES (?, ?, 1, 1, ?)")
    for (const [id, heavy] of HEAVY) insert.run(id, id, heavy)
    old.close()
    return dir
  }

  const columns = (db: Database.Database) =>
    db.prepare("SELECT id, heavy_tasks, agents_per_box, tasks_per_box, max_boxes FROM projects ORDER BY id").all()

  it("turns one-per-box and whole-box into Agents per box 1, loses nothing, and saving clears the old value", () => {
    const db = openDb(oldDb())
    dbs.push(db)
    const store = new Store(db)
    for (const [id, heavy, agentsPerBox] of HEAVY) {
      expect(store.getProject(id), `${id} (${heavy})`).toMatchObject({ agentsPerBox, tasksPerBox: null, maxBoxes: null })
      expect(store.projectBoxLimits(id), `${id} (${heavy})`).toEqual({ agentsPerBox, tasksPerBox: null, maxBoxes: null })
    }
    expect(store.projectBoxLimits("prj_whole")).toEqual({ agentsPerBox: 1, tasksPerBox: null, maxBoxes: null })
    // The old column keeps its value until the project's Agents per box is saved.
    const heavy = (id: string) => (db.prepare("SELECT heavy_tasks FROM projects WHERE id = ?").get(id) as { heavy_tasks: string | null }).heavy_tasks
    expect(heavy("prj_one")).toBe("one-per-box")
    expect(store.updateProject("prj_one", { description: "x" }).agentsPerBox).toBe(1)
    expect(heavy("prj_one")).toBe("one-per-box")

    // Cleared: back to the global one for good, not to the old value.
    expect(store.updateProject("prj_one", { agentsPerBox: null }).agentsPerBox).toBeNull()
    expect(heavy("prj_one")).toBeNull()
    expect(store.getProject("prj_one")!.agentsPerBox).toBeNull()
    expect(store.updateProject("prj_whole", { agentsPerBox: 3 }).agentsPerBox).toBe(3)
    expect(heavy("prj_whole")).toBeNull()
  })

  it("runs once, and running it again changes nothing", () => {
    const dir = oldDb()
    const db = openDb(dir)
    const after = columns(db)
    expect(after).toHaveLength(HEAVY.length)
    db.close()

    // Opening the database again doesn't re-run it: _migrations records it once.
    const again = openDb(dir)
    dbs.push(again)
    expect(columns(again)).toEqual(after)
    expect(again.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE version = ?").get(migration + 1)).toEqual({ n: 1 })

    // Its UPDATE, run again by hand, leaves every row as it is, including one whose Agents per box was set
    // afterwards while heavy_tasks still holds the old value.
    again.prepare("UPDATE projects SET agents_per_box = 3 WHERE id = 'prj_whole'").run()
    const set = columns(again)
    const update = MIGRATIONS[migration]!.split("\n").find((l) => l.trim().startsWith("UPDATE projects"))!
    again.exec(update)
    again.exec(update)
    expect(columns(again)).toEqual(set)
    expect(new Store(again).getProject("prj_whole")!.agentsPerBox).toBe(3)
  })
})
