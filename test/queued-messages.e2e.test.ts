import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, ChatMessage, Project, Task, TaskMessage, UiEvent } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// A message sent while the Coordinator, a Captain or an agent is mid-turn is saved at once as queued, and the turn
// that reads it moves it to its own start: right after the reply it was typed over, before its own reply.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  events: UiEvent[]
}
const running: Running[] = []

async function start(seed?: (yard: BoxYard) => void): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
  seed?.(yard)
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  const events: UiEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (ev) => {
    events.push(ev)
    broadcast(ev)
  }
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}`, events }
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

const idle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy || null, "Coordinator idle")

describe("Coordinator: a message sent mid-turn", () => {
  it("is saved as queued, then delivered right after the reply it was typed over", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { id: "chat_first0001", content: "status [slow:2]" })
    await waitFor(async () => (await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy || null, "busy")
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { id: "chat_queued001", content: "k it works perfect" })
    expect(sent.meta?.queued).toBe(true)

    // The chat API returns it right away, still queued.
    const during = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(during.find((m) => m.id === "chat_queued001")?.meta?.queued).toBe(true)

    // Its own turn answers it.
    await waitFor(async () => (await call<ChatMessage[]>(r, "GET", "/api/chat")).filter((m) => m.role === "assistant").length >= 2 || null, "second reply")
    await idle(r)

    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    const order = chat.map((m) => (m.role === "user" ? m.id : m.role))
    expect(order).toEqual(["chat_first0001", "tool", "assistant", "chat_queued001", "tool", "assistant"])
    const msg = chat.find((m) => m.id === "chat_queued001")!
    const firstReply = chat.find((m) => m.role === "assistant")!
    expect(msg.meta?.queued).toBeUndefined()
    expect(msg.meta?.queuedAt).toBe(sent.createdAt)
    expect(sent.createdAt).toBeLessThan(firstReply.createdAt)
    expect(msg.createdAt).toBeGreaterThan(firstReply.createdAt)

    // The UI heard about the move.
    const delivered = r.events.find((e) => e.type === "chat.message" && e.message.id === "chat_queued001" && e.message.meta?.queuedAt)
    expect(delivered).toBeTruthy()
  })

  it("several sent mid-turn are answered together and keep their send order", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { id: "chat_first0002", content: "status [slow:2]" })
    await waitFor(async () => (await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy || null, "busy")
    for (const id of ["chat_stack0001", "chat_stack0002", "chat_stack0003"]) {
      const sent = await call<ChatMessage>(r, "POST", "/api/chat", { id, content: `note ${id}` })
      expect(sent.meta?.queued).toBe(true)
    }
    const during = (await call<ChatMessage[]>(r, "GET", "/api/chat")).filter((m) => m.meta?.queued).map((m) => m.id)
    expect(during).toEqual(["chat_stack0001", "chat_stack0002", "chat_stack0003"])

    await waitFor(async () => (await call<ChatMessage[]>(r, "GET", "/api/chat")).filter((m) => m.role === "assistant").length >= 2 || null, "second reply")
    await idle(r)
    const order = (await call<ChatMessage[]>(r, "GET", "/api/chat")).map((m) => (m.role === "user" ? m.id : m.role))
    expect(order).toEqual(["chat_first0002", "tool", "assistant", "chat_stack0001", "chat_stack0002", "chat_stack0003", "tool", "assistant"])
  })

  it("a message sent while idle isn't queued", async () => {
    const r = await start()
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { id: "chat_idle00001", content: "status" })
    expect(sent.meta).toBeNull()
    await idle(r)
    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat[0]).toMatchObject({ id: "chat_idle00001", meta: null, createdAt: sent.createdAt })
  })

  it("a queued message left by a restart is delivered on startup", async () => {
    // Box Yard stopped mid-turn with this message waiting.
    const r = await start((yard) => yard.store.addChat("user", "still there?", { queued: true }, "chat_queued002"))
    await waitFor(async () => (await call<ChatMessage[]>(r, "GET", "/api/chat")).some((m) => m.role === "assistant") || null, "reply after restart")
    await idle(r)
    const msg = (await call<ChatMessage[]>(r, "GET", "/api/chat")).find((m) => m.id === "chat_queued002")!
    expect(msg.meta?.queued).toBeUndefined()
    expect(msg.meta?.queuedAt).toBeTypeOf("number")
  })
})

describe("Captain: a message sent mid-turn", () => {
  it("is saved as queued, then delivered right after the turn it was sent during", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "queued-captain" })
    const path = `/api/projects/${p.id}/captain/messages`
    await call(r, "POST", path, { id: "cap_first00001", content: "status [slow:2]" })
    await waitFor(async () => (await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy || null, "Captain busy")
    const sent = await call<CaptainMessage>(r, "POST", path, { id: "cap_queued0001", content: "k it works perfect" })
    expect(sent.meta?.queued).toBe(true)
    expect((await call<CaptainMessage[]>(r, "GET", path)).find((m) => m.id === "cap_queued0001")?.meta?.queued).toBe(true)

    await waitFor(async () => (await call<CaptainMessage[]>(r, "GET", path)).filter((m) => m.role === "assistant").length >= 2 || null, "second Captain reply")
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy || null, "Captain idle")

    const list = await call<CaptainMessage[]>(r, "GET", path)
    const order = list.filter((m) => m.role === "user" || m.role === "assistant").map((m) => (m.role === "user" ? m.id : m.role))
    expect(order).toEqual(["cap_first00001", "assistant", "cap_queued0001", "assistant"])
    const msg = list.find((m) => m.id === "cap_queued0001")!
    expect(msg.meta?.queued).toBeUndefined()
    expect(msg.meta?.queuedAt).toBe(sent.createdAt)
    expect(r.events.some((e) => e.type === "captain.message" && e.message.id === "cap_queued0001" && e.message.meta?.queuedAt)).toBe(true)
  })
})

describe("Task: feedback sent while the agent works", () => {
  it("is saved as queued, then delivered right before the turn that reads it", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "queued-task" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Queued feedback", prompt: "write a file [slow]" })
    await waitFor(async () => (await call<Task>(r, "GET", `/api/tasks/${t.id}`)).status === "working" || null, "working")
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "also add a test" })
    const during = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    const queued = during.find((m) => m.role === "user" && m.content === "also add a test")!
    expect(queued.meta?.queued).toBe(true)
    expect(queued.meta?.inputId).toBeTypeOf("string")

    // The second turn picks it up.
    await waitFor(async () => {
      const list = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
      return list.find((m) => m.id === queued.id)?.meta?.queuedAt ? list : null
    }, "delivered")
    await waitFor(async () => (await call<Task>(r, "GET", `/api/tasks/${t.id}`)).status === "done" || null, "done", 30_000)

    const list = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    const at = list.findIndex((m) => m.id === queued.id)
    const msg = list[at]!
    expect(msg.meta?.queued).toBeUndefined()
    expect(msg.meta?.queuedAt).toBe(queued.createdAt)
    // Everything from the first turn (its reply included) comes before it, the second turn's reply after it.
    const firstReply = list.findIndex((m) => m.role === "assistant")
    expect(firstReply).toBeGreaterThanOrEqual(0)
    expect(firstReply).toBeLessThan(at)
    expect(list.slice(at + 1).some((m) => m.role === "assistant")).toBe(true)
    expect(r.events.some((e) => e.type === "task.message" && e.message.id === queued.id && e.message.meta?.queuedAt)).toBe(true)
  })
})
