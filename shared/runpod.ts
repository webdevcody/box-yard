// RunPod GPU pods as a runner ("Runs on: RunPod GPU", shared/runner.ts). A GPU project gets up to its Max boxes
// pods at a time, within the $/hr caps; pod #1 mounts the project's network volume. Pods come and go, the volume
// stays (docs/runpod.md).

/**
 * A GPU project's virtual boxes, one per pod: `runpod-<projectId>` is pod #1 (the only one before projects could
 * have several), `runpod-<projectId>-<n>` pod #n. They're never `boxes` rows (like the local runner's box).
 * Project ids never end in `-<digits>` (`newId` makes `prj_<hex>`), so the suffix is unambiguous.
 */
export const GPU_BOX_PREFIX = "runpod-"
const POD_SUFFIX = /-(\d+)$/
export const gpuBoxId = (projectId: string, n = 1) => `${GPU_BOX_PREFIX}${projectId}${n > 1 ? `-${n}` : ""}`
export const isGpuBox = (id: string | null | undefined): id is string => Boolean(id?.startsWith(GPU_BOX_PREFIX))
export const gpuBoxProject = (id: string) => id.slice(GPU_BOX_PREFIX.length).replace(POD_SUFFIX, "")
/** Which of its project's pods a GPU box is: 1 for `runpod-<projectId>`. */
export const gpuBoxIndex = (id: string) => Number(POD_SUFFIX.exec(id.slice(GPU_BOX_PREFIX.length))?.[1] ?? 1)
/** "GPU pod #2 · survive-the-night". */
export const gpuPodLabel = (id: string, projectName: string | null) => `GPU pod #${gpuBoxIndex(id)} · ${projectName ?? gpuBoxProject(id)}`
/** The most pods one project may have: its Max boxes when lower, and the bound when it sets none (the $/hr caps apply too). */
export const MAX_GPU_PODS = 20

/** Pods start from this public image when no custom image is built: slower (tools install at boot), no Docker needed. */
export const RUNPOD_STOCK_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"

/** Settings › RunPod GPU (kv "runpod"). */
export interface RunPodSettings {
  /** The image pods start from: one built with Build image, any compatible one, or null for the stock image. */
  image: string | null
  /** Where Build image pushes, e.g. docker.io/alice/boxyard-gpu (no tag). */
  imageRepo: string | null
  /** GPU types to try, in order (RunPod ids, e.g. "NVIDIA RTX A5000"). */
  gpuTypes: string[]
  /** The datacenter for new volumes; null picks the one with the best stock of `gpuTypes`. */
  dataCenter: string | null
  /** Stop a pod after this many minutes with no agent turn running. */
  idleMinutes: number
  /** Agents that may run on one pod at once, unless the project sets its own Agents per box. */
  agentsPerPod: number
  containerDiskGb: number
  /** Size of a project's network volume (caches, data), which only its pod #1 mounts. 0: no volume. */
  volumeGb: number
  /**
   * The most one project's pods may cost together, $/hr, unless the project sets its own (Project.gpuMaxHourlyUsd).
   * A pod that would go over waits; one that comes back pricier than its GPU's list price allows is terminated.
   */
  maxHourlyUsd: number
  /** The most all of this install's GPU pods together may cost, $/hr. */
  totalMaxHourlyUsd: number
  /** The pod's own watchdog terminates it this long after Box Yard stops being in touch (the computer slept). */
  watchdogMinutes: number
}

export const DEFAULT_RUNPOD_SETTINGS: RunPodSettings = {
  image: null,
  imageRepo: null,
  gpuTypes: ["NVIDIA RTX A5000", "NVIDIA A40"],
  dataCenter: null,
  idleMinutes: 10,
  agentsPerPod: 3,
  containerDiskGb: 40,
  volumeGb: 30,
  maxHourlyUsd: 1,
  totalMaxHourlyUsd: 3,
  watchdogMinutes: 30,
}

export interface RunPodPodInfo {
  boxId: string
  /** Which of its project's pods (gpuBoxIndex). */
  index: number
  projectId: string
  projectName: string | null
  podId: string
  status: string
  gpu: string | null
  dataCenter: string | null
  costPerHr: number | null
  /** ms since epoch. */
  startedAt: number | null
  /** The pod stays up until then even when idle (ms since epoch), or null. */
  keepWarmUntil: number | null
  /** Agent turns running on it now. */
  running: number
}

export interface RunPodVolumeInfo {
  id: string
  name: string
  sizeGb: number
  dataCenter: string
  type: string
  projectId: string | null
  projectName: string | null
  monthlyUsd: number
}

export interface RunPodImageBuild {
  state: "idle" | "running" | "succeeded" | "failed"
  image: string | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  /** It built and pushed, but something needs a look (the registry won't let RunPod pull it anonymously). */
  warning: string | null
  /** The tail of the docker output. */
  log: string
}

/** GET /api/runpod. */
export interface RunPodStatus {
  settings: RunPodSettings
  apiKey: boolean
  /** Docker on the computer running Box Yard: installed and its daemon answering. */
  docker: { installed: boolean; running: boolean; error: string | null }
  /** The tag Build image would make now; `image` is out of date when it differs (Box Yard's runpod/ changed). */
  currentTag: string
  build: RunPodImageBuild
  pods: RunPodPodInfo[]
  volumes: RunPodVolumeInfo[]
  /** Why GPU projects can't run right now, or null. */
  problem: string | null
  error: string | null
}

export interface RunPodGpuOption {
  id: string
  name: string
  memoryGb: number
  securePrice: number
  availability: string
}

/** Network volume price by tier, $/GB/month (runpod.io/pricing). */
export const VOLUME_GB_MONTH_USD: Record<string, number> = { STANDARD: 0.07, HIGH_PERFORMANCE: 0.14 }
