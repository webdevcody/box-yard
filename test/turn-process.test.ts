import { afterEach, describe, expect, it } from "vitest"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DataDirLockedError, lockDataDir, processIdent } from "../server/dataLock.js"
import { parseRunRecord, parseTurnProbe, turnKillScript, turnProbeScript } from "../server/turnProcess.js"
import { tmpDir, waitFor } from "./helpers.js"

// Telling a turn's own process from one that took its pid later (a reboot, a box resume), and one Box Yard per data
// folder. A stand-in `sleep` plays the turn (or the other server).

const dirs: string[] = []
const procs: ChildProcess[] = []
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL")
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const scratch = () => {
  const dir = tmpDir("box-yard-turnproc-")
  dirs.push(dir)
  return dir
}
/** A process in a group of its own, like the runner. */
const sleeper = () => {
  const p = spawn("sleep", ["300"], { stdio: "ignore", detached: true })
  procs.push(p)
  return p.pid!
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !/\) Z /.test(fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, "utf8") : "")
}
const sh = (script: string) => execFileSync("bash", ["-c", script], { encoding: "utf8" })
/** A task folder whose turn is `pid`, with a run record saying `ident` (omitted: no run.json, a runner from before them). */
function taskDir(pid: number, ident?: string | null) {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, "turn.pid"), String(pid))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_1", prompt: "x" }))
  if (ident !== undefined) fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ pid, ident, turnId: "turn_1", startedAt: 1, eventsOffset: 42 }))
  return dir
}
const probe = (dir: string) => parseTurnProbe(sh(turnProbeScript(dir)))

describe.skipIf(process.platform === "win32")("a turn's process", () => {
  it("has an identity: this boot and its start time", async () => {
    // macOS start times are whole seconds (`ps -o lstart`): start the sleeper in a later second than this process.
    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - process.uptime() * 1000)))
    const pid = sleeper()
    const ident = processIdent(pid)
    expect(ident).toMatch(/^[^|]+\|.+$/)
    expect(processIdent(pid)).toBe(ident)
    expect(processIdent(process.pid)).not.toBe(ident)
  })

  it("is alive only while its pid is the process its run record names", () => {
    const pid = sleeper()
    const own = taskDir(pid, processIdent(pid))
    expect(probe(own)).toEqual({ alive: true, record: { pid, ident: processIdent(pid), turnId: "turn_1", startedAt: 1, eventsOffset: 42 } })
    // Another process has the pid now: the boot or start time differs.
    const [boot] = processIdent(pid)!.split("|")
    expect(probe(taskDir(pid, `${boot}|1`))?.alive).toBe(false)
    expect(probe(taskDir(pid, `another-boot|${processIdent(pid)!.split("|")[1]}`))?.alive).toBe(false)
    // A runner that couldn't tell its identity, or one from before run records: the pid is all there is.
    expect(probe(taskDir(pid, null))?.alive).toBe(true)
    expect(probe(taskDir(pid))).toEqual({ alive: true, record: null })
    // Nothing running.
    const gone = spawn("true")
    return new Promise<void>((resolve) =>
      gone.on("exit", () => {
        expect(probe(taskDir(gone.pid!, "x|y"))?.alive).toBe(false)
        expect(probe(scratch())).toEqual({ alive: false, record: null })
        resolve()
      }),
    )
  })

  it("is stopped by its run record, never a process that took its pid", async () => {
    const other = sleeper()
    sh(turnKillScript(taskDir(other, "another-boot|1")))
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(other)).toBe(true)

    // A turn.pid that isn't one pid (an agent can write its folder): "-1" would be every process.
    for (const bad of ["-1", "0", `${other} 1`, ""]) {
      const dir = taskDir(other)
      fs.writeFileSync(path.join(dir, "turn.pid"), bad)
      expect(probe(dir)?.alive).toBe(false)
      sh(turnKillScript(dir))
    }
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(other)).toBe(true)

    // A newer turn in the folder: not this one's to stop.
    const turn = sleeper()
    const dir = taskDir(turn, processIdent(turn))
    sh(turnKillScript(dir, "TERM", "turn_0"))
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(turn)).toBe(true)
    sh(turnKillScript(dir, "TERM", "turn_1"))
    await waitFor(() => !alive(turn), "the turn to stop")
  })

  it("reads run records and probe output defensively", () => {
    expect(parseRunRecord("")).toBeNull()
    expect(parseRunRecord("{\"pid\":\"12\"}")).toBeNull()
    expect(parseRunRecord(JSON.stringify({ pid: 12, ident: 3, eventsOffset: "x" }))).toEqual({ pid: 12, ident: null, turnId: null, startedAt: null, eventsOffset: null })
    expect(parseTurnProbe("")).toBeNull()
    expect(parseTurnProbe("bash: oops\n")).toBeNull()
    expect(parseTurnProbe("dead\n{torn")).toEqual({ alive: false, record: null })
  })
})

describe.skipIf(process.platform === "win32")("one Box Yard per data folder", () => {
  const where = { host: "127.0.0.1", port: 4020 }
  const lockFile = (dir: string) => path.join(dir, "server.lock")
  const holder = (pid: number, ident: string | null) => JSON.stringify({ pid, ident, host: "127.0.0.1", port: 3000, at: Date.now() })

  it("takes the folder, and gives it back", async () => {
    const dir = scratch()
    const lock = await lockDataDir(dir, where)
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8"))).toMatchObject({ pid: process.pid, ident: processIdent(process.pid), port: 4020 })
    lock.release()
    expect(fs.existsSync(lockFile(dir))).toBe(false)
    // This process's pid in it (left by a server that had it before a reboot): no obstacle.
    fs.writeFileSync(lockFile(dir), holder(process.pid, "another-boot|1"))
    ;(await lockDataDir(dir, where, { waitMs: 0 })).release()
    // Someone else's lock isn't released by this one.
    const mine = await lockDataDir(dir, where)
    const other = sleeper()
    fs.writeFileSync(lockFile(dir), holder(other, processIdent(other)))
    mine.release()
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid).toBe(other)
  })

  it("refuses while another server holds it, after waiting for it to stop", async () => {
    const dir = scratch()
    const other = sleeper()
    fs.writeFileSync(lockFile(dir), holder(other, processIdent(other)))
    const started = Date.now()
    const err = await lockDataDir(dir, where, { waitMs: 400 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DataDirLockedError)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect((err as Error).message).toContain(`Another Box Yard (pid ${other}, http://127.0.0.1:3000`)
    expect((err as Error).message).toContain(`is using the data folder ${dir}.`)
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid).toBe(other)

    // The old server stops while the new one waits: it starts.
    const waiting = lockDataDir(dir, where, { waitMs: 5000 })
    setTimeout(() => process.kill(other, "SIGKILL"), 300)
    const lock = await waiting
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid).toBe(process.pid)
    lock.release()
  })

  it("takes over a lock its server left behind: gone, its pid reused, or torn", async () => {
    const dir = scratch()
    const gone = spawn("true")
    await new Promise((r) => gone.on("exit", r))
    fs.writeFileSync(lockFile(dir), holder(gone.pid!, "x|y"))
    ;(await lockDataDir(dir, where, { waitMs: 0 })).release()

    // A reboot later another process has its pid.
    const stranger = sleeper()
    fs.writeFileSync(lockFile(dir), holder(stranger, "another-boot|1"))
    ;(await lockDataDir(dir, where, { waitMs: 0 })).release()
    expect(alive(stranger)).toBe(true)

    // Half written by a server that died writing it.
    fs.writeFileSync(lockFile(dir), "{\"pid\":")
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile(dir), old, old)
    const lock = await lockDataDir(dir, where, { waitMs: 0 })
    expect(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid).toBe(process.pid)
    lock.release()
  })
})
