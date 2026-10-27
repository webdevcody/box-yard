import { DOCKER_PATHS, docker } from "./cli.js"

export interface DockerInfo {
  /** The CLI that answered, or null when none did. */
  bin: string | null
  installed: boolean
  running: boolean
  version: string | null
  cpus: number | null
  memoryBytes: number | null
  /** Why containers can't run now, in plain words, or null. */
  error: string | null
}

const OK_TTL_MS = 15_000
const FAIL_TTL_MS = 3_000

export const DOCKER_NOT_INSTALLED = "Docker isn't installed on the computer running Box Yard: install Docker Desktop (or Docker Engine), start it, then try again"
export const DOCKER_NOT_RUNNING = "Docker is installed but not running on the computer running Box Yard: start Docker Desktop (or the Docker daemon), then try again"

/**
 * Is Docker here and is its daemon answering? Finds the CLI (Docker Desktop doesn't always put it on the PATH) and
 * asks `docker info`; the answer is cached for a few seconds, so placement can ask on every pass. `bin` pins the CLI
 * (DOCKER_BIN, or a fake one in tests).
 */
export class DockerEngine {
  private cached: { at: number; info: DockerInfo } | null = null
  private pending: Promise<DockerInfo> | null = null

  constructor(private readonly opts: { bin?: string | null } = {}) {}

  async info(fresh = false): Promise<DockerInfo> {
    const c = this.cached
    if (!fresh && c && Date.now() - c.at < (c.info.error ? FAIL_TTL_MS : OK_TTL_MS)) return c.info
    this.pending ??= this.check().then((info) => {
      this.cached = { at: Date.now(), info }
      return info
    }).finally(() => (this.pending = null))
    return this.pending
  }

  /** The docker CLI to run, or throws why Docker can't be used now. */
  async bin(): Promise<string> {
    const info = await this.info()
    if (info.error || !info.bin) throw new Error(info.error ?? DOCKER_NOT_INSTALLED)
    return info.bin
  }

  /** A docker command failed in a way that says the daemon went away: ask again next time. */
  forget() {
    this.cached = null
  }

  private async check(): Promise<DockerInfo> {
    const none: DockerInfo = { bin: null, installed: false, running: false, version: null, cpus: null, memoryBytes: null, error: DOCKER_NOT_INSTALLED }
    for (const bin of this.opts.bin ? [this.opts.bin] : DOCKER_PATHS) {
      const v = await docker(bin, ["--version"], { timeoutMs: 10_000 })
      if (v.code !== 0) continue
      const info = await docker(bin, ["info", "--format", "{{json .}}"], { timeoutMs: 20_000 })
      let parsed: { ServerVersion?: string; NCPU?: number; MemTotal?: number } | null = null
      try {
        parsed = JSON.parse(info.stdout.toString("utf8"))
      } catch {}
      if (info.code !== 0 || !parsed?.ServerVersion) return { ...none, bin, installed: true, error: DOCKER_NOT_RUNNING }
      return { bin, installed: true, running: true, version: parsed.ServerVersion, cpus: parsed.NCPU ?? null, memoryBytes: parsed.MemTotal ?? null, error: null }
    }
    return none
  }
}
