import type { DB } from "./db.js"
import { BadRequestError, NotFoundError, newId } from "./store.js"
import {
  HOOK_ACTIONS,
  HOOK_TEMPLATES,
  HOOK_TRIGGERS,
  hookProblems,
  normalizeFilters,
  type Hook,
  type HookAction,
  type HookFilters,
  type HookRun,
  type HookRunStatus,
  type HookTemplate,
  type HookTrigger,
} from "../shared/hooks.js"

interface HookRow {
  id: string
  project_id: string | null
  name: string
  trigger: string
  filters_json: string
  action: string
  task_title: string | null
  prompt: string
  enabled: number
  allow_self_trigger: number
  max_fires_per_task: number
  template: string | null
  created_by: string
  created_at: number
  updated_at: number
}

interface HookRunRow {
  id: string
  hook_id: string | null
  hook_name: string
  hook_project_id: string | null
  project_id: string | null
  task_id: string | null
  task_title: string | null
  event: string
  fire_key: string
  head_sha: string | null
  action: string
  prompt: string
  status: string
  result: string
  target_task_id: string | null
  created_at: number
}

export interface HookInput {
  name: string
  projectId: string | null
  trigger: HookTrigger
  filters?: HookFilters
  action: HookAction
  taskTitle?: string | null
  prompt: string
  enabled?: boolean
  allowSelfTrigger?: boolean
  maxFiresPerTask?: number
  template?: HookTemplate | null
  createdBy: string
}

export type HookPatch = Partial<Pick<Hook, "name" | "trigger" | "filters" | "action" | "taskTitle" | "prompt" | "enabled" | "allowSelfTrigger" | "maxFiresPerTask">>

export const DEFAULT_MAX_FIRES_PER_TASK = 3

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function hookFromRow(r: HookRow): Hook {
  return {
    id: r.id,
    name: r.name,
    projectId: r.project_id,
    trigger: r.trigger as HookTrigger,
    filters: normalizeFilters(parseJson<HookFilters>(r.filters_json, {})),
    action: r.action as HookAction,
    taskTitle: r.task_title,
    prompt: r.prompt,
    enabled: Boolean(r.enabled),
    allowSelfTrigger: Boolean(r.allow_self_trigger),
    maxFiresPerTask: r.max_fires_per_task,
    template: (HOOK_TEMPLATES as readonly string[]).includes(r.template ?? "") ? (r.template as HookTemplate) : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function runFromRow(r: HookRunRow): HookRun {
  return {
    id: r.id,
    hookId: r.hook_id,
    hookName: r.hook_name,
    hookProjectId: r.hook_project_id,
    projectId: r.project_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    event: r.event as HookTrigger,
    headSha: r.head_sha,
    action: r.action as HookAction,
    prompt: r.prompt,
    status: r.status as HookRunStatus,
    result: r.result,
    targetTaskId: r.target_task_id,
    createdAt: r.created_at,
  }
}

function check(h: Partial<HookInput>) {
  if (h.trigger !== undefined && !(HOOK_TRIGGERS as readonly string[]).includes(h.trigger)) throw new BadRequestError(`Unknown trigger "${h.trigger}". Use one of: ${HOOK_TRIGGERS.join(", ")}.`)
  if (h.action !== undefined && !(HOOK_ACTIONS as readonly string[]).includes(h.action)) throw new BadRequestError(`Unknown action "${h.action}". Use one of: ${HOOK_ACTIONS.join(", ")}.`)
  const problems = hookProblems(h)
  if (problems.length) throw new BadRequestError(problems.join(" "))
}

/** Hooks and their audit log (hook_runs) in SQLite. */
export class HookStore {
  constructor(private readonly db: DB) {}

  /** Global hooks (projectId null), one project's, or all of them (undefined), oldest first so the order is stable. */
  list(filter: { projectId?: string | null } = {}): Hook[] {
    const rows =
      filter.projectId === undefined
        ? this.db.prepare("SELECT * FROM hooks ORDER BY created_at ASC, rowid ASC").all()
        : filter.projectId === null
          ? this.db.prepare("SELECT * FROM hooks WHERE project_id IS NULL ORDER BY created_at ASC, rowid ASC").all()
          : this.db.prepare("SELECT * FROM hooks WHERE project_id = ? ORDER BY created_at ASC, rowid ASC").all(filter.projectId)
    return (rows as HookRow[]).map(hookFromRow)
  }

  /** The enabled hooks that can see a project's events: the global ones and the project's own. */
  listFor(projectId: string): Hook[] {
    const rows = this.db
      .prepare("SELECT * FROM hooks WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at ASC, rowid ASC")
      .all(projectId) as HookRow[]
    return rows.map(hookFromRow)
  }

  get(id: string): Hook | null {
    const row = this.db.prepare("SELECT * FROM hooks WHERE id = ?").get(id) as HookRow | undefined
    return row ? hookFromRow(row) : null
  }

  /** By id, or by name within a scope (null: global hooks). */
  find(ref: string, scope?: string | null): Hook | null {
    const byId = this.get(ref)
    if (byId) return byId
    const all = this.list(scope === undefined ? {} : { projectId: scope })
    return all.find((h) => h.name.toLowerCase() === ref.trim().toLowerCase()) ?? null
  }

  create(input: HookInput): Hook {
    check(input)
    const now = Date.now()
    const id = newId("hook")
    this.db
      .prepare(
        `INSERT INTO hooks (id, project_id, name, trigger, filters_json, action, task_title, prompt, enabled, allow_self_trigger, max_fires_per_task, template, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.name.trim(),
        input.trigger,
        JSON.stringify(normalizeFilters(input.filters)),
        input.action,
        input.action === "create_task" ? (input.taskTitle?.trim() ?? null) : null,
        input.prompt.trim(),
        input.enabled ? 1 : 0,
        input.allowSelfTrigger ? 1 : 0,
        input.maxFiresPerTask ?? DEFAULT_MAX_FIRES_PER_TASK,
        input.template ?? null,
        input.createdBy,
        now,
        now,
      )
    return this.get(id)!
  }

  update(id: string, patch: HookPatch): Hook {
    const before = this.get(id)
    if (!before) throw new NotFoundError(`Hook ${id} not found`)
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Hook
    check(next)
    this.db
      .prepare(
        `UPDATE hooks SET name = ?, trigger = ?, filters_json = ?, action = ?, task_title = ?, prompt = ?, enabled = ?, allow_self_trigger = ?, max_fires_per_task = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name.trim(),
        next.trigger,
        JSON.stringify(normalizeFilters(next.filters)),
        next.action,
        next.action === "create_task" ? (next.taskTitle?.trim() ?? null) : null,
        next.prompt.trim(),
        next.enabled ? 1 : 0,
        next.allowSelfTrigger ? 1 : 0,
        next.maxFiresPerTask,
        Date.now(),
        id,
      )
    return this.get(id)!
  }

  delete(id: string) {
    this.db.prepare("DELETE FROM hooks WHERE id = ?").run(id)
  }

  // ---------- the audit log

  addRun(input: Omit<HookRun, "id" | "createdAt"> & { fireKey: string }): HookRun {
    const id = newId("hrun")
    this.db
      .prepare(
        `INSERT INTO hook_runs (id, hook_id, hook_name, hook_project_id, project_id, task_id, task_title, event, fire_key, head_sha, action, prompt, status, result, target_task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.hookId,
        input.hookName,
        input.hookProjectId,
        input.projectId,
        input.taskId,
        input.taskTitle,
        input.event,
        input.fireKey,
        input.headSha,
        input.action,
        input.prompt,
        input.status,
        input.result,
        input.targetTaskId,
        Date.now(),
      )
    return this.getRun(id)!
  }

  updateRun(id: string, patch: Partial<Pick<HookRun, "status" | "result" | "targetTaskId">>): HookRun {
    const run = this.getRun(id)
    if (!run) throw new NotFoundError(`Hook run ${id} not found`)
    this.db
      .prepare("UPDATE hook_runs SET status = ?, result = ?, target_task_id = ? WHERE id = ?")
      .run(patch.status ?? run.status, patch.result ?? run.result, patch.targetTaskId !== undefined ? patch.targetTaskId : run.targetTaskId, id)
    return this.getRun(id)!
  }

  getRun(id: string): HookRun | null {
    const row = this.db.prepare("SELECT * FROM hook_runs WHERE id = ?").get(id) as HookRunRow | undefined
    return row ? runFromRow(row) : null
  }

  /**
   * Newest first. `projectId`: runs on that project's tasks. `hookScope`: only runs of hooks owned by that project,
   * or of global (Coordinator) hooks for null. `taskId` also finds runs that sent to or created it.
   */
  listRuns(filter: { hookId?: string; projectId?: string; taskId?: string; hookScope?: string | null; limit?: number } = {}): HookRun[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.hookId) {
      where.push("r.hook_id = ?")
      args.push(filter.hookId)
    }
    if (filter.projectId) {
      where.push("r.project_id = ?")
      args.push(filter.projectId)
    }
    if (filter.taskId) {
      where.push("(r.task_id = ? OR r.target_task_id = ?)")
      args.push(filter.taskId, filter.taskId)
    }
    if (filter.hookScope === null) where.push("r.hook_project_id IS NULL")
    else if (filter.hookScope !== undefined) {
      where.push("r.hook_project_id = ?")
      args.push(filter.hookScope)
    }
    const rows = this.db
      .prepare(`SELECT r.* FROM hook_runs r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.min(filter.limit ?? 50, 500))) as HookRunRow[]
    return rows.map(runFromRow)
  }

  /** The run already logged for this fire key, if any (a fire, or a skip for the same reason). */
  runFor(hookId: string, taskId: string, event: HookTrigger, fireKey: string): HookRun[] {
    const rows = this.db
      .prepare("SELECT * FROM hook_runs WHERE hook_id = ? AND task_id = ? AND event = ? AND fire_key = ? ORDER BY created_at ASC, rowid ASC")
      .all(hookId, taskId, event, fireKey) as HookRunRow[]
    return rows.map(runFromRow)
  }

  /** How often this hook fired for this task. */
  firesFor(hookId: string, taskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM hook_runs WHERE hook_id = ? AND task_id = ? AND status = 'fired'").get(hookId, taskId) as { n: number }).n
  }

  /** Fires (any hook) for a task since a time. */
  taskFiresSince(taskId: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM hook_runs WHERE task_id = ? AND status = 'fired' AND created_at >= ?").get(taskId, since) as { n: number }).n
  }

  /** Fires (any hook, any task) since a time, for the global rate limit. */
  firesSince(since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM hook_runs WHERE status = 'fired' AND created_at >= ?").get(since) as { n: number }).n
  }

  /** Hooks that created this task (directly or through a chain of hook-created tasks), so none of them fires on it again. */
  lineage(taskId: string, depth = 8): string[] {
    const out = new Set<string>()
    let ids = [taskId]
    for (let i = 0; i < depth && ids.length; i++) {
      const rows = this.db
        .prepare(`SELECT hook_id, task_id FROM hook_runs WHERE action = 'create_task' AND status = 'fired' AND target_task_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as { hook_id: string | null; task_id: string | null }[]
      ids = []
      for (const r of rows) {
        if (r.hook_id) out.add(r.hook_id)
        if (r.task_id && r.task_id !== taskId) ids.push(r.task_id)
      }
    }
    return [...out]
  }

  /** The newest run per hook, for the list's "last fired" line. */
  lastRuns(hookIds: string[]): Map<string, HookRun> {
    const out = new Map<string, HookRun>()
    if (!hookIds.length) return out
    const rows = this.db
      .prepare(
        `SELECT * FROM hook_runs WHERE rowid IN (SELECT MAX(rowid) FROM hook_runs WHERE hook_id IN (${hookIds.map(() => "?").join(",")}) GROUP BY hook_id)`,
      )
      .all(...hookIds) as HookRunRow[]
    for (const r of rows) if (r.hook_id) out.set(r.hook_id, runFromRow(r))
    return out
  }
}
