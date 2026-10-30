import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import type { CaptainMessage, ChatMessage, Project } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Speed step 2: a Captain's FYI reply shows on the Coordinator chat without waking the Coordinator for a turn; a
// question, decision or failure in it, a fan-out or act_on_reply still wakes it. The reply goes up at the turn's
// result line, before the CLI exits.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  mcp?: { client: Client; close: () => Promise<void> }
}
const running: Running[] = []
const DEBOUNCE_MS = 300

async function start(orchestratorAutoWake = true): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake }), { webDir: "/nonexistent" })
  yard.orchestrator.tuning.wakeDebounceMs = DEBOUNCE_MS
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  delete process.env.FAKE_CLAUDE_EXIT_MS
  for (const r of running.splice(0)) {
    await r.mcp?.close()
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

/** The Coordinator's MCP tools, called directly (no Coordinator turn). */
async function coordinatorTools(r: Running) {
  const server = buildMcpServer({
    store: r.yard.store,
    tasks: r.yard.tasks,
    hub: r.yard.hub,
    artifacts: null as never,
    publicUrl: () => "",
    scheduler: r.yard.scheduler,
    captains: r.yard.captains,
    settings: r.yard.settings,
    uploads: null as never,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  r.mcp = {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (res.isError) throw new Error(res.content[0]?.text)
    return JSON.parse(res.content[0]!.text)
  }
}

/** Every prompt the Coordinator's fake Claude session received. */
function coordinatorPrompts(r: Running): string[] {
  const id = r.yard.store.getKv("orchestrator_session")
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

const replies = (r: Running) => r.yard.store.listChat(500).filter((m: ChatMessage) => m.role === "notice" && m.meta?.captain === true && m.meta?.replyTo)
const captainBusy = async (r: Running, p: Project) => (await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await captainBusy(r, p)), "Captain idle", 30_000)
const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)
const wakeTurns = (r: Running) => r.yard.store.listTurnTimings({ since: 0, limit: 1000 }).filter((t) => t.role === "coordinator" && t.trigger === "updates")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Cody asks the Coordinator to pass `message` to Captains; resolves once every turn is over and a wake would have run. */
async function ask(r: Running, projects: Project[], content: string) {
  await call(r, "POST", "/api/chat", { content })
  await waitFor(() => replies(r).length >= projects.length && replies(r), "the Captains' replies", 30_000)
  for (const p of projects) await captainIdle(r, p)
  // Past the debounce: a wake would have started by now.
  await sleep(DEBOUNCE_MS + 700)
  await coordinatorIdle(r)
  return replies(r)
}

describe("Coordinator wakes on Captain replies", () => {
  it("shows an FYI reply without waking the Coordinator, and gives it to the Coordinator's next turn", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const [notice] = await ask(r, [p], "tell captain demo: status [fyi]")

    expect(notice!.content).toMatch(/^Captain for demo replied: .*No tasks yet/s)
    expect(notice!.content).not.toContain("boxyard-coordinator")
    expect(notice!.meta).toMatchObject({ projectId: p.id, captain: true, fyi: true })
    // The marker is hidden on the Captain's chat too.
    const said = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).filter((m) => m.role === "assistant")
    expect(said.length).toBeGreaterThan(0)
    for (const m of said) expect(m.content).not.toContain("boxyard-coordinator")

    expect(wakeTurns(r)).toHaveLength(0)
    expect(coordinatorPrompts(r)).toHaveLength(1)
    // Not dropped: the reply waits for the Coordinator's next turn, marked as needing nothing.
    expect(r.yard.store.hasUnseenNotices()).toBe(true)
    await call(r, "POST", "/api/chat", { content: "thanks" })
    const prompts = await waitFor(() => (coordinatorPrompts(r).length >= 2 ? coordinatorPrompts(r) : null), "Cody's next turn", 30_000)
    expect(prompts[1]).toMatch(/- Captain for demo replied: [\s\S]*No tasks yet[\s\S]*\(FYI: already on Cody's screen, no action needed\.\)/)
    expect(prompts[1]).not.toContain("Automatic wake-up")
    await coordinatorIdle(r)
    expect(r.yard.store.hasUnseenNotices()).toBe(false)
  }, 60_000)

  it("still wakes the Coordinator for a decision for Cody, even in a reply marked FYI", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const [notice] = await ask(r, [p], "tell captain demo: status [fyi] [decide]")
    expect(notice!.content).toContain("Cody needs to decide")
    expect(notice!.meta?.fyi).toBeUndefined()
    await waitFor(() => wakeTurns(r).length === 1, "the Coordinator's wake", 10_000)
    await coordinatorIdle(r)
    const prompts = coordinatorPrompts(r)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("Automatic wake-up")
    expect(prompts[1]).toContain("Cody needs to decide")
  }, 60_000)

  it("still wakes the Coordinator when the Captain's turn fails", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const [notice] = await ask(r, [p], "tell captain demo: status [fyi] [fail]")
    expect(notice!.content).toMatch(/^Captain for demo replied: I hit an error: .*fake Captain failure/s)
    expect(notice!.meta?.fyi).toBeUndefined()
    await waitFor(() => wakeTurns(r).length === 1, "the Coordinator's wake", 10_000)
    await coordinatorIdle(r)
    expect(coordinatorPrompts(r)[1]).toContain("fake Captain failure")
  }, 60_000)

  it("wakes the Coordinator for a fan-out's replies, FYI or not, so it can combine them", async () => {
    const r = await start()
    const alpha = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const beta = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const notices = await ask(r, [alpha, beta], "tell captain alpha: status [fyi]\ntell captain beta: status [fyi]")
    expect(notices).toHaveLength(2)
    for (const n of notices) expect(n.meta?.fyi).toBeUndefined()

    // Both requests carry the Coordinator turn that sent them.
    const sent = await Promise.all(
      [alpha, beta].map(async (p) => (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!),
    )
    expect(sent[0]!.meta?.coordinatorTurn).toMatch(/^turn_/)
    expect(sent[1]!.meta?.coordinatorTurn).toBe(sent[0]!.meta?.coordinatorTurn)

    await waitFor(() => wakeTurns(r).length >= 1, "the Coordinator's wake", 10_000)
    await coordinatorIdle(r)
    const woken = coordinatorPrompts(r).slice(1).join("\n")
    expect(woken).toContain("Automatic wake-up")
    expect(woken).toContain("- Captain for alpha replied: ")
    expect(woken).toContain("- Captain for beta replied: ")
    expect(woken).not.toContain("FYI: already on")
    expect(r.yard.store.hasUnseenNotices()).toBe(false)
  }, 60_000)

  it("wakes the Coordinator when it said it acts on the reply (act_on_reply)", async () => {
    const r = await start(false)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)
    await tool("send_to_captain", { project: "ops", message: "status [fyi]", act_on_reply: true })
    const first = await waitFor(() => replies(r)[0], "the first reply", 30_000)
    await captainIdle(r, p)
    await tool("send_to_captain", { project: "ops", message: "status again [fyi]" })
    const second = await waitFor(() => replies(r)[1], "the second reply", 30_000)
    await captainIdle(r, p)

    expect(first.meta?.fyi).toBeUndefined()
    expect(second.meta?.fyi).toBe(true)
    const sent = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).filter((m) => m.role === "user")
    expect(sent[0]!.meta?.actOnReply).toBe(true)
    expect(sent[1]!.meta?.actOnReply).toBeUndefined()
  }, 60_000)

  it("relays the reply at the Captain's result line, before its CLI exits", async () => {
    process.env.FAKE_CLAUDE_EXIT_MS = "2500"
    const r = await start(false)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)
    await tool("send_to_captain", { project: "ops", message: "status [fyi]" })
    await waitFor(() => replies(r)[0], "the reply", 30_000)
    // The Captain's process is still in its exit tail.
    expect(await captainBusy(r, p)).toBe(true)
    await captainIdle(r, p)
    expect(replies(r)).toHaveLength(1)

    // ask_captain gets it as early.
    const t0 = Date.now()
    const res = await tool("ask_captain", { project: "ops", message: "status", timeout_seconds: 30 })
    expect(res.reply).toMatch(/No tasks yet/)
    expect(await captainBusy(r, p)).toBe(true)
    const answered = Date.now() - t0
    await captainIdle(r, p)
    expect(Date.now() - t0 - answered).toBeGreaterThan(1500)
  }, 60_000)
})
