import type { Store, TaskRow } from "./store.js"
import type { PrState, TaskStatus } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"

/**
 * Live pull request state. Every task with a PR that isn't merged or closed yet, in any status, is polled
 * about once a minute with one batched GraphQL query per token (up to PR_BATCH PRs each), so a
 * PR merged by someone else (Cody, the PR Merger schedule) moves its task from pr_ready to done.
 * Before the Coordinator or a Captain is told a PR's state (list_inbox, get_task, list_tasks), any state
 * older than PR_REPORT_FRESH_MS is asked again (ensureFresh), so a missed poll never reaches Cody as
 * "waiting on you".
 *
 * Rate limits: GitHub's GraphQL budget is 5,000 points an hour per token, and a query like this
 * costs 1 point however many PRs it asks about (up to 100 nodes). At one round a minute that is
 * 60 points an hour for up to 50 open PRs, about 1% of the budget. Batches run one at a time
 * (no concurrent requests, per GitHub's secondary limits). Each token backs off on its own: errors
 * back off exponentially up to 15 minutes, and polling pauses until the reset when fewer than
 * RATE_FLOOR points are left (agents push and open PRs with the same token). One project's broken or
 * rate-limited token never holds back another project's PRs.
 */

export const PR_POLL_MS = 60_000
export const PR_MAX_BACKOFF_MS = 15 * 60_000
export const PR_BATCH = 50
export const RATE_FLOOR = 200
/** How long a turn waits for GitHub before it starts with Box Yard's last known PR state instead. */
export const PR_LIVE_TIMEOUT_MS = 4_000
/** A PR state Box Yard checked this recently is used as is when a turn starts. */
export const PR_LIVE_FRESH_MS = 30_000
/** A PR state older than this is asked from GitHub again before an MCP tool reports it. */
export const PR_REPORT_FRESH_MS = 2 * 60_000
/** How long an MCP tool waits for that answer before it reports the last known state, marked unverified. */
export const PR_REPORT_TIMEOUT_MS = 5_000

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

/** A task's PR as a turn starts (PrTracker.live), for the PR line in the turn's prompt. */
export interface LivePr {
  url: string
  number: number | null
  state: PrState | null
  mergedAt: number | null
  mergedBy: string | null
  headSha: string | null
  /** When GitHub last answered about it (this server's life only), or null. */
  checkedAt: number | null
  /**
   * `github`: asked just now. `fresh`: checked within PR_LIVE_FRESH_MS, or merged (final). `fallback`: GitHub didn't
   * answer in time (or can't be asked: no token, rate limit), so it's Box Yard's last known state.
   */
  source: "github" | "fresh" | "fallback"
}

/** What Box Yard knows about how current a task's PR state is (this server's life only). */
export interface PrCheck {
  /** When GitHub last answered about the PR, or null. */
  checkedAt: number | null
  /** Why the last try didn't get an answer (no token, the token can't see the repo, rate limit, ...), or null. */
  error: string | null
}

/** One token's health: it backs off and pauses on its own, so it never holds back another token's PRs. */
export interface TokenHealth {
  /** Rounds in a row that hit an error; the wait before the next scheduled try doubles with each. */
  failures: number
  /** No scheduled round asks with this token before then (error backoff). On-demand checks still do. */
  retryAt: number
  /** Nothing asks with this token before then (rate limit, or the budget ran low). */
  pausedUntil: number
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
  /** Settings › Coordinator › Done when its PR merges (default on, as when it wasn't a setting). */
  autoDone?: () => boolean
  log?: (message: string) => void
}

/** The statuses a merged PR moves to done when Settings' autoDoneOnMerge is on: the task's turn is over and nothing waits on Cody. */
export const AUTO_DONE_FROM: readonly TaskStatus[] = ["pr_ready", "idle"]

/** What a PR now in `state` does to a task's status: null leaves it alone. */
export function restingStatus(row: Pick<TaskRow, "status" | "current_turn_id">, state: PrState, autoDone: boolean): TaskStatus | null {
  if (row.current_turn_id) return null
  if (state === "merged") {
    if (autoDone) return AUTO_DONE_FROM.includes(row.status) ? "done" : null
    return row.status === "pr_ready" ? "idle" : null
  }
  if (state === "closed" && row.status === "pr_ready") return "idle"
  return null
}

/** owner, repo name and number of a github.com pull request URL. */
export function parsePrUrl(url: string | null | undefined): { owner: string; name: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url ?? "")
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null
}

export const prNumber = (url: string | null | undefined) => parsePrUrl(url)?.number ?? null

/** The wait before a token that failed `failures` times in a row is tried again on schedule. */
export const backoffMs = (intervalMs: number, failures: number) => Math.min(intervalMs * 2 ** Math.min(failures, 10), PR_MAX_BACKOFF_MS)

class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit; paused until ${new Date(until).toISOString()}`)
  }
}

/** GitHub's answer about one PR of a batch: its state, or why there is none. */
interface PrAnswer {
  info: PrInfo | null
  error: string | null
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
  /** GraphQL requests sent so far. */
  requests = 0
  /** Per token (in memory only, like the token itself). */
  private readonly health = new Map<string, TokenHealth>()
  /** When GitHub last answered about each task's PR, and why the last try didn't. */
  private readonly checks = new Map<string, PrCheck>()
  /** Tasks whose current PR error was logged already, so a PR the token can't see logs once, not every minute. */
  private readonly logged = new Map<string, string>()

  constructor(deps: PrTrackerDeps) {
    this.deps = deps
    this.store = deps.store
    this.fetch = deps.fetch ?? ((...args) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
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

  /** A token's health (a fresh record for a token not used yet). */
  tokenHealth(token: string): TokenHealth {
    let h = this.health.get(token)
    if (!h) this.health.set(token, (h = { failures: 0, retryAt: 0, pausedUntil: 0 }))
    return h
  }

  /** What Box Yard knows about how current a task's PR state is. */
  prCheck(taskId: string): PrCheck {
    return this.checks.get(taskId) ?? { checkedAt: null, error: null }
  }

  /**
   * The computer woke from sleep (or the network came back): forget error backoffs, which a sleeping laptop's failed
   * requests piled up, and poll now. Rate limit pauses stay, since GitHub set them.
   */
  wake() {
    for (const h of this.health.values()) {
      h.failures = 0
      h.retryAt = 0
    }
    this.arm(0)
  }

  private arm(delay: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      // Every interval: a token that is backing off or paused is skipped inside the round, the others are asked.
      void this.pollAll().finally(() => this.arm(this.intervalMs))
    }, delay)
    this.timer.unref?.()
  }

  /** One round over every PR that may still change. Merged and closed PRs are never asked about again. */
  pollAll(): Promise<void> {
    return this.exclusive(() => this.poll(this.store.listOpenPrRows(), true))
  }

  /**
   * Before a PR state is reported (list_inbox, get_task, list_tasks): ask GitHub about every PR of these tasks (all
   * tasks when null) that may still change and wasn't answered within maxAgeMs, in one batched query per token. Waits
   * at most timeoutMs and never throws; a PR it couldn't confirm keeps its last known state, and prCheck() says why.
   */
  async ensureFresh(taskIds: string[] | null, opts: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const maxAge = opts.maxAgeMs ?? PR_REPORT_FRESH_MS
    const stale = () =>
      this.store.listOpenPrRows(taskIds ?? undefined).filter((r) => {
        const at = this.checks.get(r.id)?.checkedAt
        return at == null || this.now() - at >= maxAge
      })
    if (this.stopped || !stale().length) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.timeoutMs ?? PR_REPORT_TIMEOUT_MS)))
    // Picked again once its turn comes: the round before it may have answered some of them already.
    await Promise.race([this.exclusive(() => this.poll(stale(), false)).catch(() => {}), timeout])
    clearTimeout(timer)
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

  /**
   * A task's PR as a turn starts: a state Box Yard checked moments ago (or a merged one, which is final) as is,
   * else asked from GitHub with a short timeout, else the last known state. Never throws and never waits longer
   * than timeoutMs, so a slow or unreachable GitHub doesn't hold the turn up. Null when the task has no PR.
   */
  async live(taskId: string, opts: { timeoutMs?: number; freshMs?: number } = {}): Promise<LivePr | null> {
    const row = this.store.getTaskRow(taskId)
    if (!row?.pr_url) return null
    const checked = this.checks.get(taskId)?.checkedAt ?? null
    const fresh = row.pr_state === "merged" || (checked !== null && this.now() - checked < (opts.freshMs ?? PR_LIVE_FRESH_MS))
    let source: LivePr["source"] = fresh ? "fresh" : "fallback"
    if (!fresh) {
      const asked = this.now()
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.timeoutMs ?? PR_LIVE_TIMEOUT_MS)))
      await Promise.race([this.check(taskId).catch(() => null), timeout])
      clearTimeout(timer)
      if ((this.checks.get(taskId)?.checkedAt ?? 0) >= asked) source = "github"
    }
    const now = this.store.getTaskRow(taskId)
    if (!now?.pr_url) return null
    return {
      url: now.pr_url,
      number: prNumber(now.pr_url),
      state: now.pr_state,
      mergedAt: now.pr_merged_at,
      mergedBy: now.pr_merged_by,
      headSha: now.pr_head_sha,
      checkedAt: this.checks.get(taskId)?.checkedAt ?? null,
      source,
    }
  }

  /** Requests run one after another, never in parallel. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * A try about a task's PR got no answer: keep the last known state and say why. `log`: for an answer about this PR
   * alone (a token that can't see its repo), once per reason; a whole request that failed is logged per token instead.
   */
  private missed(row: TaskRow, error: string, log = false) {
    const prev = this.checks.get(row.id)
    this.checks.set(row.id, { checkedAt: prev?.checkedAt ?? null, error })
    if (!log || this.logged.get(row.id) === error) return
    this.logged.set(row.id, error)
    this.deps.log?.(`[box-yard] Can't check PR ${row.pr_url} (task ${row.id}): ${error}`)
  }

  /**
   * Ask about these rows, one batched query per token. A scheduled round skips a token that is backing off after
   * errors; any round skips one that is rate limited. Either way the other tokens are still asked.
   */
  private async poll(rows: TaskRow[], scheduled: boolean) {
    if (this.stopped || !rows.length) return
    const byToken = new Map<string, TaskRow[]>()
    for (const row of rows) {
      if (!parsePrUrl(row.pr_url)) {
        this.missed(row, "not a github.com pull request URL", true)
        continue
      }
      const token = this.deps.token(row.project_id)
      if (!token) {
        this.missed(row, "no GitHub token for this project")
        continue
      }
      byToken.set(token, [...(byToken.get(token) ?? []), row])
    }
    for (const [token, list] of byToken) {
      const h = this.tokenHealth(token)
      if (this.now() < h.pausedUntil) {
        for (const row of list) this.missed(row, `GitHub rate limit; paused until ${new Date(h.pausedUntil).toISOString()}`)
        continue
      }
      if (scheduled && this.now() < h.retryAt) continue
      for (let i = 0; i < list.length; i += PR_BATCH) {
        const batch = list.slice(i, i + PR_BATCH)
        try {
          const answers = await this.query(token, h, batch)
          batch.forEach((row, j) => {
            const { info, error } = answers[j] ?? { info: null, error: null }
            if (!info) return this.missed(row, error ?? "GitHub returned no pull request", true)
            this.checks.set(row.id, { checkedAt: this.now(), error: null })
            this.logged.delete(row.id)
            this.apply(row.id, row.pr_url!, info)
          })
          if (h.failures) this.deps.log?.("[box-yard] PR status checks are working again.")
          h.failures = 0
          h.retryAt = 0
        } catch (err) {
          for (const row of batch) this.missed(row, errorMessage(err))
          if (err instanceof RateLimited) {
            if (h.pausedUntil < err.until) this.deps.log?.(`[box-yard] PR status checks paused for one token: ${errorMessage(err)}`)
            h.pausedUntil = Math.max(h.pausedUntil, err.until)
          } else {
            if (h.failures === 0) this.deps.log?.(`[box-yard] PR status check failed, backing off: ${errorMessage(err)}`)
            h.failures++
            h.retryAt = this.now() + backoffMs(this.intervalMs, h.failures)
          }
          // This token's other batches wait for its next try; other tokens go on.
          for (const row of list.slice(i + PR_BATCH)) this.missed(row, errorMessage(err))
          break
        }
      }
    }
  }

  /** One GraphQL request for a batch of PRs; entry i is PR i's state, or why GitHub didn't return it. */
  private async query(token: string, h: TokenHealth, rows: TaskRow[]): Promise<PrAnswer[]> {
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
      errors?: { type?: string; message?: string; path?: (string | number)[] }[]
    }
    const limit = body.data?.rateLimit
    const resetAt = limit?.resetAt ? Date.parse(limit.resetAt) : NaN
    if (body.errors?.some((e) => e.type === "RATE_LIMITED")) throw new RateLimited(Number.isFinite(resetAt) ? resetAt : this.now() + 60_000)
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub GraphQL returned no data")
    // Leave headroom for agents using the same token.
    if (typeof limit?.remaining === "number" && limit.remaining < RATE_FLOOR && Number.isFinite(resetAt)) h.pausedUntil = resetAt
    // A missing repo or PR (or one the token can't see: GitHub says NOT_FOUND for those too) comes back as null next
    // to an error for that field; the others still count.
    return rows.map((_, i) => {
      const pr = body.data?.[`p${i}`]?.pullRequest
      const info = pr ? toInfo(pr) : null
      if (info) return { info, error: null }
      const e = body.errors?.find((x) => x.path?.[0] === `p${i}`)
      const error = e
        ? `${e.type === "NOT_FOUND" ? "this project's GitHub token can't see it (or it doesn't exist)" : "GitHub said no"}: ${e.type ? `${e.type} ` : ""}${e.message ?? ""}`.trim()
        : null
      return { info: null, error }
    })
  }

  /**
   * Save a PR's state. A merged PR moves a resting task (pr_ready or idle, its turn over) to done, or with
   * Settings' autoDoneOnMerge off a pr_ready one to idle; a closed one drops a pr_ready task back to idle.
   * Any other status (working, needs input, waiting, failed, ...) is left alone. Merges seen live notify Cody;
   * the first check of an old PR (the startup backfill) doesn't.
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
    const status = restingStatus(row, info.state, this.deps.autoDone?.() ?? true)
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
