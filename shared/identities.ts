// Project identities (docs/identities.md): who acts for a project. A GitHub login with one or more tokens, the
// owners it serves, a git author, an optional signing key, an optional Claude login, the runners it may use and how
// much the Coordinator may see. Each project has exactly one; the Default identity is Settings › Credentials.
// The browser, the API and the model only ever see what's here: logins, emails, owners, fingerprints, never a value.
import type { Runner } from "./runner.js"

/** Every project starts on it: its missing parts are Settings › Credentials (env vars, saved values, `gh auth`). */
export const DEFAULT_IDENTITY_ID = "idn_default"

/** A dot's colour in the sidebar, project settings and task details. */
export const IDENTITY_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet", "orange", "teal"] as const
export type IdentityColor = (typeof IDENTITY_COLORS)[number]

/** How much of an identity's projects the Coordinator may see (Captains always see their own project). */
export const COORDINATOR_SEES = ["everything", "status"] as const
export type CoordinatorSees = (typeof COORDINATOR_SEES)[number]

/** The Claude credential an identity logs its agents in with; none uses the global one. */
export const IDENTITY_CLAUDE_KINDS = ["api_key", "oauth_token"] as const
export type IdentityClaudeKind = (typeof IDENTITY_CLAUDE_KINDS)[number]

/** Whether a git author email is one of the GitHub account's verified emails (or its noreply address). */
export type EmailCheck = "verified" | "unverified" | "unknown"

/** A GitHub token, as anyone but the server sees it. */
export interface IdentityToken {
  /** The owner (user or org) it's for; "" for every owner the identity serves. */
  owner: string
  /** sha256 of the token, first 12 hex: tells two tokens apart, can't be turned back into one. */
  fingerprint: string
  /** What GitHub said when it was saved (GET /user). */
  login: string
  /** A classic token's scopes; null for a fine-grained token (GitHub doesn't list them). */
  scopes: string[] | null
  /** Epoch ms; null when it doesn't expire or GitHub didn't say. */
  expiresAt: number | null
  /** Where it came from: "pasted", or a reference like "gh:github.com:octocat" (provenance only). */
  source: string
  /** False when this server's secret key can't open it (the key changed): it needs saving again, and turns don't get it. */
  readable: boolean
  savedAt: number
}

export interface IdentitySigning {
  format: "ssh" | "openpgp"
  /** "file": a key Box Yard holds (encrypted) and writes for each turn; "agent": a key only an agent can use. */
  kind: "file" | "agent"
  /** The public key ("ssh-ed25519 AAAA…") or the GPG key id. */
  publicKey: string
  /** "SHA256:…" for SSH keys. */
  fingerprint: string
  /** The program git signs with for an agent key (1Password's op-ssh-sign). */
  program: string | null
  /** Stop a push when one of its commits isn't signed by this key. */
  requireSigned: boolean
  /** A "file" key this server's secret key can't open (the key changed): turns don't sign until it's saved again. */
  readable: boolean
}

/** PUT /api/identities/:id/signing: a key Box Yard keeps, or one only this computer's SSH agent (or 1Password) holds. */
export type IdentitySigningInput =
  | { kind: "file"; privateKey: string; requireSigned?: boolean }
  | { kind: "agent"; publicKey: string; program?: string | null; requireSigned?: boolean }

export interface IdentityCheckResult {
  at: number
  ok: boolean
  /** One line per thing checked, e.g. "token for acme: octocat, repo, expires 12 Jan". Never a secret. */
  lines: string[]
}

/** GET /api/identities. */
export interface Identity {
  id: string
  name: string
  color: IdentityColor
  isDefault: boolean
  /** The GitHub account every token proved (GET /user); null until a token is saved. */
  githubLogin: string | null
  githubId: number | null
  /** Owners (users and orgs) whose repos it's for, e.g. ["acme-corp"]. */
  owners: string[]
  tokens: IdentityToken[]
  /** null: the repo's git author from Settings (GIT_USER_NAME / GIT_USER_EMAIL). */
  author: { name: string; email: string; emailCheck: EmailCheck } | null
  signing: IdentitySigning | null
  /** null: Settings › Credentials' Claude login. */
  claude: { kind: IdentityClaudeKind; fingerprint: string; readable: boolean } | null
  /** Runners its projects may use; null for every runner. */
  runners: Runner[] | null
  coordinatorSees: CoordinatorSees
  /** The projects that use it. */
  projectIds: string[]
  lastCheck: IdentityCheckResult | null
  createdAt: number
  updatedAt: number
}

/** POST /api/identities, PATCH /api/identities/:id. Secrets have routes of their own. */
export interface IdentityInput {
  name?: string
  color?: IdentityColor
  owners?: string[]
  author?: { name: string; email: string } | null
  runners?: Runner[] | null
  coordinatorSees?: CoordinatorSees
}

/** A GitHub owner or login: letters, digits and single hyphens, up to 39 characters. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** "the Acme identity", for sentences. */
export const identityPhrase = (i: Pick<Identity, "name" | "isDefault">) => (i.isDefault ? "the Default identity" : `the ${i.name} identity`)
