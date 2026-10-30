// Which credentials a turn's agent gets (task.json's env and unsetEnv). A box's own environment can still hold a
// credential another project's turn must not use (an Upstash box made before credentials left Box.create had the
// global Claude login and GitHub token in its env), so the turn names the ones the runner removes before it starts
// `claude`, as well as the ones it sets. What a project's own env vars don't set comes from its identity
// (server/identity/identities.ts `base`), and for the Default identity from Settings › Credentials.
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"

/** Env vars a `claude` process logs in with, strongest first (Claude Code's own order). */
export const CLAUDE_CREDENTIAL_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const

/** The GitHub token env vars that `gh` (GH_TOKEN first) and Box Yard's git credential helper (GITHUB_TOKEN) read. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const

/** The git author and committer env vars: they beat any user.name/user.email config, so a repo's can't change who commits. */
export const GIT_AUTHOR_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const

export interface TurnEnv {
  env: Record<string, string>
  /** Vars the runner removes from its own environment before adding `env`. */
  unsetEnv: string[]
  /** Whose Claude login the turn uses: its project's (or task's) env, Settings › Credentials, or none (local login). */
  claudeFrom: "project" | "global" | null
}

/**
 * The env of a `claude` process Box Yard runs on this server (the Coordinator, a Captain): the server's own, without
 * what would mark it a Claude Code session's child or the key identities' secrets are encrypted with. It logs in with
 * `own` (a project identity's Claude login), alone, or else with `global` (Settings › Credentials) over the server's.
 */
export function serverClaudeEnv(own: Record<string, string> | null, global: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
  // When Box Yard itself was started from inside a Claude Code session, don't let `claude` think it is that session's child.
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
  delete env.BOXYARD_SECRET_KEY
  if (own) for (const k of CLAUDE_CREDENTIAL_VARS) delete env[k]
  return Object.assign(env, own ?? global)
}

/**
 * The prompt cache's TTL for a server-side `claude` (Settings › 1-hour prompt cache): 1h keeps a Coordinator's or a
 * Captain's context cached across the gaps between Cody's messages, so the first step after more than 5 minutes idle
 * reads it instead of writing it all again. CLAUDE_CODE_PROMPT_CACHE_TTL beats a settings.json promptCacheTtl and
 * ENABLE_PROMPT_CACHING_1H; FORCE_PROMPT_CACHING_5M beats them all, so it goes when 1h is on (checked on CLI 2.1.293).
 */
export function withPromptCacheTtl(env: NodeJS.ProcessEnv, oneHour: boolean): NodeJS.ProcessEnv {
  if (oneHour) {
    delete env.FORCE_PROMPT_CACHING_5M
    return Object.assign(env, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", ENABLE_PROMPT_CACHING_1H: "1" })
  }
  delete env.ENABLE_PROMPT_CACHING_1H
  return Object.assign(env, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })
}

/** The strongest Claude credential in `env`, as a one-var env; empty values don't count. */
function strongestClaude(env: Record<string, string>): Record<string, string> {
  const k = CLAUDE_CREDENTIAL_VARS.find((v) => env[v])
  return k ? { [k]: env[k]! } : {}
}

/**
 * The env of a turn. `own` is its project's env with the task's on top; `base` is its identity's (for the Default
 * identity, Settings › Credentials, where env vars win). Exactly one Claude credential reaches the turn: the strongest
 * of its own when it has one, else the strongest of the base, so a project's login is never beaten by a stronger
 * global var. The GitHub token is its own GITHUB_TOKEN, else the base's, in both GITHUB_TOKEN and GH_TOKEN (gh reads
 * GH_TOKEN first). The identity's git author is the author and committer, unless the env names its own.
 */
export function turnEnv(
  own: Record<string, string>,
  base: { claude: Record<string, string>; githubToken: string; author?: { name: string; email: string } | null },
): TurnEnv {
  const ownClaude = strongestClaude(own)
  const claude = Object.keys(ownClaude).length ? ownClaude : strongestClaude(base.claude)
  const env: Record<string, string> = { ...own }
  for (const v of CLAUDE_CREDENTIAL_VARS) delete env[v]
  Object.assign(env, claude)
  const token = ownGithubToken(own) || base.githubToken
  if (token) env.GITHUB_TOKEN = env.GH_TOKEN = token
  if (base.author && !GIT_AUTHOR_VARS.some((v) => own[v])) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = base.author.name
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = base.author.email
  }
  const unsetEnv = [...CLAUDE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].filter((v) => !(v in env))
  return { env, unsetEnv, claudeFrom: Object.keys(ownClaude).length ? "project" : Object.keys(claude).length ? "global" : null }
}

/** A project's (or task's) own GitHub token env var, GITHUB_TOKEN first. */
export const ownGithubToken = (env: Record<string, string>) => env.GITHUB_TOKEN || env.GH_TOKEN || ""

/** The credential set of a Default-identity project with no Claude login or GitHub token of its own, and of every box from before the wall. */
export const GLOBAL_CREDENTIALS = "global"

/**
 * On this computer, what keeps a non-Default identity's git off the owner's own config and gh login: git reads the
 * identity's own global config (in `home`) and no system config, and gh its own folder (docs/identities.md).
 */
export function identityHomeEnv(home: string): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: `${home}/gitconfig`, GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: `${home}/gh` }
}

/**
 * The credential set a project's turns use, for the box wall: tasks of two sets never share a pool box, since an agent
 * can read everything on its box (other workspaces, their task.json, the repo mirrors). A project with its own Claude
 * login or GitHub token in its env has a set of its own; the projects of another identity share that identity's; the
 * rest (the Default identity) use the global one. A task's own env doesn't count: its tasks share their project's boxes.
 */
export function credentialSet(projectId: string, projectEnv: Record<string, string>, identityId: string = DEFAULT_IDENTITY_ID): string {
  if ([...CLAUDE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].some((v) => projectEnv[v])) return `project:${projectId}`
  return identityId === DEFAULT_IDENTITY_ID ? GLOBAL_CREDENTIALS : `identity:${identityId}`
}
