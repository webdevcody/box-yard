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
import { BOX_SIZE_SPECS } from "../shared/boxSizes.js"
import { DEFAULT_OWNER_NAME } from "../shared/owner.js"
import { DEFAULT_NOTE_BUDGET, type NoteBudget } from "../shared/notes.js"
import {
  ELEVENLABS_SPEED,
  MAX_INSTRUCTIONS,
  OPENAI_SPEED,
  TTS_DEFAULTS,
  TTS_PROVIDERS,
  type CloudProvider,
  type ElevenLabsTts,
  type KeyStatus,
  type OpenAiTts,
  type TtsInfo,
  type TtsProvider,
  type TtsSettings,
} from "../shared/tts.js"

const KEY = "settings"

export const DEFAULT_SETTINGS: Settings = {
  ownerName: DEFAULT_OWNER_NAME,
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
  autoResizeEnabled: true,
  autoResizeMaxSize: "large",
  maxBoxes: 5,
  slotsPerBox: SIZE_DEFAULTS.small.slotsPerBox,
  maxAgents: 0,
  costRates: {
    boxActiveCpuHourlyUsd: Object.fromEntries(BOX_SIZES.map((s) => [s, BOX_SIZE_SPECS[s].activeCpuHourlyUsd])) as Record<BoxSize, number>,
    boxKeepAliveMonthlyUsd: Object.fromEntries(BOX_SIZES.map((s) => [s, BOX_SIZE_SPECS[s].keepAliveMonthlyUsd])) as Record<BoxSize, number>,
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
  gitPartialClone: true,
  buildCleanupIdleMinutes: 15,
  notesRetroEnabled: true,
  notesMaxCount: DEFAULT_NOTE_BUDGET.maxNotes,
  notesMaxTokens: DEFAULT_NOTE_BUDGET.maxTokens,
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
  gitPartialClone: "BOXYARD_GIT_PARTIAL_CLONE",
  buildCleanupIdleMinutes: "BOXYARD_BUILD_CLEANUP_IDLE_MINUTES",
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
    ownerName: z.string().trim().min(1, "Name is required").max(40).regex(/^[^\n<>{}`]+$/, "Name has unsupported characters"),
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
    autoResizeEnabled: z.boolean(),
    autoResizeMaxSize: z.enum(BOX_SIZES),
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
    gitPartialClone: z.boolean(),
    buildCleanupIdleMinutes: z.number().int().min(0).max(30 * 24 * 60),
    notesRetroEnabled: z.boolean(),
    notesMaxCount: z.number().int().min(1).max(200),
    notesMaxTokens: z.number().int().min(200).max(50_000),
  })
  .partial()
  .strict()

/**
 * Settings saved in the UI live in SQLite (kv). Precedence: saved in the UI >
 * BOXYARD_OWNER_NAME / ORCHESTRATOR_MODEL / WORKER_MODEL / CAPTAIN_MODEL / CAPTAIN_EFFORT env vars > built-in defaults.
 * Every turn reads them fresh, so a change applies from the next turn on.
 */
export class SettingsStore {
  constructor(
    private readonly store: Store,
    private readonly c: Partial<
      Pick<
      Config,
      | "ownerName"
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
      | "gitPartialClone"
      | "buildCleanupIdleMinutes"
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
    if (this.c.ownerName) env.ownerName = this.c.ownerName
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
      gitPartialClone: this.c.gitPartialClone ?? DEFAULT_SETTINGS.gitPartialClone,
      buildCleanupIdleMinutes: this.c.buildCleanupIdleMinutes ?? DEFAULT_SETTINGS.buildCleanupIdleMinutes,
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

  /**
   * Agents per box and task folders per box when set on purpose (saved in the UI, BOX_SLOTS / BOX_MAX_RESIDENT,
   * or a config value that isn't the worker size's default); null means each box uses its own size's default.
   */
  boxLimitOverrides(): { slotsPerBox: number | null; maxResidentPerBox: number | null } {
    const saved = this.saved()
    const configWorkerSize = this.c.workerSize ?? DEFAULT_SETTINGS.workerSize
    const d = SIZE_DEFAULTS[configWorkerSize]
    const configSlots = this.c.slotsPerBox ?? d.slotsPerBox
    const configResidents = this.c.maxResidentPerBox ?? d.maxResidentPerBox
    const slots = saved.slotsPerBox ?? (process.env.BOX_SLOTS !== undefined || configSlots !== d.slotsPerBox ? configSlots : null)
    const residents = saved.maxResidentPerBox ?? (process.env.BOX_MAX_RESIDENT !== undefined || configResidents !== d.maxResidentPerBox ? configResidents : null)
    return { slotsPerBox: slots ?? null, maxResidentPerBox: residents ?? null }
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

/** The notes budget Settings sets. */
export const noteBudgetOf = (s: Pick<Settings, "notesMaxCount" | "notesMaxTokens">): NoteBudget => ({ maxNotes: s.notesMaxCount, maxTokens: s.notesMaxTokens })

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

// ------------------------------------------------------------------ text-to-speech (Settings › Voice)

const TTS_KEY = "tts_settings"
/** API keys live in their own kv entry, so nothing that returns settings can include them by accident. */
const TTS_SECRETS_KEY = "tts_keys"

const apiKey = z
  .string()
  .trim()
  .min(8, "That key looks too short")
  .max(500)
  .regex(/^[\x21-\x7e]+$/, "API keys have no spaces or special characters")
const ttsModel = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "Model names are letters, digits, dots and dashes")

export const ttsPatch = z
  .object({
    provider: z.enum(TTS_PROVIDERS),
    elevenlabs: z
      .object({
        voiceId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Not an ElevenLabs voice id"),
        voiceName: z.string().trim().max(100),
        model: ttsModel,
        speed: z.number().min(ELEVENLABS_SPEED.min).max(ELEVENLABS_SPEED.max),
      })
      .partial()
      .strict(),
    openai: z
      .object({
        voice: z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/, "Not an OpenAI voice"),
        model: ttsModel,
        instructions: z.string().max(MAX_INSTRUCTIONS),
        speed: z.number().min(OPENAI_SPEED.min).max(OPENAI_SPEED.max),
      })
      .partial()
      .strict(),
    /** A new key, or null to forget the saved one (an env var then applies again). */
    elevenlabsApiKey: apiKey.nullable(),
    openaiApiKey: apiKey.nullable(),
  })
  .partial()
  .strict()

type SavedTts = { provider?: TtsProvider; elevenlabs?: Partial<ElevenLabsTts>; openai?: Partial<OpenAiTts> }

/**
 * Text-to-speech settings: the provider, each provider's voice/model/speed, and the API keys.
 * Same precedence as the rest of Settings: saved in the UI > TTS_PROVIDER / ELEVENLABS_API_KEY /
 * OPENAI_API_KEY env vars > built-in defaults. info() reports keys as set/unset only.
 */
export class TtsSettingsStore {
  constructor(
    private readonly store: Store,
    private readonly c: Partial<Pick<Config, "elevenlabsApiKey" | "openaiApiKey" | "ttsProvider">>,
  ) {}

  private json<T>(key: string): T {
    try {
      const v = JSON.parse(this.store.getKv(key) ?? "{}")
      return v && typeof v === "object" ? v : ({} as T)
    } catch {
      return {} as T
    }
  }

  private saved(): SavedTts {
    const parsed = ttsPatch.safeParse(this.json(TTS_KEY))
    return parsed.success ? (parsed.data as SavedTts) : {}
  }

  private secrets(): Partial<Record<CloudProvider, string>> {
    return this.json(TTS_SECRETS_KEY)
  }

  private envKey(p: CloudProvider): string {
    return (p === "elevenlabs" ? this.c.elevenlabsApiKey : this.c.openaiApiKey) ?? ""
  }

  private envProvider(): TtsProvider | null {
    const v = this.c.ttsProvider
    return v && (TTS_PROVIDERS as readonly string[]).includes(v) ? (v as TtsProvider) : null
  }

  /** The key to call a provider with (server-side only), or "" when none is set. */
  apiKey(p: CloudProvider): string {
    return this.secrets()[p] || this.envKey(p)
  }

  info(): TtsInfo {
    const saved = this.saved()
    const envProvider = this.envProvider()
    const secrets = this.secrets()
    const settings: TtsSettings = {
      provider: saved.provider ?? envProvider ?? TTS_DEFAULTS.provider,
      elevenlabs: { ...TTS_DEFAULTS.elevenlabs, ...saved.elevenlabs },
      openai: { ...TTS_DEFAULTS.openai, ...saved.openai },
    }
    const keyStatus = (p: CloudProvider): KeyStatus =>
      secrets[p] ? { state: "set", source: "ui" } : this.envKey(p) ? { state: "set", source: "env" } : { state: "unset", source: "default" }
    return {
      settings,
      sources: {
        provider: saved.provider ? "ui" : envProvider ? "env" : "default",
        elevenlabs: saved.elevenlabs && Object.keys(saved.elevenlabs).length ? "ui" : "default",
        openai: saved.openai && Object.keys(saved.openai).length ? "ui" : "default",
      },
      keys: { elevenlabs: keyStatus("elevenlabs"), openai: keyStatus("openai") },
      defaults: TTS_DEFAULTS,
    }
  }

  get(): TtsSettings {
    return this.info().settings
  }

  update(patch: unknown): TtsInfo {
    const parsed = ttsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
    const { elevenlabsApiKey, openaiApiKey, ...prefs } = parsed.data
    const saved = this.saved()
    this.store.setKv(
      TTS_KEY,
      JSON.stringify({
        ...saved,
        ...(prefs.provider ? { provider: prefs.provider } : {}),
        ...(prefs.elevenlabs ? { elevenlabs: { ...saved.elevenlabs, ...prefs.elevenlabs } } : {}),
        ...(prefs.openai ? { openai: { ...saved.openai, ...prefs.openai } } : {}),
      }),
    )
    if (elevenlabsApiKey !== undefined || openaiApiKey !== undefined) {
      const secrets = this.secrets()
      for (const [p, v] of [["elevenlabs", elevenlabsApiKey], ["openai", openaiApiKey]] as const) {
        if (v === null) delete secrets[p]
        else if (v !== undefined) secrets[p] = v
      }
      this.store.setKv(TTS_SECRETS_KEY, JSON.stringify(secrets))
    }
    return this.info()
  }

  /** Forget saved choices (not keys) so env vars and defaults apply again. */
  reset(): TtsInfo {
    this.store.setKv(TTS_KEY, null)
    return this.info()
  }
}
