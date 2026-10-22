#!/usr/bin/env node
// Box Yard worker runner. Copied into every worker box and run there with plain
// Node (no npm install). It has two modes:
//
//   node box-runner.mjs turn <taskDir>   run one headless Claude turn for a task
//   node box-runner.mjs mcp  <taskDir>   stdio MCP server Claude uses to talk back
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
  console.error("usage: box-runner.mjs <turn|mcp> <taskDir>")
  process.exit(2)
}

const taskDir = path.resolve(taskDirArg)
const task = readJson(path.join(taskDir, "task.json"))

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
  if (attempt.exitCode !== 0 && turn.resume && /no conversation found|session.*not found/i.test(attempt.errorText)) {
    sessionId = randomUUID()
    await emit({ t: "session_reset", sessionId, reason: "Previous Claude session was not found on this box." })
    const prompt = `${turn.recap ?? ""}\n\n---\n\n${turn.prompt}`.trim()
    attempt = await runClaude({ turn, sessionId, resume: false, prompt, mcpConfigFile })
  }

  const ok = attempt.exitCode === 0 && !attempt.result?.is_error
  await emit({
    t: "turn_end",
    exitCode: attempt.exitCode,
    ok,
    result: attempt.result?.result ?? null,
    costUsd: attempt.result?.total_cost_usd ?? null,
    durationMs: attempt.result?.duration_ms ?? null,
    numTurns: attempt.result?.num_turns ?? null,
    sessionId,
    error: ok ? null : clip(attempt.errorText || attempt.result?.result || `claude exited with code ${attempt.exitCode}`, 2000),
  })
  try {
    fs.unlinkSync(path.join(taskDir, "turn.pid"))
  } catch {}
}

function runClaude({ turn, sessionId, resume, prompt, mcpConfigFile }) {
  return new Promise((resolve) => {
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
    if (task.model) args.push("--model", task.model)

    const workDir = path.join(taskDir, "work")
    const claudeConfigDir = path.join(taskDir, "claude")
    fs.mkdirSync(claudeConfigDir, { recursive: true })

    const child = spawn(task.claudeBin || "claude", args, {
      cwd: workDir,
      env: {
        ...process.env,
        ...task.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        IS_SANDBOX: "1",
        DISABLE_AUTOUPDATER: "1",
        PORT: String(task.port ?? 4000),
        BOXYARD_TASK_ID: task.taskId,
        BOXYARD_TASK_DIR: taskDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let result = null
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
      pending.then(() =>
        resolve({ exitCode: code ?? 1, result, errorText: [stderr.trim(), result?.is_error ? result.result : ""].filter(Boolean).join("\n") }),
      )
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
    description: "Mark the task finished, with a short summary of the outcome. Use when no PR is needed or after the PR is up and nothing is left.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
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
      await emit({ t: "artifact", path: p, title: args.title ? String(args.title) : path.basename(p), size: stat.size })
      return text(`Published ${path.basename(p)}. Box Yard will host it.`)
    }
    case "mark_done": {
      await emit({ t: "done", summary: String(args.summary ?? "").trim() || "Done." })
      return text("Marked done. End your turn.")
    }
    default:
      return text(`Unknown tool ${name}`, true)
  }
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
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
