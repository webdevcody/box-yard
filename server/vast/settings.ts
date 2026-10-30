import { z } from "zod"
import { BadRequestError, type Store } from "../store.js"
import { DEFAULT_VAST_SETTINGS, VAST_MACHINE_LIMITS, type VastSettings } from "../../shared/vast.js"

/** Settings › Vast.ai GPU, in a kv entry of its own (no secrets: the API key is a credential). */
const KV = "vast"

const imageRef = z
  .string()
  .trim()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "That isn't an image reference (like docker.io/you/boxyard-gpu:tag)")

const L = VAST_MACHINE_LIMITS

export const vastSettingsPatch = z
  .object({
    defaultForGpu: z.boolean(),
    image: imageRef.nullable(),
    gpuTypes: z.array(z.string().trim().min(1).max(100)).min(1, "Pick at least one GPU type").max(10),
    minRamGb: z.number().int().min(L.minRamGb.min).max(L.minRamGb.max),
    minVcpus: z.number().int().min(L.minVcpus.min).max(L.minVcpus.max),
    verifiedOnly: z.boolean(),
    minReliability: z.number().min(L.minReliability.min).max(L.minReliability.max),
    minInetDownMbps: z.number().int().min(L.minInetDownMbps.min).max(L.minInetDownMbps.max),
    containerDiskGb: z.number().int().min(20).max(2000),
    idleMinutes: z.number().int().min(1).max(24 * 60),
    agentsPerPod: z.number().int().min(1).max(16),
    maxHourlyUsd: z.number().min(0).max(100),
    totalMaxHourlyUsd: z.number().min(0).max(1000),
    watchdogMinutes: z.number().int().min(5).max(24 * 60),
  })
  .partial()
  .strict()

export class VastSettingsStore {
  constructor(private readonly store: Store) {}

  get(): VastSettings {
    let raw: unknown = {}
    try {
      raw = JSON.parse(this.store.getKv(KV) ?? "{}")
    } catch {}
    // Each field on its own, so one bad value doesn't reset the rest.
    const out: VastSettings = { ...DEFAULT_VAST_SETTINGS }
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const field = vastSettingsPatch.shape[k as keyof VastSettings]
        const parsed = field?.safeParse(v)
        if (parsed?.success && parsed.data !== undefined) (out as unknown as Record<string, unknown>)[k] = parsed.data
      }
    }
    return out
  }

  update(patch: unknown): VastSettings {
    const parsed = vastSettingsPatch.safeParse(patch)
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
