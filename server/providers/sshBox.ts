import fs from "node:fs"
import path from "node:path"
import type { SshPool, SshTarget } from "../runpod/ssh.js"
import { q, type ExecResult } from "./types.js"

/**
 * The parts of a GPU cloud's BoxProvider that only need SSH to a running machine: commands, files and uploads, all
 * through Box Yard's own SshPool (server/runpod/ssh.ts). RunPod pods and Vast.ai instances both extend it, and only
 * say how a box id becomes an SSH target. Every command touches /box/.heartbeat, which the machine's own watchdog reads.
 */
export abstract class SshBoxProvider {
  constructor(protected readonly sshPool: SshPool) {}

  /** Where to SSH for a box; throws when its machine isn't running. */
  protected abstract target(boxId: string): Promise<SshTarget>

  /** Every command touches the heartbeat the machine's watchdog reads. */
  protected wrap(command: string) {
    return `touch /box/.heartbeat 2>/dev/null; ${command}`
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const r = await this.sshPool.run(await this.target(boxId), this.wrap(command), { timeoutMs: 30 * 60_000 })
    return { exitCode: r.exitCode, stdout: r.stdout.toString("utf8"), stderr: r.stderr }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const r = await this.sshPool.run(await this.target(boxId), this.wrap(command), { onOutput })
    if (r.exitCode === 255) throw new Error(`SSH to ${boxId} failed`)
    return { exitCode: r.exitCode }
  }

  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    try {
      await this.sshPool.run(await this.target(boxId), this.wrap(command), { signal })
    } catch {}
  }

  async writeFile(boxId: string, filePath: string, content: string | Buffer): Promise<void> {
    const tmp = `${filePath}.by-tmp`
    const r = await this.sshPool.run(await this.target(boxId), `mkdir -p ${q(path.posix.dirname(filePath))} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(filePath)}`, { input: content, timeoutMs: 10 * 60_000 })
    if (r.exitCode !== 0) throw new Error(`Writing ${filePath} on ${boxId} failed: ${r.stderr.slice(-300)}`)
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const r = await this.sshPool.run(await this.target(boxId), `cat ${q(filePath)}`, { timeoutMs: 10 * 60_000 })
    if (r.exitCode !== 0) throw Object.assign(new Error(`Reading ${filePath} on ${boxId} failed: ${r.stderr.slice(-300)}`), { code: r.exitCode === 1 ? "ENOENT" : undefined })
    return r.stdout
  }

  async uploadFile(boxId: string, localPath: string, destination: string): Promise<void> {
    const tmp = `${destination}.by-tmp`
    const r = await this.sshPool.run(await this.target(boxId), `mkdir -p ${q(path.posix.dirname(destination))} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(destination)}`, {
      input: fs.createReadStream(localPath),
      timeoutMs: 60 * 60_000,
    })
    if (r.exitCode !== 0) throw new Error(`Uploading to ${destination} on ${boxId} failed: ${r.stderr.slice(-300)}`)
  }
}
