// The Coordinator's get_settings / update_settings tools: every setting the Settings dialog shows, read and changed
// through the same stores, zod schemas and save paths as the Settings UI (server/app.ts passes those in as `save`).
// Secrets (API keys, tokens) are only ever "set" / "not set", and neither tool writes one.
import { z } from "zod"
import { DEFAULT_SETTINGS, SETTING_ENV_VARS, settingsPatch, ttsPatch, type SettingsStore, type TtsSettingsStore } from "./settings.js"
import { runpodSettingsPatch, type RunPodSettingsStore } from "./runpod/settings.js"
import { DEFAULT_RUNPOD_SETTINGS, type RunPodSettings } from "../shared/runpod.js"
import { SETUP_RUNNERS, type Runner } from "../shared/runner.js"
import { CREDENTIAL_INFO, CREDENTIAL_KEYS, type CredentialKey, type CredentialStatus } from "../shared/setup.js"
import { TTS_DEFAULTS, TTS_KEY_ENV, type CloudProvider } from "../shared/tts.js"
import type { Settings } from "../shared/types.js"

export const SETTINGS_GROUPS = ["settings", "runpod", "voice", "runner", "credentials", "server"] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** A server value only an env var sets (Settings › About); changing it means editing .env and restarting. */
export interface ServerSetting {
  value: unknown
  envVar: string
  note?: string
}

/** The Settings UI's own save paths, side effects included (broadcast, pool re-read, notes budgets…). */
export interface SettingsSavers {
  settings(patch: Partial<Settings>): unknown
  runpod(patch: Partial<RunPodSettings>): unknown
  voice(patch: z.infer<typeof ttsPatch>): unknown
  runner(runner: Runner): unknown
}

export interface SettingsToolDeps {
  settings: SettingsStore
  tts: TtsSettingsStore
  runpod: RunPodSettingsStore
  /** The setup choice of where new projects run, or null before one was made. */
  runner: () => Runner | null
  credentials: () => Record<CredentialKey, CredentialStatus>
  server: () => Record<string, ServerSetting>
  save: SettingsSavers
}

/** One row of get_settings. */
export interface SettingView {
  key: string
  group: SettingsGroup
  value: unknown
  default?: unknown
  allowed?: string
  /** ui: saved in Settings; env: from the env var (saving here overrides it, like the UI); default. */
  source?: string
  envVar?: string
  /** An env var sets it and nothing here can change it. */
  envLocked?: true
  /** An API key or token: the value is only "set" / "not set". */
  secret?: true
  writable: boolean
}

export interface SettingChange {
  key: string
  before: unknown
  after: unknown
}

/** Key names that look like a secret: refused as one even when they name no setting. */
const SECRET_NAME = /api.?key|token|password|secret|credential/i

/** A writable setting: where it lives, its schema, its current and default value. */
interface Entry {
  key: string
  group: Exclude<SettingsGroup, "credentials" | "server">
  schema: z.ZodType
  value: unknown
  default: unknown
  source?: string
  envVar?: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A zod schema in a few words, for get_settings' `allowed`: "integer 1–100", "one of: small, medium, large". */
export function describeSchema(schema: z.ZodType): string {
  const s = schema as z.ZodType & Record<string, any>
  const type = s.def.type as string
  let out: string
  if (type === "nullable" || type === "optional") out = `${describeSchema(s.unwrap())}${type === "nullable" ? ", or null" : ""}`
  else if (type === "boolean") out = "true or false"
  else if (type === "enum") out = `one of: ${(s.options as string[]).join(", ")}`
  else if (type === "number") {
    const kind = s.isInt ? "integer" : "number"
    const lo = Number.isFinite(s.minValue) ? s.minValue : null
    const hi = Number.isFinite(s.maxValue) ? s.maxValue : null
    out = lo !== null && hi !== null ? `${kind} ${lo}–${hi}` : lo !== null ? `${kind} ≥ ${lo}` : hi !== null ? `${kind} ≤ ${hi}` : kind
  } else if (type === "string") {
    const pattern = (s.def.checks ?? []).map((c: any) => c._zod?.def).find((d: any) => d?.format === "regex")?.pattern as RegExp | undefined
    out = `text${s.minLength ? ` of ${s.minLength}–${s.maxLength ?? "∞"} chars` : s.maxLength ? ` up to ${s.maxLength} chars` : ""}${pattern ? ` matching ${pattern}` : ""}`
  } else if (type === "array") {
    const checks = (s.def.checks ?? []).map((c: any) => c._zod?.def)
    const min = checks.find((d: any) => d?.check === "min_length")?.minimum
    const max = checks.find((d: any) => d?.check === "max_length")?.maximum
    out = `list${min !== undefined || max !== undefined ? ` of ${min ?? 0}–${max ?? "∞"}` : ""} of ${describeSchema(s.element)}`
  } else if (type === "object") {
    out = `{ ${Object.entries(s.shape as Record<string, z.ZodType>)
      .map(([k, v]) => `${k}: ${describeSchema(v)}`)
      .join("; ")} }`
  } else out = type
  return s.description ? `${out} (${s.description})` : out
}

/** Every leaf of a value by dotted path; arrays and scalars are leaves. */
function leaves(prefix: string, v: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isPlainObject(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(`${prefix}.${k}`, x, out)
  else out[prefix] = v
  return out
}

/** `patch` merged over `base`, object by object, so a partial value keeps the fields it leaves out. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v)
  return out
}

/** `obj` with `value` at `path`, without touching `obj`. */
function setIn(obj: unknown, path: string[], value: unknown): unknown {
  if (!path.length) return value
  const base = isPlainObject(obj) ? obj : {}
  return { ...base, [path[0]!]: setIn(base[path[0]!], path.slice(1), value) }
}

export class SettingsTools {
  constructor(private readonly d: SettingsToolDeps) {}

  /** Every writable setting with its current value, by key ("maxBoxes", "runpod.maxHourlyUsd", "voice.openai.speed", "runner"). */
  private entries(): Map<string, Entry> {
    const out = new Map<string, Entry>()
    const info = this.d.settings.info()
    const shape = settingsPatch.shape as Record<string, z.ZodType>
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      out.set(k, { key: k, group: "settings", schema: shape[k]!, value: info.settings[k], default: info.defaults[k], source: info.sources[k], envVar: SETTING_ENV_VARS[k] })
    }
    const rp = this.d.runpod.get()
    for (const k of Object.keys(DEFAULT_RUNPOD_SETTINGS) as (keyof RunPodSettings)[]) {
      const value = rp[k]
      const def = DEFAULT_RUNPOD_SETTINGS[k]
      out.set(`runpod.${k}`, { key: `runpod.${k}`, group: "runpod", schema: runpodSettingsPatch.shape[k], value, default: def, source: same(value, def) ? "default" : "ui" })
    }
    const tts = this.d.tts.info()
    out.set("voice.provider", { key: "voice.provider", group: "voice", schema: ttsPatch.shape.provider, value: tts.settings.provider, default: TTS_DEFAULTS.provider, source: tts.sources.provider, envVar: "TTS_PROVIDER" })
    for (const p of ["elevenlabs", "openai"] as const) {
      const fields = ttsPatch.shape[p].unwrap().shape as Record<string, z.ZodType>
      for (const [k, schema] of Object.entries(fields)) {
        const key = `voice.${p}.${k}`
        out.set(key, { key, group: "voice", schema, value: (tts.settings[p] as unknown as Record<string, unknown>)[k], default: (TTS_DEFAULTS[p] as unknown as Record<string, unknown>)[k], source: tts.sources[p] })
      }
    }
    const runner = this.d.runner()
    out.set("runner", { key: "runner", group: "runner", schema: z.enum(SETUP_RUNNERS), value: runner ?? "box", default: "box", source: runner ? "ui" : "default" })
    return out
  }

  /** The secret and env-only rows: shown, never written. */
  private readOnly(): SettingView[] {
    const rows: SettingView[] = []
    const creds = this.d.credentials()
    for (const k of CREDENTIAL_KEYS) {
      const st = creds[k]
      rows.push({ key: `credentials.${k}`, group: "credentials", value: st.state === "set" ? "set" : "not set", source: st.source ?? undefined, envVar: CREDENTIAL_INFO[k].env, secret: true, writable: false })
    }
    const keys = this.d.tts.info().keys
    for (const p of Object.keys(keys) as CloudProvider[]) {
      rows.push({ key: `voice.${p}ApiKey`, group: "voice", value: keys[p].state === "set" ? "set" : "not set", source: keys[p].source, envVar: TTS_KEY_ENV[p], secret: true, writable: false })
    }
    for (const [k, s] of Object.entries(this.d.server())) {
      rows.push({ key: `server.${k}`, group: "server", value: s.value, source: "env", envVar: s.envVar, envLocked: true, writable: false, ...(s.note ? { allowed: s.note } : {}) })
    }
    return rows
  }

  /** get_settings: every setting with its value, default, allowed values and where it comes from. */
  list(group?: SettingsGroup): SettingView[] {
    const rows: SettingView[] = [...this.entries().values()].map((e) => ({
      key: e.key,
      group: e.group,
      value: e.value,
      default: e.default,
      allowed: describeSchema(e.schema),
      source: e.source,
      envVar: e.envVar,
      writable: true,
    }))
    rows.push(...this.readOnly())
    return group ? rows.filter((r) => r.group === group) : rows
  }

  /** Current values of every row, by leaf path, for before → after. */
  private snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.list()) leaves(r.key, r.value, out)
    return out
  }

  /**
   * Check a whole patch, then apply all of it or none of it. Keys are the ones get_settings lists; an object setting
   * takes a partial value ({ budget: { dailyUsd: 5 } } or "budget.dailyUsd": 5) merged over its current one, and
   * groups may be nested ({ runpod: { maxHourlyUsd: 2 } }). Returns every value that changed, derived ones included
   * (a new workerSize moves the size-default box limits).
   */
  async update(patch: Record<string, unknown>): Promise<SettingChange[]> {
    if (!isPlainObject(patch) || !Object.keys(patch).length) throw new Error("The patch is empty: pass at least one setting, e.g. { \"maxBoxes\": 10 }.")
    const entries = this.entries()
    const locked = new Map(this.readOnly().map((r) => [r.key, r]))
    const errors: string[] = []
    const next = new Map<string, unknown>()
    const assign = (raw: string, value: unknown) => {
      const key = raw.replace(/^settings\./, "")
      const ro = locked.get(key)
      if (ro?.secret || (!entries.has(key) && SECRET_NAME.test(key))) {
        errors.push(`${key}: API keys, tokens and passwords can't be read or written with these tools. Cody sets them in Settings › Credentials (or Voice) or with ${ro?.envVar ?? "an env var"}.`)
        return
      }
      if (ro?.envLocked) {
        errors.push(`${key}: set by the ${ro.envVar} env var on the server, so it can't be changed here. Cody edits .env and restarts Box Yard.`)
        return
      }
      const exact = entries.get(key)
      if (exact) {
        next.set(key, value)
        return
      }
      // A field of an object setting: "budget.dailyUsd", "costRates.boxActiveCpuHourlyUsd.small".
      const parent = [...entries.values()].find((e) => isPlainObject(e.value) && key.startsWith(`${e.key}.`))
      if (parent) {
        next.set(parent.key, setIn(next.has(parent.key) ? next.get(parent.key) : parent.value, key.slice(parent.key.length + 1).split("."), value))
        return
      }
      if (isPlainObject(value) && Object.keys(value).length) {
        for (const [k, v] of Object.entries(value)) assign(`${key}.${k}`, v)
        return
      }
      errors.push(`${key}: unknown setting. get_settings lists every key.`)
    }
    for (const [k, v] of Object.entries(patch)) assign(k, v)

    // A partial object (e.g. { budget: { dailyUsd: 5 } }) keeps the fields it leaves out.
    const groups = { settings: {} as Record<string, unknown>, runpod: {} as Record<string, unknown>, voice: {} as Record<string, Record<string, unknown>>, runner: null as Runner | null }
    for (const [key, raw] of next) {
      const e = entries.get(key)!
      const value = deepMerge(e.value, raw)
      const parsed = e.schema.safeParse(value)
      if (!parsed.success) {
        errors.push(`${key}: ${parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")} ` : ""}${i.message}`).join("; ")} (allowed: ${describeSchema(e.schema)})`)
        continue
      }
      if (same(parsed.data, e.value)) continue
      if (e.group === "settings") groups.settings[key] = parsed.data
      else if (e.group === "runpod") groups.runpod[key.slice("runpod.".length)] = parsed.data
      else if (e.group === "voice") {
        const [, sub, field] = key.split(".")
        if (field) (groups.voice[sub!] ??= {})[field] = parsed.data
        else (groups.voice as Record<string, unknown>)[sub!] = parsed.data
      } else groups.runner = parsed.data as Runner
    }
    // The whole group through the same schemas the Settings UI's saves use, so nothing passes here that fails there.
    if (!errors.length) {
      for (const [name, schema, value] of [
        ["settings", settingsPatch, groups.settings],
        ["runpod", runpodSettingsPatch, groups.runpod],
        ["voice", ttsPatch, groups.voice],
      ] as const) {
        const parsed = (schema as z.ZodType).safeParse(value)
        if (!parsed.success) errors.push(`${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
      }
    }
    if (errors.length) throw new Error(`Nothing was changed. ${errors.length === 1 ? "Problem" : `${errors.length} problems`}:\n- ${errors.join("\n- ")}`)

    const before = this.snapshot()
    if (Object.keys(groups.settings).length) this.d.save.settings(groups.settings as Partial<Settings>)
    if (Object.keys(groups.runpod).length) await this.d.save.runpod(groups.runpod as Partial<RunPodSettings>)
    if (Object.keys(groups.voice).length) this.d.save.voice(groups.voice as z.infer<typeof ttsPatch>)
    if (groups.runner) await this.d.save.runner(groups.runner)
    const after = this.snapshot()
    return Object.keys(after)
      .filter((k) => !same(before[k], after[k]))
      .map((k) => ({ key: k, before: before[k], after: after[k] }))
  }
}

const shown = (v: unknown) => {
  const text = typeof v === "string" ? (v === "" ? '""' : v) : JSON.stringify(v)
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** "maxBoxes 5 → 20, runpod.maxHourlyUsd 1 → 2" for the notice and the log. */
export const changeLine = (changes: SettingChange[]) => changes.map((c) => `${c.key} ${shown(c.before)} → ${shown(c.after)}`).join(", ")
