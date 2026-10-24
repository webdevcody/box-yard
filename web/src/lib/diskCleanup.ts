// Disk and cleanup display for the Boxes page and the cleanup toasts.
import { CLEANUP_STEPS, CLEAR_STEPS, cleanupSummary, diskLine, formatBytes, LOW_DISK_RATIO, rootLow, type CleanupStepKey } from "../../../shared/disk"
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

/**
 * The box's root disk (/, holding /tmp and HOME on Upstash) from its last df, or null when it's the work disk or
 * not measured yet. Low is the server's rootLow: when it sweeps stale temp folders there by itself.
 */
export function rootMeter(box: Pick<BoxInfo, "rootFreeBytes" | "rootTotalBytes">): DiskMeter | null {
  const free = box.rootFreeBytes ?? null
  const total = box.rootTotalBytes ?? null
  if (free === null || total === null || total <= 0) return null
  const used = Math.max(0, total - free)
  return {
    free,
    total,
    used,
    usedRatio: Math.min(1, used / total),
    low: rootLow({ freeBytes: free, totalBytes: total }),
    label: diskLine({ freeBytes: free, totalBytes: total }),
  }
}

const REASON: Record<BoxCleanup["reason"], string> = {
  "low-disk": "it was low on disk",
  "out-of-space": "a task ran out of space",
  manual: "Clean up now",
  clear: "Clear box",
  routine: "routine upkeep",
}

/** Workspaces a Clear box run archived and took off the box. */
const clearedCount = (c: BoxCleanup) => c.steps.find((s) => s.key === "archive")?.removed.length ?? 0
const workspaces = (n: number) => `${n} ${n === 1 ? "workspace" : "workspaces"}`

/** What a routine upkeep step is for, in a few words. */
const ROUTINE_WORK: Partial<Record<CleanupStepKey, string>> = { tmp: "stale temp folders", caches: "caches", builds: "idle build output", git: "mirror gc" }
const routineWork = (c: BoxCleanup) => c.steps.flatMap((s) => ROUTINE_WORK[s.key] ?? []).join(", ") || "idle build output, mirror gc"

/** One line about a cleanup for the box card, without its time. */
export function cleanupLine(c: BoxCleanup): string {
  const clear = c.reason === "clear"
  if (c.status === "running") {
    const done = c.steps.filter((s) => !s.skipped || s.freedBytes > 0).length
    const verb = clear ? "Clearing" : "Cleaning up"
    return c.freedBytes > 0 ? `${verb}: freed ${formatBytes(c.freedBytes)} so far (${done} of ${clear ? CLEAR_STEPS.length : CLEANUP_STEPS.length} steps)` : `${verb}…`
  }
  if (c.status === "failed") return `${clear ? "Clear" : "Cleanup"} failed: ${c.error ?? "unknown error"}`
  if (clear) return `Cleared: archived and removed ${workspaces(clearedCount(c))}, ${cleanupSummary(c)}`
  const why = c.reason === "manual" ? "Cleaned up" : c.reason === "routine" ? `Routine upkeep (${routineWork(c)})` : `Cleaned up because ${REASON[c.reason]}`
  const short = c.targetFreeBytes !== null && !c.enough ? `; still short of the ${formatBytes(c.targetFreeBytes)} new workspaces need` : ""
  return `${why}: ${cleanupSummary(c)}${short}`
}

/** The toast for a finished cleanup, or null while it's still running. */
export function cleanupToast(c: BoxCleanup): { kind: "info" | "error"; title: string; body: string } | null {
  // Routine upkeep is Box Yard's own housekeeping: it shows on the box card, not as a toast.
  if (c.status === "running" || c.reason === "routine") return null
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
