import { randomUUID } from "node:crypto"
import type { DB } from "./db.js"
import type {
  Artifact,
  ChatMessage,
  ChatRole,
  PreviewLink,
  Project,
  ProjectNote,
  CatchUp,
  Schedule,
  Task,
  TaskMessage,
  TaskMessageRole,
  TaskStatus,
} from "../shared/types.js"

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`

const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** What happened during the turn that is running now. Reset at turn start. */
export interface TurnFlags {
  asked?: string
  done?: string
  waitingOn?: string[]
  sawPr?: boolean
  /** How many times in a row a turn died and was retried. */
  interrupts?: number
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
  previews_json: string
  question: string | null
  summary: string | null
  error: string | null
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
}

interface ScheduleRow {
  id: string
  project_id: string
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

interface ProjectRow {
  id: string
  name: string
  description: string
  repo: string | null
  base_branch: string
  env_json: string
  created_at: number
  updated_at: number
}

export interface BoxRow {
  id: string
  provider: string
  status: "creating" | "ready" | "lost" | "deleting"
  created_at: number
  last_used_at: number
}

type TaskPatch = Partial<{
  title: string
  status: TaskStatus
  boxId: string | null
  sessionId: string
  sessionStarted: boolean
  branch: string | null
  prUrl: string | null
  previews: PreviewLink[]
  question: string | null
  summary: string | null
  error: string | null
  turnCount: number
  portBase: number | null
  eventCursor: string | null
  currentTurnId: string | null
  turnFlags: TurnFlags
  archivePath: string | null
  lastArchivedAt: number | null
  lastActiveAt: number
}>

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  title: "title",
  status: "status",
  boxId: "box_id",
  sessionId: "session_id",
  sessionStarted: "session_started",
  branch: "branch",
  prUrl: "pr_url",
  previews: "previews_json",
  question: "question",
  summary: "summary",
  error: "error",
  turnCount: "turn_count",
  portBase: "port_base",
  eventCursor: "event_cursor",
  currentTurnId: "current_turn_id",
  turnFlags: "turn_flags_json",
  archivePath: "archive_path",
  lastArchivedAt: "last_archived_at",
  lastActiveAt: "last_active_at",
}

export class Store {
  constructor(readonly db: DB) {}

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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as ProjectRow[]
    return rows.map((r) => this.projectFromRow(r))
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    return row ? this.projectFromRow(row) : null
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
  }): Project {
    const now = Date.now()
    const id = input.id ?? newId("prj")
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, repo, base_branch, env_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    },
  ): Project {
    const current = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    if (!current) throw new NotFoundError(`Project ${id} not found`)
    const env = json<Record<string, string>>(current.env_json, {})
    Object.assign(env, patch.env ?? {})
    for (const k of patch.removeEnv ?? []) delete env[k]
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, repo = ?, base_branch = ?, env_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name?.trim() || current.name,
        patch.description ?? current.description,
        patch.repo === undefined ? current.repo : normalizeRepo(patch.repo),
        patch.baseBranch?.trim() || current.base_branch,
        JSON.stringify(env),
        Date.now(),
        id,
      )
    return this.getProject(id)!
  }

  deleteProject(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id)
  }

  listNotes(projectId: string): ProjectNote[] {
    const rows = this.db
      .prepare("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as { id: string; project_id: string; author: string; content: string; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      author: r.author,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  addNote(projectId: string, author: string, content: string): ProjectNote {
    const note = { id: newId("note"), projectId, author, content: content.trim(), createdAt: Date.now() }
    this.db
      .prepare("INSERT INTO project_notes (id, project_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(note.id, projectId, author, note.content, note.createdAt)
    return note
  }

  // ---------- tasks ----------

  taskFromRow(row: TaskRow): Task {
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM task_inputs WHERE task_id = ?").get(row.id) as {
      n: number
    }
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
      previews: json<PreviewLink[]>(row.previews_json, []),
      question: row.question,
      summary: row.summary,
      error: row.error,
      turnCount: row.turn_count,
      pendingCount: pending.n,
      lastArchivedAt: row.last_archived_at,
      scheduleId: row.schedule_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
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

  createTask(input: {
    id?: string
    projectId: string
    title: string
    prompt: string
    env?: Record<string, string>
    branch?: string | null
    scheduleId?: string | null
  }): Task {
    const now = Date.now()
    const id = input.id ?? newId("task")
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, prompt, status, session_id, branch, env_json, schedule_id, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
        now,
        now,
      )
    return this.getTask(id)!
  }

  taskEnv(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT env_json FROM tasks WHERE id = ?").get(id) as { env_json: string } | undefined
    return json(row?.env_json, {})
  }

  turnFlags(row: TaskRow): TurnFlags {
    return json<TurnFlags>(row.turn_flags_json, {})
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const sets: string[] = []
    const args: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${TASK_COLUMNS[key]} = ?`)
      if (key === "previews" || key === "turnFlags") args.push(JSON.stringify(value))
      else if (key === "sessionStarted") args.push(value ? 1 : 0)
      else args.push(value)
    }
    sets.push("updated_at = ?")
    args.push(Date.now(), id)
    const res = this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    if (res.changes === 0) throw new NotFoundError(`Task ${id} not found`)
    return this.getTask(id)!
  }

  deleteTask(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  }

  // pending inputs: messages for a task that wait for its next turn

  queueInput(taskId: string, source: string, content: string, attachments: string[] = []) {
    this.db
      .prepare("INSERT INTO task_inputs (id, task_id, source, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("in"), taskId, source, content, attachments.length ? JSON.stringify(attachments) : null, Date.now())
  }

  /** Queued inputs, oldest first. Delete them with deleteInputs once a turn has started. */
  peekInputs(taskId: string): { id: string; source: string; content: string; attachments: string[] }[] {
    const rows = this.db
      .prepare("SELECT id, source, content, attachments FROM task_inputs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(taskId) as { id: string; source: string; content: string; attachments: string | null }[]
    return rows.map((r) => ({ ...r, attachments: r.attachments ? (JSON.parse(r.attachments) as string[]) : [] }))
  }

  deleteInputs(ids: string[]) {
    const stmt = this.db.prepare("DELETE FROM task_inputs WHERE id = ?")
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))()
  }

  clearInputs(taskId: string) {
    this.db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(taskId)
  }

  hasInputs(taskId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_inputs WHERE task_id = ? LIMIT 1").get(taskId))
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

  clearChat() {
    this.db.prepare("DELETE FROM chat_messages").run()
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

  // ---------- boxes ----------

  listBoxes(): BoxRow[] {
    return this.db.prepare("SELECT * FROM boxes WHERE status != 'deleting' ORDER BY created_at ASC").all() as BoxRow[]
  }

  getBox(id: string): BoxRow | null {
    return (this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as BoxRow | undefined) ?? null
  }

  upsertBox(row: BoxRow) {
    this.db
      .prepare(
        `INSERT INTO boxes (id, provider, status, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_used_at = excluded.last_used_at`,
      )
      .run(row.id, row.provider, row.status, row.created_at, row.last_used_at)
  }

  setBoxStatus(id: string, status: BoxRow["status"]) {
    this.db.prepare("UPDATE boxes SET status = ?, last_used_at = ? WHERE id = ?").run(status, Date.now(), id)
  }

  touchBox(id: string) {
    this.db.prepare("UPDATE boxes SET last_used_at = ? WHERE id = ?").run(Date.now(), id)
  }

  removeBox(id: string) {
    this.db.prepare("DELETE FROM boxes WHERE id = ?").run(id)
  }

  // ---------- schedules ----------

  private scheduleFromRow(r: ScheduleRow): Schedule {
    return {
      id: r.id,
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

  listSchedules(filter: { projectId?: string } = {}): Schedule[] {
    const rows = filter.projectId
      ? this.db.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at ASC").all(filter.projectId)
      : this.db.prepare("SELECT * FROM schedules ORDER BY created_at ASC").all()
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
    projectId: string
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
        `INSERT INTO schedules (id, project_id, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
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

  // ---------- kv ----------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setKv(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM kv WHERE key = ?").run(key)
    else
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value)
  }
}

export class NotFoundError extends Error {
  status = 404
}

export class BadRequestError extends Error {
  status = 400
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
