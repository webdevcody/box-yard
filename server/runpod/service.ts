import path from "node:path"
import type { Store } from "../store.js"
import { BadRequestError, NotFoundError } from "../store.js"
import type { CredentialStore } from "../credentials.js"
import { RunPodProvider, catalogPrice, shortGpu } from "../providers/runpod.js"
import type { GpuRunner } from "../tasks.js"
import { RunPodApi } from "./api.js"
import { SshPool } from "./ssh.js"
import { RunPodSettingsStore } from "./settings.js"
import { ImageBuilder, checkDocker, imageTag, runpodDir } from "./image.js"
import { gpuBoxId, gpuBoxIndex, gpuBoxProject, isGpuBox, RUNPOD_GPU_GUIDE, VOLUME_GB_MONTH_USD, type RunPodGpuOption, type RunPodPodInfo, type RunPodStatus, type RunPodVolumeInfo } from "../../shared/runpod.js"

const MAX_KEEP_WARM_MINUTES = 24 * 60

/**
 * Settings › RunPod GPU and the GPU runner behind "Runs on: RunPod GPU": the API client, Box Yard's SSH key for
 * pods, the provider every `runpod-<projectId>[-<n>]` box routes to, the image builder and keep-warm.
 * Everything RunPod-side carries this install's id, so two Box Yards on one RunPod account leave each other alone.
 */
export class RunPodService implements GpuRunner {
  readonly api: RunPodApi
  readonly ssh: SshPool
  readonly provider: RunPodProvider
  readonly store: RunPodSettingsStore
  readonly images: ImageBuilder
  /** Set by the app once TaskManager exists: pod events go to the box history, progress to the tasks' logs. */
  onPodEvent: ((e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void) | null = null
  onProgress: ((boxId: string, message: string) => void) | null = null

  constructor(
    private readonly d: {
      store: Store
      credentials: CredentialStore
      dataDir: string
      /** The install id (TaskManager.installLabel without "by-"). */
      install: () => string
      fetch?: typeof fetch
    },
  ) {
    this.api = new RunPodApi(() => d.credentials.get("runpodApiKey"), d.fetch)
    this.ssh = new SshPool(path.join(d.dataDir, "runpod"))
    this.store = new RunPodSettingsStore(d.store)
    this.provider = new RunPodProvider({
      api: this.api,
      ssh: this.ssh,
      settings: () => this.store.get(),
      install: d.install,
      scriptsDir: runpodDir(),
      onEvent: (e) => this.onPodEvent?.({ boxId: e.boxId, kind: e.kind, detail: e.detail }),
      onProgress: (boxId, message) => this.onProgress?.(boxId, message),
      projectCap: (projectId) => d.store.projectGpuCap(projectId),
      projectMachine: (projectId) => d.store.projectGpuMachine(projectId),
    })
    this.images = new ImageBuilder({
      secrets: () => d.credentials.secrets(),
      onBuilt: (image) => this.store.update({ image }),
    })
  }

  settings() {
    return this.store.get()
  }

  enabled() {
    return Boolean(this.d.credentials.get("runpodApiKey"))
  }

  keepWarmUntil(boxId: string): number | null {
    const v = this.store.keepWarm()[boxId]
    return v && v > Date.now() ? v : null
  }

  /** Keep a box's pod up for `minutes` even when idle, or stop keeping it (null). Tells the pod's watchdog too. */
  async keepWarm(boxId: string, minutes: number | null): Promise<number | null> {
    if (!isGpuBox(boxId)) throw new NotFoundError(`${boxId} isn't a GPU pod`)
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_KEEP_WARM_MINUTES)) throw new BadRequestError(`Keep warm for 1 to ${MAX_KEEP_WARM_MINUTES} minutes`)
    const until = minutes === null ? null : Date.now() + minutes * 60_000
    this.store.setKeepWarm(boxId, until)
    await this.provider.keepWarm(boxId, until).catch(() => {})
    return until
  }

  /** GPU types RunPod offers on Secure or Community Cloud, with both prices and a hint, cheapest first, for the pickers. */
  async gpuOptions(): Promise<RunPodGpuOption[]> {
    const gpus = await this.api.gpus()
    const cheapest = (g: RunPodGpuOption) => Math.min(g.securePrice ?? Infinity, g.communityPrice ?? Infinity)
    return gpus
      .filter((g) => g.price)
      .map((g) => ({
        id: g.id,
        name: shortGpu(g.id),
        memoryGb: g.memory,
        securePrice: catalogPrice(g, "SECURE"),
        communityPrice: catalogPrice(g, "COMMUNITY"),
        availability: g.availability ?? "NONE",
        use: RUNPOD_GPU_GUIDE[g.id]?.use ?? null,
      }))
      .filter((g) => g.securePrice !== null || g.communityPrice !== null)
      .sort((a, b) => cheapest(a) - cheapest(b))
  }

  /** Everything Settings › RunPod GPU shows. RunPod errors land in `error`, never thrown. */
  async status(projects: { name: (id: string) => string | null; running: (boxId: string) => number }): Promise<RunPodStatus> {
    const settings = this.store.get()
    const docker = await checkDocker()
    const out: RunPodStatus = {
      settings,
      apiKey: this.enabled(),
      docker: { installed: docker.installed, running: docker.running, error: docker.error },
      currentTag: imageTag(),
      build: this.images.status(),
      pods: [],
      volumes: [],
      problem: this.enabled() ? null : "Add a RunPod API key to run projects on GPU pods",
      error: null,
    }
    if (!this.enabled()) return out
    const prefix = `boxyard-${this.d.install()}-`
    try {
      const [pods, volumes] = await Promise.all([this.provider.listPods(true), this.api.listVolumes()])
      const order = (id: string) => `${projects.name(gpuBoxProject(id)) ?? gpuBoxProject(id)}\u0000${String(gpuBoxIndex(id)).padStart(3, "0")}`
      out.pods = [...pods].sort((a, b) => order(a.boxId).localeCompare(order(b.boxId))).map(({ boxId, pod }): RunPodPodInfo => {
        const projectId = gpuBoxProject(boxId)
        return {
          boxId,
          index: gpuBoxIndex(boxId),
          projectId,
          projectName: projects.name(projectId),
          podId: pod.id,
          status: pod.status,
          gpu: pod.gpu?.id ? shortGpu(pod.gpu.id) : null,
          dataCenter: pod.dataCenterId ?? null,
          costPerHr: pod.cost ?? null,
          startedAt: pod.startedAt ? Date.parse(pod.startedAt) || null : null,
          keepWarmUntil: this.keepWarmUntil(boxId),
          running: projects.running(boxId),
        }
      })
      out.volumes = volumes
        .filter((v) => v.name.startsWith(prefix))
        .map((v): RunPodVolumeInfo => {
          const projectId = v.name.slice(prefix.length)
          return {
            id: v.id,
            name: v.name,
            sizeGb: v.size,
            dataCenter: v.dataCenter,
            type: v.type,
            projectId,
            projectName: projects.name(projectId),
            monthlyUsd: Math.round(v.size * (VOLUME_GB_MONTH_USD[v.type] ?? VOLUME_GB_MONTH_USD.STANDARD!) * 100) / 100,
          }
        })
    } catch (err) {
      out.error = (err as Error).message
    }
    return out
  }

  /** Delete one of this install's volumes. Never one a pod is using (only a project's pod #1 mounts it), never another install's. */
  async deleteVolume(id: string) {
    const prefix = `boxyard-${this.d.install()}-`
    const v = (await this.api.listVolumes()).find((x) => x.id === id)
    if (!v || !v.name.startsWith(prefix)) throw new NotFoundError(`Volume ${id} isn't one of this Box Yard's`)
    const boxId = gpuBoxId(v.name.slice(prefix.length))
    if ((await this.provider.listPods(true)).some((p) => p.boxId === boxId)) throw new BadRequestError("Its project's pod #1 is running; stop it first")
    await this.api.deleteVolume(id)
  }
}
