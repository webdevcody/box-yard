// Who a turn's commits are by (docs/identities.md, "Git author"). The first of these that's there wins:
// 1. the project's (or task's) own GIT_AUTHOR_* env vars, else its identity's author (turnEnv sets both);
// 2. Settings › Credentials › Git author (GIT_USER_NAME / GIT_USER_EMAIL);
// 3. on this computer (the local runner, a Docker container), this computer's own git config;
// 4. the GitHub account behind the turn's token: its name and <id>+<login>@users.noreply.github.com;
// 5. only then FALLBACK_AUTHOR, which the task's log and Settings › Credentials / Identities warn about.
// An identity's signing key signs whichever author it is (box-runner.mjs signingEnv). The token lookup runs on this
// server only: the token never reaches a prompt or the model.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import os from "node:os"
import { githubTokenInfo, type GithubFetch } from "./identity/github.js"
import type { Store } from "./store.js"
import { q } from "./providers/types.js"
import { GIT_AUTHOR_VARS } from "./turnCredentials.js"
import { FALLBACK_GIT_AUTHOR } from "../shared/setup.js"

export interface GitAuthor {
  name: string
  email: string
}

/** The author of last resort. Repos cloned before the author chain have it in their own .git/config. */
export const FALLBACK_AUTHOR: GitAuthor = { ...FALLBACK_GIT_AUTHOR }

/** Where a turn's author came from, in chain order. */
export type AuthorSource = "project" | "identity" | "settings" | "host" | "github" | "fallback"

export const AUTHOR_SOURCE_LABEL: Record<AuthorSource, string> = {
  project: "the project's GIT_AUTHOR_* env vars",
  identity: "its identity's author",
  settings: "Settings › Credentials › Git author",
  host: "this computer's git config",
  github: "the GitHub account behind its token",
  fallback: "Box Yard's fallback author",
}

export interface TurnAuthor {
  source: AuthorSource
  /** The author the turn's env names; null when this computer's own git picks it (the local runner's host step). */
  author: GitAuthor | null
  /** Why each step before `source` didn't give an author, for the fallback warning. */
  skipped: string[]
  /** Something worth a line in the task's log (signing that can't follow the author into a container). */
  note: string | null
}

/** What this computer's git config says (for one repo, includeIf included). */
export interface HostGit {
  name: string
  email: string
  /** commit.gpgsign is on: how git signs. */
  signing: { format: string; key: string; program: string } | null
}

const HOST_MARK = "BOXYARD_HOSTGIT "
const HOST_KEYS = ["user.name", "user.email", "commit.gpgsign", "gpg.format", "user.signingkey", "gpg.ssh.program"] as const

/**
 * Prints the git config the user's own git would use for commits in `repo` (its own config, the global one and every
 * include, includeIf too). Before that, drops the fallback author that clones made before the author chain wrote into
 * the repo's own config: it would beat the user's. Without `repo`, the global config (and its includes) alone.
 */
export function hostGitScript(repo: string | null): string {
  const keys = HOST_KEYS.join(" ")
  if (!repo) return `for k in ${keys}; do v=$(git config --global --includes --get "$k" 2>/dev/null) && printf '${HOST_MARK}%s=%s\\n' "$k" "$v"; done; true`
  return [
    `cd ${q(repo)} 2>/dev/null || exit 0`,
    `[ "$(git config --local --get user.name 2>/dev/null)" = ${q(FALLBACK_AUTHOR.name)} ] && git config --local --unset-all user.name`,
    `[ "$(git config --local --get user.email 2>/dev/null)" = ${q(FALLBACK_AUTHOR.email)} ] && git config --local --unset-all user.email`,
    `for k in ${keys}; do v=$(git config --get "$k" 2>/dev/null) && printf '${HOST_MARK}%s=%s\\n' "$k" "$v"; done; true`,
  ].join("\n")
}

/** hostGitScript's output; null when it names no author (no user.name or no user.email). */
export function parseHostGit(stdout: string): HostGit | null {
  const v: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(HOST_MARK)) continue
    const rest = line.slice(HOST_MARK.length)
    const i = rest.indexOf("=")
    if (i > 0) v[rest.slice(0, i).toLowerCase()] = rest.slice(i + 1).trim()
  }
  const name = v["user.name"] ?? ""
  const email = v["user.email"] ?? ""
  if (!name || !email) return null
  const signs = /^(true|yes|on|1)$/i.test(v["commit.gpgsign"] ?? "")
  return { name, email, signing: signs ? { format: v["gpg.format"] || "openpgp", key: v["user.signingkey"] ?? "", program: v["gpg.ssh.program"] ?? "" } : null }
}

/** This server's own global git config (and its includes), for a runner whose repo isn't on this computer's disk. */
export function readHostGit(env: NodeJS.ProcessEnv = process.env): Promise<HostGit | null> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", hostGitScript(null)], { cwd: os.homedir(), env, timeout: 10_000 }, (_err, stdout) => resolve(parseHostGit(String(stdout ?? ""))))
  })
}

/** The commit author of a GitHub account: its display name (else login) and its private noreply address. */
export const githubAuthor = (u: { login: string; id: number; name: string | null }): GitAuthor => ({
  name: u.name?.trim() || u.login,
  email: `${u.id}+${u.login}@users.noreply.github.com`,
})

/** How long a token's account is remembered, and how long a failed lookup waits before it's tried again. */
const GITHUB_OK_TTL_MS = 24 * 3600_000
const GITHUB_FAIL_TTL_MS = 10 * 60_000

/** The GitHub account behind each token, looked up once (GET /user) and cached by the token's hash. */
export class GithubAuthors {
  private readonly cache = new Map<string, { result: GitAuthor | string; until: number }>()
  private readonly pending = new Map<string, Promise<GitAuthor | string>>()

  constructor(
    private readonly fetch: GithubFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The token's account as an author, or why there's none (a sentence without the token). */
  async author(token: string): Promise<GitAuthor | string> {
    const key = createHash("sha256").update(token).digest("hex")
    const hit = this.cache.get(key)
    if (hit && hit.until > this.now()) return hit.result
    const running = this.pending.get(key)
    if (running) return running
    const lookup = githubTokenInfo(token, this.fetch)
      .then((info): GitAuthor | string => githubAuthor(info))
      .catch((err: unknown) => (err instanceof Error ? err.message : "GitHub couldn't be asked whose token it is."))
      .then((result) => {
        this.cache.set(key, { result, until: this.now() + (typeof result === "string" ? GITHUB_FAIL_TTL_MS : GITHUB_OK_TTL_MS) })
        this.pending.delete(key)
        return result
      })
    this.pending.set(key, lookup)
    return lookup
  }
}

export interface AuthorChain {
  /** The turn's env after turnEnv: GIT_AUTHOR_* set there came from the project's env or its identity. */
  env: Record<string, string>
  /** turnEnv's author came from the identity (not the project's own env vars). */
  identityAuthor: boolean
  /** Settings › Credentials › Git author (GIT_USER_NAME / GIT_USER_EMAIL), "" when unset. */
  settings: GitAuthor
  /**
   * This computer's git config, when the turn runs on this computer for the Default identity. "native": the turn's
   * own git reads it (the local runner), so the env names no author; "env": it goes in as env vars (a container).
   * Null: not on this computer, or the identity has a git config of its own.
   */
  host: { mode: "native" | "env"; read: () => Promise<HostGit | null> } | { skipped: string } | null
  /** The GitHub account of the turn's token, or why there's none. */
  github: (() => Promise<GitAuthor | string>) | { skipped: string }
}

/** Walk the chain (see the top of this file) for one turn. */
export async function chooseAuthor(c: AuthorChain): Promise<TurnAuthor> {
  if (GIT_AUTHOR_VARS.some((v) => c.env[v])) return { source: c.identityAuthor ? "identity" : "project", author: null, skipped: [], note: null }
  const skipped = ["its identity has no author"]
  if (c.settings.name.trim() && c.settings.email.trim()) return { source: "settings", author: { name: c.settings.name.trim(), email: c.settings.email.trim() }, skipped, note: null }
  skipped.push("Settings › Credentials › Git author (GIT_USER_NAME / GIT_USER_EMAIL) isn't set")
  if (c.host && "read" in c.host) {
    const host = await c.host.read().catch(() => null)
    if (host) {
      if (c.host.mode === "native") return { source: "host", author: null, skipped, note: null }
      const note = host.signing ? `This computer's git signs commits (${host.signing.format}), but its key doesn't reach the container, so this turn's commits by ${host.name} aren't signed.` : null
      return { source: "host", author: { name: host.name, email: host.email }, skipped, note }
    }
    skipped.push("this computer's git config has no user.name and user.email")
  } else if (c.host) skipped.push(c.host.skipped)
  if (typeof c.github === "function") {
    const gh = await c.github()
    if (typeof gh !== "string") return { source: "github", author: gh, skipped, note: null }
    skipped.push(`the GitHub account behind its token couldn't be read: ${gh.replace(/\.$/, "")}`)
  } else skipped.push(c.github.skipped)
  return { source: "fallback", author: FALLBACK_AUTHOR, skipped, note: null }
}

/** A turn's author as the env vars git reads (they beat any config). */
export function authorEnv(a: GitAuthor): Record<(typeof GIT_AUTHOR_VARS)[number], string> {
  return { GIT_AUTHOR_NAME: a.name, GIT_COMMITTER_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_EMAIL: a.email }
}

/** The warning a task's log gets when its commits go out under FALLBACK_AUTHOR. */
export function fallbackWarning(skipped: string[]): string {
  return `⚠️ This turn's commits go out as ${FALLBACK_AUTHOR.name} <${FALLBACK_AUTHOR.email}>, unsigned: ${skipped.join("; ")}. Set a Git author in Settings › Credentials, or an author on the project's identity (Settings › Identities).`
}

// ---------- the Settings notice ----------

/** Projects whose last turn committed under FALLBACK_AUTHOR, for Settings › Credentials / Identities. */
const FALLBACK_KV = "git_author_fallback"

export interface AuthorFallbackRecord {
  projectId: string
  taskId: string
  at: number
  why: string
}

export function authorFallbacks(store: Store): AuthorFallbackRecord[] {
  try {
    const raw = JSON.parse(store.getKv(FALLBACK_KV) ?? "{}") as Record<string, Omit<AuthorFallbackRecord, "projectId">>
    return Object.entries(raw).map(([projectId, r]) => ({ projectId, ...r }))
  } catch {
    return []
  }
}

/** Note (or clear) a project's fallback: a later turn with a real author takes it off the list. */
export function recordAuthorSource(store: Store, projectId: string, taskId: string, a: TurnAuthor) {
  const now = Object.fromEntries(authorFallbacks(store).map(({ projectId: p, ...r }) => [p, r]))
  if (a.source === "fallback") now[projectId] = { taskId, at: Date.now(), why: a.skipped.join("; ") }
  else if (projectId in now) delete now[projectId]
  else return
  store.setKv(FALLBACK_KV, Object.keys(now).length ? JSON.stringify(now) : null)
}
