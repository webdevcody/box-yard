import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import type { WorkerEvent } from "../server/bus.js"
import { AGENT_CAPTAIN_LIMIT, AGENT_CAPTAIN_WAIT_MAX_SECONDS, AGENT_CAPTAIN_WINDOW_MS } from "../shared/captain.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Agents message their project's Captain mid-turn with message_captain (fire-and-forget or a short wait).

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(prepare?: (yard: BoxYard) => void): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
  prepare?.(yard)
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}` }
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

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }

/** An in-process MCP client as the Coordinator or one project's Captain. */
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, uploads: null as never }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return { client, tool: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes }
}

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, p: Project, title: string, prompt: string) => call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title, prompt })
const fromAgents = (r: Running, p: Project) => r.yard.store.listCaptainMessages(p.id, 500).filter((m) => m.role === "user" && m.meta?.source === "agent")
const messages = (r: Running, t: Task): TaskMessage[] => r.yard.store.listTaskMessages(t.id, 500)
const replyText = (r: Running, t: Task) =>
  messages(r, t)
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n")
const getTask = (r: Running, t: Task) => r.yard.store.getTask(t.id)!
const settled = (r: Running, t: Task, turns = 1) =>
  waitFor(() => {
    const now = getTask(r, t)
    return now.turnCount >= turns && !["queued", "starting", "working"].includes(now.status) && !now.pendingCount ? now : null
  }, `${t.title} to finish ${turns} turn(s)`, 45_000)
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)

/** Every prompt the project's fake Captain session got (scripts/fake-claude.mjs keeps them in its session file). */
function captainPrompts(r: Running, p: Project): string[] {
  const id = r.yard.store.getKv(`captain_session:${p.id}`)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

let seq = 1_000_000
/** A worker event as the runner would write it, applied straight to the task (no turn). */
const event = (t: string, fields: Record<string, unknown>): WorkerEvent => ({ seq: seq++, ts: Date.now(), turnId: null, t, ...fields })

describe("message_captain (agent → its project's Captain, mid-turn)", () => {
  it("fire-and-forget: the Captain gets a labelled message and the agent's turn goes on", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = await task(r, p, "Login form", "Fix the login form\nmessage captain: The signup page crashes too, outside my brief")

    const [msg] = await waitFor(() => (fromAgents(r, p).length ? fromAgents(r, p) : null), "the agent's message on the Captain", 30_000)
    expect(msg!.content).toBe("The signup page crashes too, outside my brief")
    expect(msg!.meta).toMatchObject({ source: "agent", tool: "message_captain", taskId: t.id, taskTitle: "Login form", waitSeconds: 0 })

    const done = await settled(r, t)
    expect(done.status).toBe("done")
    expect(replyText(r, t)).toContain("message_captain: Sent to your project's Captain. Keep working")
    // The task transcript shows where it went.
    expect(messages(r, t).find((m) => m.role === "agent" && m.meta?.to === "captain")?.content).toBe("→ demo Captain: The signup page crashes too, outside my brief")

    // The Captain's prompt labels it with the task and says it isn't waiting.
    await captainIdle(r, p)
    const prompt = await waitFor(() => captainPrompts(r, p).find((x) => x.includes("signup page crashes")), "the Captain's turn")
    expect(prompt).toContain(`[From task "Login form" (${t.id}), an agent in this project, via message_captain. Not a message from Cody. It kept working.`)
    expect(prompt).toContain(`reply_to_agent (task ${t.id})`)
    // It doesn't answer, so nothing comes back to the agent.
    await new Promise((res) => setTimeout(res, 500))
    expect(getTask(r, t).turnCount).toBe(1)
  }, 60_000)

  it("wait: the Captain's reply_to_agent ends the wait and lands in the same turn, not again next turn", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = await task(r, p, "Scope check", "Start the work\nmessage captain wait 50: Is the admin page in scope? [reply]")

    const done = await settled(r, t)
    expect(replyText(r, t)).toContain("message_captain: The Captain replied:\n\nCaptain reply: go ahead, that's in scope.")
    const [msg] = fromAgents(r, p)
    expect(msg!.meta).toMatchObject({ waitSeconds: 50, taskId: t.id })
    expect(messages(r, t).some((m) => m.meta?.kind === "captain_reply")).toBe(true)

    // The Captain was told the agent waits.
    await captainIdle(r, p)
    expect(captainPrompts(r, p).find((x) => x.includes("admin page"))).toContain("It is waiting up to 50 s for your answer mid-turn")
    // The reply was taken mid-turn, so its queued copy is gone and no second turn runs for it.
    await new Promise((res) => setTimeout(res, 800))
    expect(getTask(r, t)).toMatchObject({ turnCount: done.turnCount, pendingCount: 0, status: "done" })
  }, 60_000)

  it("wait: a send_to_task from the Captain reaches the waiting agent too", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = await task(r, p, "Conflict check", "Start the work\nmessage captain wait: This conflicts with the other branch [reply-task]")

    await settled(r, t)
    expect(replyText(r, t)).toContain("message_captain: The Captain replied:\n\nCaptain reply via send_to_task: go ahead.")
    await captainIdle(r, p)
    await new Promise((res) => setTimeout(res, 800))
    expect(getTask(r, t)).toMatchObject({ turnCount: 1, pendingCount: 0 })
  }, 60_000)

  it("wait: times out, says so, and the late reply arrives as the agent's next message", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = await task(r, p, "Slow answer", "Start the work\nmessage captain wait 5: Which API version? [slow:9] [reply]")

    const t0 = Date.now()
    await waitFor(() => (replyText(r, t).includes("message_captain:") ? true : null), "the first turn's reply", 30_000)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(replyText(r, t)).toContain("message_captain: No reply within 5 s. The Captain still has your message")

    // The Captain answers after the wait ran out: it's queued and resumes the agent.
    const second = await settled(r, t, 2)
    expect(second.turnCount).toBe(2)
    const reply = messages(r, t).find((m) => m.role === "user" && m.meta?.source === "captain")
    expect(reply?.content).toBe("Captain reply: go ahead, that's in scope.")
    expect(messages(r, t).some((m) => m.meta?.kind === "captain_reply")).toBe(false)
    await captainIdle(r, p)
  }, 60_000)

  it("wait: a Captain turn that doesn't reply ends the wait early instead of running out the clock", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = await task(r, p, "FYI", "Start the work\nmessage captain wait 55: Heads up, the CI config is stale")

    const t0 = Date.now()
    await settled(r, t)
    expect(Date.now() - t0).toBeLessThan(40_000)
    expect(replyText(r, t)).toContain("message_captain: The Captain read your message and ended its turn without replying to you")
    await captainIdle(r, p)
  }, 60_000)

  it("goes only to the agent's own project's Captain; another Captain can't reply to it", async () => {
    const r = await start()
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const t = await task(r, a, "Alpha work", "Start\nmessage captain: Question for my Captain")
    await settled(r, t)
    await waitFor(() => fromAgents(r, a)[0], "alpha's Captain got it")
    expect(fromAgents(r, b)).toHaveLength(0)
    expect(r.yard.store.listCaptainMessages(b.id, 100)).toHaveLength(0)

    const beta = await mcpAs(r, { kind: "captain", projectId: b.id })
    const res = await beta.tool("reply_to_agent", { task: t.id, message: "hi" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/Out of scope/)

    const alpha = await mcpAs(r, { kind: "captain", projectId: a.id })
    const ok = await alpha.tool("reply_to_agent", { task: t.id, message: "Noted, thanks." })
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(ok.content[0]!.text).delivery).toMatch(/^resuming/)

    // Only Captains get reply_to_agent.
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator.client.listTools()).tools.map((x) => x.name)).not.toContain("reply_to_agent")
    expect((await alpha.client.listTools()).tools.map((x) => x.name)).toContain("reply_to_agent")
    await settled(r, t, 2)
    await captainIdle(r, a)
  }, 60_000)

  it(`rate-limits each task to ${AGENT_CAPTAIN_LIMIT} messages per 10 minutes, with a clear error`, async () => {
    const r = await start()
    const p = await project(r, "demo")
    const lines = Array.from({ length: AGENT_CAPTAIN_LIMIT + 1 }, (_, i) => `message captain: note ${i + 1}`)
    const t = await task(r, p, "Chatty", `Start\n${lines.join("\n")}`)

    await settled(r, t)
    const text = replyText(r, t)
    expect(text.match(/Sent to your project's Captain/g)).toHaveLength(AGENT_CAPTAIN_LIMIT)
    expect(text).toContain(`message_captain: Not sent: you already sent the Captain ${AGENT_CAPTAIN_LIMIT} messages in the last 10 minutes (the limit).`)
    await waitFor(() => (fromAgents(r, p).length === AGENT_CAPTAIN_LIMIT ? true : null), "the allowed messages on the Captain")
    await captainIdle(r, p)
    expect(fromAgents(r, p)).toHaveLength(AGENT_CAPTAIN_LIMIT)
  }, 60_000)

  it("the server enforces the limit too, and tells the agent", async () => {
    const r = await start()
    const p = await project(r, "demo")
    const t = r.yard.store.createTask({ projectId: p.id, title: "Direct", prompt: "x" })
    r.yard.store.updateTask(t.id, { status: "idle" })
    for (let i = 0; i <= AGENT_CAPTAIN_LIMIT; i++) await r.yard.tasks.apply(t.id, event("message_captain", { id: `cmsg_direct${i}`, message: `msg ${i}`, wait: 0 }))

    expect(fromAgents(r, p)).toHaveLength(AGENT_CAPTAIN_LIMIT)
    const blocked = messages(r, t).filter((m) => m.meta?.blocked)
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.content).toMatch(/not delivered: you already sent the Captain 5 messages in the last 10 minutes/)
    expect(r.yard.store.peekInputs(t.id).some((i) => i.source === "system" && /message_captain was not delivered/.test(i.content))).toBe(true)
    r.yard.store.clearInputs(t.id)
    r.yard.store.updateTask(t.id, { status: "idle" })
    await captainIdle(r, p)
  }, 60_000)

  it("runs agent messages through the Captain's loop guard without resetting it", async () => {
    const r = await start((yard) => {
      yard.captains.tuning.loopGuard = { maxRepeats: 1, windowMs: 60 * 60_000, throttleMs: 60 * 60_000, maxThrottleMs: 60 * 60_000 }
    })
    const p = await project(r, "demo")
    const t = r.yard.store.createTask({ projectId: p.id, title: "Looper", prompt: "x" })
    r.yard.store.updateTask(t.id, { status: "idle" })

    await r.yard.tasks.apply(t.id, event("message_captain", { id: "cmsg_loop1", message: "Same thing again", wait: 0 }))
    await captainIdle(r, p)
    const turns = captainPrompts(r, p).length
    expect(turns).toBe(1)
    await r.yard.tasks.apply(t.id, event("message_captain", { id: "cmsg_loop2", message: "Same thing again", wait: 0 }))

    // Kept, labelled as held, and no Captain turn for it.
    const held = fromAgents(r, p)
    expect(held).toHaveLength(2)
    expect(typeof held[1]!.meta?.heldUntil).toBe("number")
    expect(r.yard.captains.state(p.id).throttledUntil).toBe(held[1]!.meta?.heldUntil)
    await new Promise((res) => setTimeout(res, 800))
    expect(captainPrompts(r, p)).toHaveLength(turns)
    expect(messages(r, t).find((m) => m.meta?.agentMessageId === "cmsg_loop2")?.meta?.heldUntil).toBe(held[1]!.meta?.heldUntil)
    // The Coordinator hears about the loop once.
    expect(r.yard.store.listChat(100).filter((m) => m.meta?.captain && /keeps sending me the same message/.test(m.content))).toHaveLength(1)
    // A new message is new information: it lifts the throttle, and the held one is read in the same turn.
    await r.yard.tasks.apply(t.id, event("message_captain", { id: "cmsg_loop3", message: "Something new", wait: 0 }))
    await waitFor(() => (captainPrompts(r, p).length > turns ? true : null), "the Captain's next turn")
    await captainIdle(r, p)
    const last = captainPrompts(r, p).at(-1)!
    expect(last).toContain("Same thing again")
    expect(last).toContain("Something new")
    expect(last).toContain("Your loop guard held it back")
  }, 60_000)

  it("keeps the runner's limits in step with the server's", () => {
    const runner = fs.readFileSync(path.join(import.meta.dirname, "../runner/box-runner.mjs"), "utf8")
    expect(runner).toContain(`const CAPTAIN_MSG_LIMIT = ${AGENT_CAPTAIN_LIMIT}\n`)
    expect(runner).toContain(`const CAPTAIN_MSG_WINDOW_MS = ${AGENT_CAPTAIN_WINDOW_MS / 60_000} * 60_000\n`)
    expect(runner).toContain(`const CAPTAIN_WAIT_MAX_SECONDS = ${AGENT_CAPTAIN_WAIT_MAX_SECONDS}\n`)
  })
})
