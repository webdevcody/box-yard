// Pure helpers for the settings dialog: its categories, the `?settings=` deep link, and unsaved-change tracking.
import type { Settings } from "../../../shared/types"

export type SettingsSection = "orchestrator" | "agents" | "credentials" | "identities" | "runpod" | "docker" | "hooks" | "limits" | "costs" | "notifications" | "voice" | "about"

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
    description: "The agent and model behind the chat that runs the yard, the per-project Captains and the project notes they curate, and when they compact their context.",
    fields: [
      "startInZen",
      "orchestratorCli",
      "orchestratorModel",
      "orchestratorCodexModel",
      "orchestratorEffort",
      "orchestratorAutoCompact",
      "orchestratorRelay",
      "captainCli",
      "captainModel",
      "captainCodexModel",
      "captainEffort",
      "notesRetroEnabled",
      "notesMaxCount",
      "notesMaxTokens",
    ],
  },
  {
    key: "agents",
    label: "Box agents",
    description: "Defaults for the agents (Claude Code or Codex) that work on tasks inside boxes.",
    fields: ["ownerName", "agentCli", "agentModel", "agentCodexModel", "agentEffort", "agentRoutingConfig", "agentAutoCompact"],
  },
  {
    key: "credentials",
    label: "Credentials",
    description:
      "Where agents run, and the keys Box Yard works with: Upstash boxes, Claude, Codex and GitHub. They're kept on this server and never sent back to the browser. An env var on the server always wins. Saved changes apply from the next turn, no restart needed.",
    fields: [],
  },
  {
    key: "identities",
    label: "Identities",
    description:
      "Who each project acts as on GitHub: the account its token belongs to, the git author its commits get and the key that signs them, and optionally its own Claude login. Default is Settings › Credentials. Tokens and keys go in and never come back: only fingerprints show.",
    fields: [],
  },
  {
    key: "runpod",
    label: "RunPod GPU",
    description:
      "GPU machines for projects that need one (a WebGL game, ML work): a project whose Runs on is RunPod GPU gets a pod of its own that starts when a task needs it and stops when idle.",
    fields: [],
  },
  {
    key: "docker",
    label: "Docker",
    description:
      "Isolated containers on this computer for projects whose Runs on is Docker container: one per project, from an image built here, with its own CPU and memory limits. It stops when idle and keeps its workspaces in a volume.",
    fields: [],
  },
  {
    key: "hooks",
    label: "Hooks",
    description:
      "Global hooks: automations the Coordinator runs on every project's task events, like asking an agent to merge its PR once it's ready. Project hooks live on each project's Hooks tab. Switching a hook on or off waits for Save; New hook and Edit open their own form.",
    fields: [],
  },
  {
    key: "limits",
    label: "Boxes & limits",
    description:
      "Worker box size and resizing, capacity, tasks running at once on this computer, disk and memory headroom, cleanup retention, the dependency cache, repo mirrors and pushing work to git.",
    fields: [
      "workerSize",
      "autoResizeEnabled",
      "autoResizeMaxSize",
      "placementResizeEnabled",
      "maxBoxes",
      "boxCreateConcurrency",
      "slotsPerBox",
      "maxAgents",
      "localAgents",
      "maxResidentPerBox",
      "boxIdleDeleteMinutes",
      "workspaceRetentionDays",
      "archiveRetentionDays",
      "archiveKeepTouchedDays",
      "diskMinFreeMb",
      "diskCloneFactor",
      "memoryMaxUsedPercent",
      "memoryMinFreeMb",
      "loadMaxPerCpu",
      "buildCleanupIdleMinutes",
      "depCacheEnabled",
      "depCacheMaxMb",
      "gitPartialClone",
      "gitPushAtTurnEnd",
    ],
  },
  {
    key: "costs",
    label: "Usage",
    description: "What boxes may cost per day and per month, whether the Coordinator's header shows that spend, and the Upstash Box rates their cost is worked out with.",
    fields: ["showCloudMeter", "costRates", "budget"],
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "How this browser tells you a task finished or needs you, and the sound a send makes. Saved in this browser only.",
    fields: [],
  },
  {
    key: "voice",
    label: "Voice",
    description:
      "Spoken updates when work finishes, in the browser's own voice or an ElevenLabs or OpenAI one, and push-to-talk dictation in message boxes. Most of it is saved in this browser only.",
    fields: [],
  },
  { key: "about", label: "About", description: "What this Box Yard is running on.", fields: [] },
]

/** The URL query param that opens the dialog, e.g. `?settings=limits`. */
export const SETTINGS_PARAM = "settings"
export const DEFAULT_SECTION: SettingsSection = "orchestrator"

const ALIASES: Record<string, SettingsSection> = { identity: "identities", accounts: "identities", signing: "identities", keys: "credentials", credential: "credentials", setup: "credentials", tokens: "credentials", hook: "hooks", automations: "hooks", boxes: "limits", agent: "agents", workers: "agents", cost: "costs", usage: "costs", budget: "costs", spend: "costs", meter: "costs", speech: "voice", tts: "voice", gpu: "runpod", gpus: "runpod", container: "docker", containers: "docker" }

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
  buildCleanupIdleMinutes: "BOXYARD_BUILD_CLEANUP_IDLE_MINUTES",
  gitPartialClone: "BOXYARD_GIT_PARTIAL_CLONE",
  gitPushAtTurnEnd: "BOXYARD_GIT_PUSH_AT_TURN_END",
  notesMaxCount: "BOXYARD_NOTES_MAX",
  notesMaxTokens: "BOXYARD_NOTES_MAX_TOKENS",
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
  "autoResizeEnabled",
  "autoResizeMaxSize",
  "placementResizeEnabled",
  "maxBoxes",
  "boxCreateConcurrency",
  "slotsPerBox",
  "maxAgents",
  "localAgents",
  "maxResidentPerBox",
  "boxIdleDeleteMinutes",
  "workspaceRetentionDays",
  "archiveRetentionDays",
  "archiveKeepTouchedDays",
  "diskMinFreeMb",
  "diskCloneFactor",
  "memoryMaxUsedPercent",
  "memoryMinFreeMb",
  "loadMaxPerCpu",
  "buildCleanupIdleMinutes",
  "gitPartialClone",
  "gitPushAtTurnEnd",
] as const

/**
 * What Save sends. Pool limits (and the resize guardrails) go only when edited, so an untouched form doesn't pin them
 * over env changes. `keep` names fields typed in on purpose even if the value matches what's in effect (a box limit
 * typed over the size default).
 */
export function savePatch(draft: Settings, current: Settings | null | undefined, keep: readonly (keyof Settings)[] = []): Partial<Settings> {
  const patch: Partial<Settings> = { ...draft }
  for (const k of POOL_KEYS) if (current && draft[k] === current[k] && !keep.includes(k)) delete patch[k]
  return patch
}
