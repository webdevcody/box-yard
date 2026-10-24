import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxCleanup, BoxContents, BoxInfo, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Clear box and Delete box from the Boxes page: every workspace is archived before anything is removed,
// both refuse while agents are running, and "stop agents and …" stops them first.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: LocalProvider
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE)
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
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => r.yard.store.listBoxes().every((b) => !r.yard.tasks.janitor.isRunning(b.id)), "cleanups to settle").catch(() => {})
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
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return want(t) ? t : null
  }, what)
/** A done task whose archive is written, so the test can stage files in its folder. */
const settled = async (r: Running, id: string) => {
  const t = await status(r, id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pendingCount === 0, `task ${id} to finish and archive`)
  await new Promise((res) => setTimeout(res, 500))
  return t
}
const workDir = (r: Running, boxId: string, taskId: string) => path.join(r.yard.tasks.taskDir(boxId, taskId), "work")
const archived = (r: Running, taskId: string) => execFileSync("tar", ["tzf", r.yard.store.getTaskRow(taskId)!.archive_path!], { encoding: "utf8" })
/** Pretend a file changed after the last archive (no turn ran since), so the box's copy is the only current one. */
function staleArchive(r: Running, taskId: string, file: string) {
  const row = r.yard.store.getTaskRow(taskId)!
  fs.writeFileSync(path.join(workDir(r, row.box_id!, taskId), file), "uncommitted work\n")
  r.yard.store.updateTask(taskId, { lastArchivedAt: row.last_active_at - 60_000 }, { touch: false })
}

describe("delete box", () => {
  it("archives every workspace before destroying the box, and the task comes back on another box", async () => {
    const r = await start({ maxBoxes: 2 })
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const boxId = t.boxId!
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: workDir(r, boxId, t.id), stdio: "pipe" })
    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "agent work")
    staleArchive(r, t.id, "notes-uncommitted.md")

    const contents = await call<BoxContents>(r, "GET", `/api/boxes/${boxId}/contents`)
    expect(contents.running).toBe(0)
    expect(contents.tasks.map((x) => [x.id, x.status, x.archived])).toEqual([[t.id, "done", false]])
    expect(contents.tasks[0]!.uncommitted).toBe(1)

    await call(r, "DELETE", `/api/boxes/${boxId}`)
    expect((await boxes(r)).map((b) => b.id)).not.toContain(boxId)
    expect(fs.existsSync(r.provider.root(boxId))).toBe(false)
    const after = await getTask(r, t.id)
    expect(after.boxId).toBeNull()
    // The archive was refreshed before the delete, so it holds the file only the box had.
    expect(archived(r, t.id)).toContain(`${t.id}/work/notes-uncommitted.md`)

    // The next message places it on a new box and restores the workspace from that archive.
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "one more haiku" })
    const back = await status(r, t.id, (x) => x.status === "done" && x.pendingCount === 0 && Boolean(x.boxId), "the task to run again")
    expect(back.boxId).not.toBe(boxId)
    expect(fs.readFileSync(path.join(workDir(r, back.boxId!, t.id), "notes-uncommitted.md"), "utf8")).toBe("uncommitted work\n")
  })

  it("refuses while an agent is running, and stops it first when asked", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await task(r, p.id, "long one", "think for a while [hang]")
    const working = await status(r, t.id, (x) => x.status === "working", "the agent to start working")
    const boxId = working.boxId!

    const refused = await send(r, "DELETE", `/api/boxes/${boxId}`)
    expect(refused.status).toBe(409)
    expect(refused.data.error).toBe(`1 agent is running on ${boxId}: stop it first.`)
    expect((await boxes(r)).map((b) => b.id)).toContain(boxId)
    expect((await getTask(r, t.id)).status).toBe("working")

    await call(r, "DELETE", `/api/boxes/${boxId}?stopAgents=1`)
    expect((await boxes(r)).map((b) => b.id)).not.toContain(boxId)
    const stopped = await getTask(r, t.id)
    expect(stopped.status).not.toBe("working")
    expect(stopped.boxId).toBeNull()
    expect(stopped.lastArchivedAt).toBeTruthy()
    expect(r.yard.store.listTaskMessages(t.id, 200).some((m) => m.content === `Stopped so Cody could delete box ${boxId}.`)).toBe(true)
  })

  it("keeps the box when a workspace can't be archived", async () => {
    const r = await start({ archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await status(r, (await task(r, p.id, "first")).id, (x) => x.status === "done" && x.pendingCount === 0, "the task to finish")
    const res = await send(r, "DELETE", `/api/boxes/${t.boxId}`)
    expect(res.status).toBe(409)
    expect(res.data.error).toBe(`Couldn't archive ${t.id}, so ${t.boxId} was not deleted: archive ${t.id}: workspace archiving is off (BOXYARD_ARCHIVE=0)`)
    expect((await boxes(r)).find((b) => b.id === t.boxId)?.operation).toBeNull()
    expect(fs.existsSync(workDir(r, t.boxId!, t.id))).toBe(true)
  })
})

describe("clear box", () => {
  it("archives and removes every workspace but keeps the box, and reports what it freed", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const boxId = t.boxId!
    staleArchive(r, t.id, "draft.md")

    const report = await call<BoxCleanup>(r, "POST", `/api/boxes/${boxId}/clear`, {})
    expect(report.reason).toBe("clear")
    expect(report.status).toBe("done")
    expect(report.steps.map((s) => s.key)).toEqual(["archive", "partials", "caches", "git"])
    expect(report.steps[0]!.removed).toEqual([t.id])
    expect(fs.existsSync(r.yard.tasks.taskDir(boxId, t.id))).toBe(false)
    expect(archived(r, t.id)).toContain(`${t.id}/work/draft.md`)

    const info = (await boxes(r)).find((b) => b.id === boxId)!
    expect(info.status).toBe("ready")
    expect(info.residentTasks).toEqual([])
    expect(info.cleanup?.reason).toBe("clear")
    expect(info.operation).toBeNull()
    expect((await getTask(r, t.id)).boxId).toBeNull()
  })

  it("refuses while an agent is running, and clears after stopping it when asked", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const done = await settled(r, (await task(r, p.id, "first")).id)
    const t = await task(r, p.id, "long one", "think for a while [hang]")
    const working = await status(r, t.id, (x) => x.status === "working", "the agent to start working")
    expect(working.boxId).toBe(done.boxId)
    const boxId = working.boxId!

    const refused = await send(r, "POST", `/api/boxes/${boxId}/clear`, {})
    expect(refused.status).toBe(409)
    expect(refused.data.error).toBe(`1 agent is running on ${boxId}: stop it first.`)
    expect(fs.existsSync(r.yard.tasks.taskDir(boxId, done.id))).toBe(true)

    const report = await call<BoxCleanup>(r, "POST", `/api/boxes/${boxId}/clear`, { stopAgents: true })
    expect(report.status).toBe("done")
    expect([...report.steps[0]!.removed].sort()).toEqual([done.id, t.id].sort())
    for (const id of [done.id, t.id]) {
      const x = await getTask(r, id)
      expect(x.boxId).toBeNull()
      expect(x.lastArchivedAt).toBeTruthy()
    }
    expect((await getTask(r, t.id)).status).not.toBe("working")
    expect((await boxes(r)).map((b) => b.id)).toContain(boxId)
  })
})
