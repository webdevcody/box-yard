import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { ExecResult } from "../server/providers/types.js"
import { LocalProvider } from "../server/providers/local.js"
import type { AutoBoxSize } from "../shared/autoSize.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Auto-sizing end to end: the box probe measures each turn on its (pretend) Upstash box, a project's new boxes take
// the size its runs call for, and a turn that runs out of memory carries on once on a bigger box.
// The rule itself is in auto-size.test.ts.

const GB = 1024 ** 3

/** Local boxes whose df probe reports a cgroup of their own: memory in use and the out-of-memory kill count. */
class MeasuredBoxes extends LocalProvider {
  readonly ownCgroup = true
  /** Memory in use on every box. */
  mem = 1 * GB
  oomKills = new Map<string, number>()
  constructor(dir: string) {
    super(dir, FAKE_CLAUDE)
  }
  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (!command.startsWith("df -Pk")) return super.exec(boxId, command)
    const stdout = [
      `fakefs 52428800 0 52428800 1% ${this.root(boxId)}`,
      "@@boxyard-mem",
      `memory.current ${this.mem}`,
      `memory.max ${16 * GB}`,
      "inactive_file 0",
      "usage_usec 0",
      `oom_kill ${this.oomKills.get(boxId) ?? 0}`,
      "loadavg 0.50 0.40 0.30 2/300 4242",
      "nproc 64",
    ].join("\n")
    return { exitCode: 0, stdout, stderr: "" }
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: MeasuredBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new MeasuredBoxes(tmpDir("boxes-"))
  const yard = createBoxYard(testConfig({ port, maxBoxes: 3, ...overrides }), { webDir: "/nonexistent", provider })
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
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const task = (r: Running, projectId: string, title: string, prompt: string) => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const autoSize = (r: Running, projectId: string) => call<AutoBoxSize & { enabled: boolean; override: string | null }>(r, "GET", `/api/projects/${projectId}/auto-size`)
const until = (r: Running, id: string, status: Task["status"]) =>
  waitFor(async () => {
    const t = await call<Task>(r, "GET", `/api/tasks/${id}`)
    return t.status === status && t.pendingCount === 0 ? t : null
  }, `task ${id} to be ${status}`)
const running_ = (r: Running, id: string) =>
  waitFor(() => {
    const row = r.yard.store.getTaskRow(id)
    return row?.current_turn_id && row.box_id && row.status === "working" ? row : null
  }, "its turn to run")
const sizeOf = (r: Running, boxId: string | null) => r.yard.store.getBox(boxId!)?.size
const events = (r: Running, id: string) => r.yard.store.listTaskMessages(id, 200).map((m) => m.content)
const notices = (r: Running) => (r.yard.store.db.prepare("SELECT content FROM chat_messages WHERE role = 'notice' ORDER BY created_at, rowid").all() as { content: string }[]).map((n) => n.content)

/** FAKE_CLAUDE_GATE: each turn of the project waits at the gate until the test says how it ends (scripts/fake-claude.mjs). */
function gate() {
  const file = path.join(tmpDir("gate-"), "g")
  const reached = (n: number) => waitFor(() => (fs.existsSync(`${file}.turns`) && fs.readFileSync(`${file}.turns`, "utf8").trim().split("\n").length >= n) || null, `turn ${n} at its gate`)
  return { file, reached, end: (n: number, how: "ok" | "fail" | "kill") => fs.writeFileSync(`${file}.${n}`, how) }
}

/** The box's cgroup kills a process for memory while the turn on it waits at its gate (after a reading to compare with). */
async function outOfMemory(r: Running, boxId: string) {
  await r.yard.tasks.probeDisk(boxId, 0)
  r.provider.oomKills.set(boxId, (r.provider.oomKills.get(boxId) ?? 0) + 1)
}

describe("auto-sizing", () => {
  it("sizes a project's new boxes from what its runs used, from the third; its own box size overrides it", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "big" })
    r.provider.mem = 3.5 * GB // over a small box's 4 GB / 1.25
    for (const n of [1, 2]) await until(r, (await task(r, p.id, `run ${n}`, "build it [slow:1]")).id, "done")
    expect(await autoSize(r, p.id)).toMatchObject({ size: null, runs: 2, enabled: true, override: null, label: "not measured yet (2 of 3 runs)" })
    expect(r.yard.tasks.newBoxSize(p.id)).toBe("small")
    expect(r.yard.tasks.projectBoxSettings(p).boxSize).toBe("global: small (Settings › Worker size); auto-sizing has it not measured yet (2 of 3 runs)")

    const third = await until(r, (await task(r, p.id, "run 3", "build it [slow:1]")).id, "done")
    expect(sizeOf(r, third.boxId)).toBe("small")
    expect(await autoSize(r, p.id)).toMatchObject({ size: "medium", runs: 3, basis: "memory", label: "medium (peak 3.5 GB over 3 runs)" })
    expect(r.yard.tasks.projectBoxSettings(p).boxSize).toBe("auto: medium (peak 3.5 GB over 3 runs)")

    // The next task gets a medium box; the small one is too small for the project now.
    const next = await until(r, (await task(r, p.id, "run 4", "build it")).id, "done")
    expect(next.boxId).not.toBe(third.boxId)
    expect(sizeOf(r, next.boxId)).toBe("medium")

    // Another project isn't measured, so Settings › Worker size applies to it.
    const other = await call<Project>(r, "POST", "/api/projects", { name: "other" })
    expect(r.yard.tasks.newBoxSize(other.id)).toBe("small")

    // The project's own box size wins; with auto-sizing off, Worker size applies.
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: "small" })
    expect(r.yard.tasks.newBoxSize(p.id)).toBe("small")
    expect(await autoSize(r, p.id)).toMatchObject({ size: "medium", override: "small" })
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: null })
    expect(r.yard.tasks.newBoxSize(p.id)).toBe("medium")
    r.yard.settings.update({ autoResizeEnabled: false })
    expect(r.yard.tasks.newBoxSize(p.id)).toBe("small")
    expect(r.yard.tasks.projectBoxSettings(r.yard.store.getProject(p.id)!).boxSize).toBe("global: small (Settings › Worker size)")
  })

  it("carries a turn that ran out of memory on once, on a bigger box; a second time it fails", async () => {
    const r = await start()
    const g = gate()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "oom", env: { FAKE_CLAUDE_GATE: g.file } })
    const t = await task(r, p.id, "build", "build it")
    const first = await running_(r, t.id)
    await g.reached(1)
    expect(sizeOf(r, first.box_id)).toBe("small")
    await outOfMemory(r, first.box_id!)
    g.end(1, "fail")

    // The retry: on a medium box, in the same session, told what happened.
    const retry = await waitFor(() => {
      const row = r.yard.store.getTaskRow(t.id)
      return row?.current_turn_id && row.box_id && row.box_id !== first.box_id ? row : null
    }, "the retry on another box")
    expect(sizeOf(r, retry.box_id)).toBe("medium")
    expect(r.yard.store.turnFlags(retry).oomRetries).toBe(1)
    expect(events(r, t.id)).toContain(`Turn 1 ran out of memory on its small box ${first.box_id}; it carries on now on a medium box instead of failing.`)
    expect(notices(r)).toContain(`⚠️ **build** ran out of memory: its small box ${first.box_id} was too small, so it carries on on a medium box, and its project's tasks get medium boxes from now on.`)
    expect(await autoSize(r, p.id)).toMatchObject({ size: "medium", basis: "out-of-memory", label: "medium (a turn ran out of memory on a smaller box)" })
    await g.reached(2)
    expect(r.yard.store.db.prepare("SELECT status FROM task_turns WHERE task_id = ? ORDER BY started_at").all(t.id)).toMatchObject([{ status: "interrupted" }, { status: "started" }])

    // Out of memory again on the medium box: it fails, and says why it wasn't retried.
    await outOfMemory(r, retry.box_id!)
    g.end(2, "fail")
    const failed = await until(r, t.id, "failed")
    expect(failed.error).toMatch(/^It ran out of memory on its medium box, and isn't retried on a bigger one: it already had its retry on a bigger box\. /)
    expect(await autoSize(r, p.id)).toMatchObject({ size: "large" })
  })

  it("doesn't retry where the project set its own box size, or it's the biggest Box Yard may pick", async () => {
    const r = await start()
    const g = gate()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "pinned", boxSize: "small", env: { FAKE_CLAUDE_GATE: g.file } })
    const t = await task(r, p.id, "build", "build it")
    const row = await running_(r, t.id)
    await g.reached(1)
    await outOfMemory(r, row.box_id!)
    g.end(1, "fail")
    const failed = await until(r, t.id, "failed")
    expect(failed.error).toMatch(/^It ran out of memory on its small box, and isn't retried on a bigger one: its project's Box size is set to small, so Box Yard doesn't pick one \(raise it in the project's settings\)\. /)

    // Without a size of its own but held to small boxes by Settings › Max size it may choose.
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: null })
    r.yard.settings.update({ autoResizeMaxSize: "small" })
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "try again" })
    await g.reached(2)
    await outOfMemory(r, row.box_id!)
    g.end(2, "fail")
    await waitFor(async () => (await call<Task>(r, "GET", `/api/tasks/${t.id}`)).error?.includes("Settings › Max size it may choose is small") || null, "the second failure")
  })

  it("counts an agent killed outright (exit 137) as out of memory", async () => {
    const r = await start()
    const g = gate()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "killed", env: { FAKE_CLAUDE_GATE: g.file } })
    const t = await task(r, p.id, "build", "build it")
    const first = await running_(r, t.id)
    await g.reached(1)
    g.end(1, "kill")
    const retry = await waitFor(() => {
      const row = r.yard.store.getTaskRow(t.id)
      return row?.current_turn_id && row.box_id && row.box_id !== first.box_id ? row : null
    }, "the retry on another box")
    expect(sizeOf(r, retry.box_id)).toBe("medium")
    await g.reached(2)
    g.end(2, "ok")
    await until(r, t.id, "done")
  })
})
