// The Claude models and effort levels every model/effort picker offers (Settings › Coordinator and Box agents, the
// New task dialog), and which effort levels each model takes. The server asks the installed claude CLI for its own
// list (server/claudeModels.ts) and merges it over this one with `mergeCliModels`; this table is the fallback, read
// from Claude Code 2.1.293's model registry and https://code.claude.com/docs/en/model-config.
import { EFFORTS, type Effort } from "./types.js"

export type ModelGroup = "latest" | "alias" | "older"

export interface ClaudeModel {
  /** What `claude --model` gets. */
  id: string
  label: string
  group: ModelGroup
  /** The effort levels it takes. Empty: it takes none, and the CLI sends no effort at all. */
  efforts: readonly Effort[]
  /** One line for the picker: what an alias runs on, long context, retirement. */
  note?: string
}

/** Where the picker's list came from: the installed CLI, or the table below when the CLI couldn't be asked. */
export interface ModelCatalog {
  models: ClaudeModel[]
  source: "cli" | "builtin"
  cliVersion: string | null
  fetchedAt: number | null
  /** Why the CLI couldn't be asked, when source is builtin. */
  error?: string
}

export const MODEL_GROUP_LABEL: Record<ModelGroup, string> = { latest: "Latest", alias: "Aliases", older: "Older" }
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }

const ALL = EFFORTS
const NO_XHIGH: readonly Effort[] = ["low", "medium", "high", "max"]
const NONE: readonly Effort[] = []

export const BUILTIN_MODELS: readonly ClaudeModel[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", group: "latest", efforts: ALL, note: "Most capable, for the hardest and longest tasks" },
  { id: "claude-opus-5-5", label: "Opus 5.5", group: "latest", efforts: ALL, note: "Complex, everyday work" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", group: "latest", efforts: ALL, note: "Efficient for routine tasks" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", group: "latest", efforts: ALL, note: "Fastest, for quick answers" },

  { id: "opus", label: "opus", group: "alias", efforts: ALL, note: "The latest Opus" },
  { id: "sonnet", label: "sonnet", group: "alias", efforts: ALL, note: "The latest Sonnet" },
  { id: "haiku", label: "haiku", group: "alias", efforts: ALL, note: "The latest Haiku" },
  { id: "fable", label: "fable", group: "alias", efforts: ALL, note: "The latest Fable" },
  { id: "best", label: "best", group: "alias", efforts: ALL, note: "Fable where your account has it, else Opus" },
  { id: "opusplan", label: "opusplan", group: "alias", efforts: ALL, note: "Opus while planning, Sonnet to carry it out" },
  { id: "opus[1m]", label: "opus[1m]", group: "alias", efforts: ALL, note: "Opus with a 1M-token window (native from Opus 4.7)" },
  { id: "sonnet[1m]", label: "sonnet[1m]", group: "alias", efforts: ALL, note: "Sonnet with a 1M-token window (native from Sonnet 5)" },
  { id: "fable[1m]", label: "fable[1m]", group: "alias", efforts: ALL, note: "Fable with a 1M-token window (native)" },
  { id: "opusplan[1m]", label: "opusplan[1m]", group: "alias", efforts: ALL, note: "opusplan with 1M-token windows" },

  { id: "claude-fable-5", label: "Fable 5", group: "older", efforts: ALL },
  { id: "claude-opus-5", label: "Opus 5", group: "older", efforts: ALL },
  { id: "claude-sonnet-5", label: "Sonnet 5", group: "older", efforts: ALL },
  { id: "claude-opus-4-8", label: "Opus 4.8", group: "older", efforts: ALL },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "older", efforts: ALL },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "older", efforts: NO_XHIGH },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 [1m]", group: "older", efforts: NO_XHIGH, note: "Opus 4.6 with a 1M-token window" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", group: "older", efforts: NO_XHIGH },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 [1m]", group: "older", efforts: NO_XHIGH, note: "Sonnet 4.6 with a 1M-token window" },
  { id: "claude-opus-4-5", label: "Opus 4.5", group: "older", efforts: NONE },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", group: "older", efforts: NONE },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", group: "older", efforts: NONE },
  { id: "claude-opus-4-1", label: "Opus 4.1", group: "older", efforts: NONE },
  { id: "claude-opus-4-0", label: "Opus 4", group: "older", efforts: NONE },
  { id: "claude-sonnet-4-0", label: "Sonnet 4", group: "older", efforts: NONE },
  { id: "claude-3-7-sonnet", label: "Sonnet 3.7", group: "older", efforts: NONE, note: "May be retired on your account" },
  { id: "claude-3-5-sonnet", label: "Sonnet 3.5", group: "older", efforts: NONE, note: "May be retired on your account" },
  { id: "claude-3-5-haiku", label: "Haiku 3.5", group: "older", efforts: NONE, note: "May be retired on your account" },
]

/** A model's row, by exact id, else without a date suffix ("claude-sonnet-4-5-20250929" is Sonnet 4.5). */
export function findModel(models: readonly ClaudeModel[], id: string): ClaudeModel | undefined {
  const v = id.trim()
  return models.find((m) => m.id === v) ?? models.find((m) => m.id === v.replace(/-\d{8}(?=$|\[)/, ""))
}

export type EffortCheck = { ok: true } | { ok: false; runsAs: Effort | null; message: string }

/**
 * Whether `model` takes `effort`, and what the CLI runs instead when it doesn't: the highest level it takes at or
 * below the one picked ("xhigh runs as high on Opus 4.6"), or no effort at all for a model that takes none. A model
 * id the list doesn't know is ok: only the CLI can tell.
 */
export function checkEffort(models: readonly ClaudeModel[], model: string, effort: string): EffortCheck {
  const m = findModel(models, model)
  const at = EFFORTS.indexOf(effort as Effort)
  if (!m || at < 0 || m.efforts.includes(effort as Effort)) return { ok: true }
  if (!m.efforts.length) return { ok: false, runsAs: null, message: `${m.label} takes no effort level, so the CLI sends none.` }
  const runsAs = [...EFFORTS.slice(0, at)].reverse().find((e) => m.efforts.includes(e)) ?? m.efforts[0]!
  return { ok: false, runsAs, message: `${m.label} has no ${EFFORT_LABEL[effort as Effort]} effort, so the CLI runs it at ${EFFORT_LABEL[runsAs]}.` }
}

/** One model row from the CLI's `initialize` control response (the Agent SDK's `ModelInfo`). */
export interface CliModelInfo {
  value: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

const cliEfforts = (r: CliModelInfo): Effort[] => (r.supportsEffort ? EFFORTS.filter((e) => (r.supportedEffortLevels ?? EFFORTS).includes(e)) : [])
const labelOf = (id: string) =>
  id
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1")
    .replace(/^\w/, (c) => c.toUpperCase())

/**
 * The built-in list with what the installed CLI says on top: the effort levels it reports for each alias and the
 * model the alias runs on now ("opus · Opus 5.5"), plus any model it names that the list doesn't have yet (a new
 * release shows up without a Box Yard update). "default" is left out: Box Yard always passes a model.
 */
export function mergeCliModels(builtin: readonly ClaudeModel[], rows: readonly CliModelInfo[]): ClaudeModel[] {
  const out = builtin.map((m) => ({ ...m }))
  const add = (m: ClaudeModel) => {
    const at = m.group === "latest" ? out.findIndex((x) => x.group !== "latest") : -1
    out.splice(at < 0 ? out.length : at, 0, m)
  }
  for (const r of rows) {
    if (typeof r?.value !== "string" || !r.value || r.value === "default") continue
    const efforts = cliEfforts(r)
    const resolved = typeof r.resolvedModel === "string" && r.resolvedModel !== r.value ? r.resolvedModel : null
    const target = resolved ? findModel(out, resolved) : null
    const runsOn = target?.label ?? (resolved ? labelOf(resolved) : null)
    const known = findModel(out, r.value)
    if (known) {
      known.efforts = efforts
      if (runsOn && known.group === "alias") known.note = !known.note || known.note.startsWith("The latest") ? `${runsOn} now` : `${known.note} (${runsOn} now)`
    } else {
      const isId = r.value.startsWith("claude-")
      add({ id: r.value, label: isId ? labelOf(r.value) : r.value, group: isId ? "latest" : "alias", efforts, note: runsOn ? `${runsOn} now` : undefined })
    }
    if (resolved && !target) add({ id: resolved, label: labelOf(resolved), group: "latest", efforts })
  }
  return out
}
