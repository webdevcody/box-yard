import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Store } from "../store.js"
import { BadRequestError, NotFoundError } from "../store.js"
import type { CredentialStore } from "../credentials.js"
import type { GpuRunner } from "../tasks.js"
import { SshPool } from "../runpod/ssh.js"
import { runpodDir } from "../runpod/image.js"
import { VastProvider } from "../providers/vast.js"
import { VastApi } from "./api.js"
import { VastSettingsStore } from "./settings.js"
import { gpuBoxProvider } from "../../shared/gpu.js"
import { RUNPOD_STOCK_IMAGE, gpuBoxIndex, gpuBoxProject } from "../../shared/runpod.js"
import { VAST_GPU_GUIDE, type VastGpuOption, type VastInstanceInfo, type VastSettings, type VastStatus } from "../../shared/vast.js"

const MAX_KEEP_WARM_MINUTES = 24 * 60

/** Box Yard's vast/ folder: init.sh and watchdog.sh, beside runpod/ (whose bootstrap.sh installs the tools). */
export function vastDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, "../../vast"), path.resolve(here, "../../../../vast"), path.resolve(process.cwd(), "vast")]
  return candidates.find((d) => fs.existsSync(path.join(d, "watchdog.sh"))) ?? candidates.at(-1)!
}

/**
 * Settings › Vast.ai GPU and the second GPU cloud behind "Runs on: GPU": the API client, Box Yard's SSH key for
 * instances (its own, in `<data dir>/vast`), the provider every `vastai-<projectId>[-<n>]` box routes to, and keep-warm.
 * Instances carry this install's id in their label, so two Box Yards on one Vast account leave each other's alone.
 */
export class VastService implements GpuRunner {
  readonly kind = "vast" as const
  readonly api: VastApi
  readonly ssh: SshPool
  readonly provider: VastProvider
  readonly store: VastSettingsStore
  onPodEvent: ((e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void) | null = null
  onProgress: ((boxId: string, message: string) => void) | null = null

  constructor(
    private readonly d: {
      store: Store
      credentials: CredentialStore
      dataDir: string
      install: () => string
      git: { name: string; email: string }
      /** Settings › RunPod GPU › Image: instances use the same built image unless Settings › Vast.ai GPU names one. */
      runpodImage: () => string | null
      fetch?: typeof fetch
    },
  ) {
    this.api = new VastApi(() => d.credentials.get("vastApiKey"), d.fetch)
    this.ssh = new SshPool(path.join(d.dataDir, "vast"))
    this.store = new VastSettingsStore(d.store)
    this.provider = new VastProvider({
      api: this.api,
      ssh: this.ssh,
      settings: () => this.store.get(),
      image: () => this.image(),
      install: d.install,
      bootstrapDir: runpodDir(),
      scriptsDir: vastDir(),
      git: d.git,
      onEvent: (e) => this.onPodEvent?.(e),
      onProgress: (boxId, message) => this.onProgress?.(boxId, message),
      projectCap: (projectId) => d.store.projectGpuCap(projectId),
      projectMachine: (projectId) => {
        const m = d.store.projectGpuMachine(projectId)
        return { gpuTypes: m.gpuTypes, minRamGb: m.minRamGb, minVcpus: m.minVcpus }
      },
    })
  }

  settings(): VastSettings {
    return this.store.get()
  }

  enabled() {
    return Boolean(this.d.credentials.get("vastApiKey"))
  }

  /** The image new instances start from: Vast's own setting, else RunPod's built image, else RunPod's stock one. */
  image(): string {
    return this.store.get().image || this.d.runpodImage() || RUNPOD_STOCK_IMAGE
  }

  keepWarmUntil(boxId: string): number | null {
    const v = this.store.keepWarm()[boxId]
    return v && v > Date.now() ? v : null
  }

  async keepWarm(boxId: string, minutes: number | null): Promise<number | null> {
    if (gpuBoxProvider(boxId) !== "vast") throw new NotFoundError(`${boxId} isn't a Vast.ai instance`)
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_KEEP_WARM_MINUTES)) throw new BadRequestError(`Keep warm for 1 to ${MAX_KEEP_WARM_MINUTES} minutes`)
    const until = minutes === null ? null : Date.now() + minutes * 60_000
    this.store.setKeepWarm(boxId, until)
    await this.provider.keepWarm(boxId, until).catch(() => {})
    return until
  }

  /**
   * GPU types with offers right now under the global filters (not the caps), cheapest first, for the pickers. The
   * guide's types come first in its order when they have none, so the picker always offers them.
   */
  async gpuOptions(): Promise<VastGpuOption[]> {
    const s = this.store.get()
    const names = [...new Set([...Object.keys(VAST_GPU_GUIDE), ...s.gpuTypes])]
    const offers = await this.provider.searchOffers({ gpuTypes: names, minRamGb: s.minRamGb, minVcpus: s.minVcpus }, 0)
    const by = new Map<string, VastGpuOption>()
    for (const o of offers) {
      const g = by.get(o.gpu_name)
      if (g) {
        g.offers++
        g.cheapestUsd = Math.min(g.cheapestUsd, o.dph_total)
      } else {
        by.set(o.gpu_name, {
          name: o.gpu_name,
          memoryGb: Math.round((o.gpu_ram ?? 0) / 1000) || VAST_GPU_GUIDE[o.gpu_name]?.vramGb || 0,
          cheapestUsd: o.dph_total,
          offers: 1,
          use: VAST_GPU_GUIDE[o.gpu_name]?.use ?? null,
        })
      }
    }
    for (const n of names) {
      if (!by.has(n)) by.set(n, { name: n, memoryGb: VAST_GPU_GUIDE[n]?.vramGb ?? 0, cheapestUsd: Infinity, offers: 0, use: VAST_GPU_GUIDE[n]?.use ?? null })
    }
    return [...by.values()].sort((a, b) => a.cheapestUsd - b.cheapestUsd).map((g) => ({ ...g, cheapestUsd: Number.isFinite(g.cheapestUsd) ? Math.round(g.cheapestUsd * 1000) / 1000 : 0 }))
  }

  /** Everything Settings › Vast.ai GPU shows. Vast errors land in `error`, never thrown. */
  async status(projects: { name: (id: string) => string | null; running: (boxId: string) => number }): Promise<VastStatus> {
    const out: VastStatus = {
      settings: this.store.get(),
      apiKey: this.enabled(),
      image: this.image(),
      instances: [],
      balanceUsd: null,
      problem: this.enabled() ? null : "Add a Vast.ai API key to run projects on Vast.ai GPUs",
      error: null,
    }
    if (!this.enabled()) return out
    try {
      const [pods, balance] = await Promise.all([this.provider.listPods(true), this.api.balance().catch(() => null)])
      out.balanceUsd = balance
      const order = (id: string) => `${projects.name(gpuBoxProject(id)) ?? gpuBoxProject(id)}\u0000${String(gpuBoxIndex(id)).padStart(3, "0")}`
      out.instances = [...pods]
        .sort((a, b) => order(a.boxId).localeCompare(order(b.boxId)))
        .map(({ boxId, pod }): VastInstanceInfo => {
          const projectId = gpuBoxProject(boxId)
          return {
            boxId,
            index: gpuBoxIndex(boxId),
            projectId,
            projectName: projects.name(projectId),
            instanceId: pod.id,
            status: pod.status,
            gpu: pod.gpu?.id ?? null,
            location: pod.dataCenterId ?? null,
            costPerHr: pod.cost ?? null,
            startedAt: pod.startedAt ? Date.parse(pod.startedAt) || null : null,
            keepWarmUntil: this.keepWarmUntil(boxId),
            running: projects.running(boxId),
          }
        })
    } catch (err) {
      out.error = (err as Error).message
    }
    return out
  }
}
