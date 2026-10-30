import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { claudeUsageOf, codexAuthSecrets, codexContext, codexExecArgs, CodexStream, isRefreshOf, MISSING_SESSION, parseCodexAuth, seedCodexAuth } from "../server/codex.js"
import { cliForModel, codexModel, isClaudeModel } from "../shared/agentCli.js"
import { tmpDir } from "./helpers.js"

// What `codex exec --json` (codex-cli 0.165) printed for a turn that called one Box Yard tool and replied.
const TURN = [
  { type: "thread.started", thread_id: "01a18a01-ef78-7370-84f0-09ca85978b12" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I’ll call `mark_done` with the summary `ok`.\n" } },
  { type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "boxyard", tool: "mark_done", arguments: { summary: "ok" }, result: null, error: null, status: "in_progress" } },
  {
    type: "item.completed",
    item: { id: "item_1", type: "mcp_tool_call", server: "boxyard", tool: "mark_done", arguments: { summary: "ok" }, result: { content: [{ type: "text", text: "Marked done. End your turn." }], structured_content: null }, error: null, status: "completed" },
  },
  { type: "item.started", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc 'false'", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc 'false'", aggregated_output: "nope\n", exit_code: 1, status: "failed" } },
  { type: "item.completed", item: { id: "item_3", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
  { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "finished" } },
  { type: "turn.completed", usage: { input_tokens: 56272, cached_input_tokens: 36992, cache_write_input_tokens: 0, output_tokens: 113, reasoning_output_tokens: 0 } },
].map((e) => JSON.stringify(e))

const run = (lines: string[], opts?: ConstructorParameters<typeof CodexStream>[0]) => {
  const s = new CodexStream(opts)
  return { stream: s, out: lines.flatMap((l) => s.push(l)) }
}

describe("CodexStream", () => {
  it("turns a Codex turn into the Claude stream-json messages the chats read", () => {
    const { stream, out } = run(TURN, { model: "gpt-6.1-sol" })
    expect(stream.sessionId).toBe("01a18a01-ef78-7370-84f0-09ca85978b12")
    expect(out[0]).toEqual({ type: "system", subtype: "init", session_id: "01a18a01-ef78-7370-84f0-09ca85978b12" })
    const texts = out.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((b: any) => b.type === "text").map((b: any) => b.text)
    expect(texts).toEqual(["I’ll call `mark_done` with the summary `ok`.\n", "finished"])
    const uses = out.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((b: any) => b.type === "tool_use")
    expect(uses).toEqual([
      { type: "tool_use", id: "item_1", name: "mcp__boxyard__mark_done", input: { summary: "ok" } },
      { type: "tool_use", id: "item_2", name: "Bash", input: { command: "/bin/zsh -lc 'false'" } },
    ])
    const results = out.filter((m) => m.type === "user").flatMap((m) => m.message.content)
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "item_1", content: [{ type: "text", text: "Marked done. End your turn." }], is_error: false },
      { type: "tool_result", tool_use_id: "item_2", content: [{ type: "text", text: "nope\n" }], is_error: true },
    ])
    const result = out.at(-1)
    expect(result).toMatchObject({ type: "result", is_error: false, session_id: stream.sessionId, model: "gpt-6.1-sol" })
    // Codex counts cached input inside input_tokens; Claude doesn't.
    expect(result.usage).toEqual({ input_tokens: 56272 - 36992, cache_creation_input_tokens: 0, cache_read_input_tokens: 36992, output_tokens: 113 })
    expect(stream.sawResult).toBe(true)
  })

  it("gives a tool call that only completes (no started event) its tool_use first", () => {
    const { out } = run([JSON.stringify({ type: "item.completed", item: { id: "x", type: "web_search", query: "box yard" } })])
    expect(out.map((m) => m.type)).toEqual(["assistant", "user"])
    expect(out[0].message.content[0]).toMatchObject({ name: "WebSearch", input: { query: "box yard" } })
  })

  it("reports a failed MCP call as an error result", () => {
    const failed = { type: "item.completed", item: { id: "t", type: "mcp_tool_call", server: "boxyard", tool: "create_task", arguments: {}, result: null, error: { message: "MCP tool call requires approval" }, status: "failed" } }
    const { out } = run([JSON.stringify(failed)])
    expect(out[1].message.content[0]).toEqual({ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "MCP tool call requires approval" }], is_error: true })
  })

  it("ends a failed turn with an error result, and keeps a recoverable error for the record", () => {
    const { stream, out } = run([JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }), JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })])
    expect(stream.lastError).toBe("Reconnecting... 1/5")
    expect(out.at(-1)).toMatchObject({ type: "result", is_error: true, result: "usage limit reached" })
  })

  it("adds the context the rollout file reports when the turn ends", () => {
    const { out } = run(TURN, { context: () => ({ tokens: 41_000, window: 500_000, model: "gpt-6.1-sol" }) })
    const usage = out.filter((m) => m.type === "assistant" && m.message.content.length === 0)
    expect(usage).toHaveLength(1)
    expect(usage[0].message.usage.input_tokens).toBe(41_000)
    expect(out.at(-1).modelUsage).toEqual({ "gpt-6.1-sol": { contextWindow: 500_000 } })
  })

  it("ignores lines that aren't JSON", () => {
    expect(run(["not json", ""]).out).toEqual([])
  })
})

describe("codexExecArgs", () => {
  const base = { resume: null, model: null, effort: null, instructions: "Be brief.\nReally.", manager: false }

  it("runs a task agent like Claude Code with bypassPermissions, with Box Yard's stdio tools approved", () => {
    const args = codexExecArgs({ ...base, mcp: { command: "/usr/bin/node", args: ["/r/box-runner.mjs", "mcp", "/t"] }, model: "gpt-6.1-sol", effort: "high", autoCompactTokens: 300_000 })
    expect(args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args).toContain("--ignore-user-config")
    expect(args).toContain('developer_instructions="Be brief.\\nReally."')
    expect(args).toContain('mcp_servers.boxyard.command="/usr/bin/node"')
    expect(args).toContain('mcp_servers.boxyard.args=["/r/box-runner.mjs","mcp","/t"]')
    expect(args).toContain('mcp_servers.boxyard.default_tools_approval_mode="approve"')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args).toContain("model_auto_compact_token_limit=300000")
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-6.1-sol"])
    expect(args).not.toContain("features.shell_tool=false")
    expect(args.at(-1)).toBe("-")
  })

  it("gives the Coordinator no shell, a read-only sandbox and its HTTP tools with a token from the env", () => {
    const args = codexExecArgs({ ...base, manager: true, mcp: { url: "http://127.0.0.1:3000/mcp", tokenEnv: "BOXYARD_MCP_TOKEN" }, resume: "thread-1" })
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only", 'approval_policy="never"', "features.shell_tool=false", "features.unified_exec=false"]))
    expect(args).toContain('mcp_servers.boxyard.url="http://127.0.0.1:3000/mcp"')
    expect(args).toContain('mcp_servers.boxyard.bearer_token_env_var="BOXYARD_MCP_TOKEN"')
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args.slice(-3)).toEqual(["resume", "thread-1", "-"])
    // Feature switches go through config, so a Codex without one of them warns instead of refusing to start.
    expect(args).not.toContain("--disable")
  })

  it("names no MCP server when there is none", () => {
    expect(codexExecArgs(base).some((a) => a.startsWith("mcp_servers."))).toBe(false)
  })
})

const login = (account: string, refreshed: string, token = "rt_aaaaaaaaaaaaaaaa") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id_aaaaaaaaaaaa", access_token: "at_aaaaaaaaaaaa", refresh_token: token, account_id: account }, last_refresh: refreshed })

describe("Codex login files", () => {
  it("accepts a ChatGPT auth.json, minified, and refuses anything else", () => {
    const pretty = JSON.stringify(JSON.parse(login("acct-1", "2026-10-20T10:00:00Z")), null, 2)
    const parsed = parseCodexAuth(pretty)
    expect(parsed).toMatchObject({ account: "acct-1", lastRefresh: Date.parse("2026-10-20T10:00:00Z") })
    expect("text" in parsed && parsed.text).toBe(login("acct-1", "2026-10-20T10:00:00Z"))
    expect(parseCodexAuth("sk-proj-123")).toHaveProperty("error")
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }))).toHaveProperty("error")
  })

  it("takes a copy as a refresh only when it's the same account, later", () => {
    const old = login("acct-1", "2026-10-01T00:00:00Z")
    expect(isRefreshOf(old, login("acct-1", "2026-10-09T00:00:00Z", "rt_bbbbbbbbbbbbbbbb"))).toBe(true)
    expect(isRefreshOf(old, login("acct-2", "2026-10-09T00:00:00Z"))).toBe(false)
    expect(isRefreshOf(old, login("acct-1", "2026-09-01T00:00:00Z"))).toBe(false)
    expect(isRefreshOf(old, "garbage")).toBe(false)
  })

  it("seeds a Codex home, but never over a refreshed copy of the same login", () => {
    const home = tmpDir("codex-home")
    const old = login("acct-1", "2026-10-01T00:00:00Z")
    expect(seedCodexAuth(home, old)).toBe(true)
    expect((fs.statSync(path.join(home, "auth.json")).mode & 0o777).toString(8)).toBe("600")
    const newer = login("acct-1", "2026-10-09T00:00:00Z", "rt_bbbbbbbbbbbbbbbb")
    fs.writeFileSync(path.join(home, "auth.json"), newer)
    expect(seedCodexAuth(home, old)).toBe(false)
    expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toBe(newer)
    // Another account's login replaces it.
    expect(seedCodexAuth(home, login("acct-2", "2026-10-02T00:00:00Z"))).toBe(true)
  })

  it("names the tokens inside for redaction", () => {
    expect(codexAuthSecrets(login("a", "2026-10-01T00:00:00Z"))).toEqual(["id_aaaaaaaaaaaa", "at_aaaaaaaaaaaa", "rt_aaaaaaaaaaaaaaaa"])
  })
})

describe("codexContext", () => {
  it("reads the last token count and model from the thread's rollout file", () => {
    const home = tmpDir("codex-rollout")
    const day = path.join(home, "sessions", "2026", "10", "29")
    fs.mkdirSync(day, { recursive: true })
    const lines = [
      { type: "session_meta", payload: { id: "t-1" } },
      { type: "turn_context", payload: { model: "gpt-6-luna" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, output_tokens: 10 }, model_context_window: 272000 } } },
      { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 40_000, cached_input_tokens: 39_000, output_tokens: 500 }, model_context_window: 500000 } } },
      { type: "event_msg", payload: { type: "token_count", info: null } },
    ]
    fs.writeFileSync(path.join(day, "rollout-2026-10-29T10-00-00-t-1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    expect(codexContext(home, "t-1")).toEqual({ tokens: 40_500, window: 500000, model: "gpt-6.1-sol" })
    expect(codexContext(home, "t-2")).toBeNull()
  })
})

describe("agent CLI helpers", () => {
  it("tells Claude and OpenAI models apart", () => {
    expect(isClaudeModel("claude-opus-5-5")).toBe(true)
    expect(isClaudeModel("sonnet[1m]")).toBe(true)
    expect(cliForModel("gpt-6.1-sol")).toBe("codex")
    expect(cliForModel("o3")).toBe("codex")
    expect(cliForModel("my-alias")).toBeNull()
  })

  it("never hands Codex a Claude model", () => {
    expect(codexModel("claude-opus-5-5", "gpt-6-luna")).toBe("gpt-6-luna")
    expect(codexModel("gpt-6.1-sol", "gpt-6-luna")).toBe("gpt-6.1-sol")
    expect(codexModel(null, "")).toBeNull()
  })

  it("knows both CLIs' missing-session errors", () => {
    expect(MISSING_SESSION.test("No conversation found with session ID: x")).toBe(true)
    expect(MISSING_SESSION.test("Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)")).toBe(true)
  })

  it("maps usage with nothing in it to zeros", () => {
    expect(claudeUsageOf(null)).toBeNull()
    expect(claudeUsageOf({ input_tokens: 5 })).toEqual({ input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })
  })
})
