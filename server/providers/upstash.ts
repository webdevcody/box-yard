import { Box } from "@upstash/box"
import fs from "node:fs"
import type { Config } from "../config.js"
import { retry } from "../util/retry.js"
import { q, type BoxHealth, type BoxProvider, type ExecResult } from "./types.js"

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
  private cache = new Map<string, Box>()

  constructor(private readonly c: Config) {}

  root() {
    return ROOT
  }

  private async box(boxId: string): Promise<Box> {
    const hit = this.cache.get(boxId)
    if (hit) return hit
    const box = await retry(() => Box.get(boxId, { apiKey: this.c.upstashBoxApiKey, gitToken: this.c.githubToken }))
    this.cache.set(boxId, box)
    return box
  }

  async create({ labels }: { labels: string[] }): Promise<string> {
    const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" }
    if (this.c.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.c.claudeOauthToken
    if (this.c.anthropicApiKey) env.ANTHROPIC_API_KEY = this.c.anthropicApiKey
    if (this.c.githubToken) env.GITHUB_TOKEN = this.c.githubToken
    const opts = {
      apiKey: this.c.upstashBoxApiKey,
      runtime: this.c.workerRuntime as "node",
      size: this.c.workerSize,
      labels: labels.map((l) => l.replace(/[^\w.:-]/g, "-").slice(0, 20)).slice(0, 5),
      env,
      git: this.c.githubToken
        ? { token: this.c.githubToken, userName: this.c.gitUserName, userEmail: this.c.gitUserEmail }
        : undefined,
    }
    // Create is not idempotent, so only one attempt; callers handle failure.
    const box = this.c.workerSnapshotId ? await Box.fromSnapshot(this.c.workerSnapshotId, opts) : await Box.create(opts)
    this.cache.set(box.id, box)
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
