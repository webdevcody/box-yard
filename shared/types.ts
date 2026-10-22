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
  previews: PreviewLink[]
  question: string | null
  summary: string | null
  error: string | null
  turnCount: number
  /** Messages waiting to be sent in the next turn. */
  pendingCount: number
  lastArchivedAt: number | null
  /** Set when a schedule started this task. */
  scheduleId: string | null
  createdAt: number
  updatedAt: number
}

/** What to do when runs were missed (the server was down or its box was paused). */
export type CatchUp = "once" | "skip"

export interface Schedule {
  id: string
  projectId: string
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
  pool: { maxBoxes: number; slotsPerBox: number }
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
  | { type: "artifact"; artifact: Artifact }
  | { type: "boxes"; boxes: BoxInfo[] }
  | { type: "schedule"; schedule: Schedule }
  | { type: "schedule.deleted"; scheduleId: string }
