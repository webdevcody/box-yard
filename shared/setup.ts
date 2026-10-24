// First-run setup and Settings › Credentials: the keys Box Yard needs to do real work. The browser only ever
// sees whether each one is set and where it comes from, never a value.
import type { SettingSource } from "./types.js"

export const CREDENTIAL_KEYS = ["upstashBoxApiKey", "claudeOauthToken", "anthropicApiKey", "githubToken"] as const
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]

/** An env var on the server (it wins, and can't be changed here) or a value saved in the app. */
export type CredentialSource = "env" | "saved"

export interface CredentialStatus {
  state: "set" | "unset"
  source: CredentialSource | null
}

/** GET /api/setup. */
export interface SetupStatus {
  /** Every required item is set, so the Coordinator can run. */
  ready: boolean
  /** What's still needed, in setup order ("Upstash Box API key", "Claude sign-in"). */
  missing: string[]
  /** Mock mode (or a fake claude): nothing is required. */
  mock: boolean
  credentials: Record<CredentialKey, CredentialStatus>
  boxes: {
    /** Where new boxes are made right now. */
    provider: string
    /** False when BOX_PROVIDER=local (or mock mode) keeps every box on the server's machine. */
    required: boolean
  }
  claude: {
    required: boolean
    state: "set" | "unset"
    /** The credential agents use. With both set, Claude Code uses the API key. */
    using: "claudeOauthToken" | "anthropicApiKey" | null
  }
  github: { state: "set" | "unset" }
  owner: { name: string; source: SettingSource }
  /** What a saved value can't change until the server restarts, in plain words. Empty when everything is live. */
  restart: string[]
}

/** PUT /api/setup/credentials: a new value, or null to forget the saved one. */
export type CredentialsPatch = Partial<Record<CredentialKey, string | null>>

/** POST /api/setup/test/:key. `message` never contains a secret. */
export interface CredentialTest {
  ok: boolean
  message: string
  ms: number
}

/** GET /api/setup/repos: the GitHub token's most recently pushed repos ("owner/name"), for Zen's first prompts. */
export interface RecentRepos {
  repos: string[]
}

/** What the setup card and Settings › Credentials say about each credential. */
export const CREDENTIAL_INFO: Record<
  CredentialKey,
  { label: string; env: string; placeholder: string; help: string; link: { href: string; label: string } }
> = {
  upstashBoxApiKey: {
    label: "Upstash Box API key",
    env: "UPSTASH_BOX_API_KEY",
    placeholder: "Paste your Box API key",
    help: "The cloud boxes your agents work in.",
    link: { href: "https://console.upstash.com", label: "Create one in the Upstash console" },
  },
  claudeOauthToken: {
    label: "Claude subscription token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    placeholder: "sk-ant-oat01-…",
    help: "Uses your Claude Pro or Max plan, with no per-call charges.",
    link: { href: "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token", label: "How setup-token works" },
  },
  anthropicApiKey: {
    label: "Anthropic API key",
    env: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api03-…",
    help: "Pay per use, billed to your Claude Console account.",
    link: { href: "https://platform.claude.com/settings/keys", label: "Create one in the Claude Console" },
  },
  githubToken: {
    label: "GitHub token",
    env: "GITHUB_TOKEN",
    placeholder: "github_pat_…",
    help: "Lets agents clone repos, push branches and open PRs, and lets Box Yard follow PR state.",
    link: {
      href: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token",
      label: "Create a fine-grained token",
    },
  },
}

/** The repository permissions a GitHub token needs, as GitHub's fine-grained token form names them. */
export const GITHUB_TOKEN_SCOPES = "Contents and Pull requests: read and write · Metadata: read"

/** The command that prints a Claude subscription token. */
export const SETUP_TOKEN_COMMAND = "claude setup-token"
