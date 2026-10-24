import type { Store } from "./store.js"
import type { CompactionTaskSnapshot, Task, TaskMessage } from "../shared/types.js"
import { preview } from "./replies.js"

const TASK_ID = /\btask_[A-Za-z0-9-]{6,40}\b/g
const ACTIVE = new Set(["queued", "starting", "working", "needs_input", "waiting", "idle", "pr_ready", "failed"])

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

/** Snapshots of the tasks active, updated or mentioned since the previous compaction, newest first. */
export function compactionTaskSnapshots(store: Store, tasks: Task[], since: number, mentioned: Set<string>): CompactionTaskSnapshot[] {
  return tasks
    .filter((t) => t.updatedAt > since || mentioned.has(t.id) || ACTIVE.has(t.status))
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
