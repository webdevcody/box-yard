// A small client for Daytona's REST API (https://app.daytona.io/api, daytona.io/docs/openapi.json) and the toolbox
// every sandbox runs (daytona.io/docs/toolbox-openapi.json). Only sandbox-scoped calls: make, list, read and delete
// this install's sandboxes, set one's auto-stop, sign one port's preview URL, and run commands and move files in one.
// Never the account-wide ones (API keys, organizations, regions, runners, registries, secrets, warm pools): the key in
// Settings › Credentials (DAYTONA_API_KEY) needs only write:sandboxes and delete:sandboxes.

import fs from "node:fs"
import { daytonaGpuLabel } from "../../shared/daytona.js"

export const DAYTONA_API = "https://app.daytona.io/api"
/** Where the toolbox is when a sandbox doesn't say (its `toolboxProxyUrl`). */
export const DAYTONA_TOOLBOX = "https://proxy.app.daytona.io/toolbox"

/** A sandbox as GET /sandbox/{id} returns it. `memory` and `disk` are GiB. */
export interface DaytonaSandbox {
  id: string
  name?: string
  state?: string
  desiredState?: string
  errorReason?: string | null
  labels?: Record<string, string> | null
  cpu?: number
  gpu?: number
  gpuType?: string | string[] | null
  memory?: number
  disk?: number
  spot?: boolean
  spotEvictedAt?: string | null
  user?: string
  target?: string
  createdAt?: string
  updatedAt?: string
  autoStopInterval?: number
  toolboxProxyUrl?: string | null
}

export interface CreateSandboxInput {
  labels: Record<string, string>
  /** The Dockerfile the sandbox is built from (`FROM <image>` and Box Yard's tools). */
  dockerfile: string
  gpuTypes: string[]
  /** 0: no GPU. */
  gpus: number
  vcpus: number
  memoryGb: number
  diskGb: number
  spot: boolean
  /** Minutes without contact before Daytona stops it, which deletes it (ephemeral). */
  autoStopMinutes: number
}

/** An error Daytona returned, with its status (0: no answer). */
export class DaytonaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The body of POST /sandbox: built from a Dockerfile (the only way to set resources), ephemeral, private. */
export function createBody(input: CreateSandboxInput): Record<string, unknown> {
  return {
    user: "root",
    labels: input.labels,
    public: false,
    buildInfo: { dockerfileContent: input.dockerfile },
    cpu: input.vcpus,
    memory: input.memoryGb,
    disk: input.diskGb,
    ...(input.gpus > 0 ? { gpu: input.gpus, gpuType: input.gpuTypes, ...(input.spot ? { spot: true } : {}) } : {}),
    autoStopInterval: input.autoStopMinutes,
    // GPU sandboxes must be ephemeral (Daytona refuses them otherwise); CPU ones too, so none outlives its stop.
    autoDeleteInterval: 0,
  }
}

export class DaytonaApi {
  constructor(
    private readonly key: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = DAYTONA_API,
    /** Waits between retries of a 429 (Daytona's rate limits), shortened in tests. */
    private readonly retryMs = [1500, 4000],
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const key = this.key()
    if (!key) throw new DaytonaError("No Daytona API key: add one in Settings › Credentials (DAYTONA_API_KEY).", 401)
    return { Authorization: `Bearer ${key}`, "X-Daytona-Source": "box-yard", ...extra }
  }

  /** A call, retrying a 429 (it wasn't acted on, so even a create is safe to send again). */
  private async send(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000)
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers(init.headers),
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        })
      } catch (err) {
        if (err instanceof DaytonaError) throw err
        throw new DaytonaError(`Daytona ${method} ${this.what(url)}: ${(err as Error).message}`, 0)
      }
      if (res.status === 429 && attempt < this.retryMs.length) {
        await res.body?.cancel().catch(() => {})
        await sleep(this.retryMs[attempt]!)
        continue
      }
      if (res.ok) return res
      const text = await res.text().catch(() => "")
      let detail = text.slice(0, 300)
      try {
        const j = JSON.parse(text) as { message?: string | string[]; error?: string }
        detail = [Array.isArray(j.message) ? j.message.join("; ") : j.message, j.error].filter(Boolean)[0] ?? detail
      } catch {}
      throw new DaytonaError(`Daytona ${method} ${this.what(url)}: ${res.status} ${detail}`.trim(), res.status)
    }
  }

  /** "/sandbox/{id}" for messages: the path without the query, and never the host. */
  private what(url: string) {
    return new URL(url).pathname.replace(/^\/(api|toolbox)/, "")
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, `${this.base}${path}`, body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  /** Make a sandbox. It comes back building (pending_build, building_snapshot) and starts on its own. */
  async createSandbox(input: CreateSandboxInput): Promise<DaytonaSandbox> {
    const sb = await this.json<DaytonaSandbox>("POST", "/sandbox", createBody(input))
    if (!sb || typeof sb.id !== "string") throw new DaytonaError("Daytona POST /sandbox answered without a sandbox id", 500)
    return sb
  }

  /** The sandboxes carrying every one of these labels (deleted ones left out), across pages. */
  async listSandboxes(labels: Record<string, string>): Promise<DaytonaSandbox[]> {
    const out: DaytonaSandbox[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ labels: JSON.stringify(labels), limit: "200" })
      if (cursor) qs.set("cursor", cursor)
      // Daytona answered with a plain list before it paged; both shapes are read.
      const r = await this.json<DaytonaSandbox[] | { items?: DaytonaSandbox[]; nextCursor?: string | null }>("GET", `/sandbox?${qs}`)
      const items = Array.isArray(r) ? r : (r?.items ?? [])
      out.push(...items.filter((s) => s && typeof s.id === "string"))
      cursor = Array.isArray(r) ? null : (r?.nextCursor ?? null)
      if (!cursor) break
    }
    return out.filter((s) => s.state !== "destroyed" && s.state !== "destroying")
  }

  /** The sandbox, or null when it's gone. */
  async getSandbox(id: string): Promise<DaytonaSandbox | null> {
    try {
      const sb = await this.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`)
      return sb && typeof sb.id === "string" && sb.state !== "destroyed" ? sb : null
    } catch (err) {
      if (err instanceof DaytonaError && err.status === 404) return null
      throw err
    }
  }

  /** Delete a sandbox (its disk goes with it; Daytona finishes in the background). Already gone is fine. */
  async deleteSandbox(id: string): Promise<void> {
    try {
      await this.send("DELETE", `${this.base}/sandbox/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof DaytonaError && err.status === 404) return
      throw err
    }
  }

  /** How long the sandbox may go without contact before Daytona stops (and so deletes) it. */
  async setAutoStop(id: string, minutes: number): Promise<void> {
    await this.send("POST", `${this.base}/sandbox/${encodeURIComponent(id)}/autostop/${Math.max(1, Math.round(minutes))}`)
  }

  /**
   * A URL for one port that needs no token and lapses after `seconds` (at most a day). Never the plain preview URL's
   * token, which opens every port of the sandbox, its terminal and its toolbox included, and can't be revoked.
   */
  async signedPreviewUrl(id: string, port: number, seconds: number): Promise<string> {
    const r = await this.json<{ url?: string }>("GET", `/sandbox/${encodeURIComponent(id)}/ports/${port}/signed-preview-url?expiresInSeconds=${Math.round(seconds)}`)
    if (!r?.url) throw new DaytonaError(`Daytona didn't sign a preview URL for port ${port}`, 500)
    return r.url
  }

  /** The sandbox's toolbox: its own `toolboxProxyUrl` (HTTPS only, as the key goes with every call), else the default. */
  toolbox(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">): string {
    let base = DAYTONA_TOOLBOX
    try {
      if (sb.toolboxProxyUrl && new URL(sb.toolboxProxyUrl).protocol === "https:") base = sb.toolboxProxyUrl.replace(/\/+$/, "")
    } catch {}
    return `${base}/${encodeURIComponent(sb.id)}`
  }

  /**
   * Run a command in the sandbox and wait for it. `result` is stdout and stderr together (the provider separates
   * them). The toolbox kills the command after `timeoutSec` (always sent: its default is 10 s).
   */
  async execute(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">, command: string, timeoutSec: number, signal?: AbortSignal): Promise<{ exitCode: number; result: string }> {
    const res = await this.send("POST", `${this.toolbox(sb)}/process/execute`, {
      body: JSON.stringify({ command, timeout: Math.max(1, Math.round(timeoutSec)) }),
      headers: { "Content-Type": "application/json" },
      timeoutMs: (timeoutSec + 60) * 1000,
      signal,
    })
    const r = (await res.json()) as { exitCode?: number; result?: string }
    return { exitCode: typeof r?.exitCode === "number" ? r.exitCode : -1, result: typeof r?.result === "string" ? r.result : "" }
  }

  /** Write a file in the sandbox (parent folders made, an existing file replaced): a Buffer, or a local file streamed. */
  async upload(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">, dest: string, content: Buffer | { localPath: string }, timeoutMs = 10 * 60_000): Promise<void> {
    const form = new FormData()
    const blob = Buffer.isBuffer(content) ? new Blob([new Uint8Array(content)]) : await fs.openAsBlob(content.localPath)
    form.append("file", blob, dest.split("/").pop() || "file")
    await this.send("POST", `${this.toolbox(sb)}/files/upload-v2?${new URLSearchParams({ path: dest })}`, { body: form, timeoutMs })
  }

  /** A file from the sandbox. Throws with `code: "ENOENT"` when it isn't there. */
  async download(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">, path: string, timeoutMs = 10 * 60_000): Promise<Buffer> {
    const res = await this.fetchFile(sb, path, timeoutMs)
    return Buffer.from(await res.arrayBuffer())
  }

  /** A file from the sandbox, handed over piece by piece as it arrives (an archive needn't fit in memory). */
  async downloadStream(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">, path: string, onChunk: (chunk: Uint8Array) => void, timeoutMs = 2 * 60 * 60_000): Promise<void> {
    const res = await this.fetchFile(sb, path, timeoutMs)
    if (!res.body) return
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) onChunk(chunk)
  }

  private async fetchFile(sb: Pick<DaytonaSandbox, "id" | "toolboxProxyUrl">, path: string, timeoutMs: number): Promise<Response> {
    try {
      return await this.send("GET", `${this.toolbox(sb)}/files/download?${new URLSearchParams({ path })}`, { timeoutMs })
    } catch (err) {
      if (err instanceof DaytonaError && (err.status === 404 || (err.status === 400 && /not (found|exist)|no such file/i.test(err.message)))) throw Object.assign(err, { code: "ENOENT" })
      throw err
    }
  }
}

/** Daytona's sandbox state as RunPod's pod status words, which TaskManager reads for every GPU cloud. */
export function sandboxStatus(sb: Pick<DaytonaSandbox, "state">): "RUNNING" | "STARTING" | "EXITED" | "ERROR" {
  const s = (sb.state ?? "").toLowerCase()
  if (s === "started") return "RUNNING"
  if (s === "error" || s === "build_failed") return "ERROR"
  // Stopped GPU sandboxes are deleted on the spot; a stopped CPU one is too (autoDeleteInterval 0).
  if (["stopped", "stopping", "archived", "archiving", "paused", "pausing", "destroyed", "destroying"].includes(s)) return "EXITED"
  return "STARTING"
}

/** The GPU a sandbox has: "RTX 4090", "2× H100", "RTX 4090 or RTX 5090" (while Daytona hasn't said which), or "CPU only". */
export function sandboxGpu(sb: Pick<DaytonaSandbox, "gpu" | "gpuType">): string {
  if (!sb.gpu) return "CPU only"
  const types = Array.isArray(sb.gpuType) ? sb.gpuType : sb.gpuType ? [sb.gpuType] : []
  const name = types.map(daytonaGpuLabel).join(" or ") || "GPU"
  return sb.gpu > 1 ? `${sb.gpu}× ${name}` : name
}
