// Types shared by the API server and the React app.
import type { TaskOutcome } from "./quiet.js"
import type { BoxCleanup } from "./disk.js"
import type { Hook, HookRun } from "./hooks.js"
import type { BoxResize } from "./boxSizes.js"
import type { TtsInfo } from "./tts.js"
export type { TaskOutcome } from "./quiet.js"
export type { BoxCleanup } from "./disk.js"
export type { BoxResize, ResizePlan, ResizeInitiator, ResizeMode, ResizeStep, DiskFit } from "./boxSizes.js"

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
  /** The curated notes every agent in the project starts with (the Captain keeps them within the notes budget). */
  notes: ProjectNote[]
  /** This project's own notes budget (most notes in a prompt); null uses Settings › Max notes. */
  notesMaxCount: number | null
  /** This project's own notes token budget; null uses Settings › Notes token budget. */
  notesMaxTokens: number | null
  /** Size for new boxes made for this project; null uses Settings → Worker size. */
  boxSize: BoxSize | null
  /** Box mirrors of its repo are partial clones (blob:none); null uses Settings → Partial clone mirrors. */
  partialClone: boolean | null
  /** Push each task's branch and uncommitted work at the end of every turn; null uses Settings → Push at turn end. */
  pushAtTurnEnd: boolean | null
  createdAt: number
  updatedAt: number
}

export interface ProjectNote {
  id: string
  projectId: string
  /** Who created it: the owner's name, "captain", "orchestrator", or "agent: <task title>" for older agent notes. */
  author: string
  content: string
  createdAt: number
  /** The last edit; createdAt until someone edits it. */
  updatedAt: number
  /** Who made the last edit, or null when it was never edited. */
  updatedBy: string | null
}

export const NOTE_SUGGESTION_STATUSES = ["pending", "accepted", "merged", "rejected"] as const
export type NoteSuggestionStatus = (typeof NOTE_SUGGESTION_STATUSES)[number]

/**
 * A note an agent proposed with suggest_note. It never reaches a prompt by itself: the project's Captain
 * accepts it as a note, merges it into one, or rejects it in the notes retro after the task. Nobody else
 * approves it; the Notes tab only shows the history.
 */
export interface NoteSuggestion {
  id: string
  projectId: string
  /** The task whose agent suggested it; null once that task is deleted. */
  taskId: string | null
  taskTitle: string
  content: string
  /** What a future agent would get wrong without this note. */
  why: string
  status: NoteSuggestionStatus
  /** The note it became (accepted) or was merged into. */
  noteId: string | null
  resolvedBy: string | null
  /** The Captain's one-line reason for its decision. */
  reason: string | null
  createdAt: number
  resolvedAt: number | null
  /** When a notes retro handed it to the Captain; each suggestion goes out in one retro at most. */
  retroAt: number | null
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
  /** Why a queued task is held back beyond a free slot, e.g. "Waiting for disk cleanup on box-1". */
  waitReason: string | null
  turnCount: number
  /** Messages waiting to be sent in the next turn. */
  pendingCount: number
  /** Changes whenever the queued messages do (added, edited, cancelled, being delivered); "" when none. */
  queueRev?: string
  lastArchivedAt: number | null
  /** Set when a schedule started this task. */
  scheduleId: string | null
  /** "noop" when the agent reported a run that found nothing to do and the server accepted it (shared/quiet.ts). */
  outcome: TaskOutcome | null
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
  /** Claude Code cost recorded for this task's turns. */
  claudeCostUsd: number
  /** Claude Code tokens recorded for this task's turns. */
  claudeTokens: number
  /** Routing rule name or id that picked the current model/effort, if any. */
  routingRule: string | null
  /** Short explanation of why that route was picked. */
  routingReason: string | null
  /** Cody pressed "Merge PR" and the agent hasn't finished that turn yet (null otherwise). */
  mergeRequest?: MergeRequest | null
  /** The last turn-end push of the task's git work (repo projects with push at turn end on); null before the first. */
  pushState?: PushState | null
  createdAt: number
  updatedAt: number
}

/**
 * What the last turn-end push did. "pushed": origin has the branch's commits and, when there is uncommitted work,
 * the hidden ref refs/boxyard/wip/<task>, so the archive only needs the session and log. "skipped" (push off, no
 * write access, a repo git can't snapshot) and "failed" keep the full archive.
 */
export interface PushState {
  status: "pushed" | "skipped" | "failed"
  at: number
  branch: string | null
  /** The commit the workspace was on. */
  head: string | null
  /** Commit on origin at refs/boxyard/wip/<task> holding uncommitted work; null when the work was clean. */
  wip: string | null
  /** Why it was skipped or failed. */
  reason: string | null
}

/**
 * A pending "Merge PR" request: the standard merge message went to the task's session (or waits in its queue).
 * It stays until the turn that handled it ends or the PR is merged or closed; a second one for the same PR is refused meanwhile.
 */
export interface MergeRequest {
  prNumber: number
  prUrl: string
  requestedAt: number
  /** When the message went out in a turn; null while it waits for the agent's current turn to end. */
  deliveredAt: number | null
  /** Who asked, when it wasn't the owner's Merge button: a hook, as `hook "On PR ready → merge"`. */
  requestedBy?: string | null
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

/** Who sent a queued message: shapes its row on the task page. */
export type QueuedSender = "owner" | "coordinator" | "captain" | "hook" | "agent" | "system"

/**
 * A message waiting for a task's next turn (GET /api/tasks/:id/queue). "queued" ones can be edited and deleted;
 * "delivering" ones are being handed to a turn that is starting, and are locked.
 */
export interface QueuedMessage {
  id: string
  taskId: string
  /** The raw input source: cody, cody:merge, orchestrator, captain:<project>, hook:<id>, agent:<task>, system. */
  source: string
  kind: QueuedSender
  /** Who sent it, as the row says it: "Cody", "Coordinator", "box-yard Captain", "Hook: On PR ready". */
  sender: string
  text: string
  attachments: Attachment[]
  status: "queued" | "delivering"
  /** Bumped on every edit; pass it back to an edit to refuse it when someone else changed the message first. */
  version: number
  createdAt: number
  updatedAt: number
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

/** Who sent a Captain a message: Cody from the Captain tab, the Coordinator (send_to_captain/ask_captain) or a schedule. */
export type CaptainSource = "cody" | "coordinator" | "schedule" | "hook"

/** The Captain-tool fields the Coordinator chat keeps on a send_to_captain/ask_captain/wait_for_captain tool line (meta.captain). */
export interface CaptainToolResult {
  projectId: string | null
  /** The Captain's reply (ask/wait), when it gave one. */
  reply: string | null
  /** False when the Coordinator stopped waiting while the Captain was still working. */
  finished: boolean | null
}

export interface CaptainMessage {
  id: string
  projectId: string
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
  size: BoxSize
  keepAlive: boolean
  slots: number
  runningTurns: number
  residentTasks: string[]
  /** Names of the projects whose tasks live on this box. */
  projects: string[]
  activeMs: number
  uptimeMs: number
  diskBytes: number | null
  /** Free and total space on the box's work disk (df), null until first checked. */
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  diskCheckedAt: number | null
  /** Free and total space on the box's root disk (/tmp, HOME) when that isn't the work disk; null otherwise or until checked. */
  rootFreeBytes?: number | null
  rootTotalBytes?: number | null
  /** Too little free space for a new workspace (Settings → Boxes & limits → Disk). */
  diskLow: boolean
  /** The running cleanup, or the last one. */
  cleanup: BoxCleanup | null
  /** What is being done to the box right now; its Clean up, Clear, Resize and Delete buttons wait for it. */
  operation: BoxOperation | null
  /** The running resize, or the last one (on a migrated-to box: the one that made it). */
  resize: BoxResize | null
  estimatedCostUsd: number
  usageSource: "actual" | "estimated"
  createdAt: number
  lastUsedAt: number
}

export type BoxOperation = "cleanup" | "clear" | "delete" | "resize"

/** What Clear box and Delete box would touch, for their confirmations. */
export interface BoxContents {
  boxId: string
  tasks: {
    id: string
    title: string
    projectId: string
    status: TaskStatus
    /** A turn is running (or setting up) on the box right now. */
    running: boolean
    /** Changed or untracked files in the workspace (git status), null when it couldn't tell. Archived before anything is removed. */
    uncommitted: number | null
    /** The workspace already has an archive newer than its last activity. */
    archived: boolean
  }[]
  /** Agents running on the box: Clear and Delete refuse unless asked to stop them. */
  running: number
  /** Disk in use on the box (df), and how much of it is Box Yard's folders (du). */
  diskUsedBytes: number | null
  diskBytes: number | null
}

export interface Health {
  ok: boolean
  provider: string
  mock: boolean
  bus: "redis" | "file"
  claude: { available: boolean; version: string | null }
  problems: string[]
  pool: { maxBoxes: number; slotsPerBox: number; maxAgents: number; maxResidentPerBox: number; boxIdleDeleteMinutes: number }
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
  /** A project's note suggestions changed (one was added or resolved). */
  | { type: "note_suggestions"; projectId: string }
  | { type: "project.deleted"; projectId: string }
  /** The owner reordered the projects: every project id, first to last. */
  | { type: "projects.order"; ids: string[] }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.delta"; text: string }
  | { type: "chat.busy"; busy: boolean }
  /** An orchestrator turn ended. `replyId` is its final reply (text after its last tool call), if it said anything. */
  | { type: "chat.turn"; startedAt: number; replyId: string | null }
  | { type: "orchestrator.state"; state: OrchestratorState }
  | { type: "captain.message"; message: CaptainMessage }
  | { type: "captain.state"; state: CaptainState }
  | { type: "settings"; info: SettingsInfo }
  /** Settings › Voice text-to-speech choices changed (keys only as set/unset). */
  | { type: "tts"; info: TtsInfo }
  | { type: "artifact"; artifact: Artifact }
  | { type: "boxes"; boxes: BoxInfo[] }
  | { type: "box.cleanup"; cleanup: BoxCleanup }
  | { type: "box.resize"; resize: BoxResize }
  | { type: "schedule"; schedule: Schedule }
  | { type: "schedule.run"; run: ScheduleRun }
  | { type: "schedule.deleted"; scheduleId: string }
  | { type: "notification"; notification: AppNotification }
  | { type: "notifications.read"; ids: string[]; readAt: number }
  | { type: "hook"; hook: Hook }
  | { type: "hook.deleted"; hookId: string }
  | { type: "hook.run"; run: HookRun }

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
  /** The task it's about; null for a box notification (e.g. a resize the Coordinator made). */
  taskId: string | null
  /** The box it's about, for box notifications. */
  boxId?: string | null
  /** Where a click goes when it isn't the task page. */
  href?: string | null
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
/** Captains have their own model/effort settings; like every default they start at Opus 5.5, high effort. */
export const DEFAULT_CAPTAIN_MODEL = DEFAULT_MODEL
export const DEFAULT_CAPTAIN_EFFORT: Effort = DEFAULT_EFFORT
/** The CLI accepts an auto-compact window between these many tokens. */
export const AUTOCOMPACT_MIN_TOKENS = 100_000
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000

export const WORKER_SIZES = ["small", "medium", "large"] as const
export type WorkerSize = (typeof WORKER_SIZES)[number]

export const SIZE_DEFAULTS: Record<WorkerSize, { slotsPerBox: number; maxResidentPerBox: number }> = {
  small: { slotsPerBox: 1, maxResidentPerBox: 3 },
  medium: { slotsPerBox: 2, maxResidentPerBox: 8 },
  large: { slotsPerBox: 4, maxResidentPerBox: 18 },
}

export interface AutoCompact {
  enabled: boolean
  unit: "percent" | "tokens"
  /** Percent of the context window (10-95) or a token count. */
  value: number
}

export const BOX_SIZES = WORKER_SIZES
export type BoxSize = WorkerSize

export interface CostRates {
  boxActiveCpuHourlyUsd: Record<BoxSize, number>
  boxKeepAliveMonthlyUsd: Record<BoxSize, number>
  boxStorageGbMonthUsd: number
}

export interface BudgetSettings {
  /** 0 disables this budget. */
  dailyUsd: number
  /** 0 disables this budget. */
  monthlyUsd: number
}

export interface Settings {
  /** What Box Yard calls its human in prompts and labels (default "Cody"). */
  ownerName: string
  orchestratorModel: string
  orchestratorEffort: Effort
  /** Compacts between turns once usage passes the threshold; writes a log file first. */
  orchestratorAutoCompact: AutoCompact
  /** Model for the per-project Captains, separate from the Coordinator's. */
  captainModel: string
  captainEffort: Effort
  agentModel: string
  agentEffort: AgentEffort
  /** YAML routing rules the orchestrator uses to choose per-task/per-turn model and effort. */
  agentRoutingConfig: string
  /** When enabled, passed to the CLI as --autocompact; otherwise the CLI's own default applies. */
  agentAutoCompact: AutoCompact
  /** Upstash Box size used for new worker boxes (a project's preferred size wins). */
  workerSize: WorkerSize
  /** The Coordinator and Captains may resize boxes with resize_box. */
  autoResizeEnabled: boolean
  /** The largest size resize_box may pick. */
  autoResizeMaxSize: BoxSize
  /** Most worker boxes alive at once. */
  maxBoxes: number
  /** Claude turns that may run at once inside one box. Unset, each box uses its own size's default. */
  slotsPerBox: number
  /** Cap on agents running at once across all boxes. 0 = no extra cap beyond boxes x agents per box. */
  maxAgents: number
  /** Rates used to estimate Upstash Box infrastructure costs. */
  costRates: CostRates
  /** Optional cost guardrail. When exceeded, Box Yard holds queued agent turns. */
  budget: BudgetSettings
  /** Task folders kept in one box before old archived ones are parked. */
  maxResidentPerBox: number
  /** Delete a worker box after this many idle minutes. 0 = keep boxes until removed manually. */
  boxIdleDeleteMinutes: number
  /** Park archived resting task folders from boxes after this many idle days. 0 = keep folders. */
  workspaceRetentionDays: number
  /** Prune orphan and long-done archives after this many days. 0 = keep archives. */
  archiveRetentionDays: number
  /** Never prune the archive of a task touched within this many days (on top of archiveRetentionDays). 0 = no extra protection. */
  archiveKeepTouchedDays: number
  /** Free space a box needs before a new workspace lands on it, at least. */
  diskMinFreeMb: number
  /** ...and at least this many times the repo's last clone size. */
  diskCloneFactor: number
  /** Box repo mirrors are partial clones (blob:none): old blobs are fetched when something reads them. A project can override it. */
  gitPartialClone: boolean
  /**
   * After every turn, push the task's branch and its uncommitted work (to the hidden ref refs/boxyard/wip/<task>),
   * so archives only carry what git can't. A project can override it.
   */
  gitPushAtTurnEnd: boolean
  /** Remove a resting task's git-ignored build output (node_modules, dist, caches…) after this many idle minutes. 0 = off. */
  buildCleanupIdleMinutes: number
  /** Notes retro: when a task's PR merges, or a task without a PR ends done, its Captain curates the agent's note suggestions. */
  notesRetroEnabled: boolean
  /** Max notes: at most this many notes go into each agent's prompt (a project can set its own)... */
  notesMaxCount: number
  /** ...and at most about this many tokens of them. Over either, the Captain is told to prune. */
  notesMaxTokens: number
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

export interface ClaudeUsageTotals {
  costUsd: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalTokens: number
  turns: number
  durationMs: number
}

export interface BoxUsageTotals {
  activeMs: number
  uptimeMs: number
  diskBytes: number
  costUsd: number
  source: "actual" | "estimated"
}

export interface UsageWindow {
  key: "today" | "7d" | "30d"
  label: string
  since: number
  claude: ClaudeUsageTotals
  boxes: BoxUsageTotals
  totalCostUsd: number
}

export interface UsageProjectTotal {
  projectId: string
  projectName: string
  claude: ClaudeUsageTotals
}

export interface UsageTaskTotal {
  taskId: string
  taskTitle: string
  projectId: string
  projectName: string
  claude: ClaudeUsageTotals
}

export interface UsageBoxTotal {
  boxId: string
  provider: string
  size: BoxSize
  keepAlive: boolean
  activeMs: number
  uptimeMs: number
  diskBytes: number | null
  estimatedCostUsd: number
  usageSource: "actual" | "estimated"
}

export interface BudgetStatus {
  daily: { limitUsd: number; usedUsd: number; exceeded: boolean; warning: boolean }
  monthly: { limitUsd: number; usedUsd: number; exceeded: boolean; warning: boolean }
  blocked: boolean
}

export interface UsageReport {
  generatedAt: number
  rates: CostRates
  budget: BudgetStatus
  windows: UsageWindow[]
  projects: UsageProjectTotal[]
  tasks: UsageTaskTotal[]
  boxes: UsageBoxTotal[]
  /** The Coordinator's own runs (all-time). */
  orchestrator: ClaudeUsageTotals
  /** Per-project Captain runs (all-time), including older rows logged as orchestrator usage with a project id. */
  captains: ClaudeUsageTotals
  /** Everything for one period. Only present when the request passed `from` (GET /api/usage?from=&to=). */
  period?: UsagePeriodReport
}

/** Where spend goes. Agents are task turns that no schedule started; schedule runs are the rest. */
export type UsageCategory = "coordinator" | "captains" | "agents" | "schedules" | "boxes"
export const USAGE_CATEGORIES: UsageCategory[] = ["coordinator", "captains", "agents", "schedules", "boxes"]

/** One line of a breakdown table. Every breakdown's rows sum to the period total. */
export interface UsageBreakdownRow {
  key: string
  label: string
  /** Second line, e.g. a task's project or a schedule's run count. */
  detail?: string | null
  href?: string | null
  /** Set on rows that aren't the breakdown's own kind (Boxes in "By model", the Coordinator in "By project"). */
  other?: boolean
  category?: UsageCategory | null
  /** Claude runs that did work (a run with no tokens and no cost, like a /context probe, isn't a turn). */
  turns: number
  tokens: number
  costUsd: number
  /** Schedule runs: tasks the schedule started in the period. */
  runs?: number
  children?: UsageBreakdownRow[]
}

export interface UsageBucket {
  start: number
  /** Cost per category in this bucket. */
  costs: Record<UsageCategory, number>
}

export interface UsagePeriodBox {
  boxId: string
  size: BoxSize
  keepAlive: boolean
  /** False once the box is gone; its metered time still counts. */
  live: boolean
  activeMs: number
  uptimeMs: number
  diskBytes: number | null
  costUsd: number
  source: "actual" | "estimated"
}

export interface UsagePeriodReport {
  from: number
  to: number
  bucketMs: number
  totalCostUsd: number
  claude: ClaudeUsageTotals
  boxes: BoxUsageTotals
  categories: Record<UsageCategory, { costUsd: number; turns: number; tokens: number }>
  buckets: UsageBucket[]
  byProject: UsageBreakdownRow[]
  byTask: UsageBreakdownRow[]
  byModel: UsageBreakdownRow[]
  bySource: UsageBreakdownRow[]
  boxList: UsagePeriodBox[]
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

export interface CompactionTaskSnapshot {
  taskId: string
  title: string
  status: TaskStatus
  projectId: string
  projectName: string
  branch: string | null
  prUrl: string | null
  sessionId: string
  summary: string
  lastActiveAt: number
}

export interface OrchestratorCompactionRecord extends CompactionInfo {
  id: string
  sessionId: string
  model: string
  jsonFile: string
  taskCount: number
  tasks: CompactionTaskSnapshot[]
  markdown?: string
}

/** A compaction read back from its log files (Captain compactions have no database rows). */
export interface CompactionRecord extends OrchestratorCompactionRecord {
  /** Tasks the compaction links: snapshotted, listed in its frontmatter, or named in its summary. */
  taskIds: string[]
}

export interface TaskCompactionRecord {
  id: string
  taskId: string
  sessionId: string
  at: number
  statusBefore: TaskStatus | null
  statusAfter: TaskStatus | null
  tokensBefore: number | null
  tokensAfter: number | null
  summary: string
  archivePath: string | null
  archiveAvailable: boolean
  archiveNote: string | null
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

export interface CaptainState {
  projectId: string
  busy: boolean
  usage: ContextUsage
  compacting: boolean
  compactQueued: boolean
  lastCompaction: CompactionInfo | null
  compactionsDir: string
  error: string | null
  /** Unattended wake-ups since Cody or the Coordinator last wrote. */
  autoTurns?: number
  /** Set while the loop guard holds back automatic wake-ups; queued updates go out when it ends. */
  throttledUntil?: number | null
}

export interface CaptainCompaction extends CompactionInfo {
  content: string
}
