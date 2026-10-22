// Types shared by the API server and the React app.

export const TASK_STATUSES = [
  "queued", // waiting for a free box slot
  "starting", // box is being prepared (clone, restore, install)
  "working", // a Claude turn is running
  "needs_input", // the agent asked Cody something
  "waiting", // the agent is waiting on a reply from another agent
  "idle", // turn finished, nothing pending
  "pr_ready", // a pull request is open
  "done", // the agent (or Cody) marked it finished
  "failed", // something broke; see `error`
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Statuses where a task needs nothing from anyone right now. */
export const RESTING_STATUSES: TaskStatus[] = ["idle", "pr_ready", "done", "failed", "needs_input", "waiting"]

/** A task's pull request as GitHub sees it. Merged and closed are final: polling stops there. */
export const PR_STATES = ["open", "draft", "merged", "closed"] as const
export type PrState = (typeof PR_STATES)[number]
export const isFinalPrState = (s: PrState | null | undefined) => s === "merged" || s === "closed"

export interface Project {
  id: string
  name: string
  description: string
  /** `owner/name` or a full git URL. Empty for non-coding projects. */
  repo: string | null
  baseBranch: string
  /** Env var names only; values never leave the server. */
  envKeys: string[]
  notes: ProjectNote[]
  createdAt: number
  updatedAt: number
}

export interface ProjectNote {
  id: string
  projectId: string
  author: string
  content: string
  createdAt: number
}

export interface PreviewLink {
  port: number
  url: string
  label: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  prompt: string
  status: TaskStatus
  boxId: string | null
  sessionId: string
  branch: string | null
  prUrl: string | null
  /** Null until the server has asked GitHub (or the task has no PR). */
  prState: PrState | null
  prMergedAt: number | null
  /** GitHub login of whoever merged the PR. */
  prMergedBy: string | null
  previews: PreviewLink[]
  question: string | null
  summary: string | null
  /** Until there is a summary: the latest assistant text or tool call as one line (shared/activity.ts), for cards. */
  activity?: string | null
  error: string | null
  turnCount: number
  /** Messages waiting to be sent in the next turn. */
  pendingCount: number
  lastArchivedAt: number | null
  /** Set when a schedule started this task. */
  scheduleId: string | null
  /** Tokens in the Claude session's context after its last turn; null until the first turn ends. */
  contextTokens: number | null
  contextWindow: number | null
  /** A compaction is queued for after the current turn. */
  compactPending: boolean
  /** A compaction turn is running right now. */
  compacting: boolean
  /** Model currently selected for subsequent turns, when routing overrode the global agent model. */
  model: string | null
  /** Effort currently selected for subsequent turns, when routing or the orchestrator overrode the global effort. */
  effort: Effort | null
  /** Routing rule name or id that picked the current model/effort, if any. */
  routingRule: string | null
  /** Short explanation of why that route was picked. */
  routingReason: string | null
  createdAt: number
  updatedAt: number
}

/** What to do when runs were missed (the server was down or its box was paused). */
export type CatchUp = "once" | "skip"

/** Where a schedule's runs go: a fresh task in a project, or a message to the orchestrator chat. */
export type ScheduleTarget = "project" | "orchestrator"

export type ScheduleRunStatus = "queued" | "running" | "done" | "failed"

/** One run of an orchestrator schedule. (Project schedule runs are ordinary tasks.) */
export interface ScheduleRun {
  id: string
  scheduleId: string
  status: ScheduleRunStatus
  reason: "scheduled" | "manual" | "catch-up"
  /** The text injected into the chat, e.g. "[Scheduled: Morning digest] ...". */
  prompt: string
  dueAt: number
  /** The chat message this run injected, once delivered. */
  chatMessageId: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface Schedule {
  id: string
  target: ScheduleTarget
  /** Null for orchestrator schedules. */
  projectId: string | null
  name: string
  /** 5-field cron expression or a macro like @daily. */
  cron: string
  /** IANA time zone the cron is read in, e.g. America/New_York. */
  timezone: string
  /** What the agent is asked to do on every run. */
  prompt: string
  enabled: boolean
  catchUp: CatchUp
  /** Start a run even when the previous run is still going. */
  allowOverlap: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastTaskId: string | null
  /** Why the last due run did not start a task, if it didn't. */
  lastSkipReason: string | null
  runCount: number
  /** QStash schedule id when QStash triggers this schedule. */
  qstashId: string | null
  createdAt: number
  updatedAt: number
}

/** A file Cody attached to a message. `path` is the file on the server's disk (chat messages only). */
export interface Attachment {
  id: string
  name: string
  size: number
  mime: string
  path?: string
}

export type TaskMessageRole = "user" | "assistant" | "tool" | "event" | "agent"

export interface TaskMessage {
  id: string
  taskId: string
  role: TaskMessageRole
  content: string
  meta: Record<string, unknown> | null
  createdAt: number
}

export type ChatRole = "user" | "assistant" | "tool" | "notice" | "error"

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  meta: Record<string, unknown> | null
  createdAt: number
}

export interface Artifact {
  id: string
  projectId: string | null
  taskId: string | null
  title: string
  filename: string
  mime: string
  size: number
  url: string
  createdAt: number
}

export interface BoxInfo {
  id: string
  provider: string
  status: "creating" | "ready" | "lost" | "deleting"
  slots: number
  runningTurns: number
  residentTasks: string[]
  /** Names of the projects whose tasks live on this box. */
  projects: string[]
  createdAt: number
  lastUsedAt: number
}

export interface Health {
  ok: boolean
  provider: string
  mock: boolean
  bus: "redis" | "file"
  claude: { available: boolean; version: string | null }
  problems: string[]
  pool: { maxBoxes: number; slotsPerBox: number; maxAgents: number }
  orchestratorBusy: boolean
  /** How schedules are triggered: the server's own timer, or QStash plus the timer. */
  scheduler: "local" | "qstash"
}

/** Server-sent events pushed to the UI. */
export type UiEvent =
  | { type: "task"; task: Task }
  | { type: "task.deleted"; taskId: string }
  | { type: "task.message"; message: TaskMessage }
  | { type: "project"; project: Project }
  | { type: "project.deleted"; projectId: string }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.delta"; text: string }
  | { type: "chat.busy"; busy: boolean }
  /** An orchestrator turn ended. `replyId` is its final reply (text after its last tool call), if it said anything. */
  | { type: "chat.turn"; startedAt: number; replyId: string | null }
  | { type: "orchestrator.state"; state: OrchestratorState }
  | { type: "settings"; info: SettingsInfo }
  | { type: "artifact"; artifact: Artifact }
  | { type: "boxes"; boxes: BoxInfo[] }
  | { type: "schedule"; schedule: Schedule }
  | { type: "schedule.run"; run: ScheduleRun }
  | { type: "schedule.deleted"; scheduleId: string }
  | { type: "notification"; notification: AppNotification }
  | { type: "notifications.read"; ids: string[]; readAt: number }

/** Task statuses that are worth telling Cody about when a task lands in them. */
export const NOTIFY_STATUSES = ["done", "pr_ready", "needs_input", "failed", "idle"] as const
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number]

/**
 * Should a status change notify Cody? Only when work settles: a running (or queued) task lands on a
 * finished or attention status. Idle counts only after a turn actually ran (working -> idle).
 */
export function shouldNotify(prev: TaskStatus, next: TaskStatus): next is NotifyStatus {
  if (prev === next) return false
  if (!(NOTIFY_STATUSES as readonly TaskStatus[]).includes(next)) return false
  if (next === "idle") return prev === "working"
  return prev === "queued" || prev === "starting" || prev === "working"
}

/** A task that finished or needs attention, as shown in toasts and the sidebar's Recent list. */
export interface AppNotification {
  id: string
  taskId: string
  projectId: string
  /** Task title and project name as they were when it fired. */
  title: string
  projectName: string
  status: NotifyStatus
  /** One line: the question, the error or the agent's summary. */
  summary: string | null
  createdAt: number
  readAt: number | null
}

// ---------------------------------------------------------------- effort, usage, settings

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORTS)[number]
/** Box agent effort setting: a fixed level, or the orchestrator picks per task/message. */
export type AgentEffort = Effort | "orchestrator"

export const DEFAULT_MODEL = "claude-opus-5-5"
export const DEFAULT_EFFORT: Effort = "high"
/** The CLI accepts an auto-compact window between these many tokens. */
export const AUTOCOMPACT_MIN_TOKENS = 100_000
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000

export interface AutoCompact {
  enabled: boolean
  unit: "percent" | "tokens"
  /** Percent of the context window (10-95) or a token count. */
  value: number
}

export interface Settings {
  orchestratorModel: string
  orchestratorEffort: Effort
  /** Compacts between turns once usage passes the threshold; writes a log file first. */
  orchestratorAutoCompact: AutoCompact
  agentModel: string
  agentEffort: AgentEffort
  /** YAML routing rules the orchestrator uses to choose per-task/per-turn model and effort. */
  agentRoutingConfig: string
  /** When enabled, passed to the CLI as --autocompact; otherwise the CLI's own default applies. */
  agentAutoCompact: AutoCompact
  /** Most worker boxes alive at once. */
  maxBoxes: number
  /** Claude turns that may run at once inside one box. */
  slotsPerBox: number
  /** Cap on agents running at once across all boxes. 0 = no extra cap beyond boxes x agents per box. */
  maxAgents: number
}

/** Agents that can run at once under a set of limits. */
export function agentCapacity(p: { maxBoxes: number; slotsPerBox: number; maxAgents: number }) {
  const perBoxes = p.maxBoxes * p.slotsPerBox
  return p.maxAgents > 0 ? Math.min(p.maxAgents, perBoxes) : perBoxes
}

/** Free-plan box limit, from https://upstash.com/pricing/box (checked 2026-10-22). */
export const UPSTASH_FREE_CONCURRENT_BOXES = 10

export type SettingSource = "ui" | "env" | "default"

export interface SettingsInfo {
  /** The values in effect from the next turn on. */
  settings: Settings
  /** Where each value comes from: saved in the UI, an env var, or the built-in default. */
  sources: Record<keyof Settings, SettingSource>
  defaults: Settings
}

export interface ContextUsage {
  tokens: number | null
  window: number | null
  updatedAt: number | null
}

export interface CompactionInfo {
  at: number
  trigger: "button" | "auto"
  tokensBefore: number | null
  tokensAfter: number | null
  file: string
}

export interface OrchestratorState {
  busy: boolean
  usage: ContextUsage
  compacting: boolean
  compactQueued: boolean
  lastCompaction: CompactionInfo | null
  compactionsDir: string
  error: string | null
}
