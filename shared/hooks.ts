// Hooks: automations the Coordinator (global hooks) or a project's Captain (project hooks) set up to run
// when a task event happens, e.g. "when a PR is ready, ask its agent to merge it". The server and the
// web app share these rules: what each trigger and action means, how a prompt template is rendered,
// and which events a hook's filters let through. The engine is server/hooks.ts.
import type { PrState, TaskStatus } from "./types.js"

export const HOOK_TRIGGERS = ["task.finished", "task.pr_ready", "task.failed", "task.needs_input", "pr.merged", "schedule.run_finished"] as const
export type HookTrigger = (typeof HOOK_TRIGGERS)[number]

export const TRIGGER_INFO: Record<HookTrigger, { label: string; description: string }> = {
  "task.finished": { label: "Task finished", description: "A turn ended and the agent is resting: idle, PR ready, or done (mark_done)." },
  "task.pr_ready": { label: "PR ready", description: "The agent opened or pushed to a pull request and its turn ended. Fires once per head commit." },
  "task.failed": { label: "Task failed", description: "A turn failed, or the agent couldn't start." },
  "task.needs_input": { label: "Needs input", description: "The agent asked Cody a question (ask_user) and is waiting." },
  "pr.merged": { label: "PR merged", description: "The task's pull request was merged on GitHub." },
  "schedule.run_finished": { label: "Schedule run finished", description: "A project schedule's run ended. Quiet no-op runs are skipped unless you include them." },
}

export const HOOK_ACTIONS = ["send_to_task", "message_captain", "message_coordinator", "create_task"] as const
export type HookAction = (typeof HOOK_ACTIONS)[number]

export const ACTION_INFO: Record<HookAction, { label: string; description: string }> = {
  send_to_task: { label: "Send to the task", description: "Send the prompt to the same task's agent. It resumes its session, like send_to_task." },
  message_captain: { label: "Message the Captain", description: "Send the prompt to the project's Captain." },
  message_coordinator: { label: "Message the Coordinator", description: "Send the prompt to the Coordinator chat." },
  create_task: { label: "Create a task", description: "Start a new task in the project with the prompt." },
}

/** Who started a task, for the "started by" filter. Tasks a hook created are "hook". */
export const HOOK_SOURCES = ["cody", "captain", "coordinator", "schedule"] as const
export type HookSource = (typeof HOOK_SOURCES)[number]
export type TaskSource = HookSource | "hook"

export const SOURCE_INFO: Record<HookSource, string> = { cody: "Cody", captain: "Captain", coordinator: "Coordinator", schedule: "Schedule" }

export interface HookFilters {
  /** Global hooks only: just this project's tasks. */
  projectId?: string | null
  /** Case-insensitive regexes; when set, the task's title / prompt must match. */
  titleRegex?: string | null
  promptRegex?: string | null
  /** Only tasks started by one of these. Empty: any. */
  sources?: HookSource[]
  /** The PR must carry at least one of these labels. Empty: any. */
  labels?: string[]
  /** Skip PRs that carry any of these labels (say "no-automerge"). */
  excludeLabels?: string[]
  /** Draft PRs are skipped unless this is on. */
  includeDrafts?: boolean
  /** Quiet no-op schedule runs (shared/quiet.ts) are skipped unless this is on. */
  includeQuiet?: boolean
}

/** Built-in hooks you can create in one click. The server fills in their prompt. */
export const HOOK_TEMPLATES = ["pr_merge"] as const
export type HookTemplate = (typeof HOOK_TEMPLATES)[number]

export interface Hook {
  id: string
  name: string
  /** null: a global hook, owned by the Coordinator. Otherwise the project whose Captain owns it. */
  projectId: string | null
  trigger: HookTrigger
  filters: HookFilters
  action: HookAction
  /** create_task only: the new task's title (a template like the prompt). */
  taskTitle: string | null
  /** The prompt template; {task_id}, {pr_url} and the other HOOK_VARIABLES are filled in when it fires. */
  prompt: string
  enabled: boolean
  /** Fire on turns this hook started itself (off by default, so a hook can't loop on its own work). */
  allowSelfTrigger: boolean
  /** Most times this hook fires for one task. */
  maxFiresPerTask: number
  template: HookTemplate | null
  /** "Cody", "Coordinator" or "<project> Captain". */
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type HookRunStatus = "fired" | "skipped" | "failed"

/** One audit-log row: a hook matched an event, and what it did about it. */
export interface HookRun {
  id: string
  hookId: string | null
  hookName: string
  /** The hook's scope when it ran: null for a global hook, else the project that owns it. */
  hookProjectId: string | null
  /** The task's project. */
  projectId: string | null
  taskId: string | null
  taskTitle: string | null
  event: HookTrigger
  headSha: string | null
  action: HookAction
  /** The rendered prompt. */
  prompt: string
  status: HookRunStatus
  /** What happened, in a sentence. */
  result: string
  /** The task that got the prompt (send_to_task) or was created (create_task). */
  targetTaskId: string | null
  createdAt: number
}

/** A hook as lists show it: with its newest run. */
export type HookWithLastRun = Hook & { lastRun: HookRun | null }

/** A built-in hook you can create in one click (GET /api/hooks/templates). */
export interface HookTemplateView {
  key: HookTemplate
  description: string
  name: string
  trigger: HookTrigger
  action: HookAction
  filters: HookFilters
  prompt: string
  maxFiresPerTask: number
}

export const HOOK_VARIABLES = ["task_id", "task_title", "project", "pr_number", "pr_url", "branch", "head_sha", "status", "summary"] as const
export type HookVariable = (typeof HOOK_VARIABLES)[number]
export type HookVars = Record<HookVariable, string>

export const VARIABLE_INFO: Record<HookVariable, string> = {
  task_id: "The task's id",
  task_title: "The task's title",
  project: "The project's name",
  pr_number: "Pull request number",
  pr_url: "Pull request URL",
  branch: "The task's git branch",
  head_sha: "The PR's head commit",
  status: "The task's status",
  summary: "The agent's last summary",
}

/** Example values for the live preview in the hook editor. */
export const SAMPLE_HOOK_VARS: HookVars = {
  task_id: "task_1a2b3c4d5e6f",
  task_title: "Add a dark mode toggle",
  project: "box-yard",
  pr_number: "42",
  pr_url: "https://github.com/acme/box-yard/pull/42",
  branch: "boxyard/add-a-dark-mode-toggle-1a2b",
  head_sha: "9f3c2e1a7b6d5c4e3f2a1b0c9d8e7f6a5b4c3d2e",
  status: "pr_ready",
  summary: "Added a dark mode toggle to Settings, with tests. PR #42 is open.",
}

const VAR_RE = /\{([a-z_]+)\}/g

/** Fill in {variables}. Unknown names stay as written; known ones without a value become "". */
export function renderHookTemplate(template: string, vars: Partial<HookVars>): string {
  return template.replace(VAR_RE, (whole, name: string) => ((HOOK_VARIABLES as readonly string[]).includes(name) ? (vars[name as HookVariable] ?? "") : whole))
}

/** {names} in a template that aren't hook variables (probably typos). */
export function unknownVariables(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(VAR_RE)) if (!(HOOK_VARIABLES as readonly string[]).includes(m[1]!)) out.add(m[1]!)
  return [...out]
}

/** PR triggers can use PR filters; every trigger can, but only these always have a PR. */
export const PR_TRIGGERS: readonly HookTrigger[] = ["task.pr_ready", "pr.merged"]

/** What a hook is matched against when a task event happens. */
export interface HookSubject {
  trigger: HookTrigger
  projectId: string
  title: string
  prompt: string
  source: TaskSource | null
  status: TaskStatus
  prUrl: string | null
  prState: PrState | null
  prLabels: string[]
  /** A quiet no-op schedule run. */
  quiet: boolean
}

export const MAX_REGEX_LENGTH = 300

/** A filter regex, compiled case-insensitively; null when it is empty or invalid. */
export function filterRegex(pattern: string | null | undefined): RegExp | null {
  if (!pattern?.trim()) return null
  try {
    return new RegExp(pattern.slice(0, MAX_REGEX_LENGTH), "i")
  } catch {
    return null
  }
}

const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean)

/**
 * Why this hook ignores the event, or null when it should fire. Filters only narrow: an empty filter lets
 * everything through, except draft PRs and quiet runs, which need includeDrafts / includeQuiet.
 */
export function hookMismatch(hook: Pick<Hook, "enabled" | "trigger" | "projectId" | "filters">, s: HookSubject): string | null {
  const f = hook.filters
  if (!hook.enabled) return "the hook is off"
  if (hook.trigger !== s.trigger) return `it runs on ${hook.trigger}`
  if (hook.projectId && hook.projectId !== s.projectId) return "the task is in another project"
  if (f.projectId && f.projectId !== s.projectId) return "the task is in another project"
  if (f.titleRegex?.trim() && !filterRegex(f.titleRegex)?.test(s.title)) return "the title doesn't match"
  if (f.promptRegex?.trim() && !filterRegex(f.promptRegex)?.test(s.prompt)) return "the prompt doesn't match"
  if (f.sources?.length && !(s.source && (f.sources as string[]).includes(s.source))) return "the task was started by someone else"
  const labels = lower(s.prLabels)
  const want = lower(f.labels)
  if (want.length && !want.some((l) => labels.includes(l))) return s.prUrl ? "the PR doesn't have a required label" : "the task has no PR"
  const skip = lower(f.excludeLabels).find((l) => labels.includes(l))
  if (skip) return `the PR is labelled ${skip}`
  if (s.prState === "draft" && !f.includeDrafts && (PR_TRIGGERS.includes(s.trigger) || want.length)) return "the PR is a draft"
  if (s.quiet && !f.includeQuiet) return "it was a quiet no-op run"
  return null
}

/** Clean up filters from a form or a tool call: trimmed, deduped, empty ones dropped. */
export function normalizeFilters(f: HookFilters | null | undefined): HookFilters {
  const list = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))]
  const out: HookFilters = {}
  if (f?.projectId) out.projectId = f.projectId
  if (f?.titleRegex?.trim()) out.titleRegex = f.titleRegex.trim()
  if (f?.promptRegex?.trim()) out.promptRegex = f.promptRegex.trim()
  const sources = list(f?.sources).filter((s): s is HookSource => (HOOK_SOURCES as readonly string[]).includes(s))
  if (sources.length) out.sources = sources
  if (list(f?.labels).length) out.labels = list(f?.labels)
  if (list(f?.excludeLabels).length) out.excludeLabels = list(f?.excludeLabels)
  if (f?.includeDrafts) out.includeDrafts = true
  if (f?.includeQuiet) out.includeQuiet = true
  return out
}

/** Problems that would make a hook never work, as sentences; [] when it's fine. */
export function hookProblems(h: { name?: string; prompt?: string; action?: HookAction; taskTitle?: string | null; filters?: HookFilters; maxFiresPerTask?: number }): string[] {
  const out: string[] = []
  if (h.name !== undefined && !h.name.trim()) out.push("Give the hook a name.")
  if (h.prompt !== undefined && !h.prompt.trim()) out.push("Write the prompt the hook sends.")
  if (h.action === "create_task" && !h.taskTitle?.trim()) out.push("A hook that creates tasks needs a task title.")
  for (const [key, label] of [["titleRegex", "title"], ["promptRegex", "prompt"]] as const) {
    const p = h.filters?.[key]
    if (!p?.trim()) continue
    if (p.length > MAX_REGEX_LENGTH) out.push(`The ${label} pattern is longer than ${MAX_REGEX_LENGTH} characters.`)
    else if (!filterRegex(p)) out.push(`The ${label} pattern isn't a valid regular expression.`)
  }
  if (h.maxFiresPerTask !== undefined && (!Number.isInteger(h.maxFiresPerTask) || h.maxFiresPerTask < 1 || h.maxFiresPerTask > 50)) {
    out.push("Fires per task must be a whole number from 1 to 50.")
  }
  return out
}

/** One line about what a hook does, for lists: "PR ready → Send to the task". */
export const hookSummary = (h: Pick<Hook, "trigger" | "action">) => `${TRIGGER_INFO[h.trigger].label} → ${ACTION_INFO[h.action].label}`

/** The short head commit, as GitHub shows it. */
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)
