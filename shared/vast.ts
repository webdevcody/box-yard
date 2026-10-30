// Vast.ai GPU instances as the second GPU cloud behind "Runs on: GPU" (shared/gpu.ts, docs/vast.md). A GPU project on
// Vast.ai rents an instance per pod slot from Vast's marketplace: the cheapest offer that fits its GPU types, machine
// minimums and the $/hr caps. Instances are destroyed when idle (a stopped one keeps no GPU and may never restart).

/**
 * Vast.ai `gpu_name`s and what each is good for, shown in the pickers. Names are Vast's exactly (with spaces, as the
 * CLI sends them); prices are rough marketplace ones, the pickers show live offers.
 */
export const VAST_GPU_GUIDE: Record<string, { vramGb: number; usd: string; use: string }> = {
  "RTX 3070": { vramGb: 8, usd: "~$0.06–0.12/hr", use: "the cheapest: browser and WebGL game testing" },
  "RTX 3080": { vramGb: 10, usd: "~$0.08–0.15/hr", use: "browser and WebGL game testing" },
  "RTX A4000": { vramGb: 16, usd: "~$0.10–0.20/hr", use: "browser and WebGL game testing" },
  "RTX 3090": { vramGb: 24, usd: "~$0.13–0.30/hr", use: "games and mid-size models" },
  "RTX A5000": { vramGb: 24, usd: "~$0.15–0.30/hr", use: "games and mid-size models" },
  "RTX 4090": { vramGb: 24, usd: "~$0.30–0.60/hr", use: "fast CUDA and mid-size models" },
  A40: { vramGb: 48, usd: "~$0.30–0.50/hr", use: "big models and datasets" },
  "RTX A6000": { vramGb: 48, usd: "~$0.40–0.70/hr", use: "big models and datasets" },
}

/** "24 GB, ~$0.15–0.30/hr, games and mid-size models", or null for a GPU with no guide entry. */
export const vastGpuHint = (name: string) => {
  const g = VAST_GPU_GUIDE[name]
  return g ? `${g.vramGb} GB, ${g.usd}, ${g.use}` : null
}

/** Bounds on the machine minimums and filters (global, and per project for RAM and vCPUs). */
export const VAST_MACHINE_LIMITS = {
  minRamGb: { min: 1, max: 1024 },
  minVcpus: { min: 1, max: 256 },
  minReliability: { min: 0, max: 1 },
  minInetDownMbps: { min: 0, max: 10_000 },
} as const

/** Settings › Vast.ai GPU (kv "vast"). No secrets: the API key is a credential (VAST_API_KEY). */
export interface VastSettings {
  /** GPU projects that don't pick a cloud (Project.gpuProvider) run on Vast.ai instead of RunPod. */
  defaultForGpu: boolean
  /** The image instances start from; null: Settings › RunPod GPU › Image when one is built, else RunPod's stock image. */
  image: string | null
  /** GPU types to rent, in order (Vast `gpu_name`s, e.g. "RTX A5000"). */
  gpuTypes: string[]
  /** Only offers from hosts with at least this much RAM (GB) and these many effective vCPUs, unless the project sets its own. */
  minRamGb: number
  minVcpus: number
  /** Only hosts Vast has verified. */
  verifiedOnly: boolean
  /** Only hosts at least this reliable (Vast's 0–1 score). */
  minReliability: number
  /** Only hosts that download at least this fast (Mb/s): images and repos come down at boot. */
  minInetDownMbps: number
  /** The instance's disk, fixed at create; it bills while the instance exists. */
  containerDiskGb: number
  /** Destroy an instance after this many minutes with no task running or waiting. */
  idleMinutes: number
  /** Tasks that may run on one instance at once, unless the project sets its own Tasks running at once. */
  agentsPerPod: number
  /** The most one project's instances may cost together, $/hr, unless the project sets its own (Project.gpuMaxHourlyUsd). */
  maxHourlyUsd: number
  /** The most all of this install's Vast.ai instances together may cost, $/hr. */
  totalMaxHourlyUsd: number
  /** The instance's own watchdog destroys it this long after Box Yard stops being in touch (the computer slept). */
  watchdogMinutes: number
}

export const DEFAULT_VAST_SETTINGS: VastSettings = {
  defaultForGpu: false,
  image: null,
  gpuTypes: ["RTX A5000", "RTX 3090", "A40"],
  minRamGb: 24,
  minVcpus: 8,
  verifiedOnly: true,
  minReliability: 0.95,
  minInetDownMbps: 100,
  containerDiskGb: 40,
  idleMinutes: 10,
  agentsPerPod: 3,
  maxHourlyUsd: 1,
  totalMaxHourlyUsd: 3,
  watchdogMinutes: 30,
}

export interface VastInstanceInfo {
  boxId: string
  /** Which of its project's instances (gpuBoxIndex). */
  index: number
  projectId: string
  projectName: string | null
  instanceId: string
  /** RUNNING, STARTING, EXITED or ERROR (Vast's actual_status, mapped). */
  status: string
  gpu: string | null
  /** Where the host is, e.g. "Oregon, US". */
  location: string | null
  costPerHr: number | null
  /** ms since epoch. */
  startedAt: number | null
  keepWarmUntil: number | null
  /** Agent turns running on it now. */
  running: number
}

/** GET /api/vast. */
export interface VastStatus {
  settings: VastSettings
  apiKey: boolean
  /** The image instances start from now (settings.image, else RunPod's built image, else the stock one). */
  image: string
  instances: VastInstanceInfo[]
  /** The account's prepaid credit, USD, when Vast says. */
  balanceUsd: number | null
  /** Why Vast.ai projects can't run right now, or null. */
  problem: string | null
  error: string | null
}

/** A GPU type the marketplace has offers for right now, for the pickers. */
export interface VastGpuOption {
  name: string
  memoryGb: number
  /** The cheapest matching offer, $/hr. */
  cheapestUsd: number
  /** How many matching offers there are. */
  offers: number
  use: string | null
}
