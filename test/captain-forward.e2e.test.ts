import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, QueuedMessage, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Cody sends a task-chat message to the project's Captain instead of the busy agent (POST /api/tasks/:id/captain):
// the Captain gets the task's queue with it, can act on it, and its reply shows in the task's chat.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
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
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const messages = (r: Running, t: Task): TaskMessage[] => r.yard.store.listTaskMessages(t.id, 500)
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)

function captainPrompts(r: Running, p: Project): string[] {
  const id = r.yard.store.getKv(`captain_session:${p.id}`)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

describe("forward a task-chat message to the Captain", () => {
  it("the Captain gets the task's queue, acts on it, and its reply shows in the task's chat", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Login form", prompt: "Fix the login form [slow:20]" })
    await waitFor(() => (r.yard.store.getTask(t.id)!.status === "working" ? true : null), "the task to be working", 30_000)

    // Two messages queue behind the busy agent.
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "Also add a dark mode toggle" })
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "And fix the footer links" })
    const queued = await call<QueuedMessage[]>(r, "GET", `/api/tasks/${t.id}/queue`)
    expect(queued.map((q) => q.text)).toEqual(["Also add a dark mode toggle", "And fix the footer links"])

    const line = await call<TaskMessage>(r, "POST", `/api/tasks/${t.id}/captain`, { content: "Split the dark mode item out into its own task [cancel-queued]" })
    expect(line).toMatchObject({ taskId: t.id, role: "event", content: "Split the dark mode item out into its own task [cancel-queued]" })
    expect(line.meta).toMatchObject({ kind: "to_captain", captainProjectId: p.id, captainName: "demo", queued: 2 })

    // It's on the Captain as Cody's message, with the task and its queue, and not queued for the agent.
    const onCaptain = r.yard.store.listCaptainMessages(p.id, 50).find((m) => m.id === line.meta!.captainMessageId)!
    expect(onCaptain.meta).toMatchObject({ source: "cody", viaTask: { taskId: t.id, taskTitle: "Login form", queue: queued.map((q) => ({ id: q.id, text: q.text })) } })
    expect((await call<QueuedMessage[]>(r, "GET", `/api/tasks/${t.id}/queue`)).length).toBe(2)

    // The Captain's reply comes back to the task's chat.
    const answer = await waitFor(() => messages(r, t).find((m) => m.meta?.kind === "captain_answer") ?? null, "the Captain's reply in the task's chat", 30_000)
    expect(answer.role).toBe("event")
    expect(answer.meta).toMatchObject({ captainMessageIds: [onCaptain.id], captainProjectId: p.id, captainName: "demo" })
    expect(answer.content).toContain(`Forwarded from ${t.id} with queued ${queued[0]!.id}, ${queued[1]!.id}.`)
    expect(answer.content).toContain(`Cancelled ${queued[0]!.id}`)
    await captainIdle(r, p)

    // The Captain's prompt named the task and listed its queue by id; it cancelled the first queued message.
    const prompt = captainPrompts(r, p).find((x) => x.includes("Split the dark mode item"))!
    expect(prompt).toContain(`[From Cody, sent from the chat of task "Login form" (${t.id}) to you instead of its busy agent`)
    expect(prompt).toContain(`- ${queued[0]!.id} (Cody): Also add a dark mode toggle`)
    expect(prompt).toContain(`- ${queued[1]!.id} (Cody): And fix the footer links`)
    expect((await call<QueuedMessage[]>(r, "GET", `/api/tasks/${t.id}/queue`)).map((q) => q.text)).toEqual(["And fix the footer links"])

    // The thread order: sent to the Captain, then its reply. Neither went to the agent.
    const kinds = messages(r, t).filter((m) => m.meta?.kind === "to_captain" || m.meta?.kind === "captain_answer").map((m) => m.meta!.kind)
    expect(kinds).toEqual(["to_captain", "captain_answer"])
    expect(messages(r, t).some((m) => m.role === "user" && m.content.includes("Split the dark mode"))).toBe(false)
    await call(r, "POST", `/api/tasks/${t.id}/stop`)
  }, 60_000)

  it("an idle task with nothing queued says so, and an unknown task is a 404", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Notes page", prompt: "Write the notes page" })
    await waitFor(() => (["done", "idle"].includes(r.yard.store.getTask(t.id)!.status) ? true : null), "the task to finish", 30_000)

    await call(r, "POST", `/api/tasks/${t.id}/captain`, { content: "What's queued here?" })
    const answer = await waitFor(() => messages(r, t).find((m) => m.meta?.kind === "captain_answer") ?? null, "the Captain's reply", 30_000)
    expect(answer.content).toContain(`Forwarded from ${t.id} with no queued messages.`)
    await captainIdle(r, p)
    expect(captainPrompts(r, p).some((x) => x.includes(`(Task ${t.id} had no queued messages.)`))).toBe(true)
    // The task didn't wake for it.
    expect(r.yard.store.getTask(t.id)!.turnCount).toBe(1)

    const res = await fetch(`${r.base}/api/tasks/task_nope123/captain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }) })
    expect(res.status).toBe(404)
  }, 60_000)
})
