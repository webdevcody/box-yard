import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { turnTiming } from "../server/turnTimings.js"
import { TURN_TIMINGS_WINDOW_MS, type TurnClockReading, type TurnTiming } from "../shared/turnTimings.js"
import type { CaptainMessage, ChatMessage, Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Per-turn timings: every Coordinator, Captain and task turn leaves a turn_timings row, its id on the reply.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  closers: (() => Promise<void>)[]
}
const running: Running[] = []

async function start(orchestratorAutoWake = false): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}`, closers: [] }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const close of r.closers) await close()
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

/** An MCP caller's tools, called directly. `statusOnly`: the projects whose identity shows the Coordinator status only. */
async function tools(r: Running, caller: McpCaller = { kind: "coordinator" }, statusOnly: string[] = []) {
  const server = buildMcpServer(
    {
      store: r.yard.store,
      tasks: r.yard.tasks,
      hub: r.yard.hub,
      artifacts: null as never,
      publicUrl: () => "",
      scheduler: r.yard.scheduler,
      captains: r.yard.captains,
      settings: r.yard.settings,
      uploads: null as never,
      identities: statusOnly.length ? ({ statusOnly: (id: string) => statusOnly.includes(id) } as never) : undefined,
    },
    caller,
  )
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  r.closers.push(async () => {
    await client.close()
    await server.close()
  })
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (res.isError) throw new Error(res.content[0]?.text)
    return JSON.parse(res.content[0]!.text)
  }
}

const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)

describe("turn timings", () => {
  it("times a Coordinator → Captain round trip, stage by stage, and links each reply to its row", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "tell captain demo: status" })
    await coordinatorIdle(r)
    await captainIdle(r, p)

    const reply = await waitFor(() => r.yard.store.listChat(100).find((m: ChatMessage) => m.role === "assistant" && m.meta?.timingId), "the Coordinator's reply with its timing")
    const coord = await call<TurnTiming>(r, "GET", `/api/turn-timings/${reply.meta!.timingId}`)
    expect(reply.meta!.timingMs).toBe(coord.totalMs)
    expect(coord).toMatchObject({ role: "coordinator", kind: "turn", trigger: "cody", ok: true, mcpStatus: "boxyard: connected" })
    // Cody's message waited for nothing: asked for → spawn is the server's own few ms.
    expect(coord.queueMs).toBeGreaterThanOrEqual(0)
    expect(coord.queueMs).toBeLessThan(5_000)
    expect(coord.startupMs).toBeGreaterThan(0)
    // fake-claude connects to /mcp before its init line: the server saw the handshake.
    expect(coord.processMs).toBeGreaterThan(0)
    expect(coord.mcpMs).toBeGreaterThanOrEqual(0)
    expect(coord.processMs! + coord.mcpMs!).toBeLessThanOrEqual(coord.startupMs! + 5)
    expect(coord.totalMs).toBeGreaterThanOrEqual(coord.wallMs)
    expect(coord.steps.some((s) => s.k === "tool" && s.name === "send_to_captain")).toBe(true)

    const captainReply = await waitFor(
      async () => (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "assistant" && m.meta?.timingId),
      "the Captain's reply with its timing",
    )
    const cap = await call<TurnTiming>(r, "GET", `/api/turn-timings/${captainReply.meta!.timingId}`)
    expect(cap).toMatchObject({ role: "captain", projectId: p.id, trigger: "coordinator", ok: true })
    expect(cap.queueMs).toBeGreaterThanOrEqual(0)
    expect(cap.processMs).toBeGreaterThan(0)

    // The API's report and the MCP tool's agree on the roles.
    const report = await call<{ summary: { turns: number; byRole: Record<string, { turns: number }> } }>(r, "GET", "/api/turn-timings?days=1")
    expect(report.summary.byRole.coordinator!.turns).toBeGreaterThanOrEqual(1)
    expect(report.summary.byRole.captain!.turns).toBeGreaterThanOrEqual(1)
    const coordinator = await tools(r)
    const all = await coordinator("turn_timings", { days: 1 })
    expect(Object.keys(all.by_role).sort()).toEqual(["captain", "coordinator"])
    expect(all.by_role.coordinator["Start-up"]).toMatch(/^p50 .* · p95 .* \(n \d+\)$/)
    expect(all.recent.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([coord.id, cap.id]))
    await expect(call(r, "GET", "/api/turn-timings/tim_nope")).rejects.toThrow(/404/)
    await expect(call(r, "GET", "/api/turn-timings?role=boss")).rejects.toThrow(/400/)
  }, 60_000)

  it("times a task turn from its launch, with the box's setup and the runner's MCP handshake", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "work" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    const event = await waitFor(
      async () => (await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)).find((m) => m.role === "event" && m.content.startsWith("Turn 1 finished") && m.meta?.timingId),
      "the turn's finished line with its timing",
      30_000,
    )
    const timing = await call<TurnTiming>(r, "GET", `/api/turn-timings/${event.meta!.timingId}`)
    expect(event.meta!.timingMs).toBe(timing.totalMs)
    expect(timing).toMatchObject({ role: "task", kind: "turn", projectId: p.id, taskId: t.id, ok: true })
    expect(timing.setupMs).toBeGreaterThanOrEqual(0)
    expect(timing.queueMs).toBeGreaterThanOrEqual(0)
    expect(timing.startupMs).toBeGreaterThan(0)
    // The runner's stdio MCP server wrote down its handshake for the turn to read.
    expect(timing.processMs).toBeGreaterThan(0)
    expect(timing.mcpMs).toBeGreaterThanOrEqual(0)
    expect(timing.totalMs).toBeGreaterThanOrEqual(timing.wallMs)
    expect(timing.modelCalls).toBeGreaterThanOrEqual(1)
    const own = await call<{ recent: { id: string }[] }>(r, "GET", `/api/turn-timings?role=task&taskId=${t.id}`)
    expect(own.recent.map((x) => x.id)).toEqual([timing.id])
  }, 60_000)

  it("keeps a Captain to its own project's turns, and a status-only project's turns out of the Coordinator's lists", async () => {
    const r = await start()
    const a = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const b = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const reading = fakeReading(Date.now() - 60_000)
    const row = (id: string, role: TurnTiming["role"], projectId: string | null) => turnTiming(reading, { id, role, kind: "turn", projectId, sessionId: null, model: null, effort: null, resumed: false })
    r.yard.store.recordTurnTiming(row("tim_coord", "coordinator", null))
    r.yard.store.recordTurnTiming(row("tim_alpha", "captain", a.id))
    r.yard.store.recordTurnTiming(row("tim_beta", "captain", b.id))

    const alpha = await tools(r, { kind: "captain", projectId: a.id })
    const mine = await alpha("turn_timings")
    expect(mine.recent.map((x: { id: string }) => x.id)).toEqual(["tim_alpha"])
    await expect(alpha("turn_timings", { project: "beta" })).rejects.toThrow(/Out of scope/)
    await expect(alpha("turn_timings", { role: "coordinator" })).rejects.toThrow(/Out of scope/)

    const coordinator = await tools(r, { kind: "coordinator" }, [b.id])
    const seen = await coordinator("turn_timings")
    expect(seen.turns).toBe(3)
    expect(seen.recent.map((x: { id: string }) => x.id).sort()).toEqual(["tim_alpha", "tim_coord"])
    expect(seen.status_only_turns).toBe(1)
    expect(seen.slowest_tools).toEqual([expect.stringMatching(/^Read: .* in 2 calls/)])
  })
})

describe("turn_timings retention", () => {
  it("drops rows older than the window", () => {
    const store = new Store(openDb(tmpDir(), ":memory:"))
    const now = Date.now()
    const row = (id: string, endedAt: number) => turnTiming({ ...fakeReading(endedAt - 1000), endedAt }, { id, role: "task", kind: "turn", sessionId: null, model: null, effort: null, resumed: false })
    store.recordTurnTiming(row("tim_old", now - TURN_TIMINGS_WINDOW_MS - 60_000))
    store.recordTurnTiming(row("tim_new", now))
    expect(store.getTurnTiming("tim_old")).toBeNull()
    expect(store.getTurnTiming("tim_new")).toMatchObject({ id: "tim_new", role: "task", steps: [{ k: "model" }, { k: "tool", name: "Read" }] })
    expect(store.listTurnTimings({ since: 0 }).map((t) => t.id)).toEqual(["tim_new"])
  })
})

function fakeReading(startedAt: number): TurnClockReading {
  return {
    startedAt,
    endedAt: startedAt + 3000,
    startupMs: 300,
    mcpStatus: null,
    firstTokenMs: 900,
    modelMs: 1500,
    toolMs: 400,
    modelCalls: 1,
    toolCalls: 1,
    tailMs: 100,
    wallMs: 3000,
    cliMs: 2600,
    apiMs: 1400,
    numTurns: 1,
    inputTokens: 10,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 100,
    contextTokens: 1160,
    ok: true,
    steps: [
      { k: "model", at: 300, ms: 1500 },
      { k: "tool", name: "Read", at: 1800, ms: 400 },
    ],
    stepsDropped: 0,
  }
}
