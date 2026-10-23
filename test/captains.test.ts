import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import { captainToolResult } from "../server/orchestrator.js"
import { captainSourceOf } from "../shared/captain.js"
import type { CaptainMessage, CaptainToolResult, ChatMessage, Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake: true }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
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

describe("project Captains", () => {
  it("accept direct project-page messages and keeps a per-project transcript", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })

    await call<CaptainMessage>(r, "POST", `/api/projects/${p.id}/captain/messages`, {
      id: "cap_abc123def456",
      content: "task demo: Haiku -- write a haiku",
    })

    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle")
    const messages = await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
    expect(messages.map((m) => m.role)).toContain("user")
    // Labelled as Cody's on the Captain tab.
    expect(messages.find((m) => m.id === "cap_abc123def456")?.meta).toMatchObject({ source: "cody" })
    expect(messages.some((m) => m.role === "assistant" && /Started task/i.test(m.content))).toBe(true)
    const tasks = await call<Task[]>(r, "GET", `/api/tasks?projectId=${p.id}`)
    expect(tasks).toHaveLength(1)
    await waitFor(async () => {
      const t = await call<Task>(r, "GET", `/api/tasks/${tasks[0]!.id}`)
      return !["queued", "starting", "working"].includes(t.status) ? t : null
    }, "Captain-created task to settle")
  })

  it("exposes Coordinator MCP tools that hand work to a Captain", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "ops" })
    const mcp = buildMcpServer({
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
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)

    const res = (await client.callTool({
      name: "ask_captain",
      arguments: { project: "ops", message: "status", timeout_seconds: 30 },
    })) as { content: { text: string }[]; isError?: boolean }

    expect(res.isError).not.toBe(true)
    const body = JSON.parse(res.content[0]!.text)
    expect(body.allFinished).toBe(true)
    expect(body.state.projectId).toBeTruthy()
    await client.close()
    await mcp.close()
  })

  it("stores the Coordinator's orders on the Captain transcript and the Captain's reply on the Coordinator's tool line", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "tell captain demo: status please\nask captain demo: status" })

    const chat = await waitFor(async () => {
      const list = await call<ChatMessage[]>(r, "GET", "/api/chat")
      const ask = list.find((m) => m.role === "tool" && m.content === "ask_captain")
      return ask?.meta?.captain ? list : null
    }, "ask_captain result on the tool line", 30_000)
    const ask = chat.find((m) => m.content === "ask_captain")!
    expect(ask.meta?.input).toMatchObject({ project: "demo", message: "status" })
    expect(ask.meta?.captain).toMatchObject({ projectId: p.id, finished: true })
    expect((ask.meta?.captain as CaptainToolResult).reply).toMatch(/No tasks yet/)
    const tell = chat.find((m) => m.content === "send_to_captain")!
    expect(tell.meta?.captain).toMatchObject({ projectId: p.id, reply: null })

    const transcript = await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
    const inbound = transcript.filter((m) => m.role === "user")
    expect(inbound.map((m) => [m.content, m.meta?.source, m.meta?.tool])).toEqual([
      ["status please", "coordinator", "send_to_captain"],
      ["status", "coordinator", "ask_captain"],
    ])
    // Let both sessions finish before the store closes.
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle")
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle")
  })

  it("routes task notices to the owning Captain before reporting to the Coordinator", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })

    await waitFor(async () => (await call<Task>(r, "GET", `/api/tasks/${task.id}`)).status === "done", "task done")
    const captainMessages = await waitFor(async () => {
      const list = await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
      return list.some((m) => m.role === "notice" && /is done|finished/.test(m.content)) ? list : null
    }, "Captain notice")
    expect(captainMessages.some((m) => m.meta?.taskId === task.id)).toBe(true)

    const chat = await waitFor(async () => {
      const list = await call<ChatMessage[]>(r, "GET", "/api/chat")
      return list.some((m) => m.role === "notice" && m.meta?.captain === true) ? list : null
    }, "Captain report to Coordinator", 30_000)
    expect(chat.some((m) => m.content.startsWith("Captain for demo:"))).toBe(true)
  })
})

describe("Captain message helpers", () => {
  it("labels inbound messages by meta.source, falling back to the id shape for older rows", () => {
    expect(captainSourceOf({ id: "cap_x", meta: { source: "cody" } })).toBe("cody")
    expect(captainSourceOf({ id: "cap_x", meta: { scheduleId: "sch_1" } })).toBe("schedule")
    expect(captainSourceOf({ id: "chat_abcdef123456", meta: null })).toBe("cody")
    expect(captainSourceOf({ id: "cap_abcdef123456", meta: null })).toBe("coordinator")
  })

  it("reads the Captain's project and reply from send/ask/wait_for_captain results", () => {
    const text = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }]
    expect(captainToolResult("send_to_captain", text({ delivered: true, projectId: "prj_a", messageId: "cap_1" }))).toEqual({ projectId: "prj_a", reply: null, finished: null })
    // ask_captain: only the reply to this question, never an older lastReply.
    expect(captainToolResult("ask_captain", text({ projectId: "prj_a", allFinished: true, lastReply: "old", reply: null }))).toEqual({ projectId: "prj_a", reply: null, finished: true })
    expect(captainToolResult("ask_captain", text({ projectId: "prj_a", allFinished: true, lastReply: "x", reply: "Two open tasks." }))?.reply).toBe("Two open tasks.")
    expect(captainToolResult("wait_for_captain", JSON.stringify({ state: { projectId: "prj_b" }, allFinished: false, lastReply: "Working on it" }))).toEqual({
      projectId: "prj_b",
      reply: "Working on it",
      finished: false,
    })
    expect(captainToolResult("list_tasks", text({}))).toBeNull()
    expect(captainToolResult("ask_captain", "Captains are not available")).toBeNull()
  })
})
