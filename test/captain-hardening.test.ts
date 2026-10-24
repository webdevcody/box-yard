import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { followupPrompt } from "../server/prompts.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { userMessageLabel } from "../shared/sender.js"
import type { CaptainState, ChatMessage, Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, orchestratorAutoWake: true })
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

/** A task that sits idle without running a worker turn. */
function parkedTask(r: Running, projectId: string, title: string): Task {
  const t = r.yard.store.createTask({ projectId, title, prompt: title })
  r.yard.store.updateTask(t.id, { status: "idle" })
  return r.yard.store.getTask(t.id)!
}

const COORDINATOR_ONLY = ["create_project", "update_project", "delete_project", "send_to_captain", "ask_captain", "wait_for_captain", "clean_up_box", "save_note"]

describe("Captain MCP scoping (#43)", () => {
  async function twoProjects() {
    const r = await start()
    const a = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const b = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    return { r, a, b, ta: parkedTask(r, a.id, "Alpha work"), tb: parkedTask(r, b.id, "Beta work") }
  }

  it("hides project-admin and cross-Captain tools from a Captain, but not from the Coordinator", async () => {
    const { r, a } = await twoProjects()
    const captain = await mcpAs(r, { kind: "captain", projectId: a.id })
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const captainTools = (await captain.client.listTools()).tools.map((t) => t.name)
    const coordinatorTools = (await coordinator.client.listTools()).tools.map((t) => t.name)
    for (const name of COORDINATOR_ONLY) {
      expect(captainTools).not.toContain(name)
      expect(coordinatorTools).toContain(name)
    }
    expect(captainTools).toContain("create_task")

    for (const name of COORDINATOR_ONLY) {
      const res = await captain.tool(name, { project: "beta", name: "gamma", message: "hi" })
      expect(res.isError, name).toBe(true)
      expect(res.content[0]!.text).toMatch(/not found/)
    }
    expect(r.yard.store.findProject("gamma")).toBeNull()
    expect(r.yard.store.findProject("beta")).not.toBeNull()
  })

  it("denies a Captain another project's tasks and project, with a clear error", async () => {
    const { r, a, b, tb } = await twoProjects()
    const { tool } = await mcpAs(r, { kind: "captain", projectId: a.id })
    const denied: [string, Record<string, unknown>][] = [
      ["get_task", { task: tb.id }],
      ["send_to_task", { task: tb.id, message: "hi" }],
      ["set_task_model", { task: tb.id, effort: "low" }],
      ["stop_task", { task: tb.id }],
      ["close_task", { task: tb.id }],
      ["retry_task", { task: tb.id }],
      ["get_preview_url", { task: tb.id, port: 3000 }],
      ["wait_for_tasks", { tasks: [tb.id], timeout_seconds: 5 }],
      ["find_compactions_by_task", { task: tb.id }],
      ["create_task", { project: b.id, title: "sneaky", prompt: "x" }],
      ["create_task", { project: "alpha", title: "sneaky", prompt: "x", related_tasks: [tb.id] }],
      ["add_note", { project: "beta", content: "x" }],
      ["list_notes", { project: "beta" }],
      ["list_note_suggestions", { project: "beta" }],
      ["list_note_suggestions", { task: tb.id }],
      ["list_tasks", { project: "beta" }],
      ["list_artifacts", { project: "beta" }],
      ["create_artifact", { title: "x", filename: "x.md", content: "x", task: tb.id }],
      ["create_schedule", { project: "beta", name: "nightly", cron: "@daily", prompt: "x" }],
      ["create_schedule", { name: "digest", cron: "@daily", prompt: "x", target: "orchestrator" }],
      ["list_schedules", { target: "orchestrator" }],
    ]
    for (const [name, args] of denied) {
      const res = await tool(name, args)
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(res.content[0]!.text, name).toMatch(/^Out of scope: .*You are the Captain for project "alpha"/)
    }
    expect(r.yard.store.listTasks({ projectId: b.id })).toHaveLength(1)
    expect(r.yard.store.listTasks({ projectId: a.id })).toHaveLength(1)
    expect(r.yard.store.listNotes(b.id)).toHaveLength(0)
    expect(r.yard.store.getTask(tb.id)!.pendingCount).toBe(0)
    expect(r.yard.store.listSchedules()).toHaveLength(0)

    // A title from another project isn't even found.
    expect((await tool("get_task", { task: "Beta work" })).content[0]!.text).toMatch(/No task "Beta work" in this project/)
  })

  it("denies a Captain another project's schedules", async () => {
    const { r, b } = await twoProjects()
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator.tool("create_schedule", { project: "beta", name: "Beta nightly", cron: "@daily", prompt: "x", enabled: false })).isError).not.toBe(true)
    expect((await coordinator.tool("create_schedule", { name: "Digest", cron: "@daily", prompt: "x", enabled: false })).isError).not.toBe(true)
    const alpha = r.yard.store.findProject("alpha")!
    const { tool } = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    for (const schedule of ["Beta nightly", "Digest"]) {
      for (const name of ["update_schedule", "delete_schedule", "run_schedule_now", "list_schedule_runs"]) {
        const res = await tool(name, { schedule, name: "renamed" })
        expect(res.isError, `${name} ${schedule}`).toBe(true)
        expect(res.content[0]!.text).toMatch(/^Out of scope: schedule/)
      }
    }
    expect(JSON.parse((await tool("list_schedules")).content[0]!.text)).toEqual([])
    expect(r.yard.store.listSchedules({ projectId: b.id })[0]!.name).toBe("Beta nightly")
  })

  it("lets a Captain work normally inside its own project", async () => {
    const { r, a, ta } = await twoProjects()
    const { tool } = await mcpAs(r, { kind: "captain", projectId: a.id })
    const ok = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await tool(name, args)
      expect(res.isError, `${name}: ${res.content[0]?.text}`).not.toBe(true)
      return res.content[0]!.text
    }
    expect(JSON.parse(await ok("get_task", { task: ta.id })).id).toBe(ta.id)
    expect(JSON.parse(await ok("get_task", { task: "Alpha work" })).id).toBe(ta.id)
    expect(JSON.parse(await ok("list_projects")).map((p: Project) => p.name)).toEqual(["alpha"])
    // No project filter means "my project".
    expect(JSON.parse(await ok("list_tasks")).map((t: Task) => t.id)).toEqual([ta.id])
    await ok("add_note", { content: "Captain note" })
    expect(r.yard.store.listNotes(a.id).map((n) => n.author)).toEqual(["captain"])
    await ok("set_task_model", { task: ta.id, effort: "low" })
    // Schedules default to the Captain's project.
    const sched = JSON.parse(await ok("create_schedule", { name: "Alpha nightly", cron: "@daily", prompt: "x", enabled: false }))
    expect(sched.project).toBe("alpha")
    await ok("update_schedule", { schedule: "Alpha nightly", name: "Alpha nightly 2" })
    await ok("delete_schedule", { schedule: "Alpha nightly 2" })
    const created = JSON.parse(await ok("create_task", { project: "alpha", title: "New alpha work", prompt: "write a haiku", related_tasks: [ta.id] }))
    expect(created.project).toBe("alpha")
    await waitFor(() => !["queued", "starting", "working"].includes(r.yard.store.getTask(created.id)!.status), "captain task to settle")
  })

  it("leaves the Coordinator's tool set unscoped", async () => {
    const { r, tb } = await twoProjects()
    const { tool } = await mcpAs(r, { kind: "coordinator" })
    expect(JSON.parse((await tool("get_task", { task: tb.id })).content[0]!.text).id).toBe(tb.id)
    expect(JSON.parse((await tool("list_projects")).content[0]!.text)).toHaveLength(2)
    expect(JSON.parse((await tool("list_tasks")).content[0]!.text)).toHaveLength(2)
    expect((await tool("save_note", { project: "beta", content: "x" })).isError).not.toBe(true)
    expect((await tool("create_project", { name: "gamma" })).isError).not.toBe(true)
    expect((await tool("update_project", { project: "gamma", description: "third" })).isError).not.toBe(true)
    expect((await tool("delete_project", { project: "gamma" })).isError).not.toBe(true)
  })

  it("gives each Captain its own MCP token, enforced by the HTTP endpoint", async () => {
    const { r, a, tb } = await twoProjects()
    const mcpCall = (token: string, name: string, args: Record<string, unknown>) =>
      fetch(`${r.base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
    const token = r.yard.captains.tokenFor(a.id)
    expect(r.yard.captains.tokenFor(a.id)).toBe(token)
    expect(r.yard.captains.projectForToken(token)).toBe(a.id)

    const denied = await (await mcpCall(token, "get_task", { task: tb.id })).json()
    expect(denied.result.isError).toBe(true)
    expect(denied.result.content[0].text).toMatch(/^Out of scope/)
    const admin = await (await mcpCall(token, "delete_project", { project: "beta" })).json()
    expect(admin.result.isError).toBe(true)
    expect(r.yard.store.findProject("beta")).not.toBeNull()
    expect((await mcpCall("nope", "list_tasks", {})).status).toBe(401)

    // The Captain's claude process is configured with its own token, not the Coordinator's.
    r.yard.captains.send(a.id, "status")
    await waitFor(() => !r.yard.captains.state(a.id).busy && fs.existsSync(path.join(r.dataDir, "captains", a.id, "mcp.json")), "Captain turn")
    const captainCfg = JSON.parse(fs.readFileSync(path.join(r.dataDir, "captains", a.id, "mcp.json"), "utf8"))
    expect(captainCfg.mcpServers.boxyard.headers.Authorization).toBe(`Bearer ${token}`)
    expect(token).toMatch(/^cpt_/)
  })
})

describe("Captain message labels (#51)", () => {
  it("formats Captain messages to workers with the project name", () => {
    const names = (id: string) => (id === "prj_alpha01" ? "alpha" : undefined)
    expect(followupPrompt([{ source: "captain:prj_alpha01", content: "Please add tests." }], names)).toBe(
      "Message from the alpha Captain (on Cody's behalf):\n\nPlease add tests.",
    )
    expect(followupPrompt([{ source: "orchestrator", content: "hi" }], names)).toBe("Message from the Box Yard Coordinator (on Cody's behalf):\n\nhi")
    expect(followupPrompt([{ source: "captain:prj_gone01", content: "hi" }], names)).toMatch(/^Message from the project Captain \(on Cody's behalf\)/)
    expect(userMessageLabel({ source: "captain", captainName: "alpha" })).toBe("alpha Captain")
    expect(userMessageLabel({ source: "orchestrator" })).toBe("Coordinator")
    expect(userMessageLabel(null)).toBe("Cody")
  })

  it("labels a Captain's send_to_task as from that Captain, in the worker prompt and the transcript", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await waitFor(async () => (await call<Task>(r, "GET", `/api/tasks/${t.id}`)).status === "done", "task done")

    const { tool } = await mcpAs(r, { kind: "captain", projectId: p.id })
    expect((await tool("send_to_task", { task: t.id, message: "Make it rhyme." })).isError).not.toBe(true)

    const msg = r.yard.store.listTaskMessages(t.id, 50).find((m) => m.role === "user" && m.content === "Make it rhyme.")!
    expect(msg.meta).toMatchObject({ source: "captain", captainProjectId: p.id, captainName: "alpha" })
    expect(userMessageLabel(msg.meta)).toBe("alpha Captain")

    // The fake worker writes the prompt it got into box-yard-demo.md.
    const task = await waitFor(async () => {
      const x = await call<Task>(r, "GET", `/api/tasks/${t.id}`)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "follow-up turn")
    const demo = fs.readFileSync(path.join(r.dataDir, "local-boxes", task.boxId!, "tasks", t.id, "work", "box-yard-demo.md"), "utf8")
    expect(demo).toContain("Message from the alpha Captain (on Cody's behalf):\n\nMake it rhyme.")
    expect(demo).not.toContain("Coordinator")
  })
})

describe("Captain loop guard (#45)", () => {
  async function setup(loopGuard = { maxRepeats: 2, windowMs: 60_000, throttleMs: 1500, maxThrottleMs: 5000 }) {
    const r = await start()
    r.yard.captains.tuning.wakeDebounceMs = 30
    r.yard.captains.tuning.loopGuard = loopGuard
    const p = await call<Project>(r, "POST", "/api/projects", { name: "nightly" })
    const t = parkedTask(r, p.id, "Overnight job")
    const state = () => r.yard.captains.state(p.id) as CaptainState
    const unseen = () => r.yard.store.peekUnseenCaptainNotices(p.id)
    const notice = (text: string) => r.yard.captains.notice(text, { taskId: t.id })
    const settled = (autoTurns: number) => waitFor(() => !state().busy && state().autoTurns === autoTurns && unseen().length === 0, `${autoTurns} auto-turns`)
    const reports = (re: RegExp) => r.yard.store.listChat(500).filter((m: ChatMessage) => m.meta?.captain === true && re.test(m.content))
    return { r, p, t, state, unseen, notice, settled, reports }
  }

  it("processes every unattended wake-up that brings new events, well past the old cap of 6", async () => {
    const { state, notice, settled } = await setup()
    for (let i = 1; i <= 10; i++) {
      notice(`✅ **Overnight job** is done: batch ${i} processed`)
      await settled(i)
    }
    expect(state().throttledUntil).toBeNull()
  }, 60_000)

  it("throttles a real loop, tells the Coordinator, and delivers what queued meanwhile", async () => {
    const { state, unseen, notice, settled, reports } = await setup()
    const loop = "❌ **Overnight job** failed: exit code 1"
    notice(loop)
    await settled(1)
    notice(loop)
    await settled(2)

    // The third identical wake is a loop: held back, reported once, and kept queued.
    notice(loop)
    await waitFor(() => state().throttledUntil, "throttle")
    const notices = await waitFor(() => reports(/Loop guard/), "loop guard report")
    expect(notices[0]!.content).toMatch(/^Captain for nightly: Loop guard: .*1 update is queued, not dropped/)
    expect(unseen()).toEqual([loop])
    notice(loop)
    await new Promise((res) => setTimeout(res, 300))
    expect(state().autoTurns).toBe(2)
    expect(unseen()).toEqual([loop, loop])

    // When the throttle ends, the queued updates go out in one wake.
    await settled(3)
    expect(state().throttledUntil).toBeNull()
    expect(reports(/Loop guard/)).toHaveLength(1)

    // Still looping: throttled again, and a new event lifts it at once with the queued repeats.
    notice(loop)
    await waitFor(() => state().throttledUntil, "second throttle")
    expect(unseen()).toEqual([loop])
    notice("✅ **Overnight job** is done: fixed the build")
    await settled(4)
    expect(state().throttledUntil).toBeNull()
    expect(reports(/Loop guard/)).toHaveLength(2)
  }, 60_000)

  it("a message from Cody or the Coordinator lifts the throttle and takes the queued updates", async () => {
    const { r, p, state, unseen, notice, settled } = await setup({ maxRepeats: 1, windowMs: 60_000, throttleMs: 60_000, maxThrottleMs: 60_000 })
    const loop = "💬 **Overnight job** finished its turn: (no reply)"
    notice(loop)
    await settled(1)
    notice(loop)
    await waitFor(() => state().throttledUntil, "throttle")
    expect(unseen()).toEqual([loop])
    r.yard.captains.send(p.id, "status")
    await waitFor(() => !state().busy && unseen().length === 0, "message turn")
    expect(state()).toMatchObject({ throttledUntil: null, autoTurns: 0 })
  }, 60_000)
})
