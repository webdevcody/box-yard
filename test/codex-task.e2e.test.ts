import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { codexExecArgs } from "../server/codex.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Task agents on Codex (docs/codex.md), through runner/box-runner.mjs and scripts/fake-codex.mjs: the CLI a task keeps,
// codex exec's flags, the thread it resumes, the context it reports, and the ChatGPT login a turn gets and gives back.

interface Running {
  yard: BoxYard
  server: Server
  call: <T>(method: string, url: string, body?: unknown) => Promise<T>
  raw: (method: string, url: string, body?: unknown) => Promise<{ status: number; text: string }>
}
const running: Running[] = []
let log = ""

beforeEach(() => {
  log = path.join(tmpDir("codex-task-log"), "codex.jsonl")
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
  const yard = createBoxYard(testConfig({ port, claudeOauthToken: "global-claude-oauth" }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const base = `http://127.0.0.1:${port}`
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await raw(method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${r.text}`)
    return JSON.parse(r.text) as T
  }
  const r = { yard, server, call, raw }
  running.push(r)
  return r
}

const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const resting = (r: Running, id: string) => waitFor(() => (["done", "idle", "failed"].includes(r.yard.store.getTask(id)?.status ?? "") && !r.yard.store.getTaskRow(id)?.current_turn_id ? r.yard.store.getTask(id) : null), "the turn to end", 30_000)
const login = (refreshed: string, token = "rt_first_000000000000") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id_000000000000", access_token: "at_000000000000", refresh_token: token, account_id: "acct-1" }, last_refresh: refreshed })

describe("task agents on Codex", () => {
  it("run codex exec with Box Yard's tools, and the next turn resumes the thread Codex named", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "cx", agentCli: "codex" })
    expect(p.agentCli).toBe("codex")
    const created = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi" })
    expect(created.agentCli).toBe("codex")
    const done = await resting(r, created.id)
    expect(done.status).toBe("done")

    const [first] = runs()
    expect(first.resume).toBeNull()
    // Like Claude Code with bypassPermissions: the box is the sandbox. Box Yard's tools are the runner's stdio server.
    expect(first.sandbox).toBe("danger-full-access")
    expect(first.config["mcp_servers.boxyard.args"]).toEqual([expect.stringMatching(/box-runner\.mjs$/), "mcp", expect.stringContaining(created.id)])
    expect(first.config["mcp_servers.boxyard.default_tools_approval_mode"]).toBe("approve")
    expect(first.config.developer_instructions).toBeTruthy()
    // The runner keeps its own copy of codexExecArgs (it runs on boxes with plain Node): the two stay the same.
    const mcp = { command: first.config["mcp_servers.boxyard.command"], args: first.config["mcp_servers.boxyard.args"] }
    expect(first.args).toEqual(codexExecArgs({ resume: null, model: first.model, effort: first.config.model_reasoning_effort ?? null, instructions: first.config.developer_instructions, mcp, manager: false }))
    // The task's own Codex home, in its folder, so its sessions move with it.
    const dir = r.yard.tasks.taskDir(done.boxId!, done.id)
    expect(first.home).toBe(path.join(dir, "codex"))
    expect(done.sessionId).toBe(first.thread)
    expect(done.contextTokens).toBeGreaterThan(0)
    expect(done.contextWindow).toBe(200_000)
    const messages = await r.call<TaskMessage[]>("GET", `/api/tasks/${done.id}/messages`)
    expect(messages.some((m) => m.role === "assistant")).toBe(true)

    // Settings' Claude login doesn't reach a Codex turn.
    const taskJson = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"))
    expect(taskJson).toMatchObject({ agent: "codex", codexLogin: null, isolateCodex: true })
    expect(taskJson.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(taskJson.unsetEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN")

    await r.call("POST", `/api/tasks/${done.id}/messages`, { content: "Say hi again" })
    await waitFor(() => runs().length === 2, "the second turn")
    await resting(r, done.id)
    expect(runs()[1].resume).toBe(first.thread)
  })

  it("hands a turn Settings' ChatGPT login and keeps the copy Codex refreshed on the box", async () => {
    const r = await start()
    r.yard.settings.credentials.update({ codexAuthJson: login("2026-01-01T00:00:00Z") })
    process.env.FAKE_CODEX_REFRESH = "1"
    const p = await r.call<Project>("POST", "/api/projects", { name: "cx", agentCli: "codex" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi" })
    const done = await resting(r, t.id)
    expect(done.status).toBe("done")
    expect(runs()[0]).toMatchObject({ login: "chatgpt", account: "acct-1" })

    const dir = r.yard.tasks.taskDir(done.boxId!, done.id)
    // The runner took the hand-over file into the task's Codex home; nothing is left beside it.
    expect(fs.existsSync(path.join(dir, "codex-auth.json"))).toBe(false)
    expect((fs.statSync(path.join(dir, "codex", "auth.json")).mode & 0o777).toString(8)).toBe("600")
    // Box Yard read the refreshed copy back: the pasted refresh token is spent.
    const now = JSON.parse(r.yard.settings.credentials.codexAuth())
    expect(now.tokens.refresh_token).not.toBe("rt_first_000000000000")
    expect(now.tokens.refresh_token).toBe(JSON.parse(fs.readFileSync(path.join(dir, "codex", "auth.json"), "utf8")).tokens.refresh_token)
    // And the login never goes into the task's archive.
    await waitFor(() => r.yard.store.getTaskRow(done.id)?.archive_path, "the turn-end archive")
    const listing = execFileSync("tar", ["tzf", r.yard.store.getTaskRow(done.id)!.archive_path!], { encoding: "utf8" })
    expect(listing).toMatch(/codex\//)
    expect(listing).not.toMatch(/auth\.json/)
  })

  it("uses a project's own CODEX_API_KEY over Settings' login", async () => {
    const r = await start()
    r.yard.settings.credentials.update({ codexAuthJson: login("2026-01-01T00:00:00Z") })
    const p = await r.call<Project>("POST", "/api/projects", { name: "cx", agentCli: "codex", env: { CODEX_API_KEY: "sk-proj-project-0000000000000000" } })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi" })
    await resting(r, t.id)
    expect(runs()[0].login).toBe("api_key")
    const dir = r.yard.tasks.taskDir(r.yard.store.getTask(t.id)!.boxId!, t.id)
    expect(fs.existsSync(path.join(dir, "codex", "auth.json"))).toBe(false)
  })

  it("picks Codex for a task whose model is an OpenAI one, keeps Claude Code the default, and leaves compaction to Codex", async () => {
    const r = await start()
    r.yard.settings.update({ agentCodexModel: "gpt-6-luna" })
    const p = await r.call<Project>("POST", "/api/projects", { name: "mixed" })
    expect(p.agentCli).toBeNull()
    const claude = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "On Claude", prompt: "Say hi" })
    expect(claude.agentCli).toBe("claude")
    const gpt = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "On GPT", prompt: "Say hi", model: "gpt-6.1-sol" })
    expect(gpt.agentCli).toBe("codex")
    const plain = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "On Codex", prompt: "Say hi", agentCli: "codex" })
    await Promise.all([resting(r, claude.id), resting(r, gpt.id), resting(r, plain.id)])
    // The task's own model wins; a Codex task without one gets Settings' Codex model, never the Claude default.
    expect(runs().map((x) => x.model).sort()).toEqual(["gpt-6-luna", "gpt-6.1-sol"])
    expect((await r.raw("POST", `/api/tasks/${gpt.id}/compact`)).status).toBe(400)
  })
})
