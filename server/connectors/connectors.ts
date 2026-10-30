import { z } from "zod"
import type { DB } from "../db.js"
import { BadRequestError, ConflictError, NotFoundError, newId } from "../store.js"
import { RUNNERS, type Runner } from "../../shared/runner.js"
import {
  CONNECTOR_AUTHS,
  CONNECTOR_KINDS,
  CONNECTOR_NAME_RE,
  CONNECTOR_SESSIONS,
  CONNECTOR_STATUSES,
  DEFAULT_CONNECTOR_SCOPE,
  OAUTH_CLIENT_KINDS,
  RESERVED_CONNECTOR_NAMES,
  connectorVar,
  type Connector,
  type ConnectorAuth,
  type ConnectorKind,
  type ConnectorOAuth,
  type ConnectorScope,
  type ConnectorSecretView,
  type ConnectorSession,
  type ConnectorStatus,
  type ConnectorTest,
  type OAuthClientKind,
} from "../../shared/connectors.js"
import { tokenFingerprint, type SecretBox } from "../identity/secretBox.js"

interface ConnectorRow {
  id: string
  name: string
  label: string
  preset: string | null
  kind: string
  url: string | null
  command: string | null
  args_json: string
  env_json: string
  auth: string
  header_name: string | null
  header_prefix: string | null
  token_env: string | null
  oauth_json: string | null
  scope_json: string
  enabled: number
  status: string
  status_detail: string | null
  test_json: string | null
  created_at: number
  updated_at: number
}

interface SecretRow {
  connector_id: string
  name: string
  ciphertext: string
  fingerprint: string
  expires_at: number | null
  created_at: number
}

/**
 * The OAuth state a connector keeps, beside its configuration: what discovery found, the client Box Yard registered,
 * and what the last sign-in got. Never a token or a client secret (those are connector_secrets).
 */
export interface OAuthState {
  clientKind: OAuthClientKind
  /** Cody's own client id (desktop, web); a registered one is in `registration`. */
  clientId: string | null
  /** The authorization server, as configured (a preset's) or discovered. */
  issuer: string | null
  scopes: string[]
  authParams: Record<string, string>
  /** The authorization server the last discovery found (or the configured issuer). */
  authServer?: string | null
  /** Authorization server metadata from the last discovery (endpoints, methods). */
  metadata?: Record<string, unknown> | null
  /** RFC 8707 resource indicator the server named, sent verbatim. */
  resource?: string | null
  /** The client Box Yard registered (RFC 7591), for one issuer and redirect address. */
  registration?: { issuer: string; redirectUri: string; clientId: string; at: number } | null
  grantedScopes?: string[] | null
  redirectUri?: string | null
  signedInAt?: number | null
}

/** A session asking which connectors it gets. */
export type SessionRef = { kind: "coordinator" } | { kind: "captain"; projectId: string } | { kind: "agent"; projectId: string; runner: Runner }

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
export const isLoopbackHost = (host: string) => LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host)

/** A remote server's address: https, or http only to this computer (a token never crosses a network in the clear). */
export function checkServerUrl(raw: string, what = "The server address"): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new BadRequestError(`${what} isn't a URL.`)
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) throw new BadRequestError(`${what} must be https (plain http only to this computer).`)
  if (u.username || u.password) throw new BadRequestError(`${what} can't hold a user name or password: put a token in its token field.`)
  return u
}

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "An env var name is letters, digits and _ (not starting with a digit)")
const headerName = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, "A header name is letters, digits and -")
const scopeInput = z
  .object({
    sessions: z.array(z.enum(CONNECTOR_SESSIONS)).max(CONNECTOR_SESSIONS.length),
    projects: z.array(z.string().trim().min(1)).max(500).nullable(),
    runners: z.array(z.enum(RUNNERS)).max(RUNNERS.length),
  })
  .strict()
const oauthInput = z
  .object({
    clientKind: z.enum(OAUTH_CLIENT_KINDS).optional(),
    clientId: z.string().trim().min(1).max(500).nullable().optional(),
    issuer: z.string().trim().max(2000).nullable().optional(),
    scopes: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
    authParams: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().max(200)).optional(),
  })
  .strict()

/** POST /api/connectors. */
export const connectorCreate = z
  .object({
    name: z.string().trim().toLowerCase(),
    label: z.string().trim().min(1).max(60).optional(),
    preset: z.string().trim().max(40).nullable().optional(),
    kind: z.enum(CONNECTOR_KINDS),
    url: z.string().trim().max(2000).nullable().optional(),
    command: z.string().trim().min(1).max(500).nullable().optional(),
    args: z.array(z.string().max(2000)).max(50).optional(),
    env: z.record(envName, z.string().max(4000)).optional(),
    auth: z.enum(CONNECTOR_AUTHS).optional(),
    header: z.object({ name: headerName, prefix: z.string().max(40) }).strict().optional(),
    tokenEnv: envName.nullable().optional(),
    oauth: oauthInput.nullable().optional(),
    scope: scopeInput.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

/** PATCH /api/connectors/:id. */
export const connectorPatch = connectorCreate.partial().strict()

/** A secret typed into Settings: a token, a client secret or an env value. Not trimmed inside, but no line breaks. */
export const secretValue = z
  .string()
  .trim()
  .min(1, "It's empty")
  .max(8000, "That's too long to be a key or token")
  .regex(/^[^\r\n]+$/, "Keys and tokens are one line")

const SECRET_NAME = /^(token|access_token|refresh_token|client_secret|dcr_client_secret|env:[A-Za-z_][A-Za-z0-9_]{0,63})$/

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) throw new BadRequestError(r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "))
  return r.data
}

/** The secrets a connector of this shape uses; any other is dropped when its shape changes. */
function secretsFor(kind: ConnectorKind, auth: ConnectorAuth, clientKind: OAuthClientKind | null): (name: string) => boolean {
  return (name) => {
    if (name.startsWith("env:")) return kind === "stdio"
    if (name === "token") return auth === "token"
    if (name === "access_token" || name === "refresh_token" || name === "dcr_client_secret") return auth === "oauth"
    if (name === "client_secret") return auth === "oauth" && clientKind !== "dynamic"
    return false
  }
}

/**
 * External MCP connectors (docs/connectors.md): the rows, their encrypted secrets, and who gets each one. Every value
 * goes in through here (saveSecret) and comes out only to build a session's MCP config (secret()) or for redaction
 * (secretValues()). list() and get() never carry one.
 */
export class Connectors {
  private readonly listeners = new Set<() => void>()
  private secretCache: string[] | null = null
  /** Access tokens replaced in this process: a transcript that printed one before it rotated still gets it redacted. */
  private readonly retired: string[] = []

  constructor(
    private readonly d: {
      db: DB
      secrets: SecretBox
      /** Projects whose identity shows the Coordinator status only (docs/identities.md). */
      statusOnly: (projectId: string) => boolean
      projectExists: (projectId: string) => boolean
      projectName: (projectId: string) => string | null
    },
  ) {}

  // ---------- reading ----------

  list(): Connector[] {
    const rows = this.d.db.prepare("SELECT * FROM connectors ORDER BY label COLLATE NOCASE, name").all() as ConnectorRow[]
    return rows.map((r) => this.view(r))
  }

  get(id: string): Connector | null {
    const row = this.row(id)
    return row ? this.view(row) : null
  }

  require(id: string): Connector {
    const c = this.get(id)
    if (!c) throw new NotFoundError(`Connector ${id} not found`)
    return c
  }

  /** By id or name, for the MCP tool. */
  find(ref: string): Connector | null {
    const row = this.row(ref) ?? (this.d.db.prepare("SELECT * FROM connectors WHERE name = ?").get(ref.trim().toLowerCase()) as ConnectorRow | undefined)
    return row ? this.view(row) : null
  }

  /** The OAuth state, for the sign-in and refresh code (server/connectors/oauth.ts). */
  oauthState(id: string): OAuthState | null {
    const row = this.row(id)
    return row ? json<OAuthState | null>(row.oauth_json, null) : null
  }

  private row(id: string): ConnectorRow | undefined {
    return this.d.db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as ConnectorRow | undefined
  }

  private secretRows(id: string): SecretRow[] {
    return this.d.db.prepare("SELECT * FROM connector_secrets WHERE connector_id = ? ORDER BY name").all(id) as SecretRow[]
  }

  private view(r: ConnectorRow): Connector {
    const secrets: ConnectorSecretView[] = this.secretRows(r.id).map((s) => ({
      name: s.name,
      fingerprint: s.fingerprint,
      readable: this.d.secrets.open(s.ciphertext) !== null,
      expiresAt: s.expires_at,
      savedAt: s.created_at,
    }))
    const scope = this.scopeOf(r)
    const o = json<OAuthState | null>(r.oauth_json, null)
    const access = secrets.find((s) => s.name === "access_token")
    const issuerHost = (() => {
      const endpoint = typeof o?.metadata?.authorization_endpoint === "string" ? o.metadata.authorization_endpoint : o?.issuer
      try {
        return endpoint ? new URL(endpoint).host : null
      } catch {
        return null
      }
    })()
    const oauth: ConnectorOAuth | null =
      r.auth === "oauth" && o
        ? {
            clientKind: o.clientKind,
            clientId: o.clientKind === "dynamic" ? (o.registration?.clientId ?? null) : o.clientId,
            hasClientSecret: secrets.some((s) => s.name === "client_secret"),
            issuer: o.issuer,
            signInHost: issuerHost,
            scopes: o.scopes,
            grantedScopes: o.grantedScopes ?? null,
            authParams: o.authParams,
            refreshable: secrets.some((s) => s.name === "refresh_token" && s.readable),
            expiresAt: access?.expiresAt ?? null,
            redirectUri: o.redirectUri ?? null,
            signedInAt: o.signedInAt ?? null,
          }
        : null
    return {
      id: r.id,
      name: r.name,
      label: r.label,
      preset: r.preset,
      kind: r.kind as ConnectorKind,
      url: r.url,
      command: r.command,
      args: json<string[]>(r.args_json, []),
      env: json<Record<string, string>>(r.env_json, {}),
      auth: r.auth as ConnectorAuth,
      header: { name: r.header_name ?? "Authorization", prefix: r.header_prefix ?? "Bearer " },
      tokenEnv: r.token_env,
      oauth,
      secrets,
      scope,
      enabled: r.enabled === 1,
      status: (CONNECTOR_STATUSES as readonly string[]).includes(r.status) ? (r.status as ConnectorStatus) : "untested",
      statusDetail: r.status_detail,
      lastTest: json<ConnectorTest | null>(r.test_json, null),
      sealedSkipped: this.sealedSkipped(scope),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private scopeOf(r: ConnectorRow): ConnectorScope {
    const s = json<Partial<ConnectorScope>>(r.scope_json, {})
    return {
      sessions: (s.sessions ?? DEFAULT_CONNECTOR_SCOPE.sessions).filter((x) => (CONNECTOR_SESSIONS as readonly string[]).includes(x)),
      projects: Array.isArray(s.projects) ? s.projects : null,
      runners: (s.runners ?? DEFAULT_CONNECTOR_SCOPE.runners).filter((x) => (RUNNERS as readonly string[]).includes(x)),
    }
  }

  /** Status-only projects a Coordinator connector's "every project" covers, which don't get it. */
  private sealedSkipped(scope: ConnectorScope): string[] {
    if (!scope.sessions.includes("coordinator") || !scope.sessions.some((s) => s !== "coordinator")) return []
    const ids = scope.projects ?? (this.d.db.prepare("SELECT id FROM projects ORDER BY name COLLATE NOCASE").all() as { id: string }[]).map((p) => p.id)
    return ids.filter((id) => this.d.statusOnly(id))
  }

  // ---------- who gets what ----------

  /** Whether a connector reaches a session: its scope covers it, and it isn't a status-only project's while the Coordinator uses it too. */
  reaches(c: Pick<Connector, "enabled" | "scope">, s: SessionRef): boolean {
    if (!c.enabled || !c.scope.sessions.includes(s.kind)) return false
    if (s.kind === "coordinator") return true
    if (c.scope.projects && !c.scope.projects.includes(s.projectId)) return false
    if (s.kind === "agent" && !c.scope.runners.includes(s.runner)) return false
    // A connector the Coordinator uses would carry a sealed project's content to it (docs/connectors.md).
    if (c.scope.sessions.includes("coordinator") && this.d.statusOnly(s.projectId)) return false
    return true
  }

  /** The connectors a session gets, by scope alone (whether each can sign in is the session builder's question). */
  forSession(s: SessionRef): Connector[] {
    return this.list().filter((c) => this.reaches(c, s))
  }

  /**
   * The connectors that reach a project's agents on Upstash boxes, as a key for the box wall: tasks of two projects
   * share a pool box only when this is the same (an agent can read everything on its box). "" when there are none.
   */
  boxKey(projectId: string): string {
    const ids = this.forSession({ kind: "agent", projectId, runner: "box" }).map((c) => c.id)
    return ids.length ? tokenFingerprint(ids.sort().join(",")) : ""
  }

  // ---------- writing ----------

  create(input: unknown): Connector {
    const body = parse(connectorCreate, input)
    const shape = this.checkShape({
      name: body.name,
      kind: body.kind,
      url: body.url ?? null,
      command: body.command ?? null,
      auth: body.auth ?? "none",
      tokenEnv: body.tokenEnv ?? null,
      oauth: body.oauth ?? null,
    })
    this.requireFreeName(shape.name)
    const scope = this.checkScope(body.scope ?? DEFAULT_CONNECTOR_SCOPE)
    const id = newId("con")
    const now = Date.now()
    const oauth: OAuthState | null =
      shape.auth === "oauth"
        ? {
            clientKind: body.oauth?.clientKind ?? "dynamic",
            clientId: body.oauth?.clientId ?? null,
            issuer: body.oauth?.issuer ?? null,
            scopes: body.oauth?.scopes ?? [],
            authParams: body.oauth?.authParams ?? {},
          }
        : null
    this.d.db
      .prepare(
        `INSERT INTO connectors (id, name, label, preset, kind, url, command, args_json, env_json, auth, header_name, header_prefix, token_env, oauth_json, scope_json, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        shape.name,
        body.label ?? shape.name,
        body.preset ?? null,
        shape.kind,
        shape.url,
        shape.command,
        JSON.stringify(shape.kind === "stdio" ? (body.args ?? []) : []),
        JSON.stringify(shape.kind === "stdio" ? (body.env ?? {}) : {}),
        shape.auth,
        body.header?.name ?? null,
        body.header?.prefix ?? null,
        shape.tokenEnv,
        oauth ? JSON.stringify(oauth) : null,
        JSON.stringify(scope),
        body.enabled === false ? 0 : 1,
        shape.auth === "oauth" || shape.auth === "token" ? "needs_auth" : "untested",
        now,
        now,
      )
    this.changed()
    return this.require(id)
  }

  update(id: string, input: unknown): Connector {
    const current = this.require(id)
    const body = parse(connectorPatch, input)
    const before = this.oauthState(id)
    const shape = this.checkShape({
      name: body.name ?? current.name,
      kind: body.kind ?? current.kind,
      url: body.url !== undefined ? body.url : current.url,
      command: body.command !== undefined ? body.command : current.command,
      auth: body.auth ?? current.auth,
      tokenEnv: body.tokenEnv !== undefined ? body.tokenEnv : current.tokenEnv,
      oauth: body.oauth !== undefined ? body.oauth : before,
    })
    if (shape.name !== current.name) this.requireFreeName(shape.name, id)
    const scope = body.scope ? this.checkScope(body.scope) : null
    const oauth: OAuthState | null =
      shape.auth === "oauth"
        ? {
            clientKind: body.oauth?.clientKind ?? before?.clientKind ?? "dynamic",
            clientId: body.oauth?.clientId !== undefined ? body.oauth.clientId : (before?.clientId ?? null),
            issuer: body.oauth?.issuer !== undefined ? body.oauth.issuer : (before?.issuer ?? null),
            scopes: body.oauth?.scopes ?? before?.scopes ?? [],
            authParams: body.oauth?.authParams ?? before?.authParams ?? {},
          }
        : null
    // A secret belongs to the server or program it was given for: another address, command, kind, auth or OAuth
    // client forgets the sign-in and the saved values, so an edit never sends one to a new host or program. Cody's own
    // OAuth client secret stays unless the client changed.
    const clientChanged = !!(oauth && before && (oauth.clientKind !== before.clientKind || oauth.clientId !== before.clientId || (oauth.issuer ?? null) !== (before.issuer ?? null)))
    const moved =
      clientChanged ||
      shape.kind !== current.kind ||
      shape.auth !== current.auth ||
      shape.url !== current.url ||
      shape.command !== current.command ||
      (shape.kind === "stdio" && body.args !== undefined && JSON.stringify(body.args) !== JSON.stringify(current.args))
    const sets: string[] = []
    const args: unknown[] = []
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v))
    if (shape.name !== current.name) set("name", shape.name)
    if (body.label !== undefined) set("label", body.label)
    if (body.preset !== undefined) set("preset", body.preset)
    set("kind", shape.kind)
    set("url", shape.url)
    set("command", shape.command)
    if (body.args !== undefined || shape.kind !== "stdio") set("args_json", JSON.stringify(shape.kind === "stdio" ? (body.args ?? current.args) : []))
    if (body.env !== undefined || shape.kind !== "stdio") set("env_json", JSON.stringify(shape.kind === "stdio" ? (body.env ?? current.env) : {}))
    set("auth", shape.auth)
    if (body.header !== undefined) {
      set("header_name", body.header.name)
      set("header_prefix", body.header.prefix)
    }
    set("token_env", shape.tokenEnv)
    // Moved: the OAuth state keeps its configuration, not what the old server's discovery and sign-in found.
    set("oauth_json", oauth ? JSON.stringify(moved ? oauth : { ...before, ...oauth }) : null)
    if (scope) set("scope_json", JSON.stringify(scope))
    if (body.enabled !== undefined) set("enabled", body.enabled ? 1 : 0)
    set("updated_at", Date.now())
    const keep = secretsFor(shape.kind, shape.auth, oauth?.clientKind ?? null)
    this.d.db.transaction(() => {
      this.d.db.prepare(`UPDATE connectors SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
      for (const s of this.secretRows(id)) if (!keep(s.name) || (moved && (s.name !== "client_secret" || clientChanged))) this.dropSecret(id, s.name)
      if (moved) this.d.db.prepare("UPDATE connectors SET status = ?, status_detail = NULL, test_json = NULL WHERE id = ?").run(shape.auth === "oauth" || shape.auth === "token" ? "needs_auth" : "untested", id)
    })()
    this.changed()
    return this.require(id)
  }

  /** A deleted project leaves every connector's chosen projects. */
  projectDeleted(projectId: string) {
    let changed = false
    for (const r of this.d.db.prepare("SELECT * FROM connectors").all() as ConnectorRow[]) {
      const scope = this.scopeOf(r)
      if (!scope.projects?.includes(projectId)) continue
      this.d.db.prepare("UPDATE connectors SET scope_json = ? WHERE id = ?").run(JSON.stringify({ ...scope, projects: scope.projects.filter((p) => p !== projectId) }), r.id)
      changed = true
    }
    if (changed) this.changed()
  }

  delete(id: string) {
    this.require(id)
    for (const s of this.secretRows(id)) this.retire(s)
    this.d.db.prepare("DELETE FROM connectors WHERE id = ?").run(id)
    this.changed()
  }

  /** Save a secret (a token, a client secret, an env value or a sign-in's tokens). */
  saveSecret(id: string, name: string, value: unknown, o: { expiresAt?: number | null } = {}) {
    const c = this.require(id)
    if (!SECRET_NAME.test(name)) throw new BadRequestError(`${name} isn't a secret a connector keeps.`)
    if (!secretsFor(c.kind, c.auth, c.oauth?.clientKind ?? null)(name)) throw new BadRequestError(`This connector doesn't use ${name.startsWith("env:") ? `a secret env var (it isn't a command)` : `a ${name.replace(/_/g, " ")}`}.`)
    const v = parse(secretValue, value)
    if (name.startsWith("env:") && name.slice(4) in c.env) throw new BadRequestError(`${name.slice(4)} is one of its plain env vars: remove it there first.`)
    this.putSecret(id, name, v, o.expiresAt ?? null)
    if (name === "token") this.setStatus(id, "untested", null)
    this.changed()
  }

  removeSecret(id: string, name: string) {
    this.require(id)
    this.dropSecret(id, name)
    this.changed()
  }

  /** A secret's value, server-side only: for a session's MCP config, a test or a refresh. null when absent or unreadable. */
  secret(id: string, name: string): string | null {
    const row = this.d.db.prepare("SELECT ciphertext FROM connector_secrets WHERE connector_id = ? AND name = ?").get(id, name) as { ciphertext: string } | undefined
    return row ? this.d.secrets.open(row.ciphertext) : null
  }

  /** A connector's secret env vars, by name. */
  secretEnv(id: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const s of this.secretRows(id)) {
      if (!s.name.startsWith("env:")) continue
      const v = this.d.secrets.open(s.ciphertext)
      if (v !== null) out[s.name.slice(4)] = v
    }
    return out
  }

  /** The secret env vars a connector has saved, readable or not (a session leaves out a command missing one). */
  secretEnvNames(id: string): string[] {
    return this.secretRows(id)
      .filter((s) => s.name.startsWith("env:"))
      .map((s) => s.name.slice(4))
  }

  /** What a sign-in or refresh got: the access token (and a refresh token when there's a new one), saved together. */
  saveTokens(id: string, t: { accessToken: string; refreshToken?: string | null; expiresAt: number | null }, state: Partial<OAuthState>) {
    const current = this.oauthState(id)
    if (!current) throw new BadRequestError("This connector doesn't sign in with OAuth.")
    this.d.db.transaction(() => {
      this.putSecret(id, "access_token", t.accessToken, t.expiresAt)
      if (t.refreshToken) this.putSecret(id, "refresh_token", t.refreshToken, null)
      this.d.db.prepare("UPDATE connectors SET oauth_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...current, ...state }), Date.now(), id)
    })()
    this.changed()
  }

  /** Discovery and registration results, kept so a refresh or the next sign-in needn't ask again. */
  saveOAuthState(id: string, state: Partial<OAuthState>) {
    const current = this.oauthState(id)
    if (!current) return
    this.d.db.prepare("UPDATE connectors SET oauth_json = ? WHERE id = ?").run(JSON.stringify({ ...current, ...state }), id)
  }

  /** Forget a sign-in: its tokens go, and the connector needs signing in again. */
  signOut(id: string, detail: string | null = null) {
    this.require(id)
    this.d.db.transaction(() => {
      this.dropSecret(id, "access_token")
      this.dropSecret(id, "refresh_token")
      this.d.db.prepare("UPDATE connectors SET status = 'needs_auth', status_detail = ?, updated_at = ? WHERE id = ?").run(detail, Date.now(), id)
    })()
    this.changed()
  }

  setStatus(id: string, status: ConnectorStatus, detail: string | null) {
    const r = this.row(id)
    if (!r || (r.status === status && r.status_detail === detail)) return
    this.d.db.prepare("UPDATE connectors SET status = ?, status_detail = ? WHERE id = ?").run(status, detail, id)
    this.changed()
  }

  setTest(id: string, test: ConnectorTest) {
    if (!this.row(id)) return
    this.d.db.prepare("UPDATE connectors SET test_json = ? WHERE id = ?").run(JSON.stringify(test), id)
    this.changed()
  }

  /** Every connector secret in effect (and access tokens this process replaced), for redaction; cached until one changes. */
  secretValues(): string[] {
    if (this.secretCache) return this.secretCache
    const rows = this.d.db.prepare("SELECT ciphertext FROM connector_secrets").all() as { ciphertext: string }[]
    this.secretCache = [...rows.map((r) => this.d.secrets.open(r.ciphertext) ?? "").filter(Boolean), ...this.retired]
    return this.secretCache
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---------- helpers ----------

  private putSecret(id: string, name: string, value: string, expiresAt: number | null) {
    const old = this.d.db.prepare("SELECT * FROM connector_secrets WHERE connector_id = ? AND name = ?").get(id, name) as SecretRow | undefined
    if (old) this.retire(old)
    this.d.db
      .prepare(
        `INSERT INTO connector_secrets (connector_id, name, ciphertext, fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (connector_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at, created_at = excluded.created_at`,
      )
      .run(id, name, this.d.secrets.seal(value), tokenFingerprint(value), expiresAt, Date.now())
    this.d.db.prepare("UPDATE connectors SET updated_at = ? WHERE id = ?").run(Date.now(), id)
    this.secretCache = null
  }

  private dropSecret(id: string, name: string) {
    const old = this.d.db.prepare("SELECT * FROM connector_secrets WHERE connector_id = ? AND name = ?").get(id, name) as SecretRow | undefined
    if (!old) return
    this.retire(old)
    this.d.db.prepare("DELETE FROM connector_secrets WHERE connector_id = ? AND name = ?").run(id, name)
    this.secretCache = null
  }

  /** A replaced or removed value stays on the redaction list for this process's life (the newest 50). */
  private retire(row: SecretRow) {
    const v = this.d.secrets.open(row.ciphertext)
    if (!v) return
    this.retired.push(v)
    if (this.retired.length > 50) this.retired.shift()
    this.secretCache = null
  }

  private changed() {
    this.secretCache = null
    for (const fn of this.listeners) fn()
  }

  /** No other connector has the name, or one that differs only in - and _ (they'd share their env var names, connectorVar). */
  private requireFreeName(name: string, except?: string) {
    const rows = this.d.db.prepare("SELECT name FROM connectors WHERE id != ?").all(except ?? "") as { name: string }[]
    const taken = rows.find((r) => connectorVar(r.name) === connectorVar(name))
    if (taken?.name === name) throw new ConflictError(`There's a connector named ${name} already: pick another name.`)
    if (taken) throw new ConflictError(`${name} is too like ${taken.name}, another connector's name (only - and _ differ): pick another name.`)
  }

  /** The fields that must fit together: a remote server has an https address, a command has a command, and so on. */
  private checkShape(s: {
    name: string
    kind: ConnectorKind
    url: string | null
    command: string | null
    auth: ConnectorAuth
    tokenEnv: string | null
    oauth: { clientKind?: OAuthClientKind; clientId?: string | null; issuer?: string | null } | null
  }) {
    const name = s.name.trim().toLowerCase()
    if (!CONNECTOR_NAME_RE.test(name)) throw new BadRequestError("A connector's name is lowercase letters, digits, - and _, starting with a letter (it becomes its tools' prefix, like mcp__gmail__search).")
    // mcp__a__b would read as server a's tool b in a permission rule.
    if (name.includes("__")) throw new BadRequestError("A connector's name can't hold __ (its tools are mcp__<name>__<tool>).")
    if ((RESERVED_CONNECTOR_NAMES as readonly string[]).includes(name)) throw new BadRequestError(`${name} is Box Yard's own MCP server: pick another name.`)
    if (s.kind === "stdio") {
      if (!s.command) throw new BadRequestError("A command connector needs its command (like npx).")
      if (s.auth === "oauth" || s.auth === "token") {
        if (!s.tokenEnv) throw new BadRequestError("Name the env var its token goes in (tokenEnv), like GOOGLE_ACCESS_TOKEN.")
      }
    } else {
      if (!s.url) throw new BadRequestError("A remote connector needs its server's address.")
      checkServerUrl(s.url)
      if (s.auth === "env") throw new BadRequestError("Secret env vars are for command connectors; a remote server takes a token.")
    }
    if (s.auth === "oauth") {
      const kind = s.oauth?.clientKind ?? "dynamic"
      if (kind !== "dynamic" && !s.oauth?.clientId) throw new BadRequestError("Give the client id of the OAuth client you made, or let Box Yard register one (dynamic).")
      if (s.oauth?.issuer) checkServerUrl(s.oauth.issuer, "The authorization server")
      if (s.kind === "stdio" && kind === "dynamic" && !s.oauth?.issuer) throw new BadRequestError("A command can't be asked where to sign in: give the authorization server (issuer).")
    }
    return { name, kind: s.kind, url: s.kind === "stdio" ? null : s.url, command: s.kind === "stdio" ? s.command : null, auth: s.auth, tokenEnv: s.kind === "stdio" ? s.tokenEnv : null }
  }

  private checkScope(scope: ConnectorScope): ConnectorScope {
    const sessions = CONNECTOR_SESSIONS.filter((x) => scope.sessions.includes(x))
    const runners = RUNNERS.filter((x) => scope.runners.includes(x))
    const projects = scope.projects ? [...new Set(scope.projects)] : null
    for (const p of projects ?? []) if (!this.d.projectExists(p)) throw new BadRequestError(`There's no project ${p}.`)
    if (sessions.includes("agent") && !runners.length) throw new BadRequestError("Pick at least one runner its agents may be on.")
    // A connector the Coordinator uses would carry a sealed project's content to it (docs/connectors.md).
    if (sessions.includes("coordinator") && sessions.some((x) => x !== "coordinator") && projects) {
      const sealed = projects.filter((p) => this.d.statusOnly(p))
      if (sealed.length) {
        const names = sealed.map((p) => this.d.projectName(p) ?? p).join(", ")
        throw new BadRequestError(`${names} ${sealed.length === 1 ? "shows" : "show"} the Coordinator status only, so a connector the Coordinator uses can't reach ${sealed.length === 1 ? "it" : "them"}: it'd carry their content to the Coordinator. Untick the Coordinator, or leave ${sealed.length === 1 ? "it" : "them"} out.`)
      }
    }
    return { sessions, projects, runners }
  }
}

/** One line on where a connector reaches, for the MCP tool and errors. */
export function scopeLine(scope: ConnectorScope, projectName: (id: string) => string | null): string {
  const who = scope.sessions.length ? scope.sessions.map((s: ConnectorSession) => (s === "coordinator" ? "the Coordinator" : s === "captain" ? "Captains" : "agents")).join(", ") : "nobody"
  const projects = scope.sessions.some((s) => s !== "coordinator") ? (scope.projects ? ` of ${scope.projects.map((p) => projectName(p) ?? p).join(", ")}` : " of every project") : ""
  const runners = scope.sessions.includes("agent") ? ` (agents on ${scope.runners.join(", ")})` : ""
  return `${who}${projects}${runners}`
}
