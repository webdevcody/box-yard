// State up front (speed step 2): the tasks and projects a message names, as they stand now, handed to the Coordinator
// or a Captain with the message. A model step costs ~2.7 s before it writes anything, so a turn that would open with
// list_tasks or get_task answers one step sooner. Built once per turn, from the store, with the named PRs asked of
// GitHub first (like get_task does), so the PR states in it are as fresh as the tools'.
import type { Project, Task } from "../shared/types.js"
import { isFinalPrState } from "../shared/types.js"
import { prNumber, PR_REPORT_FRESH_MS } from "./prs.js"
import type { Store } from "./store.js"

/** Tasks shown in full (with their last reply) per message. */
export const NAMED_TASKS_MAX = 5
/** Characters of each named task's last reply. get_task has the rest. */
export const NAMED_REPLY_CHARS = 600
/** Projects whose open tasks are listed, per Coordinator message. */
export const NAMED_PROJECTS_MAX = 2
export const NAMED_PROJECT_TASKS_MAX = 10
/** A turn waits at most this long for GitHub before it starts with the last known PR states. */
export const NAMED_PR_TIMEOUT_MS = 2_000
/** Titles and project names shorter than this show up in messages by chance too often. */
const TITLE_MIN = 12
const PROJECT_NAME_MIN = 4
/** A bare "#N" naming more tasks than this (one per repo) is ambiguous: none of them is shown. */
const BARE_PR_MAX_HITS = 2

/** In front of a Captain's messages. */
export const NAMED_TASKS_HEADING =
  "[Tasks this message names, as they stand now: status, PR and the start of the last reply. Answer from this when it's enough; get_task has the full reply and transcript]"
/** In front of Cody's messages to the Coordinator. */
export const COORDINATOR_NAMED_HEADING =
  "[What this message names, as it stands now: each task's status, PR and the start of its last reply. Answer quick questions from this; get_task has the full reply]"

/** In front of a task thread's first prompt (a question from a task's card in the Coordinator chat), and again when the task changed. */
export const TASK_THREAD_HEADING = "[The task as it stands now: status, PR and the start of its last reply. get_task has the full reply and transcript]"
export const BATCH_THREAD_HEADING = "[These tasks as they stand now: each one's status, PR and the start of its last reply. get_task has the full reply and transcript]"

/** PrTracker's part (server/prs.ts). */
export interface PrLookup {
  ensureFresh(taskIds: string[] | null, opts?: { timeoutMs?: number }): Promise<void>
  prCheck(taskId: string): { checkedAt: number | null; error: string | null }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The PR's owner/repo and number from its URL, lower-cased. */
function prKey(url: string | null): string | null {
  const m = url?.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i)
  return m ? `${m[1]!.toLowerCase()}#${m[2]}` : null
}

/** The tasks `text` names, in the order it names them: by id, PR URL, "PR #N" / "#N", or full title. */
export function namedTasks(text: string, tasks: Task[], max = NAMED_TASKS_MAX): Task[] {
  if (!text.trim() || !tasks.length) return []
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const first = new Map<string, number>()
  const hit = (t: Task, at: number) => {
    if (!first.has(t.id) || first.get(t.id)! > at) first.set(t.id, at)
  }
  for (const m of text.matchAll(/\btask_[A-Za-z0-9-]{6,40}/g)) {
    const t = byId.get(m[0])
    if (t) hit(t, m.index)
  }
  const withPr = tasks.filter((t) => t.prUrl)
  const urlSpans: [number, number][] = []
  for (const m of text.matchAll(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/gi)) {
    urlSpans.push([m.index, m.index + m[0].length])
    const key = prKey(m[0])
    for (const t of withPr) if (prKey(t.prUrl) === key) hit(t, m.index)
  }
  for (const m of text.matchAll(/\b(PR|pull request)\s*#?(\d+)\b|(?<![\w/&#])#(\d+)\b/gi)) {
    if (urlSpans.some(([a, b]) => m.index >= a && m.index < b)) continue
    const n = Number(m[2] ?? m[3])
    const hits = withPr.filter((t) => prNumber(t.prUrl!) === n)
    // "PR #12" is meant as a PR; a bare "#12" may be an issue, so it counts only when it's unambiguous.
    if (m[1] || hits.length <= BARE_PR_MAX_HITS) for (const t of hits) hit(t, m.index)
  }
  const lower = text.toLowerCase()
  for (const t of tasks) {
    if (t.title.length < TITLE_MIN) continue
    const at = lower.indexOf(t.title.toLowerCase())
    if (at >= 0) hit(t, at)
  }
  return [...first]
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([id]) => byId.get(id)!)
}

/** The projects `text` names by id or by name (as a whole word), in the order it names them. */
export function namedProjects(text: string, projects: Project[], max = NAMED_PROJECTS_MAX): Project[] {
  if (!text.trim()) return []
  const first = new Map<Project, number>()
  for (const p of projects) {
    const byId = text.indexOf(p.id)
    const name = p.name.trim()
    const byName = name.length >= PROJECT_NAME_MIN ? text.search(new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "i")) : -1
    const at = [byId, byName].filter((i) => i >= 0)
    if (at.length) first.set(p, Math.min(...at))
  }
  return [...first]
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([p]) => p)
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const clip = (s: string, max: number, rest: string) => (s.length > max ? `${s.slice(0, max).trimEnd()}… [${s.length - max} more chars: ${rest}]` : s)

export interface StateOptions {
  store: Store
  prs?: PrLookup | null
  /** This task's project shows the caller its status only: no reply, question or error (Coordinator only). */
  sealed?: (t: Task) => boolean
  /** Name each task's project (the Coordinator's view spans projects). */
  projectNames?: Map<string, string>
  now?: number
}

/** A task's PR and how sure Box Yard is of its state, e.g. "PR #184 open (GitHub checked 40s ago) https://…". */
function prLine(t: Task, o: StateOptions, now: number): string {
  if (!t.prUrl) return ""
  const n = prNumber(t.prUrl)
  const state = t.prState ?? "state unknown"
  let sure = ""
  if (!isFinalPrState(t.prState)) {
    const checkedAt = o.prs?.prCheck(t.id).checkedAt ?? null
    sure =
      checkedAt !== null && now - checkedAt < PR_REPORT_FRESH_MS
        ? ` (GitHub checked ${ago(checkedAt, now)})`
        : ` (unconfirmed: ${checkedAt === null ? "GitHub hasn't answered yet" : `GitHub last checked ${ago(checkedAt, now)}`})`
  }
  return ` · PR${n ? ` #${n}` : ""} ${state}${sure} ${t.prUrl}`
}

/** The agent's latest reply: its mark_done summary when that says more, else its last assistant message (like get_task). */
function lastReply(store: Store, t: Task): string | null {
  const last = store.listTaskMessages(t.id, 50).filter((m) => m.role === "assistant").pop()
  const reply = t.summary && (!last || t.summary.length > last.content.length) ? t.summary : (last?.content ?? null)
  return reply?.trim() ? reply : null
}

/** One task, in full: status, PR, what it asks or why it failed, and the start of its last reply. */
function taskBlock(t: Task, o: StateOptions, now: number): string {
  const project = o.projectNames ? ` [${o.projectNames.get(t.projectId) ?? "?"}]` : ""
  const queued = t.pendingCount ? ` (+${t.pendingCount} queued messages)` : ""
  const lines = [`- ${t.id} "${t.title}"${project} ${t.status}${queued}${prLine(t, o, now)} · updated ${ago(t.updatedAt, now)}`]
  if (o.sealed?.(t)) {
    lines.push(`  (status only: ask its Captain for what it said)`)
    return lines.join("\n")
  }
  if (t.question) lines.push(`  Asks: ${clip(oneLine(t.question), NAMED_REPLY_CHARS, "get_task")}`)
  if (t.error) lines.push(`  Error: ${clip(oneLine(t.error), 300, "get_task")}`)
  const reply = lastReply(o.store, t)
  if (reply) lines.push(`  Last reply: ${clip(oneLine(reply), NAMED_REPLY_CHARS, "get_task has it in full")}`)
  return lines.join("\n")
}

/** A project's open tasks, one line each, most recently active first. */
function projectBlock(p: Project, open: Task[], o: StateOptions, now: number): string {
  const shown = open.slice(0, NAMED_PROJECT_TASKS_MAX)
  const more = open.length - shown.length
  return [
    `- ${p.name} (${p.id}): ${open.length ? `${open.length} open task${open.length === 1 ? "" : "s"}` : "no open tasks"}`,
    ...shown.map((t) => `  - ${t.id} "${t.title}" ${t.status}${prLine(t, o, now)} · updated ${ago(t.updatedAt, now)}`),
    more > 0 ? `  - …and ${more} more: list_tasks` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

const OPEN = (t: Task) => t.status !== "done"

/** Ask GitHub for these tasks' open PRs, for at most NAMED_PR_TIMEOUT_MS. Either way, an unanswered PR shows as unconfirmed. */
async function freshenPrs(tasks: Task[], o: StateOptions) {
  const prIds = tasks.filter((t) => t.prUrl && !isFinalPrState(t.prState)).map((t) => t.id)
  if (!prIds.length || !o.prs) return
  // PrTracker stops waiting by itself; the race is a backstop.
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    o.prs.ensureFresh(prIds, { timeoutMs: NAMED_PR_TIMEOUT_MS }).catch(() => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, NAMED_PR_TIMEOUT_MS + 250))),
  ])
  clearTimeout(timer)
}

/** These tasks as they stand now, in full, under `heading`: a side thread from a task's card starts from it (server/sideThreads.ts). */
export async function tasksState(tasks: Task[], o: StateOptions, heading: string): Promise<string> {
  await freshenPrs(tasks, o)
  const now = o.now ?? Date.now()
  return [heading, ...tasks.map((t) => taskBlock(o.store.getTask(t.id) ?? t, o, now))].join("\n")
}

/**
 * The block that goes in front of a message: the tasks it names (and, for the Coordinator, the projects), as they
 * stand now. Null when it names none. The named PRs are asked of GitHub first, for at most NAMED_PR_TIMEOUT_MS.
 */
export async function namedState(
  text: string,
  scope: { tasks: Task[]; projects?: Project[] },
  o: StateOptions,
  heading: string,
): Promise<string | null> {
  const named = namedTasks(text, scope.tasks)
  const projects = scope.projects ? namedProjects(text, scope.projects) : []
  if (!named.length && !projects.length) return null
  const open = new Map(projects.map((p) => [p.id, o.store.listTasks({ projectId: p.id }).filter(OPEN).sort((a, b) => b.updatedAt - a.updatedAt)]))
  await freshenPrs([...named, ...[...open.values()].flatMap((l) => l.slice(0, NAMED_PROJECT_TASKS_MAX))], o)
  // Read again: the GitHub check may have changed a PR's state.
  const fresh = (t: Task) => o.store.getTask(t.id) ?? t
  const now = o.now ?? Date.now()
  const parts = [heading]
  if (named.length) parts.push(...named.map((t) => taskBlock(fresh(t), o, now)))
  if (projects.length) {
    parts.push(named.length ? "Projects it names (open tasks):" : "")
    parts.push(...projects.map((p) => projectBlock(p, open.get(p.id)!.map(fresh), o, now)))
  }
  return parts.filter(Boolean).join("\n")
}
