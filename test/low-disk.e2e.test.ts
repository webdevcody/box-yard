import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { ExecResult } from "../server/providers/types.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxCleanup, BoxInfo, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"
import { diskLine, rootLow } from "../shared/disk.js"
import { diskMeter } from "../web/src/lib/diskCleanup.js"
import { boxAttention } from "../web/src/lib/boxOverview.js"

// Low disk: a box without room for a new workspace is skipped (and cleaned up in
// the background), a setup that runs out of space is cleaned up and retried once,
// and cleanup goes step by step without touching anyone's uncommitted work.

const MB = 1024 * 1024
const GB = 1024 * MB

/** Disk a folder uses. A `*.ballast` file counts as the byte size written in it, so tests can fake big folders. */
function used(file: string): number {
  const st = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!st) return 0
  if (!st.isDirectory()) return file.endsWith(".ballast") ? Number(fs.readFileSync(file, "utf8")) || 0 : st.size
  let total = 0
  for (const e of fs.readdirSync(file)) total += used(path.join(file, e))
  return total
}
const ballast = (dir: string, bytes: number) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "big.ballast"), String(bytes))
}

/** Local boxes with a pretend disk: df reports `capacity` minus what the box folder uses. */
class DiskBoxes extends LocalProvider {
  capacity = new Map<string, number>()
  /** Fail this many workspace setups with git's out-of-space error. */
  failSetups = 0
  /** A failed setup also leaves its box this full. */
  fullOnFail = 0
  /** Holds the runner's clean mode until released, to watch a task wait for cleanup. */
  gate: Promise<void> | null = null

  /** Boxes whose root disk (/tmp, HOME) is another filesystem: its capacity; what's in <root>/.boxyard/tmp uses it. */
  rootCapacity = new Map<string, number>()

  /** Make a box's disk show `free` bytes free right now. */
  fill(boxId: string, free: number) {
    this.capacity.set(boxId, used(this.root(boxId)) + free)
  }

  /** Give a box a separate root disk with `free` bytes free right now. */
  fillRoot(boxId: string, free: number) {
    this.rootCapacity.set(boxId, used(this.stageDir(boxId)) + free)
  }

  stageDir(boxId: string) {
    return path.join(this.root(boxId), ".boxyard", "tmp")
  }

  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk")) {
      const u = used(this.root(boxId))
      const total = this.capacity.get(boxId) ?? u + 50 * GB
      const kb = (n: number) => Math.floor(Math.max(0, n) / 1024)
      const rootTotal = this.rootCapacity.get(boxId)
      const ru = rootTotal === undefined ? 0 : used(this.stageDir(boxId))
      const rootLine = rootTotal === undefined ? "" : `@@boxyard-root-df\nfakeroot ${kb(rootTotal)} ${kb(ru)} ${kb(rootTotal - ru)} 90% /\n`
      return { exitCode: 0, stdout: `fakefs ${kb(total)} ${kb(u)} ${kb(total - u)} 50% ${this.root(boxId)}\n${rootLine}`, stderr: "" }
    }
    if (this.gate && command.includes(" clean ")) await this.gate
    if (this.failSetups > 0 && command.startsWith("mkdir -p") && /rm -rf '[^']*\/work'/.test(command)) {
      this.failSetups--
      if (this.fullOnFail) this.fill(boxId, this.fullOnFail)
      return { exitCode: 128, stdout: "", stderr: "Cloning into 'work'... fatal: sha1 file 'work/.git/objects/pack/tmp_pack_td8Dik' write error. Out of diskspace\nfatal: cannot repack to clean up just now" }
    }
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: DiskBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new DiskBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, diskMinFreeMb: 500, ...overrides }), { webDir: "/nonexistent", provider })
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
    // Let cleanups that are still going finish before the database closes.
    await waitFor(() => r.yard.store.listBoxes().every((b) => !r.yard.tasks.janitor.isRunning(b.id)), "cleanups to settle").catch(() => {})
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
const until = (r: Running, id: string, status: Task["status"], timeoutMs?: number) =>
  waitFor(
    async () => {
      const t = await getTask(r, id)
      return t.status === status && t.pendingCount === 0 ? t : null
    },
    `task ${id} to be ${status}`,
    timeoutMs,
  )
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const cleanupDone = (r: Running, boxId: string) =>
  waitFor(() => {
    const c = r.yard.tasks.janitor.current(boxId)
    return c && c.status !== "running" && !r.yard.tasks.janitor.isRunning(boxId) ? c : null
  }, `cleanup on ${boxId} to finish`)
/** A done task whose archive and post-turn cleanup are finished, so the test can stage files in its folder. */
const settled = async (r: Running, id: string) => {
  const t = await waitFor(async () => {
    const x = await getTask(r, id)
    return x.status === "done" && x.lastArchivedAt ? x : null
  }, `task ${id} to finish and archive`)
  await new Promise((res) => setTimeout(res, 800))
  return t
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" })

describe("low-disk placement", () => {
  it("puts a task on a new box when its project's box is low, and cleans the low box up in the background", async () => {
    const r = await start({ maxBoxes: 2, archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const first = await until(r, (await task(r, p.id, "first")).id, "done")
    const low = first.boxId!
    r.provider.fill(low, 100 * MB)
    await r.yard.tasks.probeDisk(low, 0)

    const second = await until(r, (await task(r, p.id, "second")).id, "done")
    expect(second.boxId).toBeTruthy()
    expect(second.boxId).not.toBe(low)
    expect(events(r, second.id)).toContain(`Waiting for a new box: ${low} is low on disk.`)

    const cleanup = await cleanupDone(r, low)
    expect(cleanup.reason).toBe("low-disk")
    expect(cleanup.targetFreeBytes).toBe(500 * MB)
    const info = (await boxes(r)).find((b) => b.id === low)!
    expect(info.diskFreeBytes).toBeLessThan(500 * MB)
    expect(info.diskTotalBytes).toBeGreaterThan(0)
    expect(info.diskLow).toBe(true)
    expect(info.cleanup?.boxId).toBe(low)
    expect(info.diskCheckedAt).toBeGreaterThan(0)
    // The Boxes page, pool_status and the notice state the same df reading the same way.
    const stated = diskLine({ freeBytes: info.diskFreeBytes, totalBytes: info.diskTotalBytes })
    expect(diskMeter(info)!.label).toBe(stated)
    const notice = await waitFor(() => r.yard.store.listChat().find((m) => m.role === "notice" && m.content.includes(`Box ${low} is low on disk`)), "the low-disk notice")
    expect(notice.content).toContain(`it has ${stated} · measured`)
  })

  it("puts a task on another existing box with room before waiting", async () => {
    const r = await start({ maxBoxes: 2, archiveWorkspaces: false })
    const a = await project(r, "alpha")
    const b = await project(r, "beta")
    const a1 = await until(r, (await task(r, a.id, "a1")).id, "done")
    const b1 = await until(r, (await task(r, b.id, "b1")).id, "done")
    expect(b1.boxId).not.toBe(a1.boxId)
    // The pool is full now; alpha's box is low, beta's has room.
    r.provider.fill(a1.boxId!, 50 * MB)
    await r.yard.tasks.probeDisk(a1.boxId!, 0)
    const a2 = await until(r, (await task(r, a.id, "a2")).id, "done")
    expect(a2.boxId).toBe(b1.boxId)
  })

  it("waits with a visible status when no box has room, and starts once the cleanup frees it", async () => {
    const r = await start({ maxBoxes: 1, archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const first = await until(r, (await task(r, p.id, "first")).id, "done")
    const box = first.boxId!
    const work = path.join(r.yard.tasks.taskDir(box, first.id), "work")
    // 600 MB of dependencies a cleanup can drop, next to work that must stay.
    ballast(path.join(work, "node_modules", "huge"), 600 * MB)
    fs.writeFileSync(path.join(work, "notes.md"), "keep me\n")
    r.provider.fill(box, 100 * MB)
    await r.yard.tasks.probeDisk(box, 0)

    let release!: () => void
    r.provider.gate = new Promise<void>((res) => (release = res))
    const second = await task(r, p.id, "second")
    const waiting = await waitFor(async () => {
      const t = await getTask(r, second.id)
      return t.status === "queued" && t.waitReason ? t : null
    }, "the task to wait for cleanup")
    expect(waiting.waitReason).toBe(`Waiting for disk cleanup on ${box}`)
    expect(waiting.error).toBeNull()

    release()
    const done = await until(r, second.id, "done")
    expect(done.boxId).toBe(box)
    expect(done.waitReason).toBeNull()
    const cleanup = await cleanupDone(r, box)
    const builds = cleanup.steps.find((s) => s.key === "builds")!
    expect(builds.freedBytes).toBeGreaterThanOrEqual(600 * MB)
    expect(cleanup.enough).toBe(true)
    // It stopped once there was room: nothing after the builds step ran.
    expect(cleanup.steps.filter((s) => s.key === "git" || s.key === "archive").every((s) => s.skipped === "enough room already")).toBe(true)
    expect(fs.existsSync(path.join(work, "node_modules"))).toBe(false)
    expect(fs.readFileSync(path.join(work, "notes.md"), "utf8")).toBe("keep me\n")
  })
})

describe("out of space during setup", () => {
  it("cleans up and retries once, then the task runs", async () => {
    const r = await start({ maxBoxes: 1, archiveWorkspaces: false })
    r.provider.failSetups = 1
    const p = await project(r, "alpha")
    const t = await until(r, (await task(r, p.id, "retry me")).id, "done")
    expect(t.error).toBeNull()
    const ev = events(r, t.id)
    expect(ev.some((e) => e.startsWith(`Box ${t.boxId} ran out of disk space while setting up the workspace. Cleaning it up and retrying once`))).toBe(true)
    expect(ev.some((e) => e.startsWith("Couldn't start the agent"))).toBe(false)
    const cleanup = await cleanupDone(r, t.boxId!)
    expect(cleanup.reason).toBe("out-of-space")
  })

  it("retries on another box when the one that ran out is still full", async () => {
    const r = await start({ maxBoxes: 2, archiveWorkspaces: false })
    r.provider.failSetups = 1
    r.provider.fullOnFail = 10 * MB
    const p = await project(r, "alpha")
    const created = await task(r, p.id, "move me")
    const firstBox = await waitFor(() => r.yard.store.listBoxes().find((b) => b.status === "ready")?.id, "the first box")
    const t = await until(r, created.id, "done")
    expect(t.boxId).not.toBe(firstBox)
    expect(events(r, t.id).some((e) => e.includes("on another box if one has room"))).toBe(true)
  })

  it("fails with a clear message when the retry runs out of space too", async () => {
    const r = await start({ maxBoxes: 1, archiveWorkspaces: false })
    r.provider.failSetups = 2
    const p = await project(r, "alpha")
    const t = await until(r, (await task(r, p.id, "still full")).id, "failed")
    expect(t.error).toMatch(/^Couldn't start the agent: box \S+ is out of disk space \(.+ free of .+\), even after cleaning it up and retrying\./)
    expect(t.error).toContain("Out of diskspace")
  })
})

describe("box cleanup", () => {
  it("goes step by step, stops once there is room, and never touches uncommitted work", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await project(r, "alpha")
    const done = await settled(r, (await task(r, p.id, "done one")).id)
    const idle = await settled(r, (await task(r, p.id, "idle one")).id)
    const box = done.boxId!
    expect(idle.boxId).toBe(box)
    r.yard.store.updateTask(idle.id, { status: "idle" })

    // The idle task: a repo with uncommitted edits, an untracked file, an untracked
    // (not ignored) dist/ and ignored node_modules.
    const repo = path.join(r.yard.tasks.taskDir(box, idle.id), "work", "app")
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), content)
    }
    write(".gitignore", "node_modules/\n")
    write("src/a.ts", "v1\n")
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    write("src/a.ts", "v2 uncommitted\n")
    write("src/new.ts", "untracked\n")
    write("dist/out.js", "untracked build output, not ignored\n")
    ballast(path.join(repo, "node_modules", "dep"), 300 * MB)
    // The done task's dependencies, and a folder a deleted task left behind.
    ballast(path.join(r.yard.tasks.taskDir(box, done.id), "work", "node_modules", "dep"), 200 * MB)
    ballast(path.join(r.yard.tasks.taskDir(box, "task_gone"), "work"), 100 * MB)

    // Low, but not so low that the emergency steps go first (that's below).
    const free = 150 * MB
    r.provider.fill(box, free)
    // Enough once the leftover folder and the done task's dependencies are gone.
    const first = await r.yard.tasks.janitor.run(box, { reason: "low-disk", target: free + 250 * MB, parkBelow: free + 250 * MB })
    expect(first.steps.map((s) => s.key)).toEqual(["tmp", "partials", "caches", "builds", "git", "archive"])
    const step = (c: BoxCleanup, key: string) => c.steps.find((s) => s.key === key)!
    expect(step(first, "tmp").skipped).toBe("no stale temp folders (a local box's /tmp is this machine's, so it's left alone)")
    expect(step(first, "partials").removed).toContain("task_gone (unknown task)")
    expect(step(first, "partials").freedBytes).toBeGreaterThanOrEqual(100 * MB)
    expect(step(first, "caches").skipped).toBe("local boxes share this machine's caches")
    // Done tasks go first, and it stopped before the idle task once there was room.
    expect(step(first, "builds").removed).toEqual([`${done.id}: 1 dir`])
    expect(step(first, "builds").freedBytes).toBeGreaterThanOrEqual(200 * MB)
    expect(step(first, "archive").skipped).toBe("enough room already")
    expect(first.enough).toBe(true)
    expect(first.freedBytes).toBe(first.steps.reduce((n, s) => n + s.freedBytes, 0))
    expect(fs.existsSync(path.join(repo, "node_modules"))).toBe(true)

    // A bigger target: the idle task's ignored deps go, then the done workspace is parked.
    const second = await r.yard.tasks.janitor.run(box, { reason: "low-disk", target: 10 * GB, parkBelow: 10 * GB })
    expect(step(second, "builds").removed).toEqual([`${idle.id}: 1 dir`])
    expect(step(second, "archive").removed).toEqual([done.id])
    expect(second.enough).toBe(false)
    expect((await getTask(r, done.id)).boxId).toBeNull()
    expect(fs.existsSync(r.yard.tasks.taskDir(box, done.id))).toBe(false)
    expect(r.yard.tasks.resumeMode(done.id)).toBe("archive")

    // The idle task's work is all still there.
    expect((await getTask(r, idle.id)).boxId).toBe(box)
    expect(fs.existsSync(path.join(repo, "node_modules"))).toBe(false)
    expect(fs.readFileSync(path.join(repo, "src/a.ts"), "utf8")).toBe("v2 uncommitted\n")
    expect(fs.readFileSync(path.join(repo, "src/new.ts"), "utf8")).toBe("untracked\n")
    expect(fs.readFileSync(path.join(repo, "dist/out.js"), "utf8")).toBe("untracked build output, not ignored\n")
  })

  it("never parks a done workspace that has no fresh archive", async () => {
    const r = await start({ maxBoxes: 1, archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const done = await until(r, (await task(r, p.id, "only copy")).id, "done")
    const report = await r.yard.tasks.janitor.run(done.boxId!, { reason: "low-disk", target: 10 * GB, parkBelow: 10 * GB })
    expect(report.steps.find((s) => s.key === "archive")!.removed).toEqual([])
    expect((await getTask(r, done.id)).boxId).toBe(done.boxId)
    expect(fs.existsSync(path.join(r.yard.tasks.taskDir(done.boxId!, done.id), "work"))).toBe(true)
  })

  it("runs from the Clean up now endpoint and reports what it freed", async () => {
    const r = await start({ maxBoxes: 1, archiveWorkspaces: false })
    const p = await project(r, "alpha")
    const t = await until(r, (await task(r, p.id, "first")).id, "done")
    ballast(path.join(r.yard.tasks.taskDir(t.boxId!, "task_leftover"), "work"), 80 * MB)
    r.provider.fill(t.boxId!, 2 * GB)
    const started = await call<BoxCleanup>(r, "POST", `/api/boxes/${t.boxId}/cleanup`)
    expect(started.status).toBe("running")
    expect(started.reason).toBe("manual")
    const report = await cleanupDone(r, t.boxId!)
    expect(report.status).toBe("done")
    expect(report.freedBytes).toBeGreaterThanOrEqual(80 * MB)
    // Plenty free, so Clean up now doesn't park done workspaces.
    expect(report.steps.find((s) => s.key === "archive")!.skipped).toBe("enough room without parking workspaces")
    expect((await boxes(r))[0]!.cleanup?.freedBytes).toBe(report.freedBytes)
    await expect(call(r, "POST", "/api/boxes/nope/cleanup")).rejects.toThrow(/404/)
  })
})

describe("root disk", () => {
  it("sweeps stale temp folders off a low root disk by itself, once per cooldown, and reports both disks", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const box = t.boxId!
    // A snapshot stage nothing touched in 45 minutes, and one an archive is writing now.
    const stale = path.join(r.provider.stageDir(box), "boxyard-git-task_old")
    ballast(stale, 300 * MB)
    const old = (Date.now() - 45 * 60_000) / 1000
    for (const f of [path.join(stale, "big.ballast"), stale]) fs.utimesSync(f, old, old)
    const live = path.join(r.provider.stageDir(box), "boxyard-archive-keep-task_now")
    ballast(live, 100 * MB)
    r.provider.fillRoot(box, 200 * MB)

    await r.yard.tasks.probeDisk(box, 0)
    const low = (await boxes(r)).find((b) => b.id === box)!
    expect(low.rootFreeBytes).toBe(200 * MB)
    expect(rootLow({ freeBytes: low.rootFreeBytes ?? null, totalBytes: low.rootTotalBytes ?? null })).toBe(true)
    expect(boxAttention(low).map((a) => a.key)).toEqual(["root"])
    expect(low.diskLow).toBe(false)

    const sweep = (r.yard.tasks as unknown as { sweepRootDisks(now: number): Promise<void> }).sweepRootDisks.bind(r.yard.tasks)
    await sweep(Date.now())
    const c = await cleanupDone(r, box)
    expect(c).toMatchObject({ reason: "routine", status: "done", rootFreeBefore: 200 * MB, rootFreeAfter: 500 * MB })
    expect(c.steps.map((s) => s.key)).toEqual(["tmp", "caches"])
    expect(c.steps[0]!.removed).toEqual([expect.stringMatching(/^1 stale temp folder \(/)])
    expect(c.steps[0]!.freedBytes).toBe(300 * MB)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)

    // Still under 512 MB free, but swept a moment ago: not again until the cooldown passes.
    await r.yard.tasks.probeDisk(box, 0)
    await sweep(Date.now())
    expect(r.yard.tasks.janitor.current(box)!.startedAt).toBe(c.startedAt)
    ballast(path.join(r.provider.stageDir(box), "boxyard-git-task_older"), MB)
    fs.utimesSync(path.join(r.provider.stageDir(box), "boxyard-git-task_older", "big.ballast"), old, old)
    fs.utimesSync(path.join(r.provider.stageDir(box), "boxyard-git-task_older"), old, old)
    await sweep(Date.now() + 11 * 60_000)
    const again = await cleanupDone(r, box)
    expect(again.startedAt).toBeGreaterThan(c.startedAt)
    expect(fs.existsSync(path.join(r.provider.stageDir(box), "boxyard-git-task_older"))).toBe(false)
  })

  it("leaves a box alone when its root disk has room or is the work disk", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await project(r, "alpha")
    const t = await settled(r, (await task(r, p.id, "first")).id)
    const box = t.boxId!
    const sweep = (r.yard.tasks as unknown as { sweepRootDisks(now: number): Promise<void> }).sweepRootDisks.bind(r.yard.tasks)
    const janitor = r.yard.tasks.janitor
    const runs: unknown[] = []
    const run = janitor.run.bind(janitor)
    janitor.run = (boxId, opts) => (runs.push(opts.steps), run(boxId, opts))
    await r.yard.tasks.probeDisk(box, 0)
    expect((await boxes(r)).find((b) => b.id === box)!.rootFreeBytes).toBeNull()
    await sweep(Date.now())
    r.provider.fillRoot(box, 3 * GB)
    await r.yard.tasks.probeDisk(box, 0)
    expect((await boxes(r)).find((b) => b.id === box)!.rootFreeBytes).toBe(3 * GB)
    await sweep(Date.now())
    expect(runs).toEqual([])
  })
})
