import type { Store } from "./store.js"
import type { CompactionTaskSnapshot, Task, TaskMessage } from "../shared/types.js"
import { preview } from "./replies.js"

const TASK_ID = /\btask_[A-Za-z0-9-]{6,40}\b/g
/** Tasks that are running or waiting on someone: always part of the live state a summary is written from. */
const BUSY = new Set(["queued", "starting", "working", "needs_input", "waiting"])
/** At most this many live task lines go into a summary prompt or a recap. */
const LIVE_MAX = 60

/** Task ids named anywhere in these values (strings, arrays and objects, e.g. message content and meta). */
export function mentionedTaskIds(values: unknown[]): Set<string> {
  const ids = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(TASK_ID)) ids.add(m[0])
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v)
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v)
    }
  }
  for (const v of values) visit(v)
  return ids
}

function latestTaskContext(messages: TaskMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === "assistant" || x.role === "event" || x.role === "agent")
  return m ? preview(m.content, 700, "open the task transcript for more") : ""
}

function taskSnapshotSummary(store: Store, task: Task, since: number): string {
  const messages = store.listTaskMessages(task.id, 80)
  const recent = messages
    .filter((m) => m.createdAt > since && (m.role === "assistant" || m.role === "event" || m.role === "agent"))
    .slice(-4)
    .map((m) => `[${m.role}] ${m.content.replace(/\s+/g, " ").trim()}`)
    .filter(Boolean)
  const latest = recent.length ? recent.join("\n") : latestTaskContext(messages)
  const parts = [
    task.summary ? `Outcome: ${task.summary}` : "",
    latest ? `Recent context: ${latest}` : "",
    task.question ? `Question: ${task.question}` : "",
    task.error ? `Error: ${task.error}` : "",
  ].filter(Boolean)
  return preview(parts.join("\n"), 1200, "open the task transcript for more")
}

/**
 * Snapshots of the tasks updated or mentioned since the previous compaction, newest first. A task that
 * hasn't changed since is in an earlier compaction already, so it isn't copied into every one.
 */
export function compactionTaskSnapshots(store: Store, tasks: Task[], since: number, mentioned: Set<string>): CompactionTaskSnapshot[] {
  return tasks
    .filter((t) => t.updatedAt > since || mentioned.has(t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
      projectId: t.projectId,
      projectName: store.getProject(t.projectId)?.name ?? t.projectId,
      branch: t.branch,
      prUrl: t.prUrl,
      sessionId: t.sessionId,
      summary: taskSnapshotSummary(store, t, since),
      lastActiveAt: t.updatedAt,
    }))
}

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** One task as it is now: id, title, project, status, PR and any open question. */
export function liveTaskLine(store: Store, t: Task, withProject = true): string {
  const project = withProject ? ` [${store.getProject(t.projectId)?.name ?? t.projectId}]` : ""
  const pr = t.prUrl ? ` · PR ${t.prUrl}${t.prState ? ` (${t.prState})` : ""}` : ""
  const asks = t.status === "needs_input" && t.question ? ` · asks: ${clip(t.question, 160)}` : ""
  return `- ${t.id} "${clip(t.title, 80)}"${project} ${t.status}${pr}${asks}`
}

/**
 * Live lines for the named tasks (in that order) and, with `busy`, every task that is running or waiting
 * on someone. Ids that aren't tasks (or are another project's, with `projectId`) are left out.
 */
export function liveTaskLines(store: Store, ids: Iterable<string>, opts: { projectId?: string; busy?: boolean } = {}): string[] {
  const seen = new Set<string>()
  const tasks: Task[] = []
  const add = (t: Task | null) => {
    if (!t || seen.has(t.id) || (opts.projectId && t.projectId !== opts.projectId)) return
    seen.add(t.id)
    tasks.push(t)
  }
  if (opts.busy) for (const t of store.listTasks(opts.projectId ? { projectId: opts.projectId } : {})) if (BUSY.has(t.status)) add(t)
  for (const id of ids) add(store.getTask(id))
  const lines = tasks.slice(0, LIVE_MAX).map((t) => liveTaskLine(store, t, !opts.projectId))
  return tasks.length > LIVE_MAX ? [...lines, `- …and ${tasks.length - LIVE_MAX} more (list_tasks)`] : lines
}
