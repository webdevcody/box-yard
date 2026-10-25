// Notices when the computer running Box Yard slept (a laptop lid closed), so a local-runner turn that sleep broke
// resumes on wake instead of failing (issue #104). While a Mac or Linux machine sleeps the wall clock keeps going but
// Node's monotonic clock (performance.now: mach_absolute_time / CLOCK_MONOTONIC) stands still, so the wall clock
// running ahead of it between two looks is time asleep. It needs no timer to see one: any look after waking does.

import { performance } from "node:perf_hooks"

export interface SleepClock {
  wall(): number
  mono(): number
}

const SYSTEM_CLOCK: SleepClock = { wall: () => Date.now(), mono: () => performance.now() }

/** One sleep: somewhere after `from` the computer slept for `ms`, and it was awake again by `to` (wall clock). */
export interface SleepGap {
  from: number
  to: number
  ms: number
}

/** Smaller drifts are clock adjustments (NTP) or a busy event loop, not sleep. */
const MIN_GAP_MS = 20_000
/** Gaps are only asked about for turns and starts, which are hours at most. */
const KEEP_MS = 48 * 3600_000

export class SleepWatch {
  /** When it started looking (wall clock): sleeps before this aren't known. */
  readonly since: number
  private lastWall: number
  private lastMono: number
  private readonly gaps: SleepGap[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly clock: SleepClock = SYSTEM_CLOCK,
    private readonly minGapMs = MIN_GAP_MS,
  ) {
    this.lastWall = clock.wall()
    this.lastMono = clock.mono()
    this.since = this.lastWall
  }

  /** Look now: the sleep since the last look, if there was one. */
  check(): SleepGap | null {
    const wall = this.clock.wall()
    const mono = this.clock.mono()
    const slept = wall - this.lastWall - (mono - this.lastMono)
    const from = this.lastWall
    this.lastWall = wall
    this.lastMono = mono
    if (slept < this.minGapMs) return null
    return this.record(from, wall, slept)
  }

  /** Note a sleep seen some other way (the runner's own clocks, tests). */
  record(from: number, to: number, ms = to - from): SleepGap {
    const gap = { from, to, ms }
    this.gaps.push(gap)
    const cutoff = to - KEEP_MS
    while (this.gaps.length && this.gaps[0]!.to < cutoff) this.gaps.shift()
    return gap
  }

  /** Time asleep in sleeps that overlap `from`..`to` (wall clock; `to` defaults to now). Looks first. */
  sleptBetween(from: number, to?: number): number {
    this.check()
    const end = to ?? this.clock.wall()
    return this.gaps.filter((g) => g.to > from && g.from < end).reduce((n, g) => n + g.ms, 0)
  }

  /** Look every `everyMs` too, so a sleep is logged near when it ended even with nothing running. */
  start(everyMs = 5_000, onSleep?: (gap: SleepGap) => void) {
    if (this.timer) return
    this.timer = setInterval(() => {
      const gap = this.check()
      if (gap && onSleep) onSleep(gap)
    }, everyMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** "45s", "12 min", "3.5 h": how long a sleep lasted, for task logs and prompts. */
export function sleepLength(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 360_000) / 10} h`
}
