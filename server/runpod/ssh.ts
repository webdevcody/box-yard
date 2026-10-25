import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { q } from "../providers/types.js"

/** A pod's direct SSH endpoint (its public IP and the port mapped to 22). */
export interface SshTarget {
  podId: string
  host: string
  port: number
}

export interface SshRunOptions {
  input?: string | Buffer | fs.ReadStream
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** Open a connection of its own instead of sharing the pod's master connection (the first contact, before init). */
  direct?: boolean
}

export interface SshRunResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

/**
 * SSH to RunPod pods with the system `ssh`: Box Yard's own key pair (made once in `<dataDir>/runpod`, never the
 * owner's personal keys), one known_hosts file per pod (pods reuse IPs and ports, each with new host keys), and one
 * shared master connection per pod (ControlMaster), so the many short commands Box Yard runs don't each pay for a
 * handshake. Every command runs in a login shell, so /etc/profile.d/boxyard.sh (written by runpod/init.sh) applies.
 */
export class SshPool {
  private readonly keyFile: string

  constructor(private readonly dir: string) {
    this.keyFile = path.join(dir, "id_ed25519")
  }

  /** The public key pods are started with (PUBLIC_KEY), made on first use. */
  publicKey(): string {
    if (!fs.existsSync(this.keyFile)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "boxyard-runpod", "-f", this.keyFile], { stdio: "ignore" })
    }
    return fs.readFileSync(`${this.keyFile}.pub`, "utf8").trim()
  }

  private args(t: SshTarget, direct: boolean): string[] {
    this.publicKey()
    return [
      "-i", this.keyFile,
      "-p", String(t.port),
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${path.join(this.dir, `known_hosts-${t.podId.replace(/[^\w-]/g, "")}`)}`,
      "-o", "ConnectTimeout=20",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", "LogLevel=ERROR",
      ...(direct ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"] : ["-o", "ControlMaster=auto", "-o", `ControlPath=/tmp/byrp-%C`, "-o", "ControlPersist=600"]),
      `root@${t.host}`,
    ]
  }

  /** Run `command` on the pod in a login shell. Resolves with exit code 255 (and ssh's stderr) when it can't connect. */
  run(t: SshTarget, command: string, opts: SshRunOptions = {}): Promise<SshRunResult> {
    return new Promise((resolve) => {
      const child = spawn("ssh", [...this.args(t, Boolean(opts.direct)), `bash -lc ${q(command)}`], { stdio: ["pipe", "pipe", "pipe"] })
      const out: Buffer[] = []
      let stderr = ""
      let done = false
      const finish = (r: SshRunResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        opts.signal?.removeEventListener("abort", onAbort)
        resolve(r)
      }
      const onAbort = () => child.kill("SIGTERM")
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stderr += `\n(timed out after ${Math.round(opts.timeoutMs! / 1000)} s)`
            child.kill("SIGKILL")
          }, opts.timeoutMs)
        : undefined
      child.stdout.on("data", (d: Buffer) => {
        if (opts.onOutput) opts.onOutput(d.toString("utf8"))
        else out.push(d)
      })
      child.stderr.on("data", (d: Buffer) => {
        if (opts.onOutput) opts.onOutput(d.toString("utf8"))
        else stderr += d.toString("utf8")
      })
      child.on("error", (err) => finish({ exitCode: 255, stdout: Buffer.concat(out), stderr: stderr + err.message }))
      child.on("close", (code) => finish({ exitCode: code ?? 255, stdout: Buffer.concat(out), stderr }))
      child.stdin.on("error", () => {})
      if (opts.input instanceof fs.ReadStream) opts.input.pipe(child.stdin)
      else child.stdin.end(opts.input ?? "")
    })
  }

  /** Close the shared connection to a pod (it was terminated). */
  close(t: SshTarget) {
    try {
      execFileSync("ssh", [...this.args(t, false).slice(0, -1), "-O", "exit", `root@${t.host}`], { stdio: "ignore", timeout: 5000 })
    } catch {}
  }

  forget(podId: string) {
    fs.rmSync(path.join(this.dir, `known_hosts-${podId.replace(/[^\w-]/g, "")}`), { force: true })
  }
}
