import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// High-priority tasks jump the queue (shared/priority.ts): when a slot frees up on this computer (Settings › Tasks
// running at once on this computer) or on a box, a queued high task starts before every normal one, first in, first
// out within each. Running agents are never stopped, and a high task its own project's limit holds back doesn't
// block the normal tasks behind it.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []
const scratch: string[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const boxesDir = tmpDir("boxes-")
  const config = testConfig({ port, ...overrides })
  scratch.push(boxesDir, config.dataDir)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(boxesDir, FAKE_CLAUDE), localRunner: new LocalRunnerProvider(config.localDir, FAKE_CLAUDE) })
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
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id || t.status === "queued") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
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

type ToolRes = { content: { text: string }[]; isError?: boolean }

/** An in-process MCP client as the Coordinator or as one project's Captain. */
async function mcpAs(r: Running, caller: McpCaller = { kind: "coordinator" }) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes
    expect(res.isError, `${name}: ${res.content[0]?.text}`).not.toBe(true)
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  }
}

const HANG = "keep going [hang]"
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const project = (r: Running, body: Record<string, unknown>) => call<Project>(r, "POST", "/api/projects", body)
/** Tasks made one after another, a few ms apart, so their place in the queue (last_active_at) is distinct. */
async function queue(r: Running, specs: { projectId: string; title: string; priority?: "high" | "normal" }[]): Promise<Task[]> {
  const made: Task[] = []
  for (const s of specs) {
    made.push(r.yard.tasks.createTask({ ...s, prompt: HANG }))
    await new Promise((res) => setTimeout(res, 15))
  }
  return made
}
const working = (r: Running, id: string) => waitFor(() => (getTask(r, id).status === "working" ? getTask(r, id) : null), `task ${id} to work`)
const queued = (r: Running, id: string) => waitFor(() => (getTask(r, id).status === "queued" && getTask(r, id).waitReason ? getTask(r, id) : null), `task ${id} to wait`)
/** Which of `ids` got a turn next (exactly one may), once it's working. */
async function nextStarted(r: Running, ids: string[]): Promise<string> {
  const id = await waitFor(() => ids.find((x) => r.yard.store.getTaskRow(x)?.current_turn_id), `one of ${ids.join(", ")} to start`)
  await working(r, id)
  // Only one slot freed: the others stay queued.
  for (const other of ids.filter((x) => x !== id)) expect(getTask(r, other).status, `${getTask(r, other).title} still waits`).toBe("queued")
  return id
}

/** Stops each running task in turn and returns the titles in the order the queue gave them the slot. */
async function drain(r: Running, first: Task, rest: Task[]): Promise<string[]> {
  const order: string[] = []
  let current = first.id
  let left = rest.map((t) => t.id)
  while (left.length) {
    await r.yard.tasks.stopTask(current)
    current = await nextStarted(r, left)
    order.push(getTask(r, current).title)
    left = left.filter((id) => id !== current)
  }
  return order
}

describe("high priority", () => {
  it("on this computer: high tasks take a freed slot before normal ones, first in, first out within each", async () => {
    const r = await start({ localAgents: 1 })
    const mac = await project(r, { name: "mac", runner: "local" })
    const [hog] = await queue(r, [{ projectId: mac.id, title: "hog" }])
    await working(r, hog!.id)
    const waiting = await queue(r, [
      { projectId: mac.id, title: "normal 1" },
      { projectId: mac.id, title: "high 1", priority: "high" },
      { projectId: mac.id, title: "normal 2", priority: "normal" },
      { projectId: mac.id, title: "high 2", priority: "high" },
    ])
    for (const t of waiting) await queued(r, t.id)
    // The running agent is never stopped for them.
    expect(getTask(r, hog!.id).status).toBe("working")
    expect(await drain(r, hog!, waiting)).toEqual(["high 1", "high 2", "normal 1", "normal 2"])
  })

  it("on a box: a high task takes the box's next free slot", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 1 })
    const cloud = await project(r, { name: "cloud", runner: "box" })
    const [hog] = await queue(r, [{ projectId: cloud.id, title: "hog" }])
    await working(r, hog!.id)
    const waiting = await queue(r, [
      { projectId: cloud.id, title: "normal 1" },
      { projectId: cloud.id, title: "high 1", priority: "high" },
    ])
    for (const t of waiting) await queued(r, t.id)
    expect(await drain(r, hog!, waiting)).toEqual(["high 1", "normal 1"])
  })

  it("a high task its own project's limit holds back doesn't block normal tasks that can run", async () => {
    const r = await start({ localAgents: 2 })
    const heavy = await project(r, { name: "heavy", runner: "local", agentsPerBox: 1 })
    const light = await project(r, { name: "light", runner: "local" })
    const [bench, other] = await queue(r, [
      { projectId: heavy.id, title: "bench" },
      { projectId: light.id, title: "other" },
    ])
    await working(r, bench!.id)
    await working(r, other!.id)
    // Two normal tasks queued before the high one, which only goes first where its project lets it.
    const [n1, n2, urgent] = await queue(r, [
      { projectId: light.id, title: "normal 1" },
      { projectId: light.id, title: "normal 2" },
      { projectId: heavy.id, title: "urgent", priority: "high" },
    ])
    for (const t of [n1!, n2!, urgent!]) await queued(r, t.id)
    // A computer slot frees up, but heavy allows one task at a time: the normal task next in line gets the slot.
    await r.yard.tasks.stopTask(other!.id)
    expect(await nextStarted(r, [n1!.id, n2!.id, urgent!.id])).toBe(n1!.id)
    const held = getTask(r, urgent!.id)
    expect(held.waitFor.map((w) => w.taskId)).toContain(bench!.id)
    // Once its project's limit lets it, it goes before the normal task that has waited longer.
    await r.yard.tasks.stopTask(bench!.id)
    expect(await nextStarted(r, [urgent!.id, n2!.id])).toBe(urgent!.id)
  })

  it("set_task_priority moves a task that is already queued to the front, and pool_status lists the queue in order", async () => {
    const r = await start({ localAgents: 1 })
    await project(r, { name: "mac", runner: "local" })
    const tool = await mcpAs(r)
    const hog = await tool("create_task", { project: "mac", title: "hog", prompt: HANG })
    await working(r, hog.id as string)
    const made = await tool("create_tasks", {
      project: "mac",
      tasks: [
        { title: "first", prompt: HANG },
        { title: "second", prompt: HANG },
        { title: "third", prompt: HANG },
      ],
    })
    const [first, second, third] = (made.tasks as { id: string }[]).map((t) => getTask(r, t.id))
    // One create_tasks call stamps them in one go: space them out so FIFO is well-defined.
    r.yard.store.db.prepare("UPDATE tasks SET last_active_at = last_active_at + ? WHERE id = ?").run(1, second!.id)
    r.yard.store.db.prepare("UPDATE tasks SET last_active_at = last_active_at + ? WHERE id = ?").run(2, third!.id)
    for (const t of [first!, second!, third!]) await queued(r, t.id)

    const raised = await tool("set_task_priority", { task: third!.id, priority: "high" })
    expect(raised.priority).toBe("high")
    expect(getTask(r, third!.id).priority).toBe("high")
    expect(r.yard.store.listTaskMessages(third!.id, 50).some((m) => m.role === "event" && m.content.startsWith("High priority (set by the Coordinator)"))).toBe(true)
    const pool = await tool("pool_status")
    expect((pool.queued as string[]).map((l) => l.replace(/ \(.*$/, ""))).toEqual([
      `1. [high priority] ${third!.id} third`,
      `2. ${first!.id} first`,
      `3. ${second!.id} second`,
    ])
    // Lowering it again puts it back in line.
    await tool("set_task_priority", { task: third!.id, priority: "normal" })
    await tool("set_task_priority", { task: second!.id, priority: "high" })
    expect(getTask(r, third!.id).priority).toBe("normal")
    expect(await drain(r, getTask(r, hog.id as string), [first!, second!, third!])).toEqual(["second", "first", "third"])
  })

  it("a send_to_task follow-up with priority high to a resting task waits ahead of normal ones", async () => {
    const r = await start({ localAgents: 1 })
    await project(r, { name: "mac", runner: "local" })
    const tool = await mcpAs(r)
    // A task that ran and rests.
    const done = await tool("create_task", { project: "mac", title: "earlier", prompt: "write a haiku" })
    await waitFor(() => (getTask(r, done.id as string).status === "done" ? true : null), "the first task to finish")
    const hog = await tool("create_task", { project: "mac", title: "hog", prompt: HANG })
    await working(r, hog.id as string)
    const normal = await tool("create_task", { project: "mac", title: "normal", prompt: HANG })
    await queued(r, normal.id as string)
    await new Promise((res) => setTimeout(res, 15))
    const sent = await tool("send_to_task", { task: done.id, message: `one more ${HANG}`, priority: "high" })
    expect(sent.priority).toBe("high")
    await queued(r, done.id as string)
    expect(await drain(r, getTask(r, hog.id as string), [getTask(r, normal.id as string), getTask(r, done.id as string)])).toEqual(["earlier", "normal"])
  })
})
