// Upstash Box sizes, what each one gets, and the resize report the Boxes page and MCP share.
// One table so the Resize modal, Settings, cost estimates and the server's scale-down check agree.
import { formatBytes } from "./disk.js"

export const BOX_SIZE_ORDER = ["small", "medium", "large"] as const
type Size = (typeof BOX_SIZE_ORDER)[number]

export interface BoxSizeSpec {
  label: string
  cpu: number
  ramGb: number
  /** The plan's storage per box (Upstash docs). */
  storageGb: number
  /**
   * The work disk (/workspace) Box Yard's folders live on. Upstash splits the plan's storage: on a small box
   * /workspace is a 5G quota and the root overlay (HOME, /tmp) is another 5G. Medium and large are assumed to
   * split the same way until a box of that size has reported its own df (see `workDiskBytes`).
   */
  workDiskGb: number
  activeCpuHourlyUsd: number
  keepAliveMonthlyUsd: number
}

/**
 * From https://upstash.com/docs/box/overall/how-it-works#box-size and https://upstash.com/pricing/box
 * (checked 2026-10-24). The pricing table lists medium storage as 30 GB, but its FAQ and the docs say 20 GB;
 * the lower figure is used.
 */
export const BOX_SIZE_SPECS: Record<Size, BoxSizeSpec> = {
  small: { label: "Small", cpu: 2, ramGb: 4, storageGb: 10, workDiskGb: 5, activeCpuHourlyUsd: 0.1, keepAliveMonthlyUsd: 8 },
  medium: { label: "Medium", cpu: 4, ramGb: 8, storageGb: 20, workDiskGb: 10, activeCpuHourlyUsd: 0.2, keepAliveMonthlyUsd: 16 },
  large: { label: "Large", cpu: 8, ramGb: 16, storageGb: 30, workDiskGb: 15, activeCpuHourlyUsd: 0.4, keepAliveMonthlyUsd: 32 },
}

export const BOX_SIZE_DOCS = "https://upstash.com/docs/box/overall/how-it-works#box-size"

/** -1, 0 or 1: is `a` smaller than, the same as or bigger than `b`. */
export function compareSizes(a: Size, b: Size): number {
  return Math.sign(BOX_SIZE_ORDER.indexOf(a) - BOX_SIZE_ORDER.indexOf(b))
}

/** "4 vCPU · 8 GB RAM · 20 GB disk" */
export function sizeSpecLine(size: Size): string {
  const s = BOX_SIZE_SPECS[size]
  return `${s.cpu} vCPU · ${s.ramGb} GB RAM · ${s.storageGb} GB disk`
}

/** "$0.20/active CPU hour" */
export function sizePriceLine(size: Size): string {
  return `$${BOX_SIZE_SPECS[size].activeCpuHourlyUsd.toFixed(2)}/active CPU hour`
}

/** Work-disk bytes for a size: what a box of that size last reported (df), else the table's estimate. */
export function workDiskBytes(size: Size, observed?: number | null): number {
  return observed && observed > 0 ? observed : BOX_SIZE_SPECS[size].workDiskGb * 1024 ** 3
}

export interface DiskFit {
  ok: boolean
  /** Disk in use on the box now (df), null when it hasn't been measured. */
  usedBytes: number | null
  /** The smaller size's work disk. */
  capacityBytes: number
  /** Free space to keep on top of what's in use (Settings → Disk: the free-space floor). */
  headroomBytes: number
  /** Why it doesn't fit, for the modal and the MCP refusal. */
  reason: string | null
}

/**
 * Would what's on the box fit a smaller box with room to spare? What's in use now (df) plus the free-space
 * floor new workspaces need must fit the target's work disk. Unmeasured disk is refused: guessing could strand
 * workspaces that don't fit.
 */
export function scaleDownFit(input: { usedBytes: number | null; to: Size; headroomBytes: number; observedTotalBytes?: number | null }): DiskFit {
  const capacityBytes = workDiskBytes(input.to, input.observedTotalBytes)
  const base = { usedBytes: input.usedBytes, capacityBytes, headroomBytes: input.headroomBytes }
  if (input.usedBytes === null) return { ...base, ok: false, reason: "Disk use on this box hasn't been measured yet, so a smaller box might not fit it. Try again in a minute." }
  if (input.usedBytes + input.headroomBytes <= capacityBytes) return { ...base, ok: true, reason: null }
  return {
    ...base,
    ok: false,
    reason:
      `${formatBytes(input.usedBytes)} is in use, and a ${input.to} box has about ${formatBytes(capacityBytes)}; with the ${formatBytes(input.headroomBytes)} ` +
      `new workspaces need free, it wouldn't fit. Clean up or clear the box first.`,
  }
}

/** Resize in place (the provider changes the box's size) or by moving everything to a new box. */
export type ResizeMode = "in-place" | "migration"

export type ResizeInitiator =
  | { kind: "cody" }
  | { kind: "coordinator" }
  | { kind: "captain"; projectId: string }
  /** Box Yard itself: placement grew an idle box for a task whose project needs a bigger box (the pool was full). */
  | { kind: "scheduler"; projectId: string; taskId: string }

export interface ResizeStep {
  key: "stop" | "resize" | "create" | "archive" | "move" | "delete"
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  detail: string | null
}

/** A box resize, running or finished. Kept per box (old and new) and sent as SSE `box.resize`. */
export interface BoxResize {
  id: string
  /** The box being resized. After a migration it's gone and `newBoxId` holds the work. */
  boxId: string
  newBoxId: string | null
  from: Size
  to: Size
  mode: ResizeMode
  status: "running" | "done" | "failed"
  steps: ResizeStep[]
  /** Tasks moved to the new box (migration). */
  movedTasks: string[]
  by: ResizeInitiator
  reason: string | null
  error: string | null
  /** After a failed migration: what happened to the box it created ("Deleted the new medium box …"). */
  cleanup?: string | null
  startedAt: number
  finishedAt: number | null
}

/** What a resize would do, for the Resize modal (GET /api/boxes/:id/resize?size=…). */
export interface ResizePlan {
  boxId: string
  from: Size
  to: Size
  mode: ResizeMode
  running: { id: string; title: string }[]
  /** Tasks that would move (migration). */
  tasks: number
  /** Only for a scale-down. */
  fit: DiskFit | null
  /** Why it can't go ahead right now, or null. Running agents aren't a refusal: they're stopped on a second confirm. */
  refusal: string | null
}

export function resizeTitle(r: Pick<BoxResize, "boxId" | "from" | "to" | "status">): string {
  const verb = r.status === "running" ? "Resizing" : r.status === "failed" ? "Couldn't resize" : "Resized"
  return `${verb} ${r.boxId}: ${r.from} → ${r.to}`
}

/** A failed resize's error, then what happened to the box it made: "archive step failed: …. Deleted the new medium box …." */
export function resizeFailure(r: Pick<BoxResize, "error" | "cleanup">): string {
  const error = r.error ?? "unknown error"
  return r.cleanup ? `${error}${/[.!?]$/.test(error) ? "" : "."} ${r.cleanup}` : error
}

/** One line for toasts, notices and pool_status. */
export function resizeSummary(r: BoxResize): string {
  if (r.status === "failed") return resizeFailure(r)
  if (r.status === "running") {
    const step = r.steps.find((s) => s.status === "running")
    return step ? `${step.label}…` : "Starting…"
  }
  if (r.mode === "in-place") return `now ${r.to} (${sizeSpecLine(r.to)})`
  const n = r.movedTasks.length
  return `moved to ${r.newBoxId} (${r.to}); ${n} ${n === 1 ? "task restores" : "tasks restore"} from ${n === 1 ? "its" : "their"} archive on the next message`
}

export function initiatorLabel(by: ResizeInitiator, projectName?: string): string {
  return by.kind === "cody"
    ? "Cody"
    : by.kind === "coordinator"
    ? "The Coordinator"
    : by.kind === "scheduler"
    ? "Box Yard"
    : `The ${projectName ?? by.projectId} Captain`
}
