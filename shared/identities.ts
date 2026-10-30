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
  /** null: the author chain's next step (server/gitAuthor.ts): Settings › Credentials › Git author, and on. */
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

// ---- Detection (docs/identities.md › Set up from this computer): what this computer's gh, git and ssh already use,
// as evidence and proposals. Never a value: tokens and keys are named by reference ("gh:github.com:octocat",
// "file:~/.ssh/acme_signing"), and only the server resolves a reference, when an identity is created or imported.

/** A GitHub account `gh` is signed in to on this computer. */
export interface DetectedAccount {
  host: string
  login: string
  /** gh's active account for the host. */
  active: boolean
  /** gh's git protocol for the host ("https", "ssh"); Box Yard's turns always push over HTTPS with the token. */
  protocol: string | null
  /** A classic token's scopes; null when gh didn't say (a fine-grained token, or an old gh). */
  scopes: string[] | null
  /** Where gh keeps the token: "keyring", or a hosts.yml path. */
  storage: string | null
  /** The reference create_identity and import_detected_identity resolve on the server. */
  tokenRef: string
  // From GitHub, when detection may ask it (online); null otherwise.
  githubId: number | null
  name: string | null
  orgs: string[] | null
  verifiedEmails: string[] | null
  /** Fingerprints of the SSH keys it signs commits with on GitHub. */
  signingKeys: string[] | null
  /** Fingerprints of the SSH keys it logs in (pushes) with on GitHub. */
  sshKeys: string[] | null
  problem: string | null
}

/** A commit signing setup found in a git config. */
export interface DetectedSigning {
  format: "ssh" | "openpgp" | "x509"
  /** "file": a key file without a passphrase, which Box Yard can keep; "agent": one only an agent (or 1Password) can use. */
  kind: "file" | "agent" | null
  /** What to import: "file:<path>" or "agent:<fingerprint>"; null when nothing can be. */
  ref: string | null
  publicKey: string | null
  fingerprint: string | null
  /** gpg.ssh.program, when it isn't ssh-keygen (1Password's op-ssh-sign). */
  program: string | null
  /** commit.gpgsign: git signs every commit there without being asked. */
  signsByDefault: boolean
  /** Why it can't be imported as it is. */
  problem: string | null
  /** Why importing it may be unwise (it's also a key this computer logs in to servers with). */
  warning: string | null
}

/** A git author: the global one, or an includeIf block's (with the global values it doesn't override). */
export interface DetectedAuthor {
  /** "global", or the includeIf condition ("gitdir:~/work/acme/", "hasconfig:remote.*.url:https://github.com/acme/**"). */
  scope: string
  file: string
  name: string | null
  email: string | null
  signing: DetectedSigning | null
  /** The key core.sshCommand pushes with (-i), as evidence of the account. */
  sshKey: string | null
  sshKeyFingerprint: string | null
  /** GitHub owners of the repos it applies to: remotes of the repos under its folder, or its hasconfig URL. */
  repoOwners: string[]
}

/** A ~/.ssh/config Host that reaches GitHub, as evidence (alias → key). */
export interface DetectedSshHost {
  alias: string
  keyFile: string | null
  keyFingerprint: string | null
  /** IdentityAgent: 1Password's agent socket, say. */
  agent: string | null
}

export interface ProposedProject {
  id: string
  name: string
  repo: string
  why: string
  /** The identity it uses now. */
  currentIdentity: string
}

/** One identity detection suggests, for one gh account. */
export interface IdentityProposal {
  name: string
  login: string
  host: string
  tokenRef: string
  owners: string[]
  author: { name: string; email: string; from: string } | null
  signing: DetectedSigning | null
  /** The projects that should use it. */
  projects: ProposedProject[]
  /** The Default identity's token is this account already: projects that stay on Default need nothing. */
  isDefaultToday: boolean
  /** An identity Box Yard already has for this login: importing updates it instead of making another. */
  existing: { id: string; name: string } | null
  evidence: string[]
}

export interface IdentityDetection {
  at: number
  /** Whether GitHub was asked (orgs, emails, keys, push access); offline, only this computer was read. */
  online: boolean
  accounts: DetectedAccount[]
  authors: DetectedAuthor[]
  sshHosts: DetectedSshHost[]
  /** git's credential helpers here, by name ("osxkeychain"); turns don't use them. */
  credentialHelpers: string[]
  proposals: IdentityProposal[]
  /** Projects no account here clearly owns: they stay where they are. */
  unmatched: ProposedProject[]
  notes: string[]
}

/** A GitHub owner or login: letters, digits and single hyphens, up to 39 characters. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** "the Acme identity", for sentences. */
export const identityPhrase = (i: Pick<Identity, "name" | "isDefault">) => (i.isDefault ? "the Default identity" : `the ${i.name} identity`)
