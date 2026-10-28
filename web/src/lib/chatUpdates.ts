// The Coordinator chat's update notices as one-line chips. Pure, so it is unit tested; the chips themselves are
// components/UpdateChips.tsx. A notice shows as a chip until it's opened; back-to-back chips fold into one
// "N updates" chip; questions, failures and merge requests stay full cards. A Coordinator reply that follows
// updates it read gets a "from: …" line naming them (`sources`), so the reply is the version Cody reads.
import type { ChatMessage } from "../../../shared/types"
import { groupPublished, type PublishedGroup } from "./publishedNotices"
import { noticeKind, plainText, segments, splitNotice, type NoticeKind } from "./captainTranscript"
import { stripTruncation } from "./truncated"
import { routes } from "./linkify"

/** Notices that wait on Cody or went wrong: always a full card with an accent, never a chip. */
export const ATTENTION_KINDS: ReadonlySet<NoticeKind> = new Set(["needs_input", "failed", "merge"])

export const isAttention = (m: Pick<ChatMessage, "role" | "content" | "meta">) => m.role === "notice" && ATTENTION_KINDS.has(noticeKind(m.content, m.meta))

/**
 * Whether the Coordinator reads this notice with its next updates. A task notice goes to the task's project Captain
 * instead (TaskManager.notice marks it seen at once), except hook fires and merge requests ({ coordinator: true }).
 * A Captain's report, and notices about no task (warnings, settings, boxes), are the Coordinator's. A compaction
 * notice is only for Cody.
 */
export function readByCoordinator(m: Pick<ChatMessage, "role" | "content" | "meta">): boolean {
  if (m.role !== "notice") return false
  if (m.meta?.captain === true) return true
  const kind = noticeKind(m.content, m.meta)
  if (kind === "compaction") return false
  return typeof m.meta?.taskId !== "string" || kind === "hook" || kind === "merge"
}

/** One update: a notice, or one task's back-to-back published files. */
export type UpdateItem = { type: "notice"; id: string; message: ChatMessage } | { type: "files"; id: string; group: PublishedGroup<ChatMessage> }

/** An update a reply covers: the item, the row it's in (itself, or its "N updates" group) and what it's from. */
export interface UpdateSource {
  id: string
  rowId: string
  /** "box-yard Captain", the task's title, or null for a notice about no task (the kind names it). */
  label: string | null
  kind: NoticeKind
}

export type CoordinatorRow =
  /** Any other message; a Coordinator reply carries the updates it covers. */
  | { type: "message"; id: string; message: ChatMessage; sources: UpdateSource[] | null }
  | { type: "update"; id: string; item: UpdateItem }
  /** Two or more updates in a row; its id is the first one's, so it stays the same row as updates join. */
  | { type: "updates"; id: string; items: UpdateItem[] }

type MessageRow = Extract<CoordinatorRow, { type: "message" }>

export const itemMessages = (item: UpdateItem): ChatMessage[] => (item.type === "files" ? item.group.messages : [item.message])

export const rowMessages = (row: CoordinatorRow): ChatMessage[] =>
  row.type === "message" ? [row.message] : row.type === "update" ? itemMessages(row.item) : row.items.flatMap(itemMessages)

/** "Captain for box-yard replied: …" / "Captain for box-yard: …" (server/app.ts captains.onReport). */
const CAPTAIN_RE = /^Captain(?: for (.+?))?( replied)?:\s*([\s\S]*)$/

export interface ChipView {
  kind: NoticeKind
  /** A Captain's report or reply: the chip shows the Captain's icon. */
  captain: boolean
  /** What it's from, linked in place when known: "box-yard Captain", or the task. */
  source: { label: string; href: string | null } | null
  /** "replied", "done", "opened a PR", or "" when the notice names nothing. */
  verb: string
  /** The rest, as one line of plain text. */
  preview: string
}

/** Plain text with URLs as their short labels ("PR #16", a file name). */
const plainLine = (md: string) =>
  segments(plainText(md))
    .map((s) => ("href" in s ? s.label : s.text))
    .join("")
    .trim()

const VERBS: Record<string, string> = { "is done": "done", "opened a pull request": "opened a PR" }

const chipViews = new WeakMap<ChatMessage, ChipView>()

/** What a notice's chip says: icon kind, source, verb and a short preview. Cached per message. */
export function chipView(m: ChatMessage): ChipView {
  const cached = chipViews.get(m)
  if (cached) return cached
  const view = readChip(m)
  chipViews.set(m, view)
  return view
}

function readChip(m: ChatMessage): ChipView {
  const text = stripTruncation(m.content).text
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  if (m.meta?.captain === true) {
    const c = text.match(CAPTAIN_RE)
    const name = c?.[1] ?? "Project"
    return {
      kind: "message",
      captain: true,
      source: { label: `${name} Captain`, href: projectId ? `${routes.project(projectId)}?tab=captain` : null },
      verb: c?.[2] ? "replied" : "reports",
      preview: plainLine(c ? c[3]! : text),
    }
  }
  const n = splitNotice(text, m.meta)
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  if (!n.title) return { kind: n.kind, captain: false, source: null, verb: "", preview: plainLine(n.event) }
  const event = plainLine(n.event)
  // An artifact's title may itself contain ": "; its URL comes after the last one.
  const colon = n.kind === "artifact" ? event.lastIndexOf(": ") : event.indexOf(": ")
  const verb = (colon >= 0 ? event.slice(0, colon) : event).replace(/:$/, "")
  return {
    kind: n.kind,
    captain: false,
    source: { label: n.title, href: taskId ? routes.task(taskId) : null },
    verb: VERBS[verb] ?? verb,
    preview: colon >= 0 ? event.slice(colon + 2) : "",
  }
}

function sourceOf(item: UpdateItem, rowId: string): UpdateSource {
  if (item.type === "files") return { id: item.id, rowId, label: item.group.taskTitle, kind: "artifact" }
  const v = chipView(item.message)
  return { id: item.id, rowId, label: v.source?.label ?? null, kind: v.kind }
}

/**
 * The chat's rows, oldest first. Published files fold per task first (lib/publishedNotices.ts). Every notice that
 * isn't a question, failure or merge request becomes an update; two or more updates with nothing between them form
 * one group. Only Box Yard's own words separate them: a Coordinator reply of "(no update)" is never stored.
 *
 * Which updates a reply covers: a turn reads every update that came in before it started, so a reply covers the
 * Coordinator-read updates (readByCoordinator) that arrived before its turn's first tool call or, with none, before
 * the reply. One that arrived after that tool call came in mid-turn and waits for the next reply. Updates the reply
 * didn't read (a task notice its Captain handled) aren't listed.
 */
export function coordinatorRows(messages: readonly ChatMessage[]): CoordinatorRow[] {
  const rows: CoordinatorRow[] = []
  let run: UpdateItem[] = []
  /** Updates that came in and no turn has read yet, and the ones the current turn read. */
  let waiting: UpdateItem[] = []
  let read: UpdateItem[] = []
  let started = false
  const rowOf = new Map<string, string>()
  const covers: [MessageRow, UpdateItem[]][] = []
  const flush = () => {
    if (run.length === 1) rows.push({ type: "update", id: run[0]!.id, item: run[0]! })
    else if (run.length > 1) {
      rows.push({ type: "updates", id: run[0]!.id, items: run })
      for (const item of run) rowOf.set(item.id, run[0]!.id)
    }
    run = []
  }
  const start = () => {
    if (started) return
    started = true
    read = read.concat(waiting)
    waiting = []
  }
  for (const r of groupPublished(messages)) {
    if (r.type === "files") {
      run.push(r)
      if (r.group.messages.some(readByCoordinator)) waiting.push(r)
      continue
    }
    const m = r.message
    if (m.role === "notice") {
      const item: UpdateItem = { type: "notice", id: m.id, message: m }
      if (readByCoordinator(m)) waiting.push(item)
      if (!isAttention(m)) {
        run.push(item)
        continue
      }
    }
    flush()
    if (m.role === "tool") start()
    const row: MessageRow = { type: "message", id: m.id, message: m, sources: null }
    rows.push(row)
    if (m.role === "assistant") {
      start()
      if (read.length) covers.push([row, read])
    }
    if (m.role === "assistant" || m.role === "error") {
      read = []
      started = false
    }
  }
  flush()
  // Each covered update's row is known once every group is.
  for (const [row, items] of covers) row.sources = items.map((item) => sourceOf(item, rowOf.get(item.id) ?? item.id))
  return rows
}

/** The distinct names in a reply's "from:" line, in order: "box-yard Captain", "Fix login", "Warning". */
export function sourceLabels(sources: readonly UpdateSource[], kindLabel: (kind: NoticeKind) => string): string[] {
  return [...new Set(sources.map((s) => s.label ?? kindLabel(s.kind)))]
}

/** The distinct sources a group's chip previews: "box-yard Captain, Fix login +2". */
export function groupPreview(items: readonly UpdateItem[], max = 2): string {
  const names = [...new Set(items.map((item) => (item.type === "files" ? item.group.taskTitle : (chipView(item.message).source?.label ?? chipView(item.message).preview))))]
  return names.slice(0, max).join(", ") + (names.length > max ? ` +${names.length - max}` : "")
}

const sameList = <T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is) => a.length === b.length && a.every((x, i) => eq(x, b[i]!))
const sameSource = (a: UpdateSource, b: UpdateSource) => a.id === b.id && a.rowId === b.rowId && a.label === b.label && a.kind === b.kind

function sameRow(a: CoordinatorRow, b: CoordinatorRow): boolean {
  if (a.type !== b.type || a.id !== b.id || !sameList(rowMessages(a), rowMessages(b))) return false
  if (a.type === "message" && b.type === "message") return a.sources === b.sources || (a.sources !== null && b.sources !== null && sameList(a.sources, b.sources, sameSource))
  return true
}

/**
 * `next` with every row that didn't change replaced by its object from `prev`, so memo'd rows skip re-rendering
 * when a message streams in: only new rows, and rows a new message joined, are new objects.
 */
export function stableRows(prev: readonly CoordinatorRow[], next: CoordinatorRow[]): CoordinatorRow[] {
  if (!prev.length) return next
  const byId = new Map(prev.map((r) => [r.id, r]))
  return next.map((r) => {
    const p = byId.get(r.id)
    return p && sameRow(p, r) ? p : r
  })
}

/**
 * The rows from the one holding message `id` on: the rendered tail of the thread (lib/tail.ts). The rows are worked
 * out over the whole thread, so a group or a reply's sources don't change as the tail grows or trims.
 */
export function rowsFrom(rows: CoordinatorRow[], id: string | undefined): CoordinatorRow[] {
  if (id === undefined) return []
  const at = rows.findIndex((r) => rowMessages(r).some((m) => m.id === id))
  return at <= 0 ? rows : rows.slice(at)
}
