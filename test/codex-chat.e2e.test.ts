import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, ChatMessage, Project, SideThread, SideThreadMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The Coordinator and the Captains on Codex (docs/codex.md), driven through scripts/fake-codex.mjs: Codex's flags
// and JSONL events, Box Yard's real MCP tools over HTTP, its thread id as the session, and the ChatGPT login file
// Box Yard keeps refreshed.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
let log = ""

beforeEach(() => {
  log = path.join(tmpDir("codex-log"), "codex.jsonl")
  process.env.FAKE_CODEX_LOG = log
})

afterEach(async () => {
  delete process.env.FAKE_CODEX_LOG
  delete process.env.FAKE_CODEX_REFRESH
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(): Promise<Running> {
  const port = await freePort()
  const c = testConfig({ port })
  const yard = createBoxYard(c, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: c.dataDir }
  running.push(r)
  return r
}

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const chat = (r: Running) => call<ChatMessage[]>(r, "GET", "/api/chat")
const login = (refreshed: string, token = "rt_first_000000000000") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id_000000000000", access_token: "at_000000000000", refresh_token: token, account_id: "acct-1" }, last_refresh: refreshed })

describe("the Coordinator on Codex", () => {
  it("runs codex exec with Box Yard's tools, and resumes the thread Codex named", async () => {
    const r = await start()
    r.yard.settings.update({ orchestratorCli: "codex", orchestratorCodexModel: "gpt-6.1-sol" })
    await call(r, "POST", "/api/chat", { content: "create project acme" })
    await waitFor(() => r.yard.store.listProjects().find((p) => p.name === "acme"), "the project the Coordinator made with create_project")
    await waitFor(async () => (await chat(r)).some((m) => m.role === "assistant"), "a reply")
    await waitFor(() => !r.yard.orchestrator.busy, "the turn to end")

    const [first] = runs()
    expect(first.resume).toBeNull()
    expect(first.model).toBe("gpt-6.1-sol")
    // A manager: no shell, read-only, and its tools over HTTP with the token in the env, not the args.
    expect(first.sandbox).toBe("read-only")
    expect(first.config["features.shell_tool"]).toBe(false)
    expect(first.config["mcp_servers.boxyard.url"]).toMatch(/\/mcp$/)
    expect(first.config["mcp_servers.boxyard.bearer_token_env_var"]).toBe("BOXYARD_MCP_TOKEN")
    expect(JSON.stringify(first.args)).not.toMatch(/Bearer/)
    expect(first.config.developer_instructions).toMatch(/You run on Codex/)
    const tool = (await chat(r)).find((m) => m.role === "tool" && m.content === "create_project")
    expect(tool).toBeTruthy()

    const thread = r.yard.store.getKv("orchestrator_session")
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(() => runs().length === 2 && !r.yard.orchestrator.busy, "the second turn")
    expect(runs()[1].resume).toBe(thread)
    // Context usage comes from the thread's rollout file.
    expect(r.yard.orchestrator.usage().tokens).toBeGreaterThan(0)
    expect(r.yard.orchestrator.usage().window).toBe(200_000)
  })

  it("starts a new session with a recap when it moves from Claude Code to Codex", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(async () => (await chat(r)).some((m) => m.role === "assistant") && !r.yard.orchestrator.busy, "the Claude turn")
    expect(runs()).toHaveLength(0)
    r.yard.settings.update({ orchestratorCli: "codex" })
    await call(r, "POST", "/api/chat", { content: "status again" })
    await waitFor(() => runs().length === 1 && !r.yard.orchestrator.busy, "the Codex turn")
    expect(runs()[0].resume).toBeNull()
    expect((await chat(r)).filter((m) => m.role === "error")).toEqual([])
    expect(r.yard.store.getKv("orchestrator_session_cli")).toBe("codex")
  })

  it("hands Codex the saved ChatGPT login and keeps the copy Codex refreshed", async () => {
    const r = await start()
    r.yard.settings.update({ orchestratorCli: "codex" })
    r.yard.settings.credentials.update({ codexAuthJson: login("2026-01-01T00:00:00Z") })
    process.env.FAKE_CODEX_REFRESH = "1"
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(() => runs().length === 1 && !r.yard.orchestrator.busy, "the turn")
    expect(runs()[0]).toMatchObject({ login: "chatgpt", account: "acct-1", home: path.join(r.dataDir, "codex") })
    // The pasted refresh token is spent now; the next run must get the new one.
    const now = JSON.parse(r.yard.settings.credentials.codexAuth())
    expect(now.tokens.refresh_token).not.toBe("rt_first_000000000000")
    expect(Date.parse(now.last_refresh)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"))
    // Settings › Credentials still says where the login came from.
    expect(r.yard.settings.credentials.status().codexAuthJson).toEqual({ state: "set", source: "saved" })
  })

  it("compacts by writing the summary and starting the next turn from it", async () => {
    const r = await start()
    r.yard.settings.update({ orchestratorCli: "codex" })
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(() => runs().length === 1 && !r.yard.orchestrator.busy, "the first turn")
    r.yard.orchestrator.requestCompact("button")
    await waitFor(async () => (await chat(r)).some((m) => m.role === "notice" && /Context compacted/.test(m.content)), "the compaction notice")
    expect((await chat(r)).filter((m) => m.role === "error")).toEqual([])
    // The summary resumed the thread; nothing ran /compact or /context.
    expect(runs()).toHaveLength(2)
    expect(runs()[1].resume).toBe(runs()[0].resume ?? r.yard.store.listOrchestratorCompactions({ limit: 1 })[0]!.sessionId)
    expect(r.yard.store.getKv("orchestrator_session_started")).toBeNull()
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(() => runs().length === 3 && !r.yard.orchestrator.busy, "the turn after")
    expect(runs()[2].resume).toBeNull()
  })
})

describe("side threads on a Codex chat", () => {
  it("start from the summary on Codex, stay read-only, and resume their own thread", async () => {
    const r = await start()
    r.yard.settings.update({ orchestratorCli: "codex" })
    await call(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(async () => (await chat(r)).some((m) => m.role === "assistant") && !r.yard.orchestrator.busy, "the Coordinator's reply")
    const reply = (await chat(r)).filter((m) => m.role === "assistant").at(-1)!
    const answers = (id: string, n: number) =>
      waitFor(async () => {
        const list = await call<SideThreadMessage[]>(r, "GET", `/api/threads/${id}/messages`)
        const done = list.filter((m) => m.role === "assistant" || m.role === "error")
        const threads = await call<SideThread[]>(r, "GET", "/api/threads")
        return done.length >= n && !threads.find((t) => t.id === id)?.busy ? done : null
      }, `${n} side thread answers`)
    const { thread } = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { anchorId: reply.id, quote: "the yard", question: "Please try create_task" })
    const [answer] = await answers(thread.id, 1)
    // Codex can't fork at a message, and the thread's read-only token keeps it to lookups.
    expect((await call<SideThread[]>(r, "GET", "/api/threads"))[0]!.context).toBe("summary")
    expect(answer!.content).toContain("Side threads are read-only")
    expect(r.yard.store.listTasks()).toHaveLength(0)
    const threadRun = runs().at(-1)
    expect(threadRun.resume).toBeNull()
    expect(r.yard.store.sideThreadSession(thread.id)!.sessionId).toBe(threadRun.thread)

    await call(r, "POST", `/api/threads/${thread.id}/messages`, { content: "Now try list_tasks" })
    const [, lookup] = await answers(thread.id, 2)
    expect(lookup!.content).toContain("list_tasks said: [")
    expect(runs().at(-1).resume).toBe(threadRun.thread)
  })
})

describe("Captains on Codex", () => {
  it("run a project's Captain on Codex with its own thread", async () => {
    const r = await start()
    r.yard.settings.update({ captainCli: "codex" })
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo", repo: null })
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "status" })
    await waitFor(async () => (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).some((m) => m.role === "assistant"), "the Captain's reply")
    await waitFor(() => runs().length === 1, "one Codex run")
    expect(runs()[0].config.developer_instructions).toMatch(/You run on Codex/)
    expect(r.yard.store.getKv(`captain_session_cli:${p.id}`)).toBe("codex")
    expect(r.yard.store.getKv(`captain_session_started:${p.id}`)).toBe("1")
  })
})
