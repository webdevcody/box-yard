import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The local runner end to end: a project set to "Runs on: This computer" runs its turns as child processes of the
// server in <BOXYARD_LOCAL_DIR>/<task>, under its own Settings › Local agents limit, pushes at turn end without
// archives, resumes a turn this computer's sleep cut off (#104), and moves to and off boxes without losing work.
// Projects left on boxes work as before.

/** Box provider that counts the boxes it makes. */
class Boxes extends LocalProvider {
  created = 0
  override async create() {
    this.created++
    return super.create()
  }
}

/** The local runner with a hook into its commands (a start that sleep breaks, a setup that hangs). */
class HookedLocal extends LocalRunnerProvider {
  onExec: ((command: string) => Promise<ExecResult | null> | ExecResult | null) | null = null
  override async exec(boxId: string, command: string): Promise<ExecResult> {
    const hooked = this.onExec ? await this.onExec(command) : null
    return hooked ?? super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  boxes: Boxes
  local: HookedLocal
  dataDir: string
  /** config.localDir: this computer's task folders. */
  localRoot: string
}
const running: Running[] = []
/** Temp folders a test made: removed once its servers stop. */
const scratch: string[] = []
const scratchDir = (prefix: string) => {
  const dir = tmpDir(prefix)
  scratch.push(dir)
  return dir
}

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const boxes = new Boxes(scratchDir("boxes-"), FAKE_CLAUDE)
  const config = testConfig({ port, ...overrides })
  scratch.push(config.dataDir)
  const local = new HookedLocal(config.localDir, FAKE_CLAUDE)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: boxes, localRunner: local })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, boxes, local, dataDir: config.dataDir, localRoot: config.localDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.local.onExec = null
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
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

const HANG = "keep going [hang]"
const LOCAL_SLOT_WAIT = "Waiting for a free local agent slot (Settings › Local agents)"
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const newTask = (r: Running, projectId: string, title: string, prompt = "write a haiku") => r.yard.tasks.createTask({ projectId, title, prompt })
const project = (r: Running, name: string, runner: "box" | "local") => call<Project>(r, "POST", "/api/projects", { name, runner })
/** Waits for the task to be as wanted; a timeout says where it got to. */
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string, timeoutMs?: number) =>
  waitFor(
    () => {
      const t = getTask(r, id)
      return want(t) ? t : null
    },
    what,
    timeoutMs,
  ).catch((err: Error) => {
    const t = getTask(r, id)
    const log = t.boxId ? path.join(r.yard.tasks.taskDir(t.boxId, id), "runner.log") : null
    const runnerLog = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(-15) : null
    const dir = t.boxId ? r.yard.tasks.taskDir(t.boxId, id) : null
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`) : null
    const cursor = r.yard.store.getTaskRow(id)?.event_cursor
    const pidFile = dir ? path.join(dir, "turn.pid") : null
    const pid = pidFile && fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : null
    const proc = pid && fs.existsSync(`/proc/${pid}/status`) ? fs.readFileSync(`/proc/${pid}/status`, "utf8").split("\n").slice(0, 3).join(" ") + " " + fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ") : `dead ${pid}`
    const where = { status: t.status, turnCount: t.turnCount, boxId: t.boxId, error: t.error, waitReason: t.waitReason, pushState: t.pushState, events: events(r, id).slice(-8), runnerLog, files, cursor, proc }
    throw new Error(`${err.message}\n${JSON.stringify(where, null, 2)}`)
  })
const working = (r: Running, id: string) => status(r, id, (t) => t.status === "working", `task ${id} to work`)
const done = (r: Running, id: string, turns = 1) => status(r, id, (t) => t.status === "done" && t.turnCount >= turns && !t.pendingCount && !t.currentTurnId, `task ${id} to finish turn ${turns}`)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const localDir = (r: Running, taskId: string) => path.join(r.localRoot, taskId)
const archiveFile = (r: Running, taskId: string) => path.join(r.dataDir, "archives", `${taskId}.tgz`)

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin with one commit on main, served over file:// like GitHub. */
function origin() {
  const root = scratchDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  const ref = (name: string) => git(bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").find((l) => l.startsWith(`${name} `))?.split(" ")[1] ?? null
  return { url: `file://${bare}`, ref }
}

async function repoProject(r: Running, name: string, runner: "box" | "local", url: string) {
  const p = await project(r, name, runner)
  // The API only takes GitHub-style repos; point the project at the local origin instead.
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(url, p.id)
  return p
}

describe("local runner", () => {
  it("runs a local project's turns on this computer in BOXYARD_LOCAL_DIR, and box projects as before", async () => {
    const r = await start()
    const mac = await project(r, "survive-the-night", "local")
    const cloud = await project(r, "cloud", "box")
    expect(mac.runner).toBe("local")
    expect(cloud.runner).toBe("box")
    const a = newTask(r, mac.id, "bench")
    const b = newTask(r, cloud.id, "page")
    const ta = await done(r, a.id)
    const tb = await status(r, b.id, (t) => t.status === "done" && Boolean(t.lastArchivedAt), "the box task to finish and archive")

    // The local task: in its folder on this computer, on no box.
    expect(ta.boxId).toBe(LOCAL_BOX_ID)
    expect(r.yard.tasks.taskDir(LOCAL_BOX_ID, a.id)).toBe(localDir(r, a.id))
    expect(fs.readFileSync(path.join(localDir(r, a.id), "work", "box-yard-demo.md"), "utf8")).toContain("write a haiku")
    expect(fs.existsSync(path.join(r.localRoot, ".boxyard", "box-runner.mjs"))).toBe(true)
    const turn = JSON.parse(fs.readFileSync(path.join(localDir(r, a.id), "turn.json"), "utf8")) as { systemPrompt: string }
    expect(turn.systemPrompt).toContain("Box Yard's local runner), not in a sandbox")
    const taskJson = JSON.parse(fs.readFileSync(path.join(localDir(r, a.id), "task.json"), "utf8")) as { claudeBin: string; isolateConfig: boolean; boxId: string }
    expect(taskJson).toMatchObject({ claudeBin: process.execPath, isolateConfig: false, boxId: LOCAL_BOX_ID })
    // No archive: the folder is already on this disk (and there's no repo to push).
    expect(ta.lastArchivedAt).toBeNull()
    expect(fs.existsSync(archiveFile(r, a.id))).toBe(false)
    // Previews are on localhost.
    expect((await call<{ url: string }>(r, "POST", `/api/tasks/${a.id}/preview`, { port: 4005 })).url).toBe("http://localhost:4005")

    // The box task: one box made, its folder there, an archive, the box prompt.
    expect(r.boxes.created).toBe(1)
    expect(tb.boxId).toMatch(/^local-/)
    expect(fs.existsSync(path.join(r.yard.tasks.taskDir(tb.boxId!, b.id), "work", "box-yard-demo.md"))).toBe(true)
    expect(fs.existsSync(localDir(r, b.id))).toBe(false)
    expect(fs.existsSync(archiveFile(r, b.id))).toBe(true)
    const boxTurn = JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(tb.boxId!, b.id), "turn.json"), "utf8")) as { systemPrompt: string }
    expect(boxTurn.systemPrompt).toContain("running in an isolated Upstash Box")

    // This computer is never a box: not on the Boxes page, not reconciled away, not swept.
    const boxes = await call<BoxInfo[]>(r, "GET", "/api/boxes")
    expect(boxes.map((x) => x.id)).toEqual([tb.boxId])
    await r.yard.tasks.reconcileBoxes(0)
    await r.yard.tasks.maintain()
    expect(getTask(r, a.id).boxId).toBe(LOCAL_BOX_ID)
    expect(r.yard.store.getBox(LOCAL_BOX_ID)).toBeFalsy()
    expect(r.yard.tasks.history.list({ boxId: LOCAL_BOX_ID }).length).toBe(0)

    // A follow-up runs in the same folder.
    await call(r, "POST", `/api/tasks/${a.id}/messages`, { content: "one more" })
    expect((await done(r, a.id, 2)).boxId).toBe(LOCAL_BOX_ID)
    expect(r.boxes.created).toBe(1)

    // Closing keeps the folder: there's no archive to come back from. Deleting the task removes it.
    await call(r, "POST", `/api/tasks/${a.id}/close`)
    expect(events(r, a.id)).toContain("Closed. Its folder on this computer stays until the task is deleted.")
    await new Promise((res) => setTimeout(res, 1500))
    expect(fs.existsSync(path.join(localDir(r, a.id), "work"))).toBe(true)
    expect(getTask(r, a.id).boxId).toBe(LOCAL_BOX_ID)
    await r.yard.tasks.deleteTask(a.id)
    await waitFor(() => !fs.existsSync(localDir(r, a.id)), "the local folder to go")
  })

  it("has its own Local agents queue, apart from box slots and Max agents", async () => {
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { maxAgents: 1, localAgents: 1 })
    const mac = await project(r, "mac", "local")
    const cloud = await project(r, "cloud", "box")
    const a = newTask(r, mac.id, "a", HANG)
    await working(r, a.id)
    const b = newTask(r, mac.id, "b", HANG)
    const c = newTask(r, cloud.id, "c", HANG)
    // The box task runs though a local agent does (Max agents counts boxes only)...
    await working(r, c.id)
    // ...and the second local task waits for a Local agents slot, not a box.
    await status(r, b.id, (t) => t.status === "queued" && t.waitReason === LOCAL_SLOT_WAIT, "the second local task to wait for a local slot")
    expect(getTask(r, b.id).boxId).toBeNull()
    expect(r.yard.tasks.runningTotal()).toBe(1)
    expect(r.yard.tasks.poolLimits()).toMatchObject({ maxAgents: 1, agentsRunning: 1, localAgents: 1, localAgentsRunning: 1 })
    expect(r.boxes.created).toBe(1)

    // A box task waits on Max agents, never on Local agents.
    const d = newTask(r, cloud.id, "d", HANG)
    await new Promise((res) => setTimeout(res, 800))
    expect(getTask(r, d.id).status).toBe("queued")
    expect(getTask(r, d.id).waitReason).not.toBe(LOCAL_SLOT_WAIT)

    // Raising Local agents starts the waiting local task.
    await call(r, "PUT", "/api/agent-settings", { localAgents: 2 })
    expect((await working(r, b.id)).boxId).toBe(LOCAL_BOX_ID)
    expect(r.yard.store.slotsInUse(LOCAL_BOX_ID)).toBe(2)
    expect(getTask(r, d.id).status).toBe("queued")
  })

  it("respects the project's heavy-tasks setting on this computer", async () => {
    const r = await start({ localAgents: 3 })
    const mac = await call<Project>(r, "POST", "/api/projects", { name: "gpu", runner: "local", heavyTasks: "whole-box" })
    const a = newTask(r, mac.id, "a", HANG)
    await working(r, a.id)
    const b = newTask(r, mac.id, "b", HANG)
    await status(r, b.id, (t) => t.status === "queued" && /this computer has an agent running/.test(t.waitReason ?? ""), "the heavy task to wait")
  })
})

describe("sleep (#104)", () => {
  it("resumes a local turn this computer's sleep cut off instead of failing it", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "bench")
    await done(r, t.id)
    // A sleep that ended before the turn doesn't count.
    r.yard.tasks.sleep.record(Date.now() - 120_000, Date.now() - 60_000)
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "run the overnight bench [slow] [fail]" })
    await status(r, t.id, (x) => x.status === "working" && x.turnCount === 2, "turn 2 to work")
    // The lid closes mid-turn: asleep 40 minutes, awake again now.
    r.yard.tasks.sleep.record(Date.now() - 40 * 60_000, Date.now())
    const back = await done(r, t.id, 3)
    expect(back.error).toBeNull()
    expect(r.yard.store.listTaskTurns(t.id).map((x) => x.status)).toEqual(["done", "interrupted", "done"])
    expect(events(r, t.id).some((e) => /^Turn 2 was cut off while this computer slept \(40 min\); it carries on now instead of failing\.$/.test(e))).toBe(true)
    expect(events(r, t.id).some((e) => e.startsWith("Turn 2 failed"))).toBe(false)
    // The next turn was told why, in the same session.
    const turn = JSON.parse(fs.readFileSync(path.join(localDir(r, t.id), "turn.json"), "utf8")) as { prompt: string; resume: boolean }
    expect(turn.resume).toBe(true)
    expect(turn.prompt).toContain("Your previous turn was cut off when this computer went to sleep (asleep 40 min; it ended with:")
    expect(r.yard.store.turnFlags(r.yard.store.getTaskRow(t.id)!).sleeps ?? 0).toBe(0)
  })

  it("still fails a local turn that failed with no sleep, and a box turn", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const cloud = await project(r, "cloud", "box")
    const a = newTask(r, mac.id, "a", "[fail]")
    await status(r, a.id, (t) => t.status === "failed", "the local task to fail")
    const b = newTask(r, cloud.id, "b", "[slow] [fail]")
    await working(r, b.id)
    r.yard.tasks.sleep.record(Date.now() - 60_000, Date.now())
    await status(r, b.id, (t) => t.status === "failed", "the box task to fail")
  })

  it("starts again when this computer slept while the agent was starting", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    let broken = 0
    r.local.onExec = async (command) => {
      if (!command.includes("echo present || echo missing") || broken++) return null
      // The lid closes as the start begins; it wakes to a dropped connection.
      await new Promise((res) => setTimeout(res, 20))
      r.yard.tasks.sleep.record(Date.now() - 30 * 60_000, Date.now())
      return { exitCode: 255, stdout: "", stderr: "Connection reset" }
    }
    const t = newTask(r, mac.id, "bench")
    const back = await done(r, t.id)
    expect(back.boxId).toBe(LOCAL_BOX_ID)
    expect(events(r, t.id).some((e) => e.startsWith("This computer slept while the agent was starting (box not responding: Connection reset); starting it again."))).toBe(true)
    expect(events(r, t.id).some((e) => e.startsWith("Couldn't start the agent"))).toBe(false)
  })

  it("doesn't count time asleep toward a local start's timeout", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    r.local.onExec = async (command) => {
      if (command.includes("echo present || echo missing")) await gate
      return null
    }
    const t = newTask(r, mac.id, "bench")
    await status(r, t.id, (x) => x.status === "starting", "the start to hang")
    const setUpdated = (at: number) => r.yard.store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, t.id)
    // Starting for 20 minutes, 10 of them asleep: 10 awake is under the 15-minute timeout.
    const now = Date.now()
    setUpdated(now - 20 * 60_000)
    r.yard.tasks.sleep.record(now - 19 * 60_000, now - 9 * 60_000)
    await r.yard.tasks.maintain()
    expect(getTask(r, t.id).status).toBe("starting")
    // Starting for 40 minutes, 10 asleep: 30 awake times out.
    setUpdated(now - 40 * 60_000)
    await r.yard.tasks.maintain()
    expect(getTask(r, t.id)).toMatchObject({ status: "failed", error: "Starting the agent timed out." })
    release()
  })
})

describe("git and archives", () => {
  it("pushes a local task's work at turn end but keeps no archive", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "mac", "local", o.url)
    const t = newTask(r, p.id, "bench")
    const back = await status(r, t.id, (x) => x.status === "done" && x.pushState?.status === "pushed", "the turn-end push")
    expect(back.boxId).toBe(LOCAL_BOX_ID)
    // The fake agent commits nothing, so its work (box-yard-demo.md) is on origin's WIP ref.
    expect(o.ref(`refs/boxyard/wip/${t.id}`)).toBe(back.pushState!.wip)
    await new Promise((res) => setTimeout(res, 500))
    expect(getTask(r, t.id).lastArchivedAt).toBeNull()
    expect(fs.existsSync(archiveFile(r, t.id))).toBe(false)
    expect(fs.readdirSync(path.join(r.dataDir, "archives"))).toEqual([])
  })

  it("moves a task from a box to this computer and back without losing work", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "survive-the-night", "box", o.url)
    const t = newTask(r, p.id, "bench")
    const first = await status(r, t.id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pushState?.status === "pushed", "the box turn to archive and push")
    const box = first.boxId!
    expect(box).toMatch(/^local-/)
    fs.writeFileSync(path.join(r.yard.tasks.taskDir(box, t.id), "work", "notes.md"), "made on the box\n")
    // The archive and push must hold the note: archive again now that it's there.
    await r.yard.tasks.archive(t.id)

    // Cody switches the project to this computer: the next turn runs here, from the box's archive.
    await call(r, "PATCH", `/api/projects/${p.id}`, { runner: "local" })
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "carry on here" })
    const here = await done(r, t.id, 2)
    expect(here.boxId).toBe(LOCAL_BOX_ID)
    expect(fs.readFileSync(path.join(localDir(r, t.id), "work", "notes.md"), "utf8")).toBe("made on the box\n")
    expect(events(r, t.id)).toContain(`Moved from box ${box} to this computer: its project runs its agents here now.`)
    await waitFor(() => !fs.existsSync(r.yard.tasks.taskDir(box, t.id)), "the box folder to go")
    fs.writeFileSync(path.join(localDir(r, t.id), "work", "notes.md"), "made on this computer\n")

    // And back to boxes: an archive is made for the move, then it restores on a box.
    await waitFor(() => !getTask(r, t.id).currentTurnId && getTask(r, t.id).pushState?.status === "pushed", "the local push")
    await call(r, "PATCH", `/api/projects/${p.id}`, { runner: "box" })
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "back to the box" })
    const there = await done(r, t.id, 3)
    expect(there.boxId).toMatch(/^local-/)
    expect(fs.readFileSync(path.join(r.yard.tasks.taskDir(there.boxId!, t.id), "work", "notes.md"), "utf8")).toBe("made on this computer\n")
    expect(events(r, t.id).some((e) => e.startsWith("Moved from this computer to box"))).toBe(true)
    await waitFor(() => !fs.existsSync(localDir(r, t.id)), "the local folder to go")
  })
})
