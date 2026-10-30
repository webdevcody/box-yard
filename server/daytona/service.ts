import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Store } from "../store.js"
import { BadRequestError, NotFoundError } from "../store.js"
import type { CredentialStore } from "../credentials.js"
import type { GpuRunner } from "../tasks.js"
import { runpodDir } from "../runpod/image.js"
import { DaytonaProvider } from "../providers/daytona.js"
import { DaytonaApi } from "./api.js"
import { DaytonaSettingsStore } from "./settings.js"
import { gpuBoxProvider } from "../../shared/gpu.js"
import { RUNPOD_STOCK_IMAGE, gpuBoxIndex, gpuBoxProject } from "../../shared/runpod.js"
import { daytonaMachine, type DaytonaSandboxInfo, type DaytonaSettings, type DaytonaStatus } from "../../shared/daytona.js"

const MAX_KEEP_WARM_MINUTES = 24 * 60

/** Box Yard's daytona/ folder: init.sh, beside runpod/ (whose bootstrap.sh installs the tools). */
export function daytonaDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, "../../daytona"), path.resolve(here, "../../../../daytona"), path.resolve(process.cwd(), "daytona")]
  return candidates.find((d) => fs.existsSync(path.join(d, "init.sh"))) ?? candidates.at(-1)!
}

/**
 * Settings › Daytona and the third GPU cloud behind "Runs on: GPU": the API client, the provider every
 * `daytona-<projectId>[-<n>]` box routes to, and keep-warm. Sandboxes carry this install's id in a label, so two Box
 * Yards on one Daytona organization leave each other's alone. The key never leaves this server: Box Yard reaches a
 * sandbox only through Daytona's API.
 */
export class DaytonaService implements GpuRunner {
  readonly kind = "daytona" as const
  /** Its sandboxes count toward Settings › Usage › Daily cloud limit, and none starts while it's reached. */
  readonly metered = true
  readonly api: DaytonaApi
  readonly provider: DaytonaProvider
  readonly store: DaytonaSettingsStore
  onPodEvent: ((e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void) | null = null
  onProgress: ((boxId: string, message: string) => void) | null = null
  /** Why no new sandbox may start (TaskManager.cloudSpend's blockedReason), or null. */
  spendBlock: (() => string | null) | null = null

  constructor(
    private readonly d: {
      store: Store
      credentials: CredentialStore
      install: () => string
      /** Settings › RunPod GPU › Image: GPU sandboxes use the same built image unless Settings › Daytona names one. */
      runpodImage: () => string | null
      fetch?: typeof fetch
      pollMs?: number
    },
  ) {
    this.api = new DaytonaApi(() => d.credentials.get("daytonaApiKey"), d.fetch)
    this.store = new DaytonaSettingsStore(d.store)
    this.provider = new DaytonaProvider({
      api: this.api,
      settings: () => this.store.get(),
      image: () => this.image(),
      install: d.install,
      bootstrapDir: runpodDir(),
      scriptsDir: daytonaDir(),
      onEvent: (e) => this.onPodEvent?.(e),
      onProgress: (boxId, message) => this.onProgress?.(boxId, message),
      projectCap: (projectId) => d.store.projectGpuCap(projectId),
      projectMachine: (projectId) => {
        const m = d.store.projectGpuMachine(projectId)
        return { gpuTypes: m.gpuTypes, minRamGb: m.minRamGb, minVcpus: m.minVcpus }
      },
      keepWarmUntil: (boxId) => this.keepWarmUntil(boxId),
      spendBlock: () => this.spendBlock?.() ?? null,
      ...(d.pollMs ? { pollMs: d.pollMs } : {}),
    })
  }

  /**
   * Settings › Daytona, with the vCPUs and memory a sandbox gets as the Min vCPUs and Min RAM TaskManager reads (a
   * project's own Min RAM and Min vCPUs size its sandboxes).
   */
  settings(): DaytonaSettings & { minRamGb: number; minVcpus: number } {
    const s = this.store.get()
    return { ...s, ...daytonaMachine(s) }
  }

  enabled() {
    return Boolean(this.d.credentials.get("daytonaApiKey"))
  }

  /** The image GPU sandboxes start from: Daytona's own setting, else RunPod's built image, else RunPod's stock one. */
  image(): string {
    return this.store.get().image || this.d.runpodImage() || RUNPOD_STOCK_IMAGE
  }

  keepWarmUntil(boxId: string): number | null {
    const v = this.store.keepWarm()[boxId]
    return v && v > Date.now() ? v : null
  }

  async keepWarm(boxId: string, minutes: number | null): Promise<number | null> {
    if (gpuBoxProvider(boxId) !== "daytona") throw new NotFoundError(`${boxId} isn't a Daytona sandbox`)
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_KEEP_WARM_MINUTES)) throw new BadRequestError(`Keep warm for 1 to ${MAX_KEEP_WARM_MINUTES} minutes`)
    const until = minutes === null ? null : Date.now() + minutes * 60_000
    this.store.setKeepWarm(boxId, until)
    await this.provider.keepWarm(boxId, until).catch(() => {})
    return until
  }

  /** Everything Settings › Daytona shows. Daytona errors land in `error`, never thrown. */
  async status(projects: { name: (id: string) => string | null; running: (boxId: string) => number }): Promise<DaytonaStatus> {
    const s = this.store.get()
    const out: DaytonaStatus = {
      settings: s,
      apiKey: this.enabled(),
      image: this.image(),
      cpuImage: s.cpuImage,
      sandboxes: [],
      problem: this.enabled() ? null : "Add a Daytona API key to run projects on Daytona sandboxes",
      error: null,
    }
    if (!this.enabled()) return out
    try {
      const pods = await this.provider.listPods(true)
      const order = (id: string) => `${projects.name(gpuBoxProject(id)) ?? gpuBoxProject(id)}\u0000${String(gpuBoxIndex(id)).padStart(3, "0")}`
      out.sandboxes = [...pods]
        .sort((a, b) => order(a.boxId).localeCompare(order(b.boxId)))
        .map(({ boxId, pod, sandbox }): DaytonaSandboxInfo => {
          const projectId = gpuBoxProject(boxId)
          return {
            boxId,
            index: gpuBoxIndex(boxId),
            projectId,
            projectName: projects.name(projectId),
            sandboxId: sandbox.id,
            status: pod.status,
            state: sandbox.state ?? "unknown",
            gpu: pod.gpu?.id ?? null,
            vcpus: sandbox.cpu ?? null,
            memoryGb: sandbox.memory ?? null,
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
