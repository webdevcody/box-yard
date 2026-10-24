import type { Store } from "./store.js"
import type { TaskEvent, TaskEventListener } from "./tasks.js"
import { preview } from "./replies.js"
import { parseNextSteps } from "../shared/nextSteps.js"
import { BOXYARD_EDITOR } from "../shared/notes.js"
import { withOwner } from "../shared/owner.js"
import type { NoteSuggestion, Task } from "../shared/types.js"

/**
 * The notes retro. When a task's PR merges, or a task without an open PR ends done, its agent's note
 * suggestions go to the project's Captain in a "📝 Notes retro" wake, with the task's summary and PR link
 * (not its transcript). The Captain alone decides: it turns what's lasting into notes, merges or rewrites,
 * and rejects the rest, each with a one-line reason. Nobody approves anything and nothing waits on Cody.
 *
 * Every suggestion is settled in its retro: when the Captain's turn that read the retro ends, whatever it
 * left pending is rejected for it (settle). If that turn failed, the suggestions ride along in the project's
 * next retro instead, and so do pending suggestions whose task was deleted.
 *
 * It's built in (Settings › Notes retro, on by default) and listens on the task event bus. Loop safety:
 * - each suggestion goes out once (retro_at) unless its retro's turn failed, and a task without unsent
 *   suggestions is skipped, so a retro can only follow new agent work;
 * - finished tasks are batched per project (debounced), so a burst of merges is one wake;
 * - the wake is an ordinary Captain notice, so WakeLoopGuard throttles it like any other. Its loopKey names
 *   the tasks, so a task that keeps coming back to the retro counts as the same update.
 */

export interface RetroTuning {
  /** A retro goes out this long after the last task joined the batch... */
  debounceMs: number
  /** ...and never later than this after the first one. */
  maxWaitMs: number
}

export const DEFAULT_RETRO_TUNING: RetroTuning = { debounceMs: 60_000, maxWaitMs: 10 * 60_000 }

/** What made a task ready for its retro. */
export type RetroTrigger = "merged" | "done"

/** The reason a suggestion the Captain left pending in its retro is closed with. */
export const UNRESOLVED_REASON = "Not resolved in its notes retro."

export interface RetroDeps {
  store: Store
  subscribe: (listener: TaskEventListener) => () => void
  /** Settings › Notes retro. */
  enabled: () => boolean
  /** Leave the project's Captain the retro notice and wake it. */
  deliver: (projectId: string, content: string, meta: Record<string, unknown>) => void
  /** The project's notes budget, for the retro's status line. */
  budget: (projectId: string) => { line: string; over: boolean; prune?: string }
  ownerName: () => string
  /** Suggestions were settled outside the Captain's tools (the Notes tab's history refreshes). */
  changed?: (projectId: string) => void
}

export interface RetroItem {
  /** The finished task, or null for earlier suggestions: left by a retro whose turn failed, or from a deleted task. */
  task: Task | null
  trigger: RetroTrigger | null
  suggestions: NoteSuggestion[]
}

const BUSY = new Set(["queued", "starting", "working"])

/** The retro trigger a task event is, if any. */
export function retroTrigger(event: TaskEvent, task: Pick<Task, "status" | "prUrl" | "prState"> | null): RetroTrigger | null {
  if (!task) return null
  if (event.type === "pr.merged") return "merged"
  if (event.type !== "task.finished") return null
  return readyTrigger(task)
}

/** Whether a task, as it stands, has finished for the retro: its PR merged, or it's done without an open PR. */
function readyTrigger(task: Pick<Task, "status" | "prUrl" | "prState">): RetroTrigger | null {
  if (BUSY.has(task.status)) return null
  if (task.prUrl && task.prState === "merged") return "merged"
  if (task.status !== "done") return null
  // A PR that's still open gets its retro when it merges.
  if (task.prUrl && (task.prState === "open" || task.prState === "draft")) return null
  return "done"
}

/** The retro notice the Captain gets. Its first line is what the Captain tab shows. */
export function retroNotice(items: RetroItem[], opts: { budget: { line: string; over: boolean; prune?: string }; ownerName?: string }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const finished = items.filter((i) => i.task)
  const fresh = finished.reduce((n, i) => n + i.suggestions.length, 0)
  const earlier = items.filter((i) => !i.task).reduce((n, i) => n + i.suggestions.length, 0)
  const head = finished.length
    ? `📝 **Notes retro**: ${plural(finished.length, "finished task")} left ${plural(fresh, "note suggestion")} to curate${earlier ? `, plus ${earlier} earlier one${earlier === 1 ? "" : "s"}` : ""}.`
    : `📝 **Notes retro**: ${plural(earlier, "earlier note suggestion")} to curate.`
  const lines = [head, `Notes now: ${opts.budget.line}.${opts.budget.prune ? ` ${opts.budget.prune}` : ""}`]
  for (const { task, trigger, suggestions } of items) {
    if (task) {
      const outcome = trigger === "merged" ? `PR merged: ${task.prUrl}` : task.prUrl ? `done, PR ${task.prState ?? "closed"}: ${task.prUrl}` : "done, no PR"
      const summary = task.summary ? preview(parseNextSteps(task.summary).content.replace(/\s+/g, " ").trim(), 600, "call get_task for the full reply") : ""
      lines.push("", `**[${task.title}](/tasks/${task.id})** (${task.id}) · ${outcome}`)
      if (summary) lines.push(`Summary: ${summary}`)
    } else {
      lines.push("", "**Earlier suggestions** (an earlier retro didn't finish, or their task was deleted)")
    }
    for (const s of suggestions) lines.push(`- \`${s.id}\`: ${s.content}`, `  Why: ${s.why || "(the agent gave no reason)"}${task ? "" : ` (from "${s.taskTitle}")`}`)
  }
  lines.push(
    "",
    withOwner(
      "Resolve every one now (see Notes retro in your instructions): list_notes first, then resolve_suggestion for each one (accept, merge into a note, or reject), with a one-line reason. It's your call: don't ask Cody to review them. Any still pending when this turn ends are rejected automatically. Then reply with exactly (no update).",
      opts.ownerName,
    ),
  )
  return lines.join("\n")
}

/** The suggestion ids a retro notice's meta holds (none for any other notice). */
export function retroSuggestionIds(meta: Record<string, unknown> | null | undefined): string[] {
  if (meta?.kind !== "retro" || !Array.isArray(meta.suggestionIds)) return []
  return meta.suggestionIds.filter((id): id is string => typeof id === "string")
}

interface Batch {
  tasks: Map<string, RetroTrigger>
  timer: NodeJS.Timeout | null
  firstAt: number
}

export class NotesRetro {
  /** Tests shorten these before events arrive. */
  readonly tuning: RetroTuning = { ...DEFAULT_RETRO_TUNING }
  private readonly batches = new Map<string, Batch>()
  /** Suggestions in a retro the Captain hasn't finished yet, so the next retro doesn't send them again. */
  private readonly inFlight = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: RetroDeps) {}

  start() {
    this.unsubscribe ??= this.deps.subscribe((event) => this.onEvent(event))
    this.catchUp()
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const b of this.batches.values()) if (b.timer) clearTimeout(b.timer)
    this.batches.clear()
  }

  /** Tasks waiting in each project's next retro (tests, and the debug view). */
  queued(projectId: string): string[] {
    return [...(this.batches.get(projectId)?.tasks.keys() ?? [])]
  }

  /**
   * Queue what no retro picked up: tasks that finished while the retro was off or Box Yard was down, and earlier
   * suggestions (a failed retro turn's, or a deleted task's). Runs on start and when Settings change.
   */
  catchUp() {
    if (!this.deps.enabled()) return
    const pending = this.deps.store.listNoteSuggestions({ status: ["pending"], limit: 2000 })
    // A retro still queued for its Captain (Box Yard restarted before it woke) is in flight: don't send it twice.
    for (const projectId of new Set(pending.map((s) => s.projectId))) {
      for (const n of this.deps.store.peekUnseenCaptainNoticeEntries(projectId)) for (const id of retroSuggestionIds(n.meta)) this.inFlight.add(id)
    }
    const projects = new Set<string>()
    for (const s of pending) {
      if (this.inFlight.has(s.id)) continue
      const task = s.taskId ? this.deps.store.getTask(s.taskId) : null
      if (task && s.retroAt === null) {
        const trigger = readyTrigger(task)
        if (trigger) this.enqueue(s.projectId, task.id, trigger)
      } else if (!task || s.retroAt !== null) projects.add(s.projectId)
    }
    for (const projectId of projects) if (!this.batches.has(projectId)) this.enqueue(projectId)
  }

  /**
   * The Captain's turn that read retros with these suggestions ended. They must all be settled by then:
   * whatever is still pending is rejected, so no suggestion sits pending. A failed turn keeps them for the
   * project's next retro. Returns how many were closed.
   */
  settle(projectId: string, suggestionIds: string[], ok: boolean): number {
    for (const id of suggestionIds) this.inFlight.delete(id)
    if (!ok) return 0
    let closed = 0
    for (const id of suggestionIds) {
      const s = this.deps.store.getNoteSuggestion(id)
      if (s?.status !== "pending") continue
      this.deps.store.resolveNoteSuggestion(id, { status: "rejected", by: BOXYARD_EDITOR, reason: UNRESOLVED_REASON })
      closed++
    }
    if (closed) this.deps.changed?.(projectId)
    return closed
  }

  private onEvent(event: TaskEvent) {
    if (event.type !== "pr.merged" && event.type !== "task.finished") return
    if (!this.deps.enabled()) return
    const task = this.deps.store.getTask(event.taskId)
    const trigger = retroTrigger(event, task)
    if (!task || !trigger) return
    // Nothing to curate: skip it. What the task did is already in its summary and PR description.
    if (!this.unsent(task.id).length) return
    this.enqueue(task.projectId, task.id, trigger)
  }

  /** Add a task to its project's next retro, or (no task) make sure the project has one for earlier suggestions. */
  private enqueue(projectId: string, taskId?: string, trigger?: RetroTrigger) {
    const now = Date.now()
    let batch = this.batches.get(projectId)
    if (!batch) {
      batch = { tasks: new Map(), timer: null, firstAt: now }
      this.batches.set(projectId, batch)
    }
    // A task can arrive twice (it merged its PR and then marked itself done); the merge names it.
    if (taskId && trigger && batch.tasks.get(taskId) !== "merged") batch.tasks.set(taskId, trigger)
    if (batch.timer) clearTimeout(batch.timer)
    const wait = Math.max(0, Math.min(this.tuning.debounceMs, batch.firstAt + this.tuning.maxWaitMs - now))
    batch.timer = setTimeout(() => this.flush(projectId), wait)
    batch.timer.unref?.()
  }

  /**
   * Send a project's batch now. A task that is working again waits for the next batch; a task whose
   * suggestions were all handled meanwhile drops out. Earlier suggestions ride along. Returns the notice, or null.
   */
  flush(projectId: string): string | null {
    const batch = this.batches.get(projectId)
    if (!batch) return null
    if (batch.timer) clearTimeout(batch.timer)
    this.batches.delete(projectId)
    if (!this.deps.enabled()) return null
    const items: RetroItem[] = []
    const later: [string, RetroTrigger][] = []
    for (const [taskId, trigger] of batch.tasks) {
      const task = this.deps.store.getTask(taskId)
      if (!task) continue
      if (BUSY.has(task.status)) {
        later.push([taskId, trigger])
        continue
      }
      const suggestions = this.unsent(taskId)
      if (suggestions.length) items.push({ task, trigger, suggestions })
    }
    for (const [taskId, trigger] of later) this.enqueue(projectId, taskId, trigger)
    const sent = new Set(items.flatMap((i) => i.suggestions.map((s) => s.id)))
    const earlier = this.deps.store
      .listNoteSuggestions({ projectId, status: ["pending"] })
      .filter((s) => !sent.has(s.id) && !this.inFlight.has(s.id) && (s.retroAt !== null || !s.taskId || !this.deps.store.getTask(s.taskId)))
    if (earlier.length) items.push({ task: null, trigger: null, suggestions: earlier })
    if (!items.length) return null
    const ids = items.flatMap((i) => i.suggestions.map((s) => s.id))
    const content = retroNotice(items, { budget: this.deps.budget(projectId), ownerName: this.deps.ownerName() })
    this.deps.store.markSuggestionsInRetro(ids)
    for (const id of ids) this.inFlight.add(id)
    const taskIds = items.flatMap((i) => (i.task ? [i.task.id] : []))
    // Keyed by its tasks (and any earlier suggestions), so the same retro coming back counts as a repeat.
    const key = [...taskIds, ...earlier.map((s) => s.id)].sort().join(",")
    this.deps.deliver(projectId, content, { kind: "retro", taskIds, suggestionIds: ids, loopKey: `retro:${key}` })
    return content
  }

  /** Send every batch now (tests). */
  flushAll() {
    for (const projectId of [...this.batches.keys()]) this.flush(projectId)
  }

  private unsent(taskId: string) {
    return this.deps.store.listNoteSuggestions({ taskId, status: ["pending"], unsent: true })
  }
}
