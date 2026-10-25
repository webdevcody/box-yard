import type { CompactionRecord } from "../shared/types.js"
import { mentionedTaskIds } from "./compactionTasks.js"
import { readCompactionRecords } from "./compactions.js"
import type { Store } from "./store.js"

/**
 * Keyword search over what the Coordinator and the Captains said and saved before: compaction
 * summaries, chat transcripts and tasks. It is a scan, not an index, so every SQL source walks its table
 * newest first and stops at the limit; task transcripts are opt-in and only their newest rows are read.
 */

export const HISTORY_SOURCES = ["summaries", "chat", "tasks", "transcripts"] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]
export const DEFAULT_HISTORY_SOURCES: HistorySource[] = ["summaries", "chat", "tasks"]

export type HitKind = "coordinator_summary" | "captain_summary" | "coordinator_chat" | "captain_chat" | "task" | "task_summary" | "task_transcript"

export interface HistoryHit {
  kind: HitKind
  /** Compaction, message or task id. */
  id: string
  at: number
  projectId?: string
  /** A summary's markdown file. */
  file?: string
  /** The summary section the snippet is from, or a message's role. */
  where?: string
  taskIds?: string[]
  snippet: string
}

export interface HistoryScope {
  /** Only this project's history. Unset: the Coordinator's own and every project's. */
  projectId?: string
  /** Search the Coordinator's own summaries and chat (never for a Captain). */
  coordinator: boolean
}

export interface HistoryQuery {
  terms: string[]
  sources: HistorySource[]
  since?: number
  until?: number
  limit: number
}

export interface HistoryReaders {
  store: Store
  /** The Coordinator's compaction log folder (its files are the summaries; older ones may not be in the DB). */
  coordinatorCompactionsDir?: string
  /** A project's Captain compactions, newest first; unset when no Captains run in this process. */
  captainCompactions?: (projectId: string) => CompactionRecord[]
}

/** Transcript search reads at most this many of the newest task transcript rows. */
export const TRANSCRIPT_SCAN_ROWS = 100_000
const SNIPPET_RADIUS = 160
const MAX_TERMS = 8

/** Words and "quoted phrases", lowercased. Every one must appear in a hit. */
export function parseTerms(query: string): string[] {
  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const t = (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim().toLowerCase()
    if (t && !terms.includes(t)) terms.push(t)
  }
  return terms.slice(0, MAX_TERMS)
}

const matches = (text: string, terms: string[]) => {
  const lower = text.toLowerCase()
  return terms.every((t) => lower.includes(t))
}

/** The text around the first term found, on one line, cut at word boundaries where it can be. */
export function snippetOf(text: string, terms: string[], radius = SNIPPET_RADIUS): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const lower = flat.toLowerCase()
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)
  const at = hit.length ? Math.min(...hit) : 0
  let start = Math.max(0, at - radius)
  let end = Math.min(flat.length, at + radius)
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start
  if (end < flat.length) end = flat.lastIndexOf(" ", end) > at ? flat.lastIndexOf(" ", end) : end
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`
}

/** The "## " heading above a position in a markdown summary. */
function sectionAt(markdown: string, index: number): string | undefined {
  const before = markdown.slice(0, index)
  const m = [...before.matchAll(/^## (.+)$/gm)].at(-1)
  return m?.[1]?.trim()
}

/** A LIKE pattern for a term, with % and _ taken literally (ESCAPE '\'). */
const like = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

function inWindow(at: number, q: HistoryQuery) {
  return (q.since === undefined || at >= q.since) && (q.until === undefined || at <= q.until)
}

function summaryHits(records: CompactionRecord[], kind: HitKind, q: HistoryQuery, projectId?: string): HistoryHit[] {
  const out: HistoryHit[] = []
  for (const r of records) {
    if (out.length >= q.limit) break
    const markdown = r.markdown ?? ""
    if (!inWindow(r.at, q) || !matches(markdown, q.terms)) continue
    // Point at the body, not a frontmatter line that happens to match (e.g. a task id in task_ids).
    const body = markdown.indexOf("\n## ")
    const lower = markdown.toLowerCase()
    const first = Math.min(...q.terms.map((t) => {
      const i = lower.indexOf(t, Math.max(0, body))
      return i < 0 ? lower.indexOf(t) : i
    }))
    const text = markdown.slice(Math.max(0, body))
    out.push({
      kind,
      id: r.id,
      at: r.at,
      projectId,
      file: r.file,
      where: sectionAt(markdown, first),
      taskIds: [...mentionedTaskIds([snippetOf(text, q.terms, SNIPPET_RADIUS * 2)])],
      snippet: snippetOf(text, q.terms),
    })
  }
  return out
}

type MessageRow = { id: string; role: string; content: string; meta_json: string | null; created_at: number; project_id?: string; task_id?: string }

/** Where-clauses shared by the SQL sources: every term in `column`, inside the time window. */
function termClauses(column: string, timeColumn: string, q: HistoryQuery) {
  const where = q.terms.map(() => `${column} LIKE ? ESCAPE '\\'`)
  const args: (string | number)[] = q.terms.map(like)
  if (q.since !== undefined) {
    where.push(`${timeColumn} >= ?`)
    args.push(q.since)
  }
  if (q.until !== undefined) {
    where.push(`${timeColumn} <= ?`)
    args.push(q.until)
  }
  return { where, args }
}

function messageHit(kind: HitKind, r: MessageRow, q: HistoryQuery): HistoryHit {
  let meta: unknown = null
  try {
    meta = r.meta_json ? JSON.parse(r.meta_json) : null
  } catch {}
  const ids = mentionedTaskIds([r.content, meta])
  if (r.task_id) ids.add(r.task_id)
  return { kind, id: r.id, at: r.created_at, projectId: r.project_id, where: r.role, taskIds: ids.size ? [...ids] : undefined, snippet: snippetOf(r.content, q.terms) }
}

const CHAT_ROLES = "('user', 'assistant', 'notice')"

function coordinatorChat(store: Store, q: HistoryQuery): HistoryHit[] {
  const { where, args } = termClauses("content", "created_at", q)
  const rows = store.db
    .prepare(`SELECT id, role, content, meta_json, created_at FROM chat_messages WHERE role IN ${CHAT_ROLES} AND ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`)
    .all(...args, q.limit) as MessageRow[]
  return rows.map((r) => messageHit("coordinator_chat", r, q))
}

function captainChat(store: Store, q: HistoryQuery, projectId?: string): HistoryHit[] {
  const { where, args } = termClauses("content", "created_at", q)
  if (projectId) {
    where.push("project_id = ?")
    args.push(projectId)
  }
  const rows = store.db
    .prepare(`SELECT id, project_id, role, content, meta_json, created_at FROM captain_messages WHERE role IN ${CHAT_ROLES} AND ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`)
    .all(...args, q.limit) as MessageRow[]
  return rows.map((r) => messageHit("captain_chat", r, q))
}

function taskHits(store: Store, q: HistoryQuery, projectId?: string): HistoryHit[] {
  const text = "(title || char(10) || prompt || char(10) || COALESCE(summary, '') || char(10) || COALESCE(question, '') || char(10) || COALESCE(error, '') || char(10) || COALESCE(pr_url, ''))"
  const { where, args } = termClauses(text, "updated_at", q)
  if (projectId) {
    where.push("project_id = ?")
    args.push(projectId)
  }
  const rows = store.db
    .prepare(`SELECT id, project_id, title, ${text} AS body, status, updated_at FROM tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args, q.limit) as { id: string; project_id: string; title: string; body: string; status: string; updated_at: number }[]
  const tasks = rows.map((r) => ({ kind: "task" as const, id: r.id, at: r.updated_at, projectId: r.project_id, where: r.status, taskIds: [r.id], snippet: snippetOf(r.body, q.terms) }))

  const s = termClauses("tc.summary", "tc.at", q)
  if (projectId) {
    s.where.push("t.project_id = ?")
    s.args.push(projectId)
  }
  const summaries = store.db
    .prepare(
      `SELECT tc.id, tc.task_id, tc.summary, tc.at, t.project_id FROM task_compactions tc JOIN tasks t ON t.id = tc.task_id
       WHERE ${s.where.join(" AND ")} ORDER BY tc.at DESC LIMIT ?`,
    )
    .all(...s.args, q.limit) as { id: string; task_id: string; summary: string; at: number; project_id: string }[]
  return [
    ...tasks,
    ...summaries.map((r) => ({ kind: "task_summary" as const, id: r.id, at: r.at, projectId: r.project_id, taskIds: [r.task_id], snippet: snippetOf(r.summary, q.terms) })),
  ]
}

function transcriptHits(store: Store, q: HistoryQuery, projectId?: string): HistoryHit[] {
  const newest = (store.db.prepare("SELECT MAX(rowid) AS n FROM task_messages").get() as { n: number | null }).n ?? 0
  const { where, args } = termClauses("m.content", "m.created_at", q)
  if (projectId) {
    where.push("t.project_id = ?")
    args.push(projectId)
  }
  const rows = store.db
    .prepare(
      `SELECT m.id, m.task_id, m.role, m.content, m.meta_json, m.created_at, t.project_id FROM task_messages m JOIN tasks t ON t.id = m.task_id
       WHERE m.rowid > ? AND m.role IN ('user', 'assistant') AND ${where.join(" AND ")} ORDER BY m.rowid DESC LIMIT ?`,
    )
    .all(newest - TRANSCRIPT_SCAN_ROWS, ...args, q.limit) as MessageRow[]
  return rows.map((r) => messageHit("task_transcript", r, q))
}

/** Hits from every source the scope allows, newest first, at most `limit`, with how many each source had. */
export function searchHistory(readers: HistoryReaders, scope: HistoryScope, q: HistoryQuery): { hits: HistoryHit[]; perSource: Partial<Record<HitKind, number>> } {
  const { store } = readers
  const hits: HistoryHit[] = []
  const want = new Set(q.sources)
  if (want.has("summaries")) {
    if (scope.coordinator && !scope.projectId && readers.coordinatorCompactionsDir) {
      hits.push(...summaryHits(readCompactionRecords(readers.coordinatorCompactionsDir), "coordinator_summary", q))
    }
    if (readers.captainCompactions) {
      const projects = scope.projectId ? [scope.projectId] : store.listProjects().map((p) => p.id)
      for (const id of projects) hits.push(...summaryHits(readers.captainCompactions(id), "captain_summary", q, id))
    }
  }
  if (want.has("chat")) {
    if (scope.coordinator && !scope.projectId) hits.push(...coordinatorChat(store, q))
    hits.push(...captainChat(store, q, scope.projectId))
  }
  if (want.has("tasks")) hits.push(...taskHits(store, q, scope.projectId))
  if (want.has("transcripts")) hits.push(...transcriptHits(store, q, scope.projectId))
  const perSource: Partial<Record<HitKind, number>> = {}
  for (const h of hits) perSource[h.kind] = (perSource[h.kind] ?? 0) + 1
  return { hits: hits.sort((a, b) => b.at - a.at).slice(0, q.limit), perSource }
}

type ChatRow = { id: string; role: string; content: string; created_at: number }

/** A chat message in full (capped) with the messages just before and after it, for opening a chat hit. */
export function chatAround(
  store: Store,
  id: string,
  scope: HistoryScope,
  opts: { before?: number; after?: number; maxChars?: number } = {},
): { kind: HitKind; projectId?: string; messages: { id: string; role: string; at: number; content: string }[] } | null {
  const before = opts.before ?? 3
  const after = opts.after ?? 3
  const max = opts.maxChars ?? 4000
  const view = (r: ChatRow) => ({ id: r.id, role: r.role, at: r.created_at, content: r.content.length > max ? `${r.content.slice(0, max)}… [${r.content.length - max} more chars]` : r.content })
  const thread = (table: string, n: number, extra: string, args: string[]) => {
    const older = store.db
      .prepare(`SELECT id, role, content, created_at FROM ${table} WHERE rowid < ? AND role IN ${CHAT_ROLES}${extra} ORDER BY rowid DESC LIMIT ?`)
      .all(n, ...args, before) as ChatRow[]
    const newer = store.db
      .prepare(`SELECT id, role, content, created_at FROM ${table} WHERE rowid >= ? AND (role IN ${CHAT_ROLES} OR rowid = ?)${extra} ORDER BY rowid LIMIT ?`)
      .all(n, n, ...args, after + 1) as ChatRow[]
    return [...older.reverse(), ...newer].map(view)
  }
  if (scope.coordinator && !scope.projectId) {
    const hit = store.db.prepare("SELECT rowid AS n FROM chat_messages WHERE id = ?").get(id) as { n: number } | undefined
    if (hit) return { kind: "coordinator_chat", messages: thread("chat_messages", hit.n, "", []) }
  }
  const hit = store.db.prepare("SELECT rowid AS n, project_id FROM captain_messages WHERE id = ?").get(id) as { n: number; project_id: string } | undefined
  if (!hit || (scope.projectId && hit.project_id !== scope.projectId)) return null
  return { kind: "captain_chat", projectId: hit.project_id, messages: thread("captain_messages", hit.n, " AND project_id = ?", [hit.project_id]) }
}
