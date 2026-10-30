// What Box Yard does when a task's pull request merges, besides moving the task to done (TaskManager.prChanged):
// close the issues the PR names with GitHub's closing keywords ("Fixes #12"). GitHub does that itself only for PRs
// merged into the repo's default branch, so a PR merged into an epic branch (survive-the-night's map-4-epic) left
// its issues open. Settings › Coordinator › Close the issues it names, on by default; a project can turn it off.
//
// The work is queued in pr_issue_closes when the merge is seen, and a row leaves only once it's handled (or given up),
// so a restart picks up where it stopped. Every step is safe to repeat: only issues still open are closed.
// GitHub is asked with the project's own token (its identity's, server/turnCredentials.ts), never through the model.
import type { Store } from "./store.js"
import { parsePrUrl, prNumber } from "./prs.js"
import { errorMessage } from "./util/retry.js"

/** Tries before a merge's issue close is given up (network errors, rate limits, GitHub 5xx). */
export const ISSUE_CLOSE_ATTEMPTS = 6
const MAX_RETRY_MS = 60 * 60_000

/** One closing reference: "Fixes #12", "closes acme/site#12" or "Resolves https://github.com/acme/site/issues/12". */
export interface ClosingRef {
  /** The repo it names, "owner/name", or null for a bare "#12" (the PR's own repo). */
  repo: string | null
  number: number
}

const KEYWORDS = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved"
const REF = new RegExp(
  `\\b(?:${KEYWORDS}):?[ \\t]+(?:(?:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+))?#(\\d+)|https?://github\\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\\d+))(?![\\w/])`,
  "gi",
)

/**
 * The issues a PR's title and body close, the way GitHub reads them: one closing keyword (close, fixes, resolved…,
 * any case, an optional colon) per reference. Code blocks, inline code and HTML comments don't count. In the order
 * written, without repeats.
 */
export function closingRefs(text: string): ClosingRef[] {
  const prose = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g, "$1")
    .replace(/`[^`\n]*`/g, " ")
  const seen = new Set<string>()
  const refs: ClosingRef[] = []
  for (const m of prose.matchAll(REF)) {
    const repo = m[1] && m[2] ? `${m[1]}/${m[2]}` : m[4] && m[5] ? `${m[4]}/${m[5]}` : null
    const number = Number(m[3] ?? m[6])
    const key = `${repo?.toLowerCase() ?? ""}#${number}`
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(key)) continue
    seen.add(key)
    refs.push({ repo, number })
  }
  return refs
}

/** A GitHub REST answer that isn't a success: retried later when `retry`, else final. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retry: boolean,
  ) {
    super(message)
  }
}

/** A small GitHub REST client on a project's token. `fetch` is the GitHub seam (createBoxYard's github.fetch). */
export class GithubRest {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly token: string,
  ) {}

  async request<T>(method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "box-yard",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      throw new GithubError(`GitHub didn't answer: ${errorMessage(err)}`, 0, true)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message ?? text
        } catch {
          return text
        }
      })()
      // 403/429: rate limits (or a token without the scope, which a retry can't fix but costs little); 5xx: GitHub's own.
      throw new GithubError(`GitHub ${method} ${path} returned HTTP ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`, res.status, res.status === 403 || res.status === 429 || res.status >= 500)
    }
    const data = (await res.json().catch(() => null)) as T | null
    if (data === null) throw new GithubError(`GitHub ${method} ${path} returned no JSON`, res.status, true)
    return data
  }
}

/** A pull request as GitHub's REST API returns it (the fields used here). */
interface RestPr {
  number?: number
  title?: string | null
  body?: string | null
  state?: "open" | "closed"
  merged?: boolean
  merged_at?: string | null
  draft?: boolean
  base?: { ref?: string; repo?: { full_name?: string; default_branch?: string } | null }
}

/** An issue (or, with pull_request set, a PR) as GitHub's REST API returns it. */
interface RestIssue {
  number?: number
  state?: "open" | "closed"
  pull_request?: unknown
}

/** A PR's state from GitHub's REST API: open (or draft), closed, or merged. */
export async function restPrState(gh: GithubRest, url: string): Promise<"open" | "closed" | "merged"> {
  const pr = parsePrUrl(url)
  if (!pr) throw new GithubError(`${url} isn't a github.com pull request URL`, 0, false)
  const data = await gh.request<RestPr>("GET", `/repos/${pr.owner}/${pr.name}/pulls/${pr.number}`)
  return data.merged || data.merged_at ? "merged" : data.state === "closed" ? "closed" : "open"
}

/** What closing a merged PR's issues did, for the task's event. */
export interface IssueCloseResult {
  /** The branch it merged into. */
  base: string
  /** GitHub closes them itself: it merged into the default branch. */
  defaultBranch: boolean
  closed: number[]
  /** Named, but left alone: "#9 (already closed)", "acme/api#3 (another repo)". */
  skipped: string[]
}

/** Close the still-open, same-repo issues a merged PR names, each with a comment that links the PR. */
export async function closeNamedIssues(gh: GithubRest, prUrl: string, done: number[] = []): Promise<IssueCloseResult> {
  const pr = parsePrUrl(prUrl)
  if (!pr) throw new GithubError(`${prUrl} isn't a github.com pull request URL`, 0, false)
  const repo = `${pr.owner}/${pr.name}`
  const data = await gh.request<RestPr>("GET", `/repos/${repo}/pulls/${pr.number}`)
  const base = data.base?.ref ?? ""
  const defaultBranch = data.base?.repo?.default_branch ?? ""
  const result: IssueCloseResult = { base, defaultBranch: Boolean(base) && base === defaultBranch, closed: [], skipped: [] }
  if (!(data.merged || data.merged_at)) throw new GithubError(`PR #${pr.number} isn't merged on GitHub`, 0, false)
  if (result.defaultBranch) return result
  for (const ref of closingRefs(`${data.title ?? ""}\n\n${data.body ?? ""}`)) {
    if (ref.repo && ref.repo.toLowerCase() !== repo.toLowerCase()) {
      result.skipped.push(`${ref.repo}#${ref.number} (another repo)`)
      continue
    }
    if (ref.number === pr.number) continue
    if (done.includes(ref.number)) {
      result.closed.push(ref.number)
      continue
    }
    let issue: RestIssue
    try {
      issue = await gh.request<RestIssue>("GET", `/repos/${repo}/issues/${ref.number}`)
    } catch (err) {
      if (err instanceof GithubError && (err.status === 404 || err.status === 410)) {
        result.skipped.push(`#${ref.number} (not found)`)
        continue
      }
      throw err
    }
    if (issue.pull_request) result.skipped.push(`#${ref.number} (a pull request)`)
    else if (issue.state !== "open") result.skipped.push(`#${ref.number} (already closed)`)
    else {
      await gh.request("PATCH", `/repos/${repo}/issues/${ref.number}`, { state: "closed", state_reason: "completed" })
      done.push(ref.number)
      result.closed.push(ref.number)
      // The comment is extra: a failed one doesn't make the close try again.
      await gh.request("POST", `/repos/${repo}/issues/${ref.number}/comments`, { body: `Closed by #${pr.number} (merged into \`${base}\`).` }).catch(() => {})
    }
  }
  return result
}

/** "#5", "#5 and #7", "#5, #7 and #9". */
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/** The task's event for a handled merge, or null when there's nothing to say (it named no issues). */
export function issueCloseEvent(prUrl: string, r: IssueCloseResult): string | null {
  const n = prNumber(prUrl) ?? "?"
  if (r.defaultBranch || (!r.closed.length && !r.skipped.length)) return null
  const closed = r.closed.length
    ? `Closed issue${r.closed.length === 1 ? "" : "s"} ${list(r.closed.map((i) => `#${i}`))}: PR #${n} names ${r.closed.length === 1 ? "it" : "them"} and merged into ${r.base}, where GitHub doesn't close them itself.`
    : `PR #${n} merged into ${r.base}, and closed no issues.`
  return r.skipped.length ? `${closed} Left alone: ${list(r.skipped)}.` : closed
}

export interface IssueCloserDeps {
  store: Store
  /** GitHub's fetch (the seam), or null when Box Yard can't ask GitHub (mock mode). */
  fetch: typeof globalThis.fetch | null
  /** The project's GitHub token (its identity's), or null. */
  token: (projectId: string) => string | null
  /** Close the issues its merged PRs name: the project's own setting, else Settings'. */
  enabled: (projectId: string) => boolean
  /** Write an event on the task. */
  event: (taskId: string, text: string) => void
  log?: (message: string) => void
  now?: () => number
}

/**
 * The queue of merged PRs whose issues are still to close. queue() adds one (a merge seen live), run() works through
 * what's due, one at a time. A failure that may pass (network, rate limit, GitHub 5xx) tries again with a growing
 * wait, up to ISSUE_CLOSE_ATTEMPTS; anything else is reported on the task and dropped.
 */
export class IssueCloser {
  private running: Promise<void> | null = null
  private again = false
  /** Issues closed by an earlier try that failed later on, per PR: the event names them too (this server's life only). */
  private readonly progress = new Map<string, number[]>()

  constructor(private readonly deps: IssueCloserDeps) {}

  queue(taskId: string, prUrl: string) {
    this.deps.store.queueIssueClose(prUrl, taskId)
    void this.run()
  }

  /** Work through the due queue; a call while it runs makes it look again when done. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        for (const job of this.deps.store.dueIssueCloses(this.now())) await this.handle(job)
      } while (this.again)
    })().finally(() => (this.running = null))
    return this.running
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private async handle(job: { prUrl: string; taskId: string; attempts: number }) {
    const { store } = this.deps
    const row = store.getTaskRow(job.taskId)
    const finish = (event?: string) => {
      store.finishIssueClose(job.prUrl)
      this.progress.delete(job.prUrl)
      if (event && row) this.deps.event(row.id, event)
    }
    // Turned off since the merge: leave its issues alone.
    if (!row || !this.deps.enabled(row.project_id)) return finish()
    const n = prNumber(job.prUrl) ?? "?"
    const token = this.deps.token(row.project_id)
    if (!this.deps.fetch || !token) return finish(`Couldn't close the issues PR #${n} names: this project has no GitHub token.`)
    const done = this.progress.get(job.prUrl) ?? []
    try {
      const result = await closeNamedIssues(new GithubRest(this.deps.fetch, token), job.prUrl, done)
      finish(issueCloseEvent(job.prUrl, result) ?? undefined)
    } catch (err) {
      const retry = err instanceof GithubError ? err.retry : true
      const closed = done.length ? ` (closed ${list(done.map((i) => `#${i}`))} so far)` : ""
      if (retry && job.attempts + 1 < ISSUE_CLOSE_ATTEMPTS) {
        this.progress.set(job.prUrl, done)
        const wait = Math.min(60_000 * 2 ** job.attempts, MAX_RETRY_MS)
        store.retryIssueClose(job.prUrl, this.now() + wait)
        this.deps.log?.(`[box-yard] Closing the issues ${job.prUrl} names failed, trying again in ${Math.round(wait / 60_000)} min: ${errorMessage(err)}`)
        return
      }
      finish(`Couldn't close the issues PR #${n} names${closed}: ${errorMessage(err)}`)
    }
  }
}
