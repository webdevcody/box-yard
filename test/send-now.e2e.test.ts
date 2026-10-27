// "Send now" for a task's queued messages: POST /api/tasks/:id/queue/send-now, deliver_queued_now and
// send_to_task interrupt. The current turn is stopped like Stop, and one new turn resumes the session with every
// queued message in order; a turn that ends on its own meanwhile isn't hit, and a merge in progress is guarded.
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
import type { Project, SendNowDelivery, Task } from "../shared/types.js"
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
    // Stop hanging turns so the database isn't closed under them.
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTasks().every((t) => !["starting", "working"].includes(t.status)), "agents idle", 30_000).catch(() => {})
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
type SendNow = { task: Task; delivery: SendNowDelivery; queued: number }
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const send = (r: Running, id: string, content: string) => call<Task>(r, "POST", `/api/tasks/${id}/messages`, { content })
const sendNow = (r: Running, id: string, body: Record<string, unknown> = {}) => raw(r, "POST", `/api/tasks/${id}/queue/send-now`, body)
const turnJson = (r: Running, t: Task) =>
  JSON.parse(fs.readFileSync(path.join(r.dataDir, "local-boxes", t.boxId!, "tasks", t.id, "turn.json"), "utf8")) as { turnId: string; prompt: string; sessionId: string; resume: boolean }
const turns = (r: Running, taskId: string) =>
  r.yard.store.db.prepare("SELECT status FROM task_turns WHERE task_id = ? ORDER BY turn_index, started_at").all(taskId) as { status: string }[]
const resting = (t: Task) => !["queued", "starting", "working"].includes(t.status)

/** A task whose first turn has finished, then a second turn that hangs (until stopped) with `queuedAfter` queued behind it. */
async function hangingTask(r: Running, ...queuedAfter: string[]) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
  await waitFor(async () => (await getTask(r, t.id)).status === "done", "first turn")
  await send(r, t.id, "now polish it [hang]")
  await waitFor(async () => {
    const x = await getTask(r, t.id)
    return x.status === "working" && x.turnCount === 2
  }, "second turn hangs")
  const hung = await getTask(r, t.id)
  const before = turnJson(r, hung)
  for (const m of queuedAfter) await send(r, t.id, m)
  return { p, t: hung, before }
}

/** The task has run turn `n` to its end (resting again). */
const ranTurn = (r: Running, id: string, n: number) =>
  waitFor(async () => {
    const x = await getTask(r, id)
    return x.turnCount >= n && resting(x) && !x.pendingCount ? x : null
  }, `turn ${n} done`, 30_000)

describe("Send now", () => {
  it("stops the running turn and delivers every queued message in order in one new turn, in the same session", async () => {
    const r = await start()
    const { t, before } = await hangingTask(r, "first: use blue", "second: add a footer", "third: ship it")
    expect((await getTask(r, t.id)).pendingCount).toBe(3)

    const res = await sendNow(r, t.id)
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ delivery: "interrupted", queued: 3 })
    const done = await ranTurn(r, t.id, 3)
    expect(done.turnCount).toBe(3)

    const next = turnJson(r, done)
    expect(next.turnId).not.toBe(before.turnId)
    // The same Claude session, resumed.
    expect(next.resume).toBe(true)
    expect(next.sessionId).toBe(before.sessionId)
    const at = (s: string) => next.prompt.indexOf(s)
    expect(at("first: use blue")).toBeGreaterThan(-1)
    expect(at("first: use blue")).toBeLessThan(at("second: add a footer"))
    expect(at("second: add a footer")).toBeLessThan(at("third: ship it"))
    // The hanging turn was stopped; exactly one new turn carried the queue.
    expect(turns(r, t.id).map((x) => x.status)).toEqual(["done", "stopped", "done"])
    const events = r.yard.store.listTaskMessages(t.id, 200).filter((m) => m.role === "event").map((m) => m.content)
    expect(events.some((e) => /^Cody sent all 3 queued messages now: stopping the current step/.test(e))).toBe(true)
    // It isn't a Stop by Cody: the queue stays and nothing says so.
    expect(events.some((e) => /Stopped by Cody/.test(e))).toBe(false)
    expect(r.yard.store.listTaskMessages(t.id, 200).filter((m) => m.role === "user").map((m) => m.content).slice(-3)).toEqual(["first: use blue", "second: add a footer", "third: ship it"])
  }, 60_000)

  it("on a task with no running turn, behaves like a normal send", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await waitFor(async () => (await getTask(r, t.id)).status === "done", "first turn")
    // Nothing queued: nothing to do.
    expect((await sendNow(r, t.id)).data).toMatchObject({ delivery: "already_delivered", queued: 0 })

    // Queued behind a launch that is waiting (no turn runs yet): it just goes out with that turn.
    const provider = (r.yard.tasks as unknown as { provider: BoxProvider }).provider
    const wake = provider.wake.bind(provider)
    let open!: () => void
    const gate = new Promise<void>((res) => (open = res))
    provider.wake = async (boxId) => (await gate, wake(boxId))
    await send(r, t.id, "add a title")
    const res = await sendNow(r, t.id)
    expect(res.data).toMatchObject({ delivery: "next_turn", queued: 1 })
    open()
    const done = await ranTurn(r, t.id, 2)
    expect(done.turnCount).toBe(2)
    expect(turns(r, t.id).map((x) => x.status)).toEqual(["done", "done"])
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => m.meta?.kind === "send_now")).toBe(false)
  }, 60_000)

  it("doesn't stop the next turn when the current one ends on its own as Send now is pressed", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku [slow]" })
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "first turn running")
    await send(r, t.id, "then add a title [slow]")
    // [slow]: the next turn is still running when the held kill goes out, so an unguarded kill would stop it.
    const firstTurn = turnJson(r, await getTask(r, t.id)).turnId

    // Hold the stop until the first turn has ended by itself and the next one (with the queue) is running.
    const provider = (r.yard.tasks as unknown as { provider: BoxProvider }).provider
    const exec = provider.exec.bind(provider)
    let killed: string | null = null
    provider.exec = async (boxId, cmd, ...rest) => {
      // The stop itself (server/turnProcess.ts turnKillScript), not the liveness probe before it.
      if (killed === null && /by_turn_kill '[^']*' TERM; true$/m.test(cmd)) {
        killed = cmd
        await waitFor(async () => {
          const x = await getTask(r, t.id)
          return x.turnCount === 2 && x.status === "working"
        }, "the next turn starts", 30_000)
      }
      return exec(boxId, cmd, ...rest)
    }
    const res = await sendNow(r, t.id)
    expect(res.data).toMatchObject({ delivery: "interrupted", queued: 1 })

    const done = await ranTurn(r, t.id, 2)
    // Both turns finished on their own: one new turn, not stopped by the late kill, and no third.
    expect(turns(r, t.id).map((x) => x.status)).toEqual(["done", "done"])
    expect(done.turnCount).toBe(2)
    expect(turnJson(r, done).prompt).toContain("then add a title")
    // The stop only targets the turn it was meant for.
    expect(killed).toContain(`"turnId":"${firstTurn}"`)
  }, 60_000)

  it("won't interrupt a merge in progress unless asked to", async () => {
    const r = await start()
    const { t } = await hangingTask(r, "also bump the version")
    const PR = "https://github.com/acme/shop/pull/12"
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })
    r.yard.store.updateTask(t.id, { mergeRequest: { prNumber: 12, prUrl: PR, requestedAt: Date.now(), deliveredAt: Date.now(), inputId: "in_gone01", requestedBy: null } })
    expect((await getTask(r, t.id)).mergeRequest).toMatchObject({ prNumber: 12 })

    const refused = await sendNow(r, t.id)
    expect(refused.status).toBe(409)
    expect((refused.data as { error: string }).error).toMatch(/merging PR #12 .*stop the merge midway/)
    // Nothing changed: the turn still runs and the message is still queued.
    expect(await getTask(r, t.id)).toMatchObject({ status: "working", pendingCount: 1 })

    const forced = await sendNow(r, t.id, { allowMergeInterrupt: true })
    expect(forced.status).toBe(200)
    expect(forced.data).toMatchObject({ delivery: "interrupted" })
    const done = await ranTurn(r, t.id, 3)
    expect(turnJson(r, done).prompt).toContain("also bump the version")
  }, 60_000)
})

describe("Send now over MCP", () => {
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
    return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  }

  it("send_to_task interrupt: true stops the current turn and delivers the queue with the new message", async () => {
    const r = await start()
    const { t, before } = await hangingTask(r, "from Cody: keep it short")
    const tool = await mcpAs(r, { kind: "coordinator" })
    const res = await tool("send_to_task", { task: t.id, message: "from the Coordinator: stop and rename it", interrupt: true })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text).delivery).toMatch(/^interrupting: .*all 2 queued messages, in order/)

    const done = await ranTurn(r, t.id, 3)
    const next = turnJson(r, done)
    expect(next.sessionId).toBe(before.sessionId)
    expect(next.prompt.indexOf("keep it short")).toBeLessThan(next.prompt.indexOf("stop and rename it"))
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => /^The Coordinator sent all 2 queued messages now/.test(m.content))).toBe(true)
  }, 60_000)

  it("deliver_queued_now is Captain-scoped and refuses a merge in progress without allow_merge_interrupt", async () => {
    const r = await start()
    const { p, t } = await hangingTask(r, "rename the file")
    const PR = "https://github.com/acme/shop/pull/7"
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open", mergeRequest: { prNumber: 7, prUrl: PR, requestedAt: Date.now(), deliveredAt: Date.now(), inputId: "in_gone02", requestedBy: null } })

    const other = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const outsider = await mcpAs(r, { kind: "captain", projectId: other.id })
    const scoped = await outsider("deliver_queued_now", { task: t.id })
    expect(scoped.isError).toBe(true)
    expect(scoped.content[0]!.text).toMatch(/Out of scope/)

    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    // send_to_task interrupt refuses before sending anything.
    const viaSend = await captain("send_to_task", { task: t.id, message: "and the README", interrupt: true })
    expect(viaSend.isError).toBe(true)
    expect(viaSend.content[0]!.text).toMatch(/merging PR #7.*Nothing was sent/)
    expect((await getTask(r, t.id)).pendingCount).toBe(1)

    const refused = await captain("deliver_queued_now", { task: t.id })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/merging PR #7/)
    expect((await getTask(r, t.id)).status).toBe("working")

    const forced = await captain("deliver_queued_now", { task: t.id, allow_merge_interrupt: true })
    expect(forced.isError).toBeFalsy()
    expect(JSON.parse(forced.content[0]!.text)).toMatchObject({ queuedMessages: 1 })
    const done = await ranTurn(r, t.id, 3)
    expect(turnJson(r, done).prompt).toContain("rename the file")
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => /^The project's Captain sent the queued message now/.test(m.content))).toBe(true)
  }, 60_000)
})
