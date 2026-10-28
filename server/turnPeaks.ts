// Auto-sizing's measurements (shared/autoSize.ts): what each running turn uses on its Upstash box, from the box probe
// (TaskManager.probeDisk). A reading counts for a turn only while every turn running on the box is its project's, so
// another project's build never makes this one look big. An out-of-memory kill counts for every turn running then:
// for the turn alone on the box, or for a turn among other projects' only when it failed.
import type { BoxSize } from "../shared/types.js"
import type { BoxMemory } from "../shared/memory.js"
import type { TurnPeak } from "../shared/autoSize.js"

/** A CPU rate needs this long between two readings, so one busy second isn't a busy minute. */
export const CPU_RATE_MIN_MS = 30_000

/** A turn running on the box when it was probed. */
export interface ProbedTurn {
  turnId: string
  taskId: string
  projectId: string
}

export interface ProbeReading {
  boxId: string
  boxSize: BoxSize
  memory: BoxMemory
  /** Work disk in use (df total − free). */
  diskUsedBytes: number
  /** The turns running on the box now. */
  turns: ProbedTurn[]
  /** The project whose task folders are all that's on the box, or null when there are others' too. */
  diskOwner: string | null
  now: number
}

export type MeasuredTurn = TurnPeak & { turnId: string; projectId: string; taskId: string; boxId: string }

interface Running {
  projectId: string
  taskId: string
  boxId: string
  boxSize: BoxSize
  mem: number | null
  cpu: number[]
  disk: number | null
  /** Its box's cgroup killed a process for memory while it ran alone there (with only its project's turns). */
  oomAlone: boolean
  /** ...or while other projects' turns ran there too. */
  oomShared: boolean
}

interface BoxBase {
  oomKills: number | null
  cpuUsec: number | null
  cpuAt: number
  /** The turns running at the CPU reading, and their project when it was one. */
  turnIds: Set<string>
  project: string | null
}

export class TurnMeter {
  private turns = new Map<string, Running>()
  private boxes = new Map<string, BoxBase>()

  /** The box has a reading to compare the next one with (its out-of-memory count and CPU time). */
  hasBase(boxId: string): boolean {
    return this.boxes.has(boxId)
  }

  /** One probe of a box: each running turn's peaks, the CPU rate since the last reading, and any new out-of-memory kill. */
  sample(r: ProbeReading) {
    const base = this.boxes.get(r.boxId)
    const projects = new Set(r.turns.map((t) => t.projectId))
    const solo = projects.size === 1 ? [...projects][0]! : null
    const kills = typeof r.memory.oomKills === "number" ? r.memory.oomKills : null
    const oom = kills !== null && base?.oomKills != null && kills > base.oomKills

    // Cores busy since the last reading, for the turns that ran across it with only their project's.
    const usec = typeof r.memory.cpuUsageUsec === "number" ? r.memory.cpuUsageUsec : null
    let cores: number | null = null
    let keepCpuBase = false
    if (base && usec !== null && base.cpuUsec !== null && usec >= base.cpuUsec) {
      const ms = r.now - base.cpuAt
      if (ms < CPU_RATE_MIN_MS) keepCpuBase = true
      else if (solo && base.project === solo) cores = (usec - base.cpuUsec) / (ms * 1000)
    }

    for (const t of r.turns) {
      let s = this.turns.get(t.turnId)
      if (!s) {
        s = { projectId: t.projectId, taskId: t.taskId, boxId: r.boxId, boxSize: r.boxSize, mem: null, cpu: [], disk: null, oomAlone: false, oomShared: false }
        this.turns.set(t.turnId, s)
      }
      s.boxId = r.boxId
      s.boxSize = r.boxSize
      if (oom) {
        if (solo) s.oomAlone = true
        else s.oomShared = true
      }
      if (!solo) continue
      s.mem = Math.max(s.mem ?? 0, r.memory.usedBytes)
      if (cores !== null && base!.turnIds.has(t.turnId)) s.cpu.push(cores)
      if (r.diskOwner === t.projectId) s.disk = Math.max(s.disk ?? 0, r.diskUsedBytes)
    }

    this.boxes.set(r.boxId, {
      oomKills: kills ?? base?.oomKills ?? null,
      ...(keepCpuBase ? { cpuUsec: base!.cpuUsec, cpuAt: base!.cpuAt, turnIds: base!.turnIds, project: base!.project } : { cpuUsec: usec, cpuAt: r.now, turnIds: new Set(r.turns.map((t) => t.turnId)), project: solo }),
    })
  }

  /**
   * A finished turn's measurements, forgotten here: what turn_peaks records. Null when no probe measured it.
   * `failed`: the turn failed, so a kill while other projects shared its box counts for it too. `killed`: its agent
   * was killed (exit 137, SIGKILL) on a box whose cgroup count wasn't readable.
   */
  take(turnId: string, opts: { failed: boolean; killed?: boolean; at?: number }): MeasuredTurn | null {
    const s = this.turns.get(turnId)
    this.turns.delete(turnId)
    if (!s) return null
    const oom = s.oomAlone || ((s.oomShared || Boolean(opts.killed)) && opts.failed)
    if (s.mem === null && !oom) return null
    const sorted = [...s.cpu].sort((a, b) => a - b)
    return {
      turnId,
      projectId: s.projectId,
      taskId: s.taskId,
      boxId: s.boxId,
      boxSize: s.boxSize,
      at: opts.at ?? Date.now(),
      memPeakBytes: s.mem,
      cpuPeakCores: sorted.length ? sorted[sorted.length - 1]! : null,
      cpuBusyCores: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null,
      diskPeakBytes: s.disk,
      oom,
    }
  }

  /** Forgets turns that ended without finishing (interrupted, or lost with their box): any not in `running`. */
  keepOnly(running: Set<string>) {
    for (const id of this.turns.keys()) if (!running.has(id)) this.turns.delete(id)
  }

  /** The box is gone (deleted, lost or replaced): its counts start over on the next box with that id. */
  forgetBox(boxId: string) {
    this.boxes.delete(boxId)
  }
}
