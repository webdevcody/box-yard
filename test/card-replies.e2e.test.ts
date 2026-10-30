import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { searchHistory } from "../server/history.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Replying from a task's card in the Coordinator chat: "This task" sends to the task and leaves a line in the chat,
// "Coordinator" asks the Coordinator with the task named in its prompt.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_LOG_FULL"]

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
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
  process.env.FAKE_CLAUDE_LOG_FULL = "1"
  return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { prompt: string })
}
const chat = (r: Running) => call<ChatMessage[]>(r, "GET", "/api/chat")
const quiet = (t: Task) => !["queued", "starting", "working"].includes(t.status) && t.pendingCount === 0
const untilQuiet = (r: Running, id: string) => waitFor(async () => (quiet(await call<Task>(r, "GET", `/api/tasks/${id}`)) ? true : null), "task to settle")
/** The task's first turn has run and the Coordinator has read its notices. */
const settled = (r: Running, id: string) =>
  untilQuiet(r, id).then(() => waitFor(() => (!r.yard.store.hasUnseenNotices() && !r.yard.orchestrator.busy ? true : null), "coordinator to settle"))
const seenByCoordinator = (r: Running, id: string) =>
  (r.yard.store.db.prepare("SELECT seen_by_orchestrator AS seen FROM chat_messages WHERE id = ?").get(id) as { seen: number }).seen

describe("reply in a card", () => {
  it("This task: the task gets the message, and the chat a line about it that the Coordinator doesn't wake for", async () => {
    const lines = logFile()
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)
    const turns = lines().length

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "now one about pineapples", inChat: true })
    const sent = await waitFor(async () => (await chat(r)).find((m) => m.meta?.sent), "the sent line")
    expect(sent.role).toBe("notice")
    expect(sent.content).toBe("✉️ **Haiku** got a message from Cody: now one about pineapples")
    expect(sent.meta).toMatchObject({ taskId: t.id, projectId: p.id, sent: true })
    expect(seenByCoordinator(r, sent.id)).toBe(1)

    // The task runs a turn on it; the Coordinator isn't asked about the line.
    await waitFor(() => (lines().slice(turns).some((l) => l.prompt.includes("now one about pineapples")) ? true : null), "the task's turn")
    await settled(r, t.id)
    expect(lines().filter((l) => l.prompt.includes("got a message from Cody"))).toEqual([])

    // From the task page (no inChat), the chat stays as it was.
    const before = (await chat(r)).filter((m) => m.meta?.sent).length
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "and one more" })
    await settled(r, t.id)
    expect((await chat(r)).filter((m) => m.meta?.sent).length).toBe(before)
  })

  it("a file with no text says so", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)
    const msg = r.yard.tasks.sentFromChat(t.id, "  ", [{ id: "upl_1", name: "a.png", path: "/tmp/a.png", mime: "image/png", size: 1 } as never])
    expect(msg.content).toBe("✉️ **Haiku** got a message from Cody: a file")
    expect(msg.meta).toMatchObject({ attachments: [{ id: "upl_1" }] })
  })

  it("is sealed like the task's other notices when its project is status-only", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)
    r.yard.tasks.sentFromChat(t.id, "the secret is pineapples")
    const q = { terms: ["pineapples"], sources: ["chat" as const], limit: 10 }
    expect(searchHistory({ store: r.yard.store }, { coordinator: true }, q).hits).toHaveLength(1)
    expect(searchHistory({ store: r.yard.store }, { coordinator: true, statusOnly: (id) => id === p.id }, q).hits).toEqual([])
  })

  it("Coordinator: the question names its task in the prompt, and keeps which task in its meta", async () => {
    const lines = logFile()
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)

    // A task deleted since (or never there) is dropped.
    await call(r, "POST", "/api/chat", { content: "is it any good?", about: [t.id, "task_gone123456"] })
    const asked = await waitFor(async () => (await chat(r)).find((m) => m.role === "user" && m.content === "is it any good?"), "the question")
    expect(asked.meta).toEqual({ about: [t.id] })
    const turn = await waitFor(() => lines().find((l) => l.prompt.includes("is it any good?")), "the Coordinator's turn")
    expect(turn.prompt).toContain(`[Cody asked this from the card for the task "Haiku" (${t.id}) in the chat, so it's about that task.]\nis it any good?`)

    // A plain message has no note.
    await call(r, "POST", "/api/chat", { content: "anything else?" })
    const plain = await waitFor(() => lines().find((l) => l.prompt.includes("anything else?")), "the second turn")
    expect(plain.prompt).not.toContain("asked this from the card")
  })

  it("refuses an about that isn't a task id", async () => {
    const r = await start()
    await expect(call(r, "POST", "/api/chat", { content: "hi", about: ["../etc"] })).rejects.toThrow(/-> 400/)
  })
})
