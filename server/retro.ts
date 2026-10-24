import type { Store } from "./store.js"
import type { TaskEvent, TaskEventListener } from "./tasks.js"
import { preview } from "./replies.js"
import { parseNextSteps } from "../shared/nextSteps.js"
import { withOwner } from "../shared/owner.js"
import type { NoteSuggestion, Task } from "../shared/types.js"

/**
 * The notes retro. When a task's PR merges, or a task without an open PR ends done, its agent's note
 * suggestions go to the project's Captain in a "📝 Notes retro" wake, with the task's summary and PR link
 * (not its transcript). The Captain turns what's lasting into notes, merges or rewrites, and rejects the rest.
 *
 * It's built in (Settings › Notes retro, on by default) and listens on the task event bus. Loop safety:
 * - each suggestion goes out in one retro at most (retro_at), and a task without unsent suggestions is skipped,
 *   so a retro can only follow new agent work;
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
}

export interface RetroItem {
  task: Task
  trigger: RetroTrigger
  suggestions: NoteSuggestion[]
}

const BUSY = new Set(["queued", "starting", "working"])

/** The retro trigger a task event is, if any. */
export function retroTrigger(event: TaskEvent, task: Pick<Task, "status" | "prUrl" | "prState"> | null): RetroTrigger | null {
  if (!task) return null
  if (event.type === "pr.merged") return "merged"
  if (event.type !== "task.finished" || task.status !== "done") return null
  // A PR that's still open gets its retro when it merges.
  if (task.prUrl && (task.prState === "open" || task.prState === "draft")) return null
  return task.prUrl && task.prState === "merged" ? "merged" : "done"
}

/** The retro notice the Captain gets. Its first line is what the Captain tab shows. */
export function retroNotice(items: RetroItem[], opts: { budget: { line: string; over: boolean; prune?: string }; olderPending: number; ownerName?: string }): string {
  const count = items.reduce((n, i) => n + i.suggestions.length, 0)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const head = `📝 **Notes retro**: ${plural(items.length, "finished task")} left ${plural(count, "note suggestion")} to curate.`
  const lines = [head, `Notes now: ${opts.budget.line}.${opts.budget.prune ? ` ${opts.budget.prune}` : ""}`]
  if (opts.olderPending) lines.push(`${plural(opts.olderPending, "older suggestion")} from earlier retros ${opts.olderPending === 1 ? "is" : "are"} still pending (list_note_suggestions).`)
  for (const { task, trigger, suggestions } of items) {
    const outcome = trigger === "merged" ? `PR merged: ${task.prUrl}` : task.prUrl ? `done, PR ${task.prState ?? "closed"}: ${task.prUrl}` : "done, no PR"
    const summary = task.summary ? preview(parseNextSteps(task.summary).content.replace(/\s+/g, " ").trim(), 600, "call get_task for the full reply") : ""
    lines.push("", `**[${task.title}](/tasks/${task.id})** (${task.id}) · ${outcome}`)
    if (summary) lines.push(`Summary: ${summary}`)
    for (const s of suggestions) lines.push(`- \`${s.id}\`: ${s.content}`, `  Why: ${s.why || "(the agent gave no reason)"}`)
  }
  lines.push(
    "",
    withOwner(
      "Curate them now (see Notes retro in your instructions): list_notes first, then resolve_suggestion for each one (accept, merge into a note, or reject). When that's all, reply with exactly (no update) unless Cody needs to hear about it.",
      opts.ownerName,
    ),
  )
  return lines.join("\n")
}

export class NotesRetro {
  /** Tests shorten these before events arrive. */
  readonly tuning: RetroTuning = { ...DEFAULT_RETRO_TUNING }
  private readonly batches = new Map<string, { tasks: Map<string, RetroTrigger>; timer: NodeJS.Timeout | null; firstAt: number }>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: RetroDeps) {}

  start() {
    this.unsubscribe ??= this.deps.subscribe((event) => this.onEvent(event))
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

  private enqueue(projectId: string, taskId: string, trigger: RetroTrigger) {
    const now = Date.now()
    let batch = this.batches.get(projectId)
    if (!batch) {
      batch = { tasks: new Map(), timer: null, firstAt: now }
      this.batches.set(projectId, batch)
    }
    // A task can arrive twice (it merged its PR and then marked itself done); the merge names it.
    if (batch.tasks.get(taskId) !== "merged") batch.tasks.set(taskId, trigger)
    if (batch.timer) clearTimeout(batch.timer)
    const wait = Math.max(0, Math.min(this.tuning.debounceMs, batch.firstAt + this.tuning.maxWaitMs - now))
    batch.timer = setTimeout(() => this.flush(projectId), wait)
    batch.timer.unref?.()
  }

  /**
   * Send a project's batch now. A task that is working again waits for the next batch; a task whose
   * suggestions were all handled meanwhile (on the Notes tab, say) drops out. Returns the notice, or null.
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
    if (!items.length) return null
    const ids = items.flatMap((i) => i.suggestions.map((s) => s.id))
    const sent = new Set(ids)
    const olderPending = this.deps.store.listNoteSuggestions({ projectId, status: ["pending"] }).filter((s) => !sent.has(s.id)).length
    const content = retroNotice(items, { budget: this.deps.budget(projectId), olderPending, ownerName: this.deps.ownerName() })
    this.deps.store.markSuggestionsInRetro(ids)
    const taskIds = items.map((i) => i.task.id)
    this.deps.deliver(projectId, content, { kind: "retro", taskIds, suggestionIds: ids, loopKey: `retro:${[...taskIds].sort().join(",")}` })
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
