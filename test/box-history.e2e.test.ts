import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxUsageProbe } from "../server/providers/types.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxEvent, BoxResize, BoxSize, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The box history log: every path that creates, resizes, deletes, loses or cleans a box writes one row saying what
// happened and who did it, so "where did my box go" has an answer (the failed-resize cleanup case especially).

/** Local boxes that remember their size and can report another one (a size change at the provider). */
class SizedBoxes extends LocalProvider {
  sizes = new Map<string, BoxSize>()
  reported = new Map<string, BoxSize>()
  override async create(opts?: { labels: string[]; size?: BoxSize }): Promise<string> {
    const id = await super.create()
    this.sizes.set(id, opts?.size ?? "small")
    return id
  }
  override async usage(boxId: string): Promise<BoxUsageProbe> {
    return { ...(await super.usage(boxId)), size: this.reported.get(boxId) ?? this.sizes.get(boxId) ?? "small" }
  }
  async listIds(): Promise<string[]> {
    return fs.existsSync(this.baseDir) ? fs.readdirSync(this.baseDir).filter((d) => d.startsWith("local-")) : []
  }
}

class ResizableBoxes extends SizedBoxes {
  async resize(boxId: string, size: BoxSize) {
    this.sizes.set(boxId, size)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: SizedBoxes
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(overrides: Partial<Config> = {}, provider: SizedBoxes = new SizedBoxes(tmpDir("boxes-"), FAKE_CLAUDE)): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, maxBoxes: 3, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running"), "resizes to settle").catch(() => {})
    await waitFor(() => !r.yard.captains.anyBusy(), "captains to settle").catch(() => {})
    await new Promise((res) => setTimeout(res, 300))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function send(r: Running, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}
async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const { status, data } = await send(r, method, urlPath, body)
  if (status >= 400) throw new Error(`${method} ${urlPath} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return want(t) ? t : null
  }, what)
const settled = (r: Running, id: string) => status(r, id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pendingCount === 0, `task ${id} to finish and archive`)
const finished = (r: Running, boxId: string) =>
  waitFor(() => {
    const rep = r.yard.tasks.resizeReport(boxId)
    return rep && rep.status !== "running" ? rep : null
  }, `the resize of ${boxId} to finish`)
type History = { events: BoxEvent[]; more: boolean; boxIds: string[] }
const history = (r: Running, query = "") => call<History>(r, "GET", `/api/box-history${query}`)
/** Oldest first, as [box, type, actor] for compact checks. */
const trail = (events: BoxEvent[]) => [...events].reverse().map((e) => [e.boxId, e.type, e.actor])

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
}

/** Reach into TaskManager's timers' state, so a test can run a pass now instead of waiting it out. */
const internals = (r: Running) => r.yard.tasks as unknown as { lastEventAt: Map<string, number>; lastBoxProbeAt: Map<string, number>; lastOrphanSweepAt: number }

describe("box history: create and resize", () => {
  it("records placement, the resize migration's new box, the old box's delete and the resize itself, with who and why", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const oldBox = t.boxId!

    const created = (await history(r)).events
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ boxId: oldBox, boxName: oldBox, type: "created", actor: "scheduler", size: "small", projects: [{ id: p.id, name: "alpha" }], taskIds: [t.id] })
    expect(created[0]!.reason).toBe("Project alpha needed a box for its tasks.")

    r.yard.store.updateTask(t.id, { lastArchivedAt: Date.now() - 60_000 }, { touch: false })
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator("resize_box", { box: oldBox, size: "medium", reason: "Low on disk three times today" })).isError).toBeFalsy()
    const rep = await finished(r, oldBox)
    expect(rep.status).toBe("done")
    const newBox = rep.newBoxId!

    const all = (await history(r)).events
    expect(trail(all)).toEqual([
      [oldBox, "created", "scheduler"],
      [newBox, "created", "resize"],
      [oldBox, "deleted", "resize"],
      [oldBox, "resized", "coordinator"],
    ])
    const [resized, deleted, target] = all
    expect(resized).toMatchObject({ fromSize: "small", toSize: "medium", relatedBoxId: newBox, resizeId: rep.id, reason: "Low on disk three times today", taskIds: [t.id], projects: [{ id: p.id, name: "alpha" }] })
    expect(resized!.detail).toContain(`Migrated to ${newBox}`)
    expect(deleted).toMatchObject({ relatedBoxId: newBox, size: "small", taskIds: [t.id], projects: [{ id: p.id, name: "alpha" }] })
    expect(deleted!.reason).toBe(`Resized small → medium; ${newBox} took over its work.`)
    expect(target).toMatchObject({ size: "medium", relatedBoxId: oldBox, resizeId: rep.id, taskIds: [t.id] })
    expect(target!.reason).toBe(`Target of the resize of ${oldBox} small → medium, asked by The Coordinator: Low on disk three times today`)

    // The deleted box stays in the box filter, and filtering by it follows the migration to the new box.
    const h = await history(r, `?boxId=${oldBox}`)
    expect(h.boxIds).toEqual([oldBox, newBox])
    expect(trail(h.events).map((x) => x[1])).toEqual(["created", "created", "deleted", "resized"])
    expect(trail((await history(r, "?type=deleted")).events)).toEqual([[oldBox, "deleted", "resize"]])
    expect(trail((await history(r, "?actor=coordinator")).events)).toEqual([[oldBox, "resized", "coordinator"]])
    const page = await history(r, "?limit=2")
    expect(page.events.map((e) => e.type)).toEqual(["resized", "deleted"])
    expect(page.more).toBe(true)
    expect((await history(r, `?limit=2&before=${page.events[1]!.id}`)).events.map((e) => e.type)).toEqual(["created", "created"])
    expect((await send(r, "GET", "/api/box-history?type=exploded")).status).toBe(400)
    expect((await send(r, "GET", "/api/box-history?actor=gremlins")).status).toBe(400)
  })

  it("records a failed migration, the failed-resize cleanup of its new box, and Cody as the one who asked", async () => {
    const r = await start({ archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0, "the task to finish")
    await call(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "large" })
    const rep = await finished(r, t.boxId!)
    expect(rep.status).toBe("failed")
    const made = rep.newBoxId!

    const events = (await history(r)).events
    expect(trail(events)).toEqual([
      [t.boxId, "created", "scheduler"],
      [made, "created", "resize"],
      [made, "deleted", "resize-cleanup"],
      [t.boxId, "resize_failed", "owner"],
    ])
    const [failed, cleanup] = events
    expect(failed).toMatchObject({ fromSize: "small", toSize: "large", relatedBoxId: made, resizeId: rep.id, reason: null, taskIds: [t.id] })
    expect(failed!.detail).toBe(rep.error)
    expect(cleanup).toMatchObject({ size: "large", fromSize: "small", toSize: "large", relatedBoxId: t.boxId, resizeId: rep.id, taskIds: [], projects: [{ id: p.id, name: "alpha" }] })
    expect(cleanup!.reason).toBe(`Nothing moved to it: the resize of ${t.boxId} failed at its archive step.`)
  })

  it("records the cleanup that deletes a box a failed resize left behind (the merry-albacore case)", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    // A large box a failed resize made, still empty (a failure from before failed resizes cleaned up after themselves).
    const left = await r.provider.create({ labels: [], size: "large" })
    const at = Date.now() - 10 * 60_000
    r.yard.store.upsertBox({ id: left, provider: "local", status: "ready", created_at: at, last_used_at: at, size: "large", keep_alive: 0, usage_source: "estimated" })
    const failed: BoxResize = {
      id: "rsz_failedone1",
      boxId: t.boxId!,
      newBoxId: left,
      from: "small",
      to: "large",
      mode: "migration",
      status: "failed",
      steps: [],
      movedTasks: [],
      by: { kind: "captain", projectId: p.id },
      reason: "bigger builds",
      error: "archive step failed",
      startedAt: at,
      finishedAt: at,
    }
    r.yard.store.setKv(`box_resize:${t.boxId}`, JSON.stringify(failed))
    r.yard.store.setKv(`box_resize:${left}`, JSON.stringify(failed))

    await r.yard.tasks.maintain()
    await waitFor(() => !r.yard.store.getBox(left), "the leftover box to go")
    const [e] = (await history(r, `?boxId=${left}`)).events
    expect(e).toMatchObject({ boxId: left, type: "deleted", actor: "resize-cleanup", size: "large", relatedBoxId: t.boxId, resizeId: failed.id, projects: [{ id: p.id, name: "alpha" }] })
    expect(e!.reason).toBe(`Left empty by the failed resize of ${t.boxId} (small → large) and never used since.`)
    // The alpha Captain can find it too: its project lost the box.
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const rows = JSON.parse((await captain("box_history", { box: left })).content[0]!.text)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ box: left, event: "deleted", by: "Failed-resize cleanup", other_box: t.boxId, size: "small → large" })
  })

  it("records an in-place resize by a Captain with its reason, and a size change the provider reports", async () => {
    const provider = new ResizableBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
    const r = await start({}, provider)
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    expect((await captain("resize_box", { box: t.boxId, size: "large", reason: "alpha's build needs more disk" })).isError).toBeFalsy()
    expect((await finished(r, t.boxId!)).status).toBe("done")
    const [resized] = (await history(r)).events
    expect(resized).toMatchObject({ boxId: t.boxId, type: "resized", actor: "captain", actorProjectId: p.id, fromSize: "small", toSize: "large", relatedBoxId: null, reason: "alpha's build needs more disk" })
    expect(resized!.detail).toMatch(/^In place: /)

    provider.reported.set(t.boxId!, "medium")
    internals(r).lastBoxProbeAt.clear()
    await r.yard.tasks.maintain()
    const [changed] = await waitFor(async () => {
      const e = (await history(r, "?type=size_changed")).events
      return e.length ? e : null
    }, "the size change")
    expect(changed).toMatchObject({ boxId: t.boxId, actor: "provider", fromSize: "large", toSize: "medium", size: "medium" })
    // Once on record it's not news again.
    internals(r).lastBoxProbeAt.clear()
    await r.yard.tasks.maintain()
    expect((await history(r, "?type=size_changed")).events).toHaveLength(1)
  })
})

describe("box history: delete, clear, cleanup, lost, idle, orphans", () => {
  it("records Clean up now, Clear box and Delete box from the UI, and clean_up_box by the Coordinator", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const boxId = t.boxId!

    await call(r, "POST", `/api/boxes/${boxId}/cleanup`)
    await waitFor(async () => ((await history(r, "?type=cleanup")).events.length ? true : null), "the cleanup row")
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator("clean_up_box", { box: boxId })).isError).toBeFalsy()
    await waitFor(async () => ((await history(r, "?type=cleanup")).events.length === 2 ? true : null), "the second cleanup row")
    const [byCoordinator, byOwner] = (await history(r, "?type=cleanup")).events
    expect(byOwner).toMatchObject({ actor: "owner", reason: "Clean up now." })
    expect(byCoordinator).toMatchObject({ actor: "coordinator", reason: "Clean up now." })
    expect(byOwner!.detail).toMatch(/^freed /)

    await call(r, "POST", `/api/boxes/${boxId}/clear`, {})
    const [cleared] = (await history(r, "?type=cleared")).events
    expect(cleared).toMatchObject({ boxId, actor: "owner", taskIds: [t.id] })
    expect(cleared!.freedBytes).toEqual(expect.any(Number))

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more" })
    const back = await settled(r, t.id)
    await call(r, "DELETE", `/api/boxes/${back.boxId}`)
    const [deleted] = (await history(r, "?type=deleted")).events
    expect(deleted).toMatchObject({ boxId: back.boxId, actor: "owner", size: "small", taskIds: [t.id], projects: [{ id: p.id, name: "alpha" }] })
    expect(deleted!.detail).toBe("Deleted from the Boxes page; every workspace was archived first.")
  })

  it("records a box the provider reports gone as lost, with the task that was on it", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await task(r, p.id, "long one", "think for a while [hang]")
    const working = await status(r, t.id, (x) => x.status === "working", "the agent to start working")
    const boxId = working.boxId!
    fs.rmSync(r.provider.root(boxId), { recursive: true, force: true })
    internals(r).lastEventAt.set(t.id, Date.now() - 60 * 60_000)
    await r.yard.tasks.maintain()
    const [lost] = (await history(r, "?type=lost")).events
    expect(lost).toMatchObject({ boxId, actor: "provider", taskIds: [t.id], projects: [{ id: p.id, name: "alpha" }] })
    expect(lost!.reason).toBe("The provider reports the box gone (a running turn went quiet).")
  })

  it("records the idle janitor retiring a box and the orphan sweep deleting a box Box Yard doesn't know", async () => {
    const r = await start({ boxIdleDeleteMinutes: 5 })
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    r.yard.store.db.prepare("UPDATE boxes SET last_used_at = ? WHERE id = ?").run(Date.now() - 30 * 60_000, t.boxId)
    const orphan = await r.provider.create({ labels: [], size: "medium" })
    internals(r).lastOrphanSweepAt = 0
    await r.yard.tasks.maintain()

    const [retired] = (await history(r, `?boxId=${t.boxId}&type=deleted`)).events
    expect(retired).toMatchObject({ actor: "janitor", taskIds: [t.id], projects: [{ id: p.id, name: "alpha" }] })
    expect(retired!.reason).toMatch(/^Idle for 3\d min \(Settings retires boxes after 5 min\); every workspace was archived\.$/)
    const [swept] = (await history(r, "?type=orphan_deleted")).events
    expect(swept).toMatchObject({ boxId: orphan, actor: "orphan-sweep", size: null, projects: [], taskIds: [], detail: null })
    expect(fs.existsSync(r.provider.root(orphan))).toBe(false)
  })
})

describe("box_history over MCP", () => {
  it("shows a Captain only its own project's boxes; the Coordinator sees all", async () => {
    const r = await start()
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const ta = await settled(r, (await task(r, a.id, "alpha work")).id)
    const tb = await settled(r, (await task(r, b.id, "beta work")).id)
    expect(ta.boxId).not.toBe(tb.boxId)
    await call(r, "DELETE", `/api/boxes/${tb.boxId}`)

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const all = JSON.parse((await coordinator("box_history")).content[0]!.text) as { box: string; event: string; by: string }[]
    expect(all.map((e) => [e.box, e.event, e.by])).toEqual([
      [tb.boxId, "deleted", "Cody"],
      [tb.boxId, "created", "Box Yard (placement)"],
      [ta.boxId, "created", "Box Yard (placement)"],
    ])
    expect(JSON.parse((await coordinator("box_history", { box: tb.boxId, limit: 1 })).content[0]!.text)).toMatchObject([{ box: tb.boxId, event: "deleted", projects: ["beta"], tasks: [tb.id] }])

    const captainA = await mcpAs(r, { kind: "captain", projectId: a.id })
    const own = JSON.parse((await captainA("box_history")).content[0]!.text) as { box: string }[]
    expect(own.map((e) => e.box)).toEqual([ta.boxId])
    const other = await captainA("box_history", { box: tb.boxId })
    expect(other.isError).toBe(true)
    expect(other.content[0]!.text).toContain(`Out of scope: box ${tb.boxId} never hosted project "alpha"`)
    // A box nobody has history for is just empty.
    expect(JSON.parse((await captainA("box_history", { box: "local-nothing" })).content[0]!.text)).toEqual([])
  })

  it("names the owner from Settings", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    await call(r, "PUT", "/api/agent-settings", { ownerName: "Ada" })
    await call(r, "DELETE", `/api/boxes/${t.boxId}`)
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const [e] = JSON.parse((await coordinator("box_history", { type: "deleted" })).content[0]!.text)
    expect(e.by).toBe("Ada")
  })
})
