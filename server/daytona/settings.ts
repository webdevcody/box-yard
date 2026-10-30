import { z } from "zod"
import { BadRequestError, type Store } from "../store.js"
import { DAYTONA_CPU, DAYTONA_LIMITS, DEFAULT_DAYTONA_SETTINGS, type DaytonaSettings } from "../../shared/daytona.js"

/** Settings › Daytona, in a kv entry of its own (no secrets: the API key is a credential). */
const KV = "daytona"

const imageRef = z
  .string()
  .trim()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "That isn't an image reference (like docker.io/you/boxyard-gpu:tag)")

const L = DAYTONA_LIMITS

export const daytonaSettingsPatch = z
  .object({
    defaultForGpu: z.boolean(),
    image: imageRef.nullable(),
    cpuImage: imageRef.min(1),
    gpuTypes: z
      .array(z.string().trim().min(1).max(40))
      .min(1, "Pick at least one GPU type, or CPU only")
      .max(10)
      .refine((t) => !t.includes(DAYTONA_CPU) || t.length === 1, "CPU only can't be mixed with GPU types"),
    gpus: z.number().int().min(L.gpus.min).max(L.gpus.max),
    vcpus: z.number().int().min(L.vcpus.min).max(L.vcpus.max),
    memoryGb: z.number().int().min(L.memoryGb.min).max(L.memoryGb.max),
    diskGb: z.number().int().min(L.diskGb.min).max(L.diskGb.max),
    cpuVcpus: z.number().int().min(L.vcpus.min).max(L.vcpus.max),
    cpuMemoryGb: z.number().int().min(L.memoryGb.min).max(L.memoryGb.max),
    cpuDiskGb: z.number().int().min(L.diskGb.min).max(L.diskGb.max),
    spot: z.boolean(),
    idleMinutes: z.number().int().min(1).max(24 * 60),
    agentsPerPod: z.number().int().min(1).max(16),
    maxHourlyUsd: z.number().min(0).max(100),
    totalMaxHourlyUsd: z.number().min(0).max(1000),
    watchdogMinutes: z.number().int().min(5).max(24 * 60),
    startMinutes: z.number().int().min(2).max(120),
  })
  .partial()
  .strict()

export class DaytonaSettingsStore {
  constructor(private readonly store: Store) {}

  get(): DaytonaSettings {
    let raw: unknown = {}
    try {
      raw = JSON.parse(this.store.getKv(KV) ?? "{}")
    } catch {}
    // Each field on its own, so one bad value doesn't reset the rest.
    const out: DaytonaSettings = { ...DEFAULT_DAYTONA_SETTINGS }
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const field = daytonaSettingsPatch.shape[k as keyof DaytonaSettings]
        const parsed = field?.safeParse(v)
        if (parsed?.success && parsed.data !== undefined) (out as unknown as Record<string, unknown>)[k] = parsed.data
      }
    }
    return out
  }

  update(patch: unknown): DaytonaSettings {
    const parsed = daytonaSettingsPatch.safeParse(patch)
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
