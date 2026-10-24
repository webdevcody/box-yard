import { Box } from "@upstash/box"
import fs from "node:fs"
import type { Config } from "../config.js"
import type { WorkerSize } from "../../shared/types.js"
import { retry } from "../util/retry.js"
import type { CredentialStore } from "../credentials.js"
import { UPSTASH_MAX_UPLOAD_BYTES } from "../upload.js"
import { q, type BoxHealth, type BoxProvider, type BoxUsageProbe, type ExecResult } from "./types.js"

const ROOT = "/workspace/home"
const READ_CHUNK = 8 * 1024 * 1024 // server limit for one ranged read

/** Install Claude Code (unless a snapshot already has it) and set up git. */
export function workerSetupScript(c: Pick<Config, "gitUserName" | "gitUserEmail">) {
  return [
    "set -e",
    `mkdir -p ${ROOT}/.boxyard ${ROOT}/tasks`,
    "command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)",
    "command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1",
    `git config --global user.name ${q(c.gitUserName)}`,
    `git config --global user.email ${q(c.gitUserEmail)}`,
    "git config --global init.defaultBranch main",
    "claude --version",
  ].join(" && ")
}

export class UpstashProvider implements BoxProvider {
  readonly name = "upstash"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  readonly maxUploadBytes = UPSTASH_MAX_UPLOAD_BYTES
  private cache = new Map<string, Box>()
  private cacheFor = ""

  /** `creds` reads the key and tokens on each use (Settings › Credentials, env wins); without it, the env values at startup. */
  constructor(
    private readonly c: Config,
    private readonly creds?: Pick<CredentialStore, "get" | "claudeEnv">,
  ) {}

  private get apiKey() {
    return this.creds ? this.creds.get("upstashBoxApiKey") : this.c.upstashBoxApiKey
  }
  private get gitToken() {
    return this.creds ? this.creds.get("githubToken") : this.c.githubToken
  }

  /** Cached Box handles carry the key and git token they were made with, so a new key or token drops them. */
  private boxes(): Map<string, Box> {
    const key = `${this.apiKey}\n${this.gitToken}`
    if (key !== this.cacheFor) {
      this.cache.clear()
      this.cacheFor = key
    }
    return this.cache
  }

  root() {
    return ROOT
  }

  private async box(boxId: string): Promise<Box> {
    const cache = this.boxes()
    const hit = cache.get(boxId)
    if (hit) return hit
    const box = await retry(() => Box.get(boxId, { apiKey: this.apiKey, gitToken: this.gitToken }))
    cache.set(boxId, box)
    return box
  }

  async create({ labels, size }: { labels: string[]; size?: WorkerSize }): Promise<string> {
    const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" }
    if (this.creds) Object.assign(env, this.creds.claudeEnv())
    else {
      if (this.c.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.c.claudeOauthToken
      if (this.c.anthropicApiKey) env.ANTHROPIC_API_KEY = this.c.anthropicApiKey
    }
    const gitToken = this.gitToken
    if (gitToken) env.GITHUB_TOKEN = gitToken
    const opts = {
      apiKey: this.apiKey,
      runtime: this.c.workerRuntime as "node",
      size: size ?? this.c.workerSize,
      labels: labels.map((l) => l.replace(/[^\w.:-]/g, "-").slice(0, 20)).slice(0, 5),
      env,
      git: gitToken
        ? { token: gitToken, userName: this.c.gitUserName, userEmail: this.c.gitUserEmail }
        : undefined,
    }
    // Create is not idempotent, so only one attempt; callers handle failure.
    const box = this.c.workerSnapshotId ? await Box.fromSnapshot(this.c.workerSnapshotId, opts) : await Box.create(opts)
    this.boxes().set(box.id, box)
    try {
      const setup = await this.exec(box.id, workerSetupScript(this.c))
      if (setup.exitCode !== 0) throw new Error(`worker setup failed: ${(setup.stderr || setup.stdout).slice(-1500)}`)
    } catch (err) {
      await this.destroy(box.id).catch(() => {})
      throw err
    }
    return box.id
  }

  async health(boxId: string): Promise<BoxHealth> {
    try {
      const box = await this.box(boxId)
      const { status } = await retry(() => box.getStatus())
      if (status === "paused") return "paused"
      if (status === "deleted") return "gone"
      if (status === "error") return "error"
      return "running"
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code === 404 || /not found/i.test(String((err as Error).message))) {
        this.cache.delete(boxId)
        return "gone"
      }
      return "unknown"
    }
  }

  async wake(boxId: string) {
    const health = await this.health(boxId)
    if (health === "paused") {
      const box = await this.box(boxId)
      await retry(() => box.resume())
    }
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const box = await this.box(boxId)
    // `bash -c` so every command gets the same shell, whatever the box default is.
    const run = await retry(() => box.exec.command(`bash -c ${q(command)}`))
    return {
      exitCode: run.exitCode ?? (run.status === "completed" ? 0 : 1),
      stdout: run.stdout || (run.status === "completed" ? run.result : ""),
      stderr: run.stderr || (run.status !== "completed" ? run.result : ""),
    }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const box = await this.box(boxId)
    // Not retried: output may already have been handed over. A caller that fails tries again later.
    const run = await box.exec.stream(`bash -c ${q(command)}`)
    let exitCode: number | null = null
    for await (const chunk of run) {
      if (chunk.type === "output") onOutput(chunk.data)
      else if (chunk.type === "exit") exitCode = chunk.exitCode
    }
    return { exitCode: exitCode ?? (run.status === "completed" ? 0 : 1) }
  }

  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    try {
      const box = await this.box(boxId)
      const run = await box.exec.stream(`bash -c ${q(command)}`)
      const onAbort = () => void run.cancel().catch(() => {})
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        for await (const _chunk of run) {
          if (signal.aborted) break
        }
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    } catch {
      // Dropped connections are expected; the caller re-attaches if needed.
    }
  }

  async writeFile(boxId: string, filePath: string, content: string | Buffer) {
    const box = await this.box(boxId)
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
    await retry(() => box.files.write({ path: filePath, content: data.toString("base64"), encoding: "base64" }))
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const box = await this.box(boxId)
    const stat = await retry(() => box.files.stat(filePath, { follow: true }))
    const parts: Buffer[] = []
    for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, stat.size - offset)
      const b64 = await retry(() => box.files.read(filePath, { encoding: "base64", offset, length }))
      parts.push(Buffer.from(b64, "base64"))
    }
    return Buffer.concat(parts)
  }

  async uploadFile(boxId: string, localPath: string, destination: string) {
    if (!fs.existsSync(localPath)) throw new Error(`upload: ${localPath} does not exist`)
    const box = await this.box(boxId)
    await retry(() => box.files.upload([{ path: localPath, destination }]))
  }

  async publicUrl(boxId: string, port: number) {
    const box = await this.box(boxId)
    const res = await retry(() => box.getPublicURL(port))
    return res.url
  }

  private async diskBytes(boxId: string): Promise<number | null> {
    const res = await this.exec(boxId, `du -sk ${q(ROOT)} 2>/dev/null | awk '{print $1}'`)
    if (res.exitCode !== 0) return null
    const kb = Number.parseInt(res.stdout.trim(), 10)
    return Number.isFinite(kb) ? kb * 1024 : null
  }

  async listIds(label: string): Promise<string[]> {
    const boxes = await retry(() => Box.list({ apiKey: this.apiKey, label }))
    return boxes.filter((b) => b.status !== "deleted").map((b) => b.id)
  }

  async usage(boxId: string): Promise<BoxUsageProbe> {
    const box = await this.box(boxId)
    const status = await retry(() => box.getStatus()).catch(() => ({}))
    const raw = status as Record<string, unknown>
    const diskBytes = await this.diskBytes(boxId).catch(() => null)
    const size = sizeOf(raw) ?? sizeOf(box as unknown as Record<string, unknown>) ?? this.c.workerSize
    return {
      size,
      keepAlive: boolOf(raw, ["keepAlive", "keep_alive", "keepalive", "isKeepAlive"]) ?? boolOf(box as unknown as Record<string, unknown>, ["keepAlive", "keep_alive", "keepalive", "isKeepAlive"]) ?? false,
      diskBytes,
      activeMs: millisOf(raw, ["activeMs", "active_ms", "activeCpuMs", "active_cpu_ms", "cpuMs", "cpu_ms"]),
      uptimeMs: millisOf(raw, ["uptimeMs", "uptime_ms", "uptime"]),
      source: hasActualUsage(raw) ? "actual" : "estimated",
    }
  }

  async destroy(boxId: string) {
    try {
      const box = await this.box(boxId)
      await retry(() => box.delete())
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code !== 404) throw err
    } finally {
      this.cache.delete(boxId)
    }
  }
}

function sizeOf(obj: Record<string, unknown>): BoxUsageProbe["size"] | undefined {
  const v = String(obj.size ?? obj.boxSize ?? obj.runtimeSize ?? "").toLowerCase()
  return v === "small" || v === "medium" || v === "large" ? v : undefined
}

function boolOf(obj: Record<string, unknown>, keys: string[]) {
  for (const k of keys) if (typeof obj[k] === "boolean") return obj[k] as boolean
  return undefined
}

function millisOf(obj: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(k.toLowerCase().includes("second") ? v * 1000 : v))
  }
  return null
}

function hasActualUsage(obj: Record<string, unknown>) {
  return millisOf(obj, ["activeMs", "active_ms", "activeCpuMs", "active_cpu_ms", "cpuMs", "cpu_ms", "uptimeMs", "uptime_ms", "uptime"]) !== null
}
