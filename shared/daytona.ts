// Daytona sandboxes as the third GPU cloud behind "Runs on: GPU" (shared/gpu.ts, docs/daytona.md). A GPU project on
// Daytona gets a sandbox per pod slot, made from an image with the GPU types, vCPUs, memory and disk set here (or no
// GPU at all: "CPU only"). Daytona's GPU sandboxes are ephemeral (stopping one deletes it), so idle ones are deleted
// and every sandbox starts cold; workspaces come back from Box Yard's archives.

/** The pseudo GPU type for a sandbox with no GPU (plain CPU), as the pickers and the project's GPU types hold it. */
export const DAYTONA_CPU = "CPU"

/**
 * Daytona `gpuType`s, as its API spells them, with Daytona's list prices per GPU-hour (daytona.io/pricing, October
 * 2026): on demand, and spot (Tier 2 and up; pre-empted without warning). MI355X is AMD (ROCm, not CUDA).
 */
export const DAYTONA_GPU_GUIDE: Record<string, { label: string; vramGb: number; usd: number; spotUsd: number; use: string }> = {
  "RTX-4090": { label: "RTX 4090", vramGb: 24, usd: 0.99, spotUsd: 0.57, use: "the cheapest: browser and WebGL game testing, mid-size models" },
  "RTX-5090": { label: "RTX 5090", vramGb: 32, usd: 1.29, spotUsd: 0.74, use: "fast CUDA, games and mid-size models" },
  "RTX-PRO-6000": { label: "RTX PRO 6000", vramGb: 96, usd: 3.03, spotUsd: 1.74, use: "big models and datasets" },
  H100: { label: "H100", vramGb: 80, usd: 3.95, spotUsd: 2.27, use: "training and big models" },
  H200: { label: "H200", vramGb: 141, usd: 4.54, spotUsd: 2.61, use: "training and the biggest models" },
  B200: { label: "B200", vramGb: 180, usd: 6.25, spotUsd: 3.59, use: "the newest NVIDIA: large-scale training" },
  B300: { label: "B300", vramGb: 288, usd: 6.25, spotUsd: 4.08, use: "the newest NVIDIA: large-scale training" },
  MI355X: { label: "MI355X", vramGb: 288, usd: 5.99, spotUsd: 3.44, use: "AMD (ROCm, not CUDA)" },
}

/** Daytona's CPU rates (daytona.io/pricing): per vCPU-hour, per GiB-hour of memory and of disk (the first 5 GiB free). */
export const DAYTONA_RATES = { vcpuHour: 0.0504, memoryGibHour: 0.0162, diskGibHour: 0.000108, freeDiskGib: 5 } as const

/** "RTX 4090", or "CPU only". */
export const daytonaGpuLabel = (type: string) => (type === DAYTONA_CPU ? "CPU only" : (DAYTONA_GPU_GUIDE[type]?.label ?? type))

/** "24 GB, $0.99/hr, browser and …", or null for a type with no guide entry. */
export const daytonaGpuHint = (type: string) => {
  if (type === DAYTONA_CPU) return "no GPU: a plain Linux sandbox at Daytona's CPU and memory rates"
  const g = DAYTONA_GPU_GUIDE[type]
  return g ? `${g.vramGb} GB, $${g.usd}/hr (spot $${g.spotUsd}), ${g.use}` : null
}

/** A sandbox's shape: its GPUs (none for CPU only), vCPUs, memory and disk. */
export interface DaytonaShape {
  /** Daytona gpuTypes in order of preference, or [] for CPU only. */
  gpuTypes: string[]
  gpus: number
  vcpus: number
  memoryGb: number
  diskGb: number
  spot: boolean
}

/**
 * What a sandbox of this shape costs per hour, at worst: its dearest GPU type (Daytona may give any of the types it
 * asks for) times its GPUs, plus its vCPUs, memory and disk at the CPU rates. Daytona's pricing page doesn't say
 * whether a GPU's price includes the machine around it, so this counts it on top and errs high.
 */
export function daytonaHourlyUsd(s: DaytonaShape): number {
  // A type the guide doesn't know (or none named: Daytona picks) counts at the dearest one it does.
  const dearest = Math.max(...Object.values(DAYTONA_GPU_GUIDE).map((g) => (s.spot ? g.spotUsd : g.usd)))
  const each = (t: string) => (s.spot ? DAYTONA_GPU_GUIDE[t]?.spotUsd : DAYTONA_GPU_GUIDE[t]?.usd) ?? dearest
  const gpu = s.gpus > 0 ? (s.gpuTypes.length ? Math.max(...s.gpuTypes.map(each)) : dearest) * s.gpus : 0
  const r = DAYTONA_RATES
  const usd = gpu + s.vcpus * r.vcpuHour + s.memoryGb * r.memoryGibHour + Math.max(0, s.diskGb - r.freeDiskGib) * r.diskGibHour
  return Math.round(usd * 10_000) / 10_000
}

/** Bounds on the sandbox sizes (Daytona's own per-GPU maximums: 16 vCPUs, 192 GiB memory, 512 GiB disk). */
export const DAYTONA_LIMITS = {
  gpus: { min: 1, max: 8 },
  vcpus: { min: 1, max: 128 },
  memoryGb: { min: 1, max: 1536 },
  diskGb: { min: 3, max: 4096 },
} as const

/** Settings › Daytona (kv "daytona"). No secrets: the API key is a credential (DAYTONA_API_KEY). */
export interface DaytonaSettings {
  /** GPU projects that don't pick a cloud (Project.gpuProvider) run on Daytona instead of RunPod or Vast.ai. */
  defaultForGpu: boolean
  /** The image GPU sandboxes start from; null: Settings › RunPod GPU › Image when one is built, else RunPod's stock (CUDA) image. */
  image: string | null
  /** The image CPU-only sandboxes start from (small: Daytona's default per-sandbox disk is 10 GiB). */
  cpuImage: string
  /** GPU types in order of preference (Daytona gpuTypes), or ["CPU"] for sandboxes with no GPU. */
  gpuTypes: string[]
  /** GPUs per sandbox. */
  gpus: number
  /** A GPU sandbox's vCPUs and memory (GiB), unless the project sets its own RAM and vCPUs. */
  vcpus: number
  memoryGb: number
  /** A GPU sandbox's disk (GiB). */
  diskGb: number
  /** A CPU-only sandbox's vCPUs, memory and disk (Daytona's default per-sandbox limit is 4 vCPUs, 8 GiB, 10 GiB). */
  cpuVcpus: number
  cpuMemoryGb: number
  cpuDiskGb: number
  /** Spot GPUs: cheaper, Tier 2 and up, and Daytona may take one back at any moment (the sandbox and its work go). */
  spot: boolean
  /** Delete a sandbox after this many minutes with no task running or waiting. */
  idleMinutes: number
  /** Tasks that may run in one sandbox at once, unless the project sets its own Tasks running at once. */
  agentsPerPod: number
  /** The most one project's sandboxes may cost together, $/hr, unless the project sets its own (Project.gpuMaxHourlyUsd). */
  maxHourlyUsd: number
  /** The most all of this install's Daytona sandboxes together may cost, $/hr. */
  totalMaxHourlyUsd: number
  /**
   * Daytona stops (and so deletes) a sandbox this long after Box Yard was last in touch: its auto-stop interval, the
   * dead-man switch for when the computer running Box Yard sleeps or quits. Box Yard touches idle sandboxes every few
   * minutes, so it only fires when Box Yard is gone.
   */
  watchdogMinutes: number
  /** How long a new sandbox may wait for a GPU (Daytona queues it when none is free) before Box Yard gives up. */
  startMinutes: number
}

/**
 * The vCPUs and memory a sandbox gets by Settings › Daytona, as the Min vCPUs and Min RAM that a project's own replace
 * (a Daytona sandbox gets exactly what it asks for, so the project's "min" is its size).
 */
export function daytonaMachine(s: DaytonaSettings): { minRamGb: number; minVcpus: number } {
  const cpu = s.gpuTypes.includes(DAYTONA_CPU)
  return { minRamGb: cpu ? s.cpuMemoryGb : s.memoryGb, minVcpus: cpu ? s.cpuVcpus : s.vcpus }
}

export const DAYTONA_CPU_IMAGE = "ubuntu:24.04"

export const DEFAULT_DAYTONA_SETTINGS: DaytonaSettings = {
  defaultForGpu: false,
  image: null,
  cpuImage: DAYTONA_CPU_IMAGE,
  gpuTypes: ["RTX-4090", "RTX-5090"],
  gpus: 1,
  vcpus: 8,
  memoryGb: 32,
  diskGb: 60,
  cpuVcpus: 4,
  cpuMemoryGb: 8,
  cpuDiskGb: 10,
  spot: false,
  idleMinutes: 10,
  agentsPerPod: 3,
  maxHourlyUsd: 3,
  totalMaxHourlyUsd: 6,
  watchdogMinutes: 30,
  startMinutes: 20,
}

export interface DaytonaSandboxInfo {
  boxId: string
  /** Which of its project's sandboxes (gpuBoxIndex). */
  index: number
  projectId: string
  projectName: string | null
  sandboxId: string
  /** RUNNING, STARTING, EXITED or ERROR (Daytona's state, mapped), and Daytona's own word. */
  status: string
  state: string
  /** "RTX-4090", "2× H100", or "CPU only". */
  gpu: string | null
  vcpus: number | null
  memoryGb: number | null
  /** Box Yard's estimate, $/hr (daytonaHourlyUsd). */
  costPerHr: number | null
  /** ms since epoch. */
  startedAt: number | null
  keepWarmUntil: number | null
  /** Agent turns running in it now. */
  running: number
}

/** GET /api/daytona. */
export interface DaytonaStatus {
  settings: DaytonaSettings
  apiKey: boolean
  /** The images sandboxes start from now: GPU (settings.image, else RunPod's built image, else the stock one) and CPU only. */
  image: string
  cpuImage: string
  sandboxes: DaytonaSandboxInfo[]
  /** Why Daytona projects can't run right now, or null. */
  problem: string | null
  error: string | null
}
