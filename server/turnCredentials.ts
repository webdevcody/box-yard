// Which credentials a turn's agent gets (task.json's env and unsetEnv). A box's own environment can still hold a
// credential another project's turn must not use (an Upstash box made before credentials left Box.create had the
// global Claude login and GitHub token in its env), so the turn names the ones the runner removes before it starts
// `claude`, as well as the ones it sets.

/** Env vars a `claude` process logs in with, strongest first (Claude Code's own order). */
export const CLAUDE_CREDENTIAL_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const

/** The GitHub token env vars that `gh` (GH_TOKEN first) and Box Yard's git credential helper (GITHUB_TOKEN) read. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const

export interface TurnEnv {
  env: Record<string, string>
  /** Vars the runner removes from its own environment before adding `env`. */
  unsetEnv: string[]
  /** Whose Claude login the turn uses: its project's (or task's) env, Settings › Credentials, or none (local login). */
  claudeFrom: "project" | "global" | null
}

/** The strongest Claude credential in `env`, as a one-var env; empty values don't count. */
function strongestClaude(env: Record<string, string>): Record<string, string> {
  const k = CLAUDE_CREDENTIAL_VARS.find((v) => env[v])
  return k ? { [k]: env[k]! } : {}
}

/**
 * The env of a turn. `own` is its project's env with the task's on top; `global` is Settings › Credentials (env vars
 * win there). Exactly one Claude credential reaches the turn: the strongest of its own when it has one, else the
 * strongest global one, so a project's login is never beaten by a stronger global var. The GitHub token is its own
 * GITHUB_TOKEN, else the global one, in both GITHUB_TOKEN and GH_TOKEN (gh reads GH_TOKEN first).
 */
export function turnEnv(own: Record<string, string>, global: { claude: Record<string, string>; githubToken: string }): TurnEnv {
  const ownClaude = strongestClaude(own)
  const claude = Object.keys(ownClaude).length ? ownClaude : strongestClaude(global.claude)
  const env: Record<string, string> = { ...own }
  for (const v of CLAUDE_CREDENTIAL_VARS) delete env[v]
  Object.assign(env, claude)
  const token = own.GITHUB_TOKEN || own.GH_TOKEN || global.githubToken
  if (token) env.GITHUB_TOKEN = env.GH_TOKEN = token
  const unsetEnv = [...CLAUDE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].filter((v) => !(v in env))
  return { env, unsetEnv, claudeFrom: Object.keys(ownClaude).length ? "project" : Object.keys(claude).length ? "global" : null }
}

/** The credential set of a project with no Claude login or GitHub token of its own, and of every box from before the wall. */
export const GLOBAL_CREDENTIALS = "global"

/**
 * The credential set a project's turns use, for the box wall: tasks of two sets never share a pool box, since an agent
 * can read everything on its box (other workspaces, their task.json, the repo mirrors). A project with its own Claude
 * login or GitHub token in its env has a set of its own; every other project uses the global one. A task's own env
 * doesn't count: its tasks share their project's boxes.
 */
export function credentialSet(projectId: string, projectEnv: Record<string, string>): string {
  return [...CLAUDE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].some((v) => projectEnv[v]) ? `project:${projectId}` : GLOBAL_CREDENTIALS
}
