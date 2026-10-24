import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import type { BoxInfo, BoxSize, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A project with a box size runs only on boxes of at least that size (small < medium < large). When none has a
// free slot and the pool can't grow, an idle box is resized up to the size (through the usual resize), or the
// task waits with the reason on it. It never falls back to a smaller box, and restores follow the same rule.

const GB = 1024 ** 3

/** Disk a folder uses; a `*.ballast` file counts as the byte size written in it. */
function used(file: string): number {
  const st = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!st) return 0
  if (!st.isDirectory()) return file.endsWith(".ballast") ? Number(fs.readFileSync(file, "utf8")) || 0 : st.size
  let total = 0
  for (const e of fs.readdirSync(file)) total += used(path.join(file, e))
  return total
}

/** Local boxes that remember their size, fake df (a size's work disk minus the folder) and can hold creation. */
class SizedBoxes extends LocalProvider {
  sizes = new Map<string, BoxSize>()
  created: BoxSize[] = []
  destroyed: string[] = []
  gate: Promise<void> | null = null

  override async create(opts?: { labels: string[]; size?: BoxSize }): Promise<string> {
    if (this.gate) await this.gate
    const id = await super.create()
    this.sizes.set(id, opts?.size ?? "small")
    this.created.push(opts?.size ?? "small")
    return id
  }

  override async destroy(boxId: string) {
    this.destroyed.push(boxId)
    return super.destroy(boxId)
  }

  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk")) {
      const u = used(this.root(boxId))
      const total = { small: 5, medium: 10, large: 15 }[this.sizes.get(boxId) ?? "small"] * GB
      const kb = (n: number) => Math.floor(Math.max(0, n) / 1024)
      return { exitCode: 0, stdout: `fakefs ${kb(total)} ${kb(u)} ${kb(total - u)} 50% ${this.root(boxId)}\n`, stderr: "" }
    }
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: SizedBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new SizedBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, maxBoxes: 1, ...overrides }), { webDir: "/nonexistent", provider })
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
    r.provider.gate = null
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running"), "resizes to settle").catch(() => {})
    await new Promise((res) => setTimeout(res, 300))
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

const project = (r: Running, name: string, boxSize?: BoxSize) => call<Project>(r, "POST", "/api/projects", { name, ...(boxSize ? { boxSize } : {}) })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return want(t) ? t : null
  }, what)
const settled = (r: Running, id: string) => status(r, id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pendingCount === 0, `task ${id} to finish and archive`)
const sizeOf = (r: Running, boxId: string | null) => (boxId ? r.yard.store.getBox(boxId)?.size : null)
const workDir = (r: Running, boxId: string, taskId: string) => path.join(r.yard.tasks.taskDir(boxId, taskId), "work")
const messages = (r: Running, id: string) => r.yard.store.listTaskMessages(id, 200).map((m) => m.content)

describe("placement by project box size", () => {
  it("queues a large project's task with the reason when the only box is small and busy, then grows it once it's idle", async () => {
    const r = await start()
    const alpha = await project(r, "alpha")
    const big = await project(r, "big", "large")
    const hang = await task(r, alpha.id, "long one", "think for a while [hang]")
    const small = (await status(r, hang.id, (x) => x.status === "working", "alpha to work")).boxId!
    expect(sizeOf(r, small)).toBe("small")

    // The small box has a free slot (2 per box here), but it's too small: the task waits, and says why.
    const t = await task(r, big.id, "needs ram")
    const waiting = await status(r, t.id, (x) => x.status === "queued" && Boolean(x.waitReason), "the big task to wait with a reason")
    expect(waiting.waitReason).toBe("Waiting for a large box: the pool is full (1 of 1 boxes) and no box is idle to resize")
    expect(waiting.waitBoxSize).toBe("large")
    expect(waiting.boxId).toBeNull()
    expect(messages(r, t.id)).toContain("Waiting for a large box: the pool is full (1 of 1 boxes) and no box is idle to resize.")
    // The task list the Yard queue reads (GET /api/tasks) carries the same reason.
    const queue = await call<Task[]>(r, "GET", "/api/tasks")
    expect(queue.find((x) => x.id === t.id)).toMatchObject({ waitReason: waiting.waitReason, waitBoxSize: "large" })
    await new Promise((res) => setTimeout(res, 500))
    expect((await getTask(r, t.id)).boxId).toBeNull()
    expect(r.provider.created).toEqual(["small"])

    // Its agent stops (never by placement): the box is idle now, so it's resized and the task runs on it.
    await r.yard.tasks.stopTask(hang.id)
    const done = await settled(r, t.id)
    expect(sizeOf(r, done.boxId)).toBe("large")
    expect(done.waitReason).toBeNull()
    expect(done.waitBoxSize).toBeNull()
    expect(r.provider.created).toEqual(["small", "large"])
    expect(r.provider.destroyed).toEqual([small])
    const rep = r.yard.tasks.resizeReport(done.boxId!)!
    expect(rep).toMatchObject({ status: "done", from: "small", to: "large", by: { kind: "placement", projectId: big.id, taskId: t.id } })
    expect((await getTask(r, hang.id)).boxId).toBe(done.boxId)
  })

  it("resizes an idle box and reuses it, with the reason on the task meanwhile", async () => {
    const r = await start()
    const alpha = await project(r, "alpha")
    const big = await project(r, "big", "large")
    const a = await settled(r, (await task(r, alpha.id, "first")).id)
    const small = a.boxId!
    fs.writeFileSync(path.join(workDir(r, small, a.id), "notes.md"), "kept across the resize\n")
    r.yard.store.updateTask(a.id, { lastArchivedAt: Date.now() - 60_000 }, { touch: false })

    // Hold the new box's creation to see the task wait for it.
    let release!: () => void
    r.provider.gate = new Promise((res) => (release = res))
    const t = await task(r, big.id, "needs ram")
    const waiting = await status(r, t.id, (x) => x.status === "queued" && Boolean(x.waitReason), "the big task to wait for the resize")
    expect(waiting.waitReason).toBe(`Waiting for a large box: resizing box ${small} (small → large)`)
    expect(waiting.waitBoxSize).toBe("large")
    expect((await boxes(r)).find((b) => b.id === small)?.operation).toBe("resize")
    release()

    const done = await settled(r, t.id)
    const large = done.boxId!
    expect(large).not.toBe(small)
    expect(sizeOf(r, large)).toBe("large")
    expect(r.provider.created).toEqual(["small", "large"])
    expect(r.provider.destroyed).toEqual([small])
    expect((await boxes(r)).map((b) => [b.id, b.size])).toEqual([[large, "large"]])
    // The idle box's own task moved along with its archive, and its work comes back on its next turn.
    expect((await getTask(r, a.id)).boxId).toBe(large)
    await call(r, "POST", `/api/tasks/${a.id}/messages`, { content: "one more" })
    const back = await settled(r, a.id)
    expect(back.boxId).toBe(large)
    expect(fs.readFileSync(path.join(workDir(r, large, a.id), "notes.md"), "utf8")).toBe("kept across the resize\n")
    // A notice says Box Yard did it, and why.
    const notice = r.yard.store.listChat(50).find((m) => m.content.startsWith("📦 Box Yard resized box"))
    expect(notice?.content).toContain(`Reason: big needs large boxes, the pool is at its limit and ${small} was idle`)
  })

  it("grows the idle box with the least on its disk first", async () => {
    const r = await start({ maxBoxes: 2 })
    const alpha = await project(r, "alpha")
    const beta = await project(r, "beta")
    const big = await project(r, "big", "medium")
    const a = await settled(r, (await task(r, alpha.id, "a")).id)
    const b = await settled(r, (await task(r, beta.id, "b")).id)
    expect(a.boxId).not.toBe(b.boxId)
    fs.writeFileSync(path.join(workDir(r, a.boxId!, a.id), "big.ballast"), String(2 * GB))
    await r.yard.tasks.probeDisk(a.boxId!, 0)
    await r.yard.tasks.probeDisk(b.boxId!, 0)

    const done = await settled(r, (await task(r, big.id, "needs a medium box")).id)
    expect(sizeOf(r, done.boxId)).toBe("medium")
    expect(r.provider.destroyed).toEqual([b.boxId])
    expect((await getTask(r, a.id)).boxId).toBe(a.boxId)
  })

  it("never picks a smaller box: a medium project shares a large box, not a small one with a free slot", async () => {
    const r = await start({ maxBoxes: 2 })
    const alpha = await project(r, "alpha")
    const huge = await project(r, "huge", "large")
    const mid = await project(r, "mid", "medium")
    // The small box is busy (one of its two slots), so it isn't idle to resize either.
    const hang = await task(r, alpha.id, "long one", "think for a while [hang]")
    const small = (await status(r, hang.id, (x) => x.status === "working", "alpha to work")).boxId!
    const h = await settled(r, (await task(r, huge.id, "h")).id)
    expect(sizeOf(r, h.boxId)).toBe("large")

    const m = await settled(r, (await task(r, mid.id, "m")).id)
    expect(m.boxId).toBe(h.boxId)
    expect(m.boxId).not.toBe(small)
    expect(r.provider.created.sort()).toEqual(["large", "small"])
    // No size set: any box will do, so alpha's next task still uses its small box.
    const a2 = await settled(r, (await task(r, alpha.id, "a2")).id)
    expect(a2.boxId).toBe(small)
  })

  it("restores an archived task only onto a box of its project's size (send_to_task on an archived task)", async () => {
    const r = await start({ maxBoxes: 2 })
    const alpha = await project(r, "alpha")
    const p = await project(r, "proj")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const first = t.boxId!
    fs.writeFileSync(path.join(workDir(r, first, t.id), "notes.md"), "from the archive\n")
    r.yard.store.updateTask(t.id, { lastArchivedAt: Date.now() - 60_000 }, { touch: false })
    // Delete its box: the workspace goes to the archive and the task has no box.
    await call(r, "DELETE", `/api/boxes/${first}`)
    await status(r, t.id, (x) => x.boxId === null, "the task to lose its box")
    // A small box with a free slot exists (alpha's, busy with one agent), and the project now wants large.
    const hang = await task(r, alpha.id, "long one", "think for a while [hang]")
    const small = (await status(r, hang.id, (x) => x.status === "working", "alpha to work")).boxId!
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: "large" })

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "carry on" })
    const back = await settled(r, t.id)
    expect(back.boxId).not.toBe(small)
    expect(sizeOf(r, back.boxId)).toBe("large")
    expect(fs.readFileSync(path.join(workDir(r, back.boxId!, t.id), "notes.md"), "utf8")).toBe("from the archive\n")
  })

  it("moves a resting task off a box smaller than its project's size on its next message", async () => {
    const r = await start({ maxBoxes: 2 })
    const p = await project(r, "proj")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const small = t.boxId!
    fs.writeFileSync(path.join(workDir(r, small, t.id), "notes.md"), "moves with it\n")
    await r.yard.tasks.archive(t.id)
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: "medium" })

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "carry on" })
    const back = await settled(r, t.id)
    expect(back.boxId).not.toBe(small)
    expect(sizeOf(r, back.boxId)).toBe("medium")
    expect(fs.readFileSync(path.join(workDir(r, back.boxId!, t.id), "notes.md"), "utf8")).toBe("moves with it\n")
    expect(messages(r, t.id)).toContain(`Moved from ${small} (small) to ${back.boxId}: its project needs medium boxes.`)
  })

  it("keeps a task on its smaller box, and says so, when its workspace has no fresh archive to move", async () => {
    const r = await start({ maxBoxes: 2 })
    const p = await project(r, "proj")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const small = t.boxId!
    r.yard.store.updateTask(t.id, { lastArchivedAt: Date.now() - 60_000 }, { touch: false })
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: "large" })

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "carry on" })
    const back = await status(r, t.id, (x) => x.status === "done" && x.pendingCount === 0 && x.turnCount === 2, "the second turn")
    expect(back.boxId).toBe(small)
    expect(messages(r, t.id)).toContain(`Running on ${small} (small) though its project needs large boxes: its workspace has no fresh archive to move.`)
  })
})
