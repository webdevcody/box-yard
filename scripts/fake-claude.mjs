#!/usr/bin/env node
// A stand-in for the `claude` CLI, for trying Box Yard with no Anthropic
// account and for tests. It speaks the same headless protocol Box Yard uses
// (`-p --output-format stream-json`, `--session-id` / `--resume`,
// `--mcp-config`) and calls the real Box Yard MCP tools, driven by keywords in
// the prompt instead of a model.
//
//   CLAUDE_BIN="node scripts/fake-claude.mjs" npm run dev
//
// Orchestrator chat understands:
//   create project <name> [repo owner/name]
//   task <project>: <title> -- <prompt>       (prompt is optional)
//   status
// Worker prompts understand these markers anywhere in the text:
//   [ask] [fail] [slow] [preview] [artifact] [agent:<taskId>] [note]
// With no marker the worker writes a file, publishes it, and marks itself done.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes("--version")) {
  console.log("0.0.0 (fake claude for Box Yard)")
  process.exit(0)
}

const partial = args.includes("--include-partial-messages")
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude")
const sessionsDir = path.join(configDir, "fake-sessions")
fs.mkdirSync(sessionsDir, { recursive: true })

const resumeId = flag("--resume")
const newId = flag("--session-id")
const sessionId = resumeId ?? newId
const sessionFile = sessionId ? path.join(sessionsDir, `${sessionId}.json`) : null

if (resumeId && !fs.existsSync(sessionFile)) {
  console.error(`No conversation found with session ID: ${resumeId}`)
  process.exit(1)
}
if (newId && fs.existsSync(sessionFile)) {
  console.error(`Session ID ${newId} is already in use.`)
  process.exit(1)
}

const session = resumeId ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : { id: sessionId, turns: [] }
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- MCP clients

function loadMcp() {
  const file = flag("--mcp-config")
  if (!file) return null
  const cfg = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : file)
  const [, server] = Object.entries(cfg.mcpServers ?? {})[0] ?? []
  if (!server) return null
  const client = server.type === "http" ? httpClient(server) : stdioClient(server)
  client.kind = server.type === "http" ? "orchestrator" : "worker"
  return client
}

function httpClient(server) {
  let id = 0
  const call = async (method, params) => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    })
    const body = await res.json()
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  return {
    async init() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } })
    },
    tool: (name, args) => call("tools/call", { name, arguments: args }),
    close() {},
  }
}

function stdioClient(server) {
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...server.env } })
  let id = 0
  let buf = ""
  const waiting = new Map()
  child.stdout.on("data", (d) => {
    buf += d
    const lines = buf.split("\n")
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      waiting.set(myId, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n")
    })
  return {
    async init() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    },
    tool: (name, args) => call("tools/call", { name, arguments: args }),
    close: () => child.stdin.end(),
  }
}

// ---------------------------------------------------------------- output helpers

async function say(text) {
  if (partial) {
    for (const word of text.split(/(?<= )/)) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word } } })
      await sleep(15)
    }
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
}

async function useTool(mcp, name, input) {
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${Date.now()}`, name: `mcp__boxyard__${name}`, input }] } })
  const result = await mcp.tool(name, input)
  const text = result?.content?.map((c) => c.text).join("") ?? ""
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: text, is_error: Boolean(result?.isError) }] } })
  return text
}

function sh(cmd) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], { stdio: "ignore" })
    p.on("close", (code) => resolve(code))
  })
}

// ---------------------------------------------------------------- behaviors

async function orchestrator(mcp, prompt) {
  const text = prompt.split("\n").filter((l) => !l.startsWith("- ") && !l.startsWith("[Box Yard") && !l.startsWith("[Yard now]")).join("\n").trim()
  const lines = []
  let m
  if ((m = text.match(/create project\s+"?([\w .-]+?)"?(?:\s+repo\s+(\S+))?\s*$/im))) {
    const r = await useTool(mcp, "create_project", { name: m[1].trim(), ...(m[2] ? { repo: m[2] } : {}) })
    lines.push(`Created project **${m[1].trim()}**.`, "```json", r.slice(0, 400), "```")
  }
  const taskRe = /^task\s+([\w .-]+?):\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = taskRe.exec(text))) {
    const r = await useTool(mcp, "create_task", { project: m[1].trim(), title: m[2].trim(), prompt: (m[3] ?? m[2]).trim() })
    lines.push(r.startsWith("{") ? `Started task **${m[2].trim()}** in ${m[1].trim()}.` : `Couldn't start that task: ${r}`)
  }
  const scheduleRe = /^schedule\s+([\w .-]+?)\s+"([^"]+)":\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = scheduleRe.exec(text))) {
    const r = await useTool(mcp, "create_schedule", { project: m[1].trim(), cron: m[2], name: m[3].trim(), prompt: (m[4] ?? m[3]).trim() })
    lines.push(r.startsWith("{") ? `Scheduled **${m[3].trim()}** in ${m[1].trim()} (\`${m[2]}\`).` : `Couldn't create that schedule: ${r}`)
  }
  if ((m = text.match(/^delete schedule\s+(.+?)\s*$/im))) {
    lines.push(await useTool(mcp, "delete_schedule", { schedule: m[1] }))
  }
  if (!lines.length || /status|what.*(up|going)/i.test(text)) {
    const r = await useTool(mcp, "list_tasks", {})
    let tasks = []
    try {
      tasks = JSON.parse(r)
    } catch {}
    lines.push(
      tasks.length ? `Here's the yard:\n${tasks.map((t) => `- **${t.title}** (${t.project}): ${t.status}`).join("\n")}` : "No tasks yet.",
      "",
      "_This is the mock Claude. Try `create project demo`, then `task demo: Write a haiku -- write a haiku about boxes [artifact]`, or `schedule demo \"*/5 * * * *\": Haiku drop -- write a haiku [artifact]`._",
    )
  }
  await say(lines.join("\n"))
  return lines.join("\n")
}

async function worker(mcp, prompt) {
  const cwd = process.cwd()
  if (/\[slow\]/i.test(prompt)) await sleep(3000)
  if (/\[fail\]/i.test(prompt)) {
    console.error("fake failure requested by [fail]")
    process.exit(3)
  }
  await say("Looking at the task. (mock Claude)")
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }] } })

  if (/\[ask\]/i.test(prompt) && !session.turns.length) {
    await useTool(mcp, "ask_user", { question: "Which color should the button be: blue or green?" })
    return "I asked Cody which color to use."
  }
  const agent = prompt.match(/\[agent:([\w-]+)\]/i)
  if (agent) {
    await useTool(mcp, "message_agent", { to: agent[1], message: "Hi from another agent! What are you working on?", expect_reply: false })
  }
  if (/\[note\]/i.test(prompt)) await useTool(mcp, "save_note", { content: "The mock agent says: tests run with npm test." })
  if (/\[preview\]/i.test(prompt)) {
    const port = Number(process.env.PORT || 4000)
    await sh(
      `nohup node -e "require('http').createServer((q,r)=>r.end('<h1>Box Yard preview</h1>')).listen(${port},'0.0.0.0')" > /dev/null 2>&1 &`,
    )
    await useTool(mcp, "report_preview", { port, label: "Demo page" })
  }
  const file = path.join(cwd, "box-yard-demo.md")
  fs.writeFileSync(file, `# Mock result\n\nPrompt:\n\n${prompt.slice(0, 2000)}\n`)
  if (/\[artifact\]/i.test(prompt)) await useTool(mcp, "publish_artifact", { path: "box-yard-demo.md", title: "Mock report" })
  if (!/\[(ask|preview)\]/i.test(prompt) && !/^Message from agent/m.test(prompt)) {
    await useTool(mcp, "mark_done", { summary: "The mock agent wrote box-yard-demo.md." })
  }
  const reply = "Done for now. I wrote box-yard-demo.md."
  await say(reply)
  return reply
}

// ---------------------------------------------------------------- main

let prompt = ""
process.stdin.on("data", (d) => (prompt += d))
process.stdin.on("end", async () => {
  const started = Date.now()
  out({ type: "system", subtype: "init", session_id: session.id, tools: [], model: "fake" })
  let result = ""
  let mcp = null
  try {
    mcp = loadMcp()
    await mcp?.init()
    const isOrchestrator = mcp?.kind === "orchestrator"
    if (!mcp) {
      result = "(mock Claude) No MCP server configured."
      await say(result)
    } else if (isOrchestrator) result = await orchestrator(mcp, prompt)
    else result = await worker(mcp, prompt)
  } catch (err) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: String(err.message), session_id: session.id })
    process.exit(1)
  } finally {
    mcp?.close()
  }
  session.turns.push({ prompt, result, at: Date.now() })
  if (sessionFile) fs.writeFileSync(sessionFile, JSON.stringify(session))
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: session.id,
    duration_ms: Date.now() - started,
    num_turns: 1,
    total_cost_usd: 0,
  })
  process.exit(0)
})
