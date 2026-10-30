import { z } from "zod"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_CREATE_CONCURRENCY,
  BOX_SIZES,
  DEFAULT_AUTOCOMPACT_TOKENS,
  DEFAULT_CAPTAIN_EFFORT,
  DEFAULT_CAPTAIN_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_RELAY_MODEL,
  EFFORTS,
  SIZE_DEFAULTS,
  WORKER_SIZES,
  type AutoCompact,
  type BoxSize,
  type BudgetSettings,
  type CostRates,
  type Project,
  type Settings,
  type SettingSource,
  type SettingsInfo,
  type WorkerSize,
} from "../shared/types.js"
import { BOX_SIZE_SPECS } from "../shared/boxSizes.js"
import { CredentialStore } from "./credentials.js"
import type { CredentialKey } from "../shared/setup.js"
import { DEFAULT_OWNER_NAME } from "../shared/owner.js"
import { DEFAULT_NOTE_BUDGET, NOTE_BUDGET_LIMITS, projectNoteBudget, type NoteBudget } from "../shared/notes.js"
import { DEFAULT_MEMORY_POLICY } from "../shared/memory.js"
import { LOCAL_AGENTS_LIMITS } from "../shared/runner.js"
import {
  ELEVENLABS_SPEED,
  MAX_INSTRUCTIONS,
  OPENAI_SPEED,
  TTS_DEFAULTS,
  TTS_PROVIDERS,
  migrateOpenAiTts,
  type CloudProvider,
  type ElevenLabsTts,
  type KeyStatus,
  type OpenAiTts,
  type TtsInfo,
  type TtsProvider,
  type TtsSettings,
} from "../shared/tts.js"

const KEY = "settings"
/** Set once upgradeForCloudLimit has run. */
const CLOUD_LIMIT_UPGRADE_KEY = "settings_upgrade_cloud_limit"

export const DEFAULT_SETTINGS: Settings = {
  ownerName: DEFAULT_OWNER_NAME,
  startInZen: true,
  // Off: not every install uses boxes. The Boxes page always shows the same reading.
  showCloudMeter: false,
  orchestratorModel: DEFAULT_MODEL,
  orchestratorEffort: DEFAULT_EFFORT,
  // A fixed token count, not a share of the window: 80% of a 1M window let every Coordinator and Captain turn
  // carry up to 800k tokens of history. A value saved in Settings wins (only changed keys are saved).
  orchestratorAutoCompact: { enabled: true, unit: "tokens", value: DEFAULT_AUTOCOMPACT_TOKENS },
  orchestratorRelay: DEFAULT_RELAY_MODEL,
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
  // Off: a task whose project needs a bigger box than any free one waits for it; placement never resizes a box.
  placementResizeEnabled: false,
  // A safety ceiling, not a budget: Settings › Daily cloud limit keeps spend in check.
  maxBoxes: 50,
  boxCreateConcurrency: BOX_CREATE_CONCURRENCY.default,
  slotsPerBox: SIZE_DEFAULTS.small.slotsPerBox,
  maxAgents: 0,
  localAgents: 2,
  costRates: {
    boxActiveCpuHourlyUsd: Object.fromEntries(BOX_SIZES.map((s) => [s, BOX_SIZE_SPECS[s].activeCpuHourlyUsd])) as Record<BoxSize, number>,
    boxKeepAliveMonthlyUsd: Object.fromEntries(BOX_SIZES.map((s) => [s, BOX_SIZE_SPECS[s].keepAliveMonthlyUsd])) as Record<BoxSize, number>,
    boxStorageGbMonthUsd: 0.1,
  },
  // What boxes may cost: per day (raisable until midnight from the cloud meter) and over 30 days (0: no limit).
  budget: { dailyUsd: 10, monthlyUsd: 0 },
  maxResidentPerBox: SIZE_DEFAULTS.small.maxResidentPerBox,
  boxIdleDeleteMinutes: 30,
  workspaceRetentionDays: 7,
  archiveRetentionDays: 7,
  archiveKeepTouchedDays: 30,
  diskMinFreeMb: 1024,
  diskCloneFactor: 2,
  memoryMaxUsedPercent: DEFAULT_MEMORY_POLICY.maxUsedPercent,
  memoryMinFreeMb: DEFAULT_MEMORY_POLICY.minFreeMb,
  loadMaxPerCpu: DEFAULT_MEMORY_POLICY.maxLoadPerCpu,
  gitPartialClone: true,
  gitPushAtTurnEnd: true,
  buildCleanupIdleMinutes: 15,
  depCacheEnabled: false,
  depCacheMaxMb: 2048,
  notesRetroEnabled: true,
  notesMaxCount: DEFAULT_NOTE_BUDGET.maxNotes,
  notesMaxTokens: DEFAULT_NOTE_BUDGET.maxTokens,
}

/** Settings that each box takes from its own size unless set on purpose (see SettingsStore.boxLimitInfo). */
export const BOX_LIMIT_KEYS = ["slotsPerBox", "maxResidentPerBox"] as const
export type BoxLimitKey = (typeof BOX_LIMIT_KEYS)[number]
/** Why a box limit replaces the size defaults: saved in the UI, an env var, or a config value off the size default. */
export type BoxLimitSource = "ui" | "env" | "config"

/** Settings keys a reset may name: `?keys=slotsPerBox,maxResidentPerBox`, or repeated `keys`. Anything else is a 400. */
export function parseSettingKeys(raw: unknown): (keyof Settings)[] {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((k) => k.trim()).filter(Boolean)
  if (parts.length === 0) throw new BadRequestError("Name at least one setting to reset, e.g. ?keys=slotsPerBox")
  const unknown = parts.filter((k) => !Object.hasOwn(DEFAULT_SETTINGS, k))
  if (unknown.length) throw new BadRequestError(`Unknown setting${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`)
  return [...new Set(parts)] as (keyof Settings)[]
}

/** Env vars that seed box/pool settings; saved settings win over them. */
const BOX_ENV: Partial<Record<keyof Settings, string>> = {
  workerSize: "WORKER_SIZE",
  maxBoxes: "BOX_POOL_MAX",
  boxCreateConcurrency: "BOX_CREATE_CONCURRENCY",
  slotsPerBox: "BOX_SLOTS",
  maxAgents: "BOX_MAX_AGENTS",
  localAgents: "BOXYARD_LOCAL_AGENTS",
  maxResidentPerBox: "BOX_MAX_RESIDENT",
  boxIdleDeleteMinutes: "BOX_IDLE_DELETE_MINUTES",
  workspaceRetentionDays: "BOXYARD_WORKSPACE_RETENTION_DAYS",
  archiveRetentionDays: "BOXYARD_ARCHIVE_RETENTION_DAYS",
  archiveKeepTouchedDays: "BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS",
  diskMinFreeMb: "BOXYARD_DISK_MIN_FREE_MB",
  diskCloneFactor: "BOXYARD_DISK_CLONE_FACTOR",
  memoryMaxUsedPercent: "BOXYARD_MEMORY_MAX_USED_PERCENT",
  memoryMinFreeMb: "BOXYARD_MEMORY_MIN_FREE_MB",
  loadMaxPerCpu: "BOXYARD_LOAD_MAX_PER_CPU",
  gitPartialClone: "BOXYARD_GIT_PARTIAL_CLONE",
  gitPushAtTurnEnd: "BOXYARD_GIT_PUSH_AT_TURN_END",
  buildCleanupIdleMinutes: "BOXYARD_BUILD_CLEANUP_IDLE_MINUTES",
  notesMaxCount: "BOXYARD_NOTES_MAX",
  notesMaxTokens: "BOXYARD_NOTES_MAX_TOKENS",
}

/** Every env var that can supply a setting. Saved settings still win over it (the Settings UI's "from env"). */
export const SETTING_ENV_VARS: Partial<Record<keyof Settings, string>> = {
  ownerName: "BOXYARD_OWNER_NAME",
  orchestratorModel: "ORCHESTRATOR_MODEL",
  agentModel: "WORKER_MODEL",
  captainModel: "CAPTAIN_MODEL",
  captainEffort: "CAPTAIN_EFFORT",
  ...BOX_ENV,
}

const autoCompact = z
  .object({ enabled: z.boolean(), unit: z.enum(["percent", "tokens"]), value: z.number() })
  .superRefine((v, ctx) => {
    if (v.unit === "percent" && (v.value < 10 || v.value > 95)) ctx.addIssue({ code: "custom", message: "Percent must be between 10 and 95" })
    if (v.unit === "tokens" && (v.value < AUTOCOMPACT_MIN_TOKENS || v.value > AUTOCOMPACT_MAX_TOKENS))
      ctx.addIssue({ code: "custom", message: `Tokens must be between ${AUTOCOMPACT_MIN_TOKENS} and ${AUTOCOMPACT_MAX_TOKENS}` })
  })
  .describe(`value is a percent of the context window (10–95) or a token count (${AUTOCOMPACT_MIN_TOKENS}–${AUTOCOMPACT_MAX_TOKENS})`)
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
    startInZen: z.boolean(),
    showCloudMeter: z.boolean(),
    orchestratorModel: model,
    orchestratorEffort: z.enum(EFFORTS),
    orchestratorAutoCompact: autoCompact,
    orchestratorRelay: z
      .object({ enabled: z.boolean(), model, effort: z.enum(EFFORTS) })
      .strict()
      .describe("The Coordinator's relay-only turns (task updates, no message from Cody) on this model and effort when enabled. Off by default: another model or effort starts each such turn with a cold prompt cache."),
    captainModel: model,
    captainEffort: z.enum(EFFORTS),
    agentModel: model,
    agentEffort: z.enum([...EFFORTS, "orchestrator"]),
    agentRoutingConfig: z.string().max(50_000),
    agentAutoCompact: autoCompact,
    workerSize: z.enum(WORKER_SIZES),
    autoResizeEnabled: z.boolean(),
    autoResizeMaxSize: z.enum(BOX_SIZES),
    placementResizeEnabled: z.boolean(),
    maxBoxes: z.number().int().min(1).max(100),
    boxCreateConcurrency: z.number().int().min(BOX_CREATE_CONCURRENCY.min).max(BOX_CREATE_CONCURRENCY.max),
    slotsPerBox: z.number().int().min(1).max(20),
    maxAgents: z.number().int().min(0).max(1000),
    localAgents: z.number().int().min(LOCAL_AGENTS_LIMITS.min).max(LOCAL_AGENTS_LIMITS.max),
    costRates,
    budget,
    maxResidentPerBox: z.number().int().min(1).max(200),
    boxIdleDeleteMinutes: z.number().int().min(0).max(30 * 24 * 60),
    workspaceRetentionDays: z.number().int().min(0).max(3650),
    archiveRetentionDays: z.number().int().min(0).max(3650),
    archiveKeepTouchedDays: z.number().int().min(0).max(3650),
    diskMinFreeMb: z.number().int().min(0).max(1_000_000),
    diskCloneFactor: z.number().min(1).max(20),
    memoryMaxUsedPercent: z.number().int().min(0).max(100),
    memoryMinFreeMb: z.number().int().min(0).max(1_000_000),
    loadMaxPerCpu: z.number().min(0).max(100),
    gitPartialClone: z.boolean(),
    gitPushAtTurnEnd: z.boolean(),
    buildCleanupIdleMinutes: z.number().int().min(0).max(30 * 24 * 60),
    depCacheEnabled: z.boolean(),
    depCacheMaxMb: z.number().int().min(100).max(1_000_000),
    notesRetroEnabled: z.boolean(),
    notesMaxCount: z.number().int().min(NOTE_BUDGET_LIMITS.maxNotes.min).max(NOTE_BUDGET_LIMITS.maxNotes.max),
    notesMaxTokens: z.number().int().min(NOTE_BUDGET_LIMITS.maxTokens.min).max(NOTE_BUDGET_LIMITS.maxTokens.max),
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
      | "boxCreateConcurrency"
      | "slotsPerBox"
      | "maxAgents"
      | "localAgents"
      | "maxResidentPerBox"
      | "boxIdleDeleteMinutes"
      | "workspaceRetentionDays"
      | "archiveRetentionDays"
      | "archiveKeepTouchedDays"
      | "diskMinFreeMb"
      | "diskCloneFactor"
      | "memoryMaxUsedPercent"
      | "memoryMinFreeMb"
      | "loadMaxPerCpu"
      | "gitPartialClone"
      | "gitPushAtTurnEnd"
      | "buildCleanupIdleMinutes"
      | "notesMaxCount"
      | "notesMaxTokens"
      | CredentialKey
      >
    >,
  ) {
    this.credentials = new CredentialStore(store, c)
  }

  /** Settings › Credentials: the box, Claude and GitHub keys (env wins). Kept apart from get(), which reaches the browser. */
  readonly credentials: CredentialStore

  private saved(): Partial<Settings> {
    const raw = this.store.getKv(KEY)
    if (!raw) return {}
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return {}
    }
    const parsed = settingsPatch.safeParse(json)
    if (parsed.success) return parsed.data as Partial<Settings>
    if (!json || typeof json !== "object") return {}
    // One unknown or out-of-range value (written by another build) mustn't drop the rest: a lost "Agents per
    // box" would quietly bring back each size's default (4 on a large box). Keep every value that's still valid.
    const shape = settingsPatch.shape as Record<string, z.ZodType>
    const kept: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [k, v] of Object.entries(json)) {
      const one = Object.hasOwn(shape, k) ? shape[k]!.safeParse(v) : null
      if (one?.success) kept[k] = one.data
      else dropped.push(k)
    }
    const note = dropped.sort().join(", ")
    if (note !== this.droppedNote) {
      this.droppedNote = note
      console.warn(`[box-yard] saved settings: ignoring ${note} (unknown to this build or out of range); the rest still apply`)
    }
    return kept as Partial<Settings>
  }

  private droppedNote = ""

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
      boxCreateConcurrency: within(this.c.boxCreateConcurrency ?? DEFAULT_SETTINGS.boxCreateConcurrency, BOX_CREATE_CONCURRENCY),
      slotsPerBox: slotsExplicit ? configSlots : sizeDefaults.slotsPerBox,
      maxAgents: this.c.maxAgents ?? DEFAULT_SETTINGS.maxAgents,
      localAgents: within(this.c.localAgents ?? DEFAULT_SETTINGS.localAgents, LOCAL_AGENTS_LIMITS),
      maxResidentPerBox: residentsExplicit ? configResidents : sizeDefaults.maxResidentPerBox,
      boxIdleDeleteMinutes: this.c.boxIdleDeleteMinutes ?? DEFAULT_SETTINGS.boxIdleDeleteMinutes,
      workspaceRetentionDays: this.c.workspaceRetentionDays ?? DEFAULT_SETTINGS.workspaceRetentionDays,
      archiveRetentionDays: this.c.archiveRetentionDays ?? DEFAULT_SETTINGS.archiveRetentionDays,
      archiveKeepTouchedDays: this.c.archiveKeepTouchedDays ?? DEFAULT_SETTINGS.archiveKeepTouchedDays,
      diskMinFreeMb: this.c.diskMinFreeMb ?? DEFAULT_SETTINGS.diskMinFreeMb,
      diskCloneFactor: this.c.diskCloneFactor ?? DEFAULT_SETTINGS.diskCloneFactor,
      memoryMaxUsedPercent: this.c.memoryMaxUsedPercent ?? DEFAULT_SETTINGS.memoryMaxUsedPercent,
      memoryMinFreeMb: this.c.memoryMinFreeMb ?? DEFAULT_SETTINGS.memoryMinFreeMb,
      loadMaxPerCpu: this.c.loadMaxPerCpu ?? DEFAULT_SETTINGS.loadMaxPerCpu,
      gitPartialClone: this.c.gitPartialClone ?? DEFAULT_SETTINGS.gitPartialClone,
      gitPushAtTurnEnd: this.c.gitPushAtTurnEnd ?? DEFAULT_SETTINGS.gitPushAtTurnEnd,
      buildCleanupIdleMinutes: this.c.buildCleanupIdleMinutes ?? DEFAULT_SETTINGS.buildCleanupIdleMinutes,
      // BOXYARD_NOTES_MAX / BOXYARD_NOTES_MAX_TOKENS are only a fallback: Settings › Max notes wins.
      notesMaxCount: within(this.c.notesMaxCount ?? DEFAULT_SETTINGS.notesMaxCount, NOTE_BUDGET_LIMITS.maxNotes),
      notesMaxTokens: within(this.c.notesMaxTokens ?? DEFAULT_SETTINGS.notesMaxTokens, NOTE_BUDGET_LIMITS.maxTokens),
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
   * Agents per box and task folders per box when set on purpose, and why: saved in the UI, BOX_SLOTS /
   * BOX_MAX_RESIDENT, or a config value that isn't the worker size's default. A null value means each
   * box uses its own size's default.
   */
  boxLimitInfo(): Record<BoxLimitKey, { value: number | null; source: BoxLimitSource | null }> {
    const saved = this.saved()
    const d = SIZE_DEFAULTS[this.c.workerSize ?? DEFAULT_SETTINGS.workerSize]
    const one = (k: BoxLimitKey) => {
      const fromSaved = saved[k]
      if (fromSaved !== undefined) return { value: fromSaved, source: "ui" as const }
      const configured = this.c[k] ?? d[k]
      if (process.env[BOX_ENV[k]!] !== undefined) return { value: configured, source: "env" as const }
      if (configured !== d[k]) return { value: configured, source: "config" as const }
      return { value: null, source: null }
    }
    return { slotsPerBox: one("slotsPerBox"), maxResidentPerBox: one("maxResidentPerBox") }
  }

  /** The values of boxLimitInfo(); null means each box uses its own size's default. */
  boxLimitOverrides(): Record<BoxLimitKey, number | null> {
    const info = this.boxLimitInfo()
    return { slotsPerBox: info.slotsPerBox.value, maxResidentPerBox: info.maxResidentPerBox.value }
  }

  update(patch: unknown): SettingsInfo {
    const parsed = settingsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
    this.store.setKv(KEY, JSON.stringify({ ...this.saved(), ...parsed.data }))
    return this.info()
  }

  /**
   * Once per install, for the daily cloud limit: the old defaults it replaces give way. A saved budget of $0 a day and
   * $0 a month (the old "off", which the UI saved along with any other change) becomes the $10 daily limit, and a saved
   * Max boxes under the new ceiling (it was the pool's cap) becomes the ceiling. Returns what changed, for a notice.
   */
  upgradeForCloudLimit(): string[] {
    if (this.store.getKv(CLOUD_LIMIT_UPGRADE_KEY)) return []
    this.store.setKv(CLOUD_LIMIT_UPGRADE_KEY, String(Date.now()))
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(this.store.getKv(KEY) ?? "{}")
    } catch {
      return []
    }
    if (!raw || typeof raw !== "object") return []
    const changed: string[] = []
    const budget = raw.budget as Partial<BudgetSettings> | undefined
    if (budget && !budget.dailyUsd && !budget.monthlyUsd) {
      delete raw.budget
      changed.push(`Daily cloud limit: $${DEFAULT_SETTINGS.budget.dailyUsd} (it was off)`)
    }
    if (typeof raw.maxBoxes === "number" && raw.maxBoxes < DEFAULT_SETTINGS.maxBoxes) {
      changed.push(`Box ceiling: ${this.c.maxBoxes ?? DEFAULT_SETTINGS.maxBoxes} (Max boxes was ${raw.maxBoxes}; it's a safety stop under Advanced now)`)
      delete raw.maxBoxes
    }
    if (!changed.length) return []
    this.store.setKv(KEY, JSON.stringify(raw))
    return changed
  }

  /** Forget saved values (all, or the named ones) so env vars and defaults apply again. */
  reset(keys?: (keyof Settings)[]): SettingsInfo {
    const saved = this.saved()
    if (keys) for (const k of keys) delete saved[k]
    this.store.setKv(KEY, keys ? JSON.stringify(saved) : null)
    return this.info()
  }
}

/** A project's notes budget: its own override where it sets one, else Settings › Max notes and the token budget. */
export const noteBudgetOf = (s: Pick<Settings, "notesMaxCount" | "notesMaxTokens">, project?: Pick<Project, "notesMaxCount" | "notesMaxTokens"> | null): NoteBudget =>
  projectNoteBudget(s, project)

/** An env var's number, kept inside the range Settings accepts. */
const within = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, Math.round(n)))

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
    const raw = this.json<Record<string, unknown>>(TTS_KEY)
    // Choices saved for OpenAI's retired speech models (tts-1, gpt-4o-mini-tts, fable/nova/onyx,
    // speeds over 1.5×) move to their Realtime equivalents, once, so the rest still parses.
    if (raw.openai && typeof raw.openai === "object") {
      const migrated = migrateOpenAiTts(raw.openai as Partial<OpenAiTts>)
      if (JSON.stringify(migrated) !== JSON.stringify(raw.openai)) {
        raw.openai = migrated
        this.store.setKv(TTS_KEY, JSON.stringify(raw))
      }
    }
    const parsed = ttsPatch.safeParse(raw)
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
        ...(prefs.openai ? { openai: { ...saved.openai, ...migrateOpenAiTts(prefs.openai) } } : {}),
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
