// First-run setup and Settings › Credentials: the keys Box Yard needs to do real work. The browser only ever
// sees whether each one is set and where it comes from, never a value.
import type { SettingSource } from "./types.js"
import type { Runner } from "./runner.js"

export const CREDENTIAL_KEYS = ["upstashBoxApiKey", "claudeOauthToken", "anthropicApiKey", "codexAuthJson", "codexApiKey", "githubToken", "runpodApiKey", "vastApiKey"] as const
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]

/**
 * An env var on the server (it wins, and can't be changed here), a value saved in the app, or (GitHub only, once
 * agents run on this computer) the computer's own `gh auth` login.
 */
export type CredentialSource = "env" | "saved" | "gh"

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
  /**
   * Codex (docs/codex.md): needed only when the Coordinator, the Captains or a project's agents run on it. `using` is
   * the login Box Yard hands Codex: the ChatGPT login when both are set. `required`: the Coordinator runs on Codex.
   */
  codex: {
    required: boolean
    state: "set" | "unset"
    using: "codexAuthJson" | "codexApiKey" | null
  }
  github: { state: "set" | "unset" }
  owner: { name: string; source: SettingSource }
  runner: {
    /** Where the owner chose to run agents during setup, or null before they chose. */
    choice: Runner | null
    /** What new projects start with: the choice, else "box" (installs from before the choice existed). */
    default: Runner
  }
  /** Projects can pick "Upstash box": an Upstash key is set (or boxes are local folders: mock, BOX_PROVIDER=local). */
  upstash: { available: boolean }
  /** What this computer has for local agents. Null until "This computer" is chosen. */
  local: LocalCheck | null
  /** What a saved value can't change until the server restarts, in plain words. Empty when everything is live. */
  restart: string[]
  /**
   * Projects whose last turn committed as the fallback author ("Box Yard Agent", unsigned): nothing earlier in the
   * author chain (server/gitAuthor.ts) gave one. Settings › Credentials and Identities warn while any are listed.
   */
  authorFallbacks: AuthorFallback[]
}

/** The git author of last resort (server/gitAuthor.ts): a turn gets it only when nothing else names one. */
export const FALLBACK_GIT_AUTHOR = { name: "Box Yard Agent", email: "box-yard@users.noreply.github.com" } as const

/** A project whose last turn's commits went out under the fallback author (SetupStatus.authorFallbacks). */
export interface AuthorFallback {
  projectId: string
  project: string
  taskId: string
  task: string
  at: number
  /** Why each step of the author chain gave none. */
  why: string
}

/** One thing local agents use on this computer. */
export interface LocalTool {
  key: LocalToolKey
  found: boolean
  /** `--version`'s first line, when it ran. */
  version: string | null
}

export const LOCAL_TOOL_KEYS = ["node", "claude", "codex", "gh", "chrome"] as const
export type LocalToolKey = (typeof LOCAL_TOOL_KEYS)[number]

/** The local runner's prerequisites (#120), as the setup card and Settings › Credentials list them. */
export const LOCAL_TOOL_INFO: Record<LocalToolKey, { label: string; required: boolean; help: string; link: { href: string; label: string } }> = {
  node: { label: "Node.js", required: true, help: "Runs Box Yard's runner beside each agent.", link: { href: "https://nodejs.org/en/download", label: "Download Node.js" } },
  claude: {
    label: "Claude Code",
    required: true,
    help: "The agents themselves.",
    link: { href: "https://code.claude.com/docs/en/setup", label: "Install Claude Code" },
  },
  codex: {
    label: "Codex",
    required: false,
    help: "Only for agents set to run on Codex. Signed in (codex login), it needs no key here.",
    link: { href: "https://developers.openai.com/codex/cli", label: "Install Codex" },
  },
  gh: {
    label: "GitHub CLI",
    required: false,
    help: "Agents use it to open PRs. Signed in (gh auth login), it can stand in for a GitHub token.",
    link: { href: "https://cli.github.com", label: "Install gh" },
  },
  chrome: {
    label: "Chrome",
    required: false,
    help: "For agents that check their work in a real browser.",
    link: { href: "https://www.google.com/chrome", label: "Get Chrome" },
  },
}

/** GET /api/setup's `local`: found tools and logins on the computer running Box Yard. Never holds a secret. */
export interface LocalCheck {
  tools: LocalTool[]
  /** `claude auth status` says this computer's claude is signed in; null when it couldn't tell (older CLI, mock). */
  claudeLogin: boolean | null
  /** `codex login status` says this computer's codex is signed in; null when it couldn't tell (not installed, mock). */
  codexLogin?: boolean | null
  /** `gh auth status` succeeded. */
  ghLogin: boolean
  checkedAt: number
}

/** PUT /api/setup/runner. */
export interface RunnerChoice {
  runner: Runner
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
    help: "The isolated cloud boxes your agents work in.",
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
  codexAuthJson: {
    label: "Codex ChatGPT login",
    env: "CODEX_AUTH_JSON",
    placeholder: '{"auth_mode":"chatgpt","tokens":{…}} (paste all of ~/.codex/auth.json)',
    help: "Uses your ChatGPT plan for agents that run on Codex. Box Yard keeps the copy Codex refreshes, so log in once.",
    link: { href: "https://developers.openai.com/codex/auth", label: "How Codex logins work" },
  },
  codexApiKey: {
    label: "OpenAI API key for Codex",
    env: "CODEX_API_KEY",
    placeholder: "sk-proj-…",
    help: "Pay per use instead, billed to your OpenAI Platform account. Used when there's no ChatGPT login.",
    link: { href: "https://platform.openai.com/api-keys", label: "Create one on the OpenAI Platform" },
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
  runpodApiKey: {
    label: "RunPod API key",
    env: "RUNPOD_API_KEY",
    placeholder: "rpa_…",
    help: "Optional: lets projects run on RunPod GPU pods (Settings › RunPod GPU).",
    link: { href: "https://www.runpod.io/console/user/settings", label: "Create one in RunPod's settings" },
  },
  vastApiKey: {
    label: "Vast.ai API key",
    env: "VAST_API_KEY",
    placeholder: "64 hex characters",
    help: "Optional: lets projects run on Vast.ai GPU instances (Settings › Vast.ai GPU).",
    link: { href: "https://cloud.vast.ai/manage-keys/", label: "Create one in Vast.ai's Keys page" },
  },
}

/** The repository permissions a GitHub token needs, as GitHub's fine-grained token form names them. */
export const GITHUB_TOKEN_SCOPES = "Contents and Pull requests: read and write · Metadata: read"

/** The command that signs Codex in and writes ~/.codex/auth.json. */
export const CODEX_LOGIN_COMMAND = "codex login"
/** Where that login lands. */
export const CODEX_AUTH_FILE = "~/.codex/auth.json"

/** The command that prints a Claude subscription token. */
export const SETUP_TOKEN_COMMAND = "claude setup-token"
