import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, ChatMessage, Project, UiEvent } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Messages queued in the Coordinator chat or a Captain's thread (sent mid-turn) can be edited or deleted, with
// Undo, until the turn that reads them takes them. After that every change is refused, so the turn reads each
// message once, as it was when it took it.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  events: UiEvent[]
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
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

async function send(r: Running, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(r.base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const { status, data } = await send(r, method, path, body)
  if (status >= 400) throw new Error(`${method} ${path} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

/** Every prompt a turn of this runner is given, in order; `during` runs as each turn starts (after it took its messages). */
function prompts(runner: object, during?: (prompt: string, n: number) => void): string[] {
  const seen: string[] = []
  const r = runner as { runPrompt: (body: string, ...rest: unknown[]) => Promise<unknown> }
  const run = r.runPrompt.bind(runner)
  r.runPrompt = (body, ...rest) => {
    seen.push(body)
    during?.(body, seen.length)
    return run(body, ...rest)
  }
  return seen
}

const busy = (r: Running, path: string) => waitFor(async () => (await call<{ busy: boolean }>(r, "GET", path)).busy || null, "busy")
const idle = (r: Running, path: string) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", path)).busy || null, "idle")
const count = (text: string, part: string) => text.split(part).length - 1

describe("Coordinator chat: queued messages", () => {
  it("edit and delete (with Undo) until the next turn takes them; it reads the edited text, never a deleted one", async () => {
    const r = await start()
    const seen = prompts(r.yard.orchestrator)
    await call(r, "POST", "/api/chat", { id: "chat_busy00001", content: "status [slow:2]" })
    await busy(r, "/api/orchestrator")
    for (const [id, content] of [
      ["chat_q00000001", "first note"],
      ["chat_q00000002", "second note"],
      ["chat_q00000003", "third note"],
    ]) {
      expect((await call<ChatMessage>(r, "POST", "/api/chat", { id, content })).meta?.queued).toBe(true)
    }

    const edited = await call<ChatMessage>(r, "PATCH", "/api/chat/messages/chat_q00000001", { text: " first note, edited " })
    expect(edited).toMatchObject({ id: "chat_q00000001", content: "first note, edited", meta: { queued: true } })
    expect(r.events.some((e) => e.type === "chat.message" && e.message.id === "chat_q00000001" && e.message.content === "first note, edited")).toBe(true)
    expect((await send(r, "PATCH", "/api/chat/messages/chat_q00000001", { text: "  " })).status).toBe(400)

    const deleted = await call<ChatMessage>(r, "DELETE", "/api/chat/messages/chat_q00000002")
    expect(deleted.meta).toEqual({ cancelled: true })
    expect(await send(r, "PATCH", "/api/chat/messages/chat_q00000002", { text: "too late" })).toMatchObject({ status: 409, data: { error: "That message was deleted." } })

    // Undo.
    await call(r, "DELETE", "/api/chat/messages/chat_q00000003")
    expect((await call<ChatMessage>(r, "POST", "/api/chat/messages/chat_q00000003/restore")).meta).toEqual({ queued: true })
    // Not a queued message (Cody's first one, already read), or no such message.
    expect((await send(r, "PATCH", "/api/chat/messages/chat_busy00001", { text: "x" })).status).toBe(409)
    expect((await send(r, "DELETE", "/api/chat/messages/chat_nope00001")).status).toBe(404)

    await waitFor(() => seen.length >= 2 || null, "second turn")
    await idle(r, "/api/orchestrator")
    expect(seen[1]).toContain("first note, edited")
    expect(seen[1]).toContain("third note")
    expect(seen[1]).not.toContain("second note")
    expect(seen).toHaveLength(2)

    // Delivered: changes are refused now.
    const late = await send(r, "PATCH", "/api/chat/messages/chat_q00000001", { text: "after the fact" })
    expect(late.status).toBe(409)
    expect(late.data.error).toMatch(/already delivered to the Coordinator/)
    expect((await send(r, "DELETE", "/api/chat/messages/chat_q00000003")).status).toBe(409)
    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.find((m) => m.id === "chat_q00000001")).toMatchObject({ content: "first note, edited", meta: { queuedAt: expect.any(Number) } })
    expect(chat.find((m) => m.id === "chat_q00000002")?.meta).toEqual({ cancelled: true })
  })

  it("an edit or delete as the turn takes the message is refused, and the turn reads it once, as it was", async () => {
    const r = await start()
    const refused: string[] = []
    const seen = prompts(r.yard.orchestrator, (_prompt, n) => {
      if (n !== 2) return
      // The turn has just read and taken its messages: this is the earliest a change can land.
      for (const change of [() => r.yard.orchestrator.editQueued("chat_race00001", "edited too late"), () => r.yard.orchestrator.cancelQueued("chat_race00001")]) {
        try {
          change()
        } catch (err) {
          refused.push((err as Error).message)
        }
      }
    })
    await call(r, "POST", "/api/chat", { id: "chat_busy00002", content: "status [slow:2]" })
    await busy(r, "/api/orchestrator")
    await call(r, "POST", "/api/chat", { id: "chat_race00001", content: "the original" })
    await waitFor(() => seen.length >= 2 || null, "second turn")
    await idle(r, "/api/orchestrator")

    expect(refused).toEqual([expect.stringMatching(/already delivered/), expect.stringMatching(/already delivered/)])
    expect(count(seen.join("\n"), "the original")).toBe(1)
    expect(seen.join("\n")).not.toContain("edited too late")
    expect((await call<ChatMessage[]>(r, "GET", "/api/chat")).find((m) => m.id === "chat_race00001")).toMatchObject({ content: "the original" })
    expect(seen).toHaveLength(2)
  })

  it("deleting the only queued message means no turn for it; Undo after the turn ended still gets it answered", async () => {
    const r = await start()
    const seen = prompts(r.yard.orchestrator)
    await call(r, "POST", "/api/chat", { id: "chat_busy00003", content: "status [slow:2]" })
    await busy(r, "/api/orchestrator")
    await call(r, "POST", "/api/chat", { id: "chat_gone00001", content: "never mind" })
    await call(r, "DELETE", "/api/chat/messages/chat_gone00001")
    await idle(r, "/api/orchestrator")
    // Give a would-be follow-up turn the chance to start.
    await new Promise((res) => setTimeout(res, 300))
    expect(seen).toHaveLength(1)

    const restored = await call<ChatMessage>(r, "POST", "/api/chat/messages/chat_gone00001/restore")
    // Idle now: it goes straight in, not queued.
    expect(restored.meta).toEqual({})
    await waitFor(() => seen.length >= 2 || null, "turn for the restored message")
    expect(seen[1]).toContain("never mind")
    await idle(r, "/api/orchestrator")
  })
})

describe("Captain: queued messages", () => {
  it("edit and delete until the next turn takes them, only in the Captain's own project", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "queue-edit-captain" })
    const other = await call<Project>(r, "POST", "/api/projects", { name: "queue-edit-other" })
    const seen = prompts(r.yard.captains.get(p.id))
    const path = `/api/projects/${p.id}/captain/messages`
    await call(r, "POST", path, { id: "cap_busy000001", content: "status [slow:2]" })
    await busy(r, `/api/projects/${p.id}/captain`)
    await call(r, "POST", path, { id: "cap_q000000001", content: "keep this" })
    await call(r, "POST", path, { id: "cap_q000000002", content: "drop this" })

    // Through another project's Captain: not found.
    expect((await send(r, "PATCH", `/api/projects/${other.id}/captain/messages/cap_q000000001`, { text: "hijack" })).status).toBe(404)
    expect((await send(r, "DELETE", `/api/projects/${other.id}/captain/messages/cap_q000000002`)).status).toBe(404)

    const edited = await call<CaptainMessage>(r, "PATCH", `${path}/cap_q000000001`, { text: "keep this, edited" })
    expect(edited).toMatchObject({ projectId: p.id, content: "keep this, edited", meta: { queued: true, source: "cody" } })
    expect(r.events.some((e) => e.type === "captain.message" && e.message.id === "cap_q000000001" && e.message.content === "keep this, edited")).toBe(true)
    await call(r, "DELETE", `${path}/cap_q000000002`)

    await waitFor(() => seen.length >= 2 || null, "second Captain turn")
    await idle(r, `/api/projects/${p.id}/captain`)
    expect(seen[1]).toContain("keep this, edited")
    expect(seen[1]).not.toContain("drop this")
    const late = await send(r, "DELETE", `${path}/cap_q000000001`)
    expect(late.status).toBe(409)
    expect(late.data.error).toMatch(/already delivered to the Captain/)
    await idle(r, "/api/orchestrator")
  })
})
