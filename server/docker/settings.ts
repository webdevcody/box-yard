import { z } from "zod"
import { BadRequestError, type Store } from "../store.js"
import { DEFAULT_DOCKER_SETTINGS, DOCKER_LIMITS, type DockerSettings } from "../../shared/docker.js"

/** Settings › Docker, in a kv entry of its own (no secrets: containers get the credentials Settings › Credentials has). */
const KV = "docker"

/** An image reference: [registry/]name[:tag][@digest], no spaces or shell characters. */
export const dockerImageRef = z
  .string()
  .trim()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "That isn't an image reference (like node:24-bookworm or ghcr.io/you/agent:1)")

export const dockerSettingsPatch = z
  .object({
    cpus: z.number().min(DOCKER_LIMITS.cpus.min).max(DOCKER_LIMITS.cpus.max),
    memoryMb: z.number().int().min(DOCKER_LIMITS.memoryMb.min).max(DOCKER_LIMITS.memoryMb.max),
    agentsPerContainer: z.number().int().min(DOCKER_LIMITS.agentsPerContainer.min).max(DOCKER_LIMITS.agentsPerContainer.max),
    idleMinutes: z.number().int().min(DOCKER_LIMITS.idleMinutes.min).max(DOCKER_LIMITS.idleMinutes.max),
    image: dockerImageRef.nullable(),
    hostPortBase: z.number().int().min(DOCKER_LIMITS.hostPortBase.min).max(DOCKER_LIMITS.hostPortBase.max),
  })
  .partial()
  .strict()

/** A Dockerfile is text the owner wrote; this only bounds its size. Keys in it are refused when it's built. */
const dockerfileText = z.string().max(20_000)

/** A project's own image (Project.docker): each field left out stays as it is, null (or blank) clears it. */
export const projectDockerPatch = z
  .object({
    image: z.union([dockerImageRef, z.literal("")]).nullable(),
    dockerfile: dockerfileText.nullable(),
  })
  .partial()
  .strict()

export class DockerSettingsStore {
  constructor(private readonly store: Store) {}

  get(): DockerSettings {
    let raw: unknown = {}
    try {
      raw = JSON.parse(this.store.getKv(KV) ?? "{}")
    } catch {}
    // Each field on its own, so one bad value (an older shape) doesn't reset the rest.
    const out: DockerSettings = { ...DEFAULT_DOCKER_SETTINGS }
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        const field = dockerSettingsPatch.shape[k as keyof DockerSettings]
        const parsed = field?.safeParse(v)
        if (parsed?.success && parsed.data !== undefined) (out as unknown as Record<string, unknown>)[k] = parsed.data
      }
    }
    return out
  }

  update(patch: unknown): DockerSettings {
    const parsed = dockerSettingsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    const next = { ...this.get(), ...parsed.data }
    this.store.setKv(KV, JSON.stringify(next))
    return next
  }
}
