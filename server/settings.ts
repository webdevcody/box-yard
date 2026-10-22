import { z } from "zod"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  type AutoCompact,
  type Settings,
  type SettingSource,
  type SettingsInfo,
} from "../shared/types.js"

const KEY = "settings"

export const DEFAULT_SETTINGS: Settings = {
  orchestratorModel: DEFAULT_MODEL,
  orchestratorEffort: DEFAULT_EFFORT,
  orchestratorAutoCompact: { enabled: true, unit: "percent", value: 80 },
  agentModel: DEFAULT_MODEL,
  agentEffort: DEFAULT_EFFORT,
  // Off means the CLI's own default (compact near the model's window) applies.
  agentAutoCompact: { enabled: false, unit: "percent", value: 80 },
  maxBoxes: 5,
  slotsPerBox: 2,
  maxAgents: 0,
}

/** Env vars that seed the pool limits; saved settings win over them. */
const POOL_ENV: Record<"maxBoxes" | "slotsPerBox" | "maxAgents", string> = {
  maxBoxes: "BOX_POOL_MAX",
  slotsPerBox: "BOX_SLOTS",
  maxAgents: "BOX_MAX_AGENTS",
}

const autoCompact = z
  .object({ enabled: z.boolean(), unit: z.enum(["percent", "tokens"]), value: z.number() })
  .superRefine((v, ctx) => {
    if (v.unit === "percent" && (v.value < 10 || v.value > 95)) ctx.addIssue({ code: "custom", message: "Percent must be between 10 and 95" })
    if (v.unit === "tokens" && (v.value < AUTOCOMPACT_MIN_TOKENS || v.value > AUTOCOMPACT_MAX_TOKENS))
      ctx.addIssue({ code: "custom", message: `Tokens must be between ${AUTOCOMPACT_MIN_TOKENS} and ${AUTOCOMPACT_MAX_TOKENS}` })
  })
const model = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\[\]/-]+$/, "Model names have no spaces")

export const settingsPatch = z
  .object({
    orchestratorModel: model,
    orchestratorEffort: z.enum(EFFORTS),
    orchestratorAutoCompact: autoCompact,
    agentModel: model,
    agentEffort: z.enum([...EFFORTS, "orchestrator"]),
    agentAutoCompact: autoCompact,
    maxBoxes: z.number().int().min(1).max(100),
    slotsPerBox: z.number().int().min(1).max(20),
    maxAgents: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict()

/**
 * Settings saved in the UI live in SQLite (kv). Precedence: saved in the UI >
 * ORCHESTRATOR_MODEL / WORKER_MODEL env vars (models only) > built-in defaults.
 * Every turn reads them fresh, so a change applies from the next turn on.
 */
export class SettingsStore {
  constructor(
    private readonly store: Store,
    private readonly c: Pick<Config, "orchestratorModel" | "workerModel" | "maxBoxes" | "slotsPerBox" | "maxAgents">,
  ) {}

  private saved(): Partial<Settings> {
    const raw = this.store.getKv(KEY)
    if (!raw) return {}
    try {
      const parsed = settingsPatch.safeParse(JSON.parse(raw))
      return parsed.success ? (parsed.data as Partial<Settings>) : {}
    } catch {
      return {}
    }
  }

  info(): SettingsInfo {
    const saved = this.saved()
    const env: Partial<Settings> = {}
    if (this.c.orchestratorModel) env.orchestratorModel = this.c.orchestratorModel
    if (this.c.workerModel) env.agentModel = this.c.workerModel
    // Config already holds the env var or the built-in default for the pool limits.
    const pool = { maxBoxes: this.c.maxBoxes, slotsPerBox: this.c.slotsPerBox, maxAgents: this.c.maxAgents }
    const defaults = { ...DEFAULT_SETTINGS, ...pool }
    const settings = { ...defaults, ...env, ...saved } as Settings
    const sources = {} as Record<keyof Settings, SettingSource>
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const fromEnv = k in env || (k in POOL_ENV && process.env[POOL_ENV[k as keyof typeof POOL_ENV]] !== undefined)
      sources[k] = k in saved ? "ui" : fromEnv ? "env" : "default"
    }
    return { settings, sources, defaults }
  }

  get(): Settings {
    return this.info().settings
  }

  update(patch: unknown): SettingsInfo {
    const parsed = settingsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
    this.store.setKv(KEY, JSON.stringify({ ...this.saved(), ...parsed.data }))
    return this.info()
  }

  /** Forget saved values (all, or the named ones) so env vars and defaults apply again. */
  reset(keys?: (keyof Settings)[]): SettingsInfo {
    const saved = this.saved()
    if (keys) for (const k of keys) delete saved[k]
    this.store.setKv(KEY, keys ? JSON.stringify(saved) : null)
    return this.info()
  }
}

/** Tokens at which an auto-compact should happen, or null when it is off. */
export function compactThreshold(ac: AutoCompact, window: number | null): number | null {
  if (!ac.enabled) return null
  if (ac.unit === "tokens") return ac.value
  return Math.round(((window ?? AUTOCOMPACT_MAX_TOKENS) * ac.value) / 100)
}

/** The CLI's --autocompact value (tokens), clamped to what it accepts. */
export function autocompactFlag(ac: AutoCompact, window: number | null): string | null {
  const t = compactThreshold(ac, window)
  if (t === null) return null
  return String(Math.min(AUTOCOMPACT_MAX_TOKENS, Math.max(AUTOCOMPACT_MIN_TOKENS, t)))
}
