// Which coding agent CLI runs a Box Yard agent: Claude Code (the default) or OpenAI's Codex. The Coordinator, the
// Captains and each project's task agents pick one each (Settings › Coordinator, Settings › Box agents, a project's
// Agent setting); a task keeps the one it started on (docs/codex.md).

export const AGENT_CLIS = ["claude", "codex"] as const
export type AgentCli = (typeof AGENT_CLIS)[number]
export const DEFAULT_AGENT_CLI: AgentCli = "claude"

export const AGENT_CLI_LABEL: Record<AgentCli, string> = { claude: "Claude Code", codex: "Codex" }

/** Short names the UI shows on chips. */
export const AGENT_CLI_SHORT: Record<AgentCli, string> = { claude: "Claude", codex: "Codex" }

export const isAgentCli = (v: unknown): v is AgentCli => typeof v === "string" && (AGENT_CLIS as readonly string[]).includes(v)

/** A Claude model id or alias (claude-opus-5-5, opus, sonnet[1m], haiku, fable…): Codex can't run it. */
export function isClaudeModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(claude|opus|sonnet|haiku|fable)\b/i.test(model.trim()))
}

/** An OpenAI model id Codex runs (gpt-6.1-sol, gpt-5.6-terra, o3, codex-mini…): Claude Code can't run it. */
export function isOpenAiModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(gpt-|o\d|codex)/i.test(model.trim()))
}

/** The CLI a model belongs to, when its name says; null for a name neither CLI owns (a custom alias). */
export function cliForModel(model: string | null | undefined): AgentCli | null {
  return isClaudeModel(model) ? "claude" : isOpenAiModel(model) ? "codex" : null
}

/**
 * The model a Codex run passes to `codex exec -m`: `chosen` (a task's or the route's) unless it is a Claude model,
 * else the Codex model setting; null leaves it to Codex's own default.
 */
export function codexModel(chosen: string | null | undefined, setting: string | null | undefined): string | null {
  if (chosen && !isClaudeModel(chosen)) return chosen.trim()
  return setting?.trim() || null
}

/** Models offered in the Codex model fields; any other name Codex knows works too. Empty = Codex's own default. */
export const CODEX_MODEL_SUGGESTIONS = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const
