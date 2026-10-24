import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import { ORCHESTRATOR_PROMPT } from "./prompts.js"
import { updatesBlock } from "./noticeBatch.js"
import { withOwner } from "../shared/owner.js"
import type { Attachment, CaptainToolResult, ChatMessage, CompactionTaskSnapshot, ContextUsage, OrchestratorState, ScheduleRun } from "../shared/types.js"
import { uploadsDir } from "./uploads.js"
import { BadRequestError } from "./store.js"
import { compactThreshold, type SettingsStore } from "./settings.js"
import { contextTokens, contextWindowOf, formatTokens, parseContextReport, resultUsageObject } from "./usage.js"
import {
  SUMMARY_PROMPT,
  cleanSummary,
  compactionsDir,
  compactionsPrompt,
  finishCompaction,
  lastCompaction,
  summaryLooksValid,
  writeCompaction,
} from "./compactions.js"
import { routingInstructions } from "./routing.js"
import { compactionTaskSnapshots, mentionedTaskIds } from "./compactionTasks.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"

const TURN_TIMEOUT_MS = 15 * 60_000
/** Wait this long after a task update before waking the orchestrator, to batch updates. */
const WAKE_DEBOUNCE_MS = 4000
/** Automatic turns in a row (no message from Cody in between) before it stops waking itself. */
const MAX_AUTO_TURNS = 8
/** What the orchestrator says on an automatic turn when there's nothing to tell Cody; not shown. */
const NO_UPDATE = "(no update)"
const SESSION_KEY = "orchestrator_session"
const STARTED_KEY = "orchestrator_session_started"
const USAGE_KEY = "orchestrator_usage"
/** Never wait for more than this share of the window: the CLI's own last-resort compaction (no log) kicks in near 96%. */
const MAX_THRESHOLD_SHARE = 0.95

/** Tools that create something, and the id prefix of what they create. */
const CREATES: Record<string, string> = { create_task: "task", create_project: "prj", create_schedule: "sch" }

/** The id a create_* tool result names (the first id with the tool's prefix), or null. */
export function createdId(tool: string, content: unknown): string | null {
  const prefix = CREATES[tool]
  if (!prefix) return null
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : ""
  return new RegExp(`\\b${prefix}_[A-Za-z0-9-]{6,40}\\b`).exec(text)?.[0] ?? null
}

/** Coordinator tools that talk to a project Captain; their tool lines keep the result as meta.captain. */
export const CAPTAIN_TOOLS = new Set(["send_to_captain", "ask_captain", "wait_for_captain"])

/** The Captain's project and reply from a send/ask/wait_for_captain result, or null if it isn't one. */
export function captainToolResult(tool: string, content: unknown): CaptainToolResult | null {
  if (!CAPTAIN_TOOLS.has(tool)) return null
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : ""
  let r: any
  try {
    r = JSON.parse(text)
  } catch {
    return null
  }
  if (!r || typeof r !== "object") return null
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null)
  // ask_captain names only what was said after the question; wait_for_captain the latest reply.
  const reply = tool === "send_to_captain" ? null : tool === "ask_captain" && "reply" in r ? str(r.reply) : str(r.lastReply)
  return {
    projectId: str(r.projectId) ?? str(r.state?.projectId),
    reply: reply ? reply.slice(0, 20_000) : null,
    finished: typeof r.allFinished === "boolean" ? r.allFinished : null,
  }
}

/** What one run of the claude CLI produced. */
interface RunResult {
  ok: boolean
  error: string
  /** Assistant text (used for the compaction summary). */
  text: string
  /** Raw stdout, for non-stream commands like /context. */
  raw: string
  sessionId: string | null
}
type RunKind = "turn" | "summary" | "compact" | "context"

/** Tell the orchestrator where Cody's attached files are, and how to pass them on. */
export function attachmentNote(files: unknown, ownerName?: string): string {
  if (!Array.isArray(files) || !files.length) return ""
  const lines = (files as Attachment[]).map((f) => `- ${f.name} (${f.mime}, ${f.size} bytes) id=${f.id} path=${f.path}`)
  return `\n\n[${withOwner("Cody", ownerName)} attached ${files.length === 1 ? "a file" : "files"}. Open them with the Read tool (images included). To give them to an agent, pass the ids in the \`attachments\` param of create_task or send_to_task.]\n${lines.join("\n")}`
}

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
  /** Model-only notes for queued scheduled runs, by run id. The queue itself lives in the schedule_runs table. */
  private readonly runNotes = new Map<string, string>()
  private child: ChildProcess | null = null
  private compactWanted: "button" | "auto" | null = null
  private compacting = false
  private lastError: string | null = null
  private readonly workdir: string
  readonly compactionsDir: string
  private readonly mcpConfigPath: string

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    mcp: { url: string; token: string },
    private readonly settings: SettingsStore,
  ) {
    this.workdir = path.join(c.dataDir, "orchestrator")
    this.compactionsDir = compactionsDir(c.dataDir)
    fs.mkdirSync(this.compactionsDir, { recursive: true })
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
  send(content: string, id?: string, attachments: Attachment[] = []): ChatMessage {
    const msg = this.store.addChat("user", content.trim(), attachments.length ? { attachments } : null, id)
    this.hub.broadcast({ type: "chat.message", message: msg })
    this.pending = true
    this.autoTurns = 0
    void this.drain()
    return msg
  }

  /**
   * A hook's message (server/hooks.ts message_coordinator): a chat line labelled with the hook, answered
   * on the next turn. Unlike Cody's messages it doesn't reset the automatic-turn count: it's an automation.
   */
  hookMessage(content: string, meta: Record<string, unknown>): ChatMessage {
    const msg = this.store.addChat("user", content.trim(), meta)
    this.hub.broadcast({ type: "chat.message", message: msg })
    this.pending = true
    void this.drain()
    return msg
  }

  /**
   * Queue a scheduled prompt (a `queued` schedule_runs row). It is injected into
   * the chat once no turn is running, so two orchestrator turns never overlap.
   */
  enqueueScheduled(runId: string, notes?: string) {
    if (notes) this.runNotes.set(runId, notes)
    void this.drain()
  }

  /** On startup: runs that were mid-turn when the server stopped are failed; queued ones are delivered. */
  resumeScheduled() {
    for (const r of this.store.listScheduleRuns({ status: ["running"] })) this.finishScheduledRun(r.id, "Box Yard restarted before this run finished.")
    if (this.store.listScheduleRuns({ status: ["queued"], limit: 1 }).length) void this.drain()
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
      // Updates from an agent that's still mid-turn (say, it published a file)
      // wait for its end-of-turn notice, which nudges again; then they go together.
      const busy = new Set(["queued", "starting", "working"])
      const ready = this.store.unseenNoticeTasks().some((id) => !id || !busy.has(this.store.getTask(id)?.status ?? "idle"))
      if (!ready) return
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

  // ------------------------------------------------------------------ context usage and compaction

  usage(): ContextUsage {
    try {
      const u = JSON.parse(this.store.getKv(USAGE_KEY) ?? "null")
      if (u) return { tokens: u.tokens ?? null, window: u.window ?? null, updatedAt: u.updatedAt ?? null }
    } catch {}
    return { tokens: null, window: null, updatedAt: null }
  }

  private setUsage(tokens: number | null, window?: number | null) {
    const prev = this.usage()
    this.store.setKv(USAGE_KEY, JSON.stringify({ tokens, window: window ?? prev.window, updatedAt: Date.now() }))
    this.publishState()
  }

  state(): OrchestratorState {
    return {
      busy: this.running,
      usage: this.usage(),
      compacting: this.compacting,
      compactQueued: this.compactWanted !== null && !this.compacting,
      lastCompaction: lastCompaction(this.compactionsDir),
      compactionsDir: this.compactionsDir,
      error: this.lastError,
    }
  }

  private publishState() {
    try {
      this.hub.broadcast({ type: "orchestrator.state", state: this.state() })
    } catch {
      // The database is closed (shutdown while a turn was finishing).
    }
  }

  /** Compact the orchestrator's session: right now if it is idle, otherwise right after the current turn. */
  requestCompact(trigger: "button" | "auto" = "button") {
    if (!this.session().started) throw new BadRequestError("The orchestrator hasn't started a conversation yet, so there is nothing to compact.")
    if (this.compacting || this.compactWanted) return this.state()
    this.compactWanted = trigger
    this.lastError = null
    this.publishState()
    void this.drain()
    return this.state()
  }

  /** After a turn: queue a compaction when usage passed the configured threshold. */
  private checkAutoCompact() {
    try {
      this.checkAutoCompactNow()
    } catch {
      // Shutting down; nothing to compact.
    }
  }

  private checkAutoCompactNow() {
    if (this.compactWanted || this.compacting) return
    const { orchestratorAutoCompact: ac } = this.settings.get()
    const u = this.usage()
    const threshold = compactThreshold(ac, u.window)
    if (threshold === null || u.tokens === null) return
    const cap = u.window ? Math.floor(u.window * MAX_THRESHOLD_SHARE) : Infinity
    if (u.tokens >= Math.min(threshold, cap)) {
      this.compactWanted = "auto"
      this.publishState()
    }
  }

  /** Tasks active or mentioned since the previous recorded compaction. */
  private compactionTaskSnapshots(): CompactionTaskSnapshot[] {
    const previous = this.store.listOrchestratorCompactions({ limit: 1 })[0]?.at ?? lastCompaction(this.compactionsDir)?.at ?? 0
    const mentioned = mentionedTaskIds(this.store.listChatSince(previous).flatMap((m) => [m.content, m.meta]))
    return compactionTaskSnapshots(this.store, this.store.listTasks(), previous, mentioned)
  }

  /**
   * Write the durable summary first, then /compact. If the summary can't be
   * produced the session is left alone (and the error shown), so every
   * compaction has a log file.
   */
  private async doCompact() {
    const trigger = this.compactWanted ?? "button"
    this.compactWanted = null
    this.compacting = true
    this.lastError = null
    this.publishState()
    try {
      const s = this.session()
      const before = this.usage().tokens
      const model = this.settings.get().orchestratorModel
      const summary = await this.run(withOwner(SUMMARY_PROMPT, this.owner()), s.id, true, "summary")
      const text = cleanSummary(summary.text)
      if (!summary.ok || !summaryLooksValid(text)) {
        throw new Error(`couldn't write the summary first (${summary.error || "empty or malformed reply"}), so the context was not compacted`)
      }
      const meta = { at: Date.now(), sessionId: s.id, model, trigger, tokensBefore: before }
      const taskSnapshots = this.compactionTaskSnapshots()
      const files = writeCompaction(this.compactionsDir, meta, text, taskSnapshots)
      this.store.addOrchestratorCompaction({
        id: files.id,
        at: meta.at,
        sessionId: meta.sessionId,
        model: meta.model,
        trigger: meta.trigger,
        tokensBefore: meta.tokensBefore,
        markdownPath: files.markdownFile,
        jsonPath: files.jsonFile,
        markdown: files.markdown,
        tasks: taskSnapshots,
      })
      const compact = await this.run("/compact", s.id, true, "compact")
      if (!compact.ok) throw new Error(`/compact failed: ${compact.error}`)
      // /compact keeps the session id; if a CLI version ever changed it, follow it.
      let id = s.id
      if (compact.sessionId && compact.sessionId !== s.id) {
        id = compact.sessionId
        this.store.setKv(SESSION_KEY, id)
      }
      const report = await this.run("/context", id, true, "context")
      const after = report.ok ? parseContextReport(report.raw) : null
      this.setUsage(after?.tokens ?? null, after?.window)
      finishCompaction(files.markdownFile, after?.tokens ?? null)
      this.store.finishOrchestratorCompaction(files.id, after?.tokens ?? null, fs.readFileSync(files.markdownFile, "utf8"))
      const note = this.store.addChat(
        "notice",
        `Context compacted${before ? ` from ${formatTokens(before)}` : ""}${after ? ` to ${formatTokens(after.tokens)} tokens` : ""} (${trigger === "auto" ? "automatic" : "button"}). Summary saved to ${files.markdownFile}.`,
        { kind: "compaction" },
      )
      // Informational only: the orchestrator doesn't need to see this one.
      this.store.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE id = ?").run(note.id)
      this.hub.broadcast({ type: "chat.message", message: note })
    } catch (err) {
      this.lastError = `Compaction skipped: ${(err as Error).message}`
      const m = this.store.addChat("error", this.lastError)
      this.hub.broadcast({ type: "chat.message", message: m })
    } finally {
      this.compacting = false
      this.publishState()
    }
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
      while (this.pending || this.wakeWanted || this.compactWanted || this.nextScheduledRun()) {
        if (this.compactWanted) {
          await this.doCompact()
        } else if (this.pending) {
          this.pending = false
          this.wakeWanted = false
          await this.turn()
        } else if (this.nextScheduledRun()) {
          await this.scheduledTurn(this.nextScheduledRun()!)
        } else {
          this.wakeWanted = false
          await this.autoTurn()
        }
      }
    } finally {
      this.running = false
      this.hub.broadcast({ type: "chat.busy", busy: false })
      this.publishState()
    }
  }

  /** The oldest queued scheduled run, if any. */
  private nextScheduledRun() {
    const queued = this.store.listScheduleRuns({ status: ["queued"] })
    return queued.length ? queued[queued.length - 1]! : null
  }

  private finishScheduledRun(id: string, error?: string) {
    const run = this.store.updateScheduleRun(id, { status: error ? "failed" : "done", error: error ?? null, finishedAt: Date.now() })
    this.runNotes.delete(id)
    this.hub.broadcast({ type: "schedule.run", run })
  }

  /** Inject a scheduled prompt into the chat as a labeled message and handle it like a message from Cody. */
  private async scheduledTurn(queued: ScheduleRun) {
    const msg = this.store.addChat("user", queued.prompt, { scheduleId: queued.scheduleId, scheduleRunId: queued.id })
    this.hub.broadcast({ type: "chat.message", message: msg })
    const run = this.store.updateScheduleRun(queued.id, { status: "running", startedAt: Date.now(), chatMessageId: msg.id })
    this.hub.broadcast({ type: "schedule.run", run })
    // This message is answered by this turn, not by Cody's next one.
    this.store.setKv("orchestrator_last_turn_at", String(Date.now() + 1))
    const notices = this.store.takeUnseenNotices()
    const notes = this.runNotes.get(queued.id)
    const prompt = [
      updatesBlock("Box Yard updates since your last turn", notices),
      queued.prompt,
      `(${withOwner("This is a scheduled message from Box Yard, not a new message from Cody.", this.owner())} ${notes ?? ""} ${withOwner("Handle it as if Cody had sent it: do the work, and reply with what Cody should see.", this.owner())})`,
    ]
      .filter(Boolean)
      .join("\n\n")
    const result = await this.runPrompt(prompt)
    this.finishScheduledRun(queued.id, result.ok ? undefined : result.error.slice(0, 500))
  }

  private owner(): string {
    return this.settings.get().ownerName
  }

  /** Messages Cody sent since the orchestrator last replied. */
  private unansweredUserMessages(): string[] {
    const since = Number(this.store.getKv("orchestrator_last_turn_at") ?? 0)
    return this.store
      .listChat(200)
      .filter((m) => m.role === "user" && m.createdAt >= since)
      .map((m) =>
        m.meta?.source === "hook" && typeof m.meta.hookName === "string"
          ? `[From the Box Yard hook "${m.meta.hookName}": ${withOwner("an automation, not a new message from Cody", this.owner())}]\n${m.content}`
          : m.content + attachmentNote(m.meta?.attachments, this.owner()),
      )
      .filter((text) => text.trim())
  }

  /** A turn with only task updates in it: report them and keep Cody's work moving. */
  private async autoTurn() {
    if (this.autoTurns >= MAX_AUTO_TURNS) return
    const notices = this.store.takeUnseenNotices()
    if (!notices.length) return
    this.autoTurns++
    await this.runPrompt(
      [
        updatesBlock("Box Yard updates since your last turn", notices),
        withOwner(
          `(Automatic wake-up: there is no new message from Cody. Tell Cody in a line or two what finished, failed or needs Cody, with links. ` +
          `If an update completes a step of work Cody already asked for and the next step is clear, start it. ` +
          `Don't start unrelated work, and don't repeat things you already told Cody. If there's nothing new for Cody, reply with exactly ${NO_UPDATE} and nothing else.)`,
          this.owner(),
        ),
      ].join("\n\n"),
    )
  }

  private async turn() {
    const messages = this.unansweredUserMessages()
    if (!messages.length) return
    this.store.setKv("orchestrator_last_turn_at", String(Date.now() + 1))
    const notices = this.store.takeUnseenNotices()
    const prompt = [
      updatesBlock("Box Yard updates since your last turn", notices),
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

  private async runPrompt(body: string): Promise<{ ok: boolean; error: string }> {
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
    this.checkAutoCompact()
    return result
  }

  /** Arguments for the claude CLI, by kind of run. Settings are read here, so changes apply from the next run. */
  private claudeArgs(kind: RunKind, sessionId: string, resume: boolean): string[] {
    const st = this.settings.get()
    const session = resume ? ["--resume", sessionId] : ["--session-id", sessionId]
    const model = ["--model", st.orchestratorModel]
    if (kind === "compact") return ["-p", "--output-format", "stream-json", "--verbose", ...session, ...model]
    // /context prints plain text.
    if (kind === "context") return ["-p", ...session, ...model]
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(kind === "turn" ? ["--include-partial-messages"] : []),
      "--strict-mcp-config",
      "--mcp-config",
      this.mcpConfigPath,
      // The summary turn must only write text; Read is for the compaction log (and only that folder).
      ...(kind === "summary"
        ? ["--tools", ""]
        : ["--tools", "Read,WebSearch,WebFetch", "--allowedTools", ["mcp__boxyard", "WebSearch", "WebFetch", ...this.readRules()].join(",")]),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      `${withOwner(ORCHESTRATOR_PROMPT, st.ownerName)}\n\n${routingInstructions(this.c.dataDir, st)}\n\n${withOwner(compactionsPrompt(this.compactionsDir), st.ownerName)}`,
      ...session,
      ...model,
      "--effort",
      st.orchestratorEffort,
    ]
  }

  /** Read access is limited to these folders (absolute paths use a `//` prefix in permission rules). */
  private readRules(): string[] {
    // The uploads folder holds files Cody attached in the chat.
    return [`Read(/${this.compactionsDir}/**)`, `Read(/${uploadsDir(this.c.dataDir)}/**)`]
  }

  private run(prompt: string, sessionId: string, resume: boolean, kind: RunKind = "turn"): Promise<RunResult> {
    return new Promise((resolve) => {
      this.writeMcpConfig()
      const args = this.claudeArgs(kind, sessionId, resume)
      const [bin, ...pre] = this.c.claudeBin.split(" ")
      const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
      // When Box Yard itself was started from inside a Claude Code session, don't
      // let the orchestrator think it is that session's child.
      for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
      // Env vars or Settings › Credentials, read on every run so a saved token works without a restart.
      Object.assign(env, this.settings.credentials.claudeEnv())

      let child: ChildProcess
      try {
        child = spawn(bin!, [...pre, ...args], { cwd: this.workdir, env, stdio: ["pipe", "pipe", "pipe"] })
      } catch (err) {
        resolve({ ok: false, error: `Couldn't start claude: ${(err as Error).message}`, text: "", raw: "", sessionId: null })
        return
      }
      this.child = child
      let stderr = ""
      let buf = ""
      let sawResult = false
      let resultError: string | null = null
      let settled = false
      let raw = ""
      let said = ""
      let resultUsage: Record<string, number> | null = null
      let resultCostUsd: number | null = null
      let resultDurationMs: number | null = null
      let resultModel: string | null = null
      // The turn's final reply: the last text, unless a tool call came after it.
      let reply: ChatMessage | null = null
      const startedAt = Date.now()
      let seenSession: string | null = null
      const created = new Map<string, ChatMessage>()
      const quiet = kind !== "turn"
      const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS)

      const onLine = (line: string) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (typeof msg.session_id === "string") seenSession = msg.session_id
        if (msg.type === "stream_event") {
          if (quiet) return
          const ev = msg.event
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            this.hub.broadcast({ type: "chat.delta", text: ev.delta.text })
          }
          return
        }
        if (msg.type === "system" && msg.subtype === "init") {
          if (kind === "turn") this.store.setKv(STARTED_KEY, "1")
          return
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          const tokens = msg.message.model === "<synthetic>" || kind !== "turn" ? null : contextTokens(msg.message.usage)
          if (tokens) this.setUsage(tokens)
          const text = msg.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
            .trim()
          if (text) said = said ? `${said}\n\n${text}` : text
          if (quiet) return
          if (text && text !== NO_UPDATE) {
            const parsed = parseNextSteps(text)
            const meta = parsed.nextSteps.length ? { [NEXT_STEPS_META_KEY]: parsed.nextSteps } : null
            const m = this.store.addChat("assistant", parsed.content, meta)
            this.hub.broadcast({ type: "chat.message", message: m })
            reply = m
          } else if (text === NO_UPDATE) reply = null
          for (const b of msg.message.content) {
            if (b.type !== "tool_use") continue
            reply = null
            const name = String(b.name).replace(/^mcp__boxyard__/, "")
            const m = this.store.addChat("tool", name, { input: b.input })
            if ((CREATES[name] || CAPTAIN_TOOLS.has(name)) && typeof b.id === "string") created.set(b.id, m)
            this.hub.broadcast({ type: "chat.message", message: m })
          }
          return
        }
        if (msg.type === "user" && Array.isArray(msg.message?.content)) {
          // A create_* result names the new task/project/schedule; the chat's tool line links to it.
          // A Captain tool's result keeps the project and the Captain's reply, shown when the line is expanded.
          for (const b of msg.message.content) {
            const m = b?.type === "tool_result" && !b.is_error ? created.get(b.tool_use_id) : undefined
            if (!m) continue
            created.delete(b.tool_use_id)
            const resultId = createdId(m.content, b.content)
            const captain = captainToolResult(m.content, b.content)
            const updated = resultId
              ? this.store.setChatMeta(m.id, { ...m.meta, resultId })
              : captain
                ? this.store.setChatMeta(m.id, { ...m.meta, captain })
                : null
            if (updated) this.hub.broadcast({ type: "chat.message", message: updated })
          }
          return
        }
        if (msg.type === "result") {
          sawResult = true
          if (kind === "turn") {
            this.store.setKv(STARTED_KEY, "1")
            const window = contextWindowOf(msg.modelUsage)
            if (window) this.setUsage(this.usage().tokens, window)
          }
          resultUsage = resultUsageObject(msg.usage)
          resultCostUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null
          resultDurationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : null
          resultModel = typeof msg.model === "string" ? msg.model : null
          if (msg.is_error) resultError = String(msg.result ?? msg.subtype ?? "error")
        }
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        if (kind === "context") raw += chunk.toString("utf8")
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
        if (resultUsage || typeof resultCostUsd === "number" || typeof resultDurationMs === "number") {
          this.store.recordClaudeUsage({
            source: "orchestrator",
            runKind: kind,
            sessionId,
            model: resultModel ?? this.settings.get().orchestratorModel,
            startedAt,
            endedAt: Date.now(),
            durationMs: resultDurationMs,
            usage: resultUsage,
            costUsd: resultCostUsd,
            resumed: resume,
          })
        }
        // Lets the client speak a one-line summary of the reply (lib/speech.ts).
        if (!quiet) this.hub.broadcast({ type: "chat.turn", startedAt, replyId: reply?.id ?? null })
        const base = { text: said, raw, sessionId: seenSession }
        if (err) return resolve({ ...base, ok: false, error: `Couldn't run claude (${this.c.claudeBin}): ${err.message}` })
        if (code === 0 && !resultError) return resolve({ ...base, ok: true, error: "" })
        resolve({ ...base, ok: false, error: resultError ?? (stderr.trim() || `claude exited with code ${code}${sawResult ? "" : " before answering"}`) })
      }
      child.on("error", (err) => finish(null, err))
      child.on("close", (code) => finish(code))
      child.stdin!.on("error", () => {})
      child.stdin!.end(prompt)
    })
  }
}
