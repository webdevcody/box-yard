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
//   tell captain <project>: <message>         (send_to_captain)
//   ask captain <project>: <message>          (ask_captain, waits for the reply)
//   wait captain <project>                    (wait_for_captain)
//   status
//   [slow] / [slow:<seconds>]                 (takes 2 s / that long before replying)
// Replies stream word by word, 15 ms apart; FAKE_CLAUDE_WORD_MS=<ms> slows that down (a long reply to type over).
// A Captain answers an agent's message_captain ("[From task … (task_…), an agent …]") when the message has
// [reply] (reply_to_agent) or [reply-task] (send_to_task), after any [slow:<seconds>]; otherwise it doesn't reply.
// A Captain's "📝 Notes retro" wake accepts every suggestion it lists (resolve_suggestion, with a reason) and
// replies "(no update)"; FAKE_RETRO=reject rejects them instead, and FAKE_RETRO=skip leaves them all pending.
// Worker prompts understand these markers anywhere in the text:
//   [ask] [fail] [slow] [slow:<seconds>] [hang] [preview] [artifact] [agent:<taskId>] [note] [noop] [pr]
// [slow:<seconds>] says "Working on it slowly." and then takes that long (a turn to restart Box Yard under).
// [note] suggests a project note (suggest_note) for the Captain's notes retro.
// A line "message captain: <msg>" sends <msg> with message_captain (fire-and-forget); "message captain wait: <msg>"
// or "message captain wait <seconds>: <msg>" waits (default 30 s). The final reply quotes each tool result.
// [hang] keeps the turn running for two minutes (until it's stopped).
// FAKE_CLAUDE_GATE (env) holds each turn until a test says how it ends; see worker().
// With no marker the worker writes a file, publishes it, and marks itself done.
// [noop] marks the run done with outcome "noop" (a quiet schedule run), even alongside [ask] or [fail].
// [pr] ends the turn without mark_done, like an agent that opened a PR and waits for review.
// Logging in: a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY containing "revoked" fails like a bad token, and
// FAKE_CLAUDE_LOGIN=required fails every run that has neither, like the real CLI with no login.
// The Merge PR button's standard message ("Merge your pull request #N") stands in for `gh pr merge` when
// FAKE_GH_STATE names a file: the worker writes {"state":"MERGED"} there for a test's fake GitHub to read.
// FAKE_CLAUDE_COMPACT_FAIL=1 makes /compact fail (after the summary was written), FAKE_CLAUDE_BAD_SUMMARY=1 the summary.
// Side threads: `--resume <id> --resume-session-at <uuid> --fork-session --session-id <new>` copies the session's turns
// up to the one that printed <uuid> into a new session (the original is left alone), as the real CLI forks. Every
// assistant line carries a uuid. A side thread's reply says how many earlier turns it sees and quotes the last one's
// prompt; "try <tool>" in its question calls that Box Yard tool and quotes the result (a read-only check).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

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
const fork = args.includes("--fork-session")
const resumeAt = flag("--resume-session-at") ?? args.find((a) => a.startsWith("--resume-session-at="))?.slice("--resume-session-at=".length)
if (resumeId && newId && !fork) {
  console.error("Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.")
  process.exit(1)
}
const sessionId = fork ? (newId ?? randomUUID()) : (resumeId ?? newId)
const sessionFile = sessionId ? path.join(sessionsDir, `${sessionId}.json`) : null
const resumeFile = resumeId ? path.join(sessionsDir, `${resumeId}.json`) : null

if (resumeId && !fs.existsSync(resumeFile)) {
  console.error(`No conversation found with session ID: ${resumeId}`)
  process.exit(1)
}
if (newId && fs.existsSync(sessionFile)) {
  console.error(`Session ID ${newId} is already in use.`)
  process.exit(1)
}

const WINDOW = Number(process.env.FAKE_CLAUDE_WINDOW || 200_000)
const PER_TURN = Number(process.env.FAKE_CLAUDE_TOKENS_PER_TURN || 3000)
// The summary lists the live tasks Box Yard gave it, like a real one would.
const liveTasks = (prompt) => /Live task state from Box Yard[^\n]*\n((?:- .*\n?)+)/.exec(prompt)?.[1]?.trim()
const fmt = (n) => (n >= 1e6 ? `${n / 1e6}m` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n))
// Record how we were called, so tests can check flags (set FAKE_CLAUDE_LOG to a file).
// FAKE_CLAUDE_LOG_FULL=1 logs the whole prompt instead of its first 120 characters.

const session = resumeId ? JSON.parse(fs.readFileSync(resumeFile, "utf8")) : { id: sessionId, turns: [] }
session.tokens ??= 0
if (resumeAt) {
  // Only the turns up to and including the one that printed that line, like the real CLI's chain cut.
  const at = session.turns.findIndex((t) => (t.uuids ?? []).includes(resumeAt))
  if (at < 0) {
    console.error(`No message found with message.uuid of: ${resumeAt}`)
    process.exit(1)
  }
  session.turns = session.turns.slice(0, at + 1)
}
if (fork) Object.assign(session, { id: sessionId, forkedFrom: resumeId, forkedAt: resumeAt ?? null })
/** The uuids of the assistant lines this run prints (a later fork can cut there). */
const uuids = []
const usageNow = () => ({ input_tokens: session.tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 })
const out = (obj) => {
  // Every assistant message carries the usage of its API call, like the real CLI.
  if (obj.type === "assistant") {
    obj.message.usage = usageNow()
    obj.uuid = randomUUID()
    obj.session_id = session.id
    uuids.push(obj.uuid)
  }
  if (flag("--output-format") !== "stream-json") return // plain text mode prints only the text
  process.stdout.write(JSON.stringify(obj) + "\n")
}
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
      await sleep(Number(process.env.FAKE_CLAUDE_WORD_MS) || 15)
    }
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
}

function withNextSteps(text, steps) {
  return `${text}\n\n<!-- boxyard-next-steps\n${JSON.stringify(steps)}\n-->`
}

async function useTool(mcp, name, input) {
  const id = `t${Date.now()}`
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__boxyard__${name}`, input }] } })
  const result = await mcp.tool(name, input)
  const text = result?.content?.map((c) => c.text).join("") ?? ""
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: Boolean(result?.isError) }] } })
  return text
}

function sh(cmd) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], { stdio: "ignore" })
    p.on("close", (code) => resolve(code))
  })
}

// ---------------------------------------------------------------- behaviors

/** A Captain's notes retro: settle every suggestion it names. */
async function notesRetro(mcp, prompt) {
  const ids = [...new Set([...prompt.matchAll(/`(sug_[A-Za-z0-9_-]+)`/g)].map((m) => m[1]))]
  const mode = process.env.FAKE_RETRO
  const action = mode === "reject" ? "reject" : "accept"
  await useTool(mcp, "list_notes", {})
  if (mode !== "skip") for (const id of ids) await useTool(mcp, "resolve_suggestion", { suggestion: id, action, reason: `mock retro ${action}` })
  await say("(no update)")
  return "(no update)"
}

/** A side thread's turn: what it can see of the chat it forked, and any tool its question asks to try. */
async function sideThread(mcp, prompt) {
  const earlier = session.turns.filter((t) => !t.thread)
  const question = prompt.includes("[Box Yard side thread]") ? (prompt.split(/'s question:\n/).pop() ?? prompt) : prompt
  const lines = [`Side thread answer (mock Claude). I can see ${earlier.length} earlier chat turn${earlier.length === 1 ? "" : "s"}${session.forkedFrom ? " (forked)" : ""}.`]
  const last = earlier.at(-1)
  if (last) lines.push(`The last one asked: "${last.prompt.split("\n").filter((l) => l.trim() && !l.startsWith("[Yard now]") && !l.startsWith("- ")).pop()?.slice(0, 120) ?? ""}"`)
  if (/Your session for this thread was started fresh/.test(prompt)) lines.push("I started fresh from the summary.")
  lines.push(`You asked: ${question.trim().slice(0, 200)}`)
  const tool = question.match(/\btry (\w+)/i)
  if (tool) lines.push(`${tool[1]} said: ${(await useTool(mcp, tool[1], tool[1] === "create_task" ? { project: "demo", title: "From a side thread", prompt: "x" } : {})).slice(0, 300)}`)
  if (/\[slow\]/i.test(question)) await sleep(2000)
  await say(lines.join("\n\n"))
  return lines.join("\n")
}

async function orchestrator(mcp, prompt) {
  if (prompt.includes("📝 **Notes retro**")) return notesRetro(mcp, prompt)
  if (prompt.includes("[Box Yard side thread]") || session.thread) {
    session.thread = true
    return sideThread(mcp, prompt)
  }
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
  // Orchestrator schedule (no project): `oschedule "<cron>": <name> -- <prompt>`
  const oscheduleRe = /^oschedule\s+"([^"]+)":\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = oscheduleRe.exec(text))) {
    const r = await useTool(mcp, "create_schedule", { cron: m[1], name: m[2].trim(), prompt: (m[3] ?? m[2]).trim() })
    lines.push(r.startsWith("{") ? `Scheduled **${m[2].trim()}** for the orchestrator (\`${m[1]}\`).` : `Couldn't create that schedule: ${r}`)
  }
  const captainRe = /^(ask|tell) captain\s+([\w .-]+?):\s*(.+)$/gim
  while ((m = captainRe.exec(text))) {
    const ask = m[1].toLowerCase() === "ask"
    const r = await useTool(mcp, ask ? "ask_captain" : "send_to_captain", { project: m[2].trim(), message: m[3].trim(), ...(ask ? { timeout_seconds: 30 } : {}) })
    lines.push(ask ? `The ${m[2].trim()} Captain answered.` : `Sent that to the ${m[2].trim()} Captain.`, "```json", r.slice(0, 300), "```")
  }
  if ((m = text.match(/^wait captain\s+([\w .-]+?)\s*$/im))) {
    await useTool(mcp, "wait_for_captain", { project: m[1].trim(), timeout_seconds: 30 })
    lines.push(`The ${m[1].trim()} Captain is done.`)
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
  if (/\[slow\]/i.test(text)) await sleep(2000)
  if ((m = text.match(/\[slow:(\d+)\]/i))) await sleep(Number(m[1]) * 1000)
  // Agents' message_captain messages: reply when they ask for it.
  const agentRe = /^\[From task .*?\((task_[\w-]+)\), an agent[^\n]*\]\n([^\n]*)/gm
  while ((m = agentRe.exec(text))) {
    if (/\[reply\]/i.test(m[2])) await useTool(mcp, "reply_to_agent", { task: m[1], message: "Captain reply: go ahead, that's in scope." })
    else if (/\[reply-task\]/i.test(m[2])) await useTool(mcp, "send_to_task", { task: m[1], message: "Captain reply via send_to_task: go ahead." })
    else continue
    lines.push(`Answered ${m[1]}.`)
  }
  await say(withNextSteps(lines.join("\n"), ["Check the latest yard status", "Start a related task", "Summarize open decisions"]))
  return lines.join("\n")
}

async function worker(mcp, prompt) {
  const cwd = process.cwd()
  if (/\[slow\]/i.test(prompt)) await sleep(3000)
  const slow = prompt.match(/\[slow:(\d+)\]/i)
  if (slow) {
    // Some output first, so a test can tell the turn is under way (a restart mid-turn, say).
    await say("Working on it slowly. (mock Claude)")
    await sleep(Number(slow[1]) * 1000)
  }
  if (/\[hang\]/i.test(prompt)) await sleep(120_000)
  // FAKE_CLAUDE_GATE=<path>: each turn takes the next number n (a line in <path>.turns) and waits for <path>.<n>:
  // "fail" exits with an error, "kill" dies by SIGKILL (as the out-of-memory killer does), anything else carries on.
  // A test acts on the box while the turn runs. A test that fails before it says gives up the turn after 2 minutes,
  // so no fake agent is left waiting.
  const gate = process.env.FAKE_CLAUDE_GATE
  if (gate) {
    fs.appendFileSync(`${gate}.turns`, `${process.pid}\n`)
    const n = fs.readFileSync(`${gate}.turns`, "utf8").trim().split("\n").length
    const giveUp = Date.now() + 120_000
    while (!fs.existsSync(`${gate}.${n}`)) {
      if (Date.now() > giveUp) {
        console.error(`FAKE_CLAUDE_GATE: nothing said how turn ${n} ends`)
        process.exit(3)
      }
      await sleep(50)
    }
    const verdict = fs.readFileSync(`${gate}.${n}`, "utf8").trim()
    if (verdict === "kill") process.kill(process.pid, "SIGKILL")
    if (verdict === "fail") {
      console.error(`fake failure requested by FAKE_CLAUDE_GATE (turn ${n})`)
      process.exit(3)
    }
  }
  const noop = /\[noop\]/i.test(prompt)
  const markNoop = () => useTool(mcp, "mark_done", { summary: "Nothing to do this run.", outcome: "noop" })
  if (/\[fail\]/i.test(prompt)) {
    if (noop) await markNoop()
    console.error("fake failure requested by the fail marker")
    process.exit(3)
  }
  await say("Looking at the task. (mock Claude)")
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }] } })

  const merge = prompt.match(/Merge your pull request #(\d+)/i)
  if (merge && process.env.FAKE_GH_STATE) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `gh pr merge ${merge[1]} --squash --delete-branch` } }] } })
    fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ state: "MERGED", mergedBy: "fake-claude", number: Number(merge[1]) }))
    const reply = `Merged PR #${merge[1]} (mock gh pr merge).`
    await say(withNextSteps(reply, ["Check the merged PR", "Clean up the branch"]))
    return reply
  }

  if (/\[ask\]/i.test(prompt) && !session.turns.length) {
    await useTool(mcp, "ask_user", { question: "Which color should the button be: blue or green?" })
    if (noop) await markNoop()
    return "I asked Cody which color to use."
  }
  const agent = prompt.match(/\[agent:([\w-]+)\]/i)
  if (agent) {
    await useTool(mcp, "message_agent", { to: agent[1], message: "Hi from another agent! What are you working on?", expect_reply: false })
  }
  const captainNotes = []
  const captainRe = /^message captain(?: (wait)(?: (\d+))?)?:\s*(.+)$/gim
  let cm
  while ((cm = captainRe.exec(prompt))) {
    const wait = cm[1] ? Number(cm[2] ?? 30) : 0
    captainNotes.push(await useTool(mcp, "message_captain", { message: cm[3].trim(), ...(wait ? { wait_seconds: wait } : {}) }))
  }
  if (/\[note\]/i.test(prompt))
    await useTool(mcp, "suggest_note", { content: "The mock agent says: tests run with npm test.", why: "A future agent would guess the wrong test command." })
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
  // An agent that prints its credentials (the transcript keeps "[redacted]" instead, test/identities.e2e.test.ts).
  if (/\[print-env\]/i.test(prompt)) await say(`My env: GITHUB_TOKEN=${process.env.GITHUB_TOKEN ?? ""} ${Object.entries(process.env).filter(([k]) => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  if (noop) await markNoop()
  else if (!/\[(ask|preview|pr)\]/i.test(prompt) && !/^Message from agent/m.test(prompt)) {
    await useTool(mcp, "mark_done", { summary: "The mock agent wrote box-yard-demo.md." })
  }
  const reply = ["Done for now. I wrote box-yard-demo.md.", ...captainNotes.map((r) => `message_captain: ${r}`)].join("\n\n")
  await say(withNextSteps(reply, ["Review the mock result", "Run a broader check", "Ask for a PR-ready summary"]))
  return reply
}

// ---------------------------------------------------------------- main

let prompt = ""
process.stdin.on("data", (d) => (prompt += d))
process.stdin.on("end", async () => {
  const started = Date.now()
  out({ type: "system", subtype: "init", session_id: session.id, tools: [], model: "fake" })
  const login = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.ANTHROPIC_API_KEY].filter(Boolean)
  const loginError = login.some((t) => t.includes("revoked"))
    ? "Invalid API key · Please run /login"
    : process.env.FAKE_CLAUDE_LOGIN === "required" && !login.length
      ? "Not logged in · Please run /login"
      : null
  if (loginError) {
    out({ type: "result", subtype: "success", is_error: true, result: loginError, session_id: session.id })
    process.exit(1)
  }
  // Like the real CLI, a session exists from its first turn's start: a turn killed halfway can be resumed. Its turns
  // list gets this one at the end.
  if (sessionFile && (!resumeId || fork)) fs.writeFileSync(sessionFile, JSON.stringify(session))
  let result = ""
  let mcp = null
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt: process.env.FAKE_CLAUDE_LOG_FULL ? prompt : prompt.slice(0, 120) }) + "\n")
  // The prompt and the reply grow the context.
  if (!/^\s*\/(compact|context)\b/.test(prompt)) session.tokens += PER_TURN
  try {
    mcp = loadMcp()
    await mcp?.init()
    const isOrchestrator = mcp?.kind === "orchestrator"
    if (/^\s*\/compact\b/.test(prompt)) {
      // Like the real CLI: same session, much smaller context, nothing printed as a message.
      if (!session.turns.length) throw new Error("Nothing to compact")
      if (process.env.FAKE_CLAUDE_COMPACT_FAIL) throw new Error("fake /compact failure (FAKE_CLAUDE_COMPACT_FAIL)")
      session.tokens = 2000
      result = ""
    } else if (/^\s*\/context\b/.test(prompt)) {
      result = `## Context Usage\n\n**Model:** fake  \n**Tokens:** ${fmt(session.tokens)} / ${fmt(WINDOW)} (${Math.round((session.tokens / WINDOW) * 100)}%)\n`
      process.stdout.write(result)
    } else if (/Your (Captain )?context( for project "[^"]*")? is about to be compacted/.test(prompt)) {
      result = process.env.FAKE_CLAUDE_BAD_SUMMARY
        ? "ok"
        : `## Decisions and preferences\n- Cody prefers short replies.\n\n## Projects and repos\n- demo (acme/demo): a demo project.\n\n## Ongoing work\n${liveTasks(prompt) || "- none"}\n\n## Open threads and next steps\n- none`
      await say(result)
    } else if (!mcp) {
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
  session.turns.push({ prompt, result, at: Date.now(), uuids, ...(session.thread ? { thread: true } : {}) })
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
    usage: usageNow(),
    modelUsage: { fake: { contextWindow: WINDOW } },
  })
  process.exit(0)
})
