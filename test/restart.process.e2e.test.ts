import { afterEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Message, Project, Task } from "../shared/types.js"
import { freePort, tmpDir, waitFor } from "./helpers.js"

// The real thing: the server (server/index.ts, mock mode) in a terminal of its own, stopped with Ctrl-C (SIGINT to
// its whole process group) mid-turn, and started again on the same data folder, as `./yard local` restarts do.
// The turn keeps running through it and the new server finishes it. A second server on the folder doesn't start.

const ROOT = path.resolve(import.meta.dirname, "..")

interface Server {
  proc: ChildProcess
  base: string
  output: () => string
  exited: Promise<number | null>
}
const servers: Server[] = []
const scratch: string[] = []
let turnPid = 0

/** The server in a process group of its own, like a terminal's foreground job. */
function serve(dataDir: string, port: number): Server {
  const blank = ["UPSTASH_BOX_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "QSTASH_TOKEN", "RUNPOD_API_KEY", "BOX_PROVIDER", "BOXYARD_PASSWORD", "BOXYARD_PUBLIC_URL"]
  const env = {
    ...process.env,
    ...Object.fromEntries(blank.map((k) => [k, ""])),
    BOXYARD_MOCK: "1",
    BOXYARD_DATA_DIR: dataDir,
    BOXYARD_LOCAL_DIR: path.join(dataDir, "local-workspaces"),
    PORT: String(port),
    HOST: "127.0.0.1",
    BOXYARD_POLL_MS: "200",
    BOXYARD_ORCHESTRATOR_AUTOWAKE: "0",
    BOXYARD_DISK_MIN_FREE_MB: "0",
    BOXYARD_MEMORY_MAX_USED_PERCENT: "0",
    BOXYARD_MEMORY_MIN_FREE_MB: "0",
    BOXYARD_LOAD_MAX_PER_CPU: "0",
  }
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  proc.stdout!.on("data", (d) => (out += d))
  proc.stderr!.on("data", (d) => (out += d))
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)))
  const s = { proc, base: `http://127.0.0.1:${port}`, output: () => out, exited }
  servers.push(s)
  return s
}

const ctrlC = (s: Server) => process.kill(-s.proc.pid!, "SIGINT")

afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s.proc.exitCode === null && s.proc.signalCode === null) {
      ctrlC(s)
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 5000))])
      if (s.proc.exitCode === null) process.kill(-s.proc.pid!, "SIGKILL")
    }
  }
  if (turnPid) {
    try {
      process.kill(-turnPid, "SIGKILL")
    } catch {}
    turnPid = 0
  }
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function call<T>(s: Server, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(s.base + urlPath, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}
const up = (s: Server) =>
  waitFor(
    () =>
      fetch(`${s.base}/api/projects`)
        .then((r) => r.ok)
        .catch(() => false),
    `the server to listen\n${s.output()}`,
    60_000,
  )
const task = (s: Server, id: string) => call<Task>(s, "GET", `/api/tasks/${id}`)
const messages = (s: Server, id: string) => call<Message[]>(s, "GET", `/api/tasks/${id}/messages`)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !/\) Z /.test(fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, "utf8") : "")
}

describe.skipIf(process.platform !== "linux")("Ctrl-C and start Box Yard again mid-turn", () => {
  it("keeps the turn running, picks it back up and finishes it; a second server on the folder doesn't start", { timeout: 180_000 }, async () => {
    const dataDir = tmpDir("box-yard-restart-proc-")
    scratch.push(dataDir)
    const port = await freePort()
    const first = serve(dataDir, port)
    await up(first)

    const mac = await call<Project>(first, "POST", "/api/projects", { name: "mac", runner: "local" })
    const t = await call<Task>(first, "POST", "/api/tasks", { projectId: mac.id, title: "bench", prompt: "run the bench [slow:25]" })
    await waitFor(async () => (await messages(first, t.id)).some((m) => m.role === "assistant" && m.content.includes("Working on it slowly.")), "the turn to be under way", 30_000)
    const dir = path.join(dataDir, "local-workspaces", t.id)
    turnPid = (JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as { pid: number }).pid

    // A second Box Yard on the same folder waits for the first to stop, then gives up and says why.
    const second = serve(dataDir, await freePort())
    expect(await second.exited).toBe(1)
    expect(second.output()).toContain(`[box-yard] Not starting. Another Box Yard (pid ${first.proc.pid}, http://127.0.0.1:${port}`)
    expect((await task(first, t.id)).status).toBe("working")

    // Ctrl-C: the server goes, the turn doesn't.
    ctrlC(first)
    expect(await first.exited).toBe(0)
    expect(first.output()).toContain("Running agents keep working, in their boxes and on this computer, and are picked up on restart.")
    expect(fs.existsSync(path.join(dataDir, "server.lock"))).toBe(false)
    await new Promise((r) => setTimeout(r, 1000))
    expect(alive(turnPid)).toBe(true)

    const third = serve(dataDir, port)
    await up(third)
    await waitFor(async () => (await messages(third, t.id)).some((m) => m.role === "event" && m.content === "Box Yard restarted and picked this turn back up; the agent kept working."), "the turn to be picked back up", 30_000)
    const finished = await waitFor(async () => {
      const now = await task(third, t.id)
      return now.status === "done" && !now.currentTurnId ? now : null
    }, "the turn to finish", 60_000)
    expect(finished.error).toBeNull()
    const said = (await messages(third, t.id)).filter((m) => m.role === "assistant").map((m) => m.content)
    expect(said.filter((m) => m.includes("Working on it slowly.")).length).toBe(1)
    expect(said.length).toBeGreaterThan(1)
    expect((await messages(third, t.id)).some((m) => m.role === "event" && m.content.startsWith("Turn interrupted"))).toBe(false)
    expect(alive(turnPid)).toBe(false)
  })
})
