// The Boxes page overview: which boxes need attention and why, the filter tabs, and the one-line "running now".
import { formatBytes } from "../../../shared/disk"
import { TASK_STATUSES, type BoxInfo, type Task, type TaskStatus } from "../../../shared/types"
import { splitBoxTasks } from "./boxTasks"
import { cleanupLine, diskMeter, rootMeter, type DiskMeter } from "./diskCleanup"

export type AttentionLevel = "error" | "warn"

export interface AttentionReason {
  key: "lost" | "deleting" | "disk" | "root" | "cleanup" | "over"
  level: AttentionLevel
  /** A few words for the row tooltip. */
  short: string
  /** The full sentence for the details modal. */
  detail: string
}

type AttentionBox = Pick<BoxInfo, "status" | "diskFreeBytes" | "diskTotalBytes" | "rootFreeBytes" | "rootTotalBytes" | "diskLow" | "cleanup" | "runningTurns" | "slots">

/** Why a box needs Cody's eye, worst first; empty when it's fine. */
export function boxAttention(box: AttentionBox): AttentionReason[] {
  const out: AttentionReason[] = []
  if (box.status === "lost")
    out.push({ key: "lost", level: "error", short: "Not responding", detail: "Box Yard lost touch with this box. Its tasks are moved or retried when they run again." })
  if (box.status === "deleting")
    out.push({
      key: "deleting",
      level: "warn",
      short: "Delete didn't go through yet",
      detail: "Box Yard asked the provider to delete this unused box and it hasn't confirmed yet. Box Yard retries every few minutes; nothing is placed here meanwhile.",
    })
  const disk = diskMeter(box)
  if (disk?.low && box.status !== "lost" && box.status !== "deleting") {
    const short = box.cleanup?.status === "done" && box.cleanup.targetFreeBytes !== null && !box.cleanup.enough ? `; the last cleanup still left it short of ${formatBytes(box.cleanup.targetFreeBytes)}` : ""
    out.push({
      key: "disk",
      level: disk.free / disk.total < CRITICAL_DISK_RATIO ? "error" : "warn",
      short: `Low on disk: ${formatBytes(disk.free)} free`,
      detail: `Low on disk (${disk.label})${short}. New tasks go to other boxes while it cleans up; they wait here only when no other box has room.`,
    })
  }
  const root = rootMeter(box)
  if (root?.low && box.status !== "lost" && box.status !== "deleting")
    out.push({
      key: "root",
      level: root.free / root.total < CRITICAL_DISK_RATIO ? "error" : "warn",
      short: `Root disk low: ${formatBytes(root.free)} free`,
      detail: `Low on the root disk, where /tmp and home live (${root.label}). Box Yard removes stale temp folders there by itself while it stays low, and stages archives on whichever disk has more room.`,
    })
  if (box.cleanup?.status === "failed") out.push({ key: "cleanup", level: "warn", short: "Last cleanup failed", detail: cleanupLine(box.cleanup) })
  if (box.runningTurns > box.slots)
    out.push({ key: "over", level: "warn", short: `${box.runningTurns}/${box.slots} agents: over its limit`, detail: `${box.runningTurns} agents are running on ${box.slots} slots. Running work continues; nothing new is placed here until it drops.` })
  return out
}

/** Below this share of the disk free, the disk meter and attention icon turn red instead of amber. */
export const CRITICAL_DISK_RATIO = 0.05

/** Tone for the row's disk meter. */
export function diskTone(box: Pick<BoxInfo, "diskFreeBytes" | "diskTotalBytes" | "diskLow">): "ok" | "warn" | "error" | "unknown" {
  return meterTone(diskMeter(box))
}

/** Tone for the root disk's meter. */
export function rootTone(box: Pick<BoxInfo, "rootFreeBytes" | "rootTotalBytes">): "ok" | "warn" | "error" | "unknown" {
  return meterTone(rootMeter(box))
}

function meterTone(disk: DiskMeter | null): "ok" | "warn" | "error" | "unknown" {
  if (!disk) return "unknown"
  if (!disk.low) return "ok"
  return disk.free / disk.total < CRITICAL_DISK_RATIO ? "error" : "warn"
}

export const BOX_FILTERS = [
  { key: "all", label: "All" },
  { key: "busy", label: "Busy" },
  { key: "idle", label: "Idle" },
  { key: "attention", label: "Needs attention" },
] as const
export type BoxFilter = (typeof BOX_FILTERS)[number]["key"]

/** The `?filter=` param as a filter; anything unknown is "all". */
export function parseBoxFilter(value: string | null | undefined): BoxFilter {
  return BOX_FILTERS.some((f) => f.key === value) ? (value as BoxFilter) : "all"
}

export function matchesBoxFilter(box: AttentionBox, filter: BoxFilter): boolean {
  if (filter === "busy") return box.runningTurns > 0
  if (filter === "idle") return box.runningTurns === 0
  if (filter === "attention") return boxAttention(box).length > 0
  return true
}

/** Boxes in one filter, in the order given (the server's: oldest box first), so rows never jump. */
export function filterBoxes<B extends AttentionBox>(boxes: B[], filter: BoxFilter): B[] {
  return boxes.filter((b) => matchesBoxFilter(b, filter))
}

export function boxFilterCounts(boxes: AttentionBox[]): Record<BoxFilter, number> {
  return Object.fromEntries(BOX_FILTERS.map((f) => [f.key, filterBoxes(boxes, f.key).length])) as Record<BoxFilter, number>
}

/** The pool at a glance: total estimated spend of the live boxes and how many need attention. */
export function poolSummary(boxes: (AttentionBox & Pick<BoxInfo, "estimatedCostUsd">)[]) {
  return {
    costUsd: boxes.reduce((sum, b) => sum + b.estimatedCostUsd, 0),
    attention: boxes.filter((b) => boxAttention(b).length > 0).length,
  }
}

/**
 * What a box is doing right now, for its one-line "running now" cell: the oldest active task (agents first,
 * then ones waiting on someone) and how many more are active. Null when nothing is.
 */
export function nowRunning(tasks: Task[]): { task: Task; more: number } | null {
  const { active } = splitBoxTasks(tasks)
  if (!active.length) return null
  const busy = active.filter((t) => t.status === "working" || t.status === "starting")
  const first = busy[0] ?? active[0]!
  return { task: first, more: active.length - 1 }
}

/** Tasks on a box grouped by status, in the usual status order, for the Clear/Delete confirmations. */
export function statusCounts(tasks: { status: TaskStatus }[]): { status: TaskStatus; count: number }[] {
  return TASK_STATUSES.map((status) => ({ status, count: tasks.filter((t) => t.status === status).length })).filter((s) => s.count > 0)
}

/** Why a box's Clean up / Clear / Resize / Delete buttons are disabled right now, or null when they aren't. */
export function boxBusyReason(box: Pick<BoxInfo, "operation" | "cleanup">): string | null {
  const op = box.operation ?? (box.cleanup?.status === "running" ? (box.cleanup.reason === "clear" ? "clear" : "cleanup") : null)
  if (op === "cleanup") return "A disk cleanup is running on this box"
  if (op === "clear") return "This box is being cleared"
  if (op === "delete") return "This box is being deleted"
  if (op === "resize") return "This box is being resized"
  return null
}
