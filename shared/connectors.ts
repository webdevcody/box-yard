// External MCP connectors (docs/connectors.md): MCP servers Box Yard passes into some of its Claude Code sessions, like
// Gmail, Notion or Linear. Each is a remote server (a URL) or a command, signs in with OAuth, a token or secret env vars,
// and says who gets it: the Coordinator, Captains and/or agents, of all or chosen projects, on which runners.
// The browser, the API and the model only ever see what's here: never a token, key or secret env value.
import type { Runner } from "./runner.js"

/** `http`: Streamable HTTP; `sse`: the older HTTP+SSE transport; `stdio`: a command next to the session. */
export const CONNECTOR_KINDS = ["http", "sse", "stdio"] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * `oauth`: the MCP OAuth flow (or a provider's own OAuth client, for Google); `token`: an API key or token sent as a
 * header (or, for a command, in an env var); `env`: a command's secret env vars only; `none`.
 */
export const CONNECTOR_AUTHS = ["none", "oauth", "token", "env"] as const
export type ConnectorAuth = (typeof CONNECTOR_AUTHS)[number]

/** The kinds of session a connector can reach. Side threads never get one: they're read-only. */
export const CONNECTOR_SESSIONS = ["coordinator", "captain", "agent"] as const
export type ConnectorSession = (typeof CONNECTOR_SESSIONS)[number]

export const CONNECTOR_SESSION_LABEL: Record<ConnectorSession, string> = { coordinator: "Coordinator", captain: "Captains", agent: "Agents" }

/**
 * `connected`: signed in (or needs no sign-in) and its last test or refresh worked; `needs_auth`: never signed in, or
 * the provider refused the refresh token, so Cody signs in again; `error`: the last test or refresh failed for another
 * reason (statusDetail says which); `untested`: saved, not tried yet.
 */
export const CONNECTOR_STATUSES = ["connected", "needs_auth", "error", "untested"] as const
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number]

/**
 * Whose OAuth client signs in: `dynamic`, one Box Yard registers itself with the provider (RFC 7591, what MCP servers
 * offer); `desktop` or `web`, one Cody made at the provider (Google), whose kind decides the redirect address.
 */
export const OAUTH_CLIENT_KINDS = ["dynamic", "desktop", "web"] as const
export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number]

/** Who gets a connector. */
export interface ConnectorScope {
  sessions: ConnectorSession[]
  /** Projects whose Captains and agents get it; null for every project. */
  projects: string[] | null
  /** Runners an agent's turn must be on to get it. The Coordinator and Captains run on this computer. */
  runners: Runner[]
}

/** The safest start: the Coordinator only (no shell, on this computer), and agents on this computer when ticked. */
export const DEFAULT_CONNECTOR_SCOPE: ConnectorScope = { sessions: ["coordinator"], projects: null, runners: ["local"] }

/** A stored secret, as anyone but the server sees it. */
export interface ConnectorSecretView {
  /** `token`, `access_token`, `refresh_token`, `client_secret`, or `env:<NAME>`. */
  name: string
  /** sha256, first 12 hex. */
  fingerprint: string
  /** False when this server's secret key can't open it: it needs saving (or signing in) again. */
  readable: boolean
  /** Epoch ms, for an access token. */
  expiresAt: number | null
  savedAt: number
}

/** The OAuth side of a connector: configuration and state, never a token. */
export interface ConnectorOAuth {
  clientKind: OAuthClientKind
  /** The client id: registered by Box Yard (dynamic) or Cody's own. Public. */
  clientId: string | null
  /** Cody's own client has a secret saved (Google's Desktop clients have one, though it isn't confidential). */
  hasClientSecret: boolean
  /** The authorization server: discovered from the MCP server, or the preset's (https://accounts.google.com). */
  issuer: string | null
  /** The host Cody signs in at, shown before he goes. */
  signInHost: string | null
  /** Scopes asked for; empty: what the server says it needs. */
  scopes: string[]
  /** Scopes the provider granted, when it said. */
  grantedScopes: string[] | null
  /** Extra authorization parameters (Google: access_type=offline, prompt=consent). */
  authParams: Record<string, string>
  /** Whether a refresh token is held, so it renews by itself. */
  refreshable: boolean
  /** When the access token runs out (epoch ms), if it does. */
  expiresAt: number | null
  /** The redirect address the last sign-in used. */
  redirectUri: string | null
  signedInAt: number | null
}

export interface ConnectorTool {
  name: string
  description: string
}

export interface ConnectorTest {
  at: number
  ok: boolean
  /** The tools it exposes, when it answered. */
  tools: ConnectorTool[]
  /** Why it failed; never a secret. */
  error: string | null
}

/** GET /api/connectors. */
export interface Connector {
  id: string
  /** The MCP server name sessions see (`gmail`): tools are mcp__<name>__<tool>. */
  name: string
  /** What Settings shows ("Gmail"). */
  label: string
  /** The preset it was made from, if any (shared/connectorPresets.ts). */
  preset: string | null
  kind: ConnectorKind
  url: string | null
  command: string | null
  args: string[]
  /** A command's env vars that aren't secret. Secret ones are in `secrets` as env:<NAME>. */
  env: Record<string, string>
  auth: ConnectorAuth
  /** The header a token (or OAuth access token) goes in, for a remote server. */
  header: { name: string; prefix: string }
  /** The env var a token (or OAuth access token) goes in, for a command. */
  tokenEnv: string | null
  oauth: ConnectorOAuth | null
  secrets: ConnectorSecretView[]
  scope: ConnectorScope
  enabled: boolean
  status: ConnectorStatus
  statusDetail: string | null
  lastTest: ConnectorTest | null
  /**
   * Status-only projects its scope covers that don't get it, because the Coordinator uses it too: it'd carry their
   * content to the Coordinator (docs/connectors.md › Status-only identities).
   */
  sealedSkipped: string[]
  createdAt: number
  updatedAt: number
}

/** POST /api/connectors, PATCH /api/connectors/:id. Secrets have routes of their own. */
export interface ConnectorInput {
  name?: string
  label?: string
  preset?: string | null
  kind?: ConnectorKind
  url?: string | null
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  auth?: ConnectorAuth
  header?: { name: string; prefix: string }
  tokenEnv?: string | null
  oauth?: { clientKind?: OAuthClientKind; clientId?: string | null; issuer?: string | null; scopes?: string[]; authParams?: Record<string, string> } | null
  scope?: ConnectorScope
  enabled?: boolean
}

/** POST /api/connectors/:id/oauth/start. */
export interface ConnectorSignIn {
  /** Open it in a new tab: the provider's sign-in page. */
  authorizeUrl: string
  redirectUri: string
  /**
   * `redirect`: the provider sends the browser back to Box Yard, which finishes by itself. `paste`: the address it lands
   * on won't load (a loopback address on another device); Cody pastes it into the dialog (POST …/oauth/complete).
   */
  mode: "redirect" | "paste"
  signInHost: string
  /** Why it's paste mode, for the dialog. */
  note: string | null
}

/** A connector name: the MCP server name sessions see. Lowercase, starts with a letter, never Box Yard's own. */
export const CONNECTOR_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/
export const RESERVED_CONNECTOR_NAMES = ["boxyard"] as const

/** The env var name a connector's secret reaches a session in (the MCP config only names it: ${VAR}). */
export const connectorVar = (name: string, part = "TOKEN") => `BOXYARD_CONNECTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${part}`

/** Where the OAuth provider sends the browser back to, under Box Yard's origin. */
export const OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback"
