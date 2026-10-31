import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { WorkerSize } from "../../shared/types.js"
import { LOCAL_BOX_ID } from "../../shared/runner.js"
import { isDockerBox } from "../../shared/docker.js"
import { isGpuBox } from "../../shared/runpod.js"
import { isMachineBox } from "../../shared/machines.js"
import { gpuBoxProvider } from "../../shared/gpu.js"
import type { BoxHealth, BoxProvider, BoxSnapshotInfo, BoxUsageProbe, ExecResult } from "./types.js"
import { TURN_SH } from "../turnProcess.js"

/**
 * "Boxes" that are folders on this machine. Good for trying Box Yard with no
 * Upstash account, for tests, and for running everything on one VPS.
 * There is no isolation between local boxes, so only run agents you trust.
 */
export class LocalProvider implements BoxProvider {
  readonly name: string = "local"
  readonly nodeBin = process.execPath
  /** Its Codex: the stand-in beside a stand-in claude (scripts/fake-codex.mjs), so folder boxes never run the real one by accident. */
  readonly codexBin: string
  constructor(
    private readonly baseDir: string,
    readonly claudeBin = "claude",
    makeDir = true,
  ) {
    if (makeDir) fs.mkdirSync(baseDir, { recursive: true })
    this.codexBin = /fake-claude\.mjs/.test(claudeBin) ? claudeBin.replace(/fake-claude\.mjs/, "fake-codex.mjs") : "codex"
  }

  root(boxId: string) {
    return path.join(this.baseDir, boxId)
  }

  /** A local snapshot: a copy of a box's folder in `<baseDir>/.snapshots/<id>`. */
  private snapshotDir(snapshotId: string) {
    if (!/^local-snap-[\w-]+$/.test(snapshotId)) throw new Error(`Not a local snapshot id: ${snapshotId}`)
    return path.join(this.baseDir, ".snapshots", snapshotId)
  }

  async create(opts?: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    const id = `local-${randomUUID().slice(0, 8)}`
    if (opts?.snapshotId) {
      const from = this.snapshotDir(opts.snapshotId)
      if (!fs.existsSync(from)) throw Object.assign(new Error(`snapshot ${opts.snapshotId} not found`), { statusCode: 404 })
      fs.cpSync(from, this.root(id), { recursive: true, verbatimSymlinks: true })
    }
    fs.mkdirSync(path.join(this.root(id), ".boxyard"), { recursive: true })
    fs.mkdirSync(path.join(this.root(id), "tasks"), { recursive: true })
    return id
  }

  async health(boxId: string): Promise<BoxHealth> {
    return fs.existsSync(this.root(boxId)) ? "running" : "gone"
  }

  async snapshot(boxId: string, _name: string): Promise<BoxSnapshotInfo> {
    const id = `local-snap-${randomUUID().slice(0, 8)}`
    fs.cpSync(this.root(boxId), this.snapshotDir(id), { recursive: true, verbatimSymlinks: true })
    return { id, bytes: null }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    fs.rmSync(this.snapshotDir(snapshotId), { recursive: true, force: true })
  }

  /** Folders inside the box's own folder: stripping a local box's copy never touches this machine's home or /tmp. */
  snapshotDirs(boxId: string) {
    return { home: path.join(this.root(boxId), "home"), tmp: path.join(this.root(boxId), "tmp") }
  }

  async wake() {}

  /** Environment box commands run with. Tests override it to put fake tools on PATH. */
  protected env(_boxId: string): NodeJS.ProcessEnv {
    return process.env
  }

  /** Run box commands in a session of their own (setsid), so a Ctrl-C in the server's terminal can't reach their turns. */
  protected readonly detached: boolean = false

  exec(boxId: string, command: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: this.root(boxId), env: this.env(boxId), detached: this.detached })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", (err) => resolve({ exitCode: 127, stdout, stderr: stderr + err.message }))
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    })
  }

  execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", command], { cwd: this.root(boxId), env: this.env(boxId), detached: this.detached })
      // Merged like Upstash's exec stream.
      child.stdout.setEncoding("utf8").on("data", onOutput)
      child.stderr.setEncoding("utf8").on("data", onOutput)
      child.on("error", reject)
      child.on("close", (code) => resolve({ exitCode: code ?? 1 }))
    })
  }

  hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: this.root(boxId), env: this.env(boxId), stdio: "ignore", detached: this.detached })
      const onAbort = () => child.kill("SIGTERM")
      signal.addEventListener("abort", onAbort, { once: true })
      child.on("error", () => resolve())
      child.on("close", () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      })
    })
  }

  async writeFile(_boxId: string, filePath: string, content: string | Buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }

  async readFile(_boxId: string, filePath: string) {
    return fs.readFileSync(filePath)
  }

  async uploadFile(_boxId: string, localPath: string, destination: string) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(localPath, destination)
  }

  async publicUrl(_boxId: string, port: number) {
    return `http://localhost:${port}`
  }

  async usage(boxId: string): Promise<BoxUsageProbe> {
    return { diskBytes: dirSize(this.root(boxId)), source: "estimated" }
  }

  async destroy(boxId: string) {
    // Stop any turn still running in this box before removing its folder (by its run record: never a reused pid).
    await this.exec(boxId, `${TURN_SH}\nfor d in tasks/*/; do by_turn_kill "$d" TERM; done; true`)
    fs.rmSync(this.root(boxId), { recursive: true, force: true })
  }
}

/**
 * Box Yard's own settings and secrets in its environment. Local-runner agents don't inherit them: task.json hands each
 * turn what it should have (its project's env, the Claude, Codex and GitHub credentials), like on a box. The Claude Code
 * session markers go too, or a Box Yard started from a Claude Code terminal would make every agent a nested session.
 */
const SERVER_ENV = /^(BOXYARD_|UPSTASH_|QSTASH_|BOX_|ELEVENLABS_|OPENAI_|CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING))/
const SERVER_KEYS = new Set([
  "PORT",
  "HOST",
  "CLAUDECODE",
  "CLAUDE_BIN",
  "CODEX_BIN",
  "CODEX_AUTH_JSON",
  "CODEX_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_USER_NAME",
  "GIT_USER_EMAIL",
  "WORKER_MODEL",
  "WORKER_SIZE",
  "ORCHESTRATOR_MODEL",
  "CAPTAIN_MODEL",
  "CAPTAIN_EFFORT",
  "TTS_PROVIDER",
])

/** `env` without Box Yard's own settings and secrets (SERVER_ENV, SERVER_KEYS). */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SERVER_KEYS.has(k) && !SERVER_ENV.test(k)) out[k] = v
  return out
}

/**
 * The local runner: a project set to "Runs on: This computer" runs its agents straight on the machine running Box Yard
 * (Cody's Mac), with its real GPU, its logged-in `claude` and `gh`, and no sandbox. It has one virtual box,
 * LOCAL_BOX_ID, which is never a `boxes` row (shared/runner.ts). Task folders are `<dir>/<task_id>` (dir is
 * BOXYARD_LOCAL_DIR, `~/boxyard-workspaces` unless set); Box Yard's runner, repo mirrors and dependency cache sit
 * beside them in `<dir>/.boxyard`. A turn is box-runner.mjs as a child process of this server, in a session of its own
 * so it outlives a server restart.
 */
export class LocalRunnerProvider extends LocalProvider {
  protected override readonly detached = true
  constructor(
    private readonly dir: string,
    claudeBin = "claude",
  ) {
    // Made on first use: most Box Yards never run a local agent, and starting one mustn't leave a folder in $HOME.
    super(dir, claudeBin, false)
  }

  /** Commands run in the folder, so it's made first (on first use, or again if someone removed it). */
  override exec(boxId: string, command: string) {
    fs.mkdirSync(this.dir, { recursive: true })
    return super.exec(boxId, command)
  }

  override execStream(boxId: string, command: string, onOutput: (chunk: string) => void) {
    fs.mkdirSync(this.dir, { recursive: true })
    return super.execStream(boxId, command, onOutput)
  }

  override hold(boxId: string, command: string, signal: AbortSignal) {
    fs.mkdirSync(this.dir, { recursive: true })
    return super.hold(boxId, command, signal)
  }

  override root(_boxId: string) {
    return this.dir
  }

  tasksRoot(_boxId: string) {
    return this.dir
  }

  override async create(): Promise<string> {
    throw new Error("The local runner has one box, this computer; it never makes another")
  }

  /** This computer holds Cody's own folders and logins: it's never snapshotted. */
  override async snapshot(): Promise<BoxSnapshotInfo> {
    throw new Error("Projects that run on this computer have no box to snapshot")
  }

  /** This computer is always there; a folder someone removed is made again. */
  override async health(): Promise<BoxHealth> {
    fs.mkdirSync(path.join(this.dir, ".boxyard"), { recursive: true })
    return "running"
  }

  protected override env(): NodeJS.ProcessEnv {
    return agentEnv(process.env)
  }

  /** Not walked: these folders are Cody's, and a workspace's node_modules would make it slow. */
  override async usage(): Promise<BoxUsageProbe> {
    return { source: "estimated" }
  }

  /** Nothing ever deletes this computer's folder: tasks remove their own (TaskManager.removeTaskDir, server/ownCleanup.ts). */
  override async destroy(): Promise<void> {}
}

/**
 * Fronts the box provider and adds the local runner: LOCAL_BOX_ID goes to `local`, every other box to `base`
 * (through its own `of`, so AutoProvider keeps routing). New boxes, leftover-box sweeps and reconcile only ever ask
 * `base`, so the local runner can't be created, swept or reconciled away as lost.
 */
export class LocalRunnerRouter implements BoxProvider {
  readonly resize?: (boxId: string, size: WorkerSize) => Promise<void>
  readonly listIds?: (label: string) => Promise<string[]>
  readonly liveIds?: () => Promise<string[]>
  readonly snapshot?: (boxId: string, name: string) => Promise<BoxSnapshotInfo>
  readonly deleteSnapshot?: (snapshotId: string) => Promise<void>
  readonly snapshotDirs?: (boxId: string) => { home: string; tmp: string }

  constructor(
    readonly base: BoxProvider,
    readonly local: BoxProvider,
    /** RunPod GPU pods (`runpod-<projectId>[-<n>]`, shared/runpod.ts), when set up. */
    readonly gpu: BoxProvider | null = null,
    /** Docker containers on this computer (`docker-<projectId>`, shared/docker.ts). */
    readonly docker: BoxProvider | null = null,
    /** Vast.ai GPU instances (`vastai-<projectId>[-<n>]`, shared/gpu.ts), when set up. */
    readonly vast: BoxProvider | null = null,
    /** Cody's SSH machines (`ssh-<machineId>`, shared/machines.ts). */
    readonly machines: BoxProvider | null = null,
    /** Daytona sandboxes (`daytona-<projectId>[-<n>]`, shared/gpu.ts), when set up. */
    readonly daytona: BoxProvider | null = null,
  ) {
    if (base.resize) this.resize = (boxId, size) => this.of(boxId).resize!(boxId, size)
    // Snapshots are the box provider's; the local runner's computer is never snapshotted (LocalRunnerProvider).
    if (base.snapshot) this.snapshot = (boxId, name) => (boxId === LOCAL_BOX_ID ? this.local : base).snapshot!(boxId, name)
    if (base.deleteSnapshot) this.deleteSnapshot = (snapshotId) => base.deleteSnapshot!(snapshotId)
    if (base.snapshotDirs) this.snapshotDirs = (boxId) => base.snapshotDirs!(boxId)
    if (base.listIds) this.listIds = (label) => base.listIds!(label)
    if (base.liveIds) this.liveIds = () => base.liveIds!()
  }

  of(boxId: string): BoxProvider {
    if (boxId === LOCAL_BOX_ID) return this.local
    if (gpuBoxProvider(boxId) === "vast") {
      if (!this.vast) throw new Error("Vast.ai GPU isn't set up: add VAST_API_KEY in Settings › Credentials")
      return this.vast
    }
    if (gpuBoxProvider(boxId) === "daytona") {
      if (!this.daytona) throw new Error("Daytona isn't set up: add DAYTONA_API_KEY in Settings › Credentials")
      return this.daytona
    }
    if (isGpuBox(boxId)) {
      if (!this.gpu) throw new Error("RunPod GPU isn't set up: add RUNPOD_API_KEY in Settings › Credentials")
      return this.gpu
    }
    if (isDockerBox(boxId)) {
      if (!this.docker) throw new Error("Docker containers aren't set up on this Box Yard")
      return this.docker
    }
    if (isMachineBox(boxId)) {
      if (!this.machines) throw new Error("SSH machines aren't set up on this Box Yard")
      // A removed machine: the provider itself, whose calls say so (health: gone).
      try {
        return this.machines.of?.(boxId) ?? this.machines
      } catch {
        return this.machines
      }
    }
    return this.base.of?.(boxId) ?? this.base
  }

  get name() {
    return this.base.name
  }
  get nodeBin() {
    return this.base.nodeBin
  }
  get claudeBin() {
    return this.base.claudeBin
  }
  get codexBin() {
    return this.base.codexBin
  }
  get maxUploadBytes() {
    return this.base.maxUploadBytes
  }

  root(boxId: string) {
    return this.of(boxId).root(boxId)
  }
  tasksRoot(boxId: string) {
    const p = this.of(boxId)
    return p.tasksRoot?.(boxId) ?? `${p.root(boxId)}/tasks`
  }
  create(opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }) {
    return this.base.create(opts)
  }
  health(boxId: string): Promise<BoxHealth> {
    return this.of(boxId).health(boxId)
  }
  wake(boxId: string) {
    return this.of(boxId).wake(boxId)
  }
  exec(boxId: string, command: string): Promise<ExecResult> {
    return this.of(boxId).exec(boxId, command)
  }
  execStream(boxId: string, command: string, onOutput: (chunk: string) => void) {
    return this.of(boxId).execStream(boxId, command, onOutput)
  }
  hold(boxId: string, command: string, signal: AbortSignal) {
    return this.of(boxId).hold(boxId, command, signal)
  }
  writeFile(boxId: string, filePath: string, content: string | Buffer) {
    return this.of(boxId).writeFile(boxId, filePath, content)
  }
  readFile(boxId: string, filePath: string) {
    return this.of(boxId).readFile(boxId, filePath)
  }
  uploadFile(boxId: string, localPath: string, destination: string) {
    return this.of(boxId).uploadFile(boxId, localPath, destination)
  }
  publicUrl(boxId: string, port: number) {
    return this.of(boxId).publicUrl(boxId, port)
  }
  destroy(boxId: string) {
    return this.of(boxId).destroy(boxId)
  }
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const p = this.of(boxId)
    return p.usage ? p.usage(boxId) : { source: "estimated" }
  }
}

function dirSize(file: string): number {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.size
  let total = st.size
  for (const entry of fs.readdirSync(file)) total += dirSize(path.join(file, entry))
  return total
}
