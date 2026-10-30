// A small client for Vast.ai's REST API (https://console.vast.ai/api/v0, docs.vast.ai/api-reference). Only what the
// GPU runner uses: offer search, renting an offer, instances, attaching an SSH key to one instance, the balance. The
// key comes from Settings › Credentials (VAST_API_KEY). Where Vast's docs disagree with each other, this sends what
// the official CLI (github.com/vast-ai/vast-cli) sends: `env` as an object, `type: "on-demand"`, GPU names with spaces.

export const VAST_API = "https://console.vast.ai/api/v0"

/** An offer from POST /bundles/: one host's GPUs for rent. RAM is in MB, disk in GB, prices in $/hr. */
export interface VastOffer {
  id: number
  machine_id?: number
  gpu_name: string
  num_gpus: number
  /** MB. */
  gpu_ram?: number
  /** MB. */
  cpu_ram?: number
  cpu_cores_effective?: number
  disk_space?: number
  /** $/hr for the GPU with the requested disk. */
  dph_total: number
  reliability?: number
  reliability2?: number
  inet_down?: number
  direct_port_count?: number
  geolocation?: string | null
  verification?: string | null
}

/** An instance from GET /instances/. `actual_status` is null while it's made, then created/loading/running/… */
export interface VastInstance {
  id: number
  label?: string | null
  actual_status?: string | null
  intended_status?: string | null
  cur_state?: string | null
  status_msg?: string | null
  gpu_name?: string | null
  num_gpus?: number
  dph_total?: number | null
  ssh_host?: string | null
  ssh_port?: number | null
  public_ipaddr?: string | null
  /** While running: `{ "22/tcp": [{ HostIp, HostPort }] }`. */
  ports?: Record<string, { HostIp?: string; HostPort: string | number }[]> | null
  /** Unix seconds. */
  start_date?: number | null
  geolocation?: string | null
  image_uuid?: string | null
}

/** What GET /users/current/ says about the account (Vast's docs name the balance `credit` in one place and `balance` in another). */
export interface VastUser {
  credit?: number | null
  balance?: number | null
}

export interface OfferQuery {
  gpuTypes: string[]
  minRamGb: number
  minVcpus: number
  diskGb: number
  verifiedOnly: boolean
  minReliability: number
  minInetDownMbps: number
  /** Only hosts with at least this many open ports (SSH and the previews go straight to the host). */
  minDirectPorts: number
  /** At most this, $/hr, or 0 for any price. */
  maxUsd: number
}

export interface CreateInstanceInput {
  image: string
  diskGb: number
  label: string
  /** Shell run on every container start, after Vast's own SSH setup. At most 4048 characters. */
  onstart: string
  env: Record<string, string>
  /** Container ports to publish (each maps to a random host port). */
  ports: number[]
}

/** An error Vast returned, with its status. `gone`: the offer was taken; `quota`: the daily search quota is used up. */
export class VastError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly gone = false,
    readonly quota = false,
  ) {
    super(message)
  }
}

/** Vast's onstart limit. */
export const ONSTART_MAX = 4048

/** The search body for POST /bundles/: one GPU, on demand, the cheapest first. */
export function offerQuery(q: OfferQuery): Record<string, unknown> {
  return {
    ...(q.verifiedOnly ? { verified: { eq: true } } : {}),
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    gpu_name: { in: q.gpuTypes },
    cpu_ram: { gte: q.minRamGb * 1000 },
    cpu_cores_effective: { gte: q.minVcpus },
    disk_space: { gte: q.diskGb },
    reliability: { gte: q.minReliability },
    inet_down: { gte: q.minInetDownMbps },
    direct_port_count: { gte: q.minDirectPorts },
    ...(q.maxUsd > 0 ? { dph_total: { lte: q.maxUsd } } : {}),
    allocated_storage: q.diskGb,
    type: "on-demand",
    order: [["dph_total", "asc"]],
    limit: 100,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class VastApi {
  constructor(
    private readonly key: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = VAST_API,
    /** Waits between retries of a 429 (Vast's per-endpoint rate limit), shortened in tests. */
    private readonly retryMs = [1500, 4000],
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = this.key()
    if (!key) throw new VastError("No Vast.ai API key: add one in Settings › Credentials (VAST_API_KEY).", 401)
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let json: { success?: boolean; error?: string; msg?: string } | null = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      if (res.ok && json?.success !== false) return json as T
      const code = json?.error ?? ""
      const quota = code === "search_quota_exceeded"
      // A 429 wasn't acted on, so trying again is safe, even for a create. The daily search quota lasts until UTC midnight.
      if (res.status === 429 && !quota && attempt < this.retryMs.length) {
        await sleep(this.retryMs[attempt]!)
        continue
      }
      const detail = [code, json?.msg].filter(Boolean).join(": ") || text.slice(0, 300)
      const gone = res.status === 404 || res.status === 410 || /no_such_ask|unavailable|already rented/i.test(detail)
      throw new VastError(`Vast.ai ${method} ${path.split("?")[0]}: ${res.status} ${detail}`.trim(), res.ok ? 400 : res.status, gone, quota)
    }
  }

  /** Rentable offers that match, cheapest first. */
  async searchOffers(q: OfferQuery): Promise<VastOffer[]> {
    if (!q.gpuTypes.length) return []
    const r = await this.call<{ offers?: VastOffer[] }>("POST", "/bundles/", offerQuery(q))
    return (r?.offers ?? []).filter((o) => o && typeof o.id === "number" && typeof o.dph_total === "number")
  }

  /** Rent an offer. Returns the new instance's id. */
  async createInstance(offerId: number, input: CreateInstanceInput): Promise<number> {
    if (input.onstart.length > ONSTART_MAX) throw new Error(`The onstart script is ${input.onstart.length} characters, over Vast's ${ONSTART_MAX}`)
    const env: Record<string, string> = { ...input.env }
    for (const p of input.ports) env[`-p ${p}:${p}`] = "1"
    const r = await this.call<{ new_contract?: number }>("PUT", `/asks/${offerId}/`, {
      client_id: "me",
      image: input.image,
      disk: input.diskGb,
      label: input.label,
      runtype: "ssh_direct",
      onstart: input.onstart,
      env,
      cancel_unavail: true,
    })
    if (typeof r?.new_contract !== "number") throw new VastError(`Vast.ai PUT /asks/${offerId}/ answered without an instance id`, 500)
    return r.new_contract
  }

  /** Every instance on the account (Box Yard keeps to its own by label). */
  async listInstances(): Promise<VastInstance[]> {
    const r = await this.call<{ instances?: VastInstance[] }>("GET", "/instances/?owner=me")
    return Array.isArray(r?.instances) ? r.instances : []
  }

  /** The instance, or null when it's gone. */
  async getInstance(id: number): Promise<VastInstance | null> {
    try {
      const r = await this.call<{ instances?: VastInstance | null }>("GET", `/instances/${id}/?owner=me`)
      const inst = r?.instances
      return inst && typeof inst === "object" && !Array.isArray(inst) && typeof inst.id === "number" ? inst : null
    } catch (err) {
      if (err instanceof VastError && err.status === 404) return null
      throw err
    }
  }

  /** Let `publicKey` into this one instance. Never the account's keys (POST /ssh/ adds to every instance). */
  async attachSshKey(id: number, publicKey: string): Promise<void> {
    await this.call("POST", `/instances/${id}/ssh/`, { ssh_key: publicKey })
  }

  /** Destroy an instance: its disk goes with it. Already gone is fine. */
  async destroyInstance(id: number): Promise<void> {
    try {
      await this.call("DELETE", `/instances/${id}/`)
    } catch (err) {
      if (err instanceof VastError && err.status === 404) return
      throw err
    }
  }

  /** The account's prepaid credit, USD, or null when Vast doesn't say. */
  async balance(): Promise<number | null> {
    const u = await this.call<VastUser>("GET", "/users/current/")
    const v = u?.credit ?? u?.balance
    return typeof v === "number" && Number.isFinite(v) ? v : null
  }
}

/** Vast's actual_status as RunPod's pod status words, which TaskManager reads for every GPU cloud. */
export function instanceStatus(i: Pick<VastInstance, "actual_status" | "intended_status">): "RUNNING" | "STARTING" | "EXITED" | "ERROR" {
  const s = (i.actual_status ?? "").toLowerCase()
  if (s === "running") return "RUNNING"
  // Exited, unknown and offline never come back to running: destroy and start over.
  if (s === "exited" || s === "unknown" || s === "offline") return "ERROR"
  if (s === "stopped" || s === "frozen") return "EXITED"
  return "STARTING"
}

/** Where to SSH: straight to the host when port 22 is published there, else Vast's SSH proxy. */
export function sshEndpoint(i: VastInstance): { host: string; port: number } | null {
  const direct = i.ports?.["22/tcp"]?.[0]?.HostPort
  if (i.public_ipaddr && direct && Number(direct) > 0) return { host: i.public_ipaddr.trim(), port: Number(direct) }
  if (i.ssh_host && i.ssh_port) return { host: i.ssh_host, port: Number(i.ssh_port) }
  return null
}

/** The host port a container port is published on, or null. */
export function hostPort(i: VastInstance, port: number): number | null {
  const p = i.ports?.[`${port}/tcp`]?.[0]?.HostPort
  return p && Number(p) > 0 ? Number(p) : null
}

/** "NVIDIA RTX A5000" (RunPod's id) → "RTX A5000" (Vast's name); Vast names stay as they are. */
export const vastGpuName = (id: string) => id.replace(/^NVIDIA (GeForce )?/, "")
