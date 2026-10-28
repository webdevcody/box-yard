// Memory and load helpers shared by the server (placement, worker prompts) and the web app (Boxes page).
import { formatBytes } from "./disk.js"

/** A box's memory and load from its last probe (memCommand, run with the df script). */
export interface BoxMemory {
  /** Memory in use, without reclaimable page cache (inactive_file), like `docker stats` and the kubelet count it. */
  usedBytes: number
  /** The cgroup's memory.max when it has one, else MemTotal. */
  totalBytes: number
  /** 1-minute load average from /proc/loadavg. */
  load1: number
  /** CPUs the load average is spread over (nproc). */
  cpus: number
  /**
   * CPU time the cgroup has used so far (cpu.stat usage_usec), in µs; absent without it. It's the box's own only on a
   * provider whose boxes are each their own cgroup (BoxProvider.ownCgroup: Upstash), which is when Box Yard meters it.
   */
  cpuUsageUsec?: number | null
  /** CPUs the cgroup may use (cpu.max quota / period); absent when unlimited or unknown. */
  cpuLimit?: number | null
}

/** Separates the memory/load part from the df lines in dfCommand's output. */
export const MEM_MARK = "@@boxyard-mem"

/**
 * Prints the cgroup v2 memory files and CPU use and limit, /proc/meminfo's totals, nproc and /proc/loadavg as `key value` lines.
 * Always exits 0: a box without some of them still reports the rest.
 */
export const memCommand = () =>
  [
    `echo ${MEM_MARK}`,
    `for f in memory.current memory.max; do [ -r /sys/fs/cgroup/$f ] && echo "$f $(cat /sys/fs/cgroup/$f)"; done`,
    `grep -s '^inactive_file ' /sys/fs/cgroup/memory.stat`,
    `grep -s '^usage_usec ' /sys/fs/cgroup/cpu.stat`,
    `[ -r /sys/fs/cgroup/cpu.max ] && echo "cpu.max $(cat /sys/fs/cgroup/cpu.max)"`,
    `grep -s -E '^(MemTotal|MemAvailable):' /proc/meminfo`,
    `echo "loadavg $(cat /proc/loadavg 2>/dev/null)"`,
    `echo "nproc $(nproc 2>/dev/null)"`,
  ].join("; ")

/**
 * The memory and load from memCommand's output (anything after MEM_MARK), or null without it. The cgroup's own
 * numbers win when it has a limit (an Upstash box is a 4/8/16 GB cgroup on a much bigger host); otherwise
 * /proc/meminfo's MemTotal - MemAvailable.
 */
export function parseMemory(stdout: string): BoxMemory | null {
  const at = stdout.indexOf(MEM_MARK)
  if (at < 0) return null
  const kv = new Map<string, string>()
  for (const line of stdout.slice(at + MEM_MARK.length).split("\n")) {
    const m = line.trim().match(/^([A-Za-z_.]+):?\s+(.*)$/)
    if (m) kv.set(m[1]!, m[2]!.trim())
  }
  const num = (k: string) => {
    const n = Number((kv.get(k) ?? "").split(/\s+/)[0])
    return kv.has(k) && Number.isFinite(n) ? n : null
  }
  const kb = (k: string) => {
    const n = num(k)
    return n === null ? null : n * 1024
  }
  const cgCurrent = num("memory.current")
  const cgMax = num("memory.max") // "max" (no limit) isn't a number
  const inactive = num("inactive_file") ?? 0
  const memTotal = kb("MemTotal")
  const memAvail = kb("MemAvailable")
  let usedBytes: number
  let totalBytes: number
  if (cgCurrent !== null && cgMax !== null && cgMax > 0 && (memTotal === null || cgMax <= memTotal)) {
    usedBytes = Math.max(0, cgCurrent - inactive)
    totalBytes = cgMax
  } else if (memTotal !== null && memAvail !== null && memTotal > 0) {
    usedBytes = Math.max(0, memTotal - memAvail)
    totalBytes = memTotal
  } else return null
  const load1 = num("loadavg")
  const cpus = num("nproc")
  const usage = num("usage_usec")
  const [quota, period] = (kv.get("cpu.max") ?? "").split(/\s+/).map(Number)
  const cpuLimit = quota && period && quota > 0 && period > 0 ? quota / period : null
  return {
    usedBytes: Math.min(usedBytes, totalBytes),
    totalBytes,
    load1: load1 ?? 0,
    cpus: cpus && cpus > 0 ? cpus : 1,
    ...(usage !== null && usage >= 0 ? { cpuUsageUsec: usage } : {}),
    ...(cpuLimit ? { cpuLimit } : {}),
  }
}

export interface MemoryPolicy {
  /** Skip a box with more than this % of its memory in use. 0 = off. */
  maxUsedPercent: number
  /** ...or with less than this much free (MB). 0 = off. */
  minFreeMb: number
  /** ...or with a 1-minute load average above this many times its CPUs. 0 = off. */
  maxLoadPerCpu: number
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { maxUsedPercent: 80, minFreeMb: 1024, maxLoadPerCpu: 2 }

/** Why a box is too busy for another agent ("3.4 GB of 4 GB memory in use (85%)"), or null when it isn't. */
export function memoryPressure(mem: BoxMemory | null | undefined, policy: MemoryPolicy): string | null {
  if (!mem || mem.totalBytes <= 0) return null
  const free = mem.totalBytes - mem.usedBytes
  const pct = (mem.usedBytes / mem.totalBytes) * 100
  if (policy.maxUsedPercent > 0 && pct > policy.maxUsedPercent) return `${memLine(mem)}, over ${policy.maxUsedPercent}%`
  if (policy.minFreeMb > 0 && free < policy.minFreeMb * 1024 * 1024) return `only ${formatBytes(Math.max(0, free))} of ${formatBytes(mem.totalBytes)} memory free`
  if (policy.maxLoadPerCpu > 0 && mem.load1 > mem.cpus * policy.maxLoadPerCpu) return `${loadLine(mem)}, over ${policy.maxLoadPerCpu}× its CPUs`
  return null
}

/** "3.4 GB of 4 GB memory in use (85%)". */
export const memLine = (mem: Pick<BoxMemory, "usedBytes" | "totalBytes">) =>
  `${formatBytes(mem.usedBytes)} of ${formatBytes(mem.totalBytes)} memory in use (${Math.round((mem.usedBytes / Math.max(1, mem.totalBytes)) * 100)}%)`

/** "load 3.20 on 2 CPUs". */
export const loadLine = (mem: Pick<BoxMemory, "load1" | "cpus">) => `load ${mem.load1.toFixed(2)} on ${mem.cpus} CPU${mem.cpus === 1 ? "" : "s"}`
