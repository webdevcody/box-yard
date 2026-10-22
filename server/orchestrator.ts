import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import { ORCHESTRATOR_PROMPT } from "./prompts.js"
import type { ChatMessage } from "../shared/types.js"

const TURN_TIMEOUT_MS = 15 * 60_000
/** Wait this long after a task update before waking the orchestrator, to batch updates. */
const WAKE_DEBOUNCE_MS = 4000
/** Automatic turns in a row (no message from Cody in between) before it stops waking itself. */
const MAX_AUTO_TURNS = 8
const SESSION_KEY = "orchestrator_session"
const STARTED_KEY = "orchestrator_session_started"

/**
 * The orchestrator is Claude Code in headless mode with the Box Yard MCP
 * tools. Every chat message runs `claude -p --resume <session>` so the
 * conversation keeps its context across messages and restarts.
 */
export class Orchestrator {
  private running = false
  private pending = false
  private wakeWanted = false
  private wakeTimer: NodeJS.Timeout | null = null
  private autoTurns = 0
  private child: ChildProcess | null = null
  private readonly workdir: string
  private readonly mcpConfigPath: string

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    mcp: { url: string; token: string },
  ) {
    this.workdir = path.join(c.dataDir, "orchestrator")
    fs.mkdirSync(this.workdir, { recursive: true })
    this.mcpConfigPath = path.join(c.dataDir, "orchestrator-mcp.json")
    this.mcpConfig = JSON.stringify({
      mcpServers: { boxyard: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
    })
  }

  private readonly mcpConfig: string

  /**
   * Written before every turn rather than once at startup: the token is per
   * process, and another server process starting on the same data dir (say,
   * one that then fails to bind the port) must not leave us a stale token.
   */
  private writeMcpConfig() {
    fs.writeFileSync(this.mcpConfigPath, this.mcpConfig, { mode: 0o600 })
  }

  get busy() {
    return this.running
  }

  /** Save Cody's message and make sure a turn will pick it up. */
  send(content: string, id?: string): ChatMessage {
    const msg = this.store.addChat("user", content.trim(), null, id)
    this.hub.broadcast({ type: "chat.message", message: msg })
    this.pending = true
    this.autoTurns = 0
    void this.drain()
    return msg
  }

  /**
   * A task finished, failed, asked something or opened a PR. Wake the
   * orchestrator (after a short pause to batch updates) so it can tell Cody
   * and carry on with work he already asked for, without waiting for his
   * next message.
   */
  nudge() {
    if (!this.c.orchestratorAutoWake || this.wakeTimer) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      if (!this.store.hasUnseenNotices()) return
      this.wakeWanted = true
      void this.drain()
    }, WAKE_DEBOUNCE_MS)
    this.wakeTimer.unref?.()
  }

  stop() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.cancel()
  }

  /** Stop the current turn. */
  cancel() {
    this.child?.kill("SIGTERM")
  }

  reset() {
    this.cancel()
    this.store.setKv(SESSION_KEY, null)
    this.store.setKv(STARTED_KEY, null)
    this.store.clearChat()
  }

  private session() {
    let id = this.store.getKv(SESSION_KEY)
    if (!id) {
      id = randomUUID()
      this.store.setKv(SESSION_KEY, id)
      this.store.setKv(STARTED_KEY, null)
    }
    return { id, started: this.store.getKv(STARTED_KEY) === "1" }
  }

  private async drain() {
    if (this.running) return
    this.running = true
    this.hub.broadcast({ type: "chat.busy", busy: true })
    try {
      while (this.pending || this.wakeWanted) {
        if (this.pending) {
          this.pending = false
          this.wakeWanted = false
          await this.turn()
        } else {
          this.wakeWanted = false
          await this.autoTurn()
        }
      }
    } finally {
      this.running = false
      this.hub.broadcast({ type: "chat.busy", busy: false })
    }
  }

  /** Messages Cody sent since the orchestrator last replied. */
  private unansweredUserMessages(): string[] {
    const since = Number(this.store.getKv("orchestrator_last_turn_at") ?? 0)
    return this.store
      .listChat(200)
      .filter((m) => m.role === "user" && m.createdAt >= since)
      .map((m) => m.content)
  }

  /** A turn with only task updates in it: report them and keep Cody's work moving. */
  private async autoTurn() {
    if (this.autoTurns >= MAX_AUTO_TURNS) return
    const notices = this.store.takeUnseenNotices()
    if (!notices.length) return
    this.autoTurns++
    await this.runPrompt(
      [
        `[Box Yard updates since your last turn]\n${notices.map((n) => `- ${n}`).join("\n")}`,
        `(Automatic wake-up: there is no new message from Cody. Tell him in a line or two what finished, failed or needs him, with links. ` +
          `If an update completes a step of work Cody already asked for and the next step is clear, start it. ` +
          `Don't start unrelated work, and don't repeat things you already told him.)`,
      ].join("\n\n"),
    )
  }

  private async turn() {
    const messages = this.unansweredUserMessages()
    if (!messages.length) return
    this.store.setKv("orchestrator_last_turn_at", String(Date.now() + 1))
    const notices = this.store.takeUnseenNotices()
    const prompt = [
      notices.length ? `[Box Yard updates since your last turn]\n${notices.map((n) => `- ${n}`).join("\n")}` : "",
      messages.join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n\n")
    await this.runPrompt(prompt)
  }

  /** A one-glance view of the yard, so the orchestrator never works from stale memory. */
  private yardNow(): string {
    const projects = new Map(this.store.listProjects().map((p) => [p.id, p.name]))
    const lines = this.store
      .listTasks({ status: ["queued", "starting", "working", "needs_input", "waiting"] })
      .map((t) => `- ${t.id} "${t.title}" [${projects.get(t.projectId) ?? "?"}] ${t.status}${t.pendingCount ? ` (+${t.pendingCount} queued messages)` : ""}`)
    return `[Yard now] ${lines.length ? `busy or waiting agents:\n${lines.join("\n")}` : "no agents are busy; every task is idle, done or failed."}`
  }

  private async runPrompt(body: string) {
    const prompt = `${this.yardNow()}\n\n${body}`
    const s = this.session()
    let result = await this.run(prompt, s.id, s.started)
    if (!result.ok && s.started && /no conversation found|session.*not found/i.test(result.error)) {
      // Session file is gone (new machine, wiped data). Start over with a recap.
      const fresh = randomUUID()
      this.store.setKv(SESSION_KEY, fresh)
      const recap = this.store
        .listChat(30)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `[${m.role}] ${m.content.slice(0, 800)}`)
        .join("\n")
      result = await this.run(`Earlier conversation (your session was reset):\n${recap}\n\n---\n\n${prompt}`, fresh, false)
    }
    if (!result.ok) {
      const msg = this.store.addChat("error", `The orchestrator hit an error: ${result.error.slice(0, 1500)}`)
      this.hub.broadcast({ type: "chat.message", message: msg })
    }
  }

  private run(prompt: string, sessionId: string, resume: boolean): Promise<{ ok: boolean; error: string }> {
    return new Promise((resolve) => {
      this.writeMcpConfig()
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--mcp-config",
        this.mcpConfigPath,
        "--tools",
        "WebSearch,WebFetch",
        "--allowedTools",
        "mcp__boxyard,WebSearch,WebFetch",
        "--permission-mode",
        "dontAsk",
        "--append-system-prompt",
        ORCHESTRATOR_PROMPT,
        ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
        ...(this.c.orchestratorModel ? ["--model", this.c.orchestratorModel] : []),
      ]
      const [bin, ...pre] = this.c.claudeBin.split(" ")
      const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
      // When Box Yard itself was started from inside a Claude Code session, don't
      // let the orchestrator think it is that session's child.
      for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
      if (this.c.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.c.claudeOauthToken
      if (this.c.anthropicApiKey) env.ANTHROPIC_API_KEY = this.c.anthropicApiKey

      let child: ChildProcess
      try {
        child = spawn(bin!, [...pre, ...args], { cwd: this.workdir, env, stdio: ["pipe", "pipe", "pipe"] })
      } catch (err) {
        resolve({ ok: false, error: `Couldn't start claude: ${(err as Error).message}` })
        return
      }
      this.child = child
      let stderr = ""
      let buf = ""
      let sawResult = false
      let resultError: string | null = null
      let settled = false
      const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS)

      const onLine = (line: string) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.type === "stream_event") {
          const ev = msg.event
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            this.hub.broadcast({ type: "chat.delta", text: ev.delta.text })
          }
          return
        }
        if (msg.type === "system" && msg.subtype === "init") {
          this.store.setKv(STARTED_KEY, "1")
          return
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          const text = msg.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
            .trim()
          if (text) {
            const m = this.store.addChat("assistant", text)
            this.hub.broadcast({ type: "chat.message", message: m })
          }
          for (const b of msg.message.content) {
            if (b.type !== "tool_use") continue
            const name = String(b.name).replace(/^mcp__boxyard__/, "")
            const m = this.store.addChat("tool", name, { input: b.input })
            this.hub.broadcast({ type: "chat.message", message: m })
          }
          return
        }
        if (msg.type === "result") {
          sawResult = true
          this.store.setKv(STARTED_KEY, "1")
          if (msg.is_error) resultError = String(msg.result ?? msg.subtype ?? "error")
        }
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) onLine(line)
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-6000)
      })
      const finish = (code: number | null, err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (buf.trim()) onLine(buf)
        this.child = null
        if (err) return resolve({ ok: false, error: `Couldn't run claude (${this.c.claudeBin}): ${err.message}` })
        if (code === 0 && !resultError) return resolve({ ok: true, error: "" })
        resolve({ ok: false, error: resultError ?? (stderr.trim() || `claude exited with code ${code}${sawResult ? "" : " before answering"}`) })
      }
      child.on("error", (err) => finish(null, err))
      child.on("close", (code) => finish(code))
      child.stdin!.on("error", () => {})
      child.stdin!.end(prompt)
    })
  }
}
