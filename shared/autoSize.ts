// Auto-sizing: the Upstash box size a project's tasks need, from what its turns used (the box probe samples them in
// server/tasks.ts). A project's own Box size overrides it. Pure, so the server, MCP and project settings agree.
import { BOX_SIZE_ORDER, BOX_SIZE_SPECS, compareSizes, workDiskBytes } from "./boxSizes.js"
import { formatBytes } from "./disk.js"
import type { BoxSize } from "./types.js"

/** How far back runs count. */
export const AUTO_SIZE_WINDOW_MS = 14 * 24 * 3_600_000
/** Runs measured before they pick the size; until then Settings › Worker size applies. */
export const AUTO_SIZE_MIN_RUNS = 3
/** RAM (and work disk) over the 14-day peak: 1.25 × it. */
export const AUTO_SIZE_HEADROOM = 1.25
/** CPU at or over this share of a box's cores is held back by them. */
export const AUTO_SIZE_CPU_BUSY = 0.9

/** One measured turn of a project (table turn_peaks), from the probes taken while only its project's turns ran on the box. */
export interface TurnPeak {
  /** The box's size while it ran. */
  boxSize: BoxSize
  at: number
  /** Memory in use (without reclaimable page cache), the most seen. */
  memPeakBytes: number | null
  /** CPU cores in use, the busiest minute or more. */
  cpuPeakCores: number | null
  /** The CPU it kept up for half its measured minutes (the median minute): what "stays above" reads. */
  cpuBusyCores: number | null
  /** Work disk in use, the most seen. */
  diskPeakBytes: number | null
  /** The box's cgroup killed a process for memory while it ran. */
  oom: boolean
}

export type AutoSizeBasis = "memory" | "cpu" | "disk" | "out-of-memory"

export interface AutoBoxSize {
  /** The size it picks; null until enough runs are measured (and none ran out of memory), when Settings › Worker size applies. */
  size: BoxSize | null
  /** Measured runs in the window. */
  runs: number
  memPeakBytes: number | null
  cpuPeakCores: number | null
  diskPeakBytes: number | null
  /** What decided the size. */
  basis: AutoSizeBasis | null
  /** It needed more than Settings › Max size it may choose, and was held to that. */
  capped: boolean
  /** "medium (peak 5.1 GB over 12 runs)" */
  label: string
}

/** A project's auto size as the API and project settings show it (TaskManager.autoBoxSize). */
export type ProjectAutoSize = AutoBoxSize & {
  /** Settings › Size and resize boxes automatically is on, so the size applies where the project has none of its own. */
  enabled: boolean
  /** The project's own box size, which overrides it. */
  override: BoxSize | null
}

const next = (size: BoxSize): BoxSize => BOX_SIZE_ORDER[BOX_SIZE_ORDER.indexOf(size) + 1] ?? size
/** The smallest size with at least `need` of something, else the largest. */
const smallestWith = (need: number, has: (size: BoxSize) => number): BoxSize => BOX_SIZE_ORDER.find((s) => has(s) >= need) ?? BOX_SIZE_ORDER[BOX_SIZE_ORDER.length - 1]!
const peakOf = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? Math.max(...xs.filter((x): x is number => x !== null)) : null)

/** The size one run's CPU asks for: cores to keep its median minute under 90%; one up from its box if it was at that box's limit. */
function cpuNeed(p: TurnPeak): BoxSize | null {
  if (p.cpuBusyCores === null) return null
  const fits = smallestWith(p.cpuBusyCores / AUTO_SIZE_CPU_BUSY, (s) => BOX_SIZE_SPECS[s].cpu)
  const held = p.cpuBusyCores >= AUTO_SIZE_CPU_BUSY * BOX_SIZE_SPECS[p.boxSize].cpu
  return held && compareSizes(fits, next(p.boxSize)) < 0 ? next(p.boxSize) : fits
}

/**
 * The size a project's boxes should be, from its turns in the last 14 days, the biggest of:
 * - memory: the smallest size whose RAM is at least 1.25 × the peak;
 * - disk: the smallest whose work disk is at least 1.25 × the most it had in use;
 * - CPU: what the median run needs to stay under 90% of its cores for half its minutes (a busy minute alone doesn't
 *   count: bigger boxes cost more per core-hour);
 * - out of memory: one size above a box any of its turns ran out of memory on, from the first such turn.
 * The rest count from 3 measured runs. The pick is held to `maxSize` (Settings › Max size it may choose).
 */
export function pickAutoSize(peaks: TurnPeak[], opts: { maxSize: BoxSize; now?: number; diskTotal?: (size: BoxSize) => number | null }): AutoBoxSize {
  const since = (opts.now ?? Date.now()) - AUTO_SIZE_WINDOW_MS
  const recent = peaks.filter((p) => p.at >= since)
  const measured = recent.filter((p) => p.memPeakBytes !== null)
  const memPeak = peakOf(measured.map((p) => p.memPeakBytes))
  const cpuPeak = peakOf(recent.map((p) => p.cpuPeakCores))
  const diskPeak = peakOf(recent.map((p) => p.diskPeakBytes))

  const picks: { size: BoxSize; basis: AutoSizeBasis }[] = []
  if (measured.length >= AUTO_SIZE_MIN_RUNS) {
    picks.push({ size: smallestWith(memPeak! * AUTO_SIZE_HEADROOM, (s) => BOX_SIZE_SPECS[s].ramGb * 1024 ** 3), basis: "memory" })
    if (diskPeak !== null) picks.push({ size: smallestWith(diskPeak * AUTO_SIZE_HEADROOM, (s) => workDiskBytes(s, opts.diskTotal?.(s))), basis: "disk" })
    const needs = recent.map(cpuNeed).filter((s): s is BoxSize => s !== null)
    if (needs.length >= AUTO_SIZE_MIN_RUNS) picks.push({ size: needs.sort(compareSizes)[Math.floor((needs.length - 1) / 2)]!, basis: "cpu" })
  }
  for (const p of recent) if (p.oom) picks.push({ size: next(p.boxSize), basis: "out-of-memory" })

  let size: BoxSize | null = null
  let basis: AutoSizeBasis | null = null
  for (const p of picks) {
    if (!size || compareSizes(p.size, size) > 0) {
      size = p.size
      basis = p.basis
    }
  }
  const capped = Boolean(size && compareSizes(size, opts.maxSize) > 0)
  if (capped) size = opts.maxSize
  return { size, runs: measured.length, memPeakBytes: memPeak, cpuPeakCores: cpuPeak, diskPeakBytes: diskPeak, basis, capped, label: autoSizeLabel(size, measured.length, memPeak, basis, capped) }
}

const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`
const BASIS_WHY: Record<AutoSizeBasis, string> = {
  memory: "",
  disk: "; for its disk use",
  cpu: "; its runs kept their CPU busy",
  "out-of-memory": "; a turn ran out of memory on a smaller box",
}

/**
 * "medium (peak 5.1 GB over 12 runs)", "medium (a turn ran out of memory on a smaller box)", "not measured yet (1 of 3
 * runs)". `capped`: "…; held to the max size".
 */
export function autoSizeLabel(size: BoxSize | null, n: number, memPeak: number | null, basis: AutoSizeBasis | null, capped = false): string {
  if (!size) return `not measured yet (${n} of ${AUTO_SIZE_MIN_RUNS} runs)`
  const cap = capped ? "; held to the max size" : ""
  if (n < AUTO_SIZE_MIN_RUNS || memPeak === null) return `${size} (a turn ran out of memory on a smaller box${cap})`
  return `${size} (peak ${formatBytes(memPeak)} over ${runs(n)}${basis ? BASIS_WHY[basis] : ""}${cap})`
}
