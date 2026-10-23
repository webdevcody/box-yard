// Disk and cleanup display for the Boxes page and the cleanup toasts.
import { cleanupSummary, formatBytes, LOW_DISK_RATIO } from "../../../shared/disk"
import type { BoxCleanup, BoxInfo } from "../../../shared/types"
import { toast } from "./toast"

export interface DiskMeter {
  free: number
  total: number
  used: number
  /** 0..1 of the disk in use. */
  usedRatio: number
  /** Too little free for a new workspace (server's call), or under LOW_DISK_RATIO of the disk. */
  low: boolean
  label: string
}

/** The box's work disk from its last df, or null before the first check. */
export function diskMeter(box: Pick<BoxInfo, "diskFreeBytes" | "diskTotalBytes" | "diskLow">): DiskMeter | null {
  const free = box.diskFreeBytes
  const total = box.diskTotalBytes
  if (free === null || total === null || total <= 0) return null
  const used = Math.max(0, total - free)
  return {
    free,
    total,
    used,
    usedRatio: Math.min(1, used / total),
    low: box.diskLow || free / total < LOW_DISK_RATIO,
    label: `${formatBytes(free)} free of ${formatBytes(total)}`,
  }
}

const REASON: Record<BoxCleanup["reason"], string> = {
  "low-disk": "it was low on disk",
  "out-of-space": "a task ran out of space",
  manual: "Clean up now",
}

/** One line about a cleanup for the box card, without its time. */
export function cleanupLine(c: BoxCleanup): string {
  if (c.status === "running") {
    const done = c.steps.filter((s) => !s.skipped || s.freedBytes > 0).length
    return c.freedBytes > 0 ? `Cleaning up: freed ${formatBytes(c.freedBytes)} so far (${done} of 5 steps)` : "Cleaning up…"
  }
  if (c.status === "failed") return `Cleanup failed: ${c.error ?? "unknown error"}`
  const why = c.reason === "manual" ? "Cleaned up" : `Cleaned up because ${REASON[c.reason]}`
  const short = c.targetFreeBytes !== null && !c.enough ? `; still short of the ${formatBytes(c.targetFreeBytes)} new workspaces need` : ""
  return `${why}: ${cleanupSummary(c)}${short}`
}

/** The toast for a finished cleanup, or null while it's still running. */
export function cleanupToast(c: BoxCleanup): { kind: "info" | "error"; title: string; body: string } | null {
  if (c.status === "running") return null
  if (c.status === "failed") return { kind: "error", title: `Cleanup on ${c.boxId} failed`, body: c.error ?? "Unknown error" }
  const free = c.freeAfter !== null ? ` ${formatBytes(c.freeAfter)} free now.` : ""
  const short = c.targetFreeBytes !== null && !c.enough ? " Still low: tasks that can't go elsewhere wait for room." : ""
  const summary = cleanupSummary(c)
  return { kind: c.enough || c.targetFreeBytes === null ? "info" : "error", title: `Cleaned up ${c.boxId}`, body: `${summary[0]!.toUpperCase()}${summary.slice(1)}.${free}${short}` }
}

/** Toast a finished cleanup (SSE box.cleanup). */
export function announceCleanup(c: BoxCleanup) {
  const t = cleanupToast(c)
  if (!t) return
  if (t.kind === "error") toast.error(t.title, t.body)
  else toast.info(t.title, t.body, { duration: 6000 })
}

/** The boxes list with one box's cleanup replaced; the same list when the box isn't in it. */
export function withCleanup(list: BoxInfo[] | undefined, c: BoxCleanup): BoxInfo[] | undefined {
  if (!list?.some((b) => b.id === c.boxId)) return list
  return list.map((b) => (b.id === c.boxId ? { ...b, cleanup: c } : b))
}
