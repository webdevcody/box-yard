import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import { BadRequestError } from "./store.js"
import { compactThreshold, type SettingsStore } from "./settings.js"
import { contextTokens, contextWindowOf, formatTokens, parseContextReport, resultUsageObject } from "./usage.js"
import { routingInstructions } from "./routing.js"
import { uploadsDir } from "./uploads.js"
import { captainPrompt } from "./prompts.js"
import { DEFAULT_LOOP_GUARD, WakeLoopGuard, type LoopGuardOptions } from "./loopGuard.js"
import { attachmentNote } from "./orchestrator.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { captainSourceOf } from "../shared/captain.js"
import {
  SUMMARY_PROMPT,
  captainCompactionsDir,
  cleanSummary,
  compactionsPrompt,
  finishCompaction,
  lastCompaction,
  listCompactions,
  readCompactionFile,
  readCompactionInfo,
  summaryLooksValid,
  writeCompaction,
} from "./compactions.js"
import type { Attachment, CaptainCompaction, CaptainMessage, CaptainSource, CaptainState, ContextUsage, Project, Task } from "../shared/types.js"

const TURN_TIMEOUT_MS = 15 * 60_000
const NO_UPDATE = "(no update)"
const MAX_THRESHOLD_SHARE = 0.95

type RunKind = "turn" | "summary" | "compact" | "context"
interface RunResult {
  ok: boolean
  error: string
  text: string
  raw: string
  sessionId: string | null
}

const sessionKey = (projectId: string) => `captain_session:${projectId}`
const startedKey = (projectId: string) => `captain_session_started:${projectId}`
const usageKey = (projectId: string) => `captain_usage:${projectId}`

function captainSummaryPrompt(project: Project, ownerName?: string) {
  return withOwner(SUMMARY_PROMPT, ownerName).replace("Your context", `Your Captain context for project "${project.name}"`).replace("# Orchestrator", "# Captain")
}

export interface CaptainSendOptions {
  /** Client-chosen message id (the Captain tab sends one for optimistic updates). */
  id?: string
  attachments?: Attachment[]
  /** Who sent it. Stored as meta.source so the transcript can label it; defaults to the Coordinator. */
  source?: CaptainSource
  /** The Coordinator tool that sent it (send_to_captain or ask_captain). */
  tool?: string
}

const SOURCE_LABEL: Record<CaptainSource, string> = { cody: "From Cody", coordinator: "From the Coordinator", schedule: "From a schedule" }

/** Up to this much of a Captain's reply is kept on the Coordinator's tool line. */
const TOOL_REPLY_MAX = 20_000

function briefTask(t: Task, ownerName?: string) {
  const merge = t.mergeRequest ? ` (merge requested by ${ownerName?.trim() || DEFAULT_OWNER_NAME} with the Merge button: pending, don't start another merge of this PR)` : ""
  return `- ${t.id} "${t.title}" ${t.status}${t.pendingCount ? ` (+${t.pendingCount} queued messages)` : ""}${t.prUrl ? ` PR ${t.prUrl}` : ""}${merge}`
}

export interface CaptainTuning {
  wakeDebounceMs: number
  loopGuard: LoopGuardOptions
}

export class CaptainManager {
  private readonly captains = new Map<string, Captain>()
  /** Each Captain's own MCP bearer token, so the MCP server can scope it to its project. */
  private readonly tokens = new Map<string, string>()
  onReport: ((projectId: string, content: string) => void) | null = null
  /** Read when a Captain is created; tests shorten these. */
  readonly tuning: CaptainTuning = { wakeDebounceMs: 3000, loopGuard: { ...DEFAULT_LOOP_GUARD } }

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly mcp: { url: string; token: string },
    private readonly settings: SettingsStore,
  ) {}

  get(projectId: string) {
    const project = this.store.getProject(projectId)
    if (!project) throw new BadRequestError(`No project ${projectId}`)
    let captain = this.captains.get(project.id)
    if (!captain) {
      const mcp = { url: this.mcp.url, token: this.tokenFor(project.id) }
      captain = new Captain(this.c, this.store, this.hub, mcp, this.settings, project, (text) => this.onReport?.(project.id, text), this.tuning)
      this.captains.set(project.id, captain)
    }
    return captain
  }

  /** The MCP token a project's Captain connects with. The Coordinator's token is never handed out. */
  tokenFor(projectId: string) {
    let token = this.tokens.get(projectId)
    if (!token) {
      token = `cpt_${randomBytes(24).toString("hex")}`
      this.tokens.set(projectId, token)
    }
    return token
  }

  /** Which project a Captain MCP token belongs to, or null for any other token. */
  projectForToken(token: string): string | null {
    for (const [projectId, t] of this.tokens) if (t === token) return projectId
    return null
  }

  find(ref: string) {
    const project = this.store.findProject(ref)
    if (!project) throw new BadRequestError(`No project "${ref}". Use list_projects.`)
    return this.get(project.id)
  }

  state(projectId: string) {
    return this.get(projectId).state()
  }

  send(projectRef: string, content: string, opts: CaptainSendOptions = {}) {
    return this.find(projectRef).send(content, opts)
  }

  async ask(projectRef: string, content: string, timeoutSeconds = 120) {
    const captain = this.find(projectRef)
    const sent = captain.send(content, { source: "coordinator", tool: "ask_captain" })
    const result = await this.wait(captain.projectId, timeoutSeconds)
    // Only what the Captain said after this question, not an older reply.
    const after = result.messages.filter((m) => m.createdAt >= sent.createdAt && m.id !== sent.id && (m.role === "assistant" || m.role === "error"))
    return { ...result, messageId: sent.id, reply: after.length ? after.map((m) => m.content).join("\n\n").slice(0, TOOL_REPLY_MAX) : null }
  }

  async wait(projectRef: string, timeoutSeconds = 120) {
    const captain = this.find(projectRef)
    const deadline = Date.now() + Math.max(5, Math.min(timeoutSeconds, 240)) * 1000
    await new Promise((r) => setTimeout(r, 300))
    while (Date.now() < deadline && captain.active) await new Promise((r) => setTimeout(r, 500))
    const messages = this.store.listCaptainMessages(captain.projectId, 30)
    const last = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "error")
    return { projectId: captain.projectId, allFinished: !captain.active, state: captain.state(), lastReply: last?.content ?? null, messages: messages.slice(-8) }
  }

  requestCompact(projectId: string) {
    return this.get(projectId).requestCompact("button")
  }

  messages(projectId: string, limit = 500) {
    return this.store.listCaptainMessages(projectId, limit)
  }

  compactions(projectId: string): CaptainCompaction[] {
    const dir = captainCompactionsDir(this.c.dataDir, projectId)
    return listCompactions(dir).flatMap((name) => {
      const file = path.join(dir, name)
      const info = readCompactionInfo(file)
      return info ? [{ ...info, content: readCompactionFile(file) }] : []
    })
  }

  /** Route a task notice to its project's Captain. Returns true when handled. */
  notice(content: string, meta: Record<string, unknown> | null = null): boolean {
    const taskId = typeof meta?.taskId === "string" ? meta.taskId : null
    const task = taskId ? this.store.getTask(taskId) : null
    if (!task) return false
    const msg = this.store.addCaptainMessage(task.projectId, "notice", content, meta)
    this.hub.broadcast({ type: "captain.message", message: msg })
    this.get(task.projectId).nudge()
    return true
  }

  stop() {
    for (const c of this.captains.values()) c.stop()
  }

  anyBusy() {
    return [...this.captains.values()].some((c) => c.active)
  }
}

class Captain {
  private running = false
  private pending = false
  private wakeWanted = false
  private wakeTimer: NodeJS.Timeout | null = null
  private throttleTimer: NodeJS.Timeout | null = null
  /** Unattended wake-ups since Cody or the Coordinator last wrote. */
  private autoTurns = 0
  private readonly loopGuard: WakeLoopGuard
  private child: ChildProcess | null = null
  private compactWanted: "button" | "auto" | null = null
  private compacting = false
  private lastError: string | null = null
  private readonly workdir: string
  private readonly mcpConfigPath: string
  private readonly mcpConfig: string
  readonly compactionsDir: string

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    mcp: { url: string; token: string },
    private readonly settings: SettingsStore,
    private readonly project: Project,
    private readonly report: (content: string) => void,
    private readonly tuning: CaptainTuning,
  ) {
    this.loopGuard = new WakeLoopGuard(tuning.loopGuard)
    this.workdir = path.join(c.dataDir, "captains", project.id)
    this.compactionsDir = captainCompactionsDir(c.dataDir, project.id)
    fs.mkdirSync(this.workdir, { recursive: true })
    fs.mkdirSync(this.compactionsDir, { recursive: true })
    this.mcpConfigPath = path.join(this.workdir, "mcp.json")
    this.mcpConfig = JSON.stringify({
      mcpServers: { boxyard: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
    })
  }

  get projectId() {
    return this.project.id
  }

  get active() {
    return this.running || this.pending || this.wakeWanted || this.compactWanted !== null
  }

  private writeMcpConfig() {
    fs.writeFileSync(this.mcpConfigPath, this.mcpConfig, { mode: 0o600 })
  }

  send(content: string, { id, attachments = [], source = "coordinator", tool }: CaptainSendOptions = {}): CaptainMessage {
    const meta = { source, ...(tool ? { tool } : {}), ...(attachments.length ? { attachments } : {}) }
    const msg = this.store.addCaptainMessage(this.project.id, "user", content.trim(), meta, id)
    this.hub.broadcast({ type: "captain.message", message: msg })
    this.pending = true
    this.autoTurns = 0
    this.loopGuard.reset()
    this.clearThrottleTimer()
    this.publishState()
    void this.drain()
    return msg
  }

  nudge() {
    if (this.wakeTimer) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      const busy = new Set(["queued", "starting", "working"])
      const ready = this.store.unseenCaptainNoticeTasks(this.project.id).some((id) => !id || !busy.has(this.store.getTask(id)?.status ?? "idle"))
      if (!ready) return
      this.wakeWanted = true
      void this.drain()
    }, this.tuning.wakeDebounceMs)
    this.wakeTimer.unref?.()
  }

  stop() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.clearThrottleTimer()
    this.child?.kill("SIGTERM")
  }

  private clearThrottleTimer() {
    if (this.throttleTimer) clearTimeout(this.throttleTimer)
    this.throttleTimer = null
  }

  usage(): ContextUsage {
    try {
      const u = JSON.parse(this.store.getKv(usageKey(this.project.id)) ?? "null")
      if (u) return { tokens: u.tokens ?? null, window: u.window ?? null, updatedAt: u.updatedAt ?? null }
    } catch {}
    return { tokens: null, window: null, updatedAt: null }
  }

  private setUsage(tokens: number | null, window?: number | null) {
    const prev = this.usage()
    this.store.setKv(usageKey(this.project.id), JSON.stringify({ tokens, window: window ?? prev.window, updatedAt: Date.now() }))
    this.publishState()
  }

  state(): CaptainState {
    return {
      projectId: this.project.id,
      busy: this.running,
      usage: this.usage(),
      compacting: this.compacting,
      compactQueued: this.compactWanted !== null && !this.compacting,
      lastCompaction: lastCompaction(this.compactionsDir),
      compactionsDir: this.compactionsDir,
      error: this.lastError,
      autoTurns: this.autoTurns,
      throttledUntil: this.loopGuard.throttledUntil,
    }
  }

  private publishState() {
    try {
      this.hub.broadcast({ type: "captain.state", state: this.state() })
    } catch {}
  }

  requestCompact(trigger: "button" | "auto" = "button") {
    if (!this.session().started) throw new BadRequestError("This Captain hasn't started a conversation yet, so there is nothing to compact.")
    if (this.compacting || this.compactWanted) return this.state()
    this.compactWanted = trigger
    this.lastError = null
    this.publishState()
    void this.drain()
    return this.state()
  }

  private session() {
    let id = this.store.getKv(sessionKey(this.project.id))
    if (!id) {
      id = randomUUID()
      this.store.setKv(sessionKey(this.project.id), id)
      this.store.setKv(startedKey(this.project.id), null)
    }
    return { id, started: this.store.getKv(startedKey(this.project.id)) === "1" }
  }

  private async drain() {
    if (this.running) return
    this.running = true
    this.publishState()
    try {
      while (this.pending || this.wakeWanted || this.compactWanted) {
        if (this.compactWanted) await this.doCompact()
        else if (this.pending) {
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
      this.publishState()
    }
  }

  private owner(): string {
    return this.settings.get().ownerName
  }

  private unansweredUserMessages(): string[] {
    const since = Number(this.store.getKv(`captain_last_turn_at:${this.project.id}`) ?? 0)
    return this.store
      .listCaptainMessages(this.project.id, 200)
      .filter((m) => m.role === "user" && m.createdAt >= since)
      .map((m) => `[${withOwner(SOURCE_LABEL[captainSourceOf(m)], this.owner())}]\n${m.content}${attachmentNote(m.meta?.attachments, this.owner())}`)
      .filter((text) => text.trim())
  }

  private async turn() {
    const messages = this.unansweredUserMessages()
    if (!messages.length) return
    this.store.setKv(`captain_last_turn_at:${this.project.id}`, String(Date.now() + 1))
    const notices = this.store.takeUnseenCaptainNotices(this.project.id)
    const prompt = [notices.length ? `[Project updates since your last turn]\n${notices.map((n) => `- ${n}`).join("\n")}` : "", messages.join("\n\n")]
      .filter(Boolean)
      .join("\n\n")
    await this.runPrompt(prompt)
  }

  private async autoTurn() {
    const queued = this.store.peekUnseenCaptainNotices(this.project.id)
    if (!queued.length) return
    const decision = this.loopGuard.check(queued)
    if (!decision.wake) {
      // Throttled, never dropped: the updates stay queued and go out with the next wake.
      this.holdUntil(decision.until)
      if (decision.started) {
        const minutes = Math.max(1, Math.round((decision.until - Date.now()) / 60_000))
        this.report(
          `Loop guard: the same task update${queued.length === 1 ? "" : "s"} kept waking me with nothing new, so my automatic wake-ups are paused for ${minutes} min. ` +
            `${queued.length} update${queued.length === 1 ? " is" : "s are"} queued, not dropped. I'll handle them then, or sooner when a new task event or a message arrives.`,
        )
      }
      this.publishState()
      return
    }
    this.clearThrottleTimer()
    const notices = this.store.takeUnseenCaptainNotices(this.project.id)
    if (!notices.length) return
    this.loopGuard.record(notices)
    this.autoTurns++
    const result = await this.runPrompt(
      [
        `[Project updates since your last turn]\n${notices.map((n) => `- ${n}`).join("\n")}`,
        withOwner(
          `(Automatic wake-up: there is no new message from Cody or the Coordinator. Decide whether a project-local next step is needed. If Cody or the Coordinator should hear about it, say so in a line or two. If nothing needs reporting, reply with exactly ${NO_UPDATE} and nothing else.)`,
          this.owner(),
        ),
      ].join("\n\n"),
      true,
    )
    if (!result.ok) this.report(`Captain for ${this.project.name} hit an error: ${result.error.slice(0, 500)}`)
  }

  /** Wake up again when the throttle ends, to deliver whatever queued up meanwhile. */
  private holdUntil(until: number) {
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      this.nudge()
    }, Math.max(0, until - Date.now()))
    this.throttleTimer.unref?.()
  }

  private projectNow(): string {
    const tasks = this.store
      .listTasks({ projectId: this.project.id })
      .filter((t) => t.status !== "done")
      .map((t) => briefTask(t, this.owner()))
    const notes = this.store.listNotes(this.project.id).slice(-12).map((n) => `- (${n.author}) ${n.content}`)
    return [
      `[Project now: ${this.project.name}]`,
      this.project.repo ? `Repo: ${this.project.repo} (${this.project.baseBranch})` : "No repo.",
      notes.length ? `Notes:\n${notes.join("\n")}` : "Notes: none.",
      tasks.length ? `Open tasks:\n${tasks.join("\n")}` : "No open tasks.",
    ].join("\n")
  }

  private async runPrompt(body: string, auto = false): Promise<{ ok: boolean; error: string }> {
    const prompt = `${this.projectNow()}\n\n${body}`
    const s = this.session()
    let result = await this.run(prompt, s.id, s.started)
    if (!result.ok && s.started && /no conversation found|session.*not found/i.test(result.error)) {
      const fresh = randomUUID()
      this.store.setKv(sessionKey(this.project.id), fresh)
      const recap = this.store
        .listCaptainMessages(this.project.id, 30)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `[${m.role}] ${m.content.slice(0, 800)}`)
        .join("\n")
      result = await this.run(`Earlier Captain conversation (your session was reset):\n${recap}\n\n---\n\n${prompt}`, fresh, false)
    }
    if (!result.ok) {
      const msg = this.store.addCaptainMessage(this.project.id, "error", `The Captain hit an error: ${result.error.slice(0, 1500)}`)
      this.hub.broadcast({ type: "captain.message", message: msg })
    }
    if (auto && result.ok && result.text.trim() && result.text.trim() !== NO_UPDATE) this.report(result.text.trim())
    this.checkAutoCompact()
    return result
  }

  private checkAutoCompact() {
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

  private async doCompact() {
    const trigger = this.compactWanted ?? "button"
    this.compactWanted = null
    this.compacting = true
    this.lastError = null
    this.publishState()
    try {
      const s = this.session()
      const before = this.usage().tokens
      const model = this.settings.get().captainModel
      const summary = await this.run(captainSummaryPrompt(this.project, this.owner()), s.id, true, "summary")
      const text = cleanSummary(summary.text)
      if (!summary.ok || !summaryLooksValid(text)) {
        throw new Error(`couldn't write the summary first (${summary.error || "empty or malformed reply"}), so the context was not compacted`)
      }
      const { markdownFile: file } = writeCompaction(this.compactionsDir, { at: Date.now(), sessionId: s.id, model, trigger, tokensBefore: before, heading: `Captain compaction summary: ${this.project.name}` }, text)
      const compact = await this.run("/compact", s.id, true, "compact")
      if (!compact.ok) throw new Error(`/compact failed: ${compact.error}`)
      let id = s.id
      if (compact.sessionId && compact.sessionId !== s.id) {
        id = compact.sessionId
        this.store.setKv(sessionKey(this.project.id), id)
      }
      const report = await this.run("/context", id, true, "context")
      const after = report.ok ? parseContextReport(report.raw) : null
      this.setUsage(after?.tokens ?? null, after?.window)
      finishCompaction(file, after?.tokens ?? null)
      const msg = this.store.addCaptainMessage(
        this.project.id,
        "notice",
        `Context compacted${before ? ` from ${formatTokens(before)}` : ""}${after ? ` to ${formatTokens(after.tokens)} tokens` : ""} (${trigger === "auto" ? "automatic" : "button"}). Summary saved to ${file}.`,
        { kind: "compaction" },
      )
      this.hub.broadcast({ type: "captain.message", message: msg })
      // Only this line: queued task updates still go to the Captain on its next wake.
      this.store.markCaptainMessageSeen(msg.id)
    } catch (err) {
      this.lastError = `Compaction skipped: ${(err as Error).message}`
      const m = this.store.addCaptainMessage(this.project.id, "error", this.lastError)
      this.hub.broadcast({ type: "captain.message", message: m })
    } finally {
      this.compacting = false
      this.publishState()
    }
  }

  private claudeArgs(kind: RunKind, sessionId: string, resume: boolean): string[] {
    const st = this.settings.get()
    const session = resume ? ["--resume", sessionId] : ["--session-id", sessionId]
    const model = ["--model", st.captainModel]
    if (kind === "compact") return ["-p", "--output-format", "stream-json", "--verbose", ...session, ...model]
    if (kind === "context") return ["-p", ...session, ...model]
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      this.mcpConfigPath,
      ...(kind === "summary"
        ? ["--tools", ""]
        : ["--tools", "Read,WebSearch,WebFetch", "--allowedTools", ["mcp__boxyard", "WebSearch", "WebFetch", ...this.readRules()].join(",")]),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      `${captainPrompt(this.project, st.ownerName)}\n\n${routingInstructions(this.c.dataDir, st)}\n\n${withOwner(compactionsPrompt(this.compactionsDir), st.ownerName)}`,
      ...session,
      ...model,
      "--effort",
      st.captainEffort,
    ]
  }

  private readRules(): string[] {
    return [`Read(/${this.compactionsDir}/**)`, `Read(/${uploadsDir(this.c.dataDir)}/**)`]
  }

  private run(prompt: string, sessionId: string, resume: boolean, kind: RunKind = "turn"): Promise<RunResult> {
    return new Promise((resolve) => {
      this.writeMcpConfig()
      const args = this.claudeArgs(kind, sessionId, resume)
      const [bin, ...pre] = this.c.claudeBin.split(" ")
      const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
      for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
      if (this.c.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.c.claudeOauthToken
      if (this.c.anthropicApiKey) env.ANTHROPIC_API_KEY = this.c.anthropicApiKey

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
      let raw = ""
      let said = ""
      let sawResult = false
      let resultError: string | null = null
      let settled = false
      let seenSession: string | null = null
      let resultUsage: ReturnType<typeof resultUsageObject> = null
      let resultCostUsd: number | null = null
      let resultDurationMs: number | null = null
      let resultModel: string | null = null
      const startedAt = Date.now()
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
        if (msg.type === "system" && msg.subtype === "init") {
          if (kind === "turn") this.store.setKv(startedKey(this.project.id), "1")
          return
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          const tokens = msg.message.model === "<synthetic>" || kind !== "turn" ? null : contextTokens(msg.message.usage)
          if (tokens) this.setUsage(tokens)
          // The hidden next-step block becomes chips under the reply; reports upward don't carry it.
          const parsed = parseNextSteps(
            msg.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("")
              .trim(),
          )
          const text = parsed.content.trim()
          if (text) said = said ? `${said}\n\n${text}` : text
          if (quiet) return
          if (text && text !== NO_UPDATE) {
            const meta = parsed.nextSteps.length ? { [NEXT_STEPS_META_KEY]: parsed.nextSteps } : null
            const m = this.store.addCaptainMessage(this.project.id, "assistant", text, meta)
            this.hub.broadcast({ type: "captain.message", message: m })
          }
          for (const b of msg.message.content) {
            if (b.type !== "tool_use") continue
            const name = String(b.name).replace(/^mcp__boxyard__/, "")
            const m = this.store.addCaptainMessage(this.project.id, "tool", name, { input: b.input })
            this.hub.broadcast({ type: "captain.message", message: m })
          }
          return
        }
        if (msg.type === "result") {
          sawResult = true
          resultUsage = resultUsageObject(msg.usage)
          resultCostUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null
          resultDurationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : null
          resultModel = typeof msg.model === "string" ? msg.model : null
          if (kind === "turn") {
            this.store.setKv(startedKey(this.project.id), "1")
            const window = contextWindowOf(msg.modelUsage)
            if (window) this.setUsage(this.usage().tokens, window)
          }
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
        // Captain runs get their own usage line and count toward the project's totals.
        if (resultUsage || typeof resultCostUsd === "number" || typeof resultDurationMs === "number") {
          this.store.recordClaudeUsage({
            source: "captain",
            runKind: kind,
            projectId: this.project.id,
            sessionId,
            model: resultModel ?? this.settings.get().captainModel,
            startedAt,
            endedAt: Date.now(),
            durationMs: resultDurationMs,
            usage: resultUsage,
            costUsd: resultCostUsd,
            resumed: resume,
          })
        }
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
