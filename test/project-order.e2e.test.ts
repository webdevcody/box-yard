import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import Database from "better-sqlite3"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { MIGRATIONS, migrate } from "../server/db.js"
import { buildMcpServer } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Project, UiEvent } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

// The owner's project order (sidebar drag-to-reorder) is saved on the server: PUT /api/projects/order
// takes every project id once, new projects go last, and the order survives a restart.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  events: UiEvent[]
}
const running: Running[] = []
const closers: (() => Promise<void>)[] = []

async function start(dataDir = tmpDir()): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, dataDir }), { webDir: "/nonexistent" })
  const events: UiEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (ev: UiEvent) => (events.push(ev), broadcast(ev))
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, events }
  running.push(r)
  return r
}

async function stop(r: Running) {
  running.splice(running.indexOf(r), 1)
  r.yard.stop()
  await new Promise((res) => r.server.close(() => res(null)))
}

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const r of [...running]) await stop(r)
})

async function send(r: Running, method: string, path: string, body?: unknown) {
  const res = await fetch(r.base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as any }
}
const create = async (r: Running, name: string) => (await send(r, "POST", "/api/projects", { name })).data as Project
const names = async (r: Running) => ((await send(r, "GET", "/api/projects")).data as Project[]).map((p) => p.name)
const reorder = (r: Running, ids: unknown) => send(r, "PUT", "/api/projects/order", { ids })

describe("project order", () => {
  it("reorders every project in one call, broadcasts it, and puts new projects last", async () => {
    const r = await start()
    const a = await create(r, "alpha")
    const b = await create(r, "beta")
    const c = await create(r, "gamma")
    expect(await names(r)).toEqual(["alpha", "beta", "gamma"])

    const res = await reorder(r, [c.id, a.id, b.id])
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ ids: [c.id, a.id, b.id] })
    expect(await names(r)).toEqual(["gamma", "alpha", "beta"])
    expect(r.events).toContainEqual({ type: "projects.order", ids: [c.id, a.id, b.id] })

    await create(r, "delta")
    expect(await names(r)).toEqual(["gamma", "alpha", "beta", "delta"])
  })

  it("refuses unknown, missing or repeated ids and leaves the order alone", async () => {
    const r = await start()
    const a = await create(r, "alpha")
    const b = await create(r, "beta")
    r.events.length = 0

    const unknown = await reorder(r, [a.id, b.id, "prj_nothere"])
    expect(unknown.status).toBe(400)
    expect(unknown.data.error).toMatch(/Unknown project: prj_nothere/)

    const missing = await reorder(r, [b.id])
    expect(missing.status).toBe(400)
    expect(missing.data.error).toMatch(new RegExp(`missing ${a.id}`))

    const twice = await reorder(r, [b.id, a.id, b.id])
    expect(twice.status).toBe(400)
    expect(twice.data.error).toMatch(/listed twice/)

    expect((await reorder(r, "nope")).status).toBe(400)
    expect((await send(r, "PUT", "/api/projects/order", {})).status).toBe(400)

    expect(await names(r)).toEqual(["alpha", "beta"])
    expect(r.events.filter((e) => e.type === "projects.order")).toEqual([])
  })

  it("survives a restart", async () => {
    const dataDir = tmpDir()
    const r = await start(dataDir)
    const a = await create(r, "alpha")
    const b = await create(r, "beta")
    const c = await create(r, "gamma")
    await reorder(r, [b.id, c.id, a.id])
    await stop(r)

    const r2 = await start(dataDir)
    expect(await names(r2)).toEqual(["beta", "gamma", "alpha"])
    await create(r2, "delta")
    expect(await names(r2)).toEqual(["beta", "gamma", "alpha", "delta"])
  })

  it("list_projects follows the saved order", async () => {
    const dataDir = tmpDir()
    const r = await start(dataDir)
    const a = await create(r, "alpha")
    const b = await create(r, "beta")
    await reorder(r, [b.id, a.id])

    const y = r.yard
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, uploads: new Uploads(uploadsDir(dataDir), 1024 * 1024) }
    const mcp = buildMcpServer(deps, { kind: "coordinator" })
    const [ca, cb] = InMemoryTransport.createLinkedPair()
    await mcp.connect(ca)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(cb)
    closers.push(async () => (await client.close(), await mcp.close()))
    const out = (await client.callTool({ name: "list_projects", arguments: {} })) as { content: { text: string }[] }
    expect((JSON.parse(out.content[0]!.text) as { name: string }[]).map((p) => p.name)).toEqual(["beta", "alpha"])
  })

  it("the migration keeps existing projects in creation order", async () => {
    const dataDir = tmpDir()
    const db = new Database(path.join(dataDir, "box-yard.sqlite"))
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("sort_order")))
    const insert = db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    insert.run("prj_second", "second", 2000, 2000)
    insert.run("prj_first", "first", 1000, 1000)
    insert.run("prj_third", "third", 3000, 3000)
    db.close()

    const r = await start(dataDir)
    expect(await names(r)).toEqual(["first", "second", "third"])
    await create(r, "fourth")
    expect(await names(r)).toEqual(["first", "second", "third", "fourth"])
  })
})
