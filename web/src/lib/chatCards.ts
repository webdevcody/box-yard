// The Coordinator chat as task cards (components/CoordinatorCards.tsx), one per task: which card each update and reply
// belongs to, the cards' order, and the Coordinator card for the rest. Pure, so it is unit tested.
//
// - A task's updates (notices, published files) go to its card; a Captain's report to the cards of the tasks it names.
// - A reply the Coordinator wrote on its own (after reading updates, the "from:" line in lib/chatUpdates.ts) goes to the
//   cards of the tasks it names: a link, an id or a bold title. One turn often reads several projects' updates, so
//   what it read doesn't say which card the reply is about; a reply naming no task stays in the Coordinator card.
//   A reply to Cody stays with his message, in the Coordinator card.
// - What Cody sends to a task from its card stays in it (a sent notice). One its task refused goes to the Coordinator
//   as Cody's message (lib/reroute.ts), so it's in the Coordinator card.
// - Everything else is the Coordinator card's: Cody's messages, the replies to them, errors, and notices about no task.
//   Tool calls aren't shown.
// - An entry about several tasks is on each of their cards.
// - Every task has a card, the chat named it or not: one a Captain started for Cody (he asked it, not the Coordinator)
//   is in no Coordinator chat row until its first update, and it's running all the same. arrangeCards shows one the
//   chat never named while its task is at work or waiting, or for a day after it was made.
// - A card's place is when its task was made, so new activity never moves it; a task made more than CARD_WINDOW_MS
//   before the chat first named it (an old one brought back) sits where the chat named it. The tasks one create_tasks
//   call started (Task.batchId) sit together, in the order they were made, where the first of them sits.
import type { ChatMessage, TaskStatus } from "../../../shared/types"
import type { BadgeStatus } from "./prState"
import type { EntityIndex } from "./linkify"
import { itemMessages, type CoordinatorRow, type UpdateItem, type UpdateSource } from "./chatUpdates"
import { messageRefs } from "./chatProvenance"

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
  /** Its task's id. */
  key: string
  taskId: string
  /** Oldest first. */
  entries: readonly CardEntry[]
  /** Its place in the list: when its task was made, or when the chat first named it (see the top). */
  first: number
  /** When its newest entry came in (`first` while it has none). */
  last: number
  /** The message that started it (Cody's, or a schedule's or hook's prompt), when the chat first named it in that turn. */
  origin: ChatMessage | null
  /** False while the chat hasn't named its task: no entries, and arrangeCards shows it only while it's at work or new. */
  named: boolean
  /** Who started its task, for a card with nothing else to say ("the nebula Captain", "a hook"); null when unknown. */
  startedBy: string | null
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
  /** Task.startedBy: captain:<project>, orchestrator, cody, hook:<id>, agent:<task>, system. */
  startedBy?: string | null
  projectName?: string
}

/** Who started a task, as a card says it. */
function starter(t: CardTask): string | null {
  const s = t.startedBy ?? ""
  if (s.startsWith("captain:")) return t.projectName ? `the ${t.projectName} Captain` : "its Captain"
  if (s === "orchestrator") return "the Coordinator"
  if (s === "cody" || s.startsWith("cody:")) return "you"
  if (s.startsWith("hook:")) return "a hook"
  if (s.startsWith("agent:")) return "another task"
  return null
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

/**
 * The cards and the Coordinator card, from coordinatorRows over the settled chat. `tasks` are the tasks the app knows:
 * an update about tasks it doesn't (deleted ones) isn't shown.
 */
export function chatCards(rows: readonly CoordinatorRow[], index: EntityIndex, tasks: ReadonlyMap<string, CardTask>): CardsModel {
  /** Every entry for a card, in chat order, with its tasks. */
  const placed: CardEntry[] = []
  const coordinator: CardEntry[] = []
  /** When the chat first named each task (and in what order, for names in the same millisecond), and the message that started it. */
  const named = new Map<string, { at: number; seq: number; origin: ChatMessage | null }>()
  const started = new Set<string>()
  /** The newest user message since the last reply: a reply after one answers it. */
  let asked: ChatMessage | null = null

  const name = (m: ChatMessage, origin: ChatMessage | null) => {
    for (const t of messageRefs(m, index).tasks) if (!named.has(t)) named.set(t, { at: m.createdAt, seq: named.size, origin })
  }
  const place = (entry: EntryBody, about: readonly string[]) => {
    if (!about.length) return void coordinator.push({ ...entry, tasks: NO_TASKS })
    const known = about.filter((t) => tasks.has(t))
    // About tasks that are gone: no card shows it.
    if (known.length) placed.push({ ...entry, tasks: known })
  }
  const update = (item: UpdateItem) => {
    const ms = itemMessages(item)
    for (const m of ms) name(m, null)
    place({ type: "update", id: item.id, item, at: Math.max(...ms.map((m) => m.createdAt)) }, itemTasks(item, index))
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
      const about = m.role === "assistant" && !asked ? messageRefs(m, index).tasks.filter((t) => tasks.has(t)) : NO_TASKS
      if (about.length) placed.push({ ...entry, tasks: about })
      else coordinator.push({ ...entry, tasks: NO_TASKS })
      if (m.role === "assistant" || m.role === "error") asked = null
    }
  }

  // One card per task, placed when it was made (or, brought back long after, where the chat first named it).
  const cards = new Map<string, ChatCard & { entries: CardEntry[] }>()
  const seq = new Map<string, number>()
  const card = (id: string) => {
    let c = cards.get(id)
    if (!c) {
      const n = named.get(id)
      const t = tasks.get(id)!
      if (n) seq.set(id, n.seq)
      const first = !n || (t.createdAt <= n.at && n.at - t.createdAt <= CARD_WINDOW_MS) ? t.createdAt : n.at
      const isNamed = Boolean(n) || started.has(id)
      cards.set(id, (c = { key: id, taskId: id, entries: [], first, last: first, origin: n?.origin ?? null, named: isNamed, startedBy: starter(t) }))
    }
    return c
  }
  for (const id of started) if (tasks.has(id)) card(id)
  for (const e of placed) for (const t of new Set(e.tasks)) card(t).entries.push(e)
  for (const id of tasks.keys()) card(id)
  const out = [...cards.values()]
  for (const c of out) {
    c.named ||= c.entries.length > 0
    c.last = Math.max(c.first, ...c.entries.map((e) => e.at))
  }
  // A create_tasks call's tasks stay together, in the order they were made, where the first of them sits.
  type Place = { first: number; seq: number; made: number }
  const own = (c: ChatCard): Place => ({ first: c.first, seq: seq.get(c.key) ?? Infinity, made: 0 })
  const before = (a: Place, b: Place) => a.first - b.first || a.seq - b.seq
  const groups = new Map<string, ChatCard[]>()
  for (const c of out) {
    const b = tasks.get(c.taskId)?.batchId
    if (!b) continue
    let g = groups.get(b)
    if (!g) groups.set(b, (g = []))
    g.push(c)
  }
  const slots = new Map<string, Place>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const at = g.map(own).reduce((a, b) => (before(b, a) < 0 ? b : a))
    // The order they were made: one call's tasks often share a millisecond, and its call names them in that order.
    const made = (c: ChatCard) => tasks.get(c.taskId)!
    g.sort((a, b) => made(a).createdAt - made(b).createdAt || own(a).seq - own(b).seq || made(a).title.localeCompare(made(b).title, undefined, { numeric: true }) || a.key.localeCompare(b.key))
    g.forEach((c, i) => slots.set(c.key, { ...at, made: i }))
  }
  const placeOf = (c: ChatCard) => slots.get(c.key) ?? own(c)
  out.sort((a, b) => {
    const pa = placeOf(a)
    const pb = placeOf(b)
    return before(pa, pb) || pa.made - pb.made || a.key.localeCompare(b.key)
  })
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
    if (p && p.first === c.first && p.last === c.last && p.origin === c.origin && p.taskId === c.taskId && p.named === c.named && p.startedBy === c.startedBy && sameList(p.entries, kept)) return p
    return { ...c, entries: kept }
  })
  const coordinator = keep(next.coordinator)
  return {
    cards: sameList(prev.cards, cards) ? prev.cards : cards,
    coordinator: sameList(prev.coordinator, coordinator) ? prev.coordinator : coordinator,
  }
}

/** Statuses that keep a card in the list however long it's been quiet: work going on, or waiting on Cody or other agents. */
const ACTIVE: ReadonlySet<BadgeStatus> = new Set<TaskStatus>(["queued", "starting", "working", "needs_input", "waiting"])
/** ...and a PR open for review keeps it up past CARD_WINDOW_MS, though it goes idle like any resting card. */
const OPEN: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>([...ACTIVE, "pr_ready"])
const FINISHED: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>(["done", "merged"])

/** Statuses Mark done may close in bulk: the turn is over and nothing waits on Cody (not running, queued or asking). */
export const CLEARABLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["idle", "pr_ready", "failed"])

export interface CardsArrangement {
  live: ChatCard[]
  /** Resting cards quiet for `idleMs` or more: "N idle". */
  idle: ChatCard[]
  /** Finished in the last CARD_WINDOW_MS: "N done today". */
  done: ChatCard[]
}

/**
 * Which cards show: those with work going on, waiting on Cody or with a PR open (one the chat never named: only the
 * first two); the rest while the chat said something about them, or their task was made, in the last CARD_WINDOW_MS. Finished ones fold into "N done" at the top, and with `idleMs` set, resting
 * ones (nothing running, queued or waiting) quiet that long into "N idle". `project` keeps one project's. `stay` keeps a
 * card where it is whatever its task does (one open as its task finishes: Cody is reading its reply).
 */
export function arrangeCards(
  cards: readonly ChatCard[],
  statusOf: (taskId: string) => BadgeStatus | undefined,
  projectOf: (taskId: string) => string | undefined,
  now: number,
  project: string | null,
  stay: (card: ChatCard) => boolean = () => false,
  idleMs = 0,
): CardsArrangement {
  const live: ChatCard[] = []
  const idle: ChatCard[] = []
  const done: ChatCard[] = []
  for (const c of cards) {
    if (project && projectOf(c.taskId) !== project) continue
    const status = statusOf(c.taskId)
    if (!status) continue
    if (stay(c) || ACTIVE.has(status)) live.push(c)
    // One the chat never named: only while at work or waiting, or for a day after it was made (old ones don't flood in).
    else if (c.last < now - CARD_WINDOW_MS && (!c.named || !OPEN.has(status))) continue
    else if (FINISHED.has(status)) done.push(c)
    else if (idleMs > 0 && c.last < now - idleMs) idle.push(c)
    else live.push(c)
  }
  return { live, idle, done }
}

/** The entries that came in after `since`: a card's "N new". */
export const newSince = (entries: readonly CardEntry[], since: number) => entries.reduce((n, e) => (e.at > since ? n + 1 : n), 0)
