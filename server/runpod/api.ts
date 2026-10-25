// A small client for RunPod's REST API v2 (https://api.runpod.io/v2; v1 retires Nov 15, 2026). Only what the GPU
// runner uses: pods, network volumes and the catalog. The key comes from Settings › Credentials (RUNPOD_API_KEY).

export const RUNPOD_API = "https://api.runpod.io/v2"

export type PodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED"

export interface RunPodPod {
  id: string
  name: string
  status: PodStatus
  image?: string
  /** What RunPod bills for it, $/hr. */
  cost?: number
  dataCenterId?: string | null
  gpu?: { id?: string; count?: number; memory?: number } | null
  ssh?: { direct?: { host: string; port: number } | null } | null
  mounts?: { network?: { volumeId: string; path: string }[] } | null
  createdAt?: string
  startedAt?: string | null
}

export interface RunPodVolume {
  id: string
  name: string
  size: number
  dataCenter: string
  type: string
}

export interface CatalogGpu {
  id: string
  name: string
  memory: number
  secure: boolean
  price: { secure: number; community: number }
  availability?: "NONE" | "LOW" | "MEDIUM" | "HIGH"
}

export interface CatalogDataCenter {
  id: string
  name: string
  networkVolumeTypes: string[]
  gpuAvailability?: { id: string; name: string; availability: "NONE" | "LOW" | "MEDIUM" | "HIGH" }[]
}

export interface CreatePodInput {
  name: string
  image: string
  gpuId: string
  dataCenterId: string
  volumeId: string | null
  containerDiskGb: number
  ports: string[]
  env: Record<string, string>
}

/** An error RunPod returned, with its status; `capacity` when no GPU of that type was free. */
export class RunPodError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly capacity = false,
  ) {
    super(message)
  }
}

const AVAILABILITY_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const
export const availabilityRank = (a: string | undefined) => AVAILABILITY_RANK[(a ?? "NONE") as keyof typeof AVAILABILITY_RANK] ?? 0

export class RunPodApi {
  constructor(
    private readonly key: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = RUNPOD_API,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = this.key()
    if (!key) throw new RunPodError("No RunPod API key: add one in Settings › Credentials (RUNPOD_API_KEY).", 401)
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      // v2 refuses a body it doesn't declare (a DELETE with any body is a 422).
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 400)
      try {
        const j = JSON.parse(text) as { detail?: string; errors?: string[]; title?: string }
        detail = [j.detail ?? j.title, ...(j.errors ?? [])].filter(Boolean).join(" ")
      } catch {}
      const capacity = /no longer any instances|not enough free|no instances|insufficient capacity|out of capacity/i.test(detail)
      throw new RunPodError(`RunPod ${method} ${path.split("?")[0]}: ${res.status} ${detail}`.trim(), res.status, capacity)
    }
    return (text ? JSON.parse(text) : null) as T
  }

  async listPods(): Promise<RunPodPod[]> {
    const out: RunPodPod[] = []
    let cursor: string | null = null
    do {
      const page: { pods: RunPodPod[]; pagination?: { nextCursor: string | null; hasNextPage: boolean } } = await this.call("GET", `/pods${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
      out.push(...(page.pods ?? []))
      cursor = page.pagination?.hasNextPage ? page.pagination.nextCursor : null
    } while (cursor)
    return out
  }

  /** The pod, or null when it's gone (terminated pods are a 404). */
  async getPod(id: string): Promise<RunPodPod | null> {
    try {
      return await this.call<RunPodPod>("GET", `/pods/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof RunPodError && err.status === 404) return null
      throw err
    }
  }

  createPod(input: CreatePodInput): Promise<RunPodPod> {
    return this.call<RunPodPod>("POST", "/pods", {
      name: input.name,
      image: input.image,
      cloud: "SECURE",
      dataCenterIds: [input.dataCenterId],
      gpu: { id: input.gpuId, count: 1 },
      disk: input.containerDiskGb,
      ports: input.ports,
      env: input.env,
      ...(input.volumeId ? { mounts: { network: [{ volumeId: input.volumeId, path: "/workspace" }] } } : {}),
    })
  }

  /** Terminate a pod: its container disk goes, a network volume stays. Already gone is fine. */
  async terminatePod(id: string): Promise<void> {
    try {
      await this.call("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "terminate" })
    } catch (err) {
      if (err instanceof RunPodError && err.status === 404) return
      throw err
    }
  }

  async listVolumes(): Promise<RunPodVolume[]> {
    const out: RunPodVolume[] = []
    let cursor: string | null = null
    do {
      const page: { networkVolumes: RunPodVolume[]; pagination?: { nextCursor: string | null; hasNextPage: boolean } } = await this.call("GET", `/network-volumes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
      out.push(...(page.networkVolumes ?? []))
      cursor = page.pagination?.hasNextPage ? page.pagination.nextCursor : null
    } while (cursor)
    return out
  }

  createVolume(input: { name: string; sizeGb: number; dataCenter: string; type: string }): Promise<RunPodVolume> {
    return this.call<RunPodVolume>("POST", "/network-volumes", { name: input.name, size: input.sizeGb, dataCenter: input.dataCenter, type: input.type })
  }

  async deleteVolume(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/network-volumes/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof RunPodError && err.status === 404) return
      throw err
    }
  }

  async gpus(): Promise<CatalogGpu[]> {
    return (await this.call<{ gpus: CatalogGpu[] }>("GET", "/catalog/gpus?include=AVAILABILITY&product=POD")).gpus ?? []
  }

  async dataCenters(): Promise<CatalogDataCenter[]> {
    return (await this.call<{ dataCenters: CatalogDataCenter[] }>("GET", "/catalog/datacenters?include=GPU_AVAILABILITY")).dataCenters ?? []
  }
}

/**
 * The datacenter with network volumes and the best stock of the wanted GPUs, best first. The first GPU in the list
 * counts most; a DC with none of them in stock is left out.
 */
export function rankDataCenters(dcs: CatalogDataCenter[], gpuIds: string[]): { id: string; volumeType: string; score: number }[] {
  return dcs
    .filter((dc) => dc.networkVolumeTypes?.length)
    .map((dc) => {
      const stock = new Map((dc.gpuAvailability ?? []).map((g) => [g.id, availabilityRank(g.availability)]))
      // Weight by priority: the first GPU's stock dominates, later ones break ties.
      const score = gpuIds.reduce((sum, id, i) => sum + (stock.get(id) ?? 0) * 10 ** (gpuIds.length - i - 1), 0)
      return { id: dc.id, volumeType: dc.networkVolumeTypes.includes("STANDARD") ? "STANDARD" : dc.networkVolumeTypes[0]!, score }
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
}
