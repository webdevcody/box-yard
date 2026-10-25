import { z } from "zod"
import { BadRequestError, type Store } from "../store.js"
import { DEFAULT_RUNPOD_SETTINGS, RUNPOD_MACHINE_LIMITS, type RunPodSettings } from "../../shared/runpod.js"

/** Settings › RunPod GPU, in a kv entry of its own (no secrets: the API key is a credential). */
const KV = "runpod"

/** An image reference: registry/name[:tag][@digest], no spaces or shell characters. */
const imageRef = z
  .string()
  .trim()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "That isn't an image reference (like docker.io/you/boxyard-gpu:tag)")

export const runpodSettingsPatch = z
  .object({
    image: imageRef.nullable(),
    imageRepo: imageRef
      .refine((v) => !/[:@]/.test(v.split("/").pop() ?? ""), "The repository has no tag: Build image picks one")
      .nullable(),
    gpuTypes: z.array(z.string().trim().min(1).max(100)).min(1, "Pick at least one GPU type").max(10),
    cloud: z.enum(["SECURE", "COMMUNITY"]),
    minRamGb: z.number().int().min(RUNPOD_MACHINE_LIMITS.minRamGb.min).max(RUNPOD_MACHINE_LIMITS.minRamGb.max),
    minVcpus: z.number().int().min(RUNPOD_MACHINE_LIMITS.minVcpus.min).max(RUNPOD_MACHINE_LIMITS.minVcpus.max),
    dataCenter: z.string().trim().min(1).max(40).nullable(),
    idleMinutes: z.number().int().min(1).max(24 * 60),
    agentsPerPod: z.number().int().min(1).max(16),
    containerDiskGb: z.number().int().min(20).max(500),
    volumeGb: z.number().int().min(0).max(4000),
    maxHourlyUsd: z.number().min(0).max(100),
    totalMaxHourlyUsd: z.number().min(0).max(1000),
    watchdogMinutes: z.number().int().min(5).max(24 * 60),
  })
  .partial()
  .strict()

/** A project's own GPU machine (Project.gpuMachine): each field left out stays as it is, null clears it. */
export const gpuMachinePatch = z
  .object({
    gpuTypes: z.array(z.string().trim().min(1).max(100)).min(1, "Pick at least one GPU type").max(10).nullable(),
    cloud: z.enum(["SECURE", "COMMUNITY"]).nullable(),
    minRamGb: runpodSettingsPatch.shape.minRamGb.nullable(),
    minVcpus: runpodSettingsPatch.shape.minVcpus.nullable(),
  })
  .partial()
  .strict()

export class RunPodSettingsStore {
  constructor(private readonly store: Store) {}

  get(): RunPodSettings {
    let raw: unknown = {}
    try {
      raw = JSON.parse(this.store.getKv(KV) ?? "{}")
    } catch {}
    // Each field on its own, so one bad value (an older shape) doesn't reset the rest.
    const out: RunPodSettings = { ...DEFAULT_RUNPOD_SETTINGS }
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const field = runpodSettingsPatch.shape[k as keyof RunPodSettings]
        const parsed = field?.safeParse(v)
        if (parsed?.success && parsed.data !== undefined) (out as unknown as Record<string, unknown>)[k] = parsed.data
      }
    }
    return out
  }

  update(patch: unknown): RunPodSettings {
    const parsed = runpodSettingsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    const next = { ...this.get(), ...parsed.data }
    this.store.setKv(KV, JSON.stringify(next))
    return next
  }

  /** Keep-warm deadlines by box id (ms since epoch), in their own kv entry so they survive restarts. */
  keepWarm(): Record<string, number> {
    try {
      const v = JSON.parse(this.store.getKv(`${KV}_keep_warm`) ?? "{}")
      return v && typeof v === "object" ? v : {}
    } catch {
      return {}
    }
  }

  setKeepWarm(boxId: string, until: number | null) {
    const all = this.keepWarm()
    if (until && until > Date.now()) all[boxId] = until
    else delete all[boxId]
    for (const [k, v] of Object.entries(all)) if (v <= Date.now()) delete all[k]
    this.store.setKv(`${KV}_keep_warm`, Object.keys(all).length ? JSON.stringify(all) : null)
  }
}
