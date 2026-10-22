import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import type { Config } from "../server/config.js"
import type { ChatMessage, OrchestratorState, Project, SettingsInfo, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Context usage, compaction (tasks and the orchestrator), the compaction log,
// and the model/effort settings, end to end with the fake claude.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  config: Config
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_TOKENS_PER_TURN", "FAKE_CLAUDE_BAD_SUMMARY", "FAKE_CLAUDE_WINDOW"]

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, config }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const k of ENV_KEYS) delete process.env[k]
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

const logFile = () => {
  const file = path.join(tmpDir(), "fake-claude.log")
  process.env.FAKE_CLAUDE_LOG = file
  return () =>
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { args: string[]; prompt: string })
}
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const quiet = (t: Task) => !["queued", "starting", "working"].includes(t.status) && t.pendingCount === 0 && !t.compactPending && !t.compacting
const untilQuiet = (r: Running, id: string, what = "task to settle") => waitFor(async () => (quiet(await getTask(r, id)) ? getTask(r, id) : null), what)
const compactions = (r: Running) => {
  const dir = r.yard.orchestrator.compactionsDir
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : []
}
const chat = (r: Running) => call<ChatMessage[]>(r, "GET", "/api/chat")
const say = async (r: Running, content: string, nth = 1) => {
  await call(r, "POST", "/api/chat", { content })
  await waitFor(async () => (await chat(r)).filter((m) => m.role === "assistant").length >= nth && !r.yard.orchestrator.busy, "orchestrator reply")
}

describe("task context usage and compaction", () => {
  it("shows usage after a turn, compacts on demand, and keeps the status and session", async () => {
    const lines = logFile()
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    const done = await untilQuiet(r, t.id)
    expect(done.status).toBe("done")
    expect(done.contextTokens).toBeGreaterThan(3000)
    expect(done.contextWindow).toBe(200_000)

    // defaults reach the CLI: opus 5.5 with high effort
    const turn = lines().find((l) => l.args.includes("--resume") === false && l.args.includes("--session-id"))!
    expect(argOf(turn.args, "--model")).toBe("claude-opus-5-5")
    expect(argOf(turn.args, "--effort")).toBe("high")

    const before = done.contextTokens!
    await call(r, "POST", `/api/tasks/${t.id}/compact`)
    const after = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return quiet(x) && x.contextTokens !== before ? x : null
    }, "compaction")
    expect(after.contextTokens).toBeLessThan(before)
    expect(after.status).toBe("done") // a compaction doesn't change the status
    expect(after.sessionId).toBe(done.sessionId)
    expect(after.turnCount).toBe(done.turnCount) // and isn't counted as a turn
    const events = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    expect(events.some((m) => /Context compacted from/.test(m.content))).toBe(true)
    const compact = lines().find((l) => l.prompt === "/compact")!
    expect(compact.args).toContain("--resume")
  })

  it("queues the compaction behind a running turn and runs it before queued messages", async () => {
    const lines = logFile()
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Slow", prompt: "go [slow]" })
    await waitFor(async () => ((await getTask(r, t.id)).status === "working" ? true : null), "working")
    const queued = await call<Task>(r, "POST", `/api/tasks/${t.id}/compact`)
    expect(queued.compactPending).toBe(true)
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more thing" })
    await untilQuiet(r, t.id, "everything to run")
    const order = lines().map((l) => l.prompt.slice(0, 12))
    const ci = order.findIndex((x) => x.startsWith("/compact"))
    const fi = order.findIndex((x) => x.startsWith("Message from"))
    expect(ci).toBeGreaterThan(0)
    expect(fi).toBeGreaterThan(ci)
  })

  it("won't compact a session that hasn't started", async () => {
    const r = await start()
    const t = r.yard.store.createTask({ projectId: r.yard.store.createProject({ name: "p" }).id, title: "x", prompt: "y" })
    await expect(call(r, "POST", `/api/tasks/${t.id}/compact`)).rejects.toThrow(/nothing to compact/)
  })
})

describe("settings reach the CLI", () => {
  it("applies saved model and effort to the next worker turn, and the env var is overridden", async () => {
    const lines = logFile()
    const r = await start({ workerModel: "env-model" })
    expect((await call<SettingsInfo>(r, "GET", "/api/agent-settings")).settings.agentModel).toBe("env-model")
    const info = await call<SettingsInfo>(r, "PUT", "/api/agent-settings", { agentModel: "ui-model", agentEffort: "low", agentAutoCompact: { enabled: true, unit: "percent", value: 50 } })
    expect(info.sources.agentModel).toBe("ui")
    await expect(call(r, "PUT", "/api/agent-settings", { agentEffort: "ludicrous" })).rejects.toThrow(/400/)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "A", prompt: "hi" })
    await untilQuiet(r, t.id)
    const turn = lines().find((l) => l.args.includes("--session-id"))!
    expect(argOf(turn.args, "--model")).toBe("ui-model")
    expect(argOf(turn.args, "--effort")).toBe("low")
    expect(argOf(turn.args, "--autocompact")).toBe("500000") // 50% of the assumed 1m window on a first turn
  })

  it("lets the orchestrator decide effort per task and per message, and hides the param otherwise", async () => {
    const lines = logFile()
    const r = await start()
    const connect = async () => {
      const server = buildMcpServer({
        store: r.yard.store, tasks: r.yard.tasks, hub: r.yard.hub, artifacts: null as never, scheduler: r.yard.scheduler, settings: r.yard.settings, publicUrl: () => "",
      } as never)
      const [a, b] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: "t", version: "0" })
      await Promise.all([server.connect(a), client.connect(b)])
      return client
    }
    const schema = async (name: string) => {
      const tools = (await (await connect()).listTools()).tools
      return tools.find((t) => t.name === name)!
    }
    // fixed mode: no effort param
    expect(Object.keys((await schema("create_task")).inputSchema.properties ?? {})).not.toContain("effort")
    expect(Object.keys((await schema("send_to_task")).inputSchema.properties ?? {})).not.toContain("effort")

    await call(r, "PUT", "/api/agent-settings", { agentEffort: "orchestrator" })
    const create = await schema("create_task")
    expect(Object.keys(create.inputSchema.properties ?? {})).toContain("effort")
    expect(JSON.stringify(create.inputSchema.properties)).toMatch(/one-command chores/)
    expect(JSON.stringify(create.inputSchema.properties)).toMatch(/real coding/)

    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const client = await connect()
    const out = (await client.callTool({ name: "create_task", arguments: { project: p.name, title: "Chore", prompt: "run ls", effort: "low" } })) as { content: { text: string }[] }
    const id = JSON.parse(out.content[0]!.text).id as string
    await untilQuiet(r, id)
    expect((await getTask(r, id)).effort).toBe("low")
    expect(argOf(lines().find((l) => l.args.includes("--session-id") && l.prompt.includes("Chore"))!.args, "--effort")).toBe("low")

    await client.callTool({ name: "send_to_task", arguments: { task: id, message: "now implement the feature [slow]", effort: "high" } })
    await untilQuiet(r, id)
    expect((await getTask(r, id)).effort).toBe("high")
    const follow = lines().filter((l) => l.args.includes("--resume") && l.prompt.startsWith("Message from"))
    expect(argOf(follow.at(-1)!.args, "--effort")).toBe("high")

    // back to a fixed level: the effort the orchestrator picked is ignored
    await call(r, "PUT", "/api/agent-settings", { agentEffort: "medium" })
    await client.callTool({ name: "send_to_task", arguments: { task: id, message: "again", effort: "max" } })
    await untilQuiet(r, id)
    expect(argOf(lines().filter((l) => l.args.includes("--resume") && l.prompt.startsWith("Message from")).at(-1)!.args, "--effort")).toBe("medium")
  })
})

describe("orchestrator usage, compaction and the durable log", () => {
  it("tracks usage live and passes model, effort, Read access and the log path to the CLI", async () => {
    const lines = logFile()
    const r = await start()
    await say(r, "status")
    const state = await call<OrchestratorState>(r, "GET", "/api/orchestrator")
    expect(state.usage.tokens).toBeGreaterThan(3000)
    expect(state.usage.window).toBe(200_000)
    const args = lines().find((l) => l.args.includes("--mcp-config"))!.args
    expect(argOf(args, "--model")).toBe("claude-opus-5-5")
    expect(argOf(args, "--effort")).toBe("high")
    const dir = r.yard.orchestrator.compactionsDir
    expect(dir).toBe(path.join(r.config.dataDir, "orchestrator", "compactions"))
    expect(argOf(args, "--append-system-prompt")).toContain(dir)
    expect(argOf(args, "--append-system-prompt")).toMatch(/chronological/)
    expect(argOf(args, "--tools")).toContain("Read")
    expect(argOf(args, "--allowedTools")).toContain(`Read(/${dir}/**)`)
  })

  it("writes the summary file first, then compacts, and records before/after", async () => {
    const lines = logFile()
    const r = await start()
    await say(r, "status")
    const before = (await call<OrchestratorState>(r, "GET", "/api/orchestrator")).usage.tokens!
    await call(r, "POST", "/api/orchestrator/compact")
    await waitFor(async () => (compactions(r).length === 1 && !(await call<OrchestratorState>(r, "GET", "/api/orchestrator")).compacting ? true : null), "compaction")
    const [name] = compactions(r)
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/)
    const text = fs.readFileSync(path.join(r.yard.orchestrator.compactionsDir, name!), "utf8")
    expect(text).toMatch(/trigger: button/)
    expect(text).toMatch(new RegExp(`tokens_before: ${before}\\b`))
    expect(text).toMatch(/tokens_after: 2000\b/)
    expect(text).toContain("## Decisions and preferences")
    expect(text).toContain("## Open threads and next steps")
    const order = lines().map((l) => l.prompt)
    const si = order.findIndex((x) => x.includes("Your context is about to be compacted"))
    const ci = order.findIndex((x) => x === "/compact")
    expect(si).toBeGreaterThan(0)
    expect(ci).toBeGreaterThan(si)
    const state = await call<OrchestratorState>(r, "GET", "/api/orchestrator")
    expect(state.usage.tokens).toBe(2000)
    expect(state.lastCompaction).toMatchObject({ trigger: "button", tokensAfter: 2000 })
    // the summary turn is not shown in the chat, and the next turn still works (same session)
    expect((await chat(r)).some((m) => m.content.includes("Cody prefers short replies"))).toBe(false)
    await say(r, "status", 2)
    // and the system prompt now lists the file
    const last = lines().filter((l) => l.args.includes("--mcp-config")).at(-1)!
    expect(argOf(last.args, "--append-system-prompt")).toContain(name!)
  })

  it("compacts by itself between turns once usage passes the threshold, and only if enabled", async () => {
    logFile()
    process.env.FAKE_CLAUDE_TOKENS_PER_TURN = "25000"
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { orchestratorAutoCompact: { enabled: false, unit: "percent", value: 10 } })
    await say(r, "status")
    expect(compactions(r)).toHaveLength(0)
    await call(r, "PUT", "/api/agent-settings", { orchestratorAutoCompact: { enabled: true, unit: "percent", value: 10 } }) // 20k of the 200k window
    await say(r, "status", 2)
    await waitFor(() => (compactions(r).length === 1 ? true : null), "auto compaction")
    expect(fs.readFileSync(path.join(r.yard.orchestrator.compactionsDir, compactions(r)[0]!), "utf8")).toMatch(/trigger: auto/)
  })

  it("doesn't compact when it can't write the summary", async () => {
    const lines = logFile()
    process.env.FAKE_CLAUDE_BAD_SUMMARY = "1"
    const r = await start()
    await say(r, "status")
    await call(r, "POST", "/api/orchestrator/compact")
    await waitFor(async () => ((await chat(r)).some((m) => m.role === "error" && /Compaction skipped/.test(m.content)) ? true : null), "error")
    expect(compactions(r)).toHaveLength(0)
    expect(lines().some((l) => l.prompt === "/compact")).toBe(false)
  })

  it("refuses to compact before there is a conversation", async () => {
    const r = await start()
    await expect(call(r, "POST", "/api/orchestrator/compact")).rejects.toThrow(/nothing to compact/)
  })
})
