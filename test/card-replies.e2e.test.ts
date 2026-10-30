import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { searchHistory } from "../server/history.js"
import { BATCH_THREAD_HEADING, TASK_THREAD_HEADING } from "../server/handoff.js"
import type { ChatMessage, Project, SideThread, SideThreadMessage, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Replying from a task's card in the Coordinator chat: "This task" sends to the task and leaves a line in the chat,
// "Coordinator" asks in the card's own side thread (kind "task"), which the main chat never sees.

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
const fakeSession = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`), "utf8")) as { turns: { prompt: string }[] }
/** A thread's answers, once it has `n` and isn't busy. */
const answers = (r: Running, id: string, n: number) =>
  waitFor(async () => {
    const done = (await call<SideThreadMessage[]>(r, "GET", `/api/threads/${id}/messages`)).filter((m) => m.role === "assistant" || m.role === "error")
    const busy = (await call<SideThread[]>(r, "GET", "/api/threads")).find((t) => t.id === id)?.busy
    return done.length >= n && !busy ? done : null
  }, `${n} side thread answers`)
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

  it("Coordinator: a question goes to the task's own side thread, forked from the Coordinator and told the task's state", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)
    await call(r, "POST", "/api/chat", { content: "status one" })
    await waitFor(async () => ((await chat(r)).at(-1)?.role === "assistant" && !r.yard.orchestrator.busy ? true : null), "the Coordinator's reply")
    const before = await chat(r)
    const mainId = String(before.filter((m) => m.role === "assistant").at(-1)!.meta!.sessionId)
    const mainTurns = fakeSession(mainId).turns.length

    const { thread, message } = await call<{ thread: SideThread; message: SideThreadMessage }>(r, "POST", "/api/threads", { kind: "task", anchorId: t.id, question: "is it any good?" })
    expect(thread).toMatchObject({ projectId: null, anchorId: t.id, kind: "task", quote: "Haiku" })
    expect(message).toMatchObject({ role: "user", content: "is it any good?" })
    const [first] = await answers(r, thread.id, 1)
    expect(first!.content).toContain("(forked)")
    expect(first!.content).toContain("You asked: is it any good?")
    const session = r.yard.store.sideThreadSession(thread.id)!
    const prompt = fakeSession(session.sessionId).turns.at(-1)!.prompt
    expect(prompt).toContain('[Box Yard side thread] Cody is asking you about a task, from the card of the task "Haiku" in the Coordinator chat.')
    expect(prompt).toContain(`${TASK_THREAD_HEADING}\n- ${t.id} "Haiku" [demo] done`)
    expect(prompt).toMatch(/Its updates in the chat, oldest first:\n- .*\*\*Haiku\*\*/)
    expect(prompt).toContain("This thread is read-only")

    // Asking again from the card adds to the same thread, which resumes its own session.
    const again = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { kind: "task", anchorId: t.id, question: "and the title?" })
    expect(again.thread.id).toBe(thread.id)
    const [, second] = await answers(r, thread.id, 2)
    expect(second!.content).toContain("You asked: and the title?")
    // The task didn't change, so its state isn't told again.
    expect(fakeSession(session.sessionId).turns.at(-1)!.prompt).toBe("and the title?")

    // The main chat and the Coordinator's session never see it.
    expect(await chat(r)).toEqual(before)
    expect(fakeSession(mainId).turns).toHaveLength(mainTurns)
    expect((await call<SideThread[]>(r, "GET", "/api/threads")).map((x) => [x.id, x.kind])).toEqual([[thread.id, "task"]])
  })

  it("Coordinator, from a batch card: the thread is the batch's, told every task's state", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const a = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Level 1: map", prompt: "x" })
    const b = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Level 2: map", prompt: "x" })
    await settled(r, a.id)
    await settled(r, b.id)
    r.yard.store.db.prepare("UPDATE tasks SET batch_id = 'bat_levels' WHERE id IN (?, ?)").run(a.id, b.id)

    const { thread } = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { kind: "task", anchorId: "batch:bat_levels", question: "which is behind?" })
    expect(thread).toMatchObject({ anchorId: "batch:bat_levels", kind: "task", quote: "Level 1: map (and 1 more)" })
    await answers(r, thread.id, 1)
    const prompt = fakeSession(r.yard.store.sideThreadSession(thread.id)!.sessionId).turns.at(-1)!.prompt
    expect(prompt).toContain('from the card of the batch of tasks "Level 1: map (and 1 more)"')
    expect(prompt).toContain(BATCH_THREAD_HEADING)
    expect(prompt).toContain(`- ${a.id} "Level 1: map"`)
    expect(prompt).toContain(`- ${b.id} "Level 2: map"`)
    expect(prompt).toContain("Their updates in the chat")
  })

  it("Coordinator, for a status-only project: the thread gets the task's status, not what it said", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await settled(r, t.id)
    r.yard.tasks.sentFromChat(t.id, "the secret is pineapples")
    r.yard.orchestrator.statusOnly = (id) => id === p.id
    const { thread } = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { kind: "task", anchorId: t.id, question: "what did it write?" })
    await answers(r, thread.id, 1)
    const prompt = fakeSession(r.yard.store.sideThreadSession(thread.id)!.sessionId).turns.at(-1)!.prompt
    // No chat turn to fork yet: it starts fresh, from the chat as the Coordinator read it (here, nothing).
    expect((await call<SideThread[]>(r, "GET", "/api/threads"))[0]).toMatchObject({ context: "summary" })
    expect(prompt).toContain(`- ${t.id} "Haiku" [demo] done`)
    expect(prompt).toContain("(status only: ask its Captain for what it said)")
    expect(prompt).not.toContain("pineapples")
    expect(prompt).not.toContain("updates in the chat")
  })

  it("refuses a task thread on no task, or in a Captain's chat", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await expect(call(r, "POST", "/api/threads", { kind: "task", anchorId: "task_gone123456", question: "hi" })).rejects.toThrow(/-> 400.*no task or batch/)
    await expect(call(r, "POST", "/api/threads", { kind: "task", anchorId: "batch:nope", question: "hi" })).rejects.toThrow(/-> 400/)
    await expect(call(r, "POST", "/api/threads", { kind: "task", anchorId: t.id, projectId: p.id, question: "hi" })).rejects.toThrow(/-> 400.*only the Coordinator chat/)
    expect(r.yard.store.listSideThreads(null)).toEqual([])
  })
})
