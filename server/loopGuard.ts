export interface LoopGuardOptions {
  /** How often the same task update may wake a Captain within `windowMs` before more of it counts as a loop. */
  maxRepeats: number
  windowMs: number
  /** The first throttle. Each further loop in a row doubles it, up to `maxThrottleMs`. */
  throttleMs: number
  maxThrottleMs: number
}

export const DEFAULT_LOOP_GUARD: LoopGuardOptions = {
  maxRepeats: 3,
  windowMs: 2 * 60 * 60_000,
  throttleMs: 5 * 60_000,
  maxThrottleMs: 60 * 60_000,
}

/** `started` is true only for the wake that turned the throttle on, so the caller reports it once. */
export type WakeDecision = { wake: true } | { wake: false; until: number; started: boolean }

const fingerprint = (notice: string) => notice.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Decides whether a batch of unseen task updates may wake a Captain unattended.
 *
 * It never drops anything: a refused batch stays queued and goes out with the next wake. It only
 * refuses a real loop, where every update in the batch is one the Captain already woke up for
 * `maxRepeats` times recently (say a task it keeps retrying fails the same way). Any new update
 * lifts the throttle at once; otherwise the queued batch is let through when the throttle ends.
 */
export class WakeLoopGuard {
  private readonly seen = new Map<string, number[]>()
  private strikes = 0
  private until: number | null = null

  constructor(
    private readonly opts: LoopGuardOptions = DEFAULT_LOOP_GUARD,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the current throttle ends, or null when not throttled. */
  get throttledUntil() {
    return this.until
  }

  check(notices: string[]): WakeDecision {
    const now = this.now()
    this.prune(now)
    const fresh = notices.some((n) => (this.seen.get(fingerprint(n))?.length ?? 0) < this.opts.maxRepeats)
    if (this.until !== null) {
      if (!fresh && now < this.until) return { wake: false, until: this.until, started: false }
      this.until = null
      if (fresh) this.strikes = 0
      return { wake: true }
    }
    if (fresh) {
      this.strikes = 0
      return { wake: true }
    }
    this.strikes++
    this.until = now + Math.min(this.opts.throttleMs * 2 ** (this.strikes - 1), this.opts.maxThrottleMs)
    return { wake: false, until: this.until, started: true }
  }

  /** Remember the updates an unattended wake just handled. */
  record(notices: string[]) {
    const now = this.now()
    for (const n of notices) {
      const key = fingerprint(n)
      this.seen.set(key, [...(this.seen.get(key) ?? []), now])
    }
  }

  /** Cody or the Coordinator stepped in: lift any throttle (the history stays, so a loop that goes on is caught again). */
  reset() {
    this.strikes = 0
    this.until = null
  }

  private prune(now: number) {
    for (const [key, times] of this.seen) {
      const recent = times.filter((t) => now - t < this.opts.windowMs)
      if (recent.length) this.seen.set(key, recent)
      else this.seen.delete(key)
    }
  }
}
