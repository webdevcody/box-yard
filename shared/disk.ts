// Disk-space helpers shared by the server (placement, cleanup) and the web app (Boxes page, toasts).
import { MEM_MARK, memCommand, parseMemory, type BoxMemory } from "./memory.js"

/**
 * One step of a box cleanup, run in this order. Each step stops the run once there is enough room, except "tmp":
 * it frees the root disk (/tmp and HOME on Upstash), not the work disk, and needs no room to run.
 */
export const CLEANUP_STEPS = [
  { key: "tmp", label: "Stale temp folders on the root disk (/tmp)" },
  { key: "partials", label: "Partial clones and failed task folders" },
  { key: "caches", label: "npm, pip and tmp caches" },
  { key: "builds", label: "node_modules and build output in resting tasks" },
  { key: "git", label: "git gc and unused repo mirrors" },
  { key: "archive", label: "Done workspaces parked in the archive" },
] as const

/**
 * With the work disk all but full (under EMERGENCY_FREE_BYTES free) these run before CLEANUP_STEPS: they need no
 * room to work, and leave enough for the steps after them (installing the runner, git gc, archiving).
 */
export const EMERGENCY_STEPS = [
  { key: "temp", label: "Session temp files and leftover restore/archive files" },
  { key: "merged", label: "Done workspaces whose PR is merged and fully pushed" },
] as const

/** A box's work disk with less free than this gets the emergency steps first. */
export const EMERGENCY_FREE_BYTES = 100 * 1024 * 1024

export type CleanupStepKey = (typeof CLEANUP_STEPS)[number]["key"] | (typeof EMERGENCY_STEPS)[number]["key"]

/** Clear box: every workspace is archived and leaves the box first, then the leftovers, caches and repo mirrors go. */
export const CLEAR_STEPS: readonly { key: CleanupStepKey; label: string }[] = [
  { key: "archive", label: "Archive every workspace, then remove it from the box" },
  { key: "partials", label: "Leftover task folders and temp files" },
  { key: "tmp", label: "Stale temp folders on the root disk (/tmp)" },
  { key: "caches", label: "npm, pip and tmp caches" },
  { key: "git", label: "Repo mirrors" },
]

export interface CleanupStepReport {
  key: CleanupStepKey
  label: string
  /** Bytes the step freed, measured with df before and after. */
  freedBytes: number
  /** Things it removed (task ids, cache names), for the log. */
  removed: string[]
  /** Why the step didn't run, when it didn't. */
  skipped: string | null
}

/**
 * "clear" is Clear box: archive and remove every workspace, keep the box. "routine" is the quiet upkeep Box Yard
 * runs by itself: build output of tasks idle past Settings › buildCleanupIdleMinutes, and a light mirror gc.
 */
export type CleanupReason = "low-disk" | "out-of-space" | "manual" | "clear" | "routine"

export interface BoxCleanup {
  boxId: string
  reason: CleanupReason
  status: "running" | "done" | "failed"
  startedAt: number
  finishedAt: number | null
  /** Free bytes the run aimed for; null runs every safe step (Clean up now). */
  targetFreeBytes: number | null
  freeBefore: number | null
  freeAfter: number | null
  totalBytes: number | null
  /** The root disk (/tmp, HOME) before and after, when it isn't the work disk. */
  rootFreeBefore?: number | null
  rootFreeAfter?: number | null
  rootTotalBytes?: number | null
  freedBytes: number
  steps: CleanupStepReport[]
  /** Free space reached the target. */
  enough: boolean
  error: string | null
}

export interface DiskSpace {
  freeBytes: number
  totalBytes: number
  /** The root disk (/, holding /tmp and HOME on Upstash) when it's another filesystem than the work disk. */
  root?: { freeBytes: number; totalBytes: number } | null
  /** The box's memory and load, read by the same script (shared/memory.ts). */
  memory?: BoxMemory | null
}

/** Separates the work disk's df line from the root disk's in dfCommand's output. */
const ROOT_DF_MARK = "@@boxyard-root-df"

/** `df -Pk` for the folder a box keeps its work in, then for /tmp (the root disk on Upstash), then memory and load. */
export const dfCommand = (dir: string) => `df -Pk '${dir.replace(/'/g, `'\\''`)}' | tail -n 1; echo ${ROOT_DF_MARK}; df -Pk /tmp 2>/dev/null | tail -n 1; ${memCommand()}`

/** Free, total and mount point from the last line of a `df -Pk` (POSIX format, 1K blocks). */
function dfLine(text: string): { freeBytes: number; totalBytes: number; mount: string } | null {
  const line = text.trim().split("\n").pop() ?? ""
  // Filesystem 1024-blocks Used Available Capacity Mounted-on; the filesystem name can hold spaces, so read from the right.
  const m = line.match(/(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\S.*)$/)
  if (!m) return null
  const total = Number(m[1]) * 1024
  const free = Number(m[3]) * 1024
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 ? { freeBytes: free, totalBytes: total, mount: m[4]!.trim() } : null
}

/**
 * The work disk from dfCommand's output (or a single `df -Pk` line), or null if it doesn't parse. `root` is set
 * when /tmp is on another filesystem.
 */
export function parseDf(stdout: string): DiskSpace | null {
  const memAt = stdout.indexOf(MEM_MARK)
  const [workPart, rootPart] = (memAt < 0 ? stdout : stdout.slice(0, memAt)).split(ROOT_DF_MARK)
  const work = dfLine(workPart ?? "")
  if (!work) return null
  const root = rootPart === undefined ? null : dfLine(rootPart)
  const memory = parseMemory(stdout)
  return {
    freeBytes: work.freeBytes,
    totalBytes: work.totalBytes,
    root: root && root.mount !== work.mount ? { freeBytes: root.freeBytes, totalBytes: root.totalBytes } : null,
    // Left out (not null) without a memory part, so df-only fakes and old outputs read as before.
    ...(memory ? { memory } : {}),
  }
}

/** A root disk with less free than this (or than LOW_DISK_RATIO of it) gets its stale temp folders swept. */
export const ROOT_MIN_FREE_BYTES = 512 * 1024 * 1024

/** Is the root disk (/tmp, HOME) getting full? */
export function rootLow(root: { freeBytes: number | null; totalBytes: number | null } | null | undefined): boolean {
  if (!root || root.freeBytes === null || root.totalBytes === null) return false
  return root.freeBytes < Math.max(ROOT_MIN_FREE_BYTES, root.totalBytes * LOW_DISK_RATIO)
}

/** "1.2 GB free of 20 GB on the root disk (/tmp, home)", or null when it's the work disk or unmeasured. */
export function rootDiskLine(d: { rootFreeBytes?: number | null; rootTotalBytes?: number | null }): string | null {
  if (d.rootFreeBytes === null || d.rootFreeBytes === undefined || d.rootTotalBytes === null || d.rootTotalBytes === undefined) return null
  return `${formatBytes(d.rootFreeBytes)} free of ${formatBytes(d.rootTotalBytes)} on the root disk (/tmp, home)`
}

/**
 * Does this error mean the disk filled up? Covers errno (ENOSPC), the libc text,
 * git's "Out of diskspace" and its pack "write error", and quota errors.
 */
export function isOutOfSpace(text: string | null | undefined): boolean {
  if (!text) return false
  return /\bENOSPC\b|no space left on device|out of disk ?space|disk quota exceeded|\bEDQUOT\b|not enough (disk )?space|\bwrite error\b/i.test(text)
}

export interface DiskPolicy {
  /** Never place a new workspace on a box with less free than this. */
  minFreeMb: number
  /** ...or less than this many times the repo's last clone size, whichever is larger. */
  cloneFactor: number
}

/** Free space a new workspace needs: the larger of the floor and `cloneFactor` × the repo's last known clone size. */
export function requiredFreeBytes(policy: DiskPolicy, cloneBytes: number | null | undefined): number {
  const floor = Math.max(0, policy.minFreeMb) * 1024 * 1024
  const byClone = cloneBytes && cloneBytes > 0 ? Math.ceil(cloneBytes * Math.max(1, policy.cloneFactor)) : 0
  return Math.max(floor, byClone)
}

/** 1.2 GB, 340 MB, 12 KB. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(abs >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (abs >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (abs >= 1024) return `${Math.round(n / 1024)} KB`
  return `${Math.round(n)} B`
}

/** "measured 12s ago", "measured 3m ago": how old a df reading is. */
export function measuredAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 90) return `measured ${s}s ago`
  if (s < 90 * 60) return `measured ${Math.round(s / 60)}m ago`
  return `measured ${Math.round(s / 3600)}h ago`
}

/**
 * The one way Box Yard states a box's disk, from df on its work disk (/workspace on Upstash):
 * "943 MB free of 5.0 GB · measured 12s ago". The Boxes page, pool_status and notices all use it.
 */
export function diskLine(d: { freeBytes: number | null; totalBytes: number | null; checkedAt?: number | null }, now = Date.now()): string {
  if (d.freeBytes === null || d.totalBytes === null) return "free space not measured yet"
  const line = `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`
  return d.checkedAt ? `${line} · ${measuredAgo(d.checkedAt, now)}` : line
}

/** "freed 1.2 GB (caches 800 MB, builds 400 MB)" or "freed nothing". */
export function cleanupSummary(c: Pick<BoxCleanup, "freedBytes" | "steps">): string {
  const parts = c.steps.filter((s) => s.freedBytes >= 1024 * 1024).map((s) => `${s.key} ${formatBytes(s.freedBytes)}`)
  if (c.freedBytes < 1024 * 1024) return "freed nothing"
  return `freed ${formatBytes(c.freedBytes)}${parts.length ? ` (${parts.join(", ")})` : ""}`
}

/** Below this share of the disk free, the Boxes page shows the meter in amber. */
export const LOW_DISK_RATIO = 0.1
