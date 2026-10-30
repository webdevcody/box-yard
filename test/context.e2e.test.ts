import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import type { Config } from "../server/config.js"
import type { ChatMessage, Effort, OrchestratorCompactionRecord, OrchestratorState, Project, SettingsInfo, Task, TaskCompactionRecord, TaskMessage } from "../shared/types.js"
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
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_TOKENS_PER_TURN", "FAKE_CLAUDE_BAD_SUMMARY", "FAKE_CLAUDE_WINDOW", "FAKE_CLAUDE_LOG_FULL"]

async function start(overrides: Partial<Config> = {}, seed?: (yard: BoxYard) => void): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  seed?.(yard)
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
const connectMcp = async (r: Running) => {
  const server = buildMcpServer({
    store: r.yard.store,
    tasks: r.yard.tasks,
    hub: r.yard.hub,
    artifacts: null as never,
    uploads: { resolveAll: () => [] },
    scheduler: r.yard.scheduler,
    settings: r.yard.settings,
    publicUrl: () => "",
  } as never)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "t", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
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
    const summaries = await call<TaskCompactionRecord[]>(r, "GET", `/api/task-compactions?taskId=${t.id}`)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ taskId: t.id, sessionId: done.sessionId, statusAfter: "done" })
    expect(summaries[0]!.summary).toMatch(/mock agent wrote|Turn 1 finished/)
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

  it("routes model and effort per task and per message, and records each turn", async () => {
    const lines = logFile()
    const r = await start()
    const connect = async () => {
      const server = buildMcpServer({
        store: r.yard.store, tasks: r.yard.tasks, hub: r.yard.hub, artifacts: null as never, uploads: { resolveAll: () => [] }, scheduler: r.yard.scheduler, settings: r.yard.settings, publicUrl: () => "",
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
    const create = await schema("create_task")
    expect(Object.keys(create.inputSchema.properties ?? {})).toContain("model")
    expect(Object.keys(create.inputSchema.properties ?? {})).toContain("effort")
    expect(Object.keys(create.inputSchema.properties ?? {})).toContain("routing_rule")
    expect(JSON.stringify(create.inputSchema.properties)).toMatch(/one-command chores/)
    expect(JSON.stringify(create.inputSchema.properties)).toMatch(/real coding/)

    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const client = await connect()
    const out = (await client.callTool({
      name: "create_task",
      arguments: { project: p.name, title: "Chore", prompt: "run ls", model: "claude-haiku-5-5", effort: "low", routing_rule: "docs-small-fixes", routing_reason: "Small chore." },
    })) as { content: { text: string }[] }
    const id = JSON.parse(out.content[0]!.text).id as string
    await untilQuiet(r, id)
    expect(await getTask(r, id)).toMatchObject({ model: "claude-haiku-5-5", effort: "low", routingRule: "docs-small-fixes", routingReason: "Small chore." })
    const first = lines().find((l) => l.args.includes("--session-id") && l.prompt.includes("Chore"))!
    expect(argOf(first.args, "--model")).toBe("claude-haiku-5-5")
    expect(argOf(first.args, "--effort")).toBe("low")

    await client.callTool({
      name: "send_to_task",
      arguments: { task: id, message: "now implement the feature [slow]", model: "claude-opus-5-5", effort: "high", routing_rule: "architecture-migrations-debugging", routing_reason: "Escalating after scope grew." },
    })
    await untilQuiet(r, id)
    expect(await getTask(r, id)).toMatchObject({ model: "claude-opus-5-5", effort: "high", routingRule: "architecture-migrations-debugging" })
    const follow = lines().filter((l) => l.args.includes("--resume") && l.prompt.startsWith("Message from"))
    expect(argOf(follow.at(-1)!.args, "--model")).toBe("claude-opus-5-5")
    expect(argOf(follow.at(-1)!.args, "--effort")).toBe("high")
    expect(r.yard.store.listTaskTurns(id).map((t) => ({ model: t.model, effort: t.effort, rule: t.routing_rule, status: t.status }))).toEqual([
      { model: "claude-haiku-5-5", effort: "low", rule: "docs-small-fixes", status: "done" },
      { model: "claude-opus-5-5", effort: "high", rule: "architecture-migrations-debugging", status: "done" },
    ])

    await client.callTool({ name: "set_task_model", arguments: { task: id, model: "claude-sonnet-5-5", effort: "medium", routing_rule: "ui", routing_reason: "Follow-up is UI-sized." } })
    await client.callTool({ name: "send_to_task", arguments: { task: id, message: "again" } })
    await untilQuiet(r, id)
    const last = lines().filter((l) => l.args.includes("--resume") && l.prompt.startsWith("Message from")).at(-1)!
    expect(argOf(last.args, "--model")).toBe("claude-sonnet-5-5")
    expect(argOf(last.args, "--effort")).toBe("medium")
  })
})

describe("model/effort precedence reaches the CLI (#44)", () => {
  const ROUTING = "defaults:\n  model: claude-sonnet-5-5\n  effort: medium\nprojects:\n  routed:\n    model: claude-haiku-5-5\n"
  const turnsOf = (r: Running, id: string) => r.yard.store.listTaskTurns(id).map((t) => ({ model: t.model, effort: t.effort, rule: t.routing_rule }))

  it("resolves every turn, so a Settings change reaches an existing task over the routing YAML defaults", async () => {
    const lines = logFile()
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { agentRoutingConfig: ROUTING })
    const demo = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const routed = await call<Project>(r, "POST", "/api/projects", { name: "routed" })

    // Settings at their defaults: the YAML defaults apply, but they aren't pinned on the task.
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: demo.id, title: "Plain", prompt: "hi" })
    expect(await untilQuiet(r, t.id)).toMatchObject({ model: null, effort: null, routingRule: null })
    const first = lines().find((l) => l.args.includes("--session-id") && l.prompt.includes("Plain"))!
    expect([argOf(first.args, "--model"), argOf(first.args, "--effort")]).toEqual(["claude-sonnet-5-5", "medium"])

    // Saving Settings reaches the same task on its next turn.
    await call(r, "PUT", "/api/agent-settings", { agentModel: "ui-model", agentEffort: "low" })
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more thing" })
    await untilQuiet(r, t.id)
    const next = lines().filter((l) => l.args.includes("--resume") && l.prompt.includes("one more thing")).at(-1)!
    expect([argOf(next.args, "--model"), argOf(next.args, "--effort")]).toEqual(["ui-model", "low"])
    expect(turnsOf(r, t.id)).toEqual([
      { model: "claude-sonnet-5-5", effort: "medium", rule: "defaults" },
      { model: "ui-model", effort: "low", rule: null },
    ])

    // The project's entry beats Settings for the model it sets; Settings still gives the effort.
    const p = await call<Task>(r, "POST", "/api/tasks", { projectId: routed.id, title: "Routed", prompt: "hi" })
    await untilQuiet(r, p.id)
    expect(turnsOf(r, p.id)).toEqual([{ model: "claude-haiku-5-5", effort: "low", rule: "project:routed" }])

    // A task's own choice beats everything.
    const own = r.yard.tasks.createTask({ projectId: routed.id, title: "Own", prompt: "hi", model: "claude-opus-5-5", effort: "max", routingRule: "architecture" })
    await untilQuiet(r, own.id)
    expect(turnsOf(r, own.id)).toEqual([{ model: "claude-opus-5-5", effort: "max", rule: "architecture" }])
    const ownTurn = lines().find((l) => l.args.includes("--session-id") && l.prompt.includes("Own"))!
    expect([argOf(ownTurn.args, "--model"), argOf(ownTurn.args, "--effort")]).toEqual(["claude-opus-5-5", "max"])
    // Usage is logged with the model the turn ran on, not the Settings model.
    const usage = r.yard.store.db.prepare("SELECT model FROM claude_usage WHERE task_id = ? ORDER BY rowid").all(p.id) as { model: string }[]
    expect(usage.map((u) => u.model)).toEqual(["claude-haiku-5-5"])
  })

  it("on startup, forgets routes older versions copied from the YAML onto tasks, and keeps deliberate ones", async () => {
    const ids: Record<string, string> = {}
    const r = await start({}, (yard) => {
      yard.settings.update({ agentRoutingConfig: ROUTING, agentModel: "ui-model" })
      const project = yard.store.createProject({ name: "demo" })
      const make = (title: string, model: string, effort: Effort, routingRule: string) =>
        yard.store.createTask({ projectId: project.id, title, prompt: "hi [noop]", model, effort, routingRule, routingReason: "Global routing default." }).id
      ids.copied = make("Copied", "claude-sonnet-5-5", "medium", "defaults")
      ids.escalated = make("Escalated", "claude-opus-5-5", "high", "defaults")
    })
    expect(await getTask(r, ids.copied!)).toMatchObject({ model: null, effort: null, routingRule: null, routingReason: null })
    expect(await getTask(r, ids.escalated!)).toMatchObject({ model: "claude-opus-5-5", effort: "high", routingRule: "defaults" })
    await untilQuiet(r, ids.copied!)
    await untilQuiet(r, ids.escalated!)
    expect(turnsOf(r, ids.copied!)[0]).toMatchObject({ model: "ui-model", effort: "medium" })
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
    process.env.FAKE_CLAUDE_LOG_FULL = "1"
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Linked context", prompt: "write a haiku" })
    await untilQuiet(r, t.id)
    await say(r, "status")
    const before = (await call<OrchestratorState>(r, "GET", "/api/orchestrator")).usage.tokens!
    await call(r, "POST", "/api/orchestrator/compact")
    await waitFor(async () => (compactions(r).length === 1 && !(await call<OrchestratorState>(r, "GET", "/api/orchestrator")).compacting ? true : null), "compaction")
    const [name] = compactions(r)
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/)
    const text = fs.readFileSync(path.join(r.yard.orchestrator.compactionsDir, name!), "utf8")
    expect(text).toMatch(/trigger: button/)
    expect(text).toMatch(new RegExp(`tokens_before: ${before}\\b`))
    expect(text).toMatch(/tokens_after: 2000\b/)
    expect(text).toContain(t.id)
    expect(text).toContain("## Decisions and preferences")
    expect(text).toContain("## Open threads and next steps")
    const apiList = await call<OrchestratorCompactionRecord[]>(r, "GET", "/api/compactions")
    expect(apiList[0]).toMatchObject({ id: name!.replace(/\.md$/, ""), taskCount: 1 })
    expect(apiList[0]!.tasks[0]).toMatchObject({ taskId: t.id, title: "Linked context", projectName: "demo", sessionId: t.sessionId })
    const apiDetail = await call<OrchestratorCompactionRecord>(r, "GET", `/api/compactions/${apiList[0]!.id}`)
    expect(apiDetail.markdown).toContain("## Decisions and preferences")
    expect(JSON.parse(fs.readFileSync(path.join(r.yard.orchestrator.compactionsDir, name!.replace(/\.md$/, ".json")), "utf8")).tasks[0].taskId).toBe(t.id)

    const client = await connectMcp(r)
    const listed = (await client.callTool({ name: "list_compactions", arguments: { task: t.id } })) as { content: { text: string }[] }
    expect(JSON.parse(listed.content[0]!.text)[0].id).toBe(apiList[0]!.id)
    const found = (await client.callTool({ name: "find_compactions_by_task", arguments: { task: t.id } })) as { content: { text: string }[] }
    expect(JSON.parse(found.content[0]!.text).orchestratorCompactions[0].id).toBe(apiList[0]!.id)
    const read = (await client.callTool({ name: "read_compaction", arguments: { compaction: apiList[0]!.id } })) as { content: { text: string }[] }
    expect(JSON.parse(read.content[0]!.text).markdown).toContain("## Open threads and next steps")
    const order = lines().map((l) => l.prompt)
    const si = order.findIndex((x) => x.includes("Your context is about to be compacted"))
    const ci = order.findIndex((x) => x.startsWith("/compact "))
    expect(si).toBeGreaterThan(0)
    expect(ci).toBeGreaterThan(si)
    // The summary and /compact passes send the turn's tools, system prompt and effort, so they hit its prompt
    // cache; only a turn may use the tools (no allow rules: dontAsk denies every call).
    const turnArgs = lines()[si - 1]!.args
    for (const pass of [lines()[si]!.args, lines()[ci]!.args]) {
      for (const flag of ["--mcp-config", "--tools", "--permission-mode", "--append-system-prompt", "--model", "--effort"]) expect(argOf(pass, flag), flag).toBe(argOf(turnArgs, flag))
      expect(pass).not.toContain("--allowedTools")
    }
    expect(argOf(turnArgs, "--tools")).toBe("Read,WebSearch,WebFetch,ToolSearch")
    const state = await call<OrchestratorState>(r, "GET", "/api/orchestrator")
    expect(state.usage.tokens).toBe(2000)
    expect(state.lastCompaction).toMatchObject({ trigger: "button", tokensAfter: 2000 })
    // the summary turn is not shown in the chat, and the next turn still works (same session)
    expect((await chat(r)).some((m) => m.content.includes("Cody prefers short replies"))).toBe(false)
    await say(r, "status", 2)
    // and the system prompt now lists the file
    // (The project's Captain logs its runs too.)
    const coordinatorTurns = () => lines().filter((l) => l.args.includes("--mcp-config") && !argOf(l.args, "--mcp-config").includes(`${path.sep}captains${path.sep}`))
    const last = coordinatorTurns().at(-1)!
    expect(argOf(last.args, "--append-system-prompt")).toContain(name!)
    // The first turn after it starts with Box Yard's summary and the live state of the tasks it names; the
    // one after that doesn't repeat it.
    expect(last.prompt).toMatch(/^\[Box Yard: Your context was just compacted/)
    expect(last.prompt).toContain("Live now, tasks it names:")
    expect(last.prompt).toContain(`- ${t.id} "Linked context"`)
    await say(r, "status", 3)
    expect(coordinatorTurns().at(-1)!.prompt).toMatch(/^\[Yard now\]/)
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

  it("has no way to clear the conversation: compacting is the only way to shrink it", async () => {
    const r = await start()
    await say(r, "status")
    const before = await chat(r)
    expect((await fetch(`${r.base}/api/chat/reset`, { method: "POST" })).status).toBe(404)
    expect(await chat(r)).toEqual(before)
  })
})
