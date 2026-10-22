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
