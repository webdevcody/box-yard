// Disk and cleanup display for the Boxes page and the cleanup toasts.
import { cleanupSummary, diskLine, formatBytes, LOW_DISK_RATIO } from "../../../shared/disk"
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
    label: diskLine({ freeBytes: free, totalBytes: total }),
  }
}

const REASON: Record<BoxCleanup["reason"], string> = {
  "low-disk": "it was low on disk",
  "out-of-space": "a task ran out of space",
  manual: "Clean up now",
  clear: "Clear box",
}

/** Workspaces a Clear box run archived and took off the box. */
const clearedCount = (c: BoxCleanup) => c.steps.find((s) => s.key === "archive")?.removed.length ?? 0
const workspaces = (n: number) => `${n} ${n === 1 ? "workspace" : "workspaces"}`

/** One line about a cleanup for the box card, without its time. */
export function cleanupLine(c: BoxCleanup): string {
  const clear = c.reason === "clear"
  if (c.status === "running") {
    const done = c.steps.filter((s) => !s.skipped || s.freedBytes > 0).length
    const verb = clear ? "Clearing" : "Cleaning up"
    return c.freedBytes > 0 ? `${verb}: freed ${formatBytes(c.freedBytes)} so far (${done} of ${clear ? 4 : 5} steps)` : `${verb}…`
  }
  if (c.status === "failed") return `${clear ? "Clear" : "Cleanup"} failed: ${c.error ?? "unknown error"}`
  if (clear) return `Cleared: archived and removed ${workspaces(clearedCount(c))}, ${cleanupSummary(c)}`
  const why = c.reason === "manual" ? "Cleaned up" : `Cleaned up because ${REASON[c.reason]}`
  const short = c.targetFreeBytes !== null && !c.enough ? `; still short of the ${formatBytes(c.targetFreeBytes)} new workspaces need` : ""
  return `${why}: ${cleanupSummary(c)}${short}`
}

/** The toast for a finished cleanup, or null while it's still running. */
export function cleanupToast(c: BoxCleanup): { kind: "info" | "error"; title: string; body: string } | null {
  if (c.status === "running") return null
  const clear = c.reason === "clear"
  if (c.status === "failed") return { kind: "error", title: `${clear ? "Clearing" : "Cleanup on"} ${c.boxId} failed`, body: c.error ?? "Unknown error" }
  const free = c.freeAfter !== null ? ` ${formatBytes(c.freeAfter)} free now.` : ""
  const short = c.targetFreeBytes !== null && !c.enough ? " Still low: tasks that can't go elsewhere wait for room." : ""
  const summary = cleanupSummary(c)
  const kept = clear ? c.steps.find((s) => s.key === "archive")?.skipped : null
  const lead = clear ? `Archived and removed ${workspaces(clearedCount(c))}; ${summary}` : `${summary[0]!.toUpperCase()}${summary.slice(1)}`
  const note = kept?.startsWith("kept ") ? ` ${kept[0]!.toUpperCase()}${kept.slice(1)}.` : ""
  return { kind: (c.enough || c.targetFreeBytes === null) && !note ? "info" : "error", title: `${clear ? "Cleared" : "Cleaned up"} ${c.boxId}`, body: `${lead}.${free}${short}${note}` }
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
