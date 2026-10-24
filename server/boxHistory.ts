import type { DB } from "./db.js"
import {
  BOX_HISTORY_MAX_DAYS,
  BOX_HISTORY_MAX_ROWS,
  type BoxActor,
  type BoxEvent,
  type BoxEventFilter,
  type BoxEventType,
} from "../shared/boxHistory.js"
import type { BoxSize } from "../shared/types.js"

interface BoxEventRow {
  id: number
  at: number
  box_id: string
  box_name: string | null
  type: BoxEventType
  actor: BoxEvent["actor"]
  actor_project_id: string | null
  reason: string | null
  size: BoxSize | null
  from_size: BoxSize | null
  to_size: BoxSize | null
  related_box_id: string | null
  resize_id: string | null
  projects_json: string
  task_ids_json: string
  freed_bytes: number | null
  detail: string | null
}

/** What a caller says about an event; TaskManager.recordBoxEvent fills in the box's name, size, projects and tasks. */
export interface BoxEventInput {
  boxId: string
  boxName?: string | null
  type: BoxEventType
  actor: BoxActor
  reason?: string | null
  size?: BoxSize | null
  fromSize?: BoxSize | null
  toSize?: BoxSize | null
  relatedBoxId?: string | null
  resizeId?: string | null
  projects?: { id: string; name: string }[]
  taskIds?: string[]
  freedBytes?: number | null
  detail?: string | null
  at?: number
}

const parseList = <T>(raw: string): T[] => {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

const fromRow = (r: BoxEventRow): BoxEvent => ({
  id: r.id,
  at: r.at,
  boxId: r.box_id,
  boxName: r.box_name,
  type: r.type,
  actor: r.actor,
  actorProjectId: r.actor_project_id,
  reason: r.reason,
  size: r.size,
  fromSize: r.from_size,
  toSize: r.to_size,
  relatedBoxId: r.related_box_id,
  resizeId: r.resize_id,
  projects: parseList<{ id: string; name: string }>(r.projects_json),
  taskIds: parseList<string>(r.task_ids_json),
  freedBytes: r.freed_bytes,
  detail: r.detail,
})

/**
 * The box history log (table box_events): append-only, bounded to BOX_HISTORY_MAX_DAYS and BOX_HISTORY_MAX_ROWS.
 * Box events are rare (a few an hour at most), so every write prunes.
 */
export class BoxHistory {
  constructor(private readonly db: DB) {}

  add(input: BoxEventInput): BoxEvent {
    const at = input.at ?? Date.now()
    const res = this.db
      .prepare(
        `INSERT INTO box_events (at, box_id, box_name, type, actor, actor_project_id, reason, size, from_size, to_size, related_box_id, resize_id, projects_json, task_ids_json, freed_bytes, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        input.boxId,
        input.boxName ?? null,
        input.type,
        input.actor.kind,
        input.actor.kind === "captain" ? input.actor.projectId : null,
        input.reason?.trim() || null,
        input.size ?? null,
        input.fromSize ?? null,
        input.toSize ?? null,
        input.relatedBoxId ?? null,
        input.resizeId ?? null,
        JSON.stringify(input.projects ?? []),
        JSON.stringify(input.taskIds ?? []),
        input.freedBytes ?? null,
        input.detail?.trim() || null,
      )
    this.prune(at)
    return this.get(Number(res.lastInsertRowid))!
  }

  get(id: number): BoxEvent | null {
    const row = this.db.prepare("SELECT * FROM box_events WHERE id = ?").get(id) as BoxEventRow | undefined
    return row ? fromRow(row) : null
  }

  /** Newest first. A projectId keeps the events whose box hosted that project, or that its Captain caused. */
  list(filter: BoxEventFilter = {}): BoxEvent[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.boxId) {
      // A resize's events on the other box count too ("where did my box go" follows the migration).
      where.push("(box_id = ? OR related_box_id = ?)")
      args.push(filter.boxId, filter.boxId)
    }
    if (filter.type) {
      where.push("type = ?")
      args.push(filter.type)
    }
    if (filter.actor) {
      where.push("actor = ?")
      args.push(filter.actor)
    }
    if (filter.projectId) {
      where.push("(actor_project_id = ? OR EXISTS (SELECT 1 FROM json_each(projects_json) WHERE json_extract(value, '$.id') = ?))")
      args.push(filter.projectId, filter.projectId)
    }
    if (filter.before) {
      where.push("id < ?")
      args.push(filter.before)
    }
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 50)))
    const rows = this.db
      .prepare(`SELECT * FROM box_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as BoxEventRow[]
    return rows.map(fromRow)
  }

  /** Every box id the log mentions, newest activity first (the Boxes page's box filter, deleted boxes included). */
  boxIds(projectId?: string): string[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT box_id, MAX(id) AS last FROM box_events
             WHERE actor_project_id = ? OR EXISTS (SELECT 1 FROM json_each(projects_json) WHERE json_extract(value, '$.id') = ?)
             GROUP BY box_id ORDER BY last DESC`,
          )
          .all(projectId, projectId) as { box_id: string }[])
      : (this.db.prepare("SELECT box_id, MAX(id) AS last FROM box_events GROUP BY box_id ORDER BY last DESC").all() as { box_id: string }[])
    return rows.map((r) => r.box_id)
  }

  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM box_events WHERE at < ?").run(now - BOX_HISTORY_MAX_DAYS * 24 * 3600_000)
    this.db.prepare("DELETE FROM box_events WHERE id <= (SELECT id FROM box_events ORDER BY id DESC LIMIT 1 OFFSET ?)").run(BOX_HISTORY_MAX_ROWS)
  }
}
