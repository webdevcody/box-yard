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

// #46: a Captain's reply to the Coordinator is pushed up as an update; ask/wait_for_captain stay short.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  mcp?: { client: Client; close: () => Promise<void> }
}
const running: Running[] = []

async function start(orchestratorAutoWake = false): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
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

/** Every prompt a fake Claude session received (scripts/fake-claude.mjs keeps them in its session file). */
function sessionPrompts(r: Running, kvKey: string): string[] {
  const id = r.yard.store.getKv(kvKey)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

const replies = (r: Running) => r.yard.store.listChat(500).filter((m: ChatMessage) => m.role === "notice" && m.meta?.captain === true && m.meta?.replyTo)
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)

describe("Captain replies to the Coordinator (#46)", () => {
  it("pushes the reply to a send_to_captain up as an update that wakes the Coordinator", async () => {
    const r = await start(true)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "tell captain demo: status" })

    const notice = await waitFor(() => replies(r)[0], "the Captain's reply on the Coordinator chat", 30_000)
    expect(notice.content).toMatch(/^Captain for demo replied: .*No tasks yet/s)
    expect(notice.meta).toMatchObject({ projectId: p.id, captain: true })
    // It names the send_to_captain message it answers.
    const sent = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!
    expect(sent.meta).toMatchObject({ source: "coordinator", tool: "send_to_captain" })
    expect(notice.meta?.replyTo).toEqual([sent.id])

    // The update wakes the Coordinator, which reads it in an automatic turn of its own.
    const prompts = await waitFor(() => {
      const list = sessionPrompts(r, "orchestrator_session")
      return list.length >= 2 ? list : null
    }, "the Coordinator's automatic turn after the reply", 30_000)
    expect(prompts[0]).toContain("tell captain demo: status")
    expect(prompts[1]).toContain("- Captain for demo replied: ")
    expect(prompts[1]).toContain("Automatic wake-up")
    await captainIdle(r, p)
    await coordinatorIdle(r)
    expect(r.yard.store.hasUnseenNotices()).toBe(false)
    expect(replies(r)).toHaveLength(1)
  })

  it("ask_captain returns as soon as the reply lands, and the reply isn't pushed a second time", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)

    const t0 = Date.now()
    const res = await tool("ask_captain", { project: "ops", message: "status", timeout_seconds: 60 })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(res.reply).toMatch(/No tasks yet/)
    expect(res.note).toBeUndefined()

    await captainIdle(r, p)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(replies(r)).toHaveLength(0)
  })

  it("ask_captain that runs out of time says so, and the reply is pushed when it lands", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)

    const t0 = Date.now()
    const res = await tool("ask_captain", { project: "ops", message: "status [slow:8]", timeout_seconds: 5 })
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(4_900)
    expect(waited).toBeLessThan(7_500)
    expect(res).toMatchObject({ allFinished: false, reply: null })
    expect(res.note).toMatch(/reply will reach you as a Box Yard update/)
    expect(replies(r)).toHaveLength(0)

    const notice = await waitFor(() => replies(r)[0], "the late reply pushed to the Coordinator", 20_000)
    expect(notice.content).toMatch(/^Captain for ops replied: .*No tasks yet/s)
    expect(notice.meta?.replyTo).toEqual([res.messageId])
    await captainIdle(r, p)
  }, 30_000)

  it("caps ask/wait_for_captain at 60 s", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)
    await expect(tool("wait_for_captain", { project: "ops", timeout_seconds: 240 })).rejects.toThrow(/60/)
    await expect(tool("ask_captain", { project: "ops", message: "status", timeout_seconds: 61 })).rejects.toThrow(/60/)
  })

  it("wait_for_captain returns early when the reply lands and takes it instead of a pushed update", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const tool = await coordinatorTools(r)

    const sent = await tool("send_to_captain", { project: "ops", message: "status [slow:2]" })
    expect(sent.delivered).toBe(true)
    const t0 = Date.now()
    const res = await tool("wait_for_captain", { project: "ops", timeout_seconds: 60 })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(res.lastReply).toMatch(/No tasks yet/)
    expect(res.allFinished).toBe(true)
    expect(res.note).toBeUndefined()

    await captainIdle(r, p)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(replies(r)).toHaveLength(0)
  })

  it("doesn't push replies to Cody's own Captain-tab messages up to the Coordinator", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "status" })
    await waitFor(async () => (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).some((m) => m.role === "assistant"), "Captain reply")
    await captainIdle(r, p)
    expect(r.yard.store.listChat(500).filter((m: ChatMessage) => m.meta?.captain === true)).toHaveLength(0)
  })
})
