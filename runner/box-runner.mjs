#!/usr/bin/env node
// Box Yard worker runner. Copied into every worker box and run there with plain
// Node (no npm install). It has three modes:
//
//   node box-runner.mjs turn  <taskDir>  run one headless Claude turn for a task
//   node box-runner.mjs mcp   <taskDir>  stdio MCP server Claude uses to talk back
//   node box-runner.mjs clean <taskDir>  delete regenerable dirs from a resting work/
//
// Every event goes into <taskDir>/events.jsonl, and also into an Upstash Redis
// stream when task.json has Redis credentials. Each event has a `seq` number so
// the orchestrator can mix both sources without duplicates.
//
// Layout of <taskDir>:
//   task.json     task settings written by the orchestrator (env, repo, redis)
//   turn.json     the turn to run (prompt, session id, resume flag)
//   work/         the agent's working directory (repo clone or scratch space)
//   claude/       CLAUDE_CONFIG_DIR, so the session transcript lives with the task
//   events.jsonl  append-only event log
//   turn.pid      pid of the running turn

import { spawn, execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const RUNNER_VERSION = "1"
const [, , mode, taskDirArg] = process.argv

if (!mode || !taskDirArg) {
  console.error("usage: box-runner.mjs <turn|mcp|clean> <taskDir>")
  process.exit(2)
}

const taskDir = path.resolve(taskDirArg)
const task = mode === "clean" ? {} : readJson(path.join(taskDir, "task.json"))

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (fallback !== undefined) return fallback
    throw new Error(`Can't read ${file}: ${err.message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Event log. A mkdir lock keeps seq numbers and file order in step even though
// the turn runner and the MCP server are separate processes.

const eventsFile = path.join(taskDir, "events.jsonl")
const seqFile = path.join(taskDir, "events.seq")
const lockDir = path.join(taskDir, "events.lock")

async function withLock(fn) {
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      // A crashed writer can leave the lock behind. Break it after 10s.
      if (Date.now() - started > 10_000) {
        try {
          fs.rmdirSync(lockDir)
        } catch {}
      }
      await sleep(15)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {}
  }
}

async function redis(command) {
  if (!task.redis?.url || !task.redis?.token) return null
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(task.redis.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${task.redis.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
      return body.result
    } catch (err) {
      lastErr = err
      await sleep(250 * 2 ** attempt)
    }
  }
  // The event is still in events.jsonl; the orchestrator falls back to it.
  process.stderr.write(`[box-yard] redis failed: ${lastErr?.message}\n`)
  return null
}

async function emit(event) {
  return withLock(async () => {
    const prev = Number.parseInt(fs.existsSync(seqFile) ? fs.readFileSync(seqFile, "utf8") : "0", 10) || 0
    const seq = prev + 1
    fs.writeFileSync(seqFile, String(seq))
    const full = { seq, ts: Date.now(), turnId: currentTurnId(), ...event }
    const line = JSON.stringify(full)
    fs.appendFileSync(eventsFile, line + "\n")
    if (task.redis?.key) await redis(["XADD", task.redis.key, "MAXLEN", "~", "5000", "*", "e", line])
    return full
  })
}

function currentTurnId() {
  return readJson(path.join(taskDir, "turn.json"), {}).turnId ?? null
}

const clip = (s, n) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "")
  return str.length > n ? `${str.slice(0, n)}…` : str
}

// ---------------------------------------------------------------------------
// Turn mode

let activeChild = null
let stopping = false

// `kill -TERM -<pid>` from the orchestrator stops the turn: end Claude, then
// still write turn_end so the task doesn't look stuck.
process.on("SIGTERM", () => {
  if (mode !== "turn" || stopping) return
  stopping = true
  try {
    activeChild?.kill("SIGTERM")
  } catch {}
  setTimeout(() => {
    try {
      activeChild?.kill("SIGKILL")
    } catch {}
  }, 5000).unref()
})

async function runTurn() {
  const turn = readJson(path.join(taskDir, "turn.json"))
  fs.writeFileSync(path.join(taskDir, "turn.pid"), String(process.pid))
  await emit({ t: "turn_start", runner: RUNNER_VERSION })

  const mcpConfigFile = path.join(taskDir, "mcp.json")
  fs.writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        boxyard: { type: "stdio", command: process.execPath, args: [process.argv[1], "mcp", taskDir] },
      },
    }),
  )

  let sessionId = turn.sessionId
  let attempt = await runClaude({ turn, sessionId, resume: turn.resume, prompt: turn.prompt, mcpConfigFile })

  // The session file can go missing (fresh box, lost archive). Start a new
  // session that carries a recap instead of failing the task.
  if (!stopping && attempt.exitCode !== 0 && turn.resume && /no conversation found|session.*not found/i.test(attempt.errorText)) {
    sessionId = randomUUID()
    await emit({ t: "session_reset", sessionId, reason: "Previous Claude session was not found on this box." })
    const prompt = `${turn.recap ?? ""}\n\n---\n\n${turn.prompt}`.trim()
    attempt = await runClaude({ turn, sessionId, resume: false, prompt, mcpConfigFile })
  }

  const ok = stopping || (attempt.exitCode === 0 && !attempt.result?.is_error)
  let usage = attempt.usage
  if (turn.compact && ok && !stopping) {
    // /compact prints no usage of its own; ask the session what it holds now.
    usage = (await contextReport(sessionId, turn.model || task.model)) ?? null
  }
  await emit({
    t: "turn_end",
    startedAt: attempt.startedAt,
    stopped: stopping,
    exitCode: attempt.exitCode,
    ok,
    result: attempt.result?.result ?? null,
    costUsd: attempt.result?.total_cost_usd ?? null,
    durationMs: attempt.result?.duration_ms ?? null,
    numTurns: attempt.result?.num_turns ?? null,
    sessionId,
    compact: Boolean(turn.compact),
    usage,
    resultUsage: attempt.result?.usage ?? null,
    error: ok ? null : clip(attempt.errorText || attempt.result?.result || `claude exited with code ${attempt.exitCode}`, 2000),
  })
  // turn.pid stays behind on purpose: the orchestrator checks it with kill -0,
  // and a fast turn must not finish before the orchestrator sees it started.
}

function claudeEnv() {
  const claudeConfigDir = path.join(taskDir, "claude")
  const isolate = task.isolateConfig !== false
  return {
    ...process.env,
    ...task.env,
    ...(isolate ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    IS_SANDBOX: "1",
    DISABLE_AUTOUPDATER: "1",
    PORT: String(task.port ?? 4000),
    BOXYARD_TASK_ID: task.taskId,
    BOXYARD_TASK_DIR: taskDir,
  }
}

/** Tokens in the context after one API call: its prompt side plus what it just wrote. */
function contextTokensOf(u) {
  if (!u) return null
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n > 0 ? n : null
}

function contextWindowOf(modelUsage) {
  let best = null
  for (const v of Object.values(modelUsage ?? {})) if (typeof v?.contextWindow === "number" && v.contextWindow > (best ?? 0)) best = v.contextWindow
  return best
}

const AMOUNT = { "": 1, k: 1e3, m: 1e6 }
function parseAmount(str) {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(str.trim())
  return m ? Math.round(Number(m[1]) * AMOUNT[m[2].toLowerCase()]) : null
}

/** `claude -p "/context"` on the session: its "Tokens: 84k / 1m (8%)" line, or null if anything is off. */
function contextReport(sessionId, model) {
  return new Promise((resolve) => {
    const args = [...(task.claudeArgs ?? []), "-p", "--resume", sessionId]
    if (model) args.push("--model", model)
    const child = spawn(task.claudeBin || "claude", [...args], { cwd: path.join(taskDir, "work"), env: claudeEnv(), stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000)
    child.stdout.on("data", (d) => (out += d))
    child.on("error", () => resolve(null))
    child.on("close", () => {
      clearTimeout(timer)
      const m = /Tokens:?\**\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(out)
      const tokens = m && parseAmount(m[1])
      const window = m && parseAmount(m[2])
      resolve(tokens && window ? { tokens, window } : null)
    })
    child.stdin.on("error", () => {})
    child.stdin.end("/context")
  })
}

function runClaude({ turn, sessionId, resume, prompt, mcpConfigFile }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigFile,
      "--append-system-prompt",
      turn.systemPrompt ?? "",
    ]
    if (resume) args.push("--resume", sessionId)
    else args.push("--session-id", sessionId)
    const model = turn.model || task.model
    if (model) args.push("--model", model)
    if (turn.effort) args.push("--effort", turn.effort)
    if (turn.autocompact) args.push("--autocompact", String(turn.autocompact))

    const workDir = path.join(taskDir, "work")
    const claudeConfigDir = path.join(taskDir, "claude")
    // Keep the session transcript inside the task folder so it moves with the
    // task between boxes. Local runs that rely on the user's own `claude`
    // login turn this off, since that login lives in the default config dir.
    const isolate = task.isolateConfig !== false
    if (isolate) fs.mkdirSync(claudeConfigDir, { recursive: true })

    const child = spawn(task.claudeBin || "claude", [...(task.claudeArgs ?? []), ...args], {
      cwd: workDir,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })

    activeChild = child
    let result = null
    let usage = null
    let stderr = ""
    let buf = ""
    let pending = Promise.resolve()
    const queue = (fn) => (pending = pending.then(fn).catch((e) => process.stderr.write(`${e.stack}\n`)))

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          queue(() => emit({ t: "log", text: clip(line, 1000) }))
          continue
        }
        if (msg.type === "result") result = msg
        const tokens = msg.type === "assistant" && msg.message?.model !== "<synthetic>" ? contextTokensOf(msg.message?.usage) : null
        if (tokens && tokens !== usage?.tokens) {
          usage = { tokens, window: usage?.window ?? null }
          queue(() => emit({ t: "usage", tokens, window: usage.window }))
        }
        for (const ev of translate(msg)) queue(() => emit(ev))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000)
    })
    child.on("error", (err) => {
      stderr += `\n${err.message}`
    })
    child.on("close", (code) => {
      if (buf.trim()) {
        try {
          const msg = JSON.parse(buf)
          if (msg.type === "result") result = msg
          for (const ev of translate(msg)) queue(() => emit(ev))
        } catch {}
        buf = ""
      }
      pending.then(() => {
        const window = contextWindowOf(result?.modelUsage)
        if (usage && window) usage.window = window
        resolve({ exitCode: code ?? 1, startedAt, result, usage, errorText: [stderr.trim(), result?.is_error ? result.result : ""].filter(Boolean).join("\n") })
      })
    })

    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

/** Turn one Claude stream-json message into zero or more compact events. */
function translate(msg) {
  const out = []
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text?.trim()) out.push({ t: "assistant", text: block.text })
      // Box Yard's own tools emit their own, richer events.
      if (block.type === "tool_use" && !String(block.name).startsWith("mcp__boxyard__")) {
        out.push({ t: "tool", name: block.name, input: clip(block.input, 400) })
      }
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("") : block.content
        out.push({ t: "tool_error", text: clip(text, 400) })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// MCP mode: newline-delimited JSON-RPC over stdio.

const TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask Cody (the human) a question when you need a decision, credentials, or information you cannot find. After calling this, end your turn; the answer arrives as your next message.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "One clear question, with the options if there are any." } },
      required: ["question"],
    },
  },
  {
    name: "list_agents",
    description: "List the other Box Yard agents (tasks), their projects and status, so you can coordinate with them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_agent",
    description:
      "Send a message to another agent by task id. Set expect_reply to true if you need an answer; then end your turn and the reply will arrive as your next message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Task id of the other agent (from list_agents)." },
        message: { type: "string" },
        expect_reply: { type: "boolean", default: false },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "save_note",
    description:
      "Save a durable fact to the project's shared notes (decisions, gotchas, how to run things). Every future agent in this project sees these notes.",
    inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "read_notes",
    description: "Read the project's shared notes written by Cody and other agents.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_pull_request",
    description:
      "Push the current branch and open a GitHub pull request (or return the open one). Commit your changes first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown summary of the change and how it was tested." },
        draft: { type: "boolean", default: false },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "report_preview",
    description:
      "Tell Box Yard a server is listening on a port so it can give Cody a public preview URL. Start the server in the background first (nohup ... &) and bind 0.0.0.0. Use $PORT to $PORT+9.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "integer" }, label: { type: "string" } },
      required: ["port"],
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a file you made (report, image, HTML page, PDF, zip...) so Box Yard hosts it for Cody. Max 25 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working directory, or absolute." },
        title: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "mark_done",
    description:
      'Mark the task finished, with a short summary of the outcome. Use when no PR is needed or after the PR is up and nothing is left. For a scheduled run that found nothing to do and changed nothing (no commits, PR, artifact, preview or question), pass outcome "noop" so Box Yard files it as a quiet run instead of notifying Cody.',
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string", enum: ["noop"], description: 'Only "noop": this run found nothing to do and changed nothing.' },
      },
      required: ["summary"],
    },
  },
]

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: path.join(taskDir, "work"), env: { ...process.env, ...task.env }, maxBuffer: 10 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
  })
}

async function liveDirectory() {
  if (task.redis?.url) {
    const raw = await redis(["GET", "boxyard:directory"])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).directory ?? []
}

async function liveNotes() {
  if (task.redis?.url) {
    const raw = await redis(["GET", `boxyard:notes:${task.projectId}`])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).notes ?? []
}

async function callTool(name, args = {}) {
  switch (name) {
    case "ask_user": {
      if (!args.question?.trim()) return text("question is required", true)
      await emit({ t: "ask_user", question: args.question.trim() })
      return text("Your question was sent to Cody. End your turn now; the answer will arrive as your next message.")
    }
    case "list_agents": {
      const agents = (await liveDirectory()).filter((a) => a.id !== task.taskId)
      if (!agents.length) return text("No other agents right now.")
      return text(agents.map((a) => `- ${a.id} | ${a.title} | project: ${a.project} | ${a.status}`).join("\n"))
    }
    case "message_agent": {
      if (!args.to || !args.message) return text("to and message are required", true)
      if (args.to === task.taskId) return text("That's you.", true)
      await emit({ t: "message_agent", to: String(args.to), message: String(args.message), expectReply: Boolean(args.expect_reply) })
      return text(
        args.expect_reply
          ? "Message sent. End your turn now; the reply will arrive as your next message."
          : "Message sent.",
      )
    }
    case "save_note": {
      if (!args.content?.trim()) return text("content is required", true)
      await emit({ t: "note", content: args.content.trim() })
      return text("Saved to the project notes.")
    }
    case "read_notes": {
      const notes = await liveNotes()
      if (!notes.length) return text("No notes yet.")
      return text(notes.map((n) => `- (${n.author}) ${n.content}`).join("\n"))
    }
    case "create_pull_request":
      return createPullRequest(args)
    case "report_preview": {
      const port = Number(args.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return text("port must be an integer 1-65535", true)
      await emit({ t: "preview", port, label: args.label ? String(args.label) : `Port ${port}` })
      return text(`Preview registered for port ${port}. Box Yard will show Cody the public URL. Keep the server running.`)
    }
    case "publish_artifact": {
      const p = path.resolve(path.join(taskDir, "work"), String(args.path ?? ""))
      let stat
      try {
        stat = fs.statSync(p)
      } catch {
        return text(`File not found: ${p}`, true)
      }
      if (!stat.isFile()) return text(`${p} is not a file`, true)
      if (stat.size > 25 * 1024 * 1024) return text("File is over 25 MB; compress or split it.", true)
      // Same rules as the server's safeFilename, so the URL we hand out is the real one.
      const filename = path.basename(p).replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120) || "file"
      const id = `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      const url = `${task.publicUrl ? task.publicUrl.replace(/\/$/, "") : ""}/artifacts/${id}/${encodeURIComponent(filename)}`
      await emit({ t: "artifact", id, path: p, title: args.title ? String(args.title) : path.basename(p), size: stat.size })
      return text(`Published ${filename}. Box Yard will host it at ${url} (live within a few seconds). Share that link.`)
    }
    case "mark_done": {
      const summary = String(args.summary ?? "").trim() || "Done."
      if (args.outcome === undefined || args.outcome === null || args.outcome === "") {
        await emit({ t: "done", summary })
        return text("Marked done. End your turn.")
      }
      if (args.outcome !== "noop") return text('outcome must be "noop" (or left out)', true)
      // Box Yard checks the noop mark against what the run did; commits are only visible from here.
      await emit({ t: "done", summary, outcome: "noop", commits: await unpushedWork() })
      return text("Marked done as a no-op run. Box Yard hides it unless the run changed something. End your turn.")
    }
    default:
      return text(`Unknown tool ${name}`, true)
  }
}

/** Commits on any local branch that aren't on origin's base branch, or null outside a git repo. */
async function unpushedWork() {
  const base = task.baseBranch || "main"
  const res = await sh("git", ["rev-list", "--count", "--branches", "--not", `refs/remotes/origin/${base}`])
  if (res.code !== 0) return null
  const n = Number(res.stdout.trim())
  return Number.isFinite(n) ? n : null
}

async function createPullRequest(args) {
  const slug = task.github?.slug
  const token = task.env?.GITHUB_TOKEN
  if (!slug) return text("This project has no GitHub repo, so there is nothing to open a PR against.", true)
  if (!token) return text("GITHUB_TOKEN is not set for this task; ask Cody with ask_user.", true)

  const branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  if (!branch || branch === "HEAD") return text("Not on a branch. Create one with git checkout -b.", true)
  if (branch === task.baseBranch) return text(`You're on ${task.baseBranch}. Create a feature branch and commit there.`, true)
  const dirty = (await sh("git", ["status", "--porcelain"])).stdout.trim()
  if (dirty) return text(`You have uncommitted changes:\n${clip(dirty, 1500)}\nCommit them first.`, true)

  const push = await sh("git", ["push", "-u", "origin", branch])
  if (push.code !== 0) return text(`git push failed:\n${clip(push.stderr || push.stdout, 2000)}`, true)

  const gh = async (method, url, body) => {
    const res = await fetch(`https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "box-yard",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message ?? "request failed"} ${JSON.stringify(data.errors ?? "")}`)
    return data
  }

  try {
    const owner = slug.split("/")[0]
    const open = await gh("GET", `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    let pr = Array.isArray(open) ? open[0] : null
    let created = false
    if (!pr) {
      pr = await gh("POST", `/repos/${slug}/pulls`, {
        title: String(args.title),
        body: `${args.body ?? ""}\n\n---\n_Opened by a Box Yard agent (task ${task.taskId})._`,
        head: branch,
        base: task.baseBranch,
        draft: Boolean(args.draft),
      })
      created = true
    }
    await emit({ t: "pr", url: pr.html_url, number: pr.number, branch })
    return text(`${created ? "Opened" : "Updated (pushed to)"} PR #${pr.number}: ${pr.html_url}`)
  } catch (err) {
    return text(String(err.message), true)
  }
}

function serveMcp() {
  let buf = ""
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        continue
      }
      handle(req).then(
        (result) => req.id !== undefined && result !== undefined && send({ jsonrpc: "2.0", id: req.id, result }),
        (err) => req.id !== undefined && send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } }),
      )
    }
  })
  process.stdin.on("end", () => process.exit(0))

  async function handle(req) {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "boxyard", version: RUNNER_VERSION },
        }
      case "ping":
        return {}
      case "tools/list":
        return { tools: TOOLS }
      case "tools/call":
        return callTool(req.params?.name, req.params?.arguments ?? {})
      default:
        if (req.id === undefined) return undefined // notification
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 })
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace cleanup. Runs between turns to free disk on resting tasks. It must
// never destroy source: inside a git repo it only deletes directories git
// reports as ignored *and* untracked, and only when their name is on the list.
// Outside any repo it can't tell source from output, so it only deletes the
// few names that are always generated (a committed `build/` or `dist/` is real
// source in plenty of repos; a `node_modules/` never is).

const CLEAN_IN_REPO = new Set([
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", "target", ".venv", "__pycache__",
])
const CLEAN_OUTSIDE_REPO = new Set(["node_modules", "__pycache__"])
const CLEAN_MAX_DEPTH = 6

function gitOut(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

async function cleanRepo(repo, removed) {
  // --directory collapses a fully untracked dir into one "dir/" entry, so a
  // dir that holds any tracked file is never listed as a whole.
  const out = await gitOut(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
  if (out === null) return // git missing or broken repo: leave it alone
  for (const entry of out.split("\0")) {
    if (!entry.endsWith("/")) continue
    const rel = entry.slice(0, -1)
    if (!CLEAN_IN_REPO.has(path.basename(rel))) continue
    // Belt and braces: re-check that git tracks nothing under it.
    const tracked = await gitOut(repo, ["ls-files", "-z", "--", rel])
    if (tracked !== "") continue
    const abs = path.join(repo, rel)
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue
    fs.rmSync(abs, { recursive: true, force: true })
    removed.push(abs)
  }
}

async function cleanDir(dir, depth, removed) {
  if (fs.existsSync(path.join(dir, ".git"))) return cleanRepo(dir, removed)
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue // skips symlinks too
    const abs = path.join(dir, e.name)
    if (CLEAN_OUTSIDE_REPO.has(e.name)) {
      fs.rmSync(abs, { recursive: true, force: true })
      removed.push(abs)
    } else if (depth < CLEAN_MAX_DEPTH) {
      await cleanDir(abs, depth + 1, removed)
    }
  }
}

async function cleanWorkspace() {
  const work = path.join(taskDir, "work")
  if (!fs.existsSync(work)) return
  const removed = []
  await cleanDir(work, 0, removed)
  for (const p of removed) console.log(path.relative(work, p))
}

// ---------------------------------------------------------------------------

if (mode === "turn") {
  runTurn().then(
    () => process.exit(0),
    async (err) => {
      try {
        await emit({ t: "turn_end", exitCode: 1, ok: false, error: `runner crashed: ${err?.stack ?? err}` })
      } catch {}
      process.exit(1)
    },
  )
} else if (mode === "mcp") {
  serveMcp()
} else if (mode === "clean") {
  cleanWorkspace().then(
    () => process.exit(0),
    (err) => {
      console.error(`clean failed: ${err?.stack ?? err}`)
      process.exit(1)
    },
  )
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
