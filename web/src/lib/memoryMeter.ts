// Memory and load display for the Boxes page (box rows and details).
import { loadLine, memLine } from "../../../shared/memory"
import type { BoxInfo } from "../../../shared/types"

/** Above this share of memory in use, the meter turns red. */
export const CRITICAL_MEMORY_RATIO = 0.95

export interface MemoryMeter {
  used: number
  total: number
  /** 0..1 of the memory in use. */
  usedRatio: number
  /** "1.4 GB of 4 GB memory in use (35%)". */
  label: string
  /** "load 0.80 on 2 CPUs", or null when the probe didn't say. */
  load: string | null
  /** Why placement skips the box for new agents (the server's call), or null. */
  busy: string | null
  tone: "ok" | "warn" | "error"
  /** Everything above in one line, for title tooltips. */
  title: string
}

type MemoryBox = Pick<BoxInfo, "memUsedBytes" | "memTotalBytes" | "loadAvg" | "cpuCount" | "memoryPressure">

/** The box's memory and load from its last probe, or null before the first one. */
export function memoryMeter(box: MemoryBox): MemoryMeter | null {
  const used = box.memUsedBytes ?? null
  const total = box.memTotalBytes ?? null
  if (used === null || total === null || total <= 0) return null
  const usedRatio = Math.min(1, used / total)
  const label = memLine({ usedBytes: used, totalBytes: total })
  const load = box.loadAvg === null || box.loadAvg === undefined ? null : loadLine({ load1: box.loadAvg, cpus: box.cpuCount ?? 1 })
  const busy = box.memoryPressure ?? null
  const tone = usedRatio >= CRITICAL_MEMORY_RATIO ? "error" : busy ? "warn" : "ok"
  const title = [`Memory: ${label}`, load, busy ? `New tasks go to other boxes while tasks run here: ${busy}` : null].filter(Boolean).join("\n")
  return { used, total, usedRatio, label, load, busy, tone, title }
}

/** "35% mem" for the row cell. */
export const memoryShort = (m: Pick<MemoryMeter, "usedRatio">) => `${Math.round(m.usedRatio * 100)}% mem`
