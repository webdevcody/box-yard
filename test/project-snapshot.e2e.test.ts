import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import type { BoxSnapshotInfo } from "../server/providers/types.js"
import { SCRATCH_MARKER } from "../server/boxSnapshot.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxEvent } from "../shared/boxHistory.js"
import type { SnapshotJob } from "../shared/snapshots.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { BoxInfo, BoxSize, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Per-project box snapshots (shared/snapshots.ts, server/boxSnapshot.ts): a box is snapshotted as it is, the copy is
// restored on a scratch box and stripped there, and new boxes for the project start from the stripped snapshot. The
// box itself never changes, nothing happens while agents run on it, and local-runner projects never use one.

/** Local boxes that log how they were made, can hold a snapshot, and can fail a restore. */
class SnapBoxes extends LocalProvider {
  created: { id: string; size: BoxSize; snapshotId: string | null }[] = []
  destroyed: string[] = []
  snapshots: string[] = []
  deletedSnapshots: string[] = []
  /** Holds every snapshot until resolved. */
  snapshotGate: Promise<void> | null = null
  /** Holds snapshots of a scratch box (one made from a snapshot) until resolved; `scratchHeld` says one is waiting. */
  scratchGate: Promise<void> | null = null
  scratchHeld = false
  /** Restores throw with this status code. */
  failRestore: number | null = null

  override async create(opts?: { labels: string[]; size?: BoxSize; snapshotId?: string }): Promise<string> {
    if (opts?.snapshotId && this.failRestore) throw Object.assign(new Error("restore exploded"), { statusCode: this.failRestore })
    const id = await super.create(opts)
    this.created.push({ id, size: opts?.size ?? "small", snapshotId: opts?.snapshotId ?? null })
    return id
  }
  override async destroy(boxId: string) {
    this.destroyed.push(boxId)
    return super.destroy(boxId)
  }
  override async snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    if (this.snapshotGate) await this.snapshotGate
    if (this.scratchGate && this.created.some((c) => c.id === boxId && c.snapshotId)) {
      this.scratchHeld = true
      await this.scratchGate
      this.scratchHeld = false
    }
    const info = await super.snapshot(boxId, name)
    this.snapshots.push(info.id)
    return info
  }
  override async deleteSnapshot(id: string) {
    this.deletedSnapshots.push(id)
    return super.deleteSnapshot(id)
  }
  /** The snapshots on disk now. */
  saved(): string[] {
    const dir = path.join(path.dirname(this.root("x")), ".snapshots")
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  }
  snapshotPath(id: string) {
    return path.join(path.dirname(this.root("x")), ".snapshots", id)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: SnapBoxes
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(overrides: Partial<Config> = {}, opts: { localRunner?: boolean } = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, maxBoxes: 3, ...overrides })
  const provider = new SnapBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(config, {
    webDir: "/nonexistent",
    provider,
    ...(opts.localRunner ? { localRunner: new LocalRunnerProvider(config.localDir, FAKE_CLAUDE) } : {}),
  })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.provider.snapshotGate = null
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => r.yard.store.listProjects().every((p) => r.yard.tasks.snapshotJob(p.id)?.status !== "running"), "snapshots to settle").catch(() => {})
    await waitFor(() => !r.yard.captains.anyBusy(), "captains to settle").catch(() => {})
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin over file:// with one commit on main. */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  return `file://${bare}`
}

const project = async (r: Running, name: string, extra: Record<string, unknown> = {}, repo?: string) => {
  const p = await call<Project>(r, "POST", "/api/projects", { name, ...extra })
  // The API only takes GitHub-style repos; point the project at the local origin instead.
  if (repo) r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(repo, p.id)
  return p
}
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return want(t) ? t : null
  }, what)
const settled = (r: Running, id: string) => status(r, id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pendingCount === 0, `task ${id} to finish and archive`)
const history = async (r: Running, boxId: string) => (await call<{ events: BoxEvent[] }>(r, "GET", `/api/box-history?boxId=${boxId}`)).events
const snapshotOf = (r: Running, projectId: string) => r.yard.store.getProject(projectId)!.snapshot
const takeSnapshot = (r: Running, projectId: string, boxId: string, reason?: string) =>
  send(r, "POST", `/api/projects/${projectId}/snapshot`, { boxId, ...(reason ? { reason } : {}) })
const finished = (r: Running, projectId: string) =>
  waitFor(() => {
    const j = r.yard.tasks.snapshotJob(projectId)
    return j && j.status !== "running" ? j : null
  }, `the snapshot for ${projectId} to finish`)
/** Delete a project's box so its next task needs a new one (Delete anyway: its workspaces hold uncommitted files). */
const dropBox = async (r: Running, boxId: string) => {
  await call(r, "DELETE", `/api/boxes/${boxId}?override=1`)
  await waitFor(() => !r.yard.store.getBox(boxId), `box ${boxId} to go`)
}

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
}

/** Write a file under `dir`, making its folders. */
function put(dir: string, rel: string, content = "x\n") {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const has = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel))

describe("taking a project snapshot", () => {
  it("strips a copy of the box (workspaces, other mirrors, logins, temp files and logs), keeps the rest, and never changes the box", async () => {
    const r = await start()
    const p = await project(r, "alpha", {}, origin())
    const t = await settled(r, (await task(r, p.id, "scaffold")).id)
    const src = t.boxId!
    const root = r.provider.root(src)
    const { home, tmp } = r.provider.snapshotDirs(src)
    const mirrors = fs.readdirSync(path.join(root, ".boxyard", "repos")).filter((n) => n.endsWith(".git"))
    expect(mirrors).toHaveLength(1)
    const mirror = mirrors[0]!

    // What a set-up box has besides the task: uncommitted work, another project's mirror, temp files, the dependency
    // and npm caches, a browser, logins and tokens, Claude sessions and shell history.
    const work = path.join(r.yard.tasks.taskDir(src, t.id), "work")
    put(work, "uncommitted.txt", "not committed anywhere\n")
    put(root, ".boxyard/repos/other.git/HEAD", "ref: refs/heads/main\n")
    put(root, ".boxyard/repos/other.git.lock", "")
    put(root, ".boxyard/tmp/junk.txt")
    put(root, ".boxyard/deps/npm/abc123/node_modules/left-pad/index.js", "module.exports = 1\n")
    put(home, ".git-credentials", "https://x:ghp_secret@github.com\n")
    put(home, ".config/gh/hosts.yml", "github.com:\n  oauth_token: gho_secret\n")
    put(home, ".claude/.credentials.json", "{}")
    put(home, ".claude/projects/session.jsonl", "{}")
    put(home, ".claude/settings.json", "{}")
    put(root, ".claude/.credentials.json", "{}")
    put(home, ".npmrc", "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_secret\n")
    put(home, ".bash_history", "ls\n")
    put(home, ".cache/ms-playwright/chromium-1/chrome", "#!/bin/sh\n")
    put(tmp, "scratch.log")
    put(tmp, ".npm-cache/content-v2/x", "cached\n")
    put(tmp, ".npm-cache/_logs/debug.log")

    const started = await takeSnapshot(r, p.id, src, "Scaffold set up the repo, npm ci and Chrome")
    expect(started.status).toBe(202)
    expect(started.data).toMatchObject({ status: "running", projectId: p.id, boxId: src, size: "small", by: { kind: "cody" } })
    const job = await finished(r, p.id)
    expect(job.error).toBeNull()
    expect(job.status).toBe("done")
    expect(job.steps.map((s) => [s.key, s.status])).toEqual([
      ["snapshot", "done"],
      ["restore", "done"],
      ["strip", "done"],
      ["save", "done"],
      ["cleanup", "done"],
    ])
    const snap = snapshotOf(r, p.id)!
    expect(snap).toMatchObject({ id: job.snapshotId, provider: "local", size: "small", boxId: src })
    // The first snapshot and the scratch box are gone; only the project's snapshot is left.
    expect(r.provider.saved()).toEqual([snap.id])
    expect(r.provider.snapshots).toHaveLength(2)
    expect(r.provider.destroyed).toEqual([job.scratchBoxId])
    expect(r.yard.store.getBox(job.scratchBoxId!)).toBeFalsy()

    // The snapshot: no task folders, other mirrors, logins, sessions or temp files; the rest is there.
    const s = r.provider.snapshotPath(snap.id)
    const sHome = path.join(s, "home")
    const sTmp = path.join(s, "tmp")
    expect(fs.readdirSync(path.join(s, "tasks"))).toEqual([])
    expect(fs.readdirSync(path.join(s, ".boxyard", "repos")).filter((n) => !n.endsWith(".lock"))).toEqual([mirror])
    for (const gone of [".boxyard/tmp/junk.txt", ".claude/.credentials.json", SCRATCH_MARKER]) expect(has(s, gone), gone).toBe(false)
    for (const gone of [".git-credentials", ".config/gh/hosts.yml", ".claude/.credentials.json", ".claude/projects", ".bash_history"]) expect(has(sHome, gone), gone).toBe(false)
    for (const gone of ["scratch.log", ".npm-cache/_logs"]) expect(has(sTmp, gone), gone).toBe(false)
    expect(has(s, ".boxyard/deps/npm/abc123/node_modules/left-pad/index.js")).toBe(true)
    expect(has(sHome, ".claude/settings.json")).toBe(true)
    expect(has(sHome, ".cache/ms-playwright/chromium-1/chrome")).toBe(true)
    expect(has(sTmp, ".npm-cache/content-v2/x")).toBe(true)
    expect(fs.readFileSync(path.join(sHome, ".npmrc"), "utf8")).toBe("registry=https://registry.npmjs.org/\n")

    // The box itself is as it was, uncommitted work and all, and takes work again.
    expect(fs.readFileSync(path.join(work, "uncommitted.txt"), "utf8")).toBe("not committed anywhere\n")
    for (const kept of [".boxyard/repos/other.git/HEAD", ".boxyard/tmp/junk.txt", ".claude/.credentials.json"]) expect(has(root, kept), kept).toBe(true)
    expect(has(home, ".git-credentials")).toBe(true)
    expect(fs.readFileSync(path.join(home, ".npmrc"), "utf8")).toContain("_authToken")
    expect(has(tmp, "scratch.log")).toBe(true)
    expect((await call<BoxInfo[]>(r, "GET", "/api/boxes")).find((b) => b.id === src)?.operation).toBeNull()

    // The history: the snapshot on the box with who and why, and the scratch box's create and delete.
    const ev = (await history(r, src)).find((e) => e.type === "snapshot")!
    expect(ev).toMatchObject({ actor: "owner", reason: "Scaffold set up the repo, npm ci and Chrome", size: "small", relatedBoxId: job.scratchBoxId })
    expect(ev.detail).toContain(`Saved as alpha's snapshot ${snap.id}: new boxes for it start from it. Removed 1 workspace, 1 other repo mirror, 5 logins and tokens and`)
    expect(ev.detail).toContain(`kept the ${mirror} mirror and 1 dependency cache entry.`)
    const scratchEvents = (await history(r, job.scratchBoxId!)).filter((e) => e.boxId === job.scratchBoxId)
    expect(scratchEvents.map((e) => [e.type, e.actor, e.relatedBoxId])).toEqual([
      ["deleted", "snapshot", src],
      ["created", "snapshot", src],
    ])
    const notice = r.yard.store.listCaptainMessages(p.id, 50).find((m) => m.role === "notice" && m.content.startsWith("📦"))
    expect(notice?.content).toContain(`📦 **alpha** snapshot saved: Cody snapshotted box ${src} (small). New alpha boxes of small or bigger now start from snapshot ${snap.id}`)
    expect(r.yard.store.listNotifications().find((n) => n.boxId === src)).toMatchObject({ title: "Snapshot saved for alpha", href: `/projects/${p.id}?tab=settings` })

    // A new box for the project (a bigger one now) starts from it: the repo mirror and the browser are already there.
    await call(r, "PATCH", `/api/projects/${p.id}`, { boxSize: "medium" })
    await dropBox(r, src)
    const t2 = await settled(r, (await task(r, p.id, "fan out")).id)
    const fresh = r.provider.created.find((c) => c.id === t2.boxId)
    expect(fresh).toMatchObject({ size: "medium", snapshotId: snap.id })
    const created = (await history(r, t2.boxId!)).find((e) => e.type === "created")!
    expect(created).toMatchObject({ actor: "scheduler", size: "medium" })
    expect(created.detail).toBe(`From alpha's snapshot ${snap.id}, taken from box ${src} (small).`)
    const freshRoot = r.provider.root(t2.boxId!)
    expect(has(path.join(freshRoot, ".boxyard", "repos"), mirror)).toBe(true)
    expect(has(r.provider.snapshotDirs(t2.boxId!).home, ".cache/ms-playwright/chromium-1/chrome")).toBe(true)
    expect(fs.readFileSync(path.join(r.yard.tasks.taskDir(t2.boxId!, t2.id), "work", "README.md"), "utf8")).toBe("hello\n")
    // Nothing of the old task came along.
    expect(fs.readdirSync(path.join(freshRoot, "tasks"))).toEqual([t2.id])
  })

  it("refuses while an agent runs on the box, for a box without the project's work, and twice at once", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const hang = await task(r, p.id, "long one", "think for a while [hang]")
    const working = await status(r, hang.id, (x) => x.status === "working", "the agent to start working")
    const boxId = working.boxId!

    const busy = await takeSnapshot(r, p.id, boxId)
    expect(busy.status).toBe(409)
    expect(busy.data.error).toBe(`1 agent is running on ${boxId}: stop it first.`)
    expect(r.yard.tasks.snapshotJob(p.id)).toBeNull()
    expect(r.provider.snapshots).toEqual([])
    expect((await getTask(r, hang.id)).status).toBe("working")

    const other = await project(r, "beta")
    const notHers = await takeSnapshot(r, other.id, boxId)
    expect(notHers.status).toBe(400)
    expect(notHers.data.error).toContain(`Box ${boxId} doesn't hold beta's work`)

    await r.yard.tasks.stopTask(hang.id)
    await status(r, hang.id, (x) => x.status !== "working", "the agent to stop")
    // Held at the first snapshot: the box takes no work, a second snapshot and a Clear wait for it.
    let release!: () => void
    r.provider.snapshotGate = new Promise((res) => (release = res))
    expect((await takeSnapshot(r, p.id, boxId)).status).toBe(202)
    expect((await call<BoxInfo[]>(r, "GET", "/api/boxes")).find((b) => b.id === boxId)?.operation).toBe("snapshot")
    await call(r, "POST", `/api/tasks/${hang.id}/messages`, { content: "carry on" })
    await status(r, hang.id, (x) => x.waitReason === `Waiting while box ${boxId} is snapshotted`, "the task to wait for the snapshot")
    const twice = await takeSnapshot(r, p.id, boxId)
    expect(twice.status).toBe(409)
    expect(twice.data.error).toBe("A snapshot for alpha is already being taken.")
    expect((await send(r, "DELETE", `/api/projects/${p.id}/snapshot`)).status).toBe(409)
    const view = await call<{ snapshot: null; job: SnapshotJob }>(r, "GET", `/api/projects/${p.id}/snapshot`)
    expect(view.snapshot).toBeNull()
    expect(view.job.steps[0]).toMatchObject({ key: "snapshot", status: "running" })
    release()
    expect((await finished(r, p.id)).status).toBe("done")
    // The waiting task runs once the box is free again.
    await status(r, hang.id, (x) => x.turnCount === 2 && x.waitReason === null, "the task to run again")
  })

  it("replaces the old snapshot and deletes it, and Clear deletes the snapshot and makes new boxes cold", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "scaffold")).id)
    await takeSnapshot(r, p.id, t.boxId!)
    const first = (await finished(r, p.id)).snapshotId!
    expect(r.provider.saved()).toEqual([first])

    await takeSnapshot(r, p.id, t.boxId!, "Chrome installed now")
    const second = await finished(r, p.id)
    expect(second.status).toBe("done")
    expect(second.steps.find((s) => s.key === "save")?.detail).toContain(`deleted the previous snapshot ${first}`)
    expect(snapshotOf(r, p.id)?.id).toBe(second.snapshotId)
    expect(r.provider.saved()).toEqual([second.snapshotId])
    expect(r.provider.deletedSnapshots).toContain(first)

    const cleared = await call<Project>(r, "DELETE", `/api/projects/${p.id}/snapshot`)
    expect(cleared.snapshot).toBeNull()
    expect(snapshotOf(r, p.id)).toBeNull()
    expect(r.provider.saved()).toEqual([])
    // Clearing again is fine.
    expect((await call<Project>(r, "DELETE", `/api/projects/${p.id}/snapshot`)).snapshot).toBeNull()

    await dropBox(r, t.boxId!)
    const t2 = await settled(r, (await task(r, p.id, "after clear")).id)
    expect(r.provider.created.find((c) => c.id === t2.boxId)?.snapshotId).toBeNull()
    expect((await history(r, t2.boxId!)).some((e) => e.type === "snapshot_fallback")).toBe(false)
  })

  it("deletes a project's snapshot with the project", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "scaffold")).id)
    await takeSnapshot(r, p.id, t.boxId!)
    const id = (await finished(r, p.id)).snapshotId!
    await call(r, "DELETE", `/api/projects/${p.id}`)
    expect(r.yard.store.getProject(p.id)).toBeFalsy()
    expect(r.provider.saved()).toEqual([])
    expect(r.provider.deletedSnapshots).toContain(id)
  })
})

describe("new boxes from a snapshot", () => {
  const fake = (size: BoxSize, id = "local-snap-seeded01") => ({ id, provider: "local", size, boxId: "local-old", bytes: null, takenAt: Date.now() })

  it("starts a box smaller than the snapshot cold, says so in the history, and tells the Captain once", async () => {
    const r = await start()
    const p = await project(r, "alpha", { boxSize: "small" })
    r.yard.store.setProjectSnapshot(p.id, fake("medium"))
    const t = await settled(r, (await task(r, p.id, "first")).id)
    expect(r.provider.created).toEqual([{ id: t.boxId, size: "small", snapshotId: null }])
    const fallback = (await history(r, t.boxId!)).find((e) => e.type === "snapshot_fallback")!
    expect(fallback).toMatchObject({ actor: "scheduler", reason: "New box for alpha, which has a snapshot." })
    expect(fallback.detail).toBe("Started cold: snapshot local-snap-seeded01 was taken on a medium box and might not fit a small one (replace it from a small box to use it there).")
    expect((await history(r, t.boxId!)).find((e) => e.type === "created")?.detail).toBe(fallback.detail)
    const warned = () => r.yard.store.listCaptainMessages(p.id, 50).filter((m) => m.role === "notice" && m.content.startsWith("⚠️ **alpha** snapshot not used"))
    expect(warned()).toHaveLength(1)
    expect(snapshotOf(r, p.id)?.id).toBe("local-snap-seeded01")

    // The next box is cold too, in the history, without a second warning.
    await dropBox(r, t.boxId!)
    const t2 = await settled(r, (await task(r, p.id, "second")).id)
    expect((await history(r, t2.boxId!)).some((e) => e.type === "snapshot_fallback")).toBe(true)
    expect(warned()).toHaveLength(1)
  })

  it("falls back to a cold box when a restore fails, keeps the snapshot, and clears one the provider no longer has", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "scaffold")).id)
    await takeSnapshot(r, p.id, t.boxId!)
    const id = (await finished(r, p.id)).snapshotId!
    await dropBox(r, t.boxId!)

    r.provider.failRestore = 500
    const t2 = await settled(r, (await task(r, p.id, "restore fails")).id)
    expect(r.provider.created.find((c) => c.id === t2.boxId)?.snapshotId).toBeNull()
    const fallback = (await history(r, t2.boxId!)).find((e) => e.type === "snapshot_fallback")!
    expect(fallback.detail).toBe(`Started cold: restoring snapshot ${id} failed (restore exploded).`)
    expect(snapshotOf(r, p.id)?.id).toBe(id)
    const warned = () => r.yard.store.listCaptainMessages(p.id, 50).filter((m) => m.role === "notice" && m.content.startsWith("⚠️ **alpha** snapshot not used"))
    expect(warned().map((m) => m.content)).toEqual([`⚠️ **alpha** snapshot not used: box ${t2.boxId} started cold because restoring snapshot ${id} failed (restore exploded).`])

    // Gone at the provider: the box starts cold and the project forgets it.
    r.provider.failRestore = null
    fs.rmSync(r.provider.snapshotPath(id), { recursive: true, force: true })
    await dropBox(r, t2.boxId!)
    const t3 = await settled(r, (await task(r, p.id, "snapshot gone")).id)
    const gone = (await history(r, t3.boxId!)).find((e) => e.type === "snapshot_fallback")!
    expect(gone.detail).toBe(`Started cold: restoring snapshot ${id} failed (snapshot ${id} not found); the provider no longer has it, so it was cleared from the project.`)
    expect(snapshotOf(r, p.id)).toBeNull()
    expect(warned()).toHaveLength(2)
  })
})

describe("box creation during a snapshot", () => {
  it("doesn't count the snapshot's scratch box against Boxes created at once", async () => {
    const r = await start({ boxCreateConcurrency: 1 })
    const alpha = await project(r, "alpha")
    const t = await settled(r, (await task(r, alpha.id, "scaffold")).id)
    // Held while the scratch box exists, which can take minutes on Upstash.
    let release!: () => void
    r.provider.scratchGate = new Promise((res) => (release = res))
    expect((await takeSnapshot(r, alpha.id, t.boxId!)).status).toBe(202)
    await waitFor(() => r.provider.scratchHeld, "the snapshot to hold its scratch box")

    // Another project's task still gets its box, with only one create allowed at a time.
    const beta = await project(r, "beta")
    const b = await settled(r, (await task(r, beta.id, "docs")).id)
    expect(b.boxId).not.toBe(t.boxId)
    expect(r.yard.tasks.poolLimits().boxesCreating).toMatchObject({ now: 0, atOnce: 1 })
    expect(r.yard.tasks.snapshotJob(alpha.id)?.status).toBe("running")
    release()
    expect((await finished(r, alpha.id)).status).toBe("done")
  })
})

describe("local-runner projects", () => {
  it("can't be snapshotted and never start from one", async () => {
    const r = await start({}, { localRunner: true })
    const boxed = await project(r, "boxed")
    const t = await settled(r, (await task(r, boxed.id, "on a box")).id)
    const mac = await project(r, "mac", { runner: "local" })
    const refused = await takeSnapshot(r, mac.id, t.boxId!)
    expect(refused.status).toBe(400)
    expect(refused.data.error).toBe("mac runs on this computer, so it has no boxes to snapshot.")
    expect((await takeSnapshot(r, boxed.id, LOCAL_BOX_ID)).status).toBe(400)

    // A snapshot left from before it moved to this computer is never used.
    r.yard.store.setProjectSnapshot(mac.id, { id: "local-snap-seeded01", provider: "local", size: "small", boxId: t.boxId!, bytes: null, takenAt: Date.now() })
    const created = r.provider.created.length
    const lt = await status(r, (await task(r, mac.id, "local work")).id, (x) => x.status === "done", "the local task to finish")
    expect(lt.boxId).toBe(LOCAL_BOX_ID)
    expect(r.provider.created).toHaveLength(created)

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator("snapshot_box", { box: LOCAL_BOX_ID, project: mac.id })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain(`No box "${LOCAL_BOX_ID}"`)
  })
})

describe("snapshot_box over MCP", () => {
  it("scopes Captains to their own project's boxes and tells the Captain when it's saved", async () => {
    const r = await start()
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const ta = await settled(r, (await task(r, a.id, "alpha work")).id)
    const tb = await settled(r, (await task(r, b.id, "beta work")).id)
    expect(ta.boxId).not.toBe(tb.boxId)

    const captainA = await mcpAs(r, { kind: "captain", projectId: a.id })
    const other = await captainA("snapshot_box", { box: tb.boxId, reason: "beta looks set up" })
    expect(other.isError).toBe(true)
    expect(other.content[0]!.text).toContain(`Out of scope: box ${tb.boxId} doesn't host project "alpha"`)
    const named = await captainA("snapshot_box", { box: tb.boxId, project: b.id })
    expect(named.isError).toBe(true)
    expect(named.content[0]!.text).toContain("Out of scope")
    expect(r.yard.tasks.snapshotJob(b.id)).toBeNull()

    const own = await captainA("snapshot_box", { box: ta.boxId, reason: "Scaffold task set up the repo and tools" })
    expect(own.isError).toBeFalsy()
    expect(JSON.parse(own.content[0]!.text)).toMatchObject({ started: true, project: "alpha", box: ta.boxId, size: "small" })
    const job = await finished(r, a.id)
    expect(job).toMatchObject({ status: "done", by: { kind: "captain", projectId: a.id }, reason: "Scaffold task set up the repo and tools" })
    const ev = (await history(r, ta.boxId!)).find((e) => e.type === "snapshot")!
    expect(ev).toMatchObject({ actor: "captain", actorProjectId: a.id })
    const notice = r.yard.store.listCaptainMessages(a.id, 50).find((m) => m.role === "notice" && m.content.startsWith("📦"))
    expect(notice?.content).toContain("📦 **alpha** snapshot saved: The alpha Captain snapshotted box")
    expect(notice?.content).toContain("Reason: Scaffold task set up the repo and tools")

    // The Coordinator: the box's only project is the default, and list_projects shows the snapshot.
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator("snapshot_box", { box: tb.boxId, reason: "beta is set up" })
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ started: true, project: "beta", box: tb.boxId })
    expect((await finished(r, b.id)).by).toEqual({ kind: "coordinator" })
    const projects = JSON.parse((await coordinator("list_projects")).content[0]!.text) as { name: string; snapshot?: string }[]
    expect(projects.find((x) => x.name === "beta")?.snapshot).toMatch(new RegExp(`^${snapshotOf(r, b.id)!.id}, taken from box ${tb.boxId} \\(small\\) .*: new boxes of small or bigger start from it$`))
  })
})
