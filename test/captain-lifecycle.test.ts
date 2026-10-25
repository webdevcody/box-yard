import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, CaptainState, Project } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The Captain parts of #50: the claude flags and tool scope, compaction (button, automatic and the
// failure path) and the session reset fallback, end to end with the fake claude.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_LOG_FULL", "FAKE_CLAUDE_TOKENS_PER_TURN", "FAKE_CLAUDE_BAD_SUMMARY", "FAKE_CLAUDE_COMPACT_FAIL"]

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
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

async function captain(r: Running, name = "demo") {
  const p = await call<Project>(r, "POST", "/api/projects", { name })
  const state = () => call<CaptainState>(r, "GET", `/api/projects/${p.id}/captain`)
  const messages = () => call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
  const idle = async () => {
    const s = await state()
    return !s.busy && !s.compacting && !s.compactQueued ? s : null
  }
  const say = async (content: string) => {
    const before = (await messages()).filter((m) => m.role === "assistant").length
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content })
    await waitFor(async () => (await idle()) && (await messages()).filter((m) => m.role === "assistant").length > before, "Captain reply")
  }
  return { p, state, messages, idle, say }
}

describe("Captain claude runs (#50)", () => {
  it("runs claude with only its own MCP config, Box Yard tools, read-only file access and a persistent session", async () => {
    const lines = logFile()
    const r = await start()
    const { p, say } = await captain(r)
    await say("status")
    await say("status again")

    const turns = lines().filter((l) => l.args.includes("--mcp-config"))
    expect(turns).toHaveLength(2)
    const [first, second] = turns.map((t) => t.args)
    expect(first).toContain("--strict-mcp-config")
    expect(argOf(first!, "--mcp-config")).toBe(path.join(r.dataDir, "captains", p.id, "mcp.json"))
    expect(argOf(first!, "--tools")).toBe("Read,WebSearch,WebFetch")
    const allowed = argOf(first!, "--allowedTools")!.split(",")
    expect(allowed.slice(0, 3)).toEqual(["mcp__boxyard", "WebSearch", "WebFetch"])
    expect(allowed.slice(3).every((rule) => /^Read\(\/\/.+\/\*\*\)$/.test(rule))).toBe(true)
    expect(allowed).toContain(`Read(/${path.join(r.dataDir, "captains", p.id, "compactions")}/**)`)
    expect(argOf(first!, "--permission-mode")).toBe("dontAsk")
    expect(argOf(first!, "--append-system-prompt")).toContain(`You are the Box Yard Captain for project "demo" (${p.id})`)
    // One session: created on the first turn, resumed after.
    const session = argOf(first!, "--session-id")
    expect(session).toBeTruthy()
    expect(argOf(second!, "--resume")).toBe(session)
    expect(turns[0]!.prompt).toMatch(/^\[Project now: demo\]/)
  })

  it("falls back to a fresh session with a recap when the old one is gone", async () => {
    const lines = logFile()
    const r = await start()
    const { p, say } = await captain(r)
    await say("status")
    const lost = randomUUID()
    r.yard.store.setKv(`captain_session:${p.id}`, lost)
    await say("status after a reset")

    const fresh = r.yard.store.getKv(`captain_session:${p.id}`)
    expect(fresh).not.toBe(lost)
    // (The failed --resume run exits before the fake claude logs it.)
    const runs = lines().filter((l) => l.args.includes("--mcp-config"))
    expect(argOf(runs.at(-1)!.args, "--session-id")).toBe(fresh)
    expect(runs.at(-1)!.prompt).toMatch(/^Earlier Captain conversation \(your session was reset\):/)
  })
})

describe("Captain compaction (#50)", () => {
  it("compacts on the button, writes a summary, and keeps queued task updates", async () => {
    const r = await start()
    const { p, state, messages, idle, say } = await captain(r)
    await say("status")
    await say("status again")
    const before = (await state()).usage.tokens!
    // A task update waiting for the Captain's next wake must survive the compaction.
    r.yard.store.addCaptainMessage(p.id, "notice", "✅ **Haiku** is done: three lines", { taskId: "task_waiting01" })

    await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
    const after = await waitFor(async () => {
      const s = await idle()
      return s?.lastCompaction ? s : null
    }, "compaction")
    expect(after.usage.tokens).toBeLessThan(before)
    expect(after.error).toBeNull()
    expect(after.lastCompaction!.trigger).toBe("button")
    expect(fs.readdirSync(after.compactionsDir).some((f) => f.endsWith(".md"))).toBe(true)
    expect((await messages()).some((m) => m.role === "notice" && /Context compacted from .*\(button\)/.test(m.content))).toBe(true)
    expect(r.yard.store.peekUnseenCaptainNotices(p.id)).toEqual(["✅ **Haiku** is done: three lines"])
  })

  it("sends the summary and /compact passes with the turn's flags, and starts the next turn with the summary", async () => {
    const lines = logFile()
    process.env.FAKE_CLAUDE_LOG_FULL = "1"
    const r = await start()
    const { p, idle, say } = await captain(r)
    const t = r.yard.store.createTask({ projectId: p.id, title: "Ship the widget", prompt: "ship it" })
    r.yard.store.updateTask(t.id, { status: "needs_input", question: "Which colour?" })
    await say("status")
    await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
    const s = await waitFor(async () => {
      const x = await idle()
      return x?.lastCompaction?.tokensAfter ? x : null
    }, "compaction")

    const runs = lines()
    const si = runs.findIndex((l) => /Your Captain context for project "demo" is about to be compacted/.test(l.prompt))
    const ci = runs.findIndex((l) => l.prompt.startsWith("/compact "))
    expect(si).toBeGreaterThan(0)
    expect(ci).toBeGreaterThan(si)
    // Box Yard gives the summarizer the live state of the project's busy task.
    expect(runs[si]!.prompt).toContain(`- ${t.id} "Ship the widget" needs_input · asks: Which colour?`)
    const turn = runs[si - 1]!.args
    for (const pass of [runs[si]!.args, runs[ci]!.args]) {
      for (const flag of ["--mcp-config", "--tools", "--permission-mode", "--append-system-prompt", "--model", "--effort"]) expect(argOf(pass, flag), flag).toBe(argOf(turn, flag))
      expect(pass).not.toContain("--allowedTools")
    }
    expect(runs[ci]!.prompt).toMatch(/Don't repeat what it says/)

    await say("what now?")
    const next = lines().filter((l) => l.args.includes("--mcp-config")).at(-1)!
    expect(next.prompt).toMatch(/^\[Box Yard: Your context was just compacted\. This is the summary you wrote right before it/)
    expect(next.prompt).toContain(s.lastCompaction!.file)
    expect(next.prompt).toContain("## Decisions and preferences")
    expect(next.prompt).toContain(`Live now, tasks it names:\n- ${t.id} "Ship the widget" needs_input`)
    await say("and now?")
    expect(lines().filter((l) => l.args.includes("--mcp-config")).at(-1)!.prompt).toMatch(/^\[Project now: demo\]/)
  })

  it("compacts automatically past the threshold", async () => {
    process.env.FAKE_CLAUDE_TOKENS_PER_TURN = "25000"
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { orchestratorAutoCompact: { enabled: true, unit: "percent", value: 10 } }) // 20k of the 200k window
    const { messages, idle, say } = await captain(r)
    await say("status")
    const s = await waitFor(async () => {
      const x = await idle()
      return x?.lastCompaction ? x : null
    }, "automatic compaction")
    expect(s.lastCompaction!.trigger).toBe("auto")
    expect((await messages()).some((m) => m.role === "notice" && /\(automatic\)/.test(m.content))).toBe(true)
  })

  it("skips the compaction and says why when the summary fails", async () => {
    const r = await start()
    const { p, state, messages, idle, say } = await captain(r)
    await say("status")
    process.env.FAKE_CLAUDE_BAD_SUMMARY = "1"
    await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
    const s = await waitFor(async () => {
      const x = await idle()
      return x?.error ? x : null
    }, "failed compaction")
    expect(s.error).toMatch(/^Compaction skipped: couldn't write the summary first/)
    expect(s.lastCompaction).toBeNull()
    expect((await messages()).some((m) => m.role === "error" && /Compaction skipped/.test(m.content))).toBe(true)
    expect((await state()).usage.tokens).toBeGreaterThan(0)
  })

  it("skips the compaction when /compact itself fails, keeping the session, the usage and the summary on record", async () => {
    const r = await start()
    const { p, state, messages, idle, say } = await captain(r)
    await say("status")
    const session = r.yard.store.getKv(`captain_session:${p.id}`)
    const before = (await state()).usage.tokens
    process.env.FAKE_CLAUDE_COMPACT_FAIL = "1"
    await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
    const s = await waitFor(async () => {
      const x = await idle()
      return x?.error ? x : null
    }, "failed compaction")
    expect(s.error).toMatch(/^Compaction skipped: \/compact failed: fake \/compact failure/)
    expect(s.usage.tokens).toBe(before)
    expect(r.yard.store.getKv(`captain_session:${p.id}`)).toBe(session)
    // The summary was written first, so it stays, but never gets a tokens_after.
    expect(s.lastCompaction).toMatchObject({ trigger: "button", tokensAfter: null })
    expect((await messages()).some((m) => m.role === "notice" && /Context compacted/.test(m.content))).toBe(false)

    // The next turn resumes the same session, and the next compaction works and clears the error.
    delete process.env.FAKE_CLAUDE_COMPACT_FAIL
    await say("status again")
    expect(r.yard.store.getKv(`captain_session:${p.id}`)).toBe(session)
    await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
    const ok = await waitFor(async () => {
      const x = await idle()
      return x?.lastCompaction?.tokensAfter ? x : null
    }, "compaction")
    expect(ok.error).toBeNull()
  })

  it("refuses a compaction before the Captain has a conversation", async () => {
    const r = await start()
    const { p } = await captain(r)
    const res = await fetch(`${r.base}/api/projects/${p.id}/captain/compact`, { method: "POST" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/nothing to compact/)
  })
})
