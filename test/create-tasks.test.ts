import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, MAX_TASK_BATCH, type McpCaller } from "../server/mcp.js"
import { Artifacts } from "../server/artifacts.js"
import { LocalProvider } from "../server/providers/local.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { FAKE_CLAUDE, freePort, testConfig, waitFor } from "./helpers.js"

// create_tasks: many tasks in one MCP call, checked all at once, scoped like create_task.

/** Boxes that never finish being created, so every task stays queued and no agent runs. */
class NeverReady extends LocalProvider {
  creates = 0
  override create(): Promise<string> {
    this.creates++
    return new Promise(() => {})
  }
}

interface Running {
  yard: BoxYard
  server: Server
  dataDir: string
  artifacts: Artifacts
  uploads: Uploads
  provider: NeverReady
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(overrides: Parameters<typeof testConfig>[0] = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const provider = new NeverReady(path.join(config.dataDir, "local-boxes"), FAKE_CLAUDE)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = {
    yard,
    server,
    dataDir: config.dataDir,
    artifacts: new Artifacts(yard.store, path.join(config.dataDir, "artifacts")),
    uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024),
    provider,
  }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    // runs_on "local" tasks start on the local runner (the box provider never makes a box): let their turns end.
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

type ToolRes = { content: { type: string; text: string }[]; isError?: boolean }

async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: r.artifacts, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: r.uploads }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  return {
    raw,
    json: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await raw(name, args)
      if (res.isError) throw new Error(res.content[0]!.text)
      return JSON.parse(res.content[0]!.text)
    },
    error: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await raw(name, args)
      expect(res.isError).toBe(true)
      return res.content[0]!.text
    },
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
  }
}

/** The files a task got with its prompt, from its first transcript line. */
function attachmentsOf(r: Running, taskId: string) {
  const first = r.yard.store.listTaskMessages(taskId, 10).find((m) => m.role === "user")!
  return ((first.meta as { attachments?: { id: string; name: string }[] }).attachments ?? []).map((f) => f.name)
}
function uploadIdsOf(r: Running, taskId: string) {
  const first = r.yard.store.listTaskMessages(taskId, 10).find((m) => m.role === "user")!
  return ((first.meta as { attachments?: { id: string }[] }).attachments ?? []).map((f) => f.id)
}

describe("create_tasks", () => {
  it("creates every task in one call, in order, with the shared brief, files, env and routing", async () => {
    const r = await start()
    const { store } = r.yard
    const p = store.createProject({ name: "town" })
    const earlier = store.createTask({ projectId: p.id, title: "Survey the plots", prompt: "x" })
    store.updateTask(earlier.id, { status: "done", summary: "Plots 1 to 3 are flat." })
    const shared = r.uploads.save("style.md", Buffer.from("red roofs"))
    const plan = r.artifacts.save({ title: "Site plan", filename: "plan.md", data: Buffer.from("# Plan"), projectId: p.id, taskId: null })
    const coordinator = await mcpAs(r, { kind: "coordinator" })

    const res = await coordinator.json("create_tasks", {
      project: "town",
      common_prompt: "Build one building for the town. Open a PR when done.",
      attachments: [shared.id],
      env: { STYLE: "brick", LEVEL: "1" },
      effort: "medium",
      tasks: [
        { title: "Bakery", prompt: "Build the bakery on plot 1.", attachments: [plan.id], related_tasks: [earlier.id] },
        { title: "Library", prompt: "Build the library on plot 2.", attachments: [plan.id], env: { LEVEL: "2" }, model: "claude-sonnet-5-5", effort: "high" },
        { title: "Tower", prompt: "Build the tower on plot 3." },
      ],
    })
    expect(res.created).toBe(3)
    expect(res.project).toBe("town")
    expect(res.tasks.map((t: { title: string }) => t.title)).toEqual(["Bakery", "Library", "Tower"])
    const [bakery, library, tower] = res.tasks.map((t: { id: string }) => store.getTask(t.id)!)
    for (const t of [bakery, library, tower]) {
      expect(t.id).toMatch(/^task_/)
      expect(t.projectId).toBe(p.id)
      expect(t.status).toBe("queued")
    }

    // The shared brief goes first, then the task's own part; related work only where asked for.
    expect(bakery.prompt).toBe(
      `Build one building for the town. Open a PR when done.\n\nBuild the bakery on plot 1.\n\n## Related earlier work\n- Survey the plots (${earlier.id}, done)\n  Outcome: Plots 1 to 3 are flat.`,
    )
    expect(tower.prompt).toBe("Build one building for the town. Open a PR when done.\n\nBuild the tower on plot 3.")

    // Shared files plus the item's own; an artifact is copied once for the whole batch.
    expect(attachmentsOf(r, bakery.id)).toEqual(["style.md", "plan.md"])
    expect(attachmentsOf(r, tower.id)).toEqual(["style.md"])
    expect(uploadIdsOf(r, bakery.id)).toEqual(uploadIdsOf(r, library.id))
    expect(uploadIdsOf(r, bakery.id)[1]).toMatch(/^up_/)
    expect(fs.readFileSync(path.join(uploadsDir(r.dataDir), uploadIdsOf(r, bakery.id)[1]!, "plan.md"), "utf8")).toBe("# Plan")

    // Env merges with the item winning; model and effort come from the item, else the call.
    expect(JSON.parse(store.getTaskRow(bakery.id)!.env_json!)).toEqual({ STYLE: "brick", LEVEL: "1" })
    expect(JSON.parse(store.getTaskRow(library.id)!.env_json!)).toEqual({ STYLE: "brick", LEVEL: "2" })
    expect([bakery.effort, library.effort, tower.effort]).toEqual(["medium", "high", "medium"])
    expect(library.model).toBe("claude-sonnet-5-5")
    expect(bakery.model).not.toBe("claude-sonnet-5-5")
  })

  it("creates nothing when any item is bad, and lists every problem by item number", async () => {
    const r = await start()
    const { store } = r.yard
    const p = store.createProject({ name: "town" })
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const before = store.listTasks().length

    const err = await coordinator.error("create_tasks", {
      project: p.id,
      tasks: [
        { title: "Bakery", prompt: "ok" },
        { title: "bakery ", prompt: "same title in another case" },
        { title: "Library", prompt: "   " },
        { title: "Tower", prompt: "ok", attachments: ["up_000000000000"] },
        { title: "Mill", prompt: "ok", related_tasks: ["task_000000000000"] },
        { title: "Gate", prompt: "ok", attachments: ["art_000000000000"] },
        { title: "Well", prompt: "fine" },
      ],
    })
    expect(err).toMatch(/^No task was created: 5 problems\. Fix them and call create_tasks again with the whole list\./)
    expect(err).toContain('- #2 "bakery": same title as #1')
    expect(err).toContain('- #3 "Library": prompt is empty')
    expect(err).toMatch(/- #4 "Tower" attachments "up_000000000000": /)
    expect(err).toMatch(/- #5 "Mill" related_tasks "task_000000000000": /)
    expect(err).toMatch(/- #6 "Gate" attachments "art_000000000000": No artifact/)
    expect(err).not.toContain("#1 ")
    expect(err).not.toContain("#7")
    expect(store.listTasks()).toHaveLength(before)
    expect(r.provider.creates).toBe(0)

    // A bad shared ref is reported once, not per item.
    const shared = await coordinator.error("create_tasks", { project: p.id, attachments: ["up_000000000000"], tasks: [{ title: "A", prompt: "a" }, { title: "B", prompt: "b" }] })
    expect(shared).toMatch(/^No task was created: one problem\. Fix it/)
    expect(shared).toMatch(/- attachments "up_000000000000": /)
    expect(store.listTasks()).toHaveLength(before)
  })

  it(`takes 1 to ${MAX_TASK_BATCH} tasks`, async () => {
    const r = await start()
    const p = r.yard.store.createProject({ name: "town" })
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Lot ${i + 1}`, prompt: `Build on lot ${i + 1}.` }))
    expect((await coordinator.raw("create_tasks", { project: p.id, tasks: [] })).isError).toBe(true)
    expect((await coordinator.raw("create_tasks", { project: p.id, tasks: items(MAX_TASK_BATCH + 1) })).isError).toBe(true)
    expect(r.yard.store.listTasks()).toHaveLength(0)

    const res = await coordinator.json("create_tasks", { project: p.id, tasks: items(MAX_TASK_BATCH) })
    expect(res.created).toBe(MAX_TASK_BATCH)
    expect(res.tasks.map((t: { title: string }) => t.title)).toEqual(items(MAX_TASK_BATCH).map((t) => t.title))
    expect(new Set(res.tasks.map((t: { id: string }) => t.id)).size).toBe(MAX_TASK_BATCH)
    expect(r.yard.store.listTasks()).toHaveLength(MAX_TASK_BATCH)
  })

  it("keeps a Captain to its own project: the project, related tasks and artifacts", async () => {
    const r = await start()
    const { store } = r.yard
    const alpha = store.createProject({ name: "alpha" })
    const beta = store.createProject({ name: "beta" })
    const betaTask = store.createTask({ projectId: beta.id, title: "Beta work", prompt: "x" })
    store.updateTask(betaTask.id, { status: "done" })
    const alphaTask = store.createTask({ projectId: alpha.id, title: "Alpha work", prompt: "x" })
    store.updateTask(alphaTask.id, { status: "done" })
    const betaDoc = r.artifacts.save({ title: "Beta doc", filename: "doc.md", data: Buffer.from("beta only"), projectId: beta.id, taskId: null })
    const captain = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    expect(await captain.tools()).toContain("create_tasks")
    const before = store.listTasks().length

    expect(await captain.error("create_tasks", { project: "beta", tasks: [{ title: "A", prompt: "a" }] })).toMatch(/^Out of scope: project "beta"/)
    const err = await captain.error("create_tasks", {
      project: "alpha",
      tasks: [
        { title: "A", prompt: "a", related_tasks: [betaTask.id] },
        { title: "B", prompt: "b", attachments: [betaDoc.id] },
      ],
    })
    expect(err).toMatch(/- #1 "A" related_tasks "task_\w+": Out of scope/)
    expect(err).toMatch(/- #2 "B" attachments "art_\w+": Out of scope: artifact/)
    expect(store.listTasks()).toHaveLength(before)

    const res = await captain.json("create_tasks", { project: "alpha", related_tasks: [alphaTask.id], tasks: [{ title: "A", prompt: "a" }, { title: "B", prompt: "b" }] })
    expect(res.created).toBe(2)
    for (const t of res.tasks) {
      const task = store.getTask(t.id)!
      expect(task.projectId).toBe(alpha.id)
      expect(task.prompt).toContain(`- Alpha work (${alphaTask.id}, done)`)
    }
    // Started by the Captain, like create_task.
    expect(store.getTaskRow(res.tasks[0].id)!.source).toBe(`captain:${alpha.id}`)
  })

  it("takes runs_on per item and as a shared default, and checks every runner before creating anything", async () => {
    const r = await start()
    const { store } = r.yard
    const p = store.createProject({ name: "mac", runner: "local" })
    const coordinator = await mcpAs(r, { kind: "coordinator" })

    const res = await coordinator.json("create_tasks", {
      project: "mac",
      runs_on: "box",
      tasks: [
        { title: "Shared", prompt: "a" },
        { title: "Own", prompt: "b", runs_on: "local" },
      ],
    })
    const [shared, own] = res.tasks.map((t: { id: string }) => store.getTask(t.id)!)
    expect(shared.runsOn).toBe("box")
    expect(own.runsOn).toBe("local")
    expect(store.taskRunner(store.getTaskRow(shared.id)!)).toBe("box")
    // Without runs_on a task follows its project.
    const plain = await coordinator.json("create_tasks", { project: "mac", tasks: [{ title: "Plain", prompt: "c" }] })
    const plainRow = store.getTaskRow(plain.tasks[0].id)!
    expect(store.getTask(plainRow.id)!.runsOn).toBeNull()
    expect(store.taskRunner(plainRow)).toBe("local")
    // create_task takes it too, and says so in its reply.
    const one = await coordinator.json("create_task", { project: "mac", title: "One", prompt: "d", runs_on: "box" })
    expect(one.runsOn).toBe("box")

    // This computer can't run agents: every item that wants it is listed, and nothing is created.
    r.yard.tasks.runnerProblem = async (runner) => (runner === "local" ? "Claude Code isn't installed on this computer" : null)
    const before = store.listTasks().length
    const err = await coordinator.error("create_tasks", {
      project: "mac",
      runs_on: "local",
      tasks: [
        { title: "Here", prompt: "a" },
        { title: "There", prompt: "b", runs_on: "box" },
        { title: "Also here", prompt: "c" },
      ],
    })
    expect(err).toMatch(/^No task was created: 2 problems/)
    expect(err).toContain(`- #1 "Here": runs_on "local": Can't run it on this computer: Claude Code isn't installed on this computer.`)
    expect(err).toContain(`- #3 "Also here": runs_on "local"`)
    expect(err).not.toContain("#2")
    expect(await coordinator.error("create_task", { project: "mac", title: "Here", prompt: "a", runs_on: "local" })).toContain("Can't run it on this computer")
    expect(store.listTasks()).toHaveLength(before)
    // send_to_task with runs_on is refused the same way, and nothing is sent or pinned.
    expect(await coordinator.error("send_to_task", { task: one.id, message: "continue locally", runs_on: "local" })).toContain("Can't run it on this computer")
    expect(store.getTask(one.id)!.runsOn).toBe("box")
    expect(store.getTask(one.id)!.pendingCount).toBe(0)
  })
})
