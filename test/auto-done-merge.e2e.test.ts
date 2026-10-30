import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, SettingsInfo, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Settings › Coordinator › Done when its PR merges (autoDoneOnMerge) and the Cards view's Mark done, over real HTTP
// with fake-claude for the turns and a fake GitHub: a resting task whose PR merges moves to done (or stays idle with
// the setting off), turning it on catches up the ones that merged while it was off, and Mark done is close_task's close.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  /** What the fake GitHub answers for every PR it's asked about. */
  gh: { merged: boolean }
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const gh = { merged: false }
  const fetch = (async () => {
    const pr = gh.merged
      ? { state: "MERGED", isDraft: false, mergedAt: "2026-10-30T09:00:00Z", mergedBy: { login: "webdevcody" }, headRefOid: "a".repeat(40), labels: { nodes: [] } }
      : { state: "OPEN", isDraft: false, mergedAt: null, mergedBy: null, headRefOid: "a".repeat(40), labels: { nodes: [] } }
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
    for (let i = 0; i < 10; i++) data[`p${i}`] = { pullRequest: pr }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch, token: () => "test-token" } })
  yard.captains.tuning.wakeDebounceMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh }
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
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

/** The task once it rests after `turns` turns. */
const rested = (r: Running, id: string, turns: number) =>
  waitFor(() => {
    const row = r.yard.store.getTaskRow(id)
    return row && row.turn_count >= turns && !row.current_turn_id && ["idle", "pr_ready", "done", "needs_input", "failed"].includes(row.status) ? r.yard.store.getTask(id) : null
  }, `task ${id} to rest after turn ${turns}`, 30_000)

let n = 0
/** A task that ran one turn and rests with `status` and an open PR, as Box Yard last saw it. */
async function prTask(r: Running, status: Task["status"] = "pr_ready"): Promise<Task> {
  const project = await call<Project>(r, "POST", "/api/projects", { name: `site${++n}` })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Night shift", prompt: "Fix the lights. [pr]" })
  await rested(r, t.id, 1)
  r.yard.store.updateTask(t.id, { status, prUrl: `https://github.com/acme/site/pull/${70 + n}`, prState: "open", prHeadSha: "0".repeat(40) }, { quiet: true })
  return r.yard.store.getTask(t.id)!
}

const events = (r: Running, id: string) => r.yard.store.listTaskMessages(id).filter((m) => m.role === "event").map((m) => m.content)

describe("Done when its PR merges", () => {
  it("is on by default, next to Idle after 3 hours", async () => {
    const r = await start()
    const info = await call<SettingsInfo>(r, "GET", "/api/agent-settings")
    expect(info.settings).toMatchObject({ autoDoneOnMerge: true, cardsIdleHours: 3 })
    expect(info.defaults).toMatchObject({ autoDoneOnMerge: true, cardsIdleHours: 3 })
    await expect(call(r, "PUT", "/api/agent-settings", { cardsIdleHours: -1 })).rejects.toThrow(/400/)
    expect((await call<SettingsInfo>(r, "PUT", "/api/agent-settings", { cardsIdleHours: 0.5 })).settings.cardsIdleHours).toBe(0.5)
  })

  it("a turn that ends with its PR merged ends done, or idle with the setting off", async () => {
    const r = await start()
    const on = await prTask(r)
    r.gh.merged = true
    r.yard.tasks.sendInput(on.id, "Anything left? [pr]", "cody")
    expect(await rested(r, on.id, 2)).toMatchObject({ status: "done", prState: "merged" })

    await call(r, "PUT", "/api/agent-settings", { autoDoneOnMerge: false })
    r.gh.merged = false
    const off = await prTask(r)
    r.gh.merged = true
    r.yard.tasks.sendInput(off.id, "Anything left? [pr]", "cody")
    expect(await rested(r, off.id, 2)).toMatchObject({ status: "idle", prState: "merged" })
  }, 90_000)

  it("off, a merge leaves resting tasks idle; turned on, those move to done and the rest stay", async () => {
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { autoDoneOnMerge: false })
    const ready = await prTask(r, "pr_ready")
    const idle = await prTask(r, "idle")
    const asking = await prTask(r, "needs_input")
    const failed = await prTask(r, "failed")
    r.gh.merged = true
    await r.yard.tasks.prs.pollAll()
    const status = (t: Task) => r.yard.store.getTask(t.id)!.status
    expect([ready, idle, asking, failed].map(status)).toEqual(["idle", "idle", "needs_input", "failed"])
    expect([ready, idle].map((t) => r.yard.store.getTask(t.id)!.prState)).toEqual(["merged", "merged"])

    const before = r.yard.store.getTask(idle.id)!.updatedAt
    await call(r, "PUT", "/api/agent-settings", { autoDoneOnMerge: true })
    expect([ready, idle, asking, failed].map(status)).toEqual(["done", "done", "needs_input", "failed"])
    expect(events(r, idle.id).at(-1)).toMatch(/^Moved to done: its pull request #\d+ is merged \(Settings › Done when its PR merges\)\.( Its workspace is archived and its box slot freed\.)?$/)
    // Not new activity: it keeps its place in "recent" lists.
    expect(r.yard.store.getTask(idle.id)!.updatedAt).toBe(before)
  }, 90_000)

  it("catches up at start: a resting task whose PR merged while the server was down moves to done", async () => {
    const r = await start()
    const t = await prTask(r, "idle")
    r.yard.store.updateTask(t.id, { prState: "merged" }, { quiet: true })
    expect(r.yard.tasks.doneMergedResting()).toBe(1)
    expect(r.yard.store.getTask(t.id)!.status).toBe("done")
    expect(r.yard.tasks.doneMergedResting()).toBe(0)
  }, 60_000)
})

describe("Mark done from the cards", () => {
  it("is close_task's close: each task is done, with the same event", async () => {
    const r = await start()
    const a = await prTask(r, "idle")
    const b = await prTask(r, "pr_ready")
    for (const t of [a, b]) await call(r, "POST", `/api/tasks/${t.id}/close`)
    for (const t of [a, b]) {
      expect(r.yard.store.getTask(t.id)!.status).toBe("done")
      expect(events(r, t.id).some((e) => e.startsWith("Closed."))).toBe(true)
    }
  }, 60_000)
})
