// The Boxes page overview: which boxes need attention and why, the filter tabs, and the one-line "running now".
import { formatBytes } from "../../../shared/disk"
import type { BoxInfo, Task } from "../../../shared/types"
import { splitBoxTasks } from "./boxTasks"
import { cleanupLine, diskMeter } from "./diskCleanup"

export type AttentionLevel = "error" | "warn"

export interface AttentionReason {
  key: "lost" | "disk" | "cleanup" | "over"
  level: AttentionLevel
  /** A few words for the row tooltip. */
  short: string
  /** The full sentence for the details modal. */
  detail: string
}

type AttentionBox = Pick<BoxInfo, "status" | "diskFreeBytes" | "diskTotalBytes" | "diskLow" | "cleanup" | "runningTurns" | "slots">

/** Why a box needs Cody's eye, worst first; empty when it's fine. */
export function boxAttention(box: AttentionBox): AttentionReason[] {
  const out: AttentionReason[] = []
  if (box.status === "lost")
    out.push({ key: "lost", level: "error", short: "Not responding", detail: "Box Yard lost touch with this box. Its tasks are moved or retried when they run again." })
  const disk = diskMeter(box)
  if (disk?.low && box.status !== "lost") {
    const short = box.cleanup?.status === "done" && box.cleanup.targetFreeBytes !== null && !box.cleanup.enough ? `; the last cleanup still left it short of ${formatBytes(box.cleanup.targetFreeBytes)}` : ""
    out.push({
      key: "disk",
      level: disk.free / disk.total < CRITICAL_DISK_RATIO ? "error" : "warn",
      short: `Low on disk: ${formatBytes(disk.free)} free`,
      detail: `Low on disk (${disk.label})${short}. New tasks go to other boxes while it cleans up; they wait here only when no other box has room.`,
    })
  }
  if (box.cleanup?.status === "failed") out.push({ key: "cleanup", level: "warn", short: "Last cleanup failed", detail: cleanupLine(box.cleanup) })
  if (box.runningTurns > box.slots)
    out.push({ key: "over", level: "warn", short: `${box.runningTurns}/${box.slots} agents: over its limit`, detail: `${box.runningTurns} agents are running on ${box.slots} slots. Running work continues; nothing new is placed here until it drops.` })
  return out
}

/** Below this share of the disk free, the disk meter and attention icon turn red instead of amber. */
export const CRITICAL_DISK_RATIO = 0.05

/** Tone for the row's disk meter. */
export function diskTone(box: Pick<BoxInfo, "diskFreeBytes" | "diskTotalBytes" | "diskLow">): "ok" | "warn" | "error" | "unknown" {
  const disk = diskMeter(box)
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
