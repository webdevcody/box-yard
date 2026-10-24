// Pure helpers for the settings dialog: its categories, the `?settings=` deep link, and unsaved-change tracking.
import type { Settings } from "../../../shared/types"

export type SettingsSection = "orchestrator" | "agents" | "hooks" | "limits" | "costs" | "notifications" | "voice" | "about"

export interface SectionInfo {
  key: SettingsSection
  label: string
  description: string
  /** The settings edited in this section; drives the unsaved-changes dot in the nav. */
  fields: (keyof Settings)[]
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  {
    key: "orchestrator",
    label: "Coordinator",
    description: "The model behind the chat that runs the yard, the per-project Captains, and when they compact their context.",
    fields: ["orchestratorModel", "orchestratorEffort", "orchestratorAutoCompact", "captainModel", "captainEffort"],
  },
  {
    key: "agents",
    label: "Box agents",
    description: "Defaults for the Claude Code agents that work on tasks inside boxes.",
    fields: ["ownerName", "agentModel", "agentEffort", "agentRoutingConfig", "agentAutoCompact"],
  },
  {
    key: "hooks",
    label: "Hooks",
    description:
      "Global hooks: automations the Coordinator runs on every project's task events, like asking an agent to merge its PR once it's ready. Project hooks live on each project's Hooks tab. Changes here save right away.",
    fields: [],
  },
  {
    key: "limits",
    label: "Boxes & limits",
    description: "Worker box size, capacity, disk headroom and cleanup retention.",
    fields: [
      "workerSize",
      "maxBoxes",
      "slotsPerBox",
      "maxAgents",
      "maxResidentPerBox",
      "boxIdleDeleteMinutes",
      "workspaceRetentionDays",
      "archiveRetentionDays",
      "archiveKeepTouchedDays",
      "diskMinFreeMb",
      "diskCloneFactor",
    ],
  },
  {
    key: "costs",
    label: "Usage & costs",
    description: "Upstash Box rates and optional spending budgets.",
    fields: ["costRates", "budget"],
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "How this browser tells you a task finished or needs you. Saved in this browser only.",
    fields: [],
  },
  {
    key: "voice",
    label: "Voice",
    description: "Spoken updates when work finishes, and push-to-talk dictation in message boxes, using this browser's speech features. Saved in this browser only.",
    fields: [],
  },
  { key: "about", label: "About", description: "What this Box Yard is running on.", fields: [] },
]

/** The URL query param that opens the dialog, e.g. `?settings=limits`. */
export const SETTINGS_PARAM = "settings"
export const DEFAULT_SECTION: SettingsSection = "orchestrator"

const ALIASES: Record<string, SettingsSection> = { hook: "hooks", automations: "hooks", boxes: "limits", agent: "agents", workers: "agents", cost: "costs", usage: "costs", budget: "costs", speech: "voice", tts: "voice" }

/** The section a `?settings=` value points at; unknown or empty values fall back to the first one. */
export function parseSection(value: string | null | undefined): SettingsSection {
  const v = (value ?? "").trim().toLowerCase()
  if (SETTINGS_SECTIONS.some((s) => s.key === v)) return v as SettingsSection
  return ALIASES[v] ?? DEFAULT_SECTION
}

/** The section `delta` steps away from `current`, wrapping around (↑/↓ in the nav). */
export function stepSection(current: SettingsSection, delta: number): SettingsSection {
  const i = SETTINGS_SECTIONS.findIndex((s) => s.key === current)
  const n = SETTINGS_SECTIONS.length
  return SETTINGS_SECTIONS[(((i + delta) % n) + n) % n]!.key
}

/** Env vars that can supply a setting, shown next to "from env". */
export const SETTING_ENV: Partial<Record<keyof Settings, string>> = {
  ownerName: "BOXYARD_OWNER_NAME",
  orchestratorModel: "ORCHESTRATOR_MODEL",
  captainModel: "CAPTAIN_MODEL",
  captainEffort: "CAPTAIN_EFFORT",
  agentModel: "WORKER_MODEL",
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

/** Settings whose draft value differs from the one in effect. */
export function changedKeys(draft: Settings | null | undefined, current: Settings | null | undefined): (keyof Settings)[] {
  if (!draft || !current) return []
  return (Object.keys(draft) as (keyof Settings)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(current[k]))
}

/** Sections holding at least one of `keys`. */
export function changedSections(keys: (keyof Settings)[]): Set<SettingsSection> {
  return new Set(SETTINGS_SECTIONS.filter((s) => s.fields.some((f) => keys.includes(f))).map((s) => s.key))
}

const POOL_KEYS = [
  "workerSize",
  "maxBoxes",
  "slotsPerBox",
  "maxAgents",
  "maxResidentPerBox",
  "boxIdleDeleteMinutes",
  "workspaceRetentionDays",
  "archiveRetentionDays",
  "archiveKeepTouchedDays",
  "diskMinFreeMb",
  "diskCloneFactor",
] as const

/** What Save sends. Pool limits go only when edited, so an untouched form doesn't pin them over env changes. */
export function savePatch(draft: Settings, current: Settings | null | undefined): Partial<Settings> {
  const patch: Partial<Settings> = { ...draft }
  for (const k of POOL_KEYS) if (current && draft[k] === current[k]) delete patch[k]
  return patch
}
