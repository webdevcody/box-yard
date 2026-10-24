import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxInfo, BoxResize, BoxSize, Project, ResizePlan, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Resizing a box up or down: in place when the provider can, else by moving the box's work to a new box of the
// target size (archive every workspace, move tasks and projects, delete the old box). Never while agents run unless
// Cody stops them; a scale-down must fit; MCP callers are held to Settings and (Captains) to their own project's boxes.

const MB = 1024 * 1024
const GB = 1024 * MB

/** Disk a folder uses; a `*.ballast` file counts as the byte size written in it. */
function used(file: string): number {
  const st = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!st) return 0
  if (!st.isDirectory()) return file.endsWith(".ballast") ? Number(fs.readFileSync(file, "utf8")) || 0 : st.size
  let total = 0
  for (const e of fs.readdirSync(file)) total += used(path.join(file, e))
  return total
}

/** Local boxes that remember their size, fake df (a size's work disk minus the folder) and can hold creation. */
class SizedBoxes extends LocalProvider {
  sizes = new Map<string, BoxSize>()
  created: BoxSize[] = []
  destroyed: string[] = []
  gate: Promise<void> | null = null
  diskGb: Record<BoxSize, number> = { small: 5, medium: 10, large: 15 }

  override async create(opts?: { labels: string[]; size?: BoxSize }): Promise<string> {
    if (this.gate) await this.gate
    const id = await super.create()
    this.sizes.set(id, opts?.size ?? "small")
    this.created.push(opts?.size ?? "small")
    return id
  }

  override async destroy(boxId: string) {
    this.destroyed.push(boxId)
    return super.destroy(boxId)
  }

  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk")) {
      const u = used(this.root(boxId))
      const total = this.diskGb[this.sizes.get(boxId) ?? "small"] * GB
      const kb = (n: number) => Math.floor(Math.max(0, n) / 1024)
      return { exitCode: 0, stdout: `fakefs ${kb(total)} ${kb(u)} ${kb(total - u)} 50% ${this.root(boxId)}\n`, stderr: "" }
    }
    return super.exec(boxId, command)
  }
}

/** A provider that resizes in place. */
class ResizableBoxes extends SizedBoxes {
  resized: [string, BoxSize][] = []
  async resize(boxId: string, size: BoxSize) {
    this.resized.push([boxId, size])
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
    r.provider.gate = null
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

const project = (r: Running, name: string, extra: Record<string, unknown> = {}) => call<Project>(r, "POST", "/api/projects", { name, ...extra })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
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
const workDir = (r: Running, boxId: string, taskId: string) => path.join(r.yard.tasks.taskDir(boxId, taskId), "work")

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

describe("resize by migration (no provider support)", () => {
  it("makes a box of the new size, moves archived tasks and the project to it, deletes the old one, and the work comes back", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const oldBox = t.boxId!
    fs.writeFileSync(path.join(workDir(r, oldBox, t.id), "notes.md"), "kept across the resize\n")
    r.yard.store.updateTask(t.id, { lastArchivedAt: Date.now() - 60_000 }, { touch: false })

    const plan = await call<ResizePlan>(r, "GET", `/api/boxes/${oldBox}/resize?size=medium`)
    expect(plan).toMatchObject({ from: "small", to: "medium", mode: "migration", tasks: 1, fit: null, refusal: null, running: [] })

    // Hold the new box's creation to watch placement skip both boxes meanwhile.
    let release!: () => void
    r.provider.gate = new Promise((res) => (release = res))
    const started = await call<BoxResize>(r, "POST", `/api/boxes/${oldBox}/resize`, { size: "medium" })
    expect(started).toMatchObject({ status: "running", from: "small", to: "medium", mode: "migration", by: { kind: "cody" } })
    expect((await boxes(r)).find((b) => b.id === oldBox)?.operation).toBe("resize")
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more haiku" })
    await status(r, t.id, (x) => x.waitReason === `Waiting while box ${oldBox} is resized`, "the task to wait for the resize")
    const busy = await send(r, "POST", `/api/boxes/${oldBox}/clear`, {})
    expect(busy.status).toBe(409)
    expect(busy.data.error).toBe(`Box ${oldBox} is busy: resizing is in progress.`)
    release()

    const done = await finished(r, oldBox)
    expect(done.status).toBe("done")
    expect(done.steps.map((s) => [s.key, s.status])).toEqual([
      ["create", "done"],
      ["archive", "done"],
      ["move", "done"],
      ["delete", "done"],
    ])
    expect(done.movedTasks).toEqual([t.id])
    const newBox = done.newBoxId!
    expect(r.provider.created).toEqual(["small", "medium"])
    expect(r.provider.destroyed).toEqual([oldBox])
    const list = await boxes(r)
    expect(list.map((b) => b.id)).toEqual([newBox])
    expect(list[0]).toMatchObject({ size: "medium", resize: { id: done.id, status: "done" } })
    // The archive was refreshed before the move, and the new box is the project's box now.
    expect(r.yard.store.getKv(`project_box:${p.id}`)).toBe(newBox)
    expect(r.yard.store.getKv(`box_owner:${newBox}`)).toBe(p.id)

    // The queued message runs on the new box with the workspace restored from its archive.
    const back = await status(r, t.id, (x) => x.status === "done" && x.pendingCount === 0, "the task to run again")
    expect(back.boxId).toBe(newBox)
    expect(fs.readFileSync(path.join(workDir(r, newBox, t.id), "notes.md"), "utf8")).toBe("kept across the resize\n")
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => m.content.startsWith(`Moved to box ${newBox} (medium) while ${oldBox} was resized.`))).toBe(true)
  })

  it("keeps everything on the old box and drops the new one when a workspace can't be archived", async () => {
    const r = await start({ archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0, "the task to finish")
    await call(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "large" })
    const rep = await finished(r, t.boxId!)
    expect(rep.status).toBe("failed")
    expect(rep.error).toContain(`Couldn't archive ${t.id}, so nothing moved and ${t.boxId} keeps its work.`)
    expect(rep.steps.find((s) => s.key === "archive")?.status).toBe("failed")
    const list = await boxes(r)
    expect(list.map((b) => [b.id, b.size, b.operation])).toEqual([[t.boxId, "small", null]])
    expect(r.provider.destroyed).toEqual([rep.newBoxId])
    expect((await getTask(r, t.id)).boxId).toBe(t.boxId)
    expect(fs.existsSync(workDir(r, t.boxId!, t.id))).toBe(true)
  })
})

describe("resize in place (provider support)", () => {
  it("changes the size of the same box and keeps its workspaces", async () => {
    const provider = new ResizableBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
    const r = await start({ slotsPerBox: 1, maxResidentPerBox: 3 }, provider)
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const plan = await call<ResizePlan>(r, "GET", `/api/boxes/${t.boxId}/resize?size=large`)
    expect(plan.mode).toBe("in-place")
    await call(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "large" })
    const rep = await finished(r, t.boxId!)
    expect(rep).toMatchObject({ status: "done", mode: "in-place", newBoxId: null })
    expect(rep.steps.map((s) => [s.key, s.status])).toEqual([["resize", "done"]])
    expect(provider.resized).toEqual([[t.boxId, "large"]])
    const box = (await boxes(r)).find((b) => b.id === t.boxId)!
    // A large box runs four agents by default when Settings don't set agents per box.
    expect(box).toMatchObject({ size: "large", slots: 4, diskTotalBytes: 15 * GB })
    expect((await getTask(r, t.id)).boxId).toBe(t.boxId)
    expect(fs.existsSync(workDir(r, t.boxId!, t.id))).toBe(true)
    expect(provider.created).toEqual(["small"])
  })
})

describe("running agents", () => {
  it("refuses while an agent works, and stops it first when asked", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await task(r, p.id, "long one", "think for a while [hang]")
    const working = await status(r, t.id, (x) => x.status === "working", "the agent to start working")
    const boxId = working.boxId!

    const plan = await call<ResizePlan>(r, "GET", `/api/boxes/${boxId}/resize?size=medium`)
    expect(plan.running).toEqual([{ id: t.id, title: "long one" }])
    expect(plan.refusal).toBeNull()
    const refused = await send(r, "POST", `/api/boxes/${boxId}/resize`, { size: "medium" })
    expect(refused.status).toBe(409)
    expect(refused.data.error).toBe(`1 agent is running on ${boxId}: stop it first.`)
    expect((await getTask(r, t.id)).status).toBe("working")
    expect(r.provider.created).toEqual(["small"])

    await call(r, "POST", `/api/boxes/${boxId}/resize`, { size: "medium", stopAgents: true })
    const rep = await finished(r, boxId)
    expect(rep.status).toBe("done")
    expect(rep.steps[0]).toMatchObject({ key: "stop", status: "done" })
    const after = await getTask(r, t.id)
    expect(after.status).not.toBe("working")
    expect(after.boxId).toBe(rep.newBoxId)
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => m.content === `Stopped so Cody could resize box ${boxId}.`)).toBe(true)
  })
})

describe("scale-down disk check", () => {
  it("refuses a smaller size the disk in use wouldn't fit with headroom, and allows it once there's room", async () => {
    // Agents per box and folders per box at the small defaults, so each box's own size decides them.
    const r = await start({ diskMinFreeMb: 1024, slotsPerBox: 1, maxResidentPerBox: 3 })
    const p = await project(r, "alpha", { boxSize: "medium" })
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const boxId = t.boxId!
    // The project's preferred size made a medium box, which runs two agents by default.
    expect((await boxes(r)).find((b) => b.id === boxId)).toMatchObject({ size: "medium", slots: 2 })
    expect(r.provider.created).toEqual(["medium"])

    const big = path.join(r.provider.root(boxId), "cache.ballast")
    fs.writeFileSync(big, String(4.5 * GB))
    const plan = await call<ResizePlan>(r, "GET", `/api/boxes/${boxId}/resize?size=small`)
    expect(plan.fit).toMatchObject({ ok: false, capacityBytes: 5 * GB, headroomBytes: 1024 * MB })
    expect(plan.refusal).toContain(`Can't scale ${boxId} down to small:`)
    expect(plan.refusal).toContain("wouldn't fit")
    const refused = await send(r, "POST", `/api/boxes/${boxId}/resize`, { size: "small" })
    expect(refused.status).toBe(400)
    expect(refused.data.error).toBe(plan.refusal)
    // Scaling up needs no check.
    expect((await call<ResizePlan>(r, "GET", `/api/boxes/${boxId}/resize?size=large`)).fit).toBeNull()

    fs.rmSync(big)
    const ok = await call<ResizePlan>(r, "GET", `/api/boxes/${boxId}/resize?size=small`)
    expect(ok.fit?.ok).toBe(true)
    expect(ok.refusal).toBeNull()
    await call(r, "POST", `/api/boxes/${boxId}/resize`, { size: "small" })
    const rep = await finished(r, boxId)
    expect(rep.status).toBe("done")
    expect((await boxes(r)).map((b) => [b.size, b.slots])).toEqual([["small", 1]])
  })

  it("refuses the same size and unknown sizes", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const same = await send(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "small" })
    expect(same.status).toBe(400)
    expect(same.data.error).toBe(`Box ${t.boxId} is already small.`)
    expect((await send(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "huge" })).status).toBe(400)
  })
})

describe("resize_box over MCP", () => {
  it("scopes Captains to boxes hosting their own project", async () => {
    const r = await start()
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const ta = await settled(r, (await task(r, a.id, "alpha work")).id)
    const tb = await settled(r, (await task(r, b.id, "beta work")).id)
    expect(ta.boxId).not.toBe(tb.boxId)

    const captainA = await mcpAs(r, { kind: "captain", projectId: a.id })
    const other = await captainA("resize_box", { box: tb.boxId, size: "medium", reason: "beta keeps running out of disk" })
    expect(other.isError).toBe(true)
    expect(other.content[0]!.text).toContain(`Out of scope: box ${tb.boxId} doesn't host project "alpha"`)
    expect(r.yard.tasks.resizeReport(tb.boxId!)).toBeNull()

    const own = await captainA("resize_box", { box: ta.boxId, size: "medium", reason: "alpha's build needs more disk" })
    expect(own.isError).toBeFalsy()
    expect(JSON.parse(own.content[0]!.text)).toMatchObject({ started: true, box: ta.boxId, from: "small", to: "medium" })
    const rep = await finished(r, ta.boxId!)
    expect(rep).toMatchObject({ status: "done", by: { kind: "captain", projectId: a.id }, reason: "alpha's build needs more disk" })
  })

  it("follows the Settings guardrails and refuses while agents run", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const coordinator = await mcpAs(r, { kind: "coordinator" })

    const pool = JSON.parse((await coordinator("pool_status")).content[0]!.text)
    expect(pool.resize_box).toEqual({ allowed: true, max_size: "large", how: "migration" })
    expect(pool.boxes[0]).toMatchObject({ id: t.boxId, size: "small (2 vCPU · 4 GB RAM · 10 GB disk)", disk_mb: { total: 5 * 1024 } })

    await call(r, "PUT", "/api/agent-settings", { autoResizeMaxSize: "medium" })
    const tooBig = await coordinator("resize_box", { box: t.boxId, size: "large", reason: "more room" })
    expect(tooBig.isError).toBe(true)
    expect(tooBig.content[0]!.text).toContain("up to medium; large is above that")

    await call(r, "PUT", "/api/agent-settings", { autoResizeEnabled: false })
    const off = await coordinator("resize_box", { box: t.boxId, size: "medium", reason: "more room" })
    expect(off.isError).toBe(true)
    expect(off.content[0]!.text).toContain("Cody has turned off automatic box resizing")
    expect(r.yard.tasks.resizeReport(t.boxId!)).toBeNull()

    await call(r, "PUT", "/api/agent-settings", { autoResizeEnabled: true })
    const hang = await task(r, p.id, "long one", "think for a while [hang]")
    await status(r, hang.id, (x) => x.status === "working", "the agent to start working")
    const busy = await coordinator("resize_box", { box: t.boxId, size: "medium", reason: "more room" })
    expect(busy.isError).toBe(true)
    expect(busy.content[0]!.text).toBe(`1 agent is running on ${t.boxId}: stop it first.`)
    expect((await getTask(r, hang.id)).status).toBe("working")
  })

  it("tells Cody, the Coordinator and the box's Captains why, when it's done", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator("resize_box", { box: t.boxId, size: "medium", reason: "Low on disk three times today" })
    expect(res.isError).toBeFalsy()
    const rep = await finished(r, t.boxId!)
    expect(rep.status).toBe("done")

    const notice = r.yard.store.listChat(200).find((m) => m.role === "notice" && m.content.startsWith("📦"))
    expect(notice?.content).toContain(`📦 The Coordinator resized box ${t.boxId} small → medium: moved to ${rep.newBoxId} (medium)`)
    expect(notice?.content).toContain("Reason: Low on disk three times today")
    // The Coordinator still reads it in its updates, and so does the project's Captain.
    expect(r.yard.store.takeUnseenNotices()).toContain(notice!.content)
    const cap = r.yard.store.listCaptainMessages(p.id, 50).find((m) => m.role === "notice" && m.content.startsWith("📦"))
    expect(cap?.content).toBe(notice?.content)
    const n = r.yard.store.listNotifications().find((x) => x.boxId === rep.newBoxId)
    expect(n).toMatchObject({ taskId: null, status: "done", href: `/boxes#${rep.newBoxId}`, title: `Resized ${t.boxId}: small → medium`, projectName: "alpha" })
    expect(n?.summary).toBe("The Coordinator: Low on disk three times today")
  })

  it("posts nothing extra when Cody resizes from the Boxes page", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    await call(r, "POST", `/api/boxes/${t.boxId}/resize`, { size: "medium" })
    await finished(r, t.boxId!)
    expect(r.yard.store.listChat(200).some((m) => m.content.startsWith("📦"))).toBe(false)
    expect(r.yard.store.listNotifications().some((x) => x.boxId)).toBe(false)
  })
})
