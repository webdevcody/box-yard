import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { CaptainNoticeEntry, Store } from "./store.js"
import { BadRequestError, queuedChatError, type QueuedChatChange } from "./store.js"
import { compactThreshold, noteBudgetOf, type SettingsStore } from "./settings.js"
import { contextTokens, contextWindowOf, formatTokens, parseContextReport, resultUsageObject } from "./usage.js"
import { routingInstructions } from "./routing.js"
import { updatesBlock } from "./noticeBatch.js"
import { uploadsDir } from "./uploads.js"
import { captainPrompt } from "./prompts.js"
import { DEFAULT_LOOP_GUARD, WakeLoopGuard, type LoopGuardOptions } from "./loopGuard.js"
import { attachmentNote } from "./orchestrator.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { agentCaptainLabel, captainSourceOf } from "../shared/captain.js"
import { budgetLine, budgetNotes, noteLine, pruneAdvice, shortTokens } from "../shared/notes.js"
import {
  SUMMARY_PROMPT,
  captainCompactionsDir,
  cleanSummary,
  compactionsPrompt,
  findCompactionRecord,
  finishCompaction,
  lastCompaction,
  listCompactions,
  readCompactionFile,
  readCompactionInfo,
  readCompactionRecords,
  summaryLooksValid,
  writeCompaction,
} from "./compactions.js"
import { compactionTaskSnapshots, mentionedTaskIds } from "./compactionTasks.js"
import type { Attachment, CaptainCompaction, CaptainMessage, CaptainSource, CaptainState, CompactionRecord, CompactionTaskSnapshot, ContextUsage, Project, Task } from "../shared/types.js"

const TURN_TIMEOUT_MS = 15 * 60_000
const NO_UPDATE = "(no update)"
/** ask_captain/wait_for_captain never hold the Coordinator's turn longer than this: the reply is pushed anyway. */
export const CAPTAIN_WAIT_MAX_SECONDS = 60
export const CAPTAIN_WAIT_DEFAULT_SECONDS = 30
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
/** A hash of the notes this Captain's session last saw, so an unchanged list isn't repeated every turn. */
const notesSeenKey = (projectId: string) => `captain_notes_seen:${projectId}`

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
  /** Extra meta to keep on the message (a hook's id and name). */
  meta?: Record<string, unknown>
}

const SOURCE_LABEL: Record<CaptainSource, string> = {
  cody: "From Cody",
  coordinator: "From the Coordinator",
  schedule: "From a schedule",
  hook: "From a hook",
  agent: "From an agent",
}

/** "[From Cody]", the hook's name for a hook's message, or the task for an agent's. Only Box Yard's own words get the owner name. */
function sourceLabel(m: CaptainMessage, ownerName: string) {
  const source = captainSourceOf(m)
  if (source === "hook" && typeof m.meta?.hookName === "string") return `From the hook "${m.meta.hookName}" ${withOwner("(an automation, not a new message from Cody)", ownerName)}`
  if (source === "agent") return `${agentCaptainLabel(m.meta)}${withOwner(agentLabelTail(m), ownerName)}`
  return withOwner(SOURCE_LABEL[source], ownerName)
}

/** What the Captain should do about an agent's message_captain: answer fast when it is waiting. */
function agentLabelTail(m: CaptainMessage) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : "?"
  const wait = typeof m.meta?.waitSeconds === "number" ? m.meta.waitSeconds : 0
  const held = typeof m.meta?.heldUntil === "number" ? " Your loop guard held it back for a while, so the agent stopped waiting." : ""
  const how =
    wait > 0 && !held
      ? ` It is waiting up to ${wait} s for your answer mid-turn: reply first, with reply_to_agent (task ${taskId}), before anything slow.`
      : ` It kept working. If it needs an answer, use reply_to_agent (task ${taskId}); it gets the reply as its next message.`
  return `, an agent in this project, via message_captain. Not a message from Cody.${held}${how}`
}

/** An agent's message_captain, as the server hands it to its project's Captain. */
export interface AgentCaptainMessage {
  taskId: string
  taskTitle: string
  message: string
  /** The runner's id for this message; the reply file and the wait use it. */
  agentMessageId: string
  /** How long the agent waits for the reply mid-turn; 0 for fire-and-forget. */
  waitSeconds: number
}

/** Up to this much of a Captain's reply is kept on the Coordinator's tool line. */
const TOOL_REPLY_MAX = 20_000

/** What a Captain tells the Coordinator, and why: an automatic report, or the reply to a Coordinator message. */
export interface CaptainReport {
  /** The Coordinator messages (send_to_captain) this reply answers; absent for automatic reports. */
  replyTo?: string[]
}

/** An ask_captain/wait_for_captain call waiting for a reply. */
interface ReplyWaiter {
  /** The Coordinator messages it waits on; null (wait_for_captain) takes the next reply to any of them. */
  ids: string[] | null
  done: () => void
}

function briefTask(t: Task, ownerName?: string) {
  const by = t.mergeRequest?.requestedBy ?? `${ownerName?.trim() || DEFAULT_OWNER_NAME} with the Merge button`
  const merge = t.mergeRequest ? ` (merge requested by ${by}: pending, don't start another merge of this PR)` : ""
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
  onReport: ((projectId: string, content: string, report: CaptainReport) => void) | null = null
  /**
   * A Captain turn that read these agent messages (message_captain) ended; `reply` is what the turn said.
   * An agent still waiting on one without a reply_to_agent/send_to_task hears that, so it stops waiting.
   */
  onAgentMessagesHandled: ((projectId: string, messages: CaptainMessage[], reply: string) => void) | null = null
  /** A Captain turn that read these notices ended; the notes retro settles the suggestions its retros held. */
  onNoticesHandled: ((projectId: string, notices: CaptainNoticeEntry[], ok: boolean) => void) | null = null
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
      captain = new Captain(
        this.c,
        this.store,
        this.hub,
        mcp,
        this.settings,
        project,
        (text, report = {}) => this.onReport?.(project.id, text, report),
        this.tuning,
        (notices, ok) => this.onNoticesHandled?.(project.id, notices, ok),
        (messages, reply) => this.onAgentMessagesHandled?.(project.id, messages, reply),
      )
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

  /** An agent's message_captain, to the Captain of the agent's own project (the server picks it, never the agent). */
  fromAgent(projectId: string, input: AgentCaptainMessage) {
    return this.get(projectId).fromAgent(input)
  }

  /**
   * Send a question and wait (bounded) for the turn that answers it. If the wait runs out, the Captain keeps
   * working and its reply reaches the Coordinator as a pushed update instead.
   */
  async ask(projectRef: string, content: string, timeoutSeconds = CAPTAIN_WAIT_DEFAULT_SECONDS) {
    const captain = this.find(projectRef)
    const sent = captain.send(content, { source: "coordinator", tool: "ask_captain" })
    const answered = await captain.waitForReply([sent.id], waitMs(timeoutSeconds))
    const messages = this.store.listCaptainMessages(captain.projectId, 60)
    // Only what the Captain said after this question, not an older reply.
    const after = messages.filter((m) => m.createdAt >= sent.createdAt && m.id !== sent.id && (m.role === "assistant" || m.role === "error"))
    return {
      ...this.waitResult(captain, messages, answered),
      messageId: sent.id,
      reply: after.length ? after.map((m) => m.content).join("\n\n").slice(0, TOOL_REPLY_MAX) : null,
    }
  }

  /** Wait (bounded) until the Captain's next reply to the Coordinator lands, or it goes idle. */
  async wait(projectRef: string, timeoutSeconds = CAPTAIN_WAIT_DEFAULT_SECONDS) {
    const captain = this.find(projectRef)
    const answered = await captain.waitForReply(null, waitMs(timeoutSeconds))
    return this.waitResult(captain, this.store.listCaptainMessages(captain.projectId, 30), answered)
  }

  private waitResult(captain: Captain, messages: CaptainMessage[], answered: boolean) {
    const last = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "error")
    return {
      projectId: captain.projectId,
      // A waiter that got its reply runs while that turn wraps up: only queued work means it isn't finished.
      allFinished: answered ? !captain.queued : !captain.active,
      state: captain.state(),
      lastReply: last?.content ?? null,
      messages: messages.slice(-8),
      ...(answered ? {} : { note: "Stopped waiting; the Captain is still working. Its reply will reach you as a Box Yard update when it's done, so don't wait again." }),
    }
  }

  editQueued(projectId: string, id: string, content: string) {
    return this.get(projectId).editQueued(id, content)
  }

  cancelQueued(projectId: string, id: string) {
    return this.get(projectId).cancelQueued(id)
  }

  restoreQueued(projectId: string, id: string) {
    return this.get(projectId).restoreQueued(id)
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

  /** This project's compactions as records, newest first; `taskId` keeps those linked to that task. */
  compactionRecords(projectId: string, filter: { taskId?: string; limit?: number } = {}): CompactionRecord[] {
    return readCompactionRecords(captainCompactionsDir(this.c.dataDir, projectId), filter)
  }

  compactionRecord(projectId: string, id: string): CompactionRecord | null {
    return findCompactionRecord(captainCompactionsDir(this.c.dataDir, projectId), id)
  }

  /** Route a task notice to its project's Captain. Returns true when handled. `wake: false` waits for the Captain's next turn. */
  notice(content: string, meta: Record<string, unknown> | null = null, { wake = true }: { wake?: boolean } = {}): boolean {
    // A box notice (e.g. a resize) goes to the Captain of every project on the box, and the Coordinator still
    // reads it: only the Captain that started it is woken; the others see it with their next update.
    if (Array.isArray(meta?.projectIds) && !meta.taskId) {
      for (const projectId of meta.projectIds as unknown[]) {
        if (typeof projectId !== "string" || !this.store.getProject(projectId)) continue
        const msg = this.store.addCaptainMessage(projectId, "notice", content, meta)
        this.hub.broadcast({ type: "captain.message", message: msg })
        if (wake && meta.captainProjectId === projectId) this.get(projectId).nudge()
      }
      return false
    }
    const taskId = typeof meta?.taskId === "string" ? meta.taskId : null
    const task = taskId ? this.store.getTask(taskId) : null
    if (!task) return false
    const msg = this.store.addCaptainMessage(task.projectId, "notice", content, meta)
    this.hub.broadcast({ type: "captain.message", message: msg })
    if (wake) this.get(task.projectId).nudge()
    return true
  }

  /**
   * A project-level notice for its Captain (a notes retro, the notes-over-budget signal), not about one task.
   * With `wake` the Captain gets it in an automatic wake-up, which its WakeLoopGuard may hold back (never drop).
   */
  projectNotice(projectId: string, content: string, meta: Record<string, unknown> = {}, { wake = true }: { wake?: boolean } = {}) {
    if (!this.store.getProject(projectId)) return null
    const msg = this.store.addCaptainMessage(projectId, "notice", content, meta)
    this.hub.broadcast({ type: "captain.message", message: msg })
    if (wake) this.get(projectId).nudge()
    return msg
  }

  stop() {
    for (const c of this.captains.values()) c.stop()
  }

  anyBusy() {
    return [...this.captains.values()].some((c) => c.active)
  }
}

const waitMs = (seconds: number) => Math.max(5, Math.min(seconds, CAPTAIN_WAIT_MAX_SECONDS)) * 1000

class Captain {
  private running = false
  private pending = false
  private wakeWanted = false
  private wakeTimer: NodeJS.Timeout | null = null
  private throttleTimer: NodeJS.Timeout | null = null
  /** Unattended wake-ups since Cody or the Coordinator last wrote. */
  private autoTurns = 0
  /** Set by stop(): the database closes right after, so a turn still winding down must not touch it. */
  private stopped = false
  private readonly loopGuard: WakeLoopGuard
  private child: ChildProcess | null = null
  private compactWanted: "button" | "auto" | null = null
  private compacting = false
  private lastError: string | null = null
  private readonly waiters = new Set<ReplyWaiter>()
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
    private readonly report: (content: string, report?: CaptainReport) => void,
    private readonly tuning: CaptainTuning,
    private readonly noticesHandled: (notices: CaptainNoticeEntry[], ok: boolean) => void = () => {},
    private readonly agentMessagesHandled: (messages: CaptainMessage[], reply: string) => void = () => {},
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
    return this.running || this.queued
  }

  /** Work waiting for the next turn: a message, a wake-up or a compaction. */
  get queued() {
    return this.pending || this.wakeWanted || this.compactWanted !== null
  }

  private writeMcpConfig() {
    fs.writeFileSync(this.mcpConfigPath, this.mcpConfig, { mode: 0o600 })
  }

  send(content: string, { id, attachments = [], source = "coordinator", tool, meta: extra }: CaptainSendOptions = {}): CaptainMessage {
    // Mid-turn it waits for the next turn: queued (see Store.deliverQueued).
    const meta = { ...extra, source, ...(tool ? { tool } : {}), ...(attachments.length ? { attachments } : {}), ...(this.running ? { queued: true } : {}) }
    const msg = this.store.addCaptainMessage(this.project.id, "user", content.trim(), meta, id)
    this.hub.broadcast({ type: "captain.message", message: msg })
    this.pending = true
    // A hook is an automation, not Cody or the Coordinator stepping in: the loop guard keeps counting.
    if (source !== "hook") {
      this.autoTurns = 0
      this.loopGuard.reset()
      this.clearThrottleTimer()
    }
    this.publishState()
    void this.drain()
    return msg
  }

  /** Edit a message still queued for the next turn. Refused once that turn has taken it. */
  editQueued(id: string, content: string): CaptainMessage {
    return this.queuedChanged(this.store.editQueuedChat("captain_messages", id, this.project.id, content.trim()))
  }

  /** Delete a queued message before a turn reads it. Undo with restoreQueued. */
  cancelQueued(id: string): CaptainMessage {
    return this.queuedChanged(this.store.cancelQueuedChat("captain_messages", id, this.project.id))
  }

  restoreQueued(id: string): CaptainMessage {
    const since = Number(this.store.getKv(`captain_last_turn_at:${this.project.id}`) ?? 0)
    const msg = this.queuedChanged(
      this.store.restoreQueuedChat("captain_messages", id, this.project.id, { queued: this.running, at: Math.max(Date.now(), since) }),
    )
    this.pending = true
    this.publishState()
    void this.drain()
    return msg
  }

  private queuedChanged(change: QueuedChatChange): CaptainMessage {
    if (!change.ok) throw queuedChatError(change.reason, "the Captain")
    const msg: CaptainMessage = { role: "user", projectId: this.project.id, ...change.row }
    this.hub.broadcast({ type: "captain.message", message: msg })
    return msg
  }

  /**
   * An agent's message_captain. Like a hook's message it's an automation, so it doesn't reset the loop guard (#58);
   * the guard also sees it, and an agent repeating the same message is held (kept, never dropped) until the
   * throttle ends or something new arrives. `heldUntil` says when, so the server can tell the agent.
   */
  fromAgent(input: AgentCaptainMessage): { message: CaptainMessage; heldUntil: number | null } {
    const meta: Record<string, unknown> = {
      source: "agent",
      tool: "message_captain",
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      agentMessageId: input.agentMessageId,
      waitSeconds: input.waitSeconds,
    }
    const key = `agent ${input.taskId}: ${input.message}`
    const decision = this.loopGuard.check([key])
    if (!decision.wake) meta.heldUntil = decision.until
    // Mid-turn it waits for the next turn, like send(): queued (see Store.deliverQueued).
    if (this.running) meta.queued = true
    const msg = this.store.addCaptainMessage(this.project.id, "user", input.message.trim(), meta)
    this.hub.broadcast({ type: "captain.message", message: msg })
    if (!decision.wake) {
      this.holdUntil(decision.until)
      if (decision.started) {
        const minutes = Math.max(1, Math.round((decision.until - Date.now()) / 60_000))
        this.report(
          `Loop guard: task ${input.taskId} ("${input.taskTitle}") keeps sending me the same message, so my automatic turns are paused for ${minutes} min. ` +
            `Its messages are kept, not dropped; I'll read them then, or sooner when something new arrives.`,
        )
      }
      this.publishState()
      return { message: msg, heldUntil: decision.until }
    }
    this.loopGuard.record([key])
    this.clearThrottleTimer()
    this.pending = true
    this.publishState()
    void this.drain()
    return { message: msg, heldUntil: null }
  }

  /**
   * Resolves true when a turn answering one of `ids` (null: any Coordinator message) ends, or the Captain goes
   * idle; false after `timeoutMs`. While a waiter holds a reply, it isn't pushed to the Coordinator as well.
   */
  waitForReply(ids: string[] | null, timeoutMs: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: ReplyWaiter = {
        ids,
        done: () => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve(true)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.add(waiter)
    })
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
    this.stopped = true
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
    if (this.running || this.stopped) return
    this.running = true
    this.publishState()
    try {
      while (!this.stopped && (this.pending || this.wakeWanted || this.compactWanted)) {
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
    } catch (err) {
      // stop() killed the turn and closed the database under it: nothing left to record.
      if (!this.stopped) throw err
    } finally {
      this.running = false
      this.publishState()
      for (const w of [...this.waiters]) w.done()
    }
  }

  private owner(): string {
    return this.settings.get().ownerName
  }

  private unansweredUserMessages(): CaptainMessage[] {
    const since = Number(this.store.getKv(`captain_last_turn_at:${this.project.id}`) ?? 0)
    return this.store.listCaptainMessages(this.project.id, 200).filter((m) => m.role === "user" && m.createdAt >= since && m.meta?.cancelled !== true)
  }

  private async turn() {
    const answering = this.unansweredUserMessages()
    const messages = answering
      .map((m) => `[${sourceLabel(m, this.owner())}]\n${m.content}${attachmentNote(m.meta?.attachments, this.owner())}`)
      .filter((text) => text.trim())
    if (!messages.length) return
    // Messages sent during the last turn move to now, right before this turn's reply.
    const moved = this.store.deliverQueued("captain_messages", answering.map((m) => m.id), this.project.id)
    for (const d of moved) {
      const m = answering.find((x) => x.id === d.id)!
      this.hub.broadcast({ type: "captain.message", message: { ...m, createdAt: d.createdAt, meta: d.meta } })
    }
    this.store.setKv(`captain_last_turn_at:${this.project.id}`, String(Math.max(Date.now(), ...moved.map((d) => d.createdAt)) + 1))
    const entries = this.store.takeUnseenCaptainNoticeEntries(this.project.id)
    const notices = entries.map((n) => n.content)
    const prompt = [updatesBlock("Project updates since your last turn", notices), messages.join("\n\n")]
      .filter(Boolean)
      .join("\n\n")
    const result = await this.runPrompt(prompt)
    this.handled(entries, result.ok)
    this.replyUpward(answering, result)
    const fromAgents = answering.filter((m) => captainSourceOf(m) === "agent")
    if (fromAgents.length) {
      try {
        this.agentMessagesHandled(fromAgents, result.ok ? result.text.trim() : `The Captain hit an error: ${result.error.slice(0, 500)}`)
      } catch (err) {
        console.error(`[captain ${this.project.id}] after-turn agent message handling failed:`, err)
      }
    }
  }

  /**
   * The Coordinator hears the Captain's reply to its messages as a pushed update, like a task notice, so
   * send_to_captain needs no blocking wait. An ask/wait_for_captain still waiting gets it in its tool result instead.
   */
  private replyUpward(answered: CaptainMessage[], result: { ok: boolean; error: string; text: string }) {
    const asked = answered.filter((m) => captainSourceOf(m) === "coordinator").map((m) => m.id)
    if (!asked.length) return
    const takers = [...this.waiters].filter((w) => !w.ids || w.ids.some((id) => asked.includes(id)))
    const taken = new Set(takers.flatMap((w) => w.ids ?? asked))
    for (const w of takers) w.done()
    const replyTo = asked.filter((id) => !taken.has(id))
    if (!replyTo.length) return
    const text = result.ok ? result.text.trim() : `I hit an error: ${result.error.slice(0, 500)}`
    if (!text || text === NO_UPDATE) return
    this.report(text.slice(0, TOOL_REPLY_MAX), { replyTo })
  }

  /** Tell the manager which notices this turn covered (a notes retro's leftovers are settled then). */
  private handled(entries: CaptainNoticeEntry[], ok: boolean) {
    if (!entries.length) return
    try {
      this.noticesHandled(entries, ok)
    } catch (err) {
      console.error(`[captain ${this.project.id}] after-turn notice handling failed:`, err)
    }
  }

  private async autoTurn() {
    const queued = this.store.peekUnseenCaptainNoticeEntries(this.project.id)
    if (!queued.length) return
    const decision = this.loopGuard.check(queued.map((n) => n.loopKey))
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
    const entries = this.store.takeUnseenCaptainNoticeEntries(this.project.id)
    if (!entries.length) return
    this.loopGuard.record(entries.map((n) => n.loopKey))
    this.autoTurns++
    const notices = entries.map((n) => n.content)
    const result = await this.runPrompt(
      [
        updatesBlock("Project updates since your last turn", notices),
        withOwner(
          `(Automatic wake-up: there is no new message from Cody or the Coordinator. Decide whether a project-local next step is needed. If Cody or the Coordinator should hear about it, say so in a line or two. If nothing needs reporting, reply with exactly ${NO_UPDATE} and nothing else.)`,
          this.owner(),
        ),
      ].join("\n\n"),
      true,
    )
    this.handled(entries, result.ok)
    if (!result.ok) this.report(`Captain for ${this.project.name} hit an error: ${result.error.slice(0, 500)}`)
  }

  /** Wake up again when the throttle ends, to deliver whatever queued up meanwhile. */
  private holdUntil(until: number) {
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      // Agent messages the guard held are answered in a turn of their own; task updates wait for the next wake.
      if (this.unansweredUserMessages().length) {
        this.pending = true
        void this.drain()
      } else this.nudge()
    }, Math.max(0, until - Date.now()))
    this.throttleTimer.unref?.()
  }

  /**
   * The project as it stands, at the top of every Captain prompt. The notes (exactly what agents get) are
   * listed when they changed since this session last saw them; otherwise one line says they're unchanged.
   */
  private projectNow(): { text: string; notesHash: string } {
    const tasks = this.store
      .listTasks({ projectId: this.project.id })
      .filter((t) => t.status !== "done")
      .map((t) => briefTask(t, this.owner()))
    const notes = this.notesNow()
    return {
      text: [
        `[Project now: ${this.project.name}]`,
        this.project.repo ? `Repo: ${this.project.repo} (${this.project.baseBranch})` : "No repo.",
        notes.text,
        tasks.length ? `Open tasks:\n${tasks.join("\n")}` : "No open tasks.",
      ].join("\n"),
      notesHash: notes.hash,
    }
  }

  private notesNow(): { text: string; hash: string } {
    const r = budgetNotes(this.store.listNotes(this.project.id), noteBudgetOf(this.settings.get(), this.store.getProject(this.project.id)))
    const listed = r.shown.map(noteLine)
    const hash = createHash("sha1").update(`${budgetLine(r)}\n${listed.join("\n")}`).digest("hex").slice(0, 16)
    const lines: string[] = []
    if (!r.count) lines.push(`Notes: none yet (budget: ${r.maxNotes} notes, ~${shortTokens(r.maxTokens)} tokens).`)
    else if (this.store.getKv(notesSeenKey(this.project.id)) === hash) lines.push(`Notes: unchanged since you last saw them (${budgetLine(r)}). list_notes shows them with ids.`)
    else lines.push(`Notes, as agents get them (${budgetLine(r)}; list_notes shows ids):`, ...listed)
    if (r.over) lines.push(withOwner(pruneAdvice(r), this.owner()))
    return { text: lines.join("\n"), hash }
  }

  private async runPrompt(body: string, auto = false): Promise<{ ok: boolean; error: string; text: string }> {
    let now = this.projectNow()
    const s = this.session()
    let result = await this.run(`${now.text}\n\n${body}`, s.id, s.started)
    if (!result.ok && s.started && /no conversation found|session.*not found/i.test(result.error)) {
      const fresh = randomUUID()
      this.store.setKv(sessionKey(this.project.id), fresh)
      // A new session hasn't seen the notes.
      this.store.setKv(notesSeenKey(this.project.id), null)
      now = this.projectNow()
      const recap = this.store
        .listCaptainMessages(this.project.id, 30)
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.meta?.cancelled !== true)
        .map((m) => `[${m.role}] ${m.content.slice(0, 800)}`)
        .join("\n")
      result = await this.run(`Earlier Captain conversation (your session was reset):\n${recap}\n\n---\n\n${now.text}\n\n${body}`, fresh, false)
    }
    if (result.ok) this.store.setKv(notesSeenKey(this.project.id), now.notesHash)
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

  /** This project's tasks active or mentioned since the previous compaction, so the tools can find it by task. */
  private compactionTaskSnapshots(): CompactionTaskSnapshot[] {
    const previous = lastCompaction(this.compactionsDir)?.at ?? 0
    const messages = this.store.listCaptainMessages(this.project.id, 1000).filter((m) => m.createdAt > previous)
    const mentioned = mentionedTaskIds(messages.flatMap((m) => [m.content, m.meta]))
    return compactionTaskSnapshots(this.store, this.store.listTasks({ projectId: this.project.id }), previous, mentioned)
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
      const meta = { at: Date.now(), sessionId: s.id, model, trigger, tokensBefore: before, heading: `Captain compaction summary: ${this.project.name}` }
      const { markdownFile: file } = writeCompaction(this.compactionsDir, meta, text, this.compactionTaskSnapshots())
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
      // The summary may not carry every note: list them again on the next turn.
      this.store.setKv(notesSeenKey(this.project.id), null)
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
      `${captainPrompt(this.project, st.ownerName, noteBudgetOf(st, this.store.getProject(this.project.id)))}\n\n${routingInstructions(this.c.dataDir, st)}\n\n${withOwner(compactionsPrompt(this.compactionsDir), st.ownerName)}`,
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
        // stop() closed the database; the run's last lines have nowhere to go.
        if (this.stopped) return
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
        if (this.stopped) return resolve({ text: said, raw, sessionId: seenSession, ok: false, error: "Box Yard stopped." })
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
