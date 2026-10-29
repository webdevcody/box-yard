// OpenAI's Codex CLI as a Box Yard agent (docs/codex.md): the `codex exec` arguments, its login, its context usage,
// and a translation of its `--json` events into the Claude Code stream-json messages the Coordinator, Captains and
// side threads already read. Task agents run Codex through runner/box-runner.mjs, which has its own copy of the
// translation (it runs on boxes with plain Node); test/codex.test.ts keeps the two in step.
import fs from "node:fs"
import path from "node:path"
import type { Effort } from "../shared/types.js"

/** What either CLI prints when the session it was told to resume isn't there (Claude Code, then Codex). */
export const MISSING_SESSION = /no conversation found|session.*not found|no rollout found/i

// ------------------------------------------------------------------ the ChatGPT login (auth.json)

/** A Codex login file (`~/.codex/auth.json`), as Settings › Credentials keeps it. */
export interface CodexAuth {
  /** The file, minified. */
  text: string
  /** `last_refresh` in ms; 0 when the file has none. Codex refreshes the tokens once it is about 8 days old. */
  lastRefresh: number
  /** The ChatGPT account the tokens belong to, so a refreshed copy from a box only replaces its own login. */
  account: string | null
}

/** `text` as a Codex login, or why it isn't one. */
export function parseCodexAuth(text: string): CodexAuth | { error: string } {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: "That isn't JSON. Paste the whole of ~/.codex/auth.json" }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "That isn't a Codex auth.json" }
  const t = raw.tokens
  const chatgpt = t && typeof t === "object" && typeof t.refresh_token === "string" && typeof t.access_token === "string" && t.refresh_token && t.access_token
  const apiKey = typeof raw.OPENAI_API_KEY === "string" && raw.OPENAI_API_KEY
  if (!chatgpt && !apiKey) return { error: "That auth.json has no ChatGPT login in it (no tokens). Run `codex login` on a computer with a browser, then paste ~/.codex/auth.json" }
  const at = typeof raw.last_refresh === "string" ? Date.parse(raw.last_refresh) : NaN
  return {
    text: JSON.stringify(raw),
    lastRefresh: Number.isFinite(at) ? at : 0,
    account: chatgpt && typeof t.account_id === "string" ? t.account_id : null,
  }
}

export const isCodexAuth = (a: CodexAuth | { error: string }): a is CodexAuth => !("error" in a)

/** `candidate` is the same login as `current`, refreshed later: it should replace it. */
export function isRefreshOf(current: string, candidate: string): boolean {
  const a = parseCodexAuth(current)
  const b = parseCodexAuth(candidate)
  if (!isCodexAuth(a) || !isCodexAuth(b)) return false
  return a.account !== null && a.account === b.account && b.lastRefresh > a.lastRefresh
}

/** The token strings in a login file, for redact(): the file as a whole never shows up in logs, its tokens might. */
export function codexAuthSecrets(text: string): string[] {
  try {
    const raw = JSON.parse(text)
    const t = raw?.tokens ?? {}
    return [t.id_token, t.access_token, t.refresh_token, raw?.OPENAI_API_KEY].filter((v): v is string => typeof v === "string" && v.length >= 8)
  } catch {
    return []
  }
}

/**
 * Put `auth` in `home`/auth.json unless the file there is the same login refreshed later (a run there refreshed it:
 * the newer tokens win, and the older ones may already be spent). Returns whether it wrote.
 */
export function seedCodexAuth(home: string, auth: string): boolean {
  const file = path.join(home, "auth.json")
  let existing = ""
  try {
    existing = fs.readFileSync(file, "utf8")
  } catch {}
  if (existing && (existing === auth || isRefreshOf(auth, existing))) return false
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, auth, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return true
}

// ------------------------------------------------------------------ `codex exec` arguments

export interface CodexExecSpec {
  /** The thread to resume, or null for a new one. */
  resume: string | null
  model: string | null
  effort: Effort | null
  /** Box Yard's part of the system prompt (Codex's developer instructions). */
  instructions: string
  /** Box Yard's MCP server: the Coordinator's over HTTP (token in `tokenEnv`), a task's over stdio; none for a login check. */
  mcp?: { url: string; tokenEnv: string } | { command: string; args: string[] } | null
  /**
   * The Coordinator, a Captain or a side thread: it acts through Box Yard's tools only, with no shell (which could read
   * the data folder, past what status-only projects allow), no file edits and no sandbox to escape. A task agent
   * works in its box like Claude Code with bypassPermissions.
   */
  manager: boolean
  /** Web search: the Coordinator's and Captains' WebSearch. */
  webSearch?: boolean
  /** Images to attach to the prompt. */
  images?: string[]
  /** Codex compacts its context on its own once it passes this many tokens (Settings › auto-compact). */
  autoCompactTokens?: number | null
}

/** A TOML value for `-c key=value`: JSON strings, numbers, booleans and arrays of them are valid TOML. */
const toml = (v: unknown) => JSON.stringify(v)

/** Tools a run never needs: ChatGPT connectors and plugins (the owner's own accounts), and the desktop helpers. */
const ALWAYS_OFF = ["apps", "plugins", "computer_use", "browser_use", "in_app_browser", "image_generation", "memories"]
/** And what the Coordinator and Captains don't get: a shell (and with it file reads), sub-agents, goals. */
const MANAGER_OFF = ["shell_tool", "unified_exec", "multi_agent", "goals"]

/** Arguments for `codex exec` (the prompt goes on stdin). */
export function codexExecArgs(spec: CodexExecSpec): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]
  if (spec.manager) args.push("--sandbox", "read-only")
  else args.push("--dangerously-bypass-approvals-and-sandbox")
  const c = (key: string, value: unknown) => args.push("-c", `${key}=${toml(value)}`)
  if (spec.manager) c("approval_policy", "never")
  c("developer_instructions", spec.instructions)
  if (spec.mcp) {
    if ("url" in spec.mcp) {
      c("mcp_servers.boxyard.url", spec.mcp.url)
      c("mcp_servers.boxyard.bearer_token_env_var", spec.mcp.tokenEnv)
    } else {
      c("mcp_servers.boxyard.command", spec.mcp.command)
      c("mcp_servers.boxyard.args", spec.mcp.args)
    }
    // Box Yard's tools run without asking (exec can't ask anyone), and some wait a while (ask_captain, message_captain).
    c("mcp_servers.boxyard.default_tools_approval_mode", "approve")
    c("mcp_servers.boxyard.startup_timeout_sec", 60)
    c("mcp_servers.boxyard.tool_timeout_sec", 900)
  }
  c("web_search", spec.webSearch === false ? "disabled" : "live")
  if (spec.effort) c("model_reasoning_effort", spec.effort)
  if (spec.autoCompactTokens) c("model_auto_compact_token_limit", spec.autoCompactTokens)
  // Config, not --disable: a feature this Codex version doesn't have is a warning there, not a refusal to start.
  for (const f of [...ALWAYS_OFF, ...(spec.manager ? MANAGER_OFF : [])]) c(`features.${f}`, false)
  if (spec.model) args.push("--model", spec.model)
  for (const img of spec.images ?? []) args.push("--image", img)
  if (spec.resume) args.push("resume", spec.resume)
  args.push("-")
  return args
}

// ------------------------------------------------------------------ context usage, from the session's rollout file

export interface CodexContext {
  /** Tokens in the context after the last model call: its input (cached or not) plus what it wrote. */
  tokens: number
  window: number | null
  model: string | null
}

/** `<home>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`, newest day first; null when there's none. */
export function codexRolloutFile(home: string, threadId: string): string | null {
  const root = path.join(home, "sessions")
  const desc = (dir: string) => {
    try {
      return fs.readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  for (const y of desc(root))
    for (const m of desc(path.join(root, y)))
      for (const d of desc(path.join(root, y, m))) {
        const hit = desc(path.join(root, y, m, d)).find((f) => f.startsWith("rollout-") && f.endsWith(`-${threadId}.jsonl`))
        if (hit) return path.join(root, y, m, d, hit)
      }
  return null
}

/** The last `token_count` (and `turn_context` model) in a rollout file: read from its end, which is all that's needed. */
export function codexContextOf(file: string, tailBytes = 2 << 20): CodexContext | null {
  let text: string
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - tailBytes)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  let ctx: CodexContext | null = null
  let model: string | null = null
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0 && (!ctx || !model); i--) {
    const line = lines[i]!
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const p = d?.payload
    if (!ctx && d?.type === "event_msg" && p?.type === "token_count" && p.info?.last_token_usage) {
      const u = p.info.last_token_usage
      const tokens = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
      if (tokens > 0) ctx = { tokens, window: typeof p.info.model_context_window === "number" ? p.info.model_context_window : null, model: null }
    }
    if (!model && d?.type === "turn_context" && typeof p?.model === "string") model = p.model
  }
  return ctx ? { ...ctx, model } : null
}

export function codexContext(home: string, threadId: string): CodexContext | null {
  const file = codexRolloutFile(home, threadId)
  return file ? codexContextOf(file) : null
}

// ------------------------------------------------------------------ `codex exec --json` → Claude stream-json

/** Claude Code's names for the built-in tools a Codex item stands for, so the chats label them the same way. */
const TOOL_NAMES: Record<string, string> = { command_execution: "Bash", file_change: "Edit", web_search: "WebSearch", todo_list: "TodoWrite" }

/** A Codex item's tool input, in the shape the chats show. */
function toolInput(item: any): Record<string, unknown> {
  switch (item.type) {
    case "mcp_tool_call":
      return item.arguments && typeof item.arguments === "object" ? item.arguments : {}
    case "command_execution":
      return { command: String(item.command ?? "") }
    case "file_change":
      return { changes: Array.isArray(item.changes) ? item.changes.map((c: any) => ({ path: c?.path, kind: c?.kind })) : [] }
    case "web_search":
      return { query: String(item.query ?? "") }
    case "todo_list":
      return { todos: Array.isArray(item.items) ? item.items : [] }
    default:
      return {}
  }
}

const toolName = (item: any) => (item.type === "mcp_tool_call" ? `mcp__${item.server ?? "boxyard"}__${item.tool ?? "tool"}` : TOOL_NAMES[item.type] ?? item.type)

/** A finished Codex item's tool result: [content, is_error], or null for items that aren't tools. */
function toolResult(item: any): [unknown, boolean] | null {
  switch (item.type) {
    case "mcp_tool_call": {
      const failed = item.status === "failed" || Boolean(item.error)
      return [failed ? [{ type: "text", text: String(item.error?.message ?? "The tool call failed.") }] : (item.result?.content ?? []), failed]
    }
    case "command_execution": {
      const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)
      return [[{ type: "text", text: String(item.aggregated_output ?? "") }], failed]
    }
    case "file_change":
      return [[{ type: "text", text: item.status === "failed" ? "The patch failed." : "Applied." }], item.status === "failed"]
    case "web_search":
    case "todo_list":
      return [[], false]
    default:
      return null
  }
}

/** Codex's token counts in Claude's terms: its input_tokens include the cached ones, Claude's don't. */
export function claudeUsageOf(u: any): Record<string, number> | null {
  if (!u || typeof u !== "object") return null
  const input = Number(u.input_tokens) || 0
  const cached = Number(u.cached_input_tokens) || 0
  const written = Number(u.cache_write_input_tokens) || 0
  return {
    input_tokens: Math.max(0, input - cached - written),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
    output_tokens: Number(u.output_tokens) || 0,
  }
}

/**
 * Reads `codex exec --json` lines and gives back the Claude Code stream-json messages they amount to: `system/init`
 * with the thread id as session_id, `assistant` text and tool_use blocks, `user` tool_result blocks, and a final
 * `result` with the turn's usage. Context usage isn't in Codex's stream; `context` reads it from the session's
 * rollout file when the turn ends, and it comes as an `assistant` message with no content and that usage.
 */
export class CodexStream {
  sessionId: string | null = null
  /** The last error Codex reported; a turn may still recover from one (it retries a dropped connection). */
  lastError: string | null = null
  sawResult = false
  private readonly started = new Set<string>()
  private readonly t0 = Date.now()

  constructor(private readonly opts: { model?: string | null; context?: (threadId: string) => CodexContext | null } = {}) {}

  /** The Claude messages for one line of Codex output (none for lines that aren't JSON or don't matter). */
  push(line: string): any[] {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      return []
    }
    const session = this.sessionId ?? undefined
    switch (ev?.type) {
      case "thread.started":
        this.sessionId = typeof ev.thread_id === "string" ? ev.thread_id : this.sessionId
        return [{ type: "system", subtype: "init", session_id: this.sessionId }]
      case "item.started": {
        const item = ev.item
        if (!item || !toolResult(item) || item.type === "web_search" || item.type === "todo_list") return []
        this.started.add(item.id)
        return [this.toolUse(item, session)]
      }
      case "item.completed": {
        const item = ev.item
        if (!item) return []
        if (item.type === "agent_message") return item.text?.trim() ? [{ type: "assistant", session_id: session, message: { model: this.opts.model ?? "codex", content: [{ type: "text", text: item.text }] } }] : []
        // An "error" item is a warning (an ignored setting); the turn goes on.
        const result = toolResult(item)
        if (!result) return []
        const out: any[] = this.started.has(item.id) ? [] : [this.toolUse(item, session)]
        this.started.delete(item.id)
        out.push({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: item.id, content: result[0], is_error: result[1] }] } })
        return out
      }
      case "error":
        this.lastError = String(ev.message ?? "error")
        return []
      case "turn.failed":
        this.sawResult = true
        return [this.result(null, String(ev.error?.message ?? this.lastError ?? "Codex failed"))]
      case "turn.completed": {
        this.sawResult = true
        const ctx = this.sessionId ? (this.opts.context?.(this.sessionId) ?? null) : null
        const model = ctx?.model ?? this.opts.model ?? "codex"
        const out: any[] = []
        if (ctx) out.push({ type: "assistant", session_id: session, message: { model, content: [], usage: { input_tokens: ctx.tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })
        out.push(this.result(ev.usage, null, ctx, model))
        return out
      }
      default:
        return []
    }
  }

  private toolUse(item: any, session: string | undefined) {
    return { type: "assistant", session_id: session, message: { model: this.opts.model ?? "codex", content: [{ type: "tool_use", id: item.id, name: toolName(item), input: toolInput(item) }] } }
  }

  private result(usage: unknown, error: string | null, ctx: CodexContext | null = null, model: string | null = null) {
    return {
      type: "result",
      subtype: error ? "error" : "success",
      is_error: Boolean(error),
      result: error ?? "",
      session_id: this.sessionId,
      duration_ms: Date.now() - this.t0,
      usage: claudeUsageOf(usage),
      model: model ?? this.opts.model ?? "codex",
      ...(ctx?.window ? { modelUsage: { [model ?? "codex"]: { contextWindow: ctx.window } } } : {}),
    }
  }
}
