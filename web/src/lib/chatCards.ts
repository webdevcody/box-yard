// The Coordinator chat as task cards (components/CoordinatorCards.tsx): which card each update and reply belongs to,
// the cards' order, a batch's one card, and the Coordinator card for the rest. Pure, so it is unit tested.
//
// - A task's updates (notices, published files) go to its card; a Captain's report to the cards of the tasks it names.
// - A reply the Coordinator wrote on its own after reading updates (the "from:" line, lib/chatUpdates.ts) goes to the
//   cards of the tasks those updates are about. A reply to Cody stays with his message, in the Coordinator card.
// - Everything else is the Coordinator card's: Cody's messages, the replies to them, errors, and notices about no task.
//   Tool calls show only in the timeline.
// - A card's place is where the chat first named its task, so new activity never moves it.
// - The tasks one create_tasks call started (Task.batchId) share one card when there are BATCH_MIN or more.
import type { ChatMessage, TaskStatus } from "../../../shared/types"
import type { BadgeStatus } from "./prState"
import type { EntityIndex } from "./linkify"
import { itemMessages, type CoordinatorRow, type UpdateItem, type UpdateSource } from "./chatUpdates"
import { messageRefs } from "./chatProvenance"

/** A create_tasks call this big or bigger is one card; smaller ones are a card per task. */
export const BATCH_MIN = 3

/** How long a finished or resting task keeps its card after the chat last said something about it. */
export const CARD_WINDOW_MS = 24 * 60 * 60_000

type EntryBody = (
  | { type: "update"; id: string; item: UpdateItem }
  | { type: "message"; id: string; message: ChatMessage; sources: UpdateSource[] | null }
) & {
  /** When it came in (an update of several files: the newest). */
  at: number
}

/** One thing a card shows: an update (its chip), or a message (a reply, a question, a failure). */
export type CardEntry = EntryBody & {
  /** The tasks it's about; empty in the Coordinator card. */
  tasks: readonly string[]
}

export interface ChatCard {
  /** The task's id, or `batch:<batch id>`. */
  key: string
  /** Its task, or a batch's tasks in the order they were made. */
  taskIds: readonly string[]
  batchId: string | null
  /** Oldest first. */
  entries: readonly CardEntry[]
  /** When the chat first named it: its place in the list. */
  first: number
  /** When its newest entry came in (`first` while it has none). */
  last: number
  /** The message that started it (Cody's, or a schedule's or hook's prompt), when the chat first named it in that turn. */
  origin: ChatMessage | null
}

export interface CardsModel {
  /** In the order the chat first named them. */
  cards: ChatCard[]
  /** The Coordinator card's entries, oldest first. */
  coordinator: CardEntry[]
}

/** What the model needs of a task (the tiles store has it, and it doesn't change on status updates). */
export interface CardTask {
  id: string
  title: string
  batchId: string | null
  createdAt: number
}

const NO_TASKS: readonly string[] = []

const taskOf = (m: ChatMessage) => (typeof m.meta?.taskId === "string" ? m.meta.taskId : null)

/** The tasks a notice is about: a Captain's report, the ones it names; a task's notice, its task. */
function noticeTasks(m: ChatMessage, index: EntityIndex): readonly string[] {
  if (m.meta?.captain === true) return messageRefs(m, index).tasks
  const t = taskOf(m)
  return t ? [t] : NO_TASKS
}

function itemTasks(item: UpdateItem, index: EntityIndex): readonly string[] {
  if (item.type === "files") return item.group.taskId ? [item.group.taskId] : NO_TASKS
  return noticeTasks(item.message, index)
}

/** The tasks a Coordinator tool call started: create_task's new id, or create_tasks' items (by title). */
function startedBy(m: ChatMessage, index: EntityIndex): readonly string[] {
  if (m.content === "create_task") return typeof m.meta?.resultId === "string" ? [m.meta.resultId] : NO_TASKS
  if (m.content === "create_tasks") return messageRefs(m, index).tasks
  return NO_TASKS
}

/** A batch's tasks in the order they were made (one create_tasks call shares a timestamp, so then by title). */
const byCreation = (a: CardTask, b: CardTask) => a.createdAt - b.createdAt || a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id)

/** Each batch of BATCH_MIN or more, by its id: its tasks in order. */
export function batchesOf(tasks: ReadonlyMap<string, CardTask>): Map<string, string[]> {
  const groups = new Map<string, CardTask[]>()
  for (const t of tasks.values()) {
    if (!t.batchId) continue
    let g = groups.get(t.batchId)
    if (!g) groups.set(t.batchId, (g = []))
    g.push(t)
  }
  const out = new Map<string, string[]>()
  for (const [id, g] of groups) if (g.length >= BATCH_MIN) out.set(id, g.sort(byCreation).map((t) => t.id))
  return out
}

/**
 * The cards and the Coordinator card, from coordinatorRows over the settled chat. `tasks` are the tasks the app knows:
 * an update about tasks it doesn't (deleted ones) shows only in the timeline.
 */
export function chatCards(rows: readonly CoordinatorRow[], index: EntityIndex, tasks: ReadonlyMap<string, CardTask>): CardsModel {
  /** Every entry for a card, in chat order, with its tasks. */
  const placed: CardEntry[] = []
  const coordinator: CardEntry[] = []
  /** When the chat first named each task, and the message that started it. */
  const named = new Map<string, { at: number; origin: ChatMessage | null }>()
  const started = new Set<string>()
  const items = new Map<string, UpdateItem>()
  /** The newest user message since the last reply: a reply after one answers it. */
  let asked: ChatMessage | null = null

  const name = (m: ChatMessage, origin: ChatMessage | null) => {
    for (const t of messageRefs(m, index).tasks) if (!named.has(t)) named.set(t, { at: m.createdAt, origin })
  }
  const place = (entry: EntryBody, about: readonly string[]) => {
    if (!about.length) return void coordinator.push({ ...entry, tasks: NO_TASKS })
    const known = about.filter((t) => tasks.has(t))
    // About tasks that are gone: the timeline still has it.
    if (known.length) placed.push({ ...entry, tasks: known })
  }
  const update = (item: UpdateItem) => {
    items.set(item.id, item)
    const ms = itemMessages(item)
    for (const m of ms) name(m, null)
    place({ type: "update", id: item.id, item, at: Math.max(...ms.map((m) => m.createdAt)) }, itemTasks(item, index))
  }
  /** The tasks of the updates a reply read. */
  const readTasks = (sources: readonly UpdateSource[] | null) => {
    const out = new Set<string>()
    for (const s of sources ?? []) {
      if (s.taskId) out.add(s.taskId)
      else {
        const item = items.get(s.id)
        if (item) for (const t of itemTasks(item, index)) out.add(t)
      }
    }
    return [...out]
  }

  for (const r of rows) {
    if (r.type === "update") update(r.item)
    else if (r.type === "updates") for (const item of r.items) update(item)
    else {
      const m = r.message
      const entry = { type: "message" as const, id: m.id, message: m, sources: r.sources, at: m.createdAt }
      if (m.role === "notice") {
        name(m, null)
        place(entry, noticeTasks(m, index))
        continue
      }
      if (m.role === "user") asked = m
      name(m, asked)
      if (m.role === "tool") {
        for (const t of startedBy(m, index)) started.add(t)
        continue
      }
      // A reply about tasks that are all gone stays in the Coordinator card rather than vanishing.
      const about = m.role === "assistant" && !asked ? readTasks(r.sources).filter((t) => tasks.has(t)) : NO_TASKS
      if (about.length) placed.push({ ...entry, tasks: about })
      else coordinator.push({ ...entry, tasks: NO_TASKS })
      if (m.role === "assistant" || m.role === "error") asked = null
    }
  }

  // Each task's card: its own, or its batch's.
  const batches = batchesOf(tasks)
  const keyOf = (id: string) => {
    const b = tasks.get(id)?.batchId
    return b && batches.has(b) ? `batch:${b}` : id
  }
  const cards = new Map<string, ChatCard & { entries: CardEntry[] }>()
  const card = (id: string) => {
    const key = keyOf(id)
    let c = cards.get(key)
    if (!c) {
      const batchId = key === id ? null : tasks.get(id)!.batchId!
      const taskIds = batchId ? batches.get(batchId)! : [id]
      // The member the chat named first places the card and says where it came from.
      let first = Infinity
      let origin: ChatMessage | null = null
      for (const t of taskIds) {
        const n = named.get(t)
        if (n && n.at < first) {
          first = n.at
          origin = n.origin
        }
      }
      cards.set(key, (c = { key, taskIds, batchId, entries: [], first, last: first, origin }))
    }
    return c
  }
  for (const id of started) if (tasks.has(id)) card(id)
  for (const e of placed) {
    const seen = new Set<string>()
    for (const t of e.tasks) {
      const c = card(t)
      if (seen.has(c.key)) continue
      seen.add(c.key)
      c.entries.push(e)
    }
  }
  const out = [...cards.values()]
  for (const c of out) {
    if (!Number.isFinite(c.first)) c.first = c.entries[0]?.at ?? 0
    c.last = Math.max(c.first, ...c.entries.map((e) => e.at))
  }
  out.sort((a, b) => a.first - b.first || a.key.localeCompare(b.key))
  return { cards: out, coordinator }
}

const sameList = <T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is) => a.length === b.length && a.every((x, i) => eq(x, b[i]!))

function sameEntry(a: CardEntry, b: CardEntry): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.id !== b.id || a.at !== b.at || !sameList(a.tasks, b.tasks)) return false
  if (a.type === "update" && b.type === "update") return a.item === b.item || sameList(itemMessages(a.item), itemMessages(b.item))
  if (a.type === "message" && b.type === "message") return a.message === b.message && a.sources === b.sources
  return false
}

/** `next` with every entry, card and list that didn't change kept as its object from `prev`, so memo'd cards skip. */
export function stableCards(prev: CardsModel | null, next: CardsModel): CardsModel {
  if (!prev) return next
  const entries = new Map<string, CardEntry>()
  for (const e of prev.coordinator) entries.set(e.id, e)
  for (const c of prev.cards) for (const e of c.entries) entries.set(e.id, e)
  const keep = (list: readonly CardEntry[]) =>
    list.map((e) => {
      const p = entries.get(e.id)
      return p && sameEntry(p, e) ? p : e
    })
  const byKey = new Map(prev.cards.map((c) => [c.key, c]))
  const cards = next.cards.map((c) => {
    const kept = keep(c.entries)
    const p = byKey.get(c.key)
    if (p && p.first === c.first && p.last === c.last && p.origin === c.origin && p.batchId === c.batchId && sameList(p.taskIds, c.taskIds) && sameList(p.entries, kept)) return p
    return { ...c, entries: kept }
  })
  const coordinator = keep(next.coordinator)
  return {
    cards: sameList(prev.cards, cards) ? prev.cards : cards,
    coordinator: sameList(prev.coordinator, coordinator) ? prev.coordinator : coordinator,
  }
}

/** Statuses that keep a card up however long the chat has been quiet about it: work going on, or waiting on Cody. */
const OPEN: ReadonlySet<BadgeStatus> = new Set<TaskStatus>(["queued", "starting", "working", "needs_input", "waiting", "pr_ready"])
const FINISHED: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>(["done", "merged"])

/**
 * Which cards show: those with work going on, waiting on Cody or with a PR open; the rest while the chat said something
 * about them in the last CARD_WINDOW_MS. Finished ones fold into "N done" at the top. `project` keeps one project's.
 */
export function arrangeCards(
  cards: readonly ChatCard[],
  statusOf: (taskId: string) => BadgeStatus | undefined,
  projectOf: (taskId: string) => string | undefined,
  now: number,
  project: string | null,
): { live: ChatCard[]; done: ChatCard[] } {
  const live: ChatCard[] = []
  const done: ChatCard[] = []
  for (const c of cards) {
    if (project && projectOf(c.taskIds[0]!) !== project) continue
    const statuses = c.taskIds.map(statusOf).filter((s): s is BadgeStatus => s !== undefined)
    if (!statuses.length) continue
    if (statuses.some((s) => OPEN.has(s))) live.push(c)
    else if (c.last < now - CARD_WINDOW_MS) continue
    else if (statuses.every((s) => FINISHED.has(s))) done.push(c)
    else live.push(c)
  }
  return { live, done }
}

/** The entries that came in after `since`: a card's "N new". */
export const newSince = (entries: readonly CardEntry[], since: number) => entries.reduce((n, e) => (e.at > since ? n + 1 : n), 0)

/** A batch's title: the words its tasks' titles start with ("Map 3 PR #399: …", "Map 3 PR #400: …" → "Map 3 PR"), or null. */
export function batchTitle(titles: readonly string[]): string | null {
  if (titles.length < 2) return null
  const words = titles.map((t) => t.trim().split(/\s+/))
  const common: string[] = []
  for (let i = 0; words.every((w) => i < w.length - 1 && w[i] === words[0]![i]); i++) common.push(words[0]![i]!)
  const title = common.join(" ").replace(/[\s:·—–#-]+$/, "")
  return /[\p{L}\p{N}]/u.test(title) ? title : null
}

/** A batch task's name inside its card: its title without the words every task in the batch starts with. */
export function batchTaskName(title: string, batch: string | null): string {
  if (!batch || !title.startsWith(batch)) return title
  return title.slice(batch.length).replace(/^[\s:·—–-]+/, "") || title
}
