// SSH machines as boxes (shared/machines.ts): `ssh-<machineId>` runs its commands on that machine over SSH. Box
// Yard's folder there (Machine.dir, `~/boxyard`) is laid out like a box's root: `.boxyard/` (the runner, repo mirrors,
// dependency cache) and `tasks/<taskId>/`. Each turn's task.json and signing key go to the machine's memory when it
// has a tmpfs (/dev/shm on Linux), linked from the task folder like a Docker container's, and the runner removes
// task.json when the turn ends (task.json `dropAfterTurn`), so the machine keeps no credential between turns.
//
// In mock mode and tests a machine is a folder on this computer and its commands run in a local bash (FolderTransport),
// so everything but the SSH connection itself runs the same scripts.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isMachineBox, machineOfBox, type Machine } from "../../shared/machines.js"
import type { BoxHealth, BoxProvider, BoxSnapshotInfo, BoxUsageProbe, ExecResult } from "../providers/types.js"
import { q } from "../providers/types.js"
import type { MachineKeys } from "./keys.js"
import { REMOTE_SCRIPT, SSH_FAILED, runSsh, scriptFor, sshArgs, sshError, uploadCommand, writeFileScript, type SshRunOptions, type SshRunResult } from "./ssh.js"

/** How commands reach a machine: SSH, or (mock mode, tests) a local bash in a folder. */
export interface MachineTransport {
  readonly kind: "ssh" | "folder"
  run(m: Machine, opts: SshRunOptions): Promise<SshRunResult>
  /**
   * Stop sharing a connection (its key or address changed, or it was removed): new commands open a new one, and
   * commands still running on the old one (a turn's hold) finish on it.
   */
  close?(m: Machine): Promise<void>
  /** Forget its host key (it was reinstalled, or its address now belongs to another machine). */
  forgetHostKey?(m: Machine): void
}

/** The system ssh, with a known_hosts file per machine and one shared connection per machine. */
export class SshTransport implements MachineTransport {
  readonly kind = "ssh"
  /** A short tag of this Box Yard's data folder, so two Box Yards on one computer never share a connection. */
  private readonly tag: string

  constructor(private readonly o: { dir: string; keys: MachineKeys; sshBin?: string }) {
    this.tag = createHash("sha256").update(path.resolve(o.dir)).digest("hex").slice(0, 6)
  }

  private knownHosts(m: Machine) {
    return path.join(this.o.dir, `known_hosts-${m.id.replace(/[^\w-]/g, "")}`)
  }

  private async args(m: Machine, controlPath = true): Promise<string[]> {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 })
    const auth = await this.o.keys.resolve(m.keyRef, m.id)
    // /tmp itself: a unix socket path must stay under ~104 bytes, and %C is 40.
    return sshArgs(m, { auth, knownHosts: this.knownHosts(m), controlPath: controlPath ? `/tmp/byssh-${this.tag}-%C` : null })
  }

  async run(m: Machine, opts: SshRunOptions): Promise<SshRunResult> {
    let args: string[]
    try {
      args = await this.args(m)
    } catch (err) {
      return { exitCode: SSH_FAILED, stdout: Buffer.alloc(0), stderr: (err as Error).message }
    }
    return runSsh(this.o.sshBin ?? "ssh", args, opts)
  }

  async close(m: Machine) {
    try {
      const args = await this.args(m)
      await runSsh(this.o.sshBin ?? "ssh", ["-O", "stop", ...args], { remote: "", timeoutMs: 5000 })
    } catch {}
  }

  forgetHostKey(m: Machine) {
    fs.rmSync(this.knownHosts(m), { force: true })
  }
}

/**
 * Machines as folders on this computer (mock mode, tests): `<dir>/<machineId>/home` is the machine's $HOME and its
 * commands run in a local bash there, from the same scripts SSH would carry. No isolation at all.
 */
export class FolderTransport implements MachineTransport {
  readonly kind = "folder"
  constructor(
    private readonly dir: string,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  home(m: Machine) {
    return path.join(this.dir, m.id, "home")
  }

  run(m: Machine, opts: SshRunOptions): Promise<SshRunResult> {
    const home = this.home(m)
    fs.mkdirSync(home, { recursive: true })
    return new Promise((resolve) => {
      // No login shell to ask: what's on this process's PATH is what the "machine" has.
      const child = spawn("bash", ["-c", opts.remote ?? REMOTE_SCRIPT.slice("bash -c ".length + 1, -1)], { cwd: home, env: { ...this.env(), HOME: home, SHELL: "" }, detached: true })
      const out: Buffer[] = []
      let stderr = ""
      const onAbort = () => {
        try {
          process.kill(-child.pid!, "SIGTERM")
        } catch {
          child.kill("SIGTERM")
        }
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      child.stdout.on("data", (d: Buffer) => (opts.onOutput ? opts.onOutput(d.toString("utf8")) : out.push(d)))
      child.stderr.on("data", (d: Buffer) => (opts.onOutput ? opts.onOutput(d.toString("utf8")) : (stderr += d.toString("utf8"))))
      child.on("error", (err) => resolve({ exitCode: 127, stdout: Buffer.concat(out), stderr: stderr + err.message }))
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort)
        resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr })
      })
      child.stdin.on("error", () => {})
      if (opts.input instanceof fs.ReadStream) opts.input.pipe(child.stdin)
      else child.stdin.end(opts.input ?? "")
    })
  }
}

/** Whether a machine answered lately: placement skips one that didn't, until maintain() reaches it again. */
export interface Reach {
  ok: boolean
  at: number
  error: string | null
}

/**
 * Every SSH machine's box. `of(boxId)` is the machine's own view (its root, node, claude and secrets folder come
 * from its last test); LocalRunnerRouter routes `ssh-*` boxes here.
 */
export class MachineProvider implements BoxProvider {
  readonly name = "ssh"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  private readonly reach = new Map<string, Reach>()

  constructor(
    private readonly o: {
      machines: (id: string) => Machine | null
      transport: MachineTransport
      /** Mock mode and tests: the claude command agents run (CLAUDE_BIN), and node is this process's. */
      claudeBin?: string
      nodeBin?: string
    },
  ) {}

  get transport() {
    return this.o.transport
  }

  machine(boxId: string): Machine {
    if (!isMachineBox(boxId)) throw new Error(`${boxId} isn't an SSH machine`)
    const m = this.o.machines(machineOfBox(boxId))
    if (!m) throw new Error(`SSH machine ${machineOfBox(boxId)} was removed`)
    return m
  }

  reachOf(machineId: string): Reach | null {
    return this.reach.get(machineId) ?? null
  }

  /** Run a script (or, with `remote`, a command fed `input`) and note whether the machine answered. */
  async run(m: Machine, opts: SshRunOptions): Promise<SshRunResult> {
    const res = await this.o.transport.run(m, opts)
    const down = this.o.transport.kind === "ssh" && res.exitCode === SSH_FAILED
    this.reach.set(m.id, { ok: !down, at: Date.now(), error: down ? sshError(res.stderr) : null })
    return res
  }

  private script(m: Machine, command: string) {
    return scriptFor(command, m.lastTest?.pathDirs ?? [])
  }

  of(boxId: string): BoxProvider {
    const m = this.machine(boxId)
    const t = m.lastTest
    const view = Object.create(this) as MachineProvider & { secretsDir?: string; nodeBin: string; claudeBin: string }
    Object.defineProperty(view, "nodeBin", { value: this.o.nodeBin ?? t?.tools.node.path ?? "node" })
    Object.defineProperty(view, "claudeBin", { value: this.o.claudeBin ?? t?.tools.claude.path ?? "claude" })
    if (t?.secretsDir && this.o.transport.kind === "ssh") Object.defineProperty(view, "secretsDir", { value: t.secretsDir })
    return view
  }

  /** Its work folder, absolute, from its last test. Placement only picks tested machines, so this is set. */
  root(boxId: string): string {
    const m = this.machine(boxId)
    if (!m.lastTest?.workDir) throw new Error(`${m.name} hasn't been tested yet: Test connection in Settings › Machines`)
    return m.lastTest.workDir
  }

  async create(): Promise<string> {
    throw new Error("SSH machines are added in Settings › Machines, never made from the pool")
  }

  async snapshot(): Promise<BoxSnapshotInfo> {
    throw new Error("SSH machines are your own computers: they're never snapshotted")
  }

  async health(boxId: string): Promise<BoxHealth> {
    let m: Machine
    try {
      m = this.machine(boxId)
    } catch {
      return "gone"
    }
    const res = await this.run(m, { input: "echo boxyard-ok", timeoutMs: 30_000 })
    return res.exitCode === 0 && res.stdout.toString().includes("boxyard-ok") ? "running" : res.exitCode === SSH_FAILED ? "error" : "unknown"
  }

  /** Reach it and make sure its folders are there; throws (with ssh's reason) when it can't be reached. */
  async wake(boxId: string): Promise<void> {
    const m = this.machine(boxId)
    const root = this.root(boxId)
    const res = await this.run(m, { input: this.script(m, `umask 077 && mkdir -p ${q(root + "/.boxyard")} ${q(root + "/tasks")}`), timeoutMs: 60_000 })
    if (res.exitCode === SSH_FAILED && this.o.transport.kind === "ssh") throw new Error(`can't reach ${m.name} over SSH: ${sshError(res.stderr)}`)
    if (res.exitCode !== 0) throw new Error(`can't make Box Yard's folder on ${m.name}: ${res.stderr.trim().slice(-300)}`)
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const m = this.machine(boxId)
    const res = await this.run(m, { input: this.script(m, command) })
    const down = res.exitCode === SSH_FAILED && this.o.transport.kind === "ssh"
    return { exitCode: res.exitCode, stdout: res.stdout.toString("utf8"), stderr: down ? `can't reach ${m.name} over SSH: ${sshError(res.stderr)}` : res.stderr }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const m = this.machine(boxId)
    const res = await this.run(m, { input: this.script(m, command), onOutput })
    if (res.exitCode === SSH_FAILED && this.o.transport.kind === "ssh") throw new Error(`lost the SSH connection to ${m.name}`)
    return { exitCode: res.exitCode }
  }

  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    try {
      const m = this.machine(boxId)
      await this.run(m, { input: this.script(m, command), signal })
    } catch {}
  }

  /**
   * Write a file, readable by the machine's user only. A task's task.json and signing.key go to the machine's tmpfs
   * when it has one (`secretsDir`), linked from the task folder: they never touch its disk.
   */
  async writeFile(boxId: string, filePath: string, content: string | Buffer): Promise<void> {
    const m = this.machine(boxId)
    const secrets = (this.of(boxId) as BoxProvider).secretsDir
    const dir = path.posix.dirname(filePath)
    const name = path.posix.basename(filePath)
    let script: string
    if (secrets && (name === "task.json" || name === "signing.key") && path.posix.dirname(dir) === `${this.root(boxId)}/tasks`) {
      const held = `${secrets}/${path.posix.basename(dir)}.${name === "task.json" ? "json" : "signing.key"}`
      // The secrets folder must be this user's own, and a folder: never one someone else made or linked.
      script = [
        `umask 077 && mkdir -p ${q(secrets)}`,
        `if [ ! -O ${q(secrets)} ] || [ -L ${q(secrets)} ]; then echo "${secrets} isn't this user's own folder" >&2; exit 1; fi`,
        `chmod 700 ${q(secrets)}`,
        writeFileScript(held, content),
        `mkdir -p ${q(dir)} && ln -sfn ${q(held)} ${q(filePath)}`,
      ].join("\n")
    } else {
      script = writeFileScript(filePath, content)
    }
    const res = await this.run(m, { input: this.script(m, script) })
    if (res.exitCode !== 0) throw new Error(`writing ${name} on ${m.name} failed: ${res.exitCode === SSH_FAILED ? sshError(res.stderr) : res.stderr.trim().slice(-300)}`)
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const m = this.machine(boxId)
    const res = await this.run(m, { input: this.script(m, `cat ${q(filePath)}`) })
    if (res.exitCode !== 0) throw new Error(`reading ${filePath} on ${m.name} failed: ${res.stderr.trim().slice(-300)}`)
    return res.stdout
  }

  /** Streams the file over SSH's stdin: no size limit, nothing on either disk but the destination. */
  async uploadFile(boxId: string, localPath: string, destination: string): Promise<void> {
    const m = this.machine(boxId)
    const res = await this.run(m, { remote: uploadCommand(destination), input: fs.createReadStream(localPath) })
    if (res.exitCode !== 0) throw new Error(`uploading to ${m.name} failed: ${res.exitCode === SSH_FAILED ? sshError(res.stderr) : res.stderr.trim().slice(-300)}`)
  }

  /** A preview on the machine, at its address on your network (the agent's server listens on 0.0.0.0). */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const m = this.machine(boxId)
    if (this.o.transport.kind === "folder") return `http://localhost:${port}`
    return `http://${m.host.includes(":") && !m.host.startsWith("[") ? `[${m.host}]` : m.host}:${port}`
  }

  /** Box Yard never removes a machine's folder: each task's folder goes with its task (TaskManager.removeTaskDir). */
  async destroy(): Promise<void> {}

  async usage(): Promise<BoxUsageProbe> {
    return { source: "estimated" }
  }
}
