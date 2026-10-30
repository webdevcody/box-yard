// The model list the pickers show (GET /api/models): the installed claude CLI's own list, asked with the stream-json
// `initialize` control request (no prompt, no API call), merged over the built-in table in shared/models.ts. Asked
// once, then again after a while, so a CLI update brings its new models without a Box Yard release.
import { spawn } from "node:child_process"
import os from "node:os"
import { BUILTIN_MODELS, mergeCliModels, type CliModelInfo, type ModelCatalog } from "../shared/models.js"

const PROBE_TIMEOUT_MS = 20_000
/** A good answer is kept this long; a failed one is retried sooner. */
const FRESH_MS = 6 * 60 * 60_000
const RETRY_MS = 10 * 60_000

/** Ask `claudeBin` for its models: the `models` of its `initialize` control response. */
export function probeCliModels(claudeBin: string, env: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): Promise<CliModelInfo[]> {
  const [bin, ...pre] = claudeBin.split(" ")
  return new Promise((resolve, reject) => {
    let done = false
    let out = ""
    let err = ""
    const finish = (e: Error | null, models?: CliModelInfo[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin?.end()
      child.kill("SIGTERM")
      if (e) reject(e)
      else resolve(models!)
    }
    const args = [...pre, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"]
    const child = spawn(bin!, args, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => finish(new Error(`claude didn't list its models within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    child.on("error", (e) => finish(new Error(`couldn't run claude (${claudeBin}): ${e.message}`)))
    child.on("close", (code) => finish(new Error(`claude exited (${code}) before listing its models${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""}`)))
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d))
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line.startsWith("{")) continue
        let msg: { type?: string; response?: { subtype?: string; request_id?: string; error?: string; response?: { models?: unknown } } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type !== "control_response" || msg.response?.request_id !== "models") continue
        const models = msg.response.response?.models
        if (msg.response.subtype !== "success" || !Array.isArray(models)) return finish(new Error(msg.response.error || "claude's initialize response had no models"))
        return finish(null, models as CliModelInfo[])
      }
    })
    child.stdin!.on("error", () => {})
    child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n")
  })
}

/** The cached catalogue. `get()` asks the CLI the first time and when the last answer is stale, one probe at a time. */
export class ClaudeModels {
  private catalog: ModelCatalog | null = null
  private nextAt = 0
  private inflight: Promise<ModelCatalog> | null = null

  constructor(
    private readonly opts: {
      claudeBin: string
      env: () => NodeJS.ProcessEnv
      version: () => Promise<string | null>
      probe?: typeof probeCliModels
      now?: () => number
    },
  ) {}

  get(refresh = false): Promise<ModelCatalog> {
    const now = this.opts.now?.() ?? Date.now()
    if (this.catalog && !refresh && now < this.nextAt) return Promise.resolve(this.catalog)
    return (this.inflight ??= this.load().finally(() => (this.inflight = null)))
  }

  private async load(): Promise<ModelCatalog> {
    const probe = this.opts.probe ?? probeCliModels
    const [version, rows] = await Promise.all([
      this.opts.version().catch(() => null),
      probe(this.opts.claudeBin, this.opts.env()).catch((e: Error) => e),
    ])
    const now = this.opts.now?.() ?? Date.now()
    if (rows instanceof Error) {
      // Keep a list the CLI gave earlier over the built-in one.
      this.catalog =
        this.catalog?.source === "cli"
          ? this.catalog
          : { models: [...BUILTIN_MODELS], source: "builtin", cliVersion: version, fetchedAt: now, error: rows.message }
      this.nextAt = now + RETRY_MS
    } else {
      this.catalog = { models: mergeCliModels(BUILTIN_MODELS, rows), source: "cli", cliVersion: version, fetchedAt: now }
      this.nextAt = now + FRESH_MS
    }
    return this.catalog
  }
}
