// The GPU clouds behind "Runs on: GPU" (shared/runner.ts): RunPod (shared/runpod.ts, docs/runpod.md) and Vast.ai
// (shared/vast.ts, docs/vast.md). A GPU project's pods are virtual boxes named after its cloud, so a box id alone
// says which cloud it's on; the project's own pick (Project.gpuProvider), else the global one, says where new pods go.

export const GPU_PROVIDERS = ["runpod", "vast"] as const
export type GpuProvider = (typeof GPU_PROVIDERS)[number]
export const isGpuProvider = (v: unknown): v is GpuProvider => GPU_PROVIDERS.includes(v as GpuProvider)

export const GPU_PROVIDER_LABEL: Record<GpuProvider, string> = { runpod: "RunPod", vast: "Vast.ai" }

/**
 * Box id prefixes. Vast's is `vastai-`, not `vast-`: Upstash names boxes adjective-animal ("vast-lobster" could be
 * one), so a GPU box must never look like an Upstash box's name.
 */
export const GPU_BOX_PREFIXES: Record<GpuProvider, string> = { runpod: "runpod-", vast: "vastai-" }

const POD_SUFFIX = /-(\d+)$/

/** The cloud a GPU box id is on, or null for any other box. */
export function gpuBoxProvider(id: string | null | undefined): GpuProvider | null {
  if (!id) return null
  for (const p of GPU_PROVIDERS) if (id.startsWith(GPU_BOX_PREFIXES[p])) return p
  return null
}

/** The box id without its cloud's prefix: `<projectId>[-<n>]`. */
export const gpuBoxRest = (id: string) => id.slice(GPU_BOX_PREFIXES[gpuBoxProvider(id) ?? "runpod"].length)

/**
 * A GPU project's virtual boxes, one per pod: `<prefix><projectId>` is pod #1, `<prefix><projectId>-<n>` pod #n.
 * Project ids never end in `-<digits>` (`newId` makes `prj_<hex>`), so the suffix is unambiguous.
 */
export const gpuBoxIdOn = (provider: GpuProvider, projectId: string, n = 1) => `${GPU_BOX_PREFIXES[provider]}${projectId}${n > 1 ? `-${n}` : ""}`
export const isAnyGpuBox = (id: string | null | undefined): id is string => gpuBoxProvider(id) !== null
export const anyGpuBoxProject = (id: string) => gpuBoxRest(id).replace(POD_SUFFIX, "")
export const anyGpuBoxIndex = (id: string) => Number(POD_SUFFIX.exec(gpuBoxRest(id))?.[1] ?? 1)

/** Where each cloud's settings live, for wait reasons and notices. */
export const GPU_SETTINGS_PATH: Record<GpuProvider, string> = { runpod: "Settings › RunPod GPU", vast: "Settings › Vast.ai GPU" }

/** The cloud a GPU project's new pods come from: its own pick, else Vast.ai when Settings › Vast.ai GPU › Use for GPU projects is on, else RunPod. */
export const effectiveGpuProvider = (own: GpuProvider | null | undefined, vastDefault: boolean): GpuProvider => own ?? (vastDefault ? "vast" : "runpod")
