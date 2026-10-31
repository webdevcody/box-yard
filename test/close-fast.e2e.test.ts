import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import type { Project, Task, UiEvent } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Mark done (POST /api/tasks/:id/close, close_task) answers and broadcasts "done" at once. Its box work (stopping a
// running turn, archiving the workspace, freeing the slot) goes on after, however slow the box is, and still happens.

/** Boxes whose commands wait behind a gate while `slow` is on, like a slow box API. */
class SlowBoxes extends LocalProvider {
  slow = false
  held = 0
  private open: (() => void)[] = []
  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (this.slow) {
      this.held++
      await new Promise<void>((resolve) => this.open.push(resolve))
    }
    return super.exec(boxId, command)
  }
  release() {
    this.slow = false
    for (const go of this.open.splice(0)) go()
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  boxes: SlowBoxes
  /** Every task status the UI was sent, in order. */
  sent: { id: string; status: string }[]
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const boxes = new SlowBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", provider: boxes })
  const sent: Running["sent"] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (ev: UiEvent) => {
    if (ev.type === "task") sent.push({ id: ev.task.id, status: ev.task.status })
    broadcast(ev)
  }
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, boxes, sent }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.boxes.release()
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const turnOf = (r: Running, id: string) => r.yard.store.getTaskRow(id)!.current_turn_id
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)

async function taskIn(r: Running, prompt: string, want: (t: Task) => boolean, what: string): Promise<Task> {
  const project = await call<Project>(r, "POST", "/api/projects", { name: `p${r.sent.length}` })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Close me", prompt })
  return waitFor(() => (want(getTask(r, t.id)) ? getTask(r, t.id) : null), what)
}

/** POST close with the box held: the answer, how long it took, and whether "done" went out before the box moved. */
async function closeOnSlowBox(r: Running, id: string) {
  r.boxes.slow = true
  const at = Date.now()
  const task = await call<Task>(r, "POST", `/api/tasks/${id}/close`)
  const ms = Date.now() - at
  return { task, ms, broadcastDone: r.sent.some((s) => s.id === id && s.status === "done") }
}

describe("Mark done on a slow box", () => {
  it("answers and broadcasts done before the archive finishes, then archives and frees the slot", async () => {
    const r = await start()
    const t = await taskIn(r, "write the notes [pr]", (t) => t.status === "idle" && !turnOf(r, t.id), "a resting task")
    expect(t.boxId).toBeTruthy()

    const { task, ms, broadcastDone } = await closeOnSlowBox(r, t.id)
    expect(task.status).toBe("done")
    expect(ms).toBeLessThan(1000)
    expect(broadcastDone).toBe(true)
    // The archive is waiting on the box: the workspace is still there.
    await waitFor(() => r.boxes.held > 0, "the archive to reach the box")
    expect(getTask(r, t.id).boxId).toBe(t.boxId)

    r.boxes.release()
    await waitFor(() => getTask(r, t.id).boxId === null, "the workspace to be archived and its slot freed")
    expect(getTask(r, t.id).status).toBe("done")
  })

  it("closes a running task at once and keeps it done when its stopped turn ends", async () => {
    const r = await start()
    const t = await taskIn(r, "keep going [hang]", (t) => t.status === "working", "a working task")

    const { task, ms, broadcastDone } = await closeOnSlowBox(r, t.id)
    expect(task.status).toBe("done")
    expect(ms).toBeLessThan(1000)
    expect(broadcastDone).toBe(true)
    expect(turnOf(r, t.id)).toBeTruthy()

    r.boxes.release()
    await waitFor(() => !turnOf(r, t.id), "the stopped turn to end", 30_000)
    expect(getTask(r, t.id).status).toBe("done")
    expect(events(r, t.id)).toContain("Stopped by Cody.")
    // Once done, nothing sent it back to idle (the card would come back).
    const after = r.sent.filter((s) => s.id === t.id).map((s) => s.status)
    expect(after.slice(after.indexOf("done"))).toEqual(after.slice(after.indexOf("done")).map(() => "done"))
    // A stop isn't news: no "is done" notice.
    expect(r.yard.store.listChat().some((m) => m.content.includes("✅ **Close me** is done"))).toBe(false)
    await waitFor(() => getTask(r, t.id).boxId === null, "the workspace to be archived and its slot freed", 30_000)
  })
})
