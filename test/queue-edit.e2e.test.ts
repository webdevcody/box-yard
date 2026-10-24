// Editable queued messages: GET/PATCH/DELETE /api/tasks/:id/queue, Undo, the delivery race, and the queue MCP tools.
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxProvider } from "../server/providers/types.js"
import type { Project, QueuedMessage, Task, UiEvent } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

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
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function raw(r: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as unknown }
}
async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await raw(r, method, p, body)
  if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(res.data)}`)
  return res.data as T
}
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const queue = (r: Running, id: string) => call<QueuedMessage[]>(r, "GET", `/api/tasks/${id}/queue`)
const send = (r: Running, id: string, content: string) => call<Task>(r, "POST", `/api/tasks/${id}/messages`, { content })
const turnPrompt = (r: Running, t: Task) => (JSON.parse(fs.readFileSync(path.join(r.dataDir, "local-boxes", t.boxId!, "tasks", t.id, "turn.json"), "utf8")) as { prompt: string }).prompt

/** A project and a task whose first turn has finished. */
async function doneTask(r: Running, prompt = "write a haiku", name = "alpha") {
  const p = await call<Project>(r, "POST", "/api/projects", { name })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt })
  await waitFor(async () => (await getTask(r, t.id)).status === "done", "first turn")
  return { p, t }
}

/** Hold launches at the turn.json write (after the queue is claimed) until `release()`. */
function gateTurnStart(r: Running) {
  const provider = (r.yard.tasks as unknown as { provider: BoxProvider }).provider
  const writeFile = provider.writeFile.bind(provider)
  let open!: () => void
  const gate = new Promise<void>((res) => (open = res))
  let reached = false
  provider.writeFile = async (boxId, file, data) => {
    if (file.endsWith("/turn.json")) {
      reached = true
      await gate
    }
    return writeFile(boxId, file, data)
  }
  return { release: () => open(), reached: () => reached }
}

/** Hold the next launch before it claims the queue (at the box wake-up) until `release()`: messages stay editable. */
function gateLaunch(r: Running) {
  const provider = (r.yard.tasks as unknown as { provider: BoxProvider }).provider
  const wake = provider.wake.bind(provider)
  let open!: () => void
  const gate = new Promise<void>((res) => (open = res))
  let reached = false
  provider.wake = async (boxId) => {
    reached = true
    await gate
    return wake(boxId)
  }
  return { release: () => open(), reached: () => reached }
}

/** A finished task whose next launch is held before it takes the queue, so messages sent now wait in it. */
async function busyTask(r: Running) {
  const { p, t } = await doneTask(r)
  const gate = gateLaunch(r)
  return { p, t, gate }
}

describe("queued messages API", () => {
  it("lists queued messages in send order with sender and time, edits and deletes them, and the turn gets the result", async () => {
    const r = await start()
    const { t, gate } = await busyTask(r)
    await send(r, t.id, "first: use blue")
    await send(r, t.id, "second: add a footer")
    await send(r, t.id, "third: ship it")

    const list = await queue(r, t.id)
    expect(list.map((m) => m.text)).toEqual(["first: use blue", "second: add a footer", "third: ship it"])
    expect(list[0]).toMatchObject({ taskId: t.id, source: "cody", kind: "owner", sender: "Cody", status: "queued", version: 1 })
    expect(list[0]!.createdAt).toBeLessThanOrEqual(list[1]!.createdAt)
    expect((await getTask(r, t.id)).pendingCount).toBe(3)
    // Not in the transcript until a turn delivers them.
    expect(r.yard.store.listTaskMessages(t.id).filter((m) => m.role === "user" && /first|second|third/.test(m.content))).toEqual([])

    const edited = await call<QueuedMessage>(r, "PATCH", `/api/tasks/${t.id}/queue/${list[0]!.id}`, { text: "first: use green", version: 1 })
    expect(edited).toMatchObject({ text: "first: use green", version: 2 })
    // A stale version is refused: someone else changed it first.
    const stale = await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${list[0]!.id}`, { text: "first: use red", version: 1 })
    expect(stale.status).toBe(409)
    expect((stale.data as { error: string }).error).toMatch(/changed since you opened it/)
    // Empty text: delete it instead.
    expect((await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${list[0]!.id}`, { text: "  " })).status).toBe(400)

    // Delete and undo puts it back in its old place; delete again for good.
    await call(r, "DELETE", `/api/tasks/${t.id}/queue/${list[1]!.id}`)
    expect((await queue(r, t.id)).map((m) => m.text)).toEqual(["first: use green", "third: ship it"])
    expect((await getTask(r, t.id)).pendingCount).toBe(2)
    expect((await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${list[1]!.id}`, { text: "x" })).status).toBe(409)
    await call(r, "POST", `/api/tasks/${t.id}/queue/${list[1]!.id}/restore`)
    expect((await queue(r, t.id)).map((m) => m.text)).toEqual(["first: use green", "second: add a footer", "third: ship it"])
    await call(r, "DELETE", `/api/tasks/${t.id}/queue/${list[2]!.id}`)
    // Another task's message ids don't work here.
    const other = r.yard.store.createTask({ projectId: t.projectId, title: "Other", prompt: "other" })
    r.yard.store.updateTask(other.id, { status: "idle" })
    expect((await raw(r, "DELETE", `/api/tasks/${other.id}/queue/${list[0]!.id}`)).status).toBe(409)

    gate.release()

    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "queued turn")
    const prompt = turnPrompt(r, done)
    expect(prompt).toContain("first: use green")
    expect(prompt).toContain("second: add a footer")
    expect(prompt).not.toContain("third: ship it")
    expect(prompt).not.toContain("use blue")
    // Delivered: off the queue, and in the transcript once each, as sent.
    expect(await queue(r, t.id)).toEqual([])
    const users = r.yard.store.listTaskMessages(t.id).filter((m) => m.role === "user" && /^(first|second|third)/.test(m.content))
    expect(users.map((m) => [m.content, m.meta?.source])).toEqual([
      ["first: use green", "cody"],
      ["second: add a footer", "cody"],
    ])
    const late = await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${list[0]!.id}`, { text: "too late" })
    expect(late.status).toBe(409)
    expect((late.data as { error: string }).error).toMatch(/already delivered/)
  })

  it("cancelling the only message of a resting task doesn't run a turn for it, and Undo brings the turn back", async () => {
    const r = await start()
    const { t } = await doneTask(r)
    // Sent and cancelled in one tick: the scheduler's placement hasn't come back yet.
    const { inputId } = r.yard.tasks.send(t.id, "never mind")
    expect(r.yard.store.getTask(t.id)!.status).toBe("queued")
    r.yard.tasks.cancelQueued(t.id, inputId)
    expect(r.yard.store.getTask(t.id)).toMatchObject({ status: "done", pendingCount: 0 })
    // No turn runs for it, even though the scheduler pass had picked the task before the cancel.
    await new Promise((res) => setTimeout(res, 1500))
    expect(await getTask(r, t.id)).toMatchObject({ status: "done", pendingCount: 0, turnCount: 1 })

    await call(r, "POST", `/api/tasks/${t.id}/queue/${inputId}/restore`)
    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "restored turn")
    expect(turnPrompt(r, done)).toContain("never mind")
  })
})

describe("queued messages: the delivery race", () => {
  it("locks claimed messages while the turn starts: edits and deletes are refused, nothing is lost or delivered twice", async () => {
    const r = await start()
    const { t } = await doneTask(r)
    const gate = gateTurnStart(r)
    const events: UiEvent[] = []
    const broadcast = r.yard.hub.broadcast.bind(r.yard.hub)
    r.yard.hub.broadcast = (e) => (events.push(e), broadcast(e))

    await send(r, t.id, "please rename the file")
    await waitFor(() => gate.reached() || null, "launch claimed the queue")
    const [m] = await queue(r, t.id)
    expect(m).toMatchObject({ text: "please rename the file", status: "delivering" })

    const edit = await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${m!.id}`, { text: "rename it to notes.md", version: m!.version })
    expect(edit.status).toBe(409)
    expect((edit.data as { error: string }).error).toMatch(/already being delivered/)
    const del = await raw(r, "DELETE", `/api/tasks/${t.id}/queue/${m!.id}`)
    expect(del.status).toBe(409)
    expect((del.data as { error: string }).error).toMatch(/already being delivered/)
    // Store-level compare-and-set agrees: nothing changed.
    expect(r.yard.store.editInput(t.id, m!.id, "sneaky").ok).toBe(false)
    expect(r.yard.store.cancelInput(t.id, m!.id).ok).toBe(false)

    gate.release()
    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "turn")
    expect(turnPrompt(r, done)).toContain("please rename the file")
    expect(turnPrompt(r, done)).not.toContain("notes.md")
    const lines = r.yard.store.listTaskMessages(t.id).filter((x) => x.role === "user" && x.content === "please rename the file")
    expect(lines).toHaveLength(1)
    expect(events.filter((e) => e.type === "task.message" && e.message.content === "please rename the file")).toHaveLength(1)
    expect(await queue(r, t.id)).toEqual([])
    // Only one turn ran for it.
    expect(done.turnCount).toBe(2)
  })

  it("a launch that fails hands claimed messages back, editable, and they go out once with the retry", async () => {
    const r = await start()
    const { t } = await doneTask(r)
    const provider = (r.yard.tasks as unknown as { provider: BoxProvider }).provider
    const writeFile = provider.writeFile.bind(provider)
    let failures = 1
    provider.writeFile = async (boxId, file, data) => {
      if (file.endsWith("/turn.json") && failures-- > 0) throw new Error("box hiccup")
      return writeFile(boxId, file, data)
    }
    await send(r, t.id, "version one")
    await waitFor(async () => ((await getTask(r, t.id)).status === "failed" ? true : null), "launch failed")
    const [m] = await queue(r, t.id)
    expect(m).toMatchObject({ text: "version one", status: "queued" })
    await call(r, "PATCH", `/api/tasks/${t.id}/queue/${m!.id}`, { text: "version two" })

    await call(r, "POST", `/api/tasks/${t.id}/retry`)
    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "retried turn")
    expect(turnPrompt(r, done)).toContain("version two")
    expect(r.yard.store.listTaskMessages(t.id).filter((x) => x.role === "user" && x.content.startsWith("version"))).toMatchObject([{ content: "version two" }])
  })

  it("claims on restart are released: a message claimed by a launch that died is queued again", async () => {
    const r = await start()
    const { t } = await doneTask(r)
    const id = r.yard.store.queueInput(t.id, "cody", "after the crash")
    expect(r.yard.store.claimInputs(t.id, "turn-x")).toHaveLength(1)
    expect(r.yard.store.peekInputs(t.id)).toEqual([])
    r.yard.store.releaseInputs()
    expect(r.yard.store.peekInputs(t.id).map((i) => i.id)).toEqual([id])
    // Delivery after a release is a no-op for the old claim: nothing is delivered twice.
    expect(r.yard.store.deliverInputs("turn-x")).toEqual([])
    expect(r.yard.store.hasInputs(t.id)).toBe(true)
  })
})

describe("queue MCP tools", () => {
  type ToolRes = { content: { text: string }[]; isError?: boolean }
  async function mcpAs(r: Running, caller: McpCaller) {
    const y = r.yard
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
    const json = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await tool(name, args)
      if (res.isError) throw new Error(res.content[0]!.text)
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>
    }
    return { tool, json }
  }

  it("lets the Coordinator list, replace and cancel a task's queued messages, by the id send_to_task returns", async () => {
    const r = await start()
    const { t, gate } = await busyTask(r)
    const coord = await mcpAs(r, { kind: "coordinator" })
    const sent = await coord.json("send_to_task", { task: t.id, message: "use tabs" })
    expect(sent.queuedMessageId).toMatch(/^in_/)
    await send(r, t.id, "and a README")

    const listed = (await coord.json("list_queued_messages", { task: t.id })) as { messages: { id: string; from: string; text: string; status: string; version: number }[] }
    expect(listed.messages.map((m) => [m.from, m.text, m.status])).toEqual([
      ["Coordinator", "use tabs", "queued"],
      ["Cody", "and a README", "queued"],
    ])
    const edited = await coord.json("edit_queued_message", { task: t.id, message_id: sent.queuedMessageId, message: "use spaces", version: listed.messages[0]!.version })
    expect(edited).toMatchObject({ text: "use spaces", version: 2 })
    expect(await coord.json("cancel_queued_message", { task: t.id, message_id: listed.messages[1]!.id })).toMatchObject({ remaining: 1 })
    expect((await queue(r, t.id)).map((m) => m.text)).toEqual(["use spaces"])

    gate.release()
    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.status === "done" ? x : null
    }, "queued turn")
    expect(turnPrompt(r, done)).toContain("use spaces")
    expect(turnPrompt(r, done)).not.toContain("README")
    const again = await coord.tool("cancel_queued_message", { task: t.id, message_id: sent.queuedMessageId })
    expect(again.isError).toBe(true)
    expect(again.content[0]!.text).toMatch(/already delivered/)
  })

  it("scopes a Captain to its own project's tasks", async () => {
    const r = await start()
    const a = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const b = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const park = (projectId: string, title: string) => {
      const t = r.yard.store.createTask({ projectId, title, prompt: title })
      // Mid-turn on a made-up box, so queued messages stay queued.
      r.yard.store.updateTask(t.id, { status: "working", currentTurnId: "held" })
      return t
    }
    const ta = park(a.id, "Alpha work")
    const tb = park(b.id, "Beta work")
    const mine = r.yard.tasks.send(ta.id, "alpha note", "orchestrator").inputId
    const theirs = r.yard.tasks.send(tb.id, "beta note", "orchestrator").inputId

    const captain = await mcpAs(r, { kind: "captain", projectId: a.id })
    const listed = (await captain.json("list_queued_messages", { task: ta.id })) as { messages: { id: string }[] }
    expect(listed.messages.map((m) => m.id)).toEqual([mine])
    for (const [name, args] of [
      ["list_queued_messages", { task: tb.id }],
      ["cancel_queued_message", { task: tb.id, message_id: theirs }],
      ["edit_queued_message", { task: tb.id, message_id: theirs, message: "hijack" }],
    ] as const) {
      const res = await captain.tool(name, args)
      expect(res.isError, name).toBe(true)
      expect(res.content[0]!.text, name).toMatch(/Out of scope/)
    }
    // A message id from another project's task, passed with its own task, matches nothing.
    const cross = await captain.tool("cancel_queued_message", { task: ta.id, message_id: theirs })
    expect(cross.isError).toBe(true)
    expect(r.yard.tasks.listQueue(tb.id).map((m) => m.text)).toEqual(["beta note"])

    // The Captain's own messages are labelled as from it.
    const own = r.yard.tasks.send(ta.id, "from the captain", `captain:${a.id}`).inputId
    expect(r.yard.tasks.listQueue(ta.id).find((m) => m.id === own)).toMatchObject({ kind: "captain", sender: "alpha Captain" })
    expect(await captain.json("cancel_queued_message", { task: ta.id, message_id: own })).toMatchObject({ remaining: 1 })
  })
})
