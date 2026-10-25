// Project snapshots in the UI (shared/snapshots.ts): the toasts, and the lines the Settings panel and the dialog show.
import { initiatorLabel } from "../../../shared/boxSizes"
import { formatBytes } from "../../../shared/disk"
import { snapshotJobLine, type ProjectSnapshot, type SnapshotJob } from "../../../shared/snapshots"
import { isLocalRunnerBox } from "../../../shared/runner"
import type { BoxInfo } from "../../../shared/types"
import { toast } from "./toast"

/** What GET /api/projects/:id/snapshot answers. */
export interface ProjectSnapshotState {
  snapshot: ProjectSnapshot | null
  job: SnapshotJob | null
}

/** The toast for a snapshot job at any stage. */
export function snapshotToast(job: SnapshotJob, projectName?: string): { kind: "progress" | "info" | "error"; title: string; body: string } {
  const name = projectName ?? job.projectId
  const who = job.by.kind === "cody" ? "" : `${initiatorLabel(job.by, job.by.kind === "captain" ? projectName : undefined)}${job.reason ? `: ${job.reason}` : ""}. `
  if (job.status === "running") return { kind: "progress", title: `Taking ${name}'s snapshot from ${job.boxId}`, body: `${who}${snapshotJobLine(job)}` }
  if (job.status === "failed") return { kind: "error", title: `${name}'s snapshot failed`, body: `${who}${job.error ?? "Unknown error"}. ${job.boxId} wasn't changed.` }
  return { kind: "info", title: `Saved ${name}'s snapshot`, body: `${who}New ${name} boxes start from ${job.snapshotId ?? "it"}. ${job.boxId} wasn't changed.` }
}

/** Show or update a snapshot job's toast (SSE project.snapshot). */
export function announceSnapshot(job: SnapshotJob, projectName?: string) {
  const t = snapshotToast(job, projectName)
  const key = `snapshot:${job.id}`
  if (t.kind === "progress") toast.progress(key, t.title, t.body)
  else toast.settle(key, t.kind, t.title, t.body)
}

/** "small · 1.2 GB" */
export const snapshotMeta = (s: ProjectSnapshot) => [s.size, ...(s.bytes ? [formatBytes(s.bytes)] : []), ...(s.provider !== "upstash" ? [s.provider] : [])].join(" · ")

/** Boxes a project's snapshot can be taken from: ready, not busy, holding the project, and not the local runner. */
export const snapshotSources = (boxes: BoxInfo[] | undefined, projectId: string) =>
  (boxes ?? []).filter((b) => b.status === "ready" && !isLocalRunnerBox(b.id) && (b.projectIds ?? []).includes(projectId))

/** Why a box can't be snapshotted right now, or null. */
export function snapshotBlocker(box: BoxInfo): string | null {
  if (box.operation) return `${box.id} is busy (${box.operation})`
  if (box.runningTurns > 0) return `${box.runningTurns === 1 ? "An agent is" : `${box.runningTurns} agents are`} running on ${box.id}. Snapshot it once they're idle.`
  return null
}
