import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Restarting Box Yard (an upgrade, a crash) while agents work. A task's turn runs detached from the server, on this
// computer or in its box, and writes its events to files there; run.json names its process (pid, boot, start time).
// The server that comes back picks each running turn up again, reads what it wrote meanwhile, and settles a turn
// whose process is gone: done if it finished, else interrupted and resumed in the same session. Each test here stops
// a server and starts another on the same database and folders, as `./yard local` restarting does.

/** Box provider that counts the boxes it makes. */
class Boxes extends LocalProvider {
  created = 0
  override async create() {
    this.created++
    return super.create()
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  boxes: Boxes
  config: Config
  boxesRoot: string
}
const running: Running[] = []
const scratch: string[] = []
/** Processes a test started that aren't Box Yard's (a pid's new owner): killed when it ends. */
const strangers: ChildProcess[] = []

async function listen(config: Config, boxesRoot: string): Promise<Running> {
  const boxes = new Boxes(boxesRoot, FAKE_CLAUDE)
  const local = new LocalRunnerProvider(config.localDir, FAKE_CLAUDE)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: boxes, localRunner: local })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(config.port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${config.port}`, boxes, config, boxesRoot }
  running.push(r)
  return r
}

async function start(): Promise<Running> {
  const config = testConfig({ port: await freePort() })
  const boxesRoot = tmpDir("box-yard-restart-boxes-")
  scratch.push(config.dataDir, boxesRoot)
  return listen(config, boxesRoot)
}

/** The server goes away (Ctrl-C, an upgrade); its agents don't. */
async function shutdown(r: Running) {
  running.splice(running.indexOf(r), 1)
  r.yard.stop()
  await new Promise((res) => r.server.close(() => res(null)))
}

/** A new server on the same database, folders and port. */
const startAgain = (r: Running) => listen(r.config, r.boxesRoot)

async function restart(r: Running) {
  await shutdown(r)
  return startAgain(r)
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const p of strangers.splice(0)) p.kill("SIGKILL")
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

const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const project = (r: Running, name: string, runner: "box" | "local") => call<Project>(r, "POST", "/api/projects", { name, runner })
const newTask = (r: Running, projectId: string, prompt: string) => r.yard.tasks.createTask({ projectId, title: "bench", prompt })
const dirOf = (r: Running, t: Task) => r.yard.tasks.taskDir(t.boxId!, t.id)
const messages = (r: Running, id: string, role: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === role)
    .map((m) => m.content)
const events = (r: Running, id: string) => messages(r, id, "event")
const turns = (r: Running, id: string) => r.yard.store.listTaskTurns(id).map((x) => x.status)
const REATTACHED = "Box Yard restarted and picked this turn back up; the agent kept working."
const GONE = "Box Yard restarted and the agent's process had stopped meanwhile (this computer or its box may have restarted)"

/** Waits for the task to be as wanted; a timeout says where it got to. */
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string, timeoutMs?: number) =>
  waitFor(() => (want(getTask(r, id)) ? getTask(r, id) : null), what, timeoutMs).catch((err: Error) => {
    const t = getTask(r, id)
    const log = t.boxId ? path.join(dirOf(r, t), "runner.log") : null
    const runnerLog = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(-15) : null
    const where = { status: t.status, turnCount: t.turnCount, boxId: t.boxId, error: t.error, turns: turns(r, id), events: events(r, id).slice(-8), runnerLog }
    throw new Error(`${err.message}\n${JSON.stringify(where, null, 2)}`)
  })
const done = (r: Running, id: string, turns = 1) => status(r, id, (t) => t.status === "done" && t.turnCount >= turns && !t.currentTurnId && !t.pendingCount, `task ${id} to finish turn ${turns}`, 30_000)
/** Working, and the agent said something already (its [slow:N] line). */
const underWay = (r: Running, id: string) =>
  status(r, id, (t) => t.status === "working" && messages(r, id, "assistant").some((m) => m.includes("Working on it slowly.")), `task ${id} to be under way`)

/** The turn's run record: its process, and the events.jsonl offset its events start at. */
const runRecord = (r: Running, t: Task) => JSON.parse(fs.readFileSync(path.join(dirOf(r, t), "run.json"), "utf8")) as { pid: number; ident: string; turnId: string; startedAt: number; eventsOffset: number }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A dead child nobody has reaped yet still answers kill -0.
  const stat = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, "utf8") : ""
  return !/\) Z /.test(stat)
}
/** Live processes in process group `pgid` (the runner and the claude it started). */
const groupMembers = (pgid: number) =>
  fs
    .readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .filter((d) => {
      try {
        const fields = fs.readFileSync(`/proc/${d}/stat`, "utf8").replace(/^.*\) /, "").split(" ")
        return fields[0] !== "Z" && Number(fields[2]) === pgid
      } catch {
        return false
      }
    })
/** The turn's whole process group dies at once, as when this computer restarts. */
const killTurn = (pid: number) => process.kill(-pid, "SIGKILL")

describe.skipIf(process.platform !== "linux")("restarting Box Yard mid-turn", () => {
  it("picks a running local turn back up: it finishes, with its status and transcript intact", async () => {
    let r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:6]")
    const before = await underWay(r, t.id)
    expect(before.boxId).toBe(LOCAL_BOX_ID)
    const rec = runRecord(r, before)
    expect(rec.turnId).toBe(r.yard.store.getTaskRow(t.id)!.current_turn_id)
    expect(rec.ident).toMatch(/\|/)
    // The runner leads its own process group, apart from the server's.
    expect(groupMembers(rec.pid).length).toBeGreaterThanOrEqual(2)
    expect(groupMembers(process.pid)).not.toContain(String(rec.pid))

    r = await restart(r)
    expect(alive(rec.pid)).toBe(true)
    await waitFor(() => events(r, t.id).includes(REATTACHED), "the turn to be picked back up")
    expect(getTask(r, t.id).status).toBe("working")
    const after = await done(r, t.id)
    expect(after.error).toBeNull()
    // One turn, done; each thing the agent said once.
    expect(turns(r, t.id)).toEqual(["done"])
    const said = messages(r, t.id, "assistant")
    expect(said.filter((m) => m.includes("Working on it slowly.")).length).toBe(1)
    expect(said.at(-1)).not.toContain("Working on it slowly.")
    expect(events(r, t.id).some((e) => e.startsWith("Turn interrupted"))).toBe(false)
    expect(events(r, t.id).filter((e) => e.startsWith("Turn 1 finished")).length).toBe(1)
  })

  it("settles a turn that finished while Box Yard was down", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:2]")
    const rec = runRecord(r, await underWay(r, t.id))
    await shutdown(r)
    await waitFor(() => !alive(rec.pid), "the turn to finish with no server", 30_000)
    const back = await startAgain(r)
    await done(back, t.id)
    expect(turns(back, t.id)).toEqual(["done"])
    expect(events(back, t.id)).not.toContain(REATTACHED)
    expect(events(back, t.id).some((e) => e.startsWith("Turn interrupted"))).toBe(false)
    expect(messages(back, t.id, "assistant").filter((m) => m.includes("Working on it slowly.")).length).toBe(1)
  })

  it("resumes, in the same session, a turn whose process died while Box Yard was down", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "set up the bench")
    await done(r, t.id)
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "run the overnight bench [slow:60]" })
    const second = await status(r, t.id, (x) => x.turnCount === 2 && x.status === "working" && messages(r, t.id, "assistant").some((m) => m.includes("Working on it slowly.")), "turn 2 to be under way")
    const session = (JSON.parse(fs.readFileSync(path.join(dirOf(r, second), "turn.json"), "utf8")) as { sessionId: string }).sessionId
    const rec = runRecord(r, second)
    await shutdown(r)
    // This computer restarts: the turn dies with it.
    killTurn(rec.pid)
    await waitFor(() => !alive(rec.pid), "the turn to die")

    const back = await startAgain(r)
    const after = await done(back, t.id, 3)
    expect(after.error).toBeNull()
    expect(turns(back, t.id)).toEqual(["done", "interrupted", "done"])
    expect(back.yard.store.listTaskTurns(t.id)[1]!.error).toBe(GONE)
    expect(events(back, t.id)).toContain(`Turn interrupted (${GONE}); retrying.`)
    const turn = JSON.parse(fs.readFileSync(path.join(dirOf(back, after), "turn.json"), "utf8")) as { prompt: string; resume: boolean; sessionId: string }
    expect(turn.resume).toBe(true)
    expect(turn.sessionId).toBe(session)
    expect(turn.prompt).toContain(`Your previous turn was interrupted (${GONE}).`)
  })

  it("doesn't take a process that has the turn's pid now for the turn, nor stop it", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:60]")
    const task = await underWay(r, t.id)
    const rec = runRecord(r, task)
    await shutdown(r)
    killTurn(rec.pid)
    await waitFor(() => !alive(rec.pid), "the turn to die")
    // After a reboot, another process has the turn's pid: here one started now, written in as if it had. In a later
    // second than the turn's: macOS start times are whole seconds (`ps -o lstart`).
    await new Promise((r) => setTimeout(r, Math.max(0, rec.startedAt + 1100 - Date.now())))
    const stranger = spawn("sleep", ["300"], { stdio: "ignore", detached: true })
    strangers.push(stranger)
    const pid = stranger.pid!
    const file = path.join(dirOf(r, task), "run.json")
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), pid }))
    fs.writeFileSync(path.join(dirOf(r, task), "turn.pid"), String(pid))

    const back = await startAgain(r)
    await done(back, t.id, 2)
    expect(turns(back, t.id)).toEqual(["interrupted", "done"])
    expect(events(back, t.id)).toContain(`Turn interrupted (${GONE}); retrying.`)
    // Neither the probe nor the next turn's start (which stops a half-started runner) touched it.
    expect(alive(pid)).toBe(true)
  })

  it("stops a picked-up turn: its whole process group", async () => {
    let r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:120]")
    const rec = runRecord(r, await underWay(r, t.id))
    r = await restart(r)
    await waitFor(() => events(r, t.id).includes(REATTACHED), "the turn to be picked back up")
    await call(r, "POST", `/api/tasks/${t.id}/stop`)
    const stopped = await status(r, t.id, (x) => !x.currentTurnId && x.status === "idle", "the turn to stop")
    expect(stopped.error).toBeNull()
    expect(turns(r, t.id)).toEqual(["stopped"])
    await waitFor(() => groupMembers(rec.pid).length === 0, "the turn's processes to end")
  })

  it("keeps a queued message across the restart, and Send now delivers it on a picked-up turn", async () => {
    let r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:120]")
    const rec = runRecord(r, await underWay(r, t.id))
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "also write the summary" })
    expect(getTask(r, t.id).pendingCount).toBe(1)
    r = await restart(r)
    await waitFor(() => events(r, t.id).includes(REATTACHED), "the turn to be picked back up")
    expect(getTask(r, t.id).pendingCount).toBe(1)
    await call(r, "POST", `/api/tasks/${t.id}/queue/send-now`, {})
    const after = await done(r, t.id, 2)
    expect(after.pendingCount).toBe(0)
    expect(turns(r, t.id)).toEqual(["stopped", "done"])
    expect(groupMembers(rec.pid).length).toBe(0)
    const turn = JSON.parse(fs.readFileSync(path.join(dirOf(r, after), "turn.json"), "utf8")) as { prompt: string; resume: boolean }
    expect(turn.prompt).toContain("also write the summary")
    expect(turn.resume).toBe(true)
  })

  it("ends a turn whose process is gone as stopped when it's stopped, without retrying it", async () => {
    const r = await start()
    const mac = await project(r, "mac", "local")
    const t = newTask(r, mac.id, "run the bench [slow:120]")
    const rec = runRecord(r, await underWay(r, t.id))
    killTurn(rec.pid)
    await waitFor(() => !alive(rec.pid), "the turn to die")
    // Before the hold stream (15 s) or the stall check notices.
    await r.yard.tasks.stopTask(t.id)
    const stopped = await status(r, t.id, (x) => !x.currentTurnId, "the turn to end")
    expect(stopped.status).toBe("idle")
    expect(turns(r, t.id)).toEqual(["stopped"])
    await new Promise((res) => setTimeout(res, 1000))
    expect(getTask(r, t.id).status).toBe("idle")
    expect(events(r, t.id).some((e) => e.startsWith("Turn interrupted"))).toBe(false)
  })

  it("picks a box's running turn back up without resetting the task or its box", async () => {
    let r = await start()
    const cloud = await project(r, "cloud", "box")
    const t = newTask(r, cloud.id, "build the page [slow:6]")
    const before = await underWay(r, t.id)
    expect(before.boxId).toMatch(/^local-/)
    const box = r.yard.store.getBox(before.boxId!)!
    const rec = runRecord(r, before)
    r = await restart(r)
    await waitFor(() => events(r, t.id).includes(REATTACHED), "the box turn to be picked back up")
    expect(getTask(r, t.id)).toMatchObject({ status: "working", boxId: before.boxId })
    const after = await done(r, t.id)
    expect(after.boxId).toBe(before.boxId)
    expect(turns(r, t.id)).toEqual(["done"])
    expect(alive(rec.pid)).toBe(false)
    // The same box, still there; no new one.
    expect(r.yard.store.getBox(box.id)).toBeTruthy()
    expect(r.boxes.created).toBe(0)
    expect(messages(r, t.id, "assistant").filter((m) => m.includes("Working on it slowly.")).length).toBe(1)
  })
})
