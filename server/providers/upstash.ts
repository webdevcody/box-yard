import { Box, type Snapshot } from "@upstash/box"
import fs from "node:fs"
import type { Config } from "../config.js"
import type { WorkerSize } from "../../shared/types.js"
import { errorMessage, retry } from "../util/retry.js"
import type { CredentialStore } from "../credentials.js"
import { UPSTASH_MAX_UPLOAD_BYTES } from "../upload.js"
import { q, type BoxHealth, type BoxProvider, type BoxSnapshotInfo, type BoxUsageProbe, type ExecResult } from "./types.js"
import { GITHUB_HELPER } from "../gitShare.js"

const ROOT = "/workspace/home"
const READ_CHUNK = 8 * 1024 * 1024 // server limit for one ranged read
/** How long a snapshot of a big disk may take. The SDK gives up after 5 minutes; we keep waiting this long by name. */
const SNAPSHOT_WAIT_MS = 30 * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The box's own git credential: the turn's $GITHUB_TOKEN, read when git asks, after an empty helper that drops any
 * other (a box made before this fix had `credential.helper=store` and a ~/.git-credentials holding the global token,
 * written by Box.create's `git` option, which answered before a project's own token). Holds no secret itself, so
 * every git command on the box, even outside a task's repo, uses the token of the turn that runs it. Run at create
 * and before every turn, so older boxes lose their stored token too.
 */
export const BOX_GIT_CREDENTIAL_SCRIPT = [
  `git config --global --replace-all credential.helper ''`,
  `git config --global --add credential.helper ${q(GITHUB_HELPER)}`,
  `rm -f "$HOME/.git-credentials"`,
].join(" && ")

/**
 * Install Claude Code (unless a snapshot already has it) and set up git. No credential is baked into the box: tokens
 * and the git author come with each turn (task.json), so one box never acts as another project's account.
 */
export function workerSetupScript(c: Pick<Config, "gitUserName" | "gitUserEmail">) {
  return [
    "set -e",
    `mkdir -p ${ROOT}/.boxyard ${ROOT}/tasks`,
    "command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)",
    "command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1",
    `git config --global user.name ${q(c.gitUserName)}`,
    `git config --global user.email ${q(c.gitUserEmail)}`,
    "git config --global init.defaultBranch main",
    BOX_GIT_CREDENTIAL_SCRIPT,
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

  /** `creds` reads the Box API key on each use (Settings › Credentials, env wins); without it, the env value at startup. */
  constructor(
    private readonly c: Config,
    private readonly creds?: Pick<CredentialStore, "get">,
  ) {}

  private get apiKey() {
    return this.creds ? this.creds.get("upstashBoxApiKey") : this.c.upstashBoxApiKey
  }

  /** Cached Box handles carry the key they were made with, so a new key drops them. */
  private boxes(): Map<string, Box> {
    const key = this.apiKey
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
    const box = await retry(() => Box.get(boxId, { apiKey: this.apiKey }))
    cache.set(boxId, box)
    return box
  }

  async create({ labels, size, snapshotId }: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    // No credentials at create (F1, F2 of the identities report): the SDK's `git` option wrote the global token into
    // the box's git config, where it answered before a project's own, and box env held the global Claude login for
    // every agent on the box. Each turn brings its own (task.json).
    const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" }
    const opts = {
      apiKey: this.apiKey,
      runtime: this.c.workerRuntime as "node",
      size: size ?? this.c.workerSize,
      labels: labels.map((l) => l.replace(/[^\w.:-]/g, "-").slice(0, 20)).slice(0, 5),
      env,
    }
    // Create is not idempotent, so only one attempt; callers handle failure. A project's snapshot comes first, then
    // the install-wide WORKER_SNAPSHOT_ID. A box from a snapshot gets the size and env passed here.
    const from = snapshotId || this.c.workerSnapshotId
    const box = from ? await Box.fromSnapshot(from, opts) : await Box.create(opts)
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

  async snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    const box = await this.box(boxId)
    let snap: Snapshot
    try {
      snap = await box.snapshot({ name })
    } catch (err) {
      // The SDK stops waiting after 5 minutes while a big disk is still being saved: keep waiting for it by name.
      if (!/timed out/i.test(errorMessage(err))) throw err
      snap = await this.waitForSnapshot(box, name)
    }
    return { id: snap.id, bytes: typeof snap.size_bytes === "number" ? snap.size_bytes : null }
  }

  private async waitForSnapshot(box: Box, name: string): Promise<Snapshot> {
    const until = Date.now() + SNAPSHOT_WAIT_MS
    let found: Snapshot | undefined
    while (Date.now() < until) {
      await sleep(5_000)
      found = (await retry(() => box.listSnapshots())).find((s) => s.name === name)
      if (found?.status === "ready") return found
      if (found?.status === "error") throw new Error(`snapshot ${found.id} failed at Upstash`)
    }
    // Don't leave a half-made snapshot behind to be billed for.
    if (found) await this.deleteSnapshot(found.id).catch(() => {})
    throw new Error(`snapshot ${name} wasn't ready after ${SNAPSHOT_WAIT_MS / 60_000} minutes`)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    // Box.deleteSnapshots without ids deletes every snapshot on the account: never let an empty id through.
    if (!snapshotId.trim()) throw new Error("deleteSnapshot needs a snapshot id")
    try {
      await retry(() => Box.deleteSnapshots({ apiKey: this.apiKey, snapshotIds: [snapshotId] }))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  snapshotDirs() {
    return { home: "$HOME", tmp: "/tmp" }
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
      if (isNotFound(err)) {
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

  async liveIds(): Promise<string[]> {
    // No label: boxes made before install labels existed must count as alive too.
    const boxes = await retry(() => Box.list({ apiKey: this.apiKey }))
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
      // Already gone (deleted in the console, or by an earlier try): that's what was asked for.
      if (!isNotFound(err)) throw err
    } finally {
      this.cache.delete(boxId)
    }
  }
}

/**
 * The provider says the box doesn't exist: 404/410, or a "not found" error with no status. Anything else (network,
 * 5xx, timeouts, 401/403 even when the text says "not found", e.g. an API key) may pass, so it isn't "gone".
 */
export function isNotFound(err: unknown): boolean {
  const code = (err as { statusCode?: number } | null)?.statusCode
  if (typeof code === "number") return code === 404 || code === 410
  return /not found/i.test(String((err as Error | null)?.message ?? ""))
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
