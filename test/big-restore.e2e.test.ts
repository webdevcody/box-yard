import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxResize, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Restores never send one file over the box's upload limit. Upstash Box refuses a file over 100 MB ("file exceeds
// maximum size of 100 MB"), and a big workspace's archive used to go up in one piece, so a task moved to another
// box failed every start. Here the limit is a megabyte or so: archives and session files over it go up in parts,
// and an archive that still can't be restored gives way to a fresh checkout and a recap, once, not forever.

const KB = 1024
const MB = 1024 * KB
/** Upstash's own words. */
const TOO_BIG = "file exceeds maximum size of 100 MB"

/** Local boxes whose uploads are refused over `limit` bytes. `advertise`: the provider says so (like Upstash's maxUploadBytes). */
class LimitedProvider extends LocalProvider {
  readonly uploads: { dest: string; bytes: number; ok: boolean }[] = []
  maxUploadBytes?: number
  constructor(
    dir: string,
    claudeBin: string,
    readonly limit: number,
    advertise: boolean,
  ) {
    super(dir, claudeBin)
    if (advertise) this.maxUploadBytes = limit
  }
  async uploadFile(boxId: string, localPath: string, destination: string) {
    const bytes = fs.statSync(localPath).size
    const ok = bytes <= this.limit
    this.uploads.push({ dest: destination, bytes, ok })
    if (!ok) throw Object.assign(new Error(TOO_BIG), { statusCode: 400 })
    return super.uploadFile(boxId, localPath, destination)
  }
  /** Uploads of a task's archive during restores, whole or in parts. */
  restoreUploads(taskId: string) {
    return this.uploads.filter((u) => path.basename(u.dest).startsWith(`restore-${taskId}.tgz`))
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: LimitedProvider
  dataDir: string
}
const running: Running[] = []

async function start(o: { limit: number; advertise: boolean }, overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const c = testConfig({ port, maxBoxes: 3, ...overrides })
  const provider = new LimitedProvider(path.join(c.dataDir, "local-boxes"), c.claudeBin, o.limit, o.advertise)
  const yard = createBoxYard(c, { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider, dataDir: c.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running"), "resizes to settle").catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim()
const random = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)))

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
async function doneTask(r: Running, projectId: string, title: string) {
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "write a haiku" })
  const done = await waitFor(async () => {
    const x = await getTask(r, t.id)
    return x.status === "done" && x.lastArchivedAt && x.pendingCount === 0 ? x : null
  }, `task ${t.id} to finish and archive`)
  await new Promise((res) => setTimeout(res, 500))
  return done
}
const taskDir = (r: Running, boxId: string, id: string) => r.yard.tasks.taskDir(boxId, id)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const turnJson = (r: Running, boxId: string, id: string) => JSON.parse(fs.readFileSync(path.join(taskDir(r, boxId, id), "turn.json"), "utf8"))

/** Archive the task again now (its files changed after its turn-end archive). */
async function rearchive(r: Running, id: string) {
  r.yard.store.updateTask(id, { lastArchivedAt: 1 }, { touch: false })
  await r.yard.tasks.archive(id)
  const row = r.yard.store.getTaskRow(id)!
  expect(row.last_archived_at).toBeGreaterThan(1)
  return row.archive_path!
}
/** Take the task's folder off its box, as when it parks or its box goes: the next message restores it. */
function park(r: Running, t: Task) {
  r.yard.store.updateTask(t.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
  fs.rmSync(taskDir(r, t.boxId!, t.id), { recursive: true, force: true })
}
/** Send a message and wait for that turn to end. */
async function nextTurn(r: Running, id: string) {
  const before = (await getTask(r, id)).turnCount
  await call(r, "POST", `/api/tasks/${id}/messages`, { content: "one more haiku" })
  return waitFor(async () => {
    const t = await getTask(r, id)
    if (t.status === "failed") throw new Error(`task failed: ${t.error}`)
    return t.status === "done" && t.turnCount > before && t.pendingCount === 0 ? t : null
  }, `task ${id} to run again`, 60_000)
}
async function resize(r: Running, boxId: string): Promise<BoxResize> {
  await call(r, "POST", `/api/boxes/${boxId}/resize`, { size: "medium" })
  return waitFor(() => {
    const rep = r.yard.tasks.resizeReport(boxId)
    return rep && rep.status !== "running" ? rep : null
  }, `the resize of ${boxId}`, 60_000)
}
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes(".boxyard-part") || f.includes(".boxyard-join") || f.startsWith("restore-"))

describe("restores never send one file over the box's upload limit", () => {
  it("a big workspace moves to a new box and restores in parts", async () => {
    const r = await start({ limit: 1 * MB, advertise: true })
    const p = await call<Project>(r, "POST", "/api/projects", { name: "royale" })
    const t = await doneTask(r, p.id, "wipe lobby items")
    const big = random(2 * MB + 300 * KB)
    fs.writeFileSync(path.join(taskDir(r, t.boxId!, t.id), "work", "lobby.bin"), big)
    r.yard.store.updateTask(t.id, { lastArchivedAt: 1 }, { touch: false })

    const rep = await resize(r, t.boxId!)
    expect(rep.error).toBeNull()
    expect(rep.movedTasks).toEqual([t.id])
    expect(fs.statSync(r.yard.store.getTaskRow(t.id)!.archive_path!).size).toBeGreaterThan(2 * MB)

    const back = await nextTurn(r, t.id)
    expect(back.boxId).toBe(rep.newBoxId)
    expect(fs.readFileSync(path.join(taskDir(r, back.boxId!, t.id), "work", "lobby.bin")).equals(big)).toBe(true)
    const parts = r.provider.restoreUploads(t.id)
    expect(parts.length).toBe(3)
    expect(parts.every((u) => u.ok && u.bytes <= 1 * MB)).toBe(true)
    // Nothing over the limit went up at all, and nothing is left over on the box.
    expect(r.provider.uploads.every((u) => u.ok)).toBe(true)
    expect(leftovers(path.join(r.provider.root(back.boxId!), ".boxyard"))).toEqual([])
    expect(events(r, t.id)).toContain(`Workspace restored on box ${back.boxId}.`)
    expect(turnJson(r, back.boxId!, t.id).resume).toBe(true)
  })

  it("a Claude session file too big for one upload comes back whole and the session resumes", async () => {
    const r = await start({ limit: 1 * MB, advertise: true })
    const p = await call<Project>(r, "POST", "/api/projects", { name: "royale" })
    const t = await doneTask(r, p.id, "long session")
    const session = path.join(taskDir(r, t.boxId!, t.id), "claude", "projects", "-work", "session.jsonl")
    fs.mkdirSync(path.dirname(session), { recursive: true })
    // Incompressible, so the archive is as big as the session.
    const lines = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ i, blob: random(1500).toString("base64") })).join("\n") + "\n"
    fs.writeFileSync(session, lines)
    const archive = await rearchive(r, t.id)
    expect(fs.statSync(archive).size).toBeGreaterThan(1.5 * MB)
    park(r, t)

    const back = await nextTurn(r, t.id)
    const restored = path.join(taskDir(r, back.boxId!, t.id), "claude", "projects", "-work", "session.jsonl")
    expect(fs.readFileSync(restored, "utf8")).toBe(lines)
    expect(r.provider.restoreUploads(t.id).length).toBeGreaterThan(1)
    expect(r.provider.uploads.every((u) => u.ok)).toBe(true)
    expect(turnJson(r, back.boxId!, t.id).resume).toBe(true)
    expect(events(r, t.id).some((e) => e.startsWith("Resumed from a recap"))).toBe(false)
  })

  it("an archive that can't be uploaded restarts from a recap on the pushed branch and work, after one try", async () => {
    // The box refuses the archive and doesn't say its limit, so it can't be split: like the old single upload.
    const r = await start({ limit: 512 * KB, advertise: false })
    const root = tmpDir("box-yard-origin-")
    const bare = path.join(root, "origin.git")
    const seed = path.join(root, "seed")
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(root, "init", "-q", "-b", "main", seed)
    fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "init")
    git(seed, "push", "-q", bare, "main")
    // Pushes at turn end (file:// pushes in mock mode too), so origin gets the branch and the uncommitted work.
    const p = await call<Project>(r, "POST", "/api/projects", { name: "royale", pushAtTurnEnd: true })
    r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(`file://${bare}`, p.id)
    const t = await doneTask(r, p.id, "wipe lobby items")
    const work = path.join(taskDir(r, t.boxId!, t.id), "work")
    // A commit on the branch (pushed at the next archive) and uncommitted work on top (pushed as the WIP ref).
    fs.writeFileSync(path.join(work, "lobby.ts"), "export const wipe = false\n")
    git(work, "add", "lobby.ts")
    git(work, "commit", "-qm", "lobby")
    fs.writeFileSync(path.join(work, "lobby.ts"), "export const wipe = true\n")
    fs.writeFileSync(path.join(work, "notes.md"), "untracked\n")
    // An ignored file goes into the git-first archive and makes it too big to upload.
    fs.appendFileSync(path.join(work, ".git", "info", "exclude"), "trace.bin\n")
    fs.writeFileSync(path.join(work, "trace.bin"), random(1 * MB))
    const archive = await rearchive(r, t.id)
    expect(r.yard.store.getTask(t.id)!.pushState?.wip).toBeTruthy()
    expect(fs.statSync(archive).size).toBeGreaterThan(512 * KB)
    park(r, t)

    const back = await nextTurn(r, t.id)
    // One try: a file over the limit is refused the same way every time.
    expect(r.provider.restoreUploads(t.id)).toEqual([expect.objectContaining({ ok: false })])
    const moved = path.join(taskDir(r, back.boxId!, t.id), "work")
    expect(fs.readFileSync(path.join(moved, "lobby.ts"), "utf8")).toBe("export const wipe = true\n")
    expect(git(moved, "log", "-1", "--format=%s")).toBe("lobby")
    const status = git(moved, "status", "--porcelain").split("\n").map((l) => l.trim())
    expect(status).toContain("M lobby.ts")
    expect(status).toContain("?? notes.md")
    expect(fs.existsSync(path.join(moved, "trace.bin"))).toBe(false)

    const turn = turnJson(r, back.boxId!, t.id)
    expect(turn.resume).toBe(false)
    expect(turn.prompt).toContain(`Your old workspace couldn't be restored on this box (${TOO_BIG}), so it was set up again.`)
    expect(turn.prompt).toContain("The uncommitted changes from the end of your last turn were put back")
    const kept = path.join(r.dataDir, "archives", `${t.id}.unrestored.tgz`)
    expect(fs.existsSync(kept)).toBe(true)
    expect(events(r, t.id)).toContain(
      `Couldn't restore the workspace archive on box ${back.boxId} (${TOO_BIG}), so the task restarts from a recap on a fresh checkout of branch ${t.branch}, with the uncommitted work its last turn pushed. The archive is kept on the server as ${kept} (removed after 7 days).`,
    )
    expect(events(r, t.id)).toContain(`Resumed from a recap: its workspace archive couldn't be restored, so a new Claude session started on a fresh checkout of branch ${t.branch} with the task's summary, PR and recent messages.`)
    const notice = r.yard.store.listChat().find((m) => m.role === "notice" && m.content.includes("restarts from a recap"))
    expect(notice?.content).toMatch(new RegExp(`^⚠️ \\*\\*wipe lobby items\\*\\* restarts from a recap: its workspace archive couldn't be restored on box ${back.boxId} \\(${TOO_BIG}\\)`))
  })

  it("a restore that keeps failing is tried twice, then restarts from a recap, and never again", async () => {
    const r = await start({ limit: 1 * MB, advertise: true })
    const p = await call<Project>(r, "POST", "/api/projects", { name: "royale" })
    const t = await doneTask(r, p.id, "broken archive")
    // Not a gzip file: tar fails on every try.
    fs.writeFileSync(r.yard.store.getTaskRow(t.id)!.archive_path!, random(64 * KB))
    park(r, t)

    const back = await nextTurn(r, t.id)
    expect(r.provider.restoreUploads(t.id).length).toBe(2)
    expect(turnJson(r, back.boxId!, t.id).resume).toBe(false)
    expect(events(r, t.id).filter((e) => e.startsWith("Couldn't restore the workspace archive"))).toHaveLength(1)
    expect(fs.existsSync(path.join(r.dataDir, "archives", `${t.id}.unrestored.tgz`))).toBe(true)

    // The folder is there now: the next turn doesn't touch the old archive again.
    const again = await nextTurn(r, t.id)
    expect(again.boxId).toBe(back.boxId)
    expect(r.provider.restoreUploads(t.id).length).toBe(2)
    expect(turnJson(r, back.boxId!, t.id).resume).toBe(true)
    expect(events(r, t.id).filter((e) => e.startsWith("Couldn't restore the workspace archive"))).toHaveLength(1)
  })
})
