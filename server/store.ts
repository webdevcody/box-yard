import { randomUUID } from "node:crypto"
import type { DB } from "./db.js"
import { BOX_SIZES, shouldNotify } from "../shared/types.js"
import { activityLine } from "../shared/activity.js"
import { isQuietRun, parseOutcome, type TaskOutcome } from "../shared/quiet.js"
import { normalizeHeavyTasks, type HeavyTasks } from "../shared/memory.js"
import { buildUsagePeriod, type PeriodBoxInterval, type PeriodClaudeRow } from "./usagePeriod.js"
import type {
  AppNotification,
  Artifact,
  CaptainMessage,
  BoxSize,
  BoxUsageTotals,
  BudgetSettings,
  BudgetStatus,
  ChatMessage,
  ChatRole,
  ClaudeUsageTotals,
  CostRates,
  CompactionTaskSnapshot,
  Effort,
  MergeRequest,
  OrchestratorCompactionRecord,
  PrState,
  PreviewLink,
  PushState,
  Project,
  ProjectNote,
  NoteSuggestion,
  NoteSuggestionStatus,
  CatchUp,
  Schedule,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleTarget,
  Task,
  TaskCompactionRecord,
  TaskMessage,
  TaskMessageRole,
  TaskStatus,
  UsageBoxTotal,
  UsageProjectTotal,
  UsageReport,
  UsagePeriodReport,
  UsageTaskTotal,
  UsageWindow,
} from "../shared/types.js"

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`

/** Parse JSON text, or return the fallback when it's empty or invalid. */
export const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const publicMergeRequest = (req: StoredMergeRequest | null): MergeRequest | null =>
  req ? { prNumber: req.prNumber, prUrl: req.prUrl, requestedAt: req.requestedAt, deliveredAt: req.deliveredAt, requestedBy: req.requestedBy ?? null } : null

/** What happened during the turn that is running now. Reset at turn start. */
export interface TurnFlags {
  asked?: string
  done?: string
  waitingOn?: string[]
  sawPr?: boolean
  /** The agent marked the run a no-op (mark_done outcome "noop"), with its commit count if it could tell. */
  noop?: { commits: number | null }
  /** How many times in a row a turn died and was retried. */
  interrupts?: number
  /** Hooks whose prompts started this turn (their inputs were in it), so they don't fire on it again. */
  hookIds?: string[]
  /** The same for the turn before, kept while the task rests (a PR merged later still knows who asked). */
  lastHookIds?: string[]
}

export interface TaskRow {
  id: string
  project_id: string
  title: string
  prompt: string
  status: TaskStatus
  box_id: string | null
  session_id: string
  session_started: number
  branch: string | null
  pr_url: string | null
  pr_state: PrState | null
  pr_merged_at: number | null
  pr_merged_by: string | null
  outcome: TaskOutcome | null
  previews_json: string
  question: string | null
  summary: string | null
  error: string | null
  wait_reason: string | null
  wait_box_size: string | null
  turn_count: number
  port_base: number | null
  event_cursor: string | null
  current_turn_id: string | null
  turn_flags_json: string
  env_json: string
  archive_path: string | null
  last_archived_at: number | null
  created_at: number
  updated_at: number
  last_active_at: number
  schedule_id: string | null
  context_tokens: number | null
  context_window: number | null
  compact_pending: number
  compacting: number
  compact_prev_status: TaskStatus | null
  model: string | null
  effort: Effort | null
  routing_rule: string | null
  routing_reason: string | null
  /** Who started the task: cody, orchestrator, captain:<project>, schedule or hook:<hook>; null on old rows. */
  source: string | null
  pr_head_sha: string | null
  pr_labels_json: string | null
  merge_request_json: string | null
  push_state_json: string | null
}

/** A pending merge request as stored: the public fields plus the queued input that carries the message. */
export interface StoredMergeRequest extends MergeRequest {
  inputId: string
}

export interface TaskTurnRow {
  id: string
  task_id: string
  turn_index: number
  model: string | null
  effort: Effort | null
  routing_rule: string | null
  routing_reason: string | null
  status: string
  started_at: number
  finished_at: number | null
  cost_usd: number | null
  error: string | null
}

interface ScheduleRunRow {
  id: string
  schedule_id: string
  status: ScheduleRunStatus
  reason: ScheduleRun["reason"]
  prompt: string
  due_at: number
  chat_message_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface ScheduleRow {
  id: string
  target: ScheduleTarget
  project_id: string | null
  name: string
  cron: string
  timezone: string
  prompt: string
  enabled: number
  catch_up: CatchUp
  allow_overlap: number
  next_run_at: number | null
  last_run_at: number | null
  last_task_id: string | null
  last_skip_reason: string | null
  run_count: number
  qstash_id: string | null
  created_at: number
  updated_at: number
}

export type SchedulePatch = Partial<{
  name: string
  cron: string
  timezone: string
  prompt: string
  enabled: boolean
  catchUp: CatchUp
  allowOverlap: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastTaskId: string | null
  lastSkipReason: string | null
  runCount: number
  qstashId: string | null
}>

const SCHEDULE_COLUMNS: Record<keyof SchedulePatch, string> = {
  name: "name",
  cron: "cron",
  timezone: "timezone",
  prompt: "prompt",
  enabled: "enabled",
  catchUp: "catch_up",
  allowOverlap: "allow_overlap",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  lastTaskId: "last_task_id",
  lastSkipReason: "last_skip_reason",
  runCount: "run_count",
  qstashId: "qstash_id",
}

/** An unseen Captain notice, with what its WakeLoopGuard counts it by and its meta (a notes retro's suggestion ids). */
export interface CaptainNoticeEntry {
  content: string
  loopKey: string
  meta: Record<string, unknown> | null
}

interface ProjectRow {
  id: string
  name: string
  description: string
  repo: string | null
  base_branch: string
  env_json: string
  box_size: string | null
  partial_clone: number | null
  push_at_turn_end: number | null
  dep_cache?: number | null
  heavy_tasks: string | null
  notes_max_count?: number | null
  notes_max_tokens?: number | null
  sort_order: number
  created_at: number
  updated_at: number
}

export interface BoxRow {
  id: string
  provider: string
  status: "creating" | "ready" | "lost" | "deleting"
  created_at: number
  last_used_at: number
  size: BoxSize
  keep_alive: number
  active_ms: number
  last_metered_at: number | null
  disk_bytes: number | null
  disk_updated_at: number | null
  usage_source: "actual" | "estimated"
  disk_free_bytes: number | null
  disk_total_bytes: number | null
  disk_checked_at: number | null
  root_free_bytes: number | null
  root_total_bytes: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  load_avg: number | null
  cpu_count: number | null
}

/** Who ran a Claude turn. Captain rows written before "captain" existed are "orchestrator" rows with a project id. */
export type ClaudeUsageSource = "task" | "orchestrator" | "captain"

/** SQL filters for the Coordinator and Captain usage lines, so older Captain rows still land on the Captain line. */
export const COORDINATOR_USAGE_WHERE = "WHERE source = 'orchestrator' AND project_id IS NULL"
export const CAPTAIN_USAGE_WHERE = "WHERE source = 'captain' OR (source = 'orchestrator' AND project_id IS NOT NULL)"

export interface ClaudeUsageRow {
  id: string
  source: ClaudeUsageSource
  run_kind: string
  task_id: string | null
  project_id: string | null
  turn_id: string | null
  session_id: string | null
  model: string | null
  started_at: number
  ended_at: number
  duration_ms: number
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  total_tokens: number
  /** This run's own cost. */
  cost_usd: number
  /** What the CLI reported: the session's running total. */
  reported_cost_usd: number
  cost_estimated: number
  raw_usage_json: string
}

interface BoxUsageIntervalRow {
  id: string
  box_id: string
  provider: string
  size: BoxSize
  keep_alive: number
  started_at: number
  ended_at: number
  active_ms: number
  uptime_ms: number
  disk_bytes: number | null
  source: "actual" | "estimated"
}

type TaskPatch = Partial<{
  title: string
  status: TaskStatus
  boxId: string | null
  sessionId: string
  sessionStarted: boolean
  branch: string | null
  prUrl: string | null
  prState: PrState | null
  prMergedAt: number | null
  prMergedBy: string | null
  outcome: TaskOutcome | null
  previews: PreviewLink[]
  question: string | null
  summary: string | null
  error: string | null
  waitReason: string | null
  waitBoxSize: BoxSize | null
  turnCount: number
  portBase: number | null
  eventCursor: string | null
  currentTurnId: string | null
  turnFlags: TurnFlags
  archivePath: string | null
  lastArchivedAt: number | null
  lastActiveAt: number
  contextTokens: number | null
  contextWindow: number | null
  compactPending: boolean
  compacting: boolean
  compactPrevStatus: TaskStatus | null
  model: string | null
  effort: Effort | null
  routingRule: string | null
  routingReason: string | null
  prHeadSha: string | null
  prLabels: string[]
  mergeRequest: StoredMergeRequest | null
  pushState: PushState | null
}>

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  title: "title",
  status: "status",
  boxId: "box_id",
  sessionId: "session_id",
  sessionStarted: "session_started",
  branch: "branch",
  prUrl: "pr_url",
  prState: "pr_state",
  prMergedAt: "pr_merged_at",
  prMergedBy: "pr_merged_by",
  outcome: "outcome",
  previews: "previews_json",
  question: "question",
  summary: "summary",
  error: "error",
  waitReason: "wait_reason",
  waitBoxSize: "wait_box_size",
  turnCount: "turn_count",
  portBase: "port_base",
  eventCursor: "event_cursor",
  currentTurnId: "current_turn_id",
  turnFlags: "turn_flags_json",
  archivePath: "archive_path",
  lastArchivedAt: "last_archived_at",
  lastActiveAt: "last_active_at",
  contextTokens: "context_tokens",
  contextWindow: "context_window",
  compactPending: "compact_pending",
  compacting: "compacting",
  compactPrevStatus: "compact_prev_status",
  model: "model",
  effort: "effort",
  routingRule: "routing_rule",
  routingReason: "routing_reason",
  prHeadSha: "pr_head_sha",
  prLabels: "pr_labels_json",
  mergeRequest: "merge_request_json",
  pushState: "push_state_json",
}

/** How many notifications to keep; older ones are pruned as new ones land. */
const NOTIFICATIONS_KEPT = 200

interface NotificationRow {
  id: string
  task_id: string | null
  box_id: string | null
  href: string | null
  project_id: string
  title: string
  project_name: string
  status: AppNotification["status"]
  summary: string | null
  created_at: number
  read_at: number | null
}

interface OrchestratorCompactionRow {
  id: string
  at: number
  session_id: string
  model: string
  trigger: "button" | "auto"
  tokens_before: number | null
  tokens_after: number | null
  markdown_path: string
  json_path: string
  markdown: string
  created_at: number
  task_count?: number
}

interface OrchestratorCompactionTaskRow {
  compaction_id: string
  task_id: string
  title: string
  status: TaskStatus
  project_id: string
  project_name: string
  branch: string | null
  pr_url: string | null
  session_id: string
  summary: string
  last_active_at: number
}

interface TaskCompactionRow {
  id: string
  task_id: string
  session_id: string
  at: number
  status_before: TaskStatus | null
  status_after: TaskStatus | null
  tokens_before: number | null
  tokens_after: number | null
  summary: string
  archive_path: string | null
  archive_available: number
  archive_note: string | null
  created_at: number
}

const oneLine = (text: string | null | undefined, max = 200) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

interface NoteRow {
  id: string
  project_id: string
  author: string
  content: string
  created_at: number
  updated_at: number | null
  updated_by: string | null
}
const noteFromRow = (r: NoteRow): ProjectNote => ({
  id: r.id,
  projectId: r.project_id,
  author: r.author,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at,
  updatedBy: r.updated_by ?? null,
})

interface SuggestionRow {
  id: string
  project_id: string
  task_id: string | null
  task_title: string
  content: string
  why: string
  status: NoteSuggestionStatus
  note_id: string | null
  resolved_by: string | null
  reason: string | null
  retro_at: number | null
  created_at: number
  resolved_at: number | null
}
const suggestionFromRow = (r: SuggestionRow): NoteSuggestion => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  taskTitle: r.task_title,
  content: r.content,
  why: r.why,
  status: r.status,
  noteId: r.note_id,
  resolvedBy: r.resolved_by,
  reason: r.reason,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  retroAt: r.retro_at,
})

/** Queued inputs in send order. */
const INPUT_ORDER = "ORDER BY created_at ASC, rowid ASC"
/** How long a cancelled queued input is kept, so Undo can bring it back. */
export const CANCELLED_INPUT_KEEP_MS = 10 * 60_000

interface InputRow {
  id: string
  task_id: string
  source: string
  content: string
  attachments: string | null
  status: "queued" | "delivering" | "cancelled"
  version: number
  claim: string | null
  prefix: string
  message_json: string | null
  created_at: number
  updated_at: number | null
}

/** A queued input as a turn delivers it: `content` is what the agent reads (prefix included). */
export interface PendingInput {
  id: string
  source: string
  content: string
  attachments: string[]
}

/** A queued input as stored, for the queue list and its edits. `content` is the editable text (no prefix). */
export interface QueuedInputRow {
  id: string
  taskId: string
  source: string
  content: string
  attachments: string[]
  status: "queued" | "delivering" | "cancelled"
  version: number
  /** The transcript line's meta (who sent it); null for agent and system messages. */
  message: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

/** A compare-and-set on a queued input: ok, or the input as it is now (null: gone, i.e. delivered or cleared). */
export type InputChange = { ok: true; row: QueuedInputRow } | { ok: false; row: QueuedInputRow | null }

/** A queued Coordinator chat or Captain message (meta.queued: sent mid-turn, waiting for the next one). */
export type QueuedChatTable = "chat_messages" | "captain_messages"
export interface QueuedChatRow {
  id: string
  content: string
  meta: Record<string, unknown>
  createdAt: number
}
/** Why a queued chat message couldn't change: a turn took it already, it was deleted, or there is no such message. */
export type QueuedChatChange = { ok: true; row: QueuedChatRow } | { ok: false; reason: "delivered" | "deleted" | "missing" }

const inputAttachments = (r: InputRow) => (r.attachments ? (JSON.parse(r.attachments) as string[]) : [])
const pendingInput = (r: InputRow): PendingInput => ({ id: r.id, source: r.source, content: r.prefix + (r.content || "(no text)"), attachments: inputAttachments(r) })
const queuedInputRow = (r: InputRow): QueuedInputRow => ({
  id: r.id,
  taskId: r.task_id,
  source: r.source,
  content: r.content,
  attachments: inputAttachments(r),
  status: r.status,
  version: r.version,
  message: r.message_json ? (JSON.parse(r.message_json) as Record<string, unknown>) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at,
})

export class Store {
  constructor(readonly db: DB) {}

  /** Called with every notification right after it is recorded (the app broadcasts it). */
  onNotification: ((n: AppNotification) => void) | null = null

  // ---------- projects ----------

  private projectFromRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      repo: row.repo,
      baseBranch: row.base_branch,
      envKeys: Object.keys(json<Record<string, string>>(row.env_json, {})),
      notes: this.listNotes(row.id),
      notesMaxCount: row.notes_max_count ?? null,
      notesMaxTokens: row.notes_max_tokens ?? null,
      boxSize: row.box_size ? normalizeBoxSize(row.box_size) : null,
      partialClone: row.partial_clone === null || row.partial_clone === undefined ? null : row.partial_clone === 1,
      pushAtTurnEnd: row.push_at_turn_end === null || row.push_at_turn_end === undefined ? null : row.push_at_turn_end === 1,
      depCache: row.dep_cache === null || row.dep_cache === undefined ? null : row.dep_cache === 1,
      heavyTasks: normalizeHeavyTasks(row.heavy_tasks),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** In the owner's order (drag-to-reorder in the sidebar), then oldest first. */
  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC, rowid ASC").all() as ProjectRow[]
    return rows.map((r) => this.projectFromRow(r))
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    return row ? this.projectFromRow(row) : null
  }

  /** Just the name, without loading the notes (placement asks often). */
  getProjectName(id: string): string | null {
    return (this.db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null
  }

  /** The project's "heavy tasks" setting, without loading the rest (placement asks per box and running task). */
  projectHeavyTasks(id: string): HeavyTasks {
    return normalizeHeavyTasks((this.db.prepare("SELECT heavy_tasks FROM projects WHERE id = ?").get(id) as { heavy_tasks: string | null } | undefined)?.heavy_tasks)
  }

  findProject(idOrName: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ? OR name = ? COLLATE NOCASE")
      .get(idOrName, idOrName) as ProjectRow | undefined
    return row ? this.projectFromRow(row) : null
  }

  projectEnv(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT env_json FROM projects WHERE id = ?").get(id) as { env_json: string } | undefined
    return json(row?.env_json, {})
  }

  createProject(input: {
    id?: string
    name: string
    description?: string
    repo?: string | null
    baseBranch?: string
    env?: Record<string, string>
    boxSize?: BoxSize | null
    partialClone?: boolean | null
    pushAtTurnEnd?: boolean | null
    depCache?: boolean | null
    heavyTasks?: HeavyTasks
    notesMaxCount?: number | null
    notesMaxTokens?: number | null
  }): Project {
    const now = Date.now()
    const id = input.id ?? newId("prj")
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, repo, base_branch, env_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM projects), ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.description ?? "",
        normalizeRepo(input.repo),
        input.baseBranch?.trim() || "main",
        JSON.stringify(input.env ?? {}),
        now,
        now,
      )
    if (input.boxSize) this.db.prepare("UPDATE projects SET box_size = ? WHERE id = ?").run(input.boxSize, id)
    if (typeof input.partialClone === "boolean") this.db.prepare("UPDATE projects SET partial_clone = ? WHERE id = ?").run(input.partialClone ? 1 : 0, id)
    if (typeof input.pushAtTurnEnd === "boolean") this.db.prepare("UPDATE projects SET push_at_turn_end = ? WHERE id = ?").run(input.pushAtTurnEnd ? 1 : 0, id)
    if (typeof input.depCache === "boolean") this.db.prepare("UPDATE projects SET dep_cache = ? WHERE id = ?").run(input.depCache ? 1 : 0, id)
    this.setHeavyTasks(id, input.heavyTasks)
    this.setProjectNotesBudget(id, input)
    return this.getProject(id)!
  }

  updateProject(
    id: string,
    patch: {
      name?: string
      description?: string
      repo?: string | null
      baseBranch?: string
      env?: Record<string, string>
      removeEnv?: string[]
      /** null clears it (Settings → Worker size applies). */
      boxSize?: BoxSize | null
      /** null clears it (Settings → Partial clone mirrors applies). */
      partialClone?: boolean | null
      /** null clears it (Settings → Push at turn end applies). */
      pushAtTurnEnd?: boolean | null
      /** null clears it (Settings → Dependency cache applies). */
      depCache?: boolean | null
      /** How its running agents share boxes (shared/memory.ts HEAVY_TASKS). */
      heavyTasks?: HeavyTasks
      /** null clears it (Settings › Max notes applies). */
      notesMaxCount?: number | null
      /** null clears it (Settings › Notes token budget applies). */
      notesMaxTokens?: number | null
    },
  ): Project {
    const current = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    if (!current) throw new NotFoundError(`Project ${id} not found`)
    const env = json<Record<string, string>>(current.env_json, {})
    Object.assign(env, patch.env ?? {})
    for (const k of patch.removeEnv ?? []) delete env[k]
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, repo = ?, base_branch = ?, env_json = ?, box_size = ?, partial_clone = ?, push_at_turn_end = ?, dep_cache = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name?.trim() || current.name,
        patch.description ?? current.description,
        patch.repo === undefined ? current.repo : normalizeRepo(patch.repo),
        patch.baseBranch?.trim() || current.base_branch,
        JSON.stringify(env),
        patch.boxSize === undefined ? current.box_size : patch.boxSize,
        patch.partialClone === undefined ? current.partial_clone : patch.partialClone === null ? null : patch.partialClone ? 1 : 0,
        patch.pushAtTurnEnd === undefined ? current.push_at_turn_end : patch.pushAtTurnEnd === null ? null : patch.pushAtTurnEnd ? 1 : 0,
        patch.depCache === undefined ? (current.dep_cache ?? null) : patch.depCache === null ? null : patch.depCache ? 1 : 0,
        Date.now(),
        id,
      )
    this.setHeavyTasks(id, patch.heavyTasks)
    this.setProjectNotesBudget(id, patch)
    return this.getProject(id)!
  }

  /** undefined leaves it as it is; "off" is stored as NULL. */
  private setHeavyTasks(id: string, v: HeavyTasks | undefined) {
    if (v === undefined) return
    this.db.prepare("UPDATE projects SET heavy_tasks = ? WHERE id = ?").run(v === "off" ? null : normalizeHeavyTasks(v), id)
  }

  /** A project's own notes budget; undefined leaves a value as it is, null clears it. */
  private setProjectNotesBudget(id: string, b: { notesMaxCount?: number | null; notesMaxTokens?: number | null }) {
    if (b.notesMaxCount !== undefined) this.db.prepare("UPDATE projects SET notes_max_count = ? WHERE id = ?").run(b.notesMaxCount, id)
    if (b.notesMaxTokens !== undefined) this.db.prepare("UPDATE projects SET notes_max_tokens = ? WHERE id = ?").run(b.notesMaxTokens, id)
  }

  /**
   * Put every project in this order, in one transaction. `ids` must name each project exactly once,
   * so a list from a stale tab (missing a new project, or naming a deleted one) is refused rather than half-applied.
   */
  reorderProjects(ids: string[]): Project[] {
    this.db.transaction(() => {
      const known = (this.db.prepare("SELECT id FROM projects").all() as { id: string }[]).map((r) => r.id)
      const knownSet = new Set(known)
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) throw new BadRequestError(`Project ${id} is listed twice`)
        seen.add(id)
      }
      const unknown = ids.filter((id) => !knownSet.has(id))
      if (unknown.length) throw new BadRequestError(`Unknown project${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`)
      const missing = known.filter((id) => !seen.has(id))
      if (missing.length) throw new BadRequestError(`The order must list every project; missing ${missing.join(", ")}`)
      const stmt = this.db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?")
      ids.forEach((id, i) => stmt.run(i, id))
    })()
    return this.listProjects()
  }

  deleteProject(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id)
  }

  listNotes(projectId: string): ProjectNote[] {
    const rows = this.db.prepare("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC, rowid ASC").all(projectId) as NoteRow[]
    return rows.map(noteFromRow)
  }

  getNote(id: string): ProjectNote | null {
    const row = this.db.prepare("SELECT * FROM project_notes WHERE id = ?").get(id) as NoteRow | undefined
    return row ? noteFromRow(row) : null
  }

  addNote(projectId: string, author: string, content: string): ProjectNote {
    const now = Date.now()
    const note: ProjectNote = { id: newId("note"), projectId, author, content: content.trim(), createdAt: now, updatedAt: now, updatedBy: null }
    this.db
      .prepare("INSERT INTO project_notes (id, project_id, author, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(note.id, projectId, author, note.content, now, now)
    return note
  }

  updateNote(id: string, content: string, by: string): ProjectNote {
    const res = this.db.prepare("UPDATE project_notes SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(content.trim(), Date.now(), by, id)
    if (!res.changes) throw new NotFoundError(`Note ${id} not found`)
    return this.getNote(id)!
  }

  deleteNote(id: string) {
    this.db.prepare("DELETE FROM project_notes WHERE id = ?").run(id)
  }

  // ---------- note suggestions ----------

  addNoteSuggestion(input: { projectId: string; taskId: string | null; taskTitle: string; content: string; why: string }): NoteSuggestion {
    const s: NoteSuggestion = {
      id: newId("sug"),
      projectId: input.projectId,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      content: input.content.trim(),
      why: input.why.trim(),
      status: "pending",
      noteId: null,
      resolvedBy: null,
      reason: null,
      createdAt: Date.now(),
      resolvedAt: null,
      retroAt: null,
    }
    this.db
      .prepare("INSERT INTO note_suggestions (id, project_id, task_id, task_title, content, why, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(s.id, s.projectId, s.taskId, s.taskTitle, s.content, s.why, s.createdAt)
    return s
  }

  getNoteSuggestion(id: string): NoteSuggestion | null {
    const row = this.db.prepare("SELECT * FROM note_suggestions WHERE id = ?").get(id) as SuggestionRow | undefined
    return row ? suggestionFromRow(row) : null
  }

  /** Oldest first. `unsent` keeps only the ones no retro has handed to the Captain yet. */
  listNoteSuggestions(filter: { projectId?: string; taskId?: string; status?: NoteSuggestionStatus[]; unsent?: boolean; limit?: number } = {}): NoteSuggestion[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.projectId) where.push("project_id = ?"), args.push(filter.projectId)
    if (filter.taskId) where.push("task_id = ?"), args.push(filter.taskId)
    if (filter.status?.length) where.push(`status IN (${filter.status.map(() => "?").join(", ")})`), args.push(...filter.status)
    if (filter.unsent) where.push("retro_at IS NULL")
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM note_suggestions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(...args, filter.limit ?? 500) as SuggestionRow[]
    return rows.map(suggestionFromRow)
  }

  pendingSuggestionCount(projectId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM note_suggestions WHERE project_id = ? AND status = 'pending'").get(projectId) as { n: number }).n
  }

  /** Settle a pending suggestion. Throws a ConflictError when someone already did. */
  resolveNoteSuggestion(id: string, r: { status: Exclude<NoteSuggestionStatus, "pending">; noteId?: string | null; by: string; reason?: string | null }): NoteSuggestion {
    const res = this.db
      .prepare("UPDATE note_suggestions SET status = ?, note_id = ?, resolved_by = ?, reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(r.status, r.noteId ?? null, r.by, r.reason?.trim() || null, Date.now(), id)
    const s = this.getNoteSuggestion(id)
    if (!s) throw new NotFoundError(`Suggestion ${id} not found`)
    if (!res.changes) throw new ConflictError(`Suggestion ${id} was already ${s.status}${s.resolvedBy ? ` by ${s.resolvedBy}` : ""}.`)
    return s
  }

  /** A retro handed these suggestions to the Captain. */
  markSuggestionsInRetro(ids: string[], at = Date.now()) {
    const stmt = this.db.prepare("UPDATE note_suggestions SET retro_at = ? WHERE id = ? AND retro_at IS NULL")
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id)
    })()
  }

  // ---------- tasks ----------

  taskFromRow(row: TaskRow): Task {
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(version), 0) AS v, COALESCE(SUM(status = 'delivering'), 0) AS d, COALESCE(MAX(updated_at), 0) AS t FROM task_inputs WHERE task_id = ? AND status != 'cancelled'",
      )
      .get(row.id) as { n: number; v: number; d: number; t: number }
    const usage = this.taskClaudeTotals(row.id)
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      boxId: row.box_id,
      sessionId: row.session_id,
      branch: row.branch,
      prUrl: row.pr_url,
      prState: row.pr_state ?? null,
      prMergedAt: row.pr_merged_at ?? null,
      prMergedBy: row.pr_merged_by ?? null,
      previews: json<PreviewLink[]>(row.previews_json, []),
      question: row.question,
      summary: row.summary,
      activity: row.summary === null ? this.taskActivity(row.id) : null,
      error: row.error,
      waitReason: row.status === "queued" ? (row.wait_reason ?? null) : null,
      waitBoxSize: row.status === "queued" && row.wait_reason && row.wait_box_size ? normalizeBoxSize(row.wait_box_size) : null,
      turnCount: row.turn_count,
      pendingCount: pending.n,
      queueRev: pending.n ? `${pending.n}.${pending.v}.${pending.d}.${pending.t}` : "",
      lastArchivedAt: row.last_archived_at,
      scheduleId: row.schedule_id ?? null,
      outcome: parseOutcome(row.outcome),
      contextTokens: row.context_tokens ?? null,
      contextWindow: row.context_window ?? null,
      compactPending: Boolean(row.compact_pending),
      compacting: Boolean(row.compacting),
      model: row.model ?? null,
      effort: row.effort ?? null,
      claudeCostUsd: usage.costUsd,
      claudeTokens: usage.totalTokens,
      routingRule: row.routing_rule ?? null,
      routingReason: row.routing_reason ?? null,
      mergeRequest: publicMergeRequest(this.mergeRequestOf(row)),
      pushState: json<PushState | null>(row.push_state_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * The task's merge request while it is still pending: for the PR the task has now, and either delivered in a
   * turn or still queued (Stop and Close drop queued messages, and the request with them).
   */
  mergeRequestOf(row: TaskRow): StoredMergeRequest | null {
    const req = json<StoredMergeRequest | null>(row.merge_request_json, null)
    if (!req || req.prUrl !== row.pr_url) return null
    if (req.deliveredAt === null && !this.db.prepare("SELECT 1 FROM task_inputs WHERE id = ? AND status != 'cancelled'").get(req.inputId)) return null
    return req
  }

  /** The latest assistant or tool message that makes a card line (see shared/activity.ts). */
  taskActivity(taskId: string): string | null {
    const rows = this.db
      .prepare("SELECT role, content, meta_json FROM task_messages WHERE task_id = ? AND role IN ('assistant', 'tool') ORDER BY created_at DESC, rowid DESC LIMIT 5")
      .all(taskId) as { role: string; content: string; meta_json: string | null }[]
    for (const r of rows) {
      const line = activityLine(r.role, r.content, json(r.meta_json, null))
      if (line) return line
    }
    return null
  }

  getTaskRow(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null
  }

  getTask(id: string): Task | null {
    const row = this.getTaskRow(id)
    return row ? this.taskFromRow(row) : null
  }

  listTasks(filter: { projectId?: string; status?: TaskStatus[] } = {}): Task[] {
    return this.listTaskRows(filter).map((r) => this.taskFromRow(r))
  }

  listTaskRows(filter: { projectId?: string; status?: TaskStatus[]; boxId?: string } = {}): TaskRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.projectId) {
      where.push("project_id = ?")
      args.push(filter.projectId)
    }
    if (filter.boxId) {
      where.push("box_id = ?")
      args.push(filter.boxId)
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`)
      args.push(...filter.status)
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`
    return this.db.prepare(sql).all(...args) as TaskRow[]
  }

  /** Tasks whose pull request may still change: it has a URL and isn't merged or closed yet. */
  listOpenPrRows(ids?: string[]): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE pr_url IS NOT NULL AND pr_url != '' AND (pr_state IS NULL OR pr_state IN ('open', 'draft')) ORDER BY created_at ASC")
      .all() as TaskRow[]
    return ids ? rows.filter((r) => ids.includes(r.id)) : rows
  }

  createTask(input: {
    id?: string
    projectId: string
    title: string
    prompt: string
    env?: Record<string, string>
    branch?: string | null
    scheduleId?: string | null
    model?: string | null
    effort?: Effort | null
    routingRule?: string | null
    routingReason?: string | null
    /** Who started it (TaskRow.source). */
    startedBy?: string | null
  }): Task {
    const now = Date.now()
    const id = input.id ?? newId("task")
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, prompt, status, session_id, branch, env_json, schedule_id, model, effort, routing_rule, routing_reason, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title.trim(),
        input.prompt,
        randomUUID(),
        input.branch ?? null,
        JSON.stringify(input.env ?? {}),
        input.scheduleId ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.routingRule ?? null,
        input.routingReason ?? null,
        now,
        now,
        now,
      )
    // Its own statement, so the insert above also works on schemas from before the column (migration tests).
    if (input.startedBy) this.db.prepare("UPDATE tasks SET source = ? WHERE id = ?").run(input.startedBy, id)
    return this.getTask(id)!
  }

  startTaskTurn(input: {
    id: string
    taskId: string
    turnIndex: number
    model: string | null
    effort: Effort | null
    routingRule: string | null
    routingReason: string | null
    status?: string
  }) {
    this.db
      .prepare(
        `INSERT INTO task_turns (id, task_id, turn_index, model, effort, routing_rule, routing_reason, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model = excluded.model,
           effort = excluded.effort,
           routing_rule = excluded.routing_rule,
           routing_reason = excluded.routing_reason,
           status = excluded.status`,
      )
      .run(input.id, input.taskId, input.turnIndex, input.model, input.effort, input.routingRule, input.routingReason, input.status ?? "started", Date.now())
  }

  finishTaskTurn(id: string, patch: { status: string; costUsd?: number | null; error?: string | null }) {
    this.db
      .prepare("UPDATE task_turns SET status = ?, finished_at = ?, cost_usd = ?, error = ? WHERE id = ?")
      .run(patch.status, Date.now(), patch.costUsd ?? null, patch.error ?? null, id)
  }

  getTaskTurn(id: string): TaskTurnRow | null {
    return (this.db.prepare("SELECT * FROM task_turns WHERE id = ?").get(id) as TaskTurnRow | undefined) ?? null
  }

  listTaskTurns(taskId: string): TaskTurnRow[] {
    return this.db.prepare("SELECT * FROM task_turns WHERE task_id = ? ORDER BY started_at ASC").all(taskId) as TaskTurnRow[]
  }

  taskEnv(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT env_json FROM tasks WHERE id = ?").get(id) as { env_json: string } | undefined
    return json(row?.env_json, {})
  }

  turnFlags(row: TaskRow): TurnFlags {
    return json<TurnFlags>(row.turn_flags_json, {})
  }

  /**
   * `quiet` skips the notification for a status change Cody caused themselves (stop, close).
   * Compaction turns never notify: they hand back the status from before the compaction.
   * `touch: false` keeps updated_at (the "last active" time) as it was.
   */
  updateTask(id: string, patch: TaskPatch, opts: { quiet?: boolean; touch?: boolean } = {}): Task {
    const before =
      patch.status !== undefined && !opts.quiet
        ? (this.db.prepare("SELECT status, compacting FROM tasks WHERE id = ?").get(id) as { status: TaskStatus; compacting: number } | undefined)
        : undefined
    const sets: string[] = []
    const args: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${TASK_COLUMNS[key]} = ?`)
      if (key === "previews" || key === "turnFlags" || key === "prLabels") args.push(JSON.stringify(value))
      else if (key === "mergeRequest" || key === "pushState") args.push(value === null ? null : JSON.stringify(value))
      else if (key === "sessionStarted" || key === "compactPending" || key === "compacting") args.push(value ? 1 : 0)
      else args.push(value)
    }
    if (opts.touch !== false) {
      sets.push("updated_at = ?")
      args.push(Date.now())
    }
    if (!sets.length) sets.push("id = id")
    args.push(id)
    const res = this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    if (res.changes === 0) throw new NotFoundError(`Task ${id} not found`)
    const task = this.getTask(id)!
    if (before && !before.compacting && shouldNotify(before.status, task.status) && !isQuietRun(task)) this.addNotification(task)
    return task
  }

  deleteTask(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  }

  // ---------- compaction history ----------

  private compactionTaskFromRow(r: OrchestratorCompactionTaskRow): CompactionTaskSnapshot {
    return {
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      projectId: r.project_id,
      projectName: r.project_name,
      branch: r.branch,
      prUrl: r.pr_url,
      sessionId: r.session_id,
      summary: r.summary,
      lastActiveAt: r.last_active_at,
    }
  }

  private taskRowsForCompaction(id: string): CompactionTaskSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestrator_compaction_tasks WHERE compaction_id = ? ORDER BY last_active_at DESC, task_id ASC")
      .all(id) as OrchestratorCompactionTaskRow[]
    return rows.map((r) => this.compactionTaskFromRow(r))
  }

  private orchestratorCompactionFromRow(row: OrchestratorCompactionRow, includeMarkdown = false, includeTasks = true): OrchestratorCompactionRecord {
    const tasks = includeTasks ? this.taskRowsForCompaction(row.id) : []
    return {
      id: row.id,
      at: row.at,
      sessionId: row.session_id,
      model: row.model,
      trigger: row.trigger,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      file: row.markdown_path,
      jsonFile: row.json_path,
      taskCount: row.task_count ?? tasks.length,
      tasks,
      ...(includeMarkdown ? { markdown: row.markdown } : {}),
    }
  }

  addOrchestratorCompaction(input: {
    id: string
    at: number
    sessionId: string
    model: string
    trigger: "button" | "auto"
    tokensBefore: number | null
    tokensAfter?: number | null
    markdownPath: string
    jsonPath: string
    markdown: string
    tasks: CompactionTaskSnapshot[]
  }): OrchestratorCompactionRecord {
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO orchestrator_compactions
           (id, at, session_id, model, trigger, tokens_before, tokens_after, markdown_path, json_path, markdown, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.at, input.sessionId, input.model, input.trigger, input.tokensBefore, input.tokensAfter ?? null, input.markdownPath, input.jsonPath, input.markdown, now)
      this.db.prepare("DELETE FROM orchestrator_compaction_tasks WHERE compaction_id = ?").run(input.id)
      const stmt = this.db.prepare(
        `INSERT INTO orchestrator_compaction_tasks
         (compaction_id, task_id, title, status, project_id, project_name, branch, pr_url, session_id, summary, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const t of input.tasks) {
        stmt.run(input.id, t.taskId, t.title, t.status, t.projectId, t.projectName, t.branch, t.prUrl, t.sessionId, t.summary, t.lastActiveAt)
      }
    })()
    return this.getOrchestratorCompaction(input.id, true)!
  }

  finishOrchestratorCompaction(id: string, tokensAfter: number | null, markdown?: string) {
    const sets = ["tokens_after = ?"]
    const args: unknown[] = [tokensAfter]
    if (markdown !== undefined) {
      sets.push("markdown = ?")
      args.push(markdown)
    }
    args.push(id)
    this.db.prepare(`UPDATE orchestrator_compactions SET ${sets.join(", ")} WHERE id = ?`).run(...args)
  }

  listOrchestratorCompactions(filter: { taskId?: string; limit?: number } = {}): OrchestratorCompactionRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const rows = filter.taskId
      ? (this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM orchestrator_compaction_tasks ct WHERE ct.compaction_id = c.id) AS task_count
             FROM orchestrator_compactions c
             JOIN orchestrator_compaction_tasks ct ON ct.compaction_id = c.id
             WHERE ct.task_id = ?
             ORDER BY c.at DESC
             LIMIT ?`,
          )
          .all(filter.taskId, limit) as OrchestratorCompactionRow[])
      : (this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM orchestrator_compaction_tasks ct WHERE ct.compaction_id = c.id) AS task_count
             FROM orchestrator_compactions c
             ORDER BY c.at DESC
             LIMIT ?`,
          )
          .all(limit) as OrchestratorCompactionRow[])
    return rows.map((r) => this.orchestratorCompactionFromRow(r, false, true))
  }

  getOrchestratorCompaction(id: string, includeMarkdown = true): OrchestratorCompactionRecord | null {
    const row = this.db.prepare("SELECT * FROM orchestrator_compactions WHERE id = ?").get(id) as OrchestratorCompactionRow | undefined
    return row ? this.orchestratorCompactionFromRow(row, includeMarkdown, true) : null
  }

  private taskCompactionFromRow(r: TaskCompactionRow): TaskCompactionRecord {
    return {
      id: r.id,
      taskId: r.task_id,
      sessionId: r.session_id,
      at: r.at,
      statusBefore: r.status_before,
      statusAfter: r.status_after,
      tokensBefore: r.tokens_before,
      tokensAfter: r.tokens_after,
      summary: r.summary,
      archivePath: r.archive_path,
      archiveAvailable: Boolean(r.archive_available),
      archiveNote: r.archive_note,
    }
  }

  addTaskCompaction(input: {
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
    archiveNote?: string | null
  }): TaskCompactionRecord {
    const id = newId("tc")
    this.db
      .prepare(
        `INSERT INTO task_compactions
         (id, task_id, session_id, at, status_before, status_after, tokens_before, tokens_after, summary, archive_path, archive_available, archive_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.sessionId,
        input.at,
        input.statusBefore,
        input.statusAfter,
        input.tokensBefore,
        input.tokensAfter,
        input.summary,
        input.archivePath,
        input.archiveAvailable ? 1 : 0,
        input.archiveNote ?? null,
        Date.now(),
      )
    return this.getTaskCompaction(id)!
  }

  listTaskCompactions(filter: { taskId?: string; sessionId?: string; limit?: number } = {}): TaskCompactionRecord[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.taskId) {
      where.push("task_id = ?")
      args.push(filter.taskId)
    }
    if (filter.sessionId) {
      where.push("session_id = ?")
      args.push(filter.sessionId)
    }
    args.push(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    const rows = this.db
      .prepare(`SELECT * FROM task_compactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`)
      .all(...args) as TaskCompactionRow[]
    return rows.map((r) => this.taskCompactionFromRow(r))
  }

  getTaskCompaction(id: string): TaskCompactionRecord | null {
    const row = this.db.prepare("SELECT * FROM task_compactions WHERE id = ?").get(id) as TaskCompactionRow | undefined
    return row ? this.taskCompactionFromRow(row) : null
  }

  updateTaskCompactionArchive(id: string, archivePath: string | null, archiveAvailable: boolean, archiveNote: string | null = null) {
    this.db
      .prepare("UPDATE task_compactions SET archive_path = ?, archive_available = ?, archive_note = ? WHERE id = ?")
      .run(archivePath, archiveAvailable ? 1 : 0, archiveNote, id)
  }

  noteTaskArchiveUnavailable(taskId: string, archivePath: string | null, note: string, at = Date.now()) {
    this.db
      .prepare(
        `UPDATE task_compactions
         SET archive_available = 0,
             archive_note = CASE WHEN archive_note IS NULL OR archive_note = '' THEN ? ELSE archive_note || '; ' || ? END
         WHERE task_id = ? AND (? IS NULL OR archive_path = ?) AND (archive_available = 1 OR archive_note IS NULL)`,
      )
      .run(`${new Date(at).toISOString()}: ${note}`, `${new Date(at).toISOString()}: ${note}`, taskId, archivePath, archivePath)
  }

  // pending inputs: messages for a task that wait for its next turn

  /**
   * Returns the input's id. `prefix` goes before the content in the agent's prompt only (a hook's label);
   * `message` is the transcript line's meta, written when the message is delivered (none for agent/system messages).
   */
  queueInput(taskId: string, source: string, content: string, attachments: string[] = [], opts: { prefix?: string; message?: Record<string, unknown> } = {}): string {
    const id = newId("in")
    const now = Date.now()
    this.db
      .prepare("INSERT INTO task_inputs (id, task_id, source, content, attachments, prefix, message_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, source, content, attachments.length ? JSON.stringify(attachments) : null, opts.prefix ?? "", opts.message ? JSON.stringify(opts.message) : null, now, now)
    return id
  }

  /** Queued inputs (not claimed by a starting turn, not cancelled), oldest first, as the agent gets them. */
  peekInputs(taskId: string): PendingInput[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status = 'queued' ${INPUT_ORDER}`)
      .all(taskId) as InputRow[]
    return rows.map(pendingInput)
  }

  /**
   * Claim every queued input for the turn `turnId` that is starting (status delivering): from now on they can't
   * be edited or cancelled. deliverInputs removes them once the turn has started, releaseInputs hands them back
   * if it couldn't. Also drops inputs cancelled long enough ago that Undo is over.
   */
  claimInputs(taskId: string, turnId: string): PendingInput[] {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_inputs WHERE task_id = ? AND status = 'cancelled' AND updated_at < ?").run(taskId, Date.now() - CANCELLED_INPUT_KEEP_MS)
      // A hand-off the last turn didn't take (see lockInput) goes in with this one.
      this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE task_id = ? AND status = 'delivering' AND claim LIKE 'handoff:%'").run(taskId)
      this.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = ? WHERE task_id = ? AND status = 'queued'").run(turnId, taskId)
      return (this.db.prepare(`SELECT * FROM task_inputs WHERE claim = ? AND status = 'delivering' ${INPUT_ORDER}`).all(turnId) as InputRow[]).map(pendingInput)
    })()
  }

  /** The turn started: remove its claimed inputs and write their transcript lines, all at once. */
  deliverInputs(turnId: string): TaskMessage[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM task_inputs WHERE claim = ? AND status = 'delivering' ${INPUT_ORDER}`).all(turnId) as InputRow[]
      this.db.prepare("DELETE FROM task_inputs WHERE claim = ? AND status = 'delivering'").run(turnId)
      // meta.queuedAt: when it was sent, like the chats' queued messages (see deliverQueued).
      return rows.flatMap((r) =>
        r.message_json ? [this.addTaskMessage(r.task_id, "user", r.content, { ...(JSON.parse(r.message_json) as Record<string, unknown>), queuedAt: r.created_at })] : [],
      )
    })()
  }

  /**
   * The input was handed to the agent mid-turn (a Captain's reply to an agent waiting on message_captain): lock it
   * like a turn's claim, so an edit can't be lost, until the agent takes it (takeInput) or the turn ends without
   * taking it (releaseInputs(claim), or the next claimInputs). False when it isn't queued any more.
   */
  lockInput(taskId: string, id: string, claim: string): boolean {
    return this.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = ? WHERE id = ? AND task_id = ? AND status = 'queued'").run(claim, id, taskId).changes > 0
  }

  /**
   * The agent took this input mid-turn (see lockInput): remove it and write its transcript line, as deliverInputs
   * would. Compare-and-set: only while it is queued or locked by a hand-off; null when cancelled, claimed by a
   * turn or gone.
   */
  takeInput(taskId: string, id: string): { message: TaskMessage | null } | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM task_inputs WHERE id = ? AND task_id = ? AND (status = 'queued' OR (status = 'delivering' AND claim LIKE 'handoff:%'))")
        .get(id, taskId) as InputRow | undefined
      if (!row) return null
      this.db.prepare("DELETE FROM task_inputs WHERE id = ?").run(id)
      const message = row.message_json ? this.addTaskMessage(taskId, "user", row.content, { ...(JSON.parse(row.message_json) as Record<string, unknown>), queuedAt: row.created_at }) : null
      return { message }
    })()
  }

  /** The turn couldn't start: its claimed inputs are queued (and editable) again. Without a turn id: every claim (startup). */
  releaseInputs(turnId?: string) {
    if (turnId) this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE claim = ? AND status = 'delivering'").run(turnId)
    else this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE status = 'delivering'").run()
  }

  /** What the task page shows: queued and delivering inputs, in send order. */
  listQueuedInputs(taskId: string): QueuedInputRow[] {
    return (this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status IN ('queued', 'delivering') ${INPUT_ORDER}`).all(taskId) as InputRow[]).map(queuedInputRow)
  }

  getQueuedInput(taskId: string, id: string): QueuedInputRow | null {
    const row = this.db.prepare("SELECT * FROM task_inputs WHERE id = ? AND task_id = ?").get(id, taskId) as InputRow | undefined
    return row ? queuedInputRow(row) : null
  }

  /**
   * Replace a queued input's text, only while it is still queued (and at `version`, when given). Compare-and-set
   * against the delivery claim: an input a turn already took is never changed.
   */
  editInput(taskId: string, id: string, content: string, version?: number): InputChange {
    const res = this.db
      .prepare("UPDATE task_inputs SET content = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'queued' AND (? IS NULL OR version = ?)")
      .run(content, Date.now(), id, taskId, version ?? null, version ?? null)
    return this.inputChange(taskId, id, res.changes > 0)
  }

  /** Cancel a queued input (kept a while for Undo). Compare-and-set like editInput. */
  cancelInput(taskId: string, id: string): InputChange {
    const res = this.db
      .prepare("UPDATE task_inputs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'queued'")
      .run(Date.now(), id, taskId)
    return this.inputChange(taskId, id, res.changes > 0)
  }

  /** Undo a cancel: the input is queued again, in its old place. */
  restoreInput(taskId: string, id: string): InputChange {
    const res = this.db
      .prepare("UPDATE task_inputs SET status = 'queued', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'cancelled'")
      .run(Date.now(), id, taskId)
    return this.inputChange(taskId, id, res.changes > 0)
  }

  private inputChange(taskId: string, id: string, ok: boolean): InputChange {
    const row = this.getQueuedInput(taskId, id)
    return ok && row ? { ok: true, row } : { ok: false, row }
  }

  /**
   * The task stopped or closed before a turn read its queue: drop every input. The messages from people get their
   * transcript line anyway, marked undelivered, so nothing Cody sent just vanishes. Returns those lines.
   */
  dropInputs(taskId: string): TaskMessage[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status != 'cancelled' ${INPUT_ORDER}`).all(taskId) as InputRow[]
      this.db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(taskId)
      return rows.flatMap((r) =>
        r.message_json ? [this.addTaskMessage(taskId, "user", r.content, { ...(JSON.parse(r.message_json) as Record<string, unknown>), undelivered: true })] : [],
      )
    })()
  }

  /** Drop every input, without transcript lines (see dropInputs for the stop/close path). */
  clearInputs(taskId: string) {
    this.db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(taskId)
  }

  /** Inputs waiting for a turn (queued or being delivered; cancelled ones don't count). */
  hasInputs(taskId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_inputs WHERE task_id = ? AND status != 'cancelled' LIMIT 1").get(taskId))
  }

  // ---------- queued messages ----------
  //
  // (Task feedback waits in task_inputs instead and gets its transcript line at delivery; see claimInputs.)
  // A message sent while the Coordinator or a Captain is mid-turn waits for the next turn. It is stored
  // right away with meta.queued, and the UI shows it under the live turn, labelled "Queued". When the turn that
  // reads it starts, deliverQueued moves it to that moment (created_at = delivery, meta.queuedAt = when it was
  // sent), so it sits right before that turn's output, after the reply it was typed over, and stays there after a reload.

  /**
   * Deliver these queued messages now; returns the ones that moved, with their new createdAt and meta. `thread`
   * names the Captain's project or the task, for captain_messages and task_messages.
   */
  deliverQueued(
    table: "chat_messages" | "captain_messages" | "task_messages",
    ids: string[],
    thread?: string,
    now = Date.now(),
  ): { id: string; createdAt: number; meta: Record<string, unknown> }[] {
    if (!ids.length) return []
    const scope = table === "captain_messages" ? "WHERE project_id = ?" : table === "task_messages" ? "WHERE task_id = ?" : ""
    return this.db.transaction(() => {
      // Strictly after everything already in the thread (the previous turn may have ended in this very millisecond).
      // Later rows that tie still sort after it, by rowid.
      const last = (this.db.prepare(`SELECT MAX(created_at) AS t FROM ${table} ${scope}`).get(...(scope ? [thread] : [])) as { t: number | null }).t ?? 0
      const at = Math.max(now, last + 1)
      const get = this.db.prepare(`SELECT meta_json, created_at FROM ${table} WHERE id = ?`)
      const set = this.db.prepare(`UPDATE ${table} SET meta_json = ?, created_at = ? WHERE id = ?`)
      const moved: { id: string; createdAt: number; meta: Record<string, unknown> }[] = []
      for (const id of ids) {
        const r = get.get(id) as { meta_json: string | null; created_at: number } | undefined
        const prev = json<Record<string, unknown> | null>(r?.meta_json, null)
        if (!r || !prev?.queued) continue
        const { queued: _, ...rest } = prev
        const meta = { ...rest, queuedAt: r.created_at }
        set.run(JSON.stringify(meta), at, id)
        moved.push({ id, createdAt: at, meta })
      }
      return moved
    })()
  }

  /** Ids of Coordinator chat messages still waiting for a turn (after a restart, say). */
  queuedChatIds(): string[] {
    return (this.db.prepare("SELECT id FROM chat_messages WHERE json_extract(meta_json, '$.queued') = 1 ORDER BY created_at ASC, rowid ASC").all() as { id: string }[]).map((r) => r.id)
  }

  // Cody can edit or delete a queued Coordinator/Captain message until the turn that reads it takes it. Each change
  // is a compare-and-set on meta.queued, which deliverQueued clears in the same tick the turn reads the messages,
  // so a change lands either before the read (the turn sees it) or not at all ("delivered"). Deleting is soft
  // (meta.cancelled, queued cleared) so Undo can bring it back; turns skip cancelled messages.

  /** `thread`: the Captain's project, for captain_messages. */
  editQueuedChat(table: QueuedChatTable, id: string, thread: string | null, content: string): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row?.meta.queued) return this.queuedChatRefusal(row)
      if (!content.trim() && !(row.meta.attachments as unknown[] | undefined)?.length) throw new BadRequestError("message is empty")
      this.db.prepare(`UPDATE ${table} SET content = ? WHERE id = ?`).run(content, id)
      return { ok: true, row: { ...row, content } }
    })()
  }

  cancelQueuedChat(table: QueuedChatTable, id: string, thread: string | null): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row?.meta.queued) return this.queuedChatRefusal(row)
      const { queued: _, ...rest } = row.meta
      const meta = { ...rest, cancelled: true }
      this.db.prepare(`UPDATE ${table} SET meta_json = ? WHERE id = ?`).run(JSON.stringify(meta), id)
      return { ok: true, row: { ...row, meta } }
    })()
  }

  /**
   * Undo a delete: the message waits again (`queued` while a turn runs) and moves to `at`, so the next turn's
   * "since the last turn" picks it up even if a turn ran meanwhile.
   */
  restoreQueuedChat(table: QueuedChatTable, id: string, thread: string | null, { queued, at }: { queued: boolean; at: number }): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row) return { ok: false, reason: "missing" }
      if (!row.meta.cancelled) return { ok: false, reason: row.meta.queued ? "deleted" : "delivered" }
      const { cancelled: _, ...rest } = row.meta
      const meta = { ...rest, ...(queued ? { queued: true } : {}) }
      this.db.prepare(`UPDATE ${table} SET meta_json = ?, created_at = ? WHERE id = ?`).run(JSON.stringify(meta), at, id)
      return { ok: true, row: { ...row, meta, createdAt: at } }
    })()
  }

  private queuedChatRow(table: QueuedChatTable, id: string, thread: string | null): QueuedChatRow | null {
    const r = (
      table === "captain_messages"
        ? this.db.prepare("SELECT id, content, meta_json, created_at FROM captain_messages WHERE id = ? AND project_id = ? AND role = 'user'").get(id, thread)
        : this.db.prepare("SELECT id, content, meta_json, created_at FROM chat_messages WHERE id = ? AND role = 'user'").get(id)
    ) as { id: string; content: string; meta_json: string | null; created_at: number } | undefined
    return r ? { id: r.id, content: r.content, meta: json<Record<string, unknown>>(r.meta_json, {}) ?? {}, createdAt: r.created_at } : null
  }

  private queuedChatRefusal(row: QueuedChatRow | null): QueuedChatChange {
    return { ok: false, reason: !row ? "missing" : row.meta.cancelled ? "deleted" : "delivered" }
  }

  // ---------- task transcript ----------

  addTaskMessage(
    taskId: string,
    role: TaskMessageRole,
    content: string,
    meta: Record<string, unknown> | null = null,
  ): TaskMessage {
    const msg: TaskMessage = { id: newId("tm"), taskId, role, content, meta, createdAt: Date.now() }
    this.db
      .prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(msg.id, taskId, role, content, meta ? JSON.stringify(meta) : null, msg.createdAt)
    return msg
  }

  listTaskMessages(taskId: string, limit = 500): TaskMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM task_messages WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(taskId, limit) as {
      id: string
      task_id: string
      role: TaskMessageRole
      content: string
      meta_json: string | null
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  // ---------- orchestrator chat ----------

  addChat(role: ChatRole, content: string, meta: Record<string, unknown> | null = null, id?: string): ChatMessage {
    const msg: ChatMessage = { id: id ?? newId("chat"), role, content, meta, createdAt: Date.now() }
    // User messages and the orchestrator's own words are already "seen" by it.
    const seen = role === "notice" ? 0 : 1
    this.db
      .prepare(
        "INSERT INTO chat_messages (id, role, content, meta_json, seen_by_orchestrator, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(msg.id, role, content, meta ? JSON.stringify(meta) : null, seen, msg.createdAt)
    return msg
  }

  /** Replace a chat message's meta (e.g. a tool line learning the id it created). */
  setChatMeta(id: string, meta: Record<string, unknown>): ChatMessage | null {
    this.db.prepare("UPDATE chat_messages SET meta_json = ? WHERE id = ?").run(JSON.stringify(meta), id)
    const r = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
      | { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }
      | undefined
    return r ? { id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at } : null
  }

  listChat(limit = 300): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC`,
      )
      .all(limit) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  listChatSince(since: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_messages WHERE created_at > ? ORDER BY created_at ASC, rowid ASC")
      .all(since) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  /** Notices the orchestrator has not been told about yet; marks them seen. */
  takeUnseenNotices(): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT content FROM chat_messages WHERE seen_by_orchestrator = 0 ORDER BY created_at ASC")
        .all() as { content: string }[]
      this.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0").run()
      return rows.map((r) => r.content)
    })()
  }

  /** Task ids of notices the orchestrator hasn't seen (null for notices not about a task). */
  unseenNoticeTasks(): (string | null)[] {
    const rows = this.db
      .prepare("SELECT json_extract(meta_json, '$.taskId') AS task_id FROM chat_messages WHERE seen_by_orchestrator = 0")
      .all() as { task_id: string | null }[]
    return rows.map((r) => r.task_id)
  }

  hasUnseenNotices(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM chat_messages WHERE seen_by_orchestrator = 0 LIMIT 1").get())
  }

  /** Mark notices about these tasks as seen (the orchestrator already looked at the tasks). */
  markNoticesSeen(taskIds: string[]) {
    if (!taskIds.length) return
    const stmt = this.db.prepare(
      "UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?",
    )
    this.db.transaction(() => {
      for (const id of taskIds) stmt.run(id)
    })()
  }

  // ---------- project captains ----------

  addCaptainMessage(projectId: string, role: ChatRole, content: string, meta: Record<string, unknown> | null = null, id?: string): CaptainMessage {
    if (!this.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
    const msg: CaptainMessage = { id: id ?? newId("cap"), projectId, role, content, meta, createdAt: Date.now() }
    const seen = role === "notice" ? 0 : 1
    this.db
      .prepare(
        "INSERT INTO captain_messages (id, project_id, role, content, meta_json, seen_by_captain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(msg.id, projectId, role, content, meta ? JSON.stringify(meta) : null, seen, msg.createdAt)
    return msg
  }

  listCaptainMessages(projectId: string, limit = 300): CaptainMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM captain_messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(projectId, limit) as { id: string; project_id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  takeUnseenCaptainNotices(projectId: string): string[] {
    return this.takeUnseenCaptainNoticeEntries(projectId).map((n) => n.content)
  }

  peekUnseenCaptainNotices(projectId: string): string[] {
    return this.peekUnseenCaptainNoticeEntries(projectId).map((n) => n.content)
  }

  /**
   * Unseen notices with the key the Captain's WakeLoopGuard counts them by: meta.loopKey when the notice has one
   * (a notes retro is keyed by its tasks, since its text changes every time), else the text itself.
   */
  takeUnseenCaptainNoticeEntries(projectId: string): CaptainNoticeEntry[] {
    return this.db.transaction(() => {
      const entries = this.peekUnseenCaptainNoticeEntries(projectId)
      this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE project_id = ? AND seen_by_captain = 0").run(projectId)
      return entries
    })()
  }

  peekUnseenCaptainNoticeEntries(projectId: string): CaptainNoticeEntry[] {
    const rows = this.db
      .prepare("SELECT content, meta_json FROM captain_messages WHERE project_id = ? AND seen_by_captain = 0 ORDER BY created_at ASC, rowid ASC")
      .all(projectId) as { content: string; meta_json: string | null }[]
    return rows.map((r) => {
      const meta = json<Record<string, unknown> | null>(r.meta_json, null)
      const loopKey = typeof meta?.loopKey === "string" && meta.loopKey ? meta.loopKey : r.content
      return { content: r.content, loopKey, meta }
    })
  }

  unseenCaptainNoticeTasks(projectId: string): (string | null)[] {
    const rows = this.db
      .prepare("SELECT json_extract(meta_json, '$.taskId') AS task_id FROM captain_messages WHERE project_id = ? AND seen_by_captain = 0")
      .all(projectId) as { task_id: string | null }[]
    return rows.map((r) => r.task_id)
  }

  markCaptainNoticesSeen(projectId: string, taskIds: string[]) {
    if (!taskIds.length) return
    const stmt = this.db.prepare(
      "UPDATE captain_messages SET seen_by_captain = 1 WHERE project_id = ? AND seen_by_captain = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?",
    )
    this.db.transaction(() => {
      for (const id of taskIds) stmt.run(projectId, id)
    })()
  }

  /**
   * A quiet run's notices (like "Schedule … started a run") are never forwarded: mark every unseen one about
   * the task as seen, for its Captain and for the Coordinator, so neither wakes up or reads them later.
   */
  dropTaskNotices(taskId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE seen_by_captain = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").run(taskId)
      this.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").run(taskId)
    })()
  }

  /** Whether the task's agent ever asked Cody something (the "Asked Cody" events). */
  taskEverAsked(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_messages WHERE task_id = ? AND role = 'event' AND json_extract(meta_json, '$.kind') = 'question' LIMIT 1").get(taskId))
  }

  markCaptainMessageSeen(id: string) {
    this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE id = ?").run(id)
  }

  // ---------- artifacts ----------

  addArtifact(input: Omit<Artifact, "id" | "createdAt" | "url"> & { path: string; id?: string }): Artifact {
    // Workers pick the id themselves so they can hand out the URL right away.
    const id = input.id && /^art_[a-f0-9]{12}$/.test(input.id) && !this.getArtifact(input.id) ? input.id : newId("art")
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, task_id, title, filename, mime, size, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.taskId, input.title, input.filename, input.mime, input.size, input.path, createdAt)
    return this.getArtifact(id)!
  }

  private artifactFromRow(r: {
    id: string
    project_id: string | null
    task_id: string | null
    title: string
    filename: string
    mime: string
    size: number
    created_at: number
  }): Artifact {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      title: r.title,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      url: `/artifacts/${r.id}/${encodeURIComponent(r.filename)}`,
      createdAt: r.created_at,
    }
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any
    return row ? this.artifactFromRow(row) : null
  }

  artifactPath(id: string): string | null {
    const row = this.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as { path: string } | undefined
    return row?.path ?? null
  }

  listArtifacts(filter: { projectId?: string; taskId?: string } = {}): Artifact[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.projectId) {
      where.push("project_id = ?")
      args.push(filter.projectId)
    }
    if (filter.taskId) {
      where.push("task_id = ?")
      args.push(filter.taskId)
    }
    const rows = this.db
      .prepare(`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`)
      .all(...args) as any[]
    return rows.map((r) => this.artifactFromRow(r))
  }

  // ---------- usage and costs ----------

  /**
   * Log one Claude CLI run and return the cost charged to it. `costUsd` is the CLI's
   * `total_cost_usd`, which is the session's running total (a resumed session starts
   * from the total its transcript saved), so the run is charged the step from the
   * session's previous report. A lower report means the total was reset; then the
   * report is the run's own cost.
   */
  recordClaudeUsage(input: {
    source: ClaudeUsageSource
    runKind: string
    taskId?: string | null
    projectId?: string | null
    turnId?: string | null
    sessionId?: string | null
    model?: string | null
    startedAt: number
    endedAt: number
    durationMs?: number | null
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens?: number
    } | null
    costUsd?: number | null
    /** The run resumed an existing session (so its report includes the session's earlier spend). */
    resumed?: boolean
  }) {
    const u = input.usage ?? {}
    const inputTokens = intToken(u.input_tokens)
    const cacheCreation = intToken(u.cache_creation_input_tokens)
    const cacheRead = intToken(u.cache_read_input_tokens)
    const outputTokens = intToken(u.output_tokens)
    const totalTokens = inputTokens + cacheCreation + cacheRead + outputTokens
    const reportedUsd = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0
    // Some CLI runs report only cost, or only duration. Keep those rows too.
    if (totalTokens <= 0 && reportedUsd <= 0 && !(input.durationMs && input.durationMs > 0)) return 0
    const { costUsd, estimated } = this.runCost({ sessionId: input.sessionId ?? null, reportedUsd, totalTokens, model: input.model ?? null, resumed: Boolean(input.resumed) })
    this.db
      .prepare(
        `INSERT INTO claude_usage
          (id, source, run_kind, task_id, project_id, turn_id, session_id, model, started_at, ended_at, duration_ms,
           input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, cost_estimated, raw_usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("cu"),
        input.source,
        input.runKind,
        input.taskId ?? null,
        input.projectId ?? null,
        input.turnId ?? null,
        input.sessionId ?? null,
        input.model ?? null,
        input.startedAt,
        input.endedAt,
        Math.max(0, Math.round(input.durationMs ?? input.endedAt - input.startedAt)),
        inputTokens,
        cacheCreation,
        cacheRead,
        outputTokens,
        totalTokens,
        costUsd,
        reportedUsd,
        estimated ? 1 : 0,
        JSON.stringify(u),
      )
    return costUsd
  }

  /**
   * This run's share of a session's running cost total (see recordClaudeUsage). With no
   * earlier report for a resumed session, the report also holds spend from before Box Yard
   * logged the session, so the run is charged its tokens at the model's recent rate instead.
   */
  private runCost(r: { sessionId: string | null; reportedUsd: number; totalTokens: number; model: string | null; resumed: boolean }): { costUsd: number; estimated: boolean } {
    if (!r.sessionId || r.reportedUsd <= 0) return { costUsd: r.reportedUsd, estimated: false }
    const prev = this.db
      .prepare("SELECT reported_cost_usd AS r FROM claude_usage WHERE session_id = ? AND reported_cost_usd > 0 ORDER BY ended_at DESC, rowid DESC LIMIT 1")
      .get(r.sessionId) as { r: number } | undefined
    if (prev && r.reportedUsd >= prev.r) return { costUsd: r.reportedUsd - prev.r, estimated: false }
    if (prev || !r.resumed) return { costUsd: r.reportedUsd, estimated: false }
    const rate = this.tokenRate(r.model)
    if (r.totalTokens > 0 && rate === null) return { costUsd: r.reportedUsd, estimated: false }
    return { costUsd: Math.min(r.reportedUsd, r.totalTokens * (rate ?? 0)), estimated: true }
  }

  /** Recent $/token for a model (else any model) from exactly priced runs, or null with no data. */
  private tokenRate(model: string | null): number | null {
    const since = Date.now() - 30 * 24 * 3_600_000
    const q = this.db.prepare(
      `SELECT SUM(cost_usd) AS c, SUM(total_tokens) AS t FROM claude_usage
       WHERE cost_estimated = 0 AND total_tokens > 0 AND started_at >= ? AND (? IS NULL OR model = ?)`,
    )
    for (const m of model ? [model, null] : [null]) {
      const row = q.get(since, m, m) as { c: number | null; t: number | null }
      if (row.c && row.t) return row.c / row.t
    }
    return null
  }

  taskClaudeTotals(taskId: string): ClaudeUsageTotals {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COUNT(*) AS turns,
          COALESCE(SUM(duration_ms), 0) AS durationMs
         FROM claude_usage WHERE task_id = ?`,
      )
      .get(taskId) as ClaudeUsageTotals
    return totals(row)
  }

  recordBoxUsageInterval(input: {
    boxId: string
    provider: string
    size: BoxSize
    keepAlive: boolean
    startedAt: number
    endedAt: number
    activeMs: number
    uptimeMs: number
    diskBytes?: number | null
    source: "actual" | "estimated"
  }) {
    if (input.endedAt <= input.startedAt || input.uptimeMs <= 0) return
    this.db
      .prepare(
        `INSERT INTO box_usage_intervals
          (id, box_id, provider, size, keep_alive, started_at, ended_at, active_ms, uptime_ms, disk_bytes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("bu"),
        input.boxId,
        input.provider,
        input.size,
        input.keepAlive ? 1 : 0,
        input.startedAt,
        input.endedAt,
        Math.max(0, Math.round(input.activeMs)),
        Math.max(0, Math.round(input.uptimeMs)),
        input.diskBytes ?? null,
        input.source,
      )
  }

  usageReport(settings: { costRates: CostRates; budget: BudgetSettings }, now = Date.now(), period?: { from: number; to: number }): UsageReport {
    const windows = usageWindows(now).map((w) => this.usageWindow(w, settings.costRates))
    const projects = this.usageProjects()
    const tasks = this.usageTasks()
    const boxes = this.listBoxes().map((b) => this.boxUsageTotal(b, settings.costRates, now))
    const orchestrator = this.claudeTotals(COORDINATOR_USAGE_WHERE)
    const captains = this.claudeTotals(CAPTAIN_USAGE_WHERE)
    return {
      generatedAt: now,
      rates: settings.costRates,
      budget: budgetStatus(settings.budget, windows),
      windows,
      projects,
      tasks,
      boxes,
      orchestrator,
      captains,
      ...(period ? { period: this.usagePeriod(period.from, period.to, settings.costRates) } : {}),
    }
  }

  /** Spend in [from, to): claude runs by start time, box intervals by their overlap. See usagePeriod.ts. */
  usagePeriod(from: number, to: number, rates: CostRates): UsagePeriodReport {
    const claude = this.db
      .prepare(
        `SELECT u.source, u.project_id AS projectId, p.name AS projectName, u.task_id AS taskId, t.title AS taskTitle,
          t.schedule_id AS scheduleId, s.name AS scheduleName, u.model, u.started_at AS startedAt, u.duration_ms AS durationMs,
          u.cost_usd AS costUsd, u.input_tokens AS inputTokens, u.cache_creation_input_tokens AS cacheCreationInputTokens,
          u.cache_read_input_tokens AS cacheReadInputTokens, u.output_tokens AS outputTokens, u.total_tokens AS totalTokens
         FROM claude_usage u
         LEFT JOIN projects p ON p.id = u.project_id
         LEFT JOIN tasks t ON t.id = u.task_id
         LEFT JOIN schedules s ON s.id = t.schedule_id
         WHERE u.started_at >= ? AND u.started_at < ?`,
      )
      .all(from, to) as PeriodClaudeRow[]
    const intervals = (this.db.prepare("SELECT * FROM box_usage_intervals WHERE ended_at > ? AND started_at < ?").all(from, to) as BoxUsageIntervalRow[]).map(
      (r): PeriodBoxInterval => {
        const size = normalizeBoxSize(r.size)
        const keepAlive = Boolean(r.keep_alive)
        return {
          boxId: r.box_id,
          size,
          keepAlive,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          activeMs: r.active_ms,
          uptimeMs: r.uptime_ms,
          diskBytes: r.disk_bytes,
          costUsd: boxCost({ activeMs: r.active_ms, uptimeMs: r.uptime_ms, diskBytes: r.disk_bytes, size, keepAlive }, rates),
          source: r.source === "actual" ? "actual" : "estimated",
        }
      },
    )
    const liveBoxes = this.listBoxes().map((b) => ({ boxId: b.id, size: normalizeBoxSize(b.size), keepAlive: Boolean(b.keep_alive), diskBytes: b.disk_bytes }))
    return buildUsagePeriod({ from, to, claude, intervals, liveBoxes })
  }

  usageBudgetStatus(settings: { costRates: CostRates; budget: BudgetSettings }, now = Date.now()): BudgetStatus {
    return this.usageReport(settings, now).budget
  }

  private usageWindow(w: { key: UsageWindow["key"]; label: string; since: number }, rates: CostRates): UsageWindow {
    const claude = this.claudeTotals("WHERE started_at >= ?", [w.since])
    const boxes = this.boxTotalsSince(w.since, rates)
    return { ...w, claude, boxes, totalCostUsd: claude.costUsd + boxes.costUsd }
  }

  private usageProjects(): UsageProjectTotal[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS projectId, p.name AS projectName,
          COALESCE(SUM(u.cost_usd), 0) AS costUsd,
          COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
          COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(u.cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
          COALESCE(SUM(u.total_tokens), 0) AS totalTokens,
          COUNT(u.id) AS turns,
          COALESCE(SUM(u.duration_ms), 0) AS durationMs
         FROM projects p
         JOIN claude_usage u ON u.project_id = p.id
         GROUP BY p.id, p.name
         ORDER BY costUsd DESC, totalTokens DESC`,
      )
      .all() as (ClaudeUsageTotals & { projectId: string; projectName: string })[]
    return rows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, claude: totals(r) }))
  }

  private usageTasks(): UsageTaskTotal[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS taskId, t.title AS taskTitle, p.id AS projectId, p.name AS projectName,
          COALESCE(SUM(u.cost_usd), 0) AS costUsd,
          COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
          COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(u.cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
          COALESCE(SUM(u.total_tokens), 0) AS totalTokens,
          COUNT(u.id) AS turns,
          COALESCE(SUM(u.duration_ms), 0) AS durationMs
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN claude_usage u ON u.task_id = t.id
         GROUP BY t.id, t.title, p.id, p.name
         ORDER BY costUsd DESC, totalTokens DESC
         LIMIT 200`,
      )
      .all() as (ClaudeUsageTotals & { taskId: string; taskTitle: string; projectId: string; projectName: string })[]
    return rows.map((r) => ({ taskId: r.taskId, taskTitle: r.taskTitle, projectId: r.projectId, projectName: r.projectName, claude: totals(r) }))
  }

  private claudeTotals(where = "", args: unknown[] = []): ClaudeUsageTotals {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COUNT(*) AS turns,
          COALESCE(SUM(duration_ms), 0) AS durationMs
         FROM claude_usage ${where}`,
      )
      .get(...args) as ClaudeUsageTotals
    return totals(row)
  }

  private boxTotalsSince(since: number, rates: CostRates): BoxUsageTotals {
    const rows = this.db.prepare("SELECT * FROM box_usage_intervals WHERE ended_at >= ? ORDER BY ended_at ASC").all(since) as BoxUsageIntervalRow[]
    const out: BoxUsageTotals = { activeMs: 0, uptimeMs: 0, diskBytes: 0, costUsd: 0, source: "actual" }
    for (const r of rows) {
      const span = Math.max(1, r.ended_at - r.started_at)
      const overlap = Math.max(0, r.ended_at - Math.max(since, r.started_at))
      if (!overlap) continue
      const share = Math.min(1, overlap / span)
      const activeMs = r.active_ms * share
      const uptimeMs = r.uptime_ms * share
      out.activeMs += activeMs
      out.uptimeMs += uptimeMs
      out.diskBytes = Math.max(out.diskBytes, r.disk_bytes ?? 0)
      out.costUsd += boxCost({ activeMs, uptimeMs, diskBytes: r.disk_bytes, size: r.size, keepAlive: Boolean(r.keep_alive) }, rates)
      if (r.source !== "actual") out.source = "estimated"
    }
    return out
  }

  private boxUsageTotal(row: BoxRow, rates: CostRates, now: number): UsageBoxTotal {
    const uptimeMs = Math.max(0, now - row.created_at)
    return {
      boxId: row.id,
      provider: row.provider,
      size: normalizeBoxSize(row.size),
      keepAlive: Boolean(row.keep_alive),
      activeMs: row.active_ms ?? 0,
      uptimeMs,
      diskBytes: row.disk_bytes ?? null,
      estimatedCostUsd: boxCost({ activeMs: row.active_ms ?? 0, uptimeMs, diskBytes: row.disk_bytes, size: normalizeBoxSize(row.size), keepAlive: Boolean(row.keep_alive) }, rates),
      usageSource: row.usage_source ?? "estimated",
    }
  }

  // ---------- boxes ----------

  listBoxes(): BoxRow[] {
    return this.db.prepare("SELECT * FROM boxes WHERE status != 'deleting' ORDER BY created_at ASC").all() as BoxRow[]
  }

  /** Boxes whose provider delete hasn't gone through yet (left out of listBoxes: nothing may use them). */
  listDeletingBoxes(): BoxRow[] {
    return this.db.prepare("SELECT * FROM boxes WHERE status = 'deleting' ORDER BY created_at ASC").all() as BoxRow[]
  }

  getBox(id: string): BoxRow | null {
    return (this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as BoxRow | undefined) ?? null
  }

  upsertBox(row: Pick<BoxRow, "id" | "provider" | "status" | "created_at" | "last_used_at"> & Partial<Omit<BoxRow, "id" | "provider" | "status" | "created_at" | "last_used_at">>) {
    this.db
      .prepare(
        `INSERT INTO boxes (id, provider, status, created_at, last_used_at, size, keep_alive, active_ms, last_metered_at, disk_bytes, disk_updated_at, usage_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          last_used_at = excluded.last_used_at,
          size = excluded.size,
          keep_alive = excluded.keep_alive,
          usage_source = excluded.usage_source`,
      )
      .run(
        row.id,
        row.provider,
        row.status,
        row.created_at,
        row.last_used_at,
        normalizeBoxSize(row.size),
        row.keep_alive ? 1 : 0,
        row.active_ms ?? 0,
        row.last_metered_at ?? row.created_at,
        row.disk_bytes ?? null,
        row.disk_updated_at ?? null,
        row.usage_source ?? "estimated",
      )
  }

  setBoxStatus(id: string, status: BoxRow["status"]) {
    this.db.prepare("UPDATE boxes SET status = ?, last_used_at = ? WHERE id = ?").run(status, Date.now(), id)
  }

  touchBox(id: string) {
    this.db.prepare("UPDATE boxes SET last_used_at = ? WHERE id = ?").run(Date.now(), id)
  }

  meterBox(
    id: string,
    patch: Partial<{
      activeMs: number
      lastMeteredAt: number
      diskBytes: number | null
      diskUpdatedAt: number | null
      size: BoxSize
      keepAlive: boolean
      usageSource: "actual" | "estimated"
      diskFreeBytes: number | null
      diskTotalBytes: number | null
      diskCheckedAt: number | null
      rootFreeBytes: number | null
      rootTotalBytes: number | null
      memUsedBytes: number | null
      memTotalBytes: number | null
      loadAvg: number | null
      cpuCount: number | null
    }>,
  ) {
    const sets: string[] = []
    const args: unknown[] = []
    const cols = {
      activeMs: "active_ms",
      lastMeteredAt: "last_metered_at",
      diskBytes: "disk_bytes",
      diskUpdatedAt: "disk_updated_at",
      size: "size",
      keepAlive: "keep_alive",
      usageSource: "usage_source",
      diskFreeBytes: "disk_free_bytes",
      diskTotalBytes: "disk_total_bytes",
      diskCheckedAt: "disk_checked_at",
      rootFreeBytes: "root_free_bytes",
      rootTotalBytes: "root_total_bytes",
      memUsedBytes: "mem_used_bytes",
      memTotalBytes: "mem_total_bytes",
      loadAvg: "load_avg",
      cpuCount: "cpu_count",
    } as const
    for (const [k, v] of Object.entries(patch) as [keyof typeof cols, unknown][]) {
      if (v === undefined) continue
      sets.push(`${cols[k]} = ?`)
      args.push(k === "keepAlive" ? (v ? 1 : 0) : k === "size" ? normalizeBoxSize(v as BoxSize) : v)
    }
    if (sets.length) this.db.prepare(`UPDATE boxes SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
  }

  removeBox(id: string) {
    this.db.prepare("DELETE FROM boxes WHERE id = ?").run(id)
  }

  // ---------- schedules ----------

  private scheduleFromRow(r: ScheduleRow): Schedule {
    return {
      id: r.id,
      target: r.target,
      projectId: r.project_id,
      name: r.name,
      cron: r.cron,
      timezone: r.timezone,
      prompt: r.prompt,
      enabled: Boolean(r.enabled),
      catchUp: r.catch_up,
      allowOverlap: Boolean(r.allow_overlap),
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastTaskId: r.last_task_id,
      lastSkipReason: r.last_skip_reason,
      runCount: r.run_count,
      qstashId: r.qstash_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  listSchedules(filter: { projectId?: string; target?: ScheduleTarget } = {}): Schedule[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.projectId) (where.push("project_id = ?"), args.push(filter.projectId))
    if (filter.target) (where.push("target = ?"), args.push(filter.target))
    const rows = this.db.prepare(`SELECT * FROM schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`).all(...args)
    return (rows as ScheduleRow[]).map((r) => this.scheduleFromRow(r))
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined
    return row ? this.scheduleFromRow(row) : null
  }

  findSchedule(idOrName: string): Schedule | null {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1")
      .get(idOrName, idOrName) as ScheduleRow | undefined
    return row ? this.scheduleFromRow(row) : null
  }

  /** Enabled schedules whose next run is at or before `now`. */
  dueSchedules(now: number): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC")
      .all(now) as ScheduleRow[]
    return rows.map((r) => this.scheduleFromRow(r))
  }

  createSchedule(input: {
    id?: string
    target?: ScheduleTarget
    projectId: string | null
    name: string
    cron: string
    timezone: string
    prompt: string
    enabled?: boolean
    catchUp?: CatchUp
    allowOverlap?: boolean
    nextRunAt: number | null
  }): Schedule {
    const now = Date.now()
    const id = input.id ?? newId("sch")
    this.db
      .prepare(
        `INSERT INTO schedules (id, target, project_id, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.target ?? "project",
        input.projectId,
        input.name.trim(),
        input.cron.trim(),
        input.timezone,
        input.prompt,
        input.enabled === false ? 0 : 1,
        input.catchUp ?? "once",
        input.allowOverlap ? 1 : 0,
        input.nextRunAt,
        now,
        now,
      )
    return this.getSchedule(id)!
  }

  updateSchedule(id: string, patch: SchedulePatch): Schedule {
    const sets: string[] = []
    const args: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof SchedulePatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${SCHEDULE_COLUMNS[key]} = ?`)
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
    }
    sets.push("updated_at = ?")
    args.push(Date.now(), id)
    const res = this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    if (res.changes === 0) throw new NotFoundError(`Schedule ${id} not found`)
    return this.getSchedule(id)!
  }

  /**
   * Move a schedule's next run from `expected` to `next`, only if nobody else
   * did first. This is what makes a run fire once even when the local timer
   * and a QStash delivery race each other.
   */
  claimRun(id: string, expected: number | null, next: number | null): boolean {
    const res = this.db
      .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at IS ?")
      .run(next, Date.now(), id, expected)
    return res.changes === 1
  }

  deleteSchedule(id: string) {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id)
  }

  // ---------- orchestrator schedule runs ----------

  private runFromRow(r: ScheduleRunRow): ScheduleRun {
    return {
      id: r.id,
      scheduleId: r.schedule_id,
      status: r.status,
      reason: r.reason,
      prompt: r.prompt,
      dueAt: r.due_at,
      chatMessageId: r.chat_message_id,
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }
  }

  createScheduleRun(input: { scheduleId: string; prompt: string; reason: ScheduleRun["reason"]; dueAt: number }): ScheduleRun {
    const id = newId("run")
    this.db
      .prepare("INSERT INTO schedule_runs (id, schedule_id, status, reason, prompt, due_at, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)")
      .run(id, input.scheduleId, input.reason, input.prompt, input.dueAt, Date.now())
    return this.getScheduleRun(id)!
  }

  getScheduleRun(id: string): ScheduleRun | null {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRunRow | undefined
    return row ? this.runFromRow(row) : null
  }

  updateScheduleRun(id: string, patch: Partial<Pick<ScheduleRun, "status" | "chatMessageId" | "error" | "startedAt" | "finishedAt">>): ScheduleRun {
    const cols = { status: "status", chatMessageId: "chat_message_id", error: "error", startedAt: "started_at", finishedAt: "finished_at" } as const
    const sets: string[] = []
    const args: unknown[] = []
    for (const [k, v] of Object.entries(patch) as [keyof typeof cols, unknown][]) {
      if (v === undefined) continue
      sets.push(`${cols[k]} = ?`)
      args.push(v)
    }
    if (sets.length) this.db.prepare(`UPDATE schedule_runs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
    return this.getScheduleRun(id)!
  }

  /** Runs of one schedule (or all of them), newest first. */
  listScheduleRuns(filter: { scheduleId?: string; status?: ScheduleRunStatus[]; limit?: number } = {}): ScheduleRun[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.scheduleId) (where.push("schedule_id = ?"), args.push(filter.scheduleId))
    if (filter.status?.length) (where.push(`status IN (${filter.status.map(() => "?").join(",")})`), args.push(...filter.status))
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, filter.limit ?? 200) as ScheduleRunRow[]
    return rows.map((r) => this.runFromRow(r))
  }

  // ---------- kv ----------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  // ---------- notifications ----------

  /** `summary` replaces the task's own one-liner, e.g. "PR #23 merged by cody". */
  addNotification(task: Task, summary?: string): AppNotification | null {
    if (!(["done", "pr_ready", "needs_input", "failed", "idle"] as TaskStatus[]).includes(task.status)) return null
    const project = this.db.prepare("SELECT name FROM projects WHERE id = ?").get(task.projectId) as { name: string } | undefined
    const text = task.status === "needs_input" ? task.question : task.status === "failed" ? task.error : task.summary
    const n: AppNotification = {
      id: newId("ntf"),
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      projectName: project?.name ?? "",
      status: task.status as AppNotification["status"],
      summary: oneLine(summary ?? text),
      createdAt: Date.now(),
      readAt: null,
    }
    this.db
      .prepare(
        "INSERT INTO notifications (id, task_id, project_id, title, project_name, status, summary, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(n.id, n.taskId, n.projectId, n.title, n.projectName, n.status, n.summary, n.createdAt)
    this.db
      .prepare("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)")
      .run(NOTIFICATIONS_KEPT)
    this.onNotification?.(n)
    return n
  }

  /** A notification about a box, not a task (e.g. a resize the Coordinator made). */
  addBoxNotification(input: { boxId: string; title: string; summary: string; status: "done" | "failed"; projectId?: string; projectName?: string; href?: string }): AppNotification {
    const n: AppNotification = {
      id: newId("ntf"),
      taskId: null,
      boxId: input.boxId,
      href: input.href ?? `/boxes#${input.boxId}`,
      projectId: input.projectId ?? "",
      title: input.title,
      projectName: input.projectName ?? "",
      status: input.status,
      summary: oneLine(input.summary),
      createdAt: Date.now(),
      readAt: null,
    }
    this.db
      .prepare(
        "INSERT INTO notifications (id, task_id, box_id, href, project_id, title, project_name, status, summary, created_at, read_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(n.id, n.boxId, n.href, n.projectId, n.title, n.projectName, n.status, n.summary, n.createdAt)
    this.db
      .prepare("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)")
      .run(NOTIFICATIONS_KEPT)
    this.onNotification?.(n)
    return n
  }

  /** Newest first. */
  listNotifications(limit = 50): AppNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, NOTIFICATIONS_KEPT))) as NotificationRow[]
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      ...(r.box_id ? { boxId: r.box_id } : {}),
      ...(r.href ? { href: r.href } : {}),
      projectId: r.project_id,
      title: r.title,
      projectName: r.project_name,
      status: r.status,
      summary: r.summary,
      createdAt: r.created_at,
      readAt: r.read_at,
    }))
  }

  /** Mark notifications read: by id, every one for a task, or all. Returns the ids that changed. */
  markNotificationsRead(by: { ids?: string[]; taskId?: string; all?: boolean }, at = Date.now()): string[] {
    let rows: { id: string }[]
    if (by.all) rows = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL").all() as { id: string }[]
    else if (by.taskId) rows = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND task_id = ?").all(by.taskId) as { id: string }[]
    else {
      const stmt = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND id = ?")
      rows = (by.ids ?? []).flatMap((id) => (stmt.get(id) as { id: string } | undefined) ?? [])
    }
    const ids = rows.map((r) => r.id)
    const upd = this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?")
    this.db.transaction(() => ids.forEach((id) => upd.run(at, id)))()
    return ids
  }

  setKv(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM kv WHERE key = ?").run(key)
    else
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value)
  }
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000
const GB = 1024 ** 3

function intToken(n: unknown) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function totals(row: Partial<ClaudeUsageTotals> | undefined | null): ClaudeUsageTotals {
  return {
    costUsd: Number(row?.costUsd ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    cacheCreationInputTokens: Number(row?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: Number(row?.cacheReadInputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    turns: Number(row?.turns ?? 0),
    durationMs: Number(row?.durationMs ?? 0),
  }
}

export function normalizeBoxSize(size: unknown): BoxSize {
  return typeof size === "string" && (BOX_SIZES as readonly string[]).includes(size) ? (size as BoxSize) : "small"
}

export function boxCost(
  box: { activeMs: number; uptimeMs: number; diskBytes?: number | null; size: BoxSize; keepAlive: boolean },
  rates: CostRates,
): number {
  const size = normalizeBoxSize(box.size)
  const active = (Math.max(0, box.activeMs) / 3_600_000) * rates.boxActiveCpuHourlyUsd[size]
  const keepAlive = box.keepAlive ? (Math.max(0, box.uptimeMs) / MONTH_MS) * rates.boxKeepAliveMonthlyUsd[size] : 0
  const storage = (((box.diskBytes ?? 0) / GB) * Math.max(0, box.uptimeMs) * rates.boxStorageGbMonthUsd) / MONTH_MS
  return active + keepAlive + storage
}

function usageWindows(now: number): Pick<UsageWindow, "key" | "label" | "since">[] {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return [
    { key: "today", label: "Today", since: day.getTime() },
    { key: "7d", label: "Last 7 days", since: now - 7 * 24 * 60 * 60 * 1000 },
    { key: "30d", label: "Last 30 days", since: now - 30 * 24 * 60 * 60 * 1000 },
  ]
}

function budgetStatus(budget: BudgetSettings, windows: UsageWindow[]): BudgetStatus {
  const today = windows.find((w) => w.key === "today")?.totalCostUsd ?? 0
  const month = windows.find((w) => w.key === "30d")?.totalCostUsd ?? 0
  const state = (usedUsd: number, limitUsd: number) => ({
    limitUsd,
    usedUsd,
    exceeded: limitUsd > 0 && usedUsd >= limitUsd,
    warning: limitUsd > 0 && usedUsd >= limitUsd * 0.8,
  })
  const daily = state(today, budget.dailyUsd)
  const monthly = state(month, budget.monthlyUsd)
  return { daily, monthly, blocked: daily.exceeded || monthly.exceeded }
}

export class NotFoundError extends Error {
  status = 404
}

export class BadRequestError extends Error {
  status = 400
}

/** The request is fine but the thing is busy or in the way right now (e.g. agents running on a box). */
export class ConflictError extends Error {
  status = 409
}

/** The error for a refused change to a queued chat message (see Store.editQueuedChat). */
export function queuedChatError(reason: "delivered" | "deleted" | "missing", who: string): Error {
  if (reason === "missing") return new NotFoundError("No such message.")
  if (reason === "deleted") return new ConflictError("That message was deleted.")
  return new ConflictError(`That message was already delivered to ${who}, so it can't be changed.`)
}

/** Accept `owner/name`, `github.com/owner/name`, or a full URL. Returns null for empty. */
export function normalizeRepo(repo: string | null | undefined): string | null {
  if (!repo) return null
  let r = repo.trim()
  if (!r) return null
  r = r.replace(/\.git$/, "").replace(/\/+$/, "")
  const gh = r.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/i)
  if (gh) return `${gh[1]}/${gh[2]}`
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return r
  if (/^(https?:\/\/|git@)/.test(r)) return r
  throw new BadRequestError(`Can't read repo "${repo}". Use owner/name or a git URL.`)
}

/** A clone URL for a normalized repo. Tokens are never put in the URL. */
export function cloneUrl(repo: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo}.git`
  return repo
}

/** owner/name for GitHub repos, else null. */
export function githubSlug(repo: string | null): string | null {
  if (!repo) return null
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo
  const m = repo.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}
