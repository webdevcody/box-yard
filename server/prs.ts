import type { Store, TaskRow } from "./store.js"
import type { PrState, TaskStatus } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"

/**
 * Live pull request state. Every task with a PR that isn't merged or closed yet is polled
 * about once a minute with one batched GraphQL query per token (up to PR_BATCH PRs each), so a
 * PR merged by someone else (Cody, the PR Merger schedule) moves its task from pr_ready to done.
 *
 * Rate limits: GitHub's GraphQL budget is 5,000 points an hour per token, and a query like this
 * costs 1 point however many PRs it asks about (up to 100 nodes). At one round a minute that is
 * 60 points an hour for up to 50 open PRs, about 1% of the budget. Batches run one at a time
 * (no concurrent requests, per GitHub's secondary limits), errors back off exponentially up to
 * 15 minutes, and polling pauses until the reset when fewer than RATE_FLOOR points are left,
 * since agents push and open PRs with the same token.
 */

export const PR_POLL_MS = 60_000
export const PR_MAX_BACKOFF_MS = 15 * 60_000
export const PR_BATCH = 50
export const RATE_FLOOR = 200

export interface PrInfo {
  state: PrState
  mergedAt: number | null
  mergedBy: string | null
  /** The head commit and label names, for hooks (left as they were when GitHub didn't say). */
  headSha?: string | null
  labels?: string[]
}

export interface PrChange {
  taskId: string
  prev: PrState | null
  info: PrInfo
  /** The task's new status when the PR moved it (pr_ready → done or idle). */
  status: TaskStatus | null
}

export interface PrTrackerDeps {
  store: Store
  /** The GitHub token for a project's PRs, or null to leave them alone (mock mode, no token). */
  token: (projectId: string) => string | null
  fetch?: typeof fetch
  now?: () => number
  intervalMs?: number
  /** After a task's PR state changed (and maybe its status); the task is already saved. */
  onChange?: (change: PrChange) => void
  log?: (message: string) => void
}

/** owner, repo name and number of a github.com pull request URL. */
export function parsePrUrl(url: string | null | undefined): { owner: string; name: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url ?? "")
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null
}

export const prNumber = (url: string | null | undefined) => parsePrUrl(url)?.number ?? null

class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit; paused until ${new Date(until).toISOString()}`)
  }
}

interface GqlPr {
  state?: "OPEN" | "CLOSED" | "MERGED"
  isDraft?: boolean
  mergedAt?: string | null
  mergedBy?: { login?: string } | null
  headRefOid?: string | null
  labels?: { nodes?: ({ name?: string } | null)[] | null } | null
}

const toInfo = (pr: GqlPr): PrInfo | null => {
  const state: PrState | null =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : null
  if (!state) return null
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
  const labels = Array.isArray(pr.labels?.nodes) ? pr.labels.nodes.map((l) => l?.name).filter((n): n is string => typeof n === "string") : undefined
  return {
    state,
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
    mergedBy: pr.mergedBy?.login ?? null,
    ...(typeof pr.headRefOid === "string" ? { headSha: pr.headRefOid } : {}),
    ...(labels ? { labels } : {}),
  }
}

export class PrTracker {
  private readonly store: Store
  private readonly deps: PrTrackerDeps
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private soonTimer: NodeJS.Timeout | null = null
  private soon = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  /** Rounds in a row that hit an error; the poll interval doubles with each. */
  failures = 0
  pausedUntil = 0
  /** GraphQL requests sent so far. */
  requests = 0

  constructor(deps: PrTrackerDeps) {
    this.deps = deps
    this.store = deps.store
    this.fetch = deps.fetch ?? ((...args) => fetch(...args))
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? PR_POLL_MS
  }

  /** Backfill right away (existing tasks), then poll every interval. */
  start() {
    this.stopped = false
    this.arm(0)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.timer = this.soonTimer = null
  }

  /** Time to the next round: the interval, doubled per failure (capped), or until a rate limit resets. */
  nextDelay(): number {
    const backoff = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 10), PR_MAX_BACKOFF_MS)
    return Math.max(this.failures ? backoff : this.intervalMs, this.pausedUntil - this.now())
  }

  private arm(delay: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pollAll().finally(() => this.arm(this.nextDelay()))
    }, delay)
    this.timer.unref?.()
  }

  /** One round over every PR that may still change. Merged and closed PRs are never asked about again. */
  pollAll(): Promise<void> {
    return this.exclusive(() => this.poll(this.store.listOpenPrRows(), true))
  }

  /** Check a task's PR shortly (an agent just opened or pushed to it). Calls within the delay share one request. */
  refresh(taskId: string, delayMs = 2_000) {
    if (this.stopped) return
    this.soon.add(taskId)
    if (this.soonTimer) return
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      const ids = [...this.soon]
      this.soon.clear()
      void this.exclusive(() => this.poll(this.store.listOpenPrRows(ids), false))
    }, delayMs)
    this.soonTimer.unref?.()
  }

  /**
   * Ask GitHub about one task's PR now and save the answer (used when a turn ends). Unlike the poll, this also
   * re-checks a closed PR, since the agent may have reopened it. Null when it can't tell.
   */
  async check(taskId: string): Promise<PrState | null> {
    const row = this.store.getTaskRow(taskId)
    if (!row?.pr_url) return null
    if (row.pr_state === "merged") return "merged"
    await this.exclusive(() => this.poll([row], false))
    const after = this.store.getTaskRow(taskId)
    return after?.pr_url === row.pr_url ? (after.pr_state ?? null) : null
  }

  /** Requests run one after another, never in parallel. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private async poll(rows: TaskRow[], scheduled: boolean) {
    if (this.stopped || !rows.length || this.now() < this.pausedUntil) return
    const byToken = new Map<string, TaskRow[]>()
    for (const row of rows) {
      const token = parsePrUrl(row.pr_url) ? this.deps.token(row.project_id) : null
      if (!token) continue
      byToken.set(token, [...(byToken.get(token) ?? []), row])
    }
    let failed = false
    round: for (const [token, list] of byToken) {
      for (let i = 0; i < list.length; i += PR_BATCH) {
        const batch = list.slice(i, i + PR_BATCH)
        try {
          const infos = await this.query(token, batch)
          batch.forEach((row, j) => {
            const info = infos[j]
            if (info) this.apply(row.id, row.pr_url!, info)
          })
        } catch (err) {
          failed = true
          if (scheduled && this.failures === 0) this.deps.log?.(`[box-yard] PR status check failed, backing off: ${errorMessage(err)}`)
          if (err instanceof RateLimited) {
            this.pausedUntil = Math.max(this.pausedUntil, err.until)
            break round
          }
        }
      }
    }
    if (!scheduled) return
    if (failed) this.failures++
    else {
      if (this.failures) this.deps.log?.("[box-yard] PR status checks are working again.")
      this.failures = 0
    }
  }

  /** One GraphQL request for a batch of PRs; entry i is PR i's state, or null if GitHub didn't return it. */
  private async query(token: string, rows: TaskRow[]): Promise<(PrInfo | null)[]> {
    const variables: Record<string, string | number> = {}
    const defs: string[] = []
    const fields: string[] = []
    rows.forEach((row, i) => {
      const pr = parsePrUrl(row.pr_url)!
      Object.assign(variables, { [`o${i}`]: pr.owner, [`n${i}`]: pr.name, [`p${i}`]: pr.number })
      defs.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`)
      fields.push(`p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { ...pr } }`)
    })
    const query = `query(${defs.join(", ")}) { rateLimit { remaining resetAt } ${fields.join(" ")} }
fragment pr on PullRequest { state isDraft mergedAt mergedBy { login } headRefOid labels(first: 30) { nodes { name } } }`

    this.requests++
    const res = await this.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "box-yard" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"))
      const reset = Number(res.headers.get("x-ratelimit-reset"))
      if (retryAfter > 0) throw new RateLimited(this.now() + retryAfter * 1000)
      if (res.headers.get("x-ratelimit-remaining") === "0" && reset > 0) throw new RateLimited(reset * 1000)
      // A secondary limit without a hint: GitHub asks for at least a minute.
      throw new RateLimited(this.now() + 60_000)
    }
    if (!res.ok) throw new Error(`GitHub GraphQL returned HTTP ${res.status}`)
    const body = (await res.json()) as {
      data?: Record<string, { pullRequest?: GqlPr | null } | null> & { rateLimit?: { remaining?: number; resetAt?: string } }
      errors?: { type?: string; message?: string }[]
    }
    const limit = body.data?.rateLimit
    const resetAt = limit?.resetAt ? Date.parse(limit.resetAt) : NaN
    if (body.errors?.some((e) => e.type === "RATE_LIMITED")) throw new RateLimited(Number.isFinite(resetAt) ? resetAt : this.now() + 60_000)
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub GraphQL returned no data")
    // Leave headroom for agents using the same token.
    if (typeof limit?.remaining === "number" && limit.remaining < RATE_FLOOR && Number.isFinite(resetAt)) this.pausedUntil = resetAt
    // A missing repo or PR comes back as null next to an error for that field; the others still count.
    return rows.map((_, i) => {
      const pr = body.data?.[`p${i}`]?.pullRequest
      return pr ? toInfo(pr) : null
    })
  }

  /**
   * Save a PR's state. A merged PR moves a pr_ready task to done; a closed one drops it back to idle.
   * Any other status (working, needs input, ...) is left alone. Merges seen live notify Cody; the first
   * check of an old PR (the startup backfill) doesn't.
   */
  apply(taskId: string, prUrl: string, info: PrInfo) {
    const row = this.store.getTaskRow(taskId)
    if (!row || row.pr_url !== prUrl) return // the agent opened a different PR in the meantime
    const labels = info.labels ? JSON.stringify(info.labels) : row.pr_labels_json
    const headSha = info.headSha ?? row.pr_head_sha
    const same = row.pr_state === info.state && row.pr_merged_at === info.mergedAt && row.pr_merged_by === info.mergedBy
    if (same && headSha === row.pr_head_sha && labels === row.pr_labels_json) return
    if (same) {
      // Only the head commit or labels moved: save them for hooks, nothing else changed.
      this.store.updateTask(row.id, { prHeadSha: headSha, ...(info.labels ? { prLabels: info.labels } : {}) }, { quiet: true, touch: false })
      return
    }
    let status: TaskStatus | null = null
    if (row.status === "pr_ready" && !row.current_turn_id) {
      if (info.state === "merged") status = "done"
      else if (info.state === "closed") status = "idle"
    }
    const task = this.store.updateTask(
      row.id,
      { prState: info.state, prMergedAt: info.mergedAt, prMergedBy: info.mergedBy, prHeadSha: headSha, ...(info.labels ? { prLabels: info.labels } : {}), ...(status ? { status } : {}) },
      // Only a status change counts as activity; a backfilled PR state on an old task shouldn't make it "recent".
      { quiet: true, touch: Boolean(status) },
    )
    const live = row.pr_state === "open" || row.pr_state === "draft"
    if (status === "done" && live) {
      this.store.addNotification(task, `PR #${prNumber(prUrl) ?? "?"} merged${info.mergedBy ? ` by ${info.mergedBy}` : ""}`)
    }
    this.deps.onChange?.({ taskId: row.id, prev: row.pr_state, info, status })
  }
}
