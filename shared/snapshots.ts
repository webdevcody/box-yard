// Per-project box snapshots: a known-good box, stripped of workspaces and secrets, that new boxes for the project
// start from (Box.fromSnapshot) instead of starting cold. server/tasks.ts takes and restores them; the project's
// Settings tab, the Boxes page and the snapshot_box MCP tool start them.

import { BOX_SIZE_ORDER } from "./boxSizes.js"

type Size = (typeof BOX_SIZE_ORDER)[number]

/** The snapshot new boxes for a project start from. */
export interface ProjectSnapshot {
  /** The provider's snapshot id. */
  id: string
  /** The provider that holds it ("upstash"; "local" for dev and test boxes). New boxes only use one of their own provider's. */
  provider: string
  /** The size of the box it was taken from. New boxes of that size or bigger start from it. */
  size: Size
  /** The box it was taken from. */
  boxId: string
  /** Its size at the provider, when the provider says. */
  bytes: number | null
  takenAt: number
}

/** Who asked for a snapshot. */
export type SnapshotInitiator = { kind: "cody" } | { kind: "coordinator" } | { kind: "captain"; projectId: string }

export interface SnapshotStep {
  key: "snapshot" | "restore" | "strip" | "save" | "cleanup"
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  detail: string | null
}

/** Taking a project's snapshot, running or finished. Kept per project and sent as SSE `project.snapshot`. */
export interface SnapshotJob {
  id: string
  projectId: string
  /** The box it's taken from. That box is never changed: a scratch copy of it is stripped instead. */
  boxId: string
  size: Size
  status: "running" | "done" | "failed"
  steps: SnapshotStep[]
  by: SnapshotInitiator
  reason: string | null
  /** The scratch box the copy was stripped on (deleted when the job ends). */
  scratchBoxId: string | null
  /** The new snapshot, once saved. */
  snapshotId: string | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export const SNAPSHOT_STEP_LABELS: Record<SnapshotStep["key"], string> = {
  snapshot: "Snapshot the box as it is",
  restore: "Restore it on a scratch box",
  strip: "Strip workspaces, credentials, temp files and logs",
  save: "Save the stripped box as the project's snapshot",
  cleanup: "Delete the scratch box and the first snapshot",
}

/**
 * Why a new box of `size` from `provider` won't start from the snapshot, or null when it will. A snapshot restores
 * onto a box of its own size or bigger (Box.fromSnapshot takes the size); a smaller box might not fit its disk.
 */
export function snapshotSkipReason(snap: Pick<ProjectSnapshot, "id" | "provider" | "size">, size: Size, provider: string): string | null {
  if (snap.provider !== provider) return `snapshot ${snap.id} is from ${snap.provider} and new boxes come from ${provider}`
  if (BOX_SIZE_ORDER.indexOf(size) < BOX_SIZE_ORDER.indexOf(snap.size)) {
    return `snapshot ${snap.id} was taken on a ${snap.size} box and might not fit a ${size} one (replace it from a ${size} box to use it there)`
  }
  return null
}

/** "Saved", "Step 2 of 5: Restore it on a scratch box", "Failed: …" */
export function snapshotJobLine(job: SnapshotJob): string {
  if (job.status === "done") return "Saved"
  if (job.status === "failed") return `Failed: ${job.error ?? "unknown error"}`
  const steps = job.steps.filter((s) => s.status !== "skipped")
  const i = steps.findIndex((s) => s.status === "running" || s.status === "pending")
  const step = steps[Math.max(0, i)]
  return step ? `Step ${Math.max(0, i) + 1} of ${steps.length}: ${step.label}` : "Running"
}
