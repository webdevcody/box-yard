/**
 * Throttles password guesses. Only failures count, so logging in from your own devices never trips it: a few
 * wrong tries are free, then each one waits longer (1 s, 2 s, 4 s … 30 s), and about 10 in the window lock that
 * client out for a while. A success clears the client's slate. Blocked attempts aren't checked at all, so a locked
 * client can't learn whether a guess was right.
 */
export type LimitOptions = {
  /** Failures older than this are forgotten. */
  windowMs: number
  /** Failures before any waiting starts. */
  freeFailures: number
  /** The wait after the first failure past the free ones; it doubles from there. */
  baseDelayMs: number
  maxDelayMs: number
  /** Failures in the window that lock the client out, and for how long. */
  lockAfter: number
  lockMs: number
  /** Clients remembered at once; the stalest are dropped past this, so made-up addresses can't fill memory. */
  maxClients: number
}

export const CLIENT_LIMITS: LimitOptions = {
  windowMs: 15 * 60_000,
  freeFailures: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  lockAfter: 10,
  lockMs: 15 * 60_000,
  maxClients: 10_000,
}

export type Blocked = { retryAfterMs: number; locked: boolean; message: string }

type Entry = { failures: number[]; lockedUntil: number }

export class LoginLimiter {
  private clients = new Map<string, Entry>()

  constructor(
    readonly opts: LimitOptions = CLIENT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether `key` may try a password now, or how long it must wait. */
  blocked(key: string): Blocked | null {
    const e = this.entry(key)
    if (!e) return null
    const now = this.now()
    if (e.lockedUntil > now) return blocked(e.lockedUntil - now, true)
    const wait = this.delayAfter(e.failures.length)
    const last = e.failures.at(-1)
    if (wait && last !== undefined && now < last + wait) return blocked(last + wait - now, false)
    return null
  }

  /** A wrong password from `key`. Returns the block it now has (the lockout, on the failure that triggers it). */
  fail(key: string): { failures: number; blocked: Blocked | null } {
    const now = this.now()
    const e = this.entry(key) ?? { failures: [], lockedUntil: 0 }
    e.failures.push(now)
    if (e.failures.length >= this.opts.lockAfter) e.lockedUntil = now + this.opts.lockMs
    // Map order is insertion order: re-inserting keeps the most recently failing clients at the end.
    this.clients.delete(key)
    this.clients.set(key, e)
    while (this.clients.size > this.opts.maxClients) this.clients.delete(this.clients.keys().next().value!)
    return { failures: e.failures.length, blocked: this.blocked(key) }
  }

  /** The right password: forget the client's failures. */
  succeed(key: string) {
    this.clients.delete(key)
  }

  /** Failures in the window for `key` (0 once a lockout ends). */
  failures(key: string) {
    return this.entry(key)?.failures.length ?? 0
  }

  private delayAfter(failures: number) {
    if (failures < this.opts.freeFailures) return 0
    return Math.min(this.opts.baseDelayMs * 2 ** (failures - this.opts.freeFailures), this.opts.maxDelayMs)
  }

  /** The live entry for `key`, after dropping failures past the window; a lockout that ended starts it over. */
  private entry(key: string): Entry | undefined {
    const e = this.clients.get(key)
    if (!e) return undefined
    const now = this.now()
    if (e.lockedUntil && e.lockedUntil <= now) {
      this.clients.delete(key)
      return undefined
    }
    if (!e.lockedUntil) e.failures = e.failures.filter((t) => t > now - this.opts.windowMs)
    if (!e.failures.length) {
      this.clients.delete(key)
      return undefined
    }
    return e
  }
}

function blocked(ms: number, locked: boolean): Blocked {
  return { retryAfterMs: ms, locked, message: `Too many attempts, try again in ${waitText(ms)}.` }
}

/** "1 minute", "15 minutes", "8 seconds": rounded up, so it's never too early. */
export function waitText(ms: number) {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`
  const m = Math.ceil(ms / 60_000)
  return `${m} minute${m === 1 ? "" : "s"}`
}

/**
 * The same, per connecting address. A client's own key comes from X-Forwarded-For, which a direct client can make
 * up, so this catches one address cycling through made-up ones. Behind a proxy every client shares the proxy's
 * address, so it's set high enough that only a sustained attack reaches it.
 */
export const PEER_LIMITS: LimitOptions = { ...CLIENT_LIMITS, freeFailures: 20, maxDelayMs: 5000, lockAfter: 100, maxClients: 1000 }
