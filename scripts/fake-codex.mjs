#!/usr/bin/env node
// A stand-in for the `codex` CLI, for trying Box Yard's Codex support with no OpenAI account and for tests. It
// speaks the `codex exec --json` protocol Box Yard uses (server/codex.ts codexExecArgs) and does the work by running
// scripts/fake-claude.mjs, so every prompt marker fake-claude knows ([ask], [fail], task <project>: …) works here
// too. It turns Codex's flags into fake-claude's and fake-claude's stream-json back into Codex's JSONL events.
//
//   CODEX_BIN="node scripts/fake-codex.mjs" npm run dev
//
// Beyond fake-claude's:
//   FAKE_CODEX_LOG=<file>       records each run's args, CODEX_HOME and login (as JSON lines)
//   FAKE_CODEX_LOGIN=required   fails like codex with no login: no $CODEX_HOME/auth.json and no CODEX_API_KEY
//   FAKE_CODEX_REFRESH=1        refreshes a ChatGPT login it runs with (new tokens, last_refresh now), as codex does
//                               once the tokens are about 8 days old
// A login whose refresh token or API key contains "revoked" fails like a spent one.
// Sessions are fake-claude's, kept in $CODEX_HOME/fake-claude; each turn appends a token_count to the thread's
// rollout file in $CODEX_HOME/sessions, where Box Yard reads context usage.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
if (argv.includes("--version")) {
  console.log("codex-cli 0.0.0 (fake codex for Box Yard)")
  process.exit(0)
}

// Without CODEX_HOME, a scratch folder: a stand-in never writes into a real home folder.
const home = process.env.CODEX_HOME || path.join(os.tmpdir(), "fake-codex")
const authFile = path.join(home, "auth.json")
const readAuth = () => {
  try {
    return JSON.parse(fs.readFileSync(authFile, "utf8"))
  } catch {
    return null
  }
}

if (argv[0] === "login" && argv[1] === "status") {
  const auth = readAuth()
  if (auth?.tokens?.refresh_token) console.log("Logged in using ChatGPT")
  else if (process.env.CODEX_API_KEY) console.log("Logged in using an API key")
  else {
    console.log("Not logged in")
    process.exit(1)
  }
  process.exit(0)
}

if (argv[0] !== "exec") {
  console.error(`fake codex: only \`exec\`, \`login status\` and --version are supported (got: ${argv.join(" ")})`)
  process.exit(2)
}

// ---------------------------------------------------------------- flags

const config = {}
const images = []
let model = null
let resume = null
let sandbox = null
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === "-c" || a === "--config") {
    const pair = argv[++i]
    const eq = pair.indexOf("=")
    const raw = pair.slice(eq + 1)
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    config[pair.slice(0, eq)] = value
  } else if (a === "-m" || a === "--model") model = argv[++i]
  else if (a === "-i" || a === "--image") images.push(argv[++i])
  else if (a === "-s" || a === "--sandbox") sandbox = argv[++i]
  else if (a === "--dangerously-bypass-approvals-and-sandbox") sandbox = "danger-full-access"
  else if (a === "resume") resume = argv[++i]
}

const login = (() => {
  const auth = readAuth()
  if (auth?.tokens?.refresh_token) return { kind: "chatgpt", secret: auth.tokens.refresh_token, account: auth.tokens.account_id ?? null }
  if (process.env.CODEX_API_KEY) return { kind: "api_key", secret: process.env.CODEX_API_KEY }
  return null
})()

const thread = resume ?? randomUUID()
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: argv, home: process.env.CODEX_HOME ?? null, login: login?.kind ?? null, account: login?.account ?? null, thread, model, resume, sandbox, images, config }) + "\n")
}

process.stdout.on("error", () => {})
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n")

if (process.env.FAKE_CODEX_LOGIN === "required" && !login) {
  console.error("Error: Not logged in. Run `codex login` or set CODEX_API_KEY.")
  process.exit(1)
}
if (login && /revoked/i.test(login.secret)) {
  emit({ type: "thread.started", thread_id: resume ?? randomUUID() })
  emit({ type: "turn.started" })
  emit({ type: "turn.failed", error: { message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." } })
  process.exit(1)
}

// Codex rotates the refresh token when it refreshes: the old one is spent from now on.
if (process.env.FAKE_CODEX_REFRESH === "1" && login?.kind === "chatgpt") {
  const auth = readAuth()
  auth.tokens.refresh_token = `rt_${randomUUID().replace(/-/g, "")}`
  auth.tokens.access_token = `at_${randomUUID().replace(/-/g, "")}`
  auth.last_refresh = new Date().toISOString()
  fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

// ---------------------------------------------------------------- run fake-claude

const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs")
const claudeArgs = ["-p", "--output-format", "stream-json", "--verbose", ...(resume ? ["--resume", resume] : ["--session-id", thread])]
if (typeof config.developer_instructions === "string") claudeArgs.push("--append-system-prompt", config.developer_instructions)
if (model) claudeArgs.push("--model", model)
if (config["mcp_servers.boxyard.url"] || config["mcp_servers.boxyard.command"]) {
  const server = config["mcp_servers.boxyard.url"]
    ? { type: "http", url: config["mcp_servers.boxyard.url"], headers: { Authorization: `Bearer ${process.env[config["mcp_servers.boxyard.bearer_token_env_var"]] ?? ""}` } }
    : { type: "stdio", command: config["mcp_servers.boxyard.command"], args: config["mcp_servers.boxyard.args"] ?? [] }
  const file = path.join(os.tmpdir(), `fake-codex-mcp-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { boxyard: server } }), { mode: 0o600 })
  process.on("exit", () => fs.rmSync(file, { force: true }))
  claudeArgs.push("--strict-mcp-config", "--mcp-config", file)
}

const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, "fake-claude") }
// The stand-in Claude must not log in with (or fail on) Claude credentials: Codex has its own login.
delete env.FAKE_CLAUDE_LOGIN
delete env.FAKE_CLAUDE_LOG
const child = spawn(process.execPath, [fakeClaude, ...claudeArgs], { env, stdio: ["pipe", "pipe", "pipe"] })
process.on("SIGTERM", () => child.kill("SIGTERM"))
process.on("SIGINT", () => child.kill("SIGINT"))
process.stdin.pipe(child.stdin)

// ---------------------------------------------------------------- fake-claude stream-json → codex JSONL

let started = false
let n = 0
let lastTokens = 0
const tools = new Map()
const item = (type, fields) => ({ id: `item_${n++}`, type, ...fields })

function translate(msg) {
  if (msg.type === "system" && msg.subtype === "init") {
    if (started) return
    started = true
    emit({ type: "thread.started", thread_id: thread })
    emit({ type: "turn.started" })
    return
  }
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    const u = msg.message.usage
    if (u) lastTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    for (const b of msg.message.content) {
      if (b.type === "text" && b.text) emit({ type: "item.completed", item: item("agent_message", { text: b.text }) })
      if (b.type === "tool_use") {
        const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(String(b.name))
        const it = m
          ? item("mcp_tool_call", { server: m[1], tool: m[2], arguments: b.input ?? {}, result: null, error: null, status: "in_progress" })
          : item("command_execution", { command: typeof b.input?.command === "string" ? b.input.command : JSON.stringify(b.input ?? {}), aggregated_output: "", exit_code: null, status: "in_progress" })
        tools.set(b.id, it)
        emit({ type: "item.started", item: it })
      }
    }
    return
  }
  if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type !== "tool_result") continue
      const it = tools.get(b.tool_use_id)
      if (!it) continue
      tools.delete(b.tool_use_id)
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("") : ""
      if (it.type === "mcp_tool_call") {
        emit({ type: "item.completed", item: { ...it, result: b.is_error ? null : { content: [{ type: "text", text }], structured_content: null }, error: b.is_error ? { message: text } : null, status: b.is_error ? "failed" : "completed" } })
      } else emit({ type: "item.completed", item: { ...it, aggregated_output: text, exit_code: b.is_error ? 1 : 0, status: b.is_error ? "failed" : "completed" } })
    }
    return
  }
  if (msg.type === "result") {
    if (!started) translate({ type: "system", subtype: "init" })
    if (msg.is_error) {
      emit({ type: "turn.failed", error: { message: String(msg.result ?? "error") } })
      return
    }
    writeRollout()
    const u = msg.usage ?? {}
    const cached = u.cache_read_input_tokens ?? 0
    emit({ type: "turn.completed", usage: { input_tokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0), cached_input_tokens: cached, cache_write_input_tokens: u.cache_creation_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, reasoning_output_tokens: 0 } })
  }
}

/** The thread's rollout file, with this turn's model and context, where Box Yard reads them. */
function writeRollout() {
  if (!lastTokens) return
  const now = new Date()
  const day = path.join(home, "sessions", String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"))
  const existing = findRollout()
  const file = existing ?? path.join(day, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [
    ...(existing ? [] : [{ type: "session_meta", payload: { id: thread } }]),
    { type: "turn_context", payload: { model: model ?? "gpt-fake" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: lastTokens, output_tokens: 0 }, model_context_window: Number(process.env.FAKE_CLAUDE_WINDOW || 200_000) } } },
  ]
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

function findRollout() {
  const root = path.join(home, "sessions")
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      } else if (e.name.endsWith(`-${thread}.jsonl`)) return p
    }
    return null
  }
  return walk(root)
}

let buf = ""
child.stdout.on("data", (d) => {
  buf += d
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      translate(JSON.parse(line))
    } catch {}
  }
})
let stderr = ""
child.stderr.on("data", (d) => {
  stderr += d
  // fake-claude's own "No conversation found" is codex's "no rollout found".
  if (!/No conversation found/.test(String(d))) process.stderr.write(d)
})
child.on("close", (code, signal) => {
  if (buf.trim()) {
    try {
      translate(JSON.parse(buf))
    } catch {}
  }
  if (/No conversation found/.test(stderr)) {
    process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${resume} (code -32600)\n`)
    process.exit(1)
  }
  process.exit(code ?? (signal ? 1 : 0))
})
