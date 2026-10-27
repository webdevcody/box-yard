import { z } from "zod"
import type { DB } from "../db.js"
import type { CredentialStore } from "../credentials.js"
import { credentialValue } from "../credentials.js"
import { BadRequestError, ConflictError, NotFoundError, githubSlug, newId } from "../store.js"
import { RUNNERS, RUNNER_PHRASE, type Runner } from "../../shared/runner.js"
import {
  COORDINATOR_SEES,
  DEFAULT_IDENTITY_ID,
  GITHUB_OWNER_RE,
  IDENTITY_CLAUDE_KINDS,
  IDENTITY_COLORS,
  type EmailCheck,
  type Identity,
  type IdentityCheckResult,
  type IdentityClaudeKind,
  type IdentitySigning,
  type IdentityToken,
} from "../../shared/identities.js"
import { GithubTokenError, githubTokenInfo, githubVerifiedEmails, noreplyEmails, type GithubFetch } from "./github.js"
import { tokenFingerprint, type SecretBox } from "./secretBox.js"

interface IdentityRow {
  id: string
  name: string
  color: string
  is_default: number
  github_login: string | null
  github_id: number | null
  owners_json: string
  author_name: string | null
  author_email: string | null
  email_check: string | null
  signing_json: string | null
  claude_kind: string | null
  runners_json: string | null
  coordinator_sees: string
  checked_json: string | null
  created_at: number
  updated_at: number
}

interface SecretRow {
  identity_id: string
  kind: "github_token" | "claude" | "signing_key"
  owner: string
  ciphertext: string
  fingerprint: string
  login: string | null
  scopes_json: string | null
  expires_at: number | null
  source: string
  created_at: number
}

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const owner = z.string().trim().regex(GITHUB_OWNER_RE, "A GitHub owner is a user or org name like acme-corp")
const author = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email("That isn't an email address").max(320) })

/** POST /api/identities and create_identity. */
export const identityCreate = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: z.enum(IDENTITY_COLORS).optional(),
    owners: z.array(owner).max(50).optional(),
    author: author.nullable().optional(),
    runners: z.array(z.enum(RUNNERS)).min(1, "Pick at least one runner, or null for every runner").nullable().optional(),
    coordinatorSees: z.enum(COORDINATOR_SEES).optional(),
  })
  .strict()

/** PATCH /api/identities/:id and update_identity. The Default identity keeps its name. */
export const identityPatch = identityCreate.partial().strict()

/** A token's owner is stored lower-case, as GitHub matches owners: "" is every owner the identity serves. */
export const tokenInput = z.object({ owner: z.union([owner, z.literal("")]).default("").transform((o) => o.toLowerCase()), token: credentialValue }).strict()
export const claudeInput = z.object({ kind: z.enum(IDENTITY_CLAUDE_KINDS), value: credentialValue }).strict()

/** Env var a Claude credential kind logs `claude` in with. */
export const CLAUDE_KIND_VAR: Record<IdentityClaudeKind, "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN"> = {
  api_key: "ANTHROPIC_API_KEY",
  oauth_token: "CLAUDE_CODE_OAUTH_TOKEN",
}

/** What a project's turns fall back on under their own env vars (turnEnv's `base`). */
export interface IdentityBase {
  identityId: string
  isDefault: boolean
  claude: Record<string, string>
  githubToken: string
  author: { name: string; email: string } | null
}

/**
 * Project identities: the rows, their encrypted secrets, and what a project's turns, clones, pushes and PR checks
 * use. Every value goes in through here (saveToken, saveClaude) and out only as resolved credentials for a turn
 * (base) or for redact() (secretValues). list() and get() never carry one.
 */
export class Identities {
  private readonly listeners = new Set<() => void>()
  private secretCache: string[] | null = null

  constructor(
    private readonly d: {
      db: DB
      secrets: SecretBox
      /** Settings › Credentials: the Default identity's missing parts. */
      credentials: Pick<CredentialStore, "get" | "claudeEnv">
      github?: GithubFetch
      /** Mock mode: tokens aren't checked with GitHub, unless a stand-in for it is given (tests). */
      mock?: boolean
    },
  ) {}

  private get offline() {
    return Boolean(this.d.mock && !this.d.github)
  }

  // ---------- reading ----------

  list(): Identity[] {
    const rows = this.d.db.prepare("SELECT * FROM identities ORDER BY is_default DESC, name COLLATE NOCASE").all() as IdentityRow[]
    return rows.map((r) => this.view(r))
  }

  get(id: string): Identity | null {
    const row = this.row(id)
    return row ? this.view(row) : null
  }

  require(id: string): Identity {
    const i = this.get(id)
    if (!i) throw new NotFoundError(`Identity ${id} not found`)
    return i
  }

  /** By id or (case-insensitive) name, for the MCP tools. */
  find(ref: string): Identity | null {
    const row = (this.row(ref) ?? this.d.db.prepare("SELECT * FROM identities WHERE name = ? COLLATE NOCASE").get(ref.trim())) as IdentityRow | undefined
    return row ? this.view(row) : null
  }

  /** A project's identity id; a project row that names a deleted one counts as Default. */
  idOf(projectId: string): string {
    const r = this.d.db.prepare("SELECT p.identity_id AS id FROM projects p JOIN identities i ON i.id = p.identity_id WHERE p.id = ?").get(projectId) as { id: string } | undefined
    return r?.id ?? DEFAULT_IDENTITY_ID
  }

  of(projectId: string): Identity {
    return this.get(this.idOf(projectId)) ?? this.require(DEFAULT_IDENTITY_ID)
  }

  private row(id: string): IdentityRow | undefined {
    return this.d.db.prepare("SELECT * FROM identities WHERE id = ?").get(id) as IdentityRow | undefined
  }

  private secretRows(id: string): SecretRow[] {
    return this.d.db.prepare("SELECT * FROM identity_secrets WHERE identity_id = ? ORDER BY kind, owner").all(id) as SecretRow[]
  }

  private view(r: IdentityRow): Identity {
    const secrets = this.secretRows(r.id)
    const tokens: IdentityToken[] = secrets
      .filter((s) => s.kind === "github_token")
      .map((s) => ({
        owner: s.owner,
        fingerprint: s.fingerprint,
        login: s.login ?? "",
        scopes: json<string[] | null>(s.scopes_json, null),
        expiresAt: s.expires_at,
        source: s.source,
        savedAt: s.created_at,
        readable: this.d.secrets.open(s.ciphertext) !== null,
      }))
    const claude = secrets.find((s) => s.kind === "claude")
    const projectIds = (this.d.db.prepare("SELECT id FROM projects WHERE identity_id = ? ORDER BY name COLLATE NOCASE").all(r.id) as { id: string }[]).map((p) => p.id)
    return {
      id: r.id,
      name: r.name,
      color: (IDENTITY_COLORS as readonly string[]).includes(r.color) ? (r.color as Identity["color"]) : "slate",
      isDefault: r.is_default === 1,
      githubLogin: r.github_login,
      githubId: r.github_id,
      owners: json<string[]>(r.owners_json, []),
      tokens,
      author: r.author_name && r.author_email ? { name: r.author_name, email: r.author_email, emailCheck: (r.email_check as EmailCheck | null) ?? "unknown" } : null,
      signing: json<IdentitySigning | null>(r.signing_json, null),
      claude: claude && r.claude_kind ? { kind: r.claude_kind as IdentityClaudeKind, fingerprint: claude.fingerprint, readable: this.d.secrets.open(claude.ciphertext) !== null } : null,
      runners: json<Runner[] | null>(r.runners_json, null),
      coordinatorSees: r.coordinator_sees === "status" ? "status" : "everything",
      projectIds,
      lastCheck: json<IdentityCheckResult | null>(r.checked_json, null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  // ---------- writing ----------

  create(input: unknown): Identity {
    const body = parse(identityCreate, input)
    this.requireFreeName(body.name)
    const id = newId("idn")
    const now = Date.now()
    this.d.db
      .prepare(
        `INSERT INTO identities (id, name, color, is_default, owners_json, author_name, author_email, email_check, runners_json, coordinator_sees, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        body.name,
        body.color ?? this.nextColor(),
        JSON.stringify(uniqueOwners(body.owners ?? [])),
        body.author?.name ?? null,
        body.author?.email ?? null,
        body.author ? "unknown" : null,
        body.runners ? JSON.stringify([...new Set(body.runners)]) : null,
        body.coordinatorSees ?? "everything",
        now,
        now,
      )
    this.changed()
    return this.require(id)
  }

  update(id: string, input: unknown): Identity {
    const current = this.require(id)
    const body = parse(identityPatch, input)
    if (body.name !== undefined && body.name !== current.name) {
      if (current.isDefault) throw new BadRequestError("The Default identity keeps its name.")
      this.requireFreeName(body.name, id)
    }
    if (body.runners !== undefined && body.runners !== null) this.requireRunnersFit(current, body.runners)
    const sets: string[] = []
    const args: unknown[] = []
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v))
    if (body.name !== undefined) set("name", body.name)
    if (body.color !== undefined) set("color", body.color)
    if (body.owners !== undefined) set("owners_json", JSON.stringify(uniqueOwners(body.owners)))
    if (body.author !== undefined) {
      set("author_name", body.author?.name ?? null)
      set("author_email", body.author?.email ?? null)
      const same = body.author && current.author && body.author.email.toLowerCase() === current.author.email.toLowerCase()
      set("email_check", body.author ? (same ? current.author!.emailCheck : "unknown") : null)
    }
    if (body.runners !== undefined) set("runners_json", body.runners ? JSON.stringify([...new Set(body.runners)]) : null)
    if (body.coordinatorSees !== undefined) set("coordinator_sees", body.coordinatorSees)
    if (!sets.length) return current
    set("updated_at", Date.now())
    this.d.db.prepare(`UPDATE identities SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
    this.changed()
    return this.require(id)
  }

  /** Remove an identity. Refused while projects use it, unless they move to Default (`moveProjects`). */
  delete(id: string, o: { moveProjects?: boolean } = {}): { movedProjectIds: string[] } {
    const current = this.require(id)
    if (current.isDefault) throw new BadRequestError("The Default identity can't be removed: it's Settings › Credentials.")
    if (current.projectIds.length && !o.moveProjects) {
      throw new ConflictError(`${current.projectIds.length === 1 ? "A project uses" : `${current.projectIds.length} projects use`} the ${current.name} identity. Give them another one first, or move them to Default.`)
    }
    this.d.db.transaction(() => {
      this.d.db.prepare("UPDATE projects SET identity_id = ? WHERE identity_id = ?").run(DEFAULT_IDENTITY_ID, id)
      this.d.db.prepare("DELETE FROM identities WHERE id = ?").run(id)
    })()
    this.changed()
    return { movedProjectIds: current.projectIds }
  }

  /**
   * Save a GitHub token for one owner ("" for every owner). GitHub must accept it, and every token of an identity
   * must be the same account: an identity is one GitHub login. The first token sets the login.
   */
  async saveToken(id: string, input: unknown, source = "pasted"): Promise<Identity> {
    const current = this.requireOwnSecrets(id, "GitHub token")
    const body = parse(tokenInput, input)
    let info: { login: string; id: number; scopes: string[] | null; expiresAt: number | null }
    if (this.offline) info = { login: current.githubLogin ?? "mock-user", id: current.githubId ?? 1, scopes: null, expiresAt: null }
    else {
      try {
        info = await githubTokenInfo(body.token, this.d.github)
      } catch (err) {
        throw new BadRequestError(err instanceof GithubTokenError ? err.message : "Couldn't check the token with GitHub.")
      }
    }
    const others = current.tokens.filter((t) => t.owner !== body.owner)
    if (current.githubLogin && others.length && info.login.toLowerCase() !== current.githubLogin.toLowerCase()) {
      throw new BadRequestError(`That token is ${info.login}'s, but the ${current.name} identity is ${current.githubLogin}. Each identity is one GitHub account: make another identity for ${info.login}.`)
    }
    const now = Date.now()
    this.d.db.transaction(() => {
      this.putSecret(id, "github_token", body.owner, body.token, { login: info.login, scopes: info.scopes, expiresAt: info.expiresAt, source })
      this.d.db.prepare("UPDATE identities SET github_login = ?, github_id = ?, updated_at = ? WHERE id = ?").run(info.login, info.id, now, id)
    })()
    if (current.author && !this.offline) await this.checkEmail(id, body.token, info).catch(() => {})
    this.changed()
    return this.require(id)
  }

  removeToken(id: string, owner: string): Identity {
    this.require(id)
    this.d.db.prepare("DELETE FROM identity_secrets WHERE identity_id = ? AND kind = 'github_token' AND owner = ?").run(id, owner.toLowerCase())
    const left = this.d.db.prepare("SELECT COUNT(*) AS n FROM identity_secrets WHERE identity_id = ? AND kind = 'github_token'").get(id) as { n: number }
    if (!left.n) this.d.db.prepare("UPDATE identities SET github_login = NULL, github_id = NULL WHERE id = ?").run(id)
    this.d.db.prepare("UPDATE identities SET updated_at = ? WHERE id = ?").run(Date.now(), id)
    this.changed()
    return this.require(id)
  }

  saveClaude(id: string, input: unknown, source = "pasted"): Identity {
    this.requireOwnSecrets(id, "Claude login")
    const body = parse(claudeInput, input)
    this.d.db.transaction(() => {
      this.putSecret(id, "claude", "", body.value, { source })
      this.d.db.prepare("UPDATE identities SET claude_kind = ?, updated_at = ? WHERE id = ?").run(body.kind, Date.now(), id)
    })()
    this.changed()
    return this.require(id)
  }

  removeClaude(id: string): Identity {
    this.require(id)
    this.d.db.prepare("DELETE FROM identity_secrets WHERE identity_id = ? AND kind = 'claude'").run(id)
    this.d.db.prepare("UPDATE identities SET claude_kind = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id)
    this.changed()
    return this.require(id)
  }

  /** Record a test_identity result (no secrets in it). */
  setCheck(id: string, result: IdentityCheckResult) {
    this.d.db.prepare("UPDATE identities SET checked_json = ? WHERE id = ?").run(JSON.stringify(result), id)
    this.changed()
  }

  /** Give a project an identity. The caller checks its runner fits (runnerProblem). */
  assign(projectId: string, identityId: string) {
    this.require(identityId)
    const r = this.d.db.prepare("UPDATE projects SET identity_id = ?, updated_at = ? WHERE id = ?").run(identityId, Date.now(), projectId)
    if (!r.changes) throw new NotFoundError(`Project ${projectId} not found`)
    this.changed()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    this.secretCache = null
    for (const fn of this.listeners) fn()
  }

  private putSecret(id: string, kind: SecretRow["kind"], owner: string, value: string, meta: { login?: string; scopes?: string[] | null; expiresAt?: number | null; source: string }) {
    this.d.db
      .prepare(
        `INSERT INTO identity_secrets (identity_id, kind, owner, ciphertext, fingerprint, login, scopes_json, expires_at, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (identity_id, kind, owner) DO UPDATE SET ciphertext = excluded.ciphertext, fingerprint = excluded.fingerprint,
           login = excluded.login, scopes_json = excluded.scopes_json, expires_at = excluded.expires_at, source = excluded.source, created_at = excluded.created_at`,
      )
      .run(id, kind, owner, this.d.secrets.seal(value), tokenFingerprint(value), meta.login ?? null, meta.scopes ? JSON.stringify(meta.scopes) : null, meta.expiresAt ?? null, meta.source, Date.now())
  }

  /** Is the identity's author email the account's own? Verified when the token may read its emails, else unknown. */
  private async checkEmail(id: string, token: string, info: { login: string; id: number }) {
    const email = this.row(id)?.author_email?.toLowerCase()
    if (!email) return
    let check: EmailCheck = "unknown"
    if (noreplyEmails(info.login, info.id).includes(email)) check = "verified"
    else {
      const emails = await githubVerifiedEmails(token, this.d.github)
      if (emails) check = emails.includes(email) ? "verified" : "unverified"
    }
    this.d.db.prepare("UPDATE identities SET email_check = ? WHERE id = ?").run(check, id)
  }

  /** The Default identity's secrets are Settings › Credentials, edited there, so there's one place for each. */
  private requireOwnSecrets(id: string, what: string): Identity {
    const current = this.require(id)
    if (current.isDefault) throw new BadRequestError(`The Default identity's ${what} is the one in Settings › Credentials. Change it there, or make an identity of its own.`)
    return current
  }

  private requireFreeName(name: string, self?: string) {
    const taken = this.d.db.prepare("SELECT id FROM identities WHERE name = ? COLLATE NOCASE").get(name) as { id: string } | undefined
    if (taken && taken.id !== self) throw new BadRequestError(`An identity named "${name}" already exists.`)
  }

  private requireRunnersFit(current: Identity, runners: Runner[]) {
    const rows = this.d.db.prepare("SELECT name, runner FROM projects WHERE identity_id = ?").all(current.id) as { name: string; runner: string | null }[]
    const misfit = rows.find((p) => !runners.includes((p.runner as Runner | null) ?? "box"))
    if (misfit) throw new BadRequestError(`${misfit.name} uses the ${current.name} identity and runs on ${RUNNER_PHRASE[(misfit.runner as Runner | null) ?? "box"]}. Keep that runner, or move the project first.`)
  }

  private nextColor(): Identity["color"] {
    const used = new Set((this.d.db.prepare("SELECT color FROM identities").all() as { color: string }[]).map((r) => r.color))
    return IDENTITY_COLORS.find((c) => c !== "slate" && !used.has(c)) ?? "sky"
  }

  // ---------- resolution ----------

  /** A secret's value, or "" when there's none or it can't be read (another secret key). */
  private secret(id: string, kind: SecretRow["kind"], owner: string): string {
    const r = this.d.db.prepare("SELECT ciphertext FROM identity_secrets WHERE identity_id = ? AND kind = ? AND owner = ?").get(id, kind, owner) as { ciphertext: string } | undefined
    return r ? (this.d.secrets.open(r.ciphertext) ?? "") : ""
  }

  /**
   * What a project's turns use under their own env vars: its identity's token for the repo's owner (else its
   * every-owner token), its Claude login, its author. The Default identity's token and Claude login are Settings ›
   * Credentials. Another identity without a token gets none (never someone else's); without a Claude login it uses
   * the global one.
   */
  base(projectId: string, repo: string | null): IdentityBase {
    const identityId = this.idOf(projectId)
    const row = this.row(identityId)
    const isDefault = !row || row.is_default === 1
    const repoOwner = githubSlug(repo)?.split("/")[0]?.toLowerCase() ?? null
    let githubToken = ""
    if (isDefault) githubToken = this.d.credentials.get("githubToken")
    else if (repoOwner) githubToken = this.secret(identityId, "github_token", repoOwner)
    if (!isDefault) githubToken ||= this.secret(identityId, "github_token", "")
    const claude = this.ownClaude(projectId) ?? this.d.credentials.claudeEnv()
    const author = row?.author_name && row.author_email ? { name: row.author_name, email: row.author_email } : null
    return { identityId, isDefault, claude, githubToken, author }
  }

  /** The Claude login of a project's identity when it has one of its own, as a one-var env; else null (the global one). */
  ownClaude(projectId: string): Record<string, string> | null {
    const row = this.row(this.idOf(projectId))
    const value = row?.claude_kind && row.is_default !== 1 ? this.secret(row.id, "claude", "") : ""
    return value ? { [CLAUDE_KIND_VAR[row!.claude_kind as IdentityClaudeKind]]: value } : null
  }

  /** Why a project of this identity can't run on `runner`, or null when it can. */
  runnerProblem(identityId: string, runner: Runner): string | null {
    // Placement asks on every pass: the row alone, not the whole view (its secrets and projects).
    const r = this.row(identityId)
    const runners = r ? json<Runner[] | null>(r.runners_json, null) : null
    if (!r || !runners || runners.includes(runner)) return null
    return `the ${r.name} identity runs only on ${runners.map((x) => RUNNER_PHRASE[x]).join(" or ")} (Settings › Identities)`
  }

  /** An identity's name, or null when there's none with that id. */
  nameOf(id: string): string | null {
    return this.row(id)?.name ?? null
  }

  /** Every identity secret in effect, for redact(); cached until one changes. */
  secretValues(): string[] {
    if (this.secretCache) return this.secretCache
    const rows = this.d.db.prepare("SELECT ciphertext FROM identity_secrets").all() as { ciphertext: string }[]
    this.secretCache = rows.map((r) => this.d.secrets.open(r.ciphertext) ?? "").filter(Boolean)
    return this.secretCache
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) throw new BadRequestError(r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "))
  return r.data
}

const uniqueOwners = (owners: string[]) => [...new Map(owners.map((o) => [o.toLowerCase(), o])).values()]
