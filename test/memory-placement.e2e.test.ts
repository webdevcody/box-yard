import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { ExecResult } from "../server/providers/types.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Memory-aware placement: a box short on memory (or over its load limit) takes no new agent while agents run on it.
// A project's own Agents per box (which replaced its "heavy tasks" setting) is in project-box-settings.e2e.test.ts.

const MB = 1024 * 1024
const GB = 1024 * MB

/** Local boxes whose df probe reports a pretend cgroup: `mem` bytes in use of 4 GB, and a load average. */
class MemBoxes extends LocalProvider {
  mem = new Map<string, number>()
  load = new Map<string, number>()

  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk")) {
      const used = this.mem.get(boxId) ?? 1 * GB
      const stdout = [
        `fakefs 52428800 0 52428800 1% ${this.root(boxId)}`,
        "@@boxyard-root-df",
        `fakefs 52428800 0 52428800 1% ${this.root(boxId)}`,
        "@@boxyard-mem",
        `memory.current ${used + 512 * MB}`,
        `memory.max ${4 * GB}`,
        // Reclaimable page cache doesn't count as in use.
        `inactive_file ${512 * MB}`,
        "MemTotal:       263000000 kB",
        "MemAvailable:   200000000 kB",
        `loadavg ${(this.load.get(boxId) ?? 0.5).toFixed(2)} 0.40 0.30 2/300 4242`,
        "nproc 2",
      ].join("\n")
      return { exitCode: 0, stdout, stderr: "" }
    }
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: MemBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new MemBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, archiveWorkspaces: false, memoryMaxUsedPercent: 80, memoryMinFreeMb: 512, loadMaxPerCpu: 2, ...overrides }), {
    webDir: "/nonexistent",
    provider,
  })
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
    // Stop the [hang] turns so nothing outlives the database.
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

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return ok(t) ? t : null
  }, `task ${id} ${what}`)
const working = (r: Running, id: string) => until(r, id, (t) => t.status === "working", "to be working")
const done = (r: Running, id: string) => until(r, id, (t) => t.status === "done" && t.pendingCount === 0, "to be done")
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
/** A long-running agent ([hang] keeps the fake turn going until it's stopped). */
const hang = async (r: Running, projectId: string, title: string) => working(r, (await task(r, projectId, title, "keep going [hang]")).id)

describe("memory-aware placement", () => {
  it("sends a new agent to another box while its project's box is short on memory", async () => {
    const r = await start({ maxBoxes: 2, slotsPerBox: 2 })
    const p = await project(r, "alpha")
    const first = await hang(r, p.id, "first")
    const busy = first.boxId!
    r.provider.mem.set(busy, Math.round(3.6 * GB))
    await r.yard.tasks.probeDisk(busy, 0)

    const info = (await boxes(r)).find((b) => b.id === busy)!
    expect(info.memUsedBytes).toBe(Math.round(3.6 * GB))
    expect(info.memTotalBytes).toBe(4 * GB)
    expect(info.cpuCount).toBe(2)
    expect(info.memoryPressure).toBe("3.6 GB of 4.0 GB memory in use (90%), over 80%")

    const second = await done(r, (await task(r, p.id, "second")).id)
    expect(second.boxId).not.toBe(busy)
    expect(events(r, second.id)).toContain(`Waiting for a new box: box ${busy} is busy: 3.6 GB of 4.0 GB memory in use (90%), over 80%.`)
  })

  it("waits when every box is busy and the pool is full, then goes once memory frees up", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 3 })
    const p = await project(r, "alpha")
    const first = await hang(r, p.id, "first")
    const box = first.boxId!
    // The load average counts too: 5 on 2 CPUs is over 2× them.
    r.provider.load.set(box, 5)
    await r.yard.tasks.probeDisk(box, 0)

    const second = await task(r, p.id, "second")
    const waiting = await until(r, second.id, (t) => Boolean(t.waitReason), "to say why it waits")
    expect(waiting.status).toBe("queued")
    expect(waiting.waitReason).toBe(`Waiting: box ${box} is busy: load 5.00 on 2 CPUs, over 2× its CPUs`)

    r.provider.load.set(box, 0.5)
    await r.yard.tasks.probeDisk(box, 0)
    r.yard.tasks.schedule()
    const ran = await done(r, second.id)
    expect(ran.boxId).toBe(box)
  })

  it("still places work on a box nobody runs on, whatever its memory says", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await project(r, "alpha")
    const first = await done(r, (await task(r, p.id, "first")).id)
    r.provider.mem.set(first.boxId!, Math.round(3.9 * GB))
    await r.yard.tasks.probeDisk(first.boxId!, 0)
    const second = await done(r, (await task(r, p.id, "second")).id)
    expect(second.boxId).toBe(first.boxId)
  })

  it("tells the agent how much memory its box has and that others may share it", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const p = await project(r, "alpha")
    const first = await done(r, (await task(r, p.id, "first")).id)
    await r.yard.tasks.probeDisk(first.boxId!, 0)
    const second = await done(r, (await task(r, p.id, "second")).id)
    const fs = await import("node:fs")
    const turn = JSON.parse(fs.readFileSync(`${r.yard.tasks.taskDir(second.boxId!, second.id)}/turn.json`, "utf8")) as { systemPrompt: string }
    expect(turn.systemPrompt).toContain("This box has 4.0 GB of memory, shared with up to 1 other agents that may run at the same time.")
    expect(turn.systemPrompt).toContain("Run heavy jobs (full test suites, headless browsers, big builds) one at a time")
  })
})
