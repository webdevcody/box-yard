import { afterEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { Box, BoxError } from "@upstash/box"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import { UpstashProvider, isNotFound } from "../server/providers/upstash.js"
import type { BoxHealth, ExecResult } from "../server/providers/types.js"
import type { BoxCleanup, BoxInfo, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Boxes deleted outside Box Yard (e.g. in the Upstash console) while idle: Box Yard reconciles with the provider's
// box list, drops the ones it no longer has (box history "lost"), keeps every box on an API error, and Delete,
// Clear and Clean up succeed on them instead of failing.

/** Local boxes with a provider-style list, and seams for a failing list, health answer or exec. */
class ConsoleProvider extends LocalProvider {
  listError: Error | null = null
  /** Ids the list leaves out though their folder is there (a list that lags). */
  unlisted = new Set<string>()
  healthOf = new Map<string, BoxHealth>()
  execError: Error | null = null
  listCalls = 0
  constructor(private readonly base: string) {
    super(base, FAKE_CLAUDE)
  }
  async liveIds() {
    this.listCalls++
    if (this.listError) throw this.listError
    return fs.readdirSync(this.base).filter((id) => !this.unlisted.has(id))
  }
  override async health(boxId: string): Promise<BoxHealth> {
    return this.healthOf.get(boxId) ?? super.health(boxId)
  }
  override exec(boxId: string, command: string): Promise<ExecResult> {
    if (this.execError) return Promise.reject(this.execError)
    return super.exec(boxId, command)
  }
  /** What deleting the box in the provider's console does. */
  deleteInConsole(boxId: string) {
    fs.rmSync(this.root(boxId), { recursive: true, force: true })
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: ConsoleProvider
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new ConsoleProvider(tmpDir("boxes-"))
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.provider.execError = null
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 300))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function send(r: Running, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}
async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const { status, data } = await send(r, method, urlPath, body)
  if (status >= 400) throw new Error(`${method} ${urlPath} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxIds = (r: Running) => r.yard.tasks.boxes().map((b) => b.id)
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return want(t) ? t : null
  }, what)
/** An idle task resting on its box, like the 7 boxes in the bug report. */
const idleOnBox = async (r: Running, projectName = "alpha") => {
  const p = await project(r, projectName)
  const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0 && Boolean(x.lastArchivedAt), "the task to finish")
  await new Promise((res) => setTimeout(res, 300))
  return { p, t, boxId: t.boxId! }
}
const lostEvents = (r: Running, boxId: string) => r.yard.tasks.history.list({ boxId, type: "lost" })
const events = (r: Running, taskId: string) => r.yard.store.listTaskMessages(taskId, 200).map((m) => m.content)

describe("reconciling with the provider's box list", () => {
  it("loses an idle box the provider no longer has, with a history entry, and its task restores from its archive elsewhere", async () => {
    const r = await start()
    const { t, boxId } = await idleOnBox(r)
    const work = path.join(r.yard.tasks.taskDir(boxId, t.id), "work")
    fs.writeFileSync(path.join(work, "kept.md"), "from the archive\n")
    await r.yard.tasks.archive(t.id)

    r.provider.deleteInConsole(boxId)
    // Nothing notices on its own: no turn is running on it.
    expect(boxIds(r)).toContain(boxId)
    await r.yard.tasks.reconcileBoxes(0)

    expect(boxIds(r)).not.toContain(boxId)
    expect(r.yard.store.getBox(boxId)).toBeNull()
    const lost = lostEvents(r, boxId)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({ actor: "provider", taskIds: [t.id] })
    expect(lost[0]!.reason).toContain("Missing from the provider's box list")
    expect(lost[0]!.projects.map((p) => p.name)).toEqual(["alpha"])
    expect((await getTask(r, t.id)).boxId).toBeNull()
    expect(events(r, t.id)).toContain(`Box ${boxId} no longer exists at the provider. The workspace will be restored from its archive when needed.`)

    // Not pinned to the vanished box: the next message lands on a new one and restores the workspace.
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more haiku" })
    const back = await status(r, t.id, (x) => x.status === "done" && x.pendingCount === 0 && Boolean(x.boxId), "the task to run again")
    expect(back.boxId).not.toBe(boxId)
    expect(fs.readFileSync(path.join(r.yard.tasks.taskDir(back.boxId!, t.id), "work", "kept.md"), "utf8")).toBe("from the archive\n")
  })

  it("falls back to a recap when the vanished box's task has no archive", async () => {
    const r = await start({ archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0, "the task to finish")
    const boxId = t.boxId!
    expect(t.lastArchivedAt).toBeFalsy()

    r.provider.deleteInConsole(boxId)
    await r.yard.tasks.reconcileBoxes(0)
    expect(boxIds(r)).not.toContain(boxId)

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more haiku" })
    const back = await status(r, t.id, (x) => x.status === "done" && x.pendingCount === 0 && Boolean(x.boxId), "the task to run again")
    expect(back.boxId).not.toBe(boxId)
    expect(events(r, t.id).some((m) => m.startsWith("Resumed from a recap"))).toBe(true)
  })

  it("keeps every box when the list fails, and a box the list misses unless the provider says it's gone", async () => {
    const r = await start()
    const { boxId } = await idleOnBox(r)

    // Network error, 5xx, auth hiccup: the list call throws. Even a box whose folder is gone stays this time.
    r.provider.deleteInConsole(boxId)
    r.provider.listError = Object.assign(new Error("fetch failed"), { statusCode: 503 })
    await r.yard.tasks.reconcileBoxes(0)
    expect(boxIds(r)).toContain(boxId)
    expect(lostEvents(r, boxId)).toHaveLength(0)

    // The list works but leaves the box out, and asking about the box itself fails (transient): kept.
    r.provider.listError = null
    r.provider.unlisted.add(boxId)
    r.provider.healthOf.set(boxId, "unknown")
    await r.yard.tasks.reconcileBoxes(0)
    expect(boxIds(r)).toContain(boxId)

    // The list lags, the provider says the box runs: kept.
    r.provider.healthOf.set(boxId, "running")
    await r.yard.tasks.reconcileBoxes(0)
    expect(boxIds(r)).toContain(boxId)

    // A definite "gone": dropped.
    r.provider.healthOf.delete(boxId)
    await r.yard.tasks.reconcileBoxes(0)
    expect(boxIds(r)).not.toContain(boxId)
    expect(lostEvents(r, boxId)).toHaveLength(1)
  })

  it("is throttled on page loads, and loading the Boxes page triggers it", async () => {
    const r = await start()
    const { boxId } = await idleOnBox(r)
    r.provider.deleteInConsole(boxId)

    const before = r.provider.listCalls
    await call<BoxInfo[]>(r, "GET", "/api/boxes")
    await waitFor(() => !r.yard.store.getBox(boxId), "the page load to drop the vanished box")
    expect(r.provider.listCalls).toBe(before + 1)
    // More page loads within the minute don't ask the provider again.
    for (let i = 0; i < 5; i++) await call<BoxInfo[]>(r, "GET", "/api/boxes")
    await r.yard.tasks.reconcileBoxes()
    expect(r.provider.listCalls).toBe(before + 1)
  })
})

describe("Delete, Clear and Clean up on a box the provider no longer has", () => {
  it("Delete drops it from Box Yard's records and is idempotent", async () => {
    const r = await start()
    const { t, boxId } = await idleOnBox(r)
    r.provider.deleteInConsole(boxId)

    expect(await send(r, "DELETE", `/api/boxes/${boxId}`)).toEqual({ status: 200, data: { ok: true } })
    expect(boxIds(r)).not.toContain(boxId)
    expect(r.yard.store.getBox(boxId)).toBeNull()
    expect((await getTask(r, t.id)).boxId).toBeNull()
    const lost = lostEvents(r, boxId)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toBe("The provider no longer has the box (deleted outside Box Yard, e.g. in the provider's console); found when Cody pressed Delete box.")

    // Again: nothing left to delete, still fine, and no new history row.
    const rows = r.yard.tasks.history.list({ boxId }).length
    expect(await send(r, "DELETE", `/api/boxes/${boxId}`)).toEqual({ status: 200, data: { ok: true } })
    expect(r.yard.tasks.history.list({ boxId })).toHaveLength(rows)
    // A box Box Yard never had is still a 404.
    expect((await send(r, "DELETE", "/api/boxes/never-was-12345")).status).toBe(404)
  })

  it("Delete of a gone box still succeeds when no workspace could be archived", async () => {
    const r = await start({ archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0, "the task to finish")
    r.provider.deleteInConsole(t.boxId!)
    expect((await send(r, "DELETE", `/api/boxes/${t.boxId}`)).status).toBe(200)
    expect(boxIds(r)).not.toContain(t.boxId)
  })

  it("Clean up now and Clear box drop it instead of erroring, and say so again on a repeat", async () => {
    const r = await start({ maxBoxes: 3 })
    const a = await idleOnBox(r, "alpha")
    const b = await idleOnBox(r, "beta")
    expect(a.boxId).not.toBe(b.boxId)
    r.provider.deleteInConsole(a.boxId)
    r.provider.deleteInConsole(b.boxId)

    const cleaned = await send(r, "POST", `/api/boxes/${a.boxId}/cleanup`)
    expect(cleaned.status).toBe(202)
    expect(cleaned.data).toMatchObject({ boxId: a.boxId, status: "done", freedBytes: 0, error: null })
    expect(boxIds(r)).not.toContain(a.boxId)
    expect(lostEvents(r, a.boxId)[0]!.reason).toContain("found when Cody pressed Clean up now")
    expect((await send(r, "POST", `/api/boxes/${a.boxId}/cleanup`)).status).toBe(202)

    const cleared = await call<BoxCleanup>(r, "POST", `/api/boxes/${b.boxId}/clear`, {})
    expect(cleared).toMatchObject({ boxId: b.boxId, status: "done", error: null })
    expect(boxIds(r)).not.toContain(b.boxId)
    expect(lostEvents(r, b.boxId)[0]!.reason).toContain("found when Cody pressed Clear box")
    expect((await send(r, "POST", `/api/boxes/${b.boxId}/clear`, {})).status).toBe(200)
    expect(lostEvents(r, a.boxId)).toHaveLength(1)
    expect(lostEvents(r, b.boxId)).toHaveLength(1)
  })
})

describe("stats from a box that can't be reached", () => {
  it("marks the box unreachable when a probe fails, clears it when one works, and leaves paused boxes alone", async () => {
    const r = await start()
    const { boxId } = await idleOnBox(r)
    const info = () => r.yard.tasks.boxes().find((b) => b.id === boxId)!
    expect(info().unreachableSince).toBeNull()

    // A paused box doesn't answer either; that's not a problem.
    r.provider.execError = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })
    r.provider.healthOf.set(boxId, "paused")
    expect(await r.yard.tasks.probeDisk(boxId, 0)).toBeNull()
    await new Promise((res) => setTimeout(res, 100))
    expect(info().unreachableSince).toBeNull()

    // Running, by the provider's word, but not answering: the page shows it as not answering.
    r.provider.healthOf.set(boxId, "unknown")
    const checkedAt = info().diskCheckedAt
    await r.yard.tasks.probeDisk(boxId, 0)
    await waitFor(() => info().unreachableSince, "the box to be marked unreachable")
    expect(info().diskCheckedAt).toBe(checkedAt)
    expect(r.yard.store.getBox(boxId)).not.toBeNull()

    r.provider.execError = null
    expect(await r.yard.tasks.probeDisk(boxId, 0)).not.toBeNull()
    expect(info().unreachableSince).toBeNull()
  })

  it("drops a box whose probe fails when the provider says it's gone", async () => {
    const r = await start()
    const { boxId } = await idleOnBox(r)
    r.provider.execError = new Error("box not reachable")
    r.provider.deleteInConsole(boxId)
    await r.yard.tasks.probeDisk(boxId, 0)
    await waitFor(() => !r.yard.store.getBox(boxId), "the gone box to be dropped")
    expect(lostEvents(r, boxId)[0]!.reason).toContain("A probe couldn't reach the box")
  })
})

describe("Upstash provider: gone vs. transient", () => {
  const provider = () => new UpstashProvider({ upstashBoxApiKey: "key", githubToken: "" } as Config)

  it("reads only 404/410, or a status-less 'not found', as gone", () => {
    expect(isNotFound(new BoxError("Box not found", 404))).toBe(true)
    expect(isNotFound(new BoxError("gone", 410))).toBe(true)
    expect(isNotFound(new Error("box abc not found"))).toBe(true)
    expect(isNotFound(new BoxError("API key not found", 401))).toBe(false)
    expect(isNotFound(new BoxError("forbidden", 403))).toBe(false)
    expect(isNotFound(new BoxError("bad gateway", 502))).toBe(false)
    expect(isNotFound(Object.assign(new Error("getaddrinfo ENOTFOUND api.upstash.com"), { code: "ENOTFOUND" }))).toBe(false)
    expect(isNotFound(new Error("fetch failed"))).toBe(false)
  })

  it("health says gone on a 404 and unknown on auth errors; destroy of a gone box succeeds; liveIds skips deleted boxes", async () => {
    const get = vi.spyOn(Box, "get")
    const list = vi.spyOn(Box, "list")
    try {
      get.mockRejectedValue(new BoxError("Box not found", 404))
      expect(await provider().health("moved-possum-73248")).toBe("gone")
      await expect(provider().destroy("moved-possum-73248")).resolves.toBeUndefined()
      get.mockRejectedValue(new BoxError("Unauthorized: API key not found", 401))
      expect(await provider().health("moved-possum-73248")).toBe("unknown")

      list.mockResolvedValue([
        { id: "lucky-ladybug-89696", status: "running" },
        { id: "heroic-alien-01924", status: "deleted" },
      ] as unknown as Awaited<ReturnType<typeof Box.list>>)
      expect(await provider().liveIds()).toEqual(["lucky-ladybug-89696"])
      // No label filter: boxes from before install labels count too.
      expect(list.mock.calls[0]![0]).toEqual({ apiKey: "key" })
      list.mockRejectedValue(new BoxError("Unauthorized", 401))
      await expect(provider().liveIds()).rejects.toThrow("Unauthorized")
    } finally {
      get.mockRestore()
      list.mockRestore()
    }
  })
})
