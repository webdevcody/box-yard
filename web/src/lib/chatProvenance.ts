// Which projects each Coordinator chat message is about, for the project bar's filter (components/ProjectBar.tsx).
// Pure, so it is unit tested.
//
// A notice is about its task and project (meta). A Captain's report is about its project and the tasks it names.
// A Coordinator turn (the messages that asked, its tool calls, its reply) is one unit: every message in it is about
// every project any of them names (a tool's task or project, the task it created, task links, ids and bold titles in
// the text) and every project of the updates its reply read (the "from:" line, lib/chatUpdates.ts).
import type { ChatMessage } from "../../../shared/types"
import type { EntityIndex } from "./linkify"
import { itemMessages, type CoordinatorRow } from "./chatUpdates"

/** The tasks and projects a message names on its own. */
export interface Refs {
  tasks: string[]
  projects: string[]
}

const ID_RE = /\b(?:task|prj)_[A-Za-z0-9-]{6,40}\b/g
const BOLD_RE = /\*\*([^*\n]{2,120})\*\*/g

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)

/** A task or project named by id, or a task by its title, or a project by its name. */
function lookup(index: EntityIndex, ref: string | null, kind: "task" | "project") {
  if (!ref) return undefined
  const byId = index.byId.get(ref)
  if (byId) return byId.kind === kind ? byId : undefined
  return kind === "task" ? index.byTitle.get(ref) : index.byName.get(`project:${ref}`)
}

function textRefs(text: string, index: EntityIndex, into: { tasks: Set<string>; projects: Set<string> }) {
  for (const [id] of text.matchAll(ID_RE)) {
    const ref = index.byId.get(id)
    if (ref?.kind === "task") into.tasks.add(ref.id)
    else if (ref?.kind === "project") into.projects.add(ref.id)
  }
  // The Coordinator writes a task's title in bold; linkify links it when exactly one task has it.
  if (text.includes("**")) for (const [, title] of text.matchAll(BOLD_RE)) {
    const ref = index.byTitle.get(title!.trim())
    if (ref) into.tasks.add(ref.id)
  }
}

const cache = new WeakMap<EntityIndex, WeakMap<ChatMessage, Refs>>()

/** The tasks and projects one message names. Cached per message and index. */
export function messageRefs(m: ChatMessage, index: EntityIndex): Refs {
  let byMessage = cache.get(index)
  if (!byMessage) cache.set(index, (byMessage = new WeakMap()))
  const hit = byMessage.get(m)
  if (hit) return hit
  const tasks = new Set<string>()
  const projects = new Set<string>()
  const meta = m.meta ?? {}
  const task = (ref: string | null) => {
    const t = lookup(index, ref, "task")
    if (t) tasks.add(t.id)
  }
  const project = (ref: string | null) => {
    const p = lookup(index, ref, "project")
    if (p) projects.add(p.id)
  }
  if (m.role === "notice") {
    task(str(meta.taskId))
    project(str(meta.projectId))
    if (meta.captain === true) textRefs(m.content, index, { tasks, projects })
  } else if (m.role === "tool") {
    const input = (meta.input ?? {}) as Record<string, unknown>
    task(str(meta.resultId))
    project(str(meta.resultId))
    task(str(input.task))
    // Ids (wait_for_tasks), or create_tasks' items by their titles.
    if (Array.isArray(input.tasks)) for (const t of input.tasks) task(str(t && typeof t === "object" ? (t as { title?: unknown }).title : t))
    project(str(input.project))
    const captain = meta.captain as { projectId?: unknown } | undefined
    project(str(captain?.projectId))
  } else {
    textRefs(m.content, index, { tasks, projects })
  }
  for (const id of tasks) {
    const p = index.byId.get(id)?.projectId
    if (p) projects.add(p)
  }
  const refs = { tasks: [...tasks], projects: [...projects] }
  byMessage.set(m, refs)
  return refs
}

export interface Provenance {
  /** Each message's projects (a turn's messages share theirs). */
  projects: ReadonlyMap<string, ReadonlySet<string>>
}

const NONE: ReadonlySet<string> = new Set()

/**
 * Every message's projects. `rows`, when given, are coordinatorRows over the same messages: a reply is also about
 * the updates it read.
 */
export function chatProvenance(messages: readonly ChatMessage[], index: EntityIndex, rows?: readonly CoordinatorRow[]): Provenance {
  // An update's messages by its id (a notice, or one task's published files), for the replies that read it.
  const updates = new Map<string, ChatMessage[]>()
  for (const r of rows ?? []) for (const item of r.type === "update" ? [r.item] : r.type === "updates" ? r.items : []) updates.set(item.id, itemMessages(item))
  const read = new Map<string, ChatMessage[]>()
  for (const r of rows ?? []) if (r.type === "message" && r.sources?.length) read.set(r.id, r.sources.flatMap((s) => updates.get(s.id) ?? []))
  const projects = new Map<string, ReadonlySet<string>>()
  let turn: ChatMessage[] = []
  let turnProjects = new Set<string>()
  const close = () => {
    const ps: ReadonlySet<string> = turnProjects.size ? turnProjects : NONE
    for (const m of turn) projects.set(m.id, ps)
    turn = []
    turnProjects = new Set()
  }
  const add = (refs: Refs) => {
    for (const p of refs.projects) turnProjects.add(p)
  }
  for (const m of messages) {
    if (m.role === "notice") {
      const own = messageRefs(m, index)
      projects.set(m.id, own.projects.length ? new Set(own.projects) : NONE)
      continue
    }
    turn.push(m)
    add(messageRefs(m, index))
    for (const n of read.get(m.id) ?? []) add(messageRefs(n, index))
    if (m.role === "assistant" || m.role === "error") close()
  }
  if (turn.length) close()
  return { projects }
}

/** The projects the chat talked about since `since` (ms), newest last. */
export function recentProjects(messages: readonly ChatMessage[], prov: Provenance, since: number): Set<string> {
  const out = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.createdAt < since) break
    for (const p of prov.projects.get(m.id) ?? NONE) out.add(p)
  }
  return out
}
