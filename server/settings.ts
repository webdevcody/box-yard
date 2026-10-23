import { z } from "zod"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_SIZES,
  DEFAULT_CAPTAIN_EFFORT,
  DEFAULT_CAPTAIN_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  SIZE_DEFAULTS,
  WORKER_SIZES,
  type AutoCompact,
  type BoxSize,
  type CostRates,
  type Settings,
  type SettingSource,
  type SettingsInfo,
  type WorkerSize,
} from "../shared/types.js"

const KEY = "settings"

export const DEFAULT_SETTINGS: Settings = {
  orchestratorModel: DEFAULT_MODEL,
  orchestratorEffort: DEFAULT_EFFORT,
  orchestratorAutoCompact: { enabled: true, unit: "percent", value: 80 },
  captainModel: DEFAULT_CAPTAIN_MODEL,
  captainEffort: DEFAULT_CAPTAIN_EFFORT,
  agentModel: DEFAULT_MODEL,
  agentEffort: DEFAULT_EFFORT,
  agentRoutingConfig: "",
  // Off means the CLI's own default (compact near the model's window) applies.
  agentAutoCompact: { enabled: false, unit: "percent", value: 80 },
  workerSize: "small",
  maxBoxes: 5,
  slotsPerBox: SIZE_DEFAULTS.small.slotsPerBox,
  maxAgents: 0,
  costRates: {
    boxActiveCpuHourlyUsd: { small: 0.1, medium: 0.2, large: 0.4 },
    boxKeepAliveMonthlyUsd: { small: 8, medium: 16, large: 32 },
    boxStorageGbMonthUsd: 0.1,
  },
  budget: { dailyUsd: 0, monthlyUsd: 0 },
  maxResidentPerBox: SIZE_DEFAULTS.small.maxResidentPerBox,
  boxIdleDeleteMinutes: 0,
  workspaceRetentionDays: 7,
  archiveRetentionDays: 7,
  archiveKeepTouchedDays: 30,
  diskMinFreeMb: 1024,
  diskCloneFactor: 2,
}

/** Env vars that seed box/pool settings; saved settings win over them. */
const BOX_ENV: Partial<Record<keyof Settings, string>> = {
  workerSize: "WORKER_SIZE",
  maxBoxes: "BOX_POOL_MAX",
  slotsPerBox: "BOX_SLOTS",
  maxAgents: "BOX_MAX_AGENTS",
  maxResidentPerBox: "BOX_MAX_RESIDENT",
  boxIdleDeleteMinutes: "BOX_IDLE_DELETE_MINUTES",
  workspaceRetentionDays: "BOXYARD_WORKSPACE_RETENTION_DAYS",
  archiveRetentionDays: "BOXYARD_ARCHIVE_RETENTION_DAYS",
  archiveKeepTouchedDays: "BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS",
  diskMinFreeMb: "BOXYARD_DISK_MIN_FREE_MB",
  diskCloneFactor: "BOXYARD_DISK_CLONE_FACTOR",
}

const autoCompact = z
  .object({ enabled: z.boolean(), unit: z.enum(["percent", "tokens"]), value: z.number() })
  .superRefine((v, ctx) => {
    if (v.unit === "percent" && (v.value < 10 || v.value > 95)) ctx.addIssue({ code: "custom", message: "Percent must be between 10 and 95" })
    if (v.unit === "tokens" && (v.value < AUTOCOMPACT_MIN_TOKENS || v.value > AUTOCOMPACT_MAX_TOKENS))
      ctx.addIssue({ code: "custom", message: `Tokens must be between ${AUTOCOMPACT_MIN_TOKENS} and ${AUTOCOMPACT_MAX_TOKENS}` })
  })
const model = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\[\]/-]+$/, "Model names have no spaces")
const usd = z.number().min(0).max(1_000_000)
const bySize = z.object(Object.fromEntries(BOX_SIZES.map((s) => [s, usd])) as Record<BoxSize, z.ZodNumber>).strict()
const costRates = z
  .object({
    boxActiveCpuHourlyUsd: bySize,
    boxKeepAliveMonthlyUsd: bySize,
    boxStorageGbMonthUsd: usd,
  })
  .strict() satisfies z.ZodType<CostRates>
const budget = z.object({ dailyUsd: usd, monthlyUsd: usd }).strict()

export const settingsPatch = z
  .object({
    orchestratorModel: model,
    orchestratorEffort: z.enum(EFFORTS),
    orchestratorAutoCompact: autoCompact,
    captainModel: model,
    captainEffort: z.enum(EFFORTS),
    agentModel: model,
    agentEffort: z.enum([...EFFORTS, "orchestrator"]),
    agentRoutingConfig: z.string().max(50_000),
    agentAutoCompact: autoCompact,
    workerSize: z.enum(WORKER_SIZES),
    maxBoxes: z.number().int().min(1).max(100),
    slotsPerBox: z.number().int().min(1).max(20),
    maxAgents: z.number().int().min(0).max(1000),
    costRates,
    budget,
    maxResidentPerBox: z.number().int().min(1).max(200),
    boxIdleDeleteMinutes: z.number().int().min(0).max(30 * 24 * 60),
    workspaceRetentionDays: z.number().int().min(0).max(3650),
    archiveRetentionDays: z.number().int().min(0).max(3650),
    archiveKeepTouchedDays: z.number().int().min(0).max(3650),
    diskMinFreeMb: z.number().int().min(0).max(1_000_000),
    diskCloneFactor: z.number().min(1).max(20),
  })
  .partial()
  .strict()

/**
 * Settings saved in the UI live in SQLite (kv). Precedence: saved in the UI >
 * ORCHESTRATOR_MODEL / WORKER_MODEL / CAPTAIN_MODEL / CAPTAIN_EFFORT env vars > built-in defaults.
 * Every turn reads them fresh, so a change applies from the next turn on.
 */
export class SettingsStore {
  constructor(
    private readonly store: Store,
    private readonly c: Partial<
      Pick<
      Config,
      | "orchestratorModel"
      | "workerModel"
      | "captainModel"
      | "captainEffort"
      | "workerSize"
      | "maxBoxes"
      | "slotsPerBox"
      | "maxAgents"
      | "maxResidentPerBox"
      | "boxIdleDeleteMinutes"
      | "workspaceRetentionDays"
      | "archiveRetentionDays"
      | "archiveKeepTouchedDays"
      | "diskMinFreeMb"
      | "diskCloneFactor"
      >
    >,
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
    if (this.c.captainModel) env.captainModel = this.c.captainModel
    if (this.c.captainEffort) env.captainEffort = this.c.captainEffort
    const configWorkerSize = this.c.workerSize ?? DEFAULT_SETTINGS.workerSize
    if (process.env.WORKER_SIZE !== undefined) env.workerSize = configWorkerSize
    const workerSize = (saved.workerSize ?? configWorkerSize) as WorkerSize
    const sizeDefaults = SIZE_DEFAULTS[workerSize]
    const configSizeDefaults = SIZE_DEFAULTS[configWorkerSize]
    const configSlots = this.c.slotsPerBox ?? configSizeDefaults.slotsPerBox
    const configResidents = this.c.maxResidentPerBox ?? configSizeDefaults.maxResidentPerBox
    const slotsExplicit = process.env.BOX_SLOTS !== undefined || configSlots !== configSizeDefaults.slotsPerBox
    const residentsExplicit = process.env.BOX_MAX_RESIDENT !== undefined || configResidents !== configSizeDefaults.maxResidentPerBox
    // Config already holds either explicit env vars or defaults derived from the effective worker size.
    const pool = {
      maxBoxes: this.c.maxBoxes ?? DEFAULT_SETTINGS.maxBoxes,
      slotsPerBox: slotsExplicit ? configSlots : sizeDefaults.slotsPerBox,
      maxAgents: this.c.maxAgents ?? DEFAULT_SETTINGS.maxAgents,
      maxResidentPerBox: residentsExplicit ? configResidents : sizeDefaults.maxResidentPerBox,
      boxIdleDeleteMinutes: this.c.boxIdleDeleteMinutes ?? DEFAULT_SETTINGS.boxIdleDeleteMinutes,
      workspaceRetentionDays: this.c.workspaceRetentionDays ?? DEFAULT_SETTINGS.workspaceRetentionDays,
      archiveRetentionDays: this.c.archiveRetentionDays ?? DEFAULT_SETTINGS.archiveRetentionDays,
      archiveKeepTouchedDays: this.c.archiveKeepTouchedDays ?? DEFAULT_SETTINGS.archiveKeepTouchedDays,
      diskMinFreeMb: this.c.diskMinFreeMb ?? DEFAULT_SETTINGS.diskMinFreeMb,
      diskCloneFactor: this.c.diskCloneFactor ?? DEFAULT_SETTINGS.diskCloneFactor,
    }
    const defaults = { ...DEFAULT_SETTINGS, workerSize, ...sizeDefaults, ...pool }
    const settings = { ...defaults, ...env, ...saved } as Settings
    const sources = {} as Record<keyof Settings, SettingSource>
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const fromEnv = k in env || (BOX_ENV[k] !== undefined && process.env[BOX_ENV[k]!] !== undefined)
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
