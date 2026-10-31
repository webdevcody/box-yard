// Side threads: Cody highlights a passage in the Coordinator chat (or a project Captain's chat) and asks about it.
// The question runs in its own Claude session, forked from the chat's session at the highlighted message
// (`--resume <chat> --resume-session-at <uuid> --fork-session`), so the thread knows everything up to and including
// that message and nothing after it. The chat's own session and transcript are never touched: a fork writes a new
// session file, and the thread's messages live in their own table.
//
// When the fork point is older than the chat's last compaction (or the chat's session was reset), the thread starts
// a fresh session instead, with the summary of the compaction before the highlighted message plus the messages from
// there up to it (context "summary").
//
// A task's card in the Coordinator chat has a thread too (kind "task", one per card, anchored on the task's id): Cody's
// questions to the Coordinator about that task, answered in the card. It forks the Coordinator's session at its newest
// answer and starts from the task as it stands now (ThreadHost.taskState) and its updates in the chat. Like every
// thread, the main chat and its session never see it. Old ones on a batch card (`batch:<id>`, before every task had its
// own card) stay listed and readable, but have no task to go on with.
//
// Threads are for questions: they see the chat's tools (so the fork keeps the chat's prompt cache) but may only use
// the read-only ones in THREAD_TOOLS. The CLI refuses the rest (dontAsk with an allowlist), and so does the MCP
// server, for the thread's own read-only token.
//
// A chat on Codex (docs/codex.md) can't be forked at a message, so its threads always start the "summary" way, on
// Codex, and only the MCP server's read-only token keeps them to the lookups.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import { BadRequestError, NotFoundError } from "./store.js"
import type { SettingsStore } from "./settings.js"
import type { McpCaller } from "./mcp.js"
import { listCompactions, readCompactionInfo, summaryBody } from "./compactions.js"
import { resultUsageObject } from "./usage.js"
import { serverClaudeEnv } from "./turnCredentials.js"
import { MISSING_SESSION, codexErrorText } from "./codex.js"
import { CHAT_ALLOWED_TOOLS, CHAT_TOOLS, codexChatLaunch, type ChatLaunch } from "./chatAgent.js"
import type { AgentCli } from "../shared/agentCli.js"
import { withOwner } from "../shared/owner.js"
import { parseNextSteps } from "../shared/nextSteps.js"
import type { ChatMessage, Effort, SideThread, SideThreadKind, SideThreadMessage, Task } from "../shared/types.js"

const TURN_TIMEOUT_MS = 10 * 60_000
/** The most of a highlight or question a thread keeps. */
export const MAX_QUOTE_CHARS = 20_000
export const MAX_QUESTION_CHARS = 20_000
/** The summary fallback replays at most this many messages, each cut to this many characters. */
const FALLBACK_MESSAGES = 30
const FALLBACK_MESSAGE_CHARS = 1500
/** A task thread starts with at most this many of the task's updates in the chat. */
const TASK_NOTICES = 12

/**
 * The Box Yard tools a side thread may call: lookups that change nothing. Every other tool is listed (the fork keeps
 * the chat's tool list, and with it the prompt cache) but refused, by the CLI and by the MCP server.
 */
export const THREAD_TOOLS: ReadonlySet<string> = new Set([
  "list_projects",
  "list_tasks",
  "get_task",
  "search_history",
  "list_compactions",
  "read_compaction",
  "find_compactions_by_task",
  "list_inbox",
  "list_queued_messages",
  "list_artifacts",
  "read_artifact",
  "list_notes",
  "list_note_suggestions",
  "list_schedules",
  "list_schedule_runs",
  "list_hooks",
  "list_hook_runs",
  "pool_status",
  "machine_stats",
  "list_machines",
  "box_history",
  "turn_timings",
  "get_settings",
])

/** What the MCP server answers a side thread that calls any other tool. */
export const READ_ONLY_REFUSAL =
  "Side threads are read-only: this tool changes Box Yard, so it isn't available here. Say what you would do, and Cody can ask for it in the main chat."

/** Chat message meta naming the Claude session line an assistant message came from: where a side thread forks. */
export const SESSION_UUID_KEY = "sessionUuid"
export const SESSION_ID_KEY = "sessionId"

/** The meta an assistant chat message keeps so a side thread can fork the session at it. */
export function sessionLineMeta(line: { uuid?: unknown }, sessionId: string): Record<string, string> {
  return typeof line.uuid === "string" && line.uuid ? { [SESSION_UUID_KEY]: line.uuid, [SESSION_ID_KEY]: sessionId } : {}
}

/** What a chat lends its side threads. */
export interface ThreadHost {
  /** The chat's working folder: its Claude sessions are stored by it, so a fork must run there too. */
  cwd: string
  /** The chat's current session. */
  session(): { id: string; started: boolean }
  /** The chat's system prompt, unchanged, so a fork reuses its prompt cache. */
  systemPrompt(): string
  /** Read rules for the chat's own folders (compaction logs, uploads). */
  readRules(): string[]
  /** The CLI the chat runs on now: a thread runs on it too. */
  cli(): AgentCli
  /** The chat's model on that CLI (null: Codex's own default). */
  model(): string | null
  effort(): string
  compactionsDir: string
  /** The chat's MCP caller; the thread gets a read-only one like it. */
  caller: McpCaller
  /** The chat's own Claude login (a Captain's project identity's), or null for Settings › Credentials'. */
  claudeLogin(): Record<string, string> | null
  /** How its runs are counted in usage. */
  usage: { source: "orchestrator" | "captain"; projectId: string | null }
  /**
   * These tasks as they stand now (status, PR, question, last reply), as the chat may see them: a task thread starts
   * from it. Only the Coordinator's chat has task threads.
   */
  taskState?(task: Task): Promise<string>
  /** The project shows the chat its tasks' status only (docs/identities.md): a task thread gets none of their updates. */
  statusOnly?(projectId: string): boolean
}

/** Where a fork starts: the session line of the newest assistant message at or before the highlighted one. */
export interface ForkPoint {
  uuid: string
  /** The highlighted message is that assistant message (else its text goes in the prompt). */
  atAnchor: boolean
}

/**
 * Where to fork `messages` (a chat up to and including the highlighted message, oldest first): the newest assistant
 * message from the chat's current session that carries its session line. null, so the thread falls back to the
 * summary, when there is none, or when the chat was compacted after it (a fork there would replay the whole
 * pre-compaction history).
 */
export function forkPoint(messages: ChatMessage[], sessionId: string, lastCompactionAt: number | null): ForkPoint | null {
  const anchor = messages.at(-1)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const uuid = m.meta?.[SESSION_UUID_KEY]
    if (typeof uuid !== "string" || m.meta?.[SESSION_ID_KEY] !== sessionId) return null
    if (lastCompactionAt !== null && m.createdAt <= lastCompactionAt) return null
    return { uuid, atAnchor: m === anchor }
  }
  return null
}

/**
 * The fallback context: the summary of the newest compaction at or before the highlighted message, then the
 * conversation from that compaction up to and including the highlighted message (never anything after it).
 */
export function summaryContext(messages: ChatMessage[], summary: { at: number; markdown: string } | null, ownerName?: string, upTo = "the highlighted message"): string {
  const since = summary?.at ?? 0
  const lines = messages
    .filter((m) => m.createdAt >= since && (m.role === "user" || m.role === "assistant" || m.role === "notice") && m.meta?.cancelled !== true && m.content.trim())
    .slice(-FALLBACK_MESSAGES)
    .map((m) => {
      const who = m.role === "user" ? withOwner("Cody", ownerName) : m.role === "assistant" ? "You" : "Box Yard update"
      const text = m.content.length > FALLBACK_MESSAGE_CHARS ? `${m.content.slice(0, FALLBACK_MESSAGE_CHARS)}…` : m.content
      return `[${who}] ${text}`
    })
  return [
    summary ? `The summary you wrote when the chat was compacted, before ${upTo}:\n${summaryBody(summary.markdown)}` : null,
    lines.length ? `The conversation${summary ? " since then" : ""}, up to and including ${upTo}:\n${lines.join("\n\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const quoteBlock = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")

/** A side thread's first prompt: the highlight and the question, with the context a fresh session needs. */
export function threadPrompt(o: { quote: string; question: string; anchorText: string | null; context: string | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      "[Box Yard side thread] Cody highlighted a passage in this chat and is asking about it in a side thread. The thread is separate from the main conversation: the main chat never sees it, and it starts at the highlighted message, so nothing said after that message is part of it.",
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    o.anchorText ? `The highlighted passage is from this message:\n${quoteBlock(o.anchorText)}` : null,
    `Highlighted:\n${quoteBlock(o.quote)}`,
    own(
      "Answer briefly and directly. This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat. No next-step block in this thread.",
    ),
    `${own("Cody")}'s question:\n${o.question}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * A reply thread's first prompt: the message Cody replied to, in full (the thread's context starts there), and the
 * reply. Like an ask's, with the whole message instead of a highlight.
 */
export function replyPrompt(o: { original: string; reply: string; context: string | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      "[Box Yard side thread] Cody replied to one of the messages in this chat, in a thread under it. The thread is separate from the main conversation: the main chat never sees it, and it starts at that message, so nothing said after it is part of it.",
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    `${own("The message Cody is replying to:")}\n${quoteBlock(o.original)}`,
    own(
      "Answer the reply in light of that message, briefly and directly. This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat. No next-step block in this thread.",
    ),
    `${own("Cody")}'s reply:\n${o.reply}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** The read-only rule every thread's first prompt ends with. */
const READ_ONLY_RULE =
  "This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat or send it to the task from its card. No next-step block in this thread."

/** A task's updates in the chat, oldest first, one line each (cut), for a task thread's first prompt. */
export function noticeLines(notices: ChatMessage[]): string {
  return notices
    .filter((m) => m.content.trim())
    .map((m) => `- ${m.content.length > FALLBACK_MESSAGE_CHARS ? `${m.content.slice(0, FALLBACK_MESSAGE_CHARS)}…` : m.content}`)
    .join("\n")
}

/**
 * A task thread's first prompt: which card Cody asks from, the task as it stands now, its updates in the chat, and the
 * question. `context`: a fresh session's notes, when the chat's session couldn't be forked.
 */
export function taskThreadPrompt(o: { title: string; state: string; notices: string; question: string; context: string | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      `[Box Yard side thread] Cody is asking you about a task, from the card of the task "${o.title}" in the Coordinator chat. This thread is separate from the main conversation: the main chat never sees it, and it starts at your newest message there.`,
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    o.state,
    o.notices ? `Its updates in the chat, oldest first:\n${o.notices}` : null,
    own(`Answer briefly and directly, about this task. ${READ_ONLY_RULE}`),
    `${own("Cody")}'s question:\n${o.question}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * What a task thread's state says, without its "updated 3m ago"s: a later turn is told the state again only when this
 * changed, not because a minute passed.
 */
export function taskKey(t: Task): string {
  return JSON.stringify([t.id, t.status, t.updatedAt, t.prUrl ?? null, t.prState ?? null, t.pendingCount ?? 0, t.question ?? null, t.error ?? null])
}

interface RunState {
  child: ChildProcess | null
  running: boolean
  pending: boolean
  /** The last user message a turn has taken: the next turn takes the ones after it. */
  lastAskId: string | null
  /** A task thread's: the task's state as its last turn was told it (taskKey). */
  taskKey?: string
}

interface RunResult {
  ok: boolean
  error: string
  /** The run stopped before the CLI started a session (a fork it couldn't make). */
  noSession: boolean
}

export class SideThreads {
  private readonly runs = new Map<string, RunState>()
  /** Read-only MCP tokens, one per chat ("coordinator" or a project id). */
  private readonly tokens = new Map<string, { token: string; caller: McpCaller }>()
  private stopped = false
  private readonly dir: string

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly settings: SettingsStore,
    private readonly mcpUrl: string,
    /** The chat a thread belongs to: the Coordinator for null, else that project's Captain. */
    private readonly hostFor: (projectId: string | null) => ThreadHost,
  ) {
    this.dir = path.join(c.dataDir, "side-threads")
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** The read-only caller a side thread's MCP token stands for, or null for any other token. */
  callerForToken(token: string): McpCaller | null {
    for (const t of this.tokens.values()) if (t.token === token) return { ...t.caller, readOnly: true } as McpCaller
    return null
  }

  list(projectId: string | null): SideThread[] {
    this.checkChat(projectId)
    return this.store.listSideThreads(projectId).map((t) => this.decorate(t))
  }

  get(id: string): SideThread {
    const t = this.store.getSideThread(id)
    if (!t) throw new NotFoundError(`Side thread ${id} not found`)
    return this.decorate(t)
  }

  messages(id: string): SideThreadMessage[] {
    this.get(id)
    return this.store.listSideThreadMessages(id)
  }

  /**
   * Open a thread on a chat message with Cody's first message: a question about a highlighted passage (kind "ask"),
   * or a reply to the whole message (kind "reply", no quote needed). A message has one reply thread: replying to it
   * again adds to that thread. Kind "task": a question from a task's card in the Coordinator chat (anchorId: the
   * task's id); a card has one thread too.
   */
  create(input: { projectId: string | null; anchorId: string; quote?: string; question: string; kind?: SideThreadKind; id?: string; messageId?: string }): {
    thread: SideThread
    message: SideThreadMessage
  } {
    this.checkChat(input.projectId)
    const kind = input.kind ?? "ask"
    const question = input.question.trim()
    if (!question) throw new BadRequestError(kind === "reply" ? "question: write a reply" : "question: ask something")
    if (kind === "task") return this.createOnCard(input, question)
    const anchor = this.store.chatUpTo(input.projectId, input.anchorId, 1)?.[0]
    if (!anchor) throw new BadRequestError(`anchorId: no message ${input.anchorId} in this chat`)
    if (kind === "reply") {
      const existing = this.store.threadOn(input.projectId, input.anchorId, "reply")
      if (existing) {
        const message = this.send(existing.id, question, input.messageId)
        return { thread: this.get(existing.id), message }
      }
    }
    const quote = (kind === "reply" ? anchor.content : (input.quote ?? "")).trim()
    if (!quote) throw new BadRequestError(kind === "reply" ? "anchorId: that message has no text to reply to" : "quote: highlight some text to ask about")
    if (input.id && this.store.getSideThread(input.id)) throw new BadRequestError(`A side thread ${input.id} already exists`)
    const thread = this.store.createSideThread({ id: input.id, projectId: input.projectId, anchorId: input.anchorId, kind, quote: quote.slice(0, MAX_QUOTE_CHARS), sessionId: randomUUID() })
    this.hub.broadcast({ type: "thread", thread: this.decorate(thread) })
    const message = this.send(thread.id, question, input.messageId)
    return { thread: this.get(thread.id), message }
  }

  /** A task card's thread: its first question, or the next one in the thread it has. */
  private createOnCard(input: { projectId: string | null; anchorId: string; id?: string; messageId?: string }, question: string) {
    if (input.projectId) throw new BadRequestError("kind: only the Coordinator chat has task cards")
    const task = this.store.getTask(input.anchorId)
    if (!task) throw new BadRequestError(`anchorId: no task ${input.anchorId}`)
    const existing = this.store.threadOn(null, input.anchorId, "task")
    if (existing) {
      const message = this.send(existing.id, question, input.messageId)
      return { thread: this.get(existing.id), message }
    }
    if (input.id && this.store.getSideThread(input.id)) throw new BadRequestError(`A side thread ${input.id} already exists`)
    const thread = this.store.createSideThread({ id: input.id, projectId: null, anchorId: input.anchorId, kind: "task", quote: task.title.slice(0, MAX_QUOTE_CHARS), sessionId: randomUUID() })
    this.hub.broadcast({ type: "thread", thread: this.decorate(thread) })
    const message = this.send(thread.id, question, input.messageId)
    return { thread: this.get(thread.id), message }
  }

  /** Cody's next message in a thread; answered right away, or after the turn that's running. It reopens a resolved thread. */
  send(id: string, content: string, messageId?: string): SideThreadMessage {
    const thread = this.get(id)
    const text = content.trim().slice(0, MAX_QUESTION_CHARS)
    if (!text) throw new BadRequestError("content: message is empty")
    const message = this.store.addSideThreadMessage(thread.id, "user", text, null, messageId)
    if (thread.resolvedAt !== null) this.store.resolveSideThread(thread.id, false)
    this.store.seeSideThread(thread.id, message.createdAt)
    this.hub.broadcast({ type: "thread.message", message })
    this.state(thread.id).pending = true
    void this.drain(thread.id)
    return message
  }

  /** Resolve a thread (it folds away under its message, still reachable there), or reopen it. */
  resolve(id: string, resolved: boolean): SideThread {
    this.get(id)
    this.store.resolveSideThread(id, resolved)
    this.publish(id)
    return this.get(id)
  }

  /** Cody has the thread open: its answers so far are read. */
  seen(id: string): SideThread {
    const before = this.get(id)
    this.store.seeSideThread(id)
    const after = this.get(id)
    if (before.unread !== after.unread) this.publish(id)
    return after
  }

  stop(id: string) {
    this.runs.get(id)?.child?.kill("SIGTERM")
  }

  delete(id: string) {
    const thread = this.get(id)
    const run = this.runs.get(id)
    if (run) {
      run.pending = false
      run.child?.kill("SIGTERM")
    }
    this.runs.delete(id)
    this.store.deleteSideThread(id)
    this.hub.broadcast({ type: "thread.deleted", threadId: id, projectId: thread.projectId })
  }

  /** Box Yard is shutting down: stop every run before the database closes. */
  stopAll() {
    this.stopped = true
    for (const r of this.runs.values()) r.child?.kill("SIGTERM")
  }

  get anyBusy() {
    return [...this.runs.values()].some((r) => r.running)
  }

  private checkChat(projectId: string | null) {
    if (projectId && !this.store.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
  }

  private decorate(t: SideThread): SideThread {
    return { ...t, busy: Boolean(this.runs.get(t.id)?.running) }
  }

  private state(id: string): RunState {
    let r = this.runs.get(id)
    if (!r) {
      // After a restart, what came before the thread's last reply was answered.
      let lastAskId: string | null = null
      let answered: string | null = null
      for (const m of this.store.listSideThreadMessages(id)) {
        if (m.role === "user") lastAskId = m.id
        else answered = lastAskId
      }
      r = { child: null, running: false, pending: false, lastAskId: answered }
      this.runs.set(id, r)
    }
    return r
  }

  private publish(id: string) {
    try {
      const t = this.store.getSideThread(id)
      if (t) this.hub.broadcast({ type: "thread", thread: this.decorate(t) })
    } catch {
      // The database is closed (shutdown while a run was finishing).
    }
  }

  private async drain(id: string) {
    const r = this.state(id)
    if (r.running || this.stopped) return
    r.running = true
    this.publish(id)
    try {
      while (r.pending && !this.stopped && this.runs.get(id) === r) {
        r.pending = false
        await this.turn(id, r)
      }
    } catch (err) {
      if (!this.stopped) throw err
    } finally {
      r.running = false
      if (!this.stopped) this.publish(id)
    }
  }

  private async turn(id: string, r: RunState) {
    const thread = this.store.getSideThread(id)
    if (!thread) return
    const list = this.store.listSideThreadMessages(id)
    const asks = list.slice(list.findIndex((m) => m.id === r.lastAskId) + 1).filter((m) => m.role === "user")
    if (!asks.length) return
    r.lastAskId = asks.at(-1)!.id
    const question = asks.map((m) => m.content).join("\n\n")
    const host = this.hostFor(thread.projectId)
    const session = this.store.sideThreadSession(id)!
    const owner = this.settings.get().ownerName

    if (thread.kind === "task") return this.taskTurn(id, r, thread, host, question, session, owner)
    if (session.started) {
      const result = await this.run(id, r, host, question, ["--resume", session.sessionId], session.sessionId, true)
      // Its session is gone, or belongs to the CLI the chat ran on before: start over from the summary.
      if (result.ok || !MISSING_SESSION.test(result.error) || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }

    const upTo = this.store.chatUpTo(thread.projectId, thread.anchorId, 400) ?? []
    const main = host.session()
    const compactions = this.compactions(host.compactionsDir)
    // Codex can't fork a session at a message: a thread on a Codex chat always starts from the summary.
    const fork = main.started && host.cli() === "claude" ? forkPoint(upTo, main.id, compactions.at(-1)?.at ?? null) : null
    const anchor = upTo.at(-1)
    // A reply thread quotes the whole message it replies to; an ask, the highlight (and the message, unless the fork ends on it).
    const first = (context: string | null, withAnchor: boolean) =>
      thread.kind === "reply"
        ? replyPrompt({ original: anchor?.content || thread.quote, reply: question, context, ownerName: owner })
        : threadPrompt({ quote: thread.quote, question, anchorText: withAnchor ? (anchor?.content ?? null) : null, context, ownerName: owner })
    if (fork) {
      const prompt = first(null, !fork.atAnchor)
      const args = ["--resume", main.id, "--resume-session-at", fork.uuid, "--fork-session", "--session-id", session.sessionId]
      const result = await this.run(id, r, host, prompt, args, session.sessionId, true, "fork")
      // A fork the CLI couldn't make (the session file is gone, say): start over from the summary.
      if (result.ok || !result.noSession || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }
    const summary = this.summaryBefore(compactions, anchor?.createdAt ?? Date.now())
    const context = summaryContext(upTo, summary, owner)
    const prompt = first(context || null, false)
    const fresh = randomUUID()
    const result = await this.run(id, r, host, prompt, ["--session-id", fresh], fresh, false, "summary")
    this.finish(id, result)
  }

  /**
   * A task card's turn. The first forks the Coordinator's session at its newest answer (or, when it can't, starts fresh
   * from the chat's last summary and messages) and starts from the task as it stands now and its updates in the chat.
   * Later turns resume the thread, with the task's state again when it changed.
   */
  private async taskTurn(
    id: string,
    r: RunState,
    thread: SideThread,
    host: ThreadHost,
    question: string,
    session: { sessionId: string; started: boolean },
    owner: string | undefined,
  ) {
    // An old batch card's thread (`batch:<id>`) has no task: like a deleted one's, it can't go on.
    const task = this.store.getTask(thread.anchorId)
    if (!task || !host.taskState) {
      this.finish(id, { ok: false, error: task ? "This chat has no task cards." : "Its task was deleted.", noSession: true })
      return
    }
    const state = await host.taskState(task)
    if (this.stopped || !this.store.getSideThread(id)) return
    const key = taskKey(this.store.getTask(task.id) ?? task)
    const changed = key !== r.taskKey
    r.taskKey = key

    if (session.started) {
      const prompt = changed ? `[The task now:]\n${state}\n\n${question}` : question
      const result = await this.run(id, r, host, prompt, ["--resume", session.sessionId], session.sessionId, true)
      // Its session is gone, or belongs to the CLI the chat ran on before: start over from the summary.
      if (result.ok || !MISSING_SESSION.test(result.error) || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }

    const recent = this.store.listChat(400)
    const main = host.session()
    const compactions = this.compactions(host.compactionsDir)
    // Codex can't fork a session at a message: a thread on a Codex chat always starts from the summary.
    const fork = main.started && host.cli() === "claude" ? forkPoint(recent, main.id, compactions.at(-1)?.at ?? null) : null
    const notices = host.statusOnly?.(task.projectId) ? "" : noticeLines(this.store.taskNotices([task.id], TASK_NOTICES))
    const first = (context: string | null) => taskThreadPrompt({ title: task.title, state, notices, question, context, ownerName: owner })
    if (fork) {
      const args = ["--resume", main.id, "--resume-session-at", fork.uuid, "--fork-session", "--session-id", session.sessionId]
      const result = await this.run(id, r, host, first(null), args, session.sessionId, true, "fork")
      if (result.ok || !result.noSession || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }
    // A fresh session replays the chat as the Coordinator read it: not Cody's messages straight to tasks (marked read
    // for it), nor a status-only project's updates.
    const sealed = (m: ChatMessage) => {
      const row = typeof m.meta?.taskId === "string" ? this.store.getTaskRow(m.meta.taskId) : null
      return Boolean(row && host.statusOnly?.(row.project_id))
    }
    const read = recent.filter((m) => m.role !== "notice" || (m.meta?.sent !== true && !sealed(m)))
    const summary = this.summaryBefore(compactions, Date.now())
    const context = summaryContext(read, summary, owner, "your newest message")
    const fresh = randomUUID()
    const result = await this.run(id, r, host, first(context || null), ["--session-id", fresh], fresh, false, "summary")
    this.finish(id, result)
  }

  private finish(id: string, result: RunResult) {
    if (result.ok || this.stopped || !this.store.getSideThread(id)) return
    const message = this.store.addSideThreadMessage(id, "error", `The side thread hit an error: ${result.error.slice(0, 1500)}`)
    this.hub.broadcast({ type: "thread.message", message })
    this.publish(id)
  }

  /** A chat's compactions, oldest first: when, and the summary file. */
  private compactions(dir: string): { at: number; file: string }[] {
    return listCompactions(dir)
      .map((name) => {
        const file = path.join(dir, name)
        return { at: readCompactionInfo(file)?.at ?? 0, file }
      })
      .filter((x) => x.at > 0)
  }

  private summaryBefore(compactions: { at: number; file: string }[], at: number): { at: number; markdown: string } | null {
    const last = compactions.filter((x) => x.at <= at).at(-1)
    if (!last) return null
    try {
      return { at: last.at, markdown: fs.readFileSync(last.file, "utf8") }
    } catch {
      return null
    }
  }

  /** The chat's read-only MCP token, made on first use. */
  private tokenFor(host: ThreadHost): string {
    const key = host.usage.projectId ?? "coordinator"
    let t = this.tokens.get(key)
    if (!t) {
      t = { token: `thr_${randomBytes(24).toString("hex")}`, caller: host.caller }
      this.tokens.set(key, t)
    }
    return t.token
  }

  private mcpConfigFor(host: ThreadHost): string {
    const key = host.usage.projectId ?? "coordinator"
    const file = path.join(this.dir, `${key}-mcp.json`)
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { boxyard: { type: "http", url: this.mcpUrl, headers: { Authorization: `Bearer ${this.tokenFor(host)}` } } } }), { mode: 0o600 })
    return file
  }

  /**
   * How a thread's run starts: its chat's CLI. `sessionArgs` are Claude Code's (--resume, --fork-session…); on Codex
   * the run resumes `sessionId` when `resumed`, else starts a new thread, which names its own session.
   */
  private launch(host: ThreadHost, sessionArgs: string[], sessionId: string, resumed: boolean): ChatLaunch {
    if (host.cli() === "codex") {
      return codexChatLaunch({
        c: this.c,
        credentials: this.settings.credentials,
        mcp: { url: this.mcpUrl, token: this.tokenFor(host) },
        resume: resumed ? sessionId : null,
        model: host.model(),
        effort: host.effort() as Effort,
        instructions: host.systemPrompt(),
      })
    }
    const allowed = [...[...THREAD_TOOLS].map((t) => `mcp__boxyard__${t}`), ...CHAT_ALLOWED_TOOLS, ...host.readRules()]
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config",
      this.mcpConfigFor(host),
      // The chat's tools and system prompt, so the fork reuses its prompt cache; only the allowlist may run.
      "--tools",
      CHAT_TOOLS,
      "--allowedTools",
      allowed.join(","),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      host.systemPrompt(),
      ...sessionArgs,
      "--model",
      host.model() ?? "",
      "--effort",
      host.effort(),
    ]
    const [bin, ...pre] = this.c.claudeBin.split(" ")
    // Like its chat's own `claude`: the chat's Claude login, and never the key identities' secrets are encrypted with.
    const env = serverClaudeEnv(host.claudeLogin(), this.settings.credentials.claudeEnv())
    return { cli: "claude", bin: bin!, args: [...pre, ...args], env, translate: null, after() {} }
  }

  private run(
    id: string,
    r: RunState,
    host: ThreadHost,
    prompt: string,
    sessionArgs: string[],
    sessionId: string,
    resumed: boolean,
    starts?: "fork" | "summary",
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const launch = this.launch(host, sessionArgs, sessionId, resumed)
      const cliName = launch.cli === "codex" ? `codex (${this.c.codexBin})` : `claude (${this.c.claudeBin})`

      let child: ChildProcess
      try {
        child = spawn(launch.bin, launch.args, { cwd: host.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] })
      } catch (err) {
        resolve({ ok: false, error: `Couldn't start ${launch.cli}: ${(err as Error).message}`, noSession: true })
        return
      }
      r.child = child
      let buf = ""
      let stderr = ""
      let settled = false
      let sawInit = false
      let sawResult = false
      let resultError: string | null = null
      let resultUsage: ReturnType<typeof resultUsageObject> = null
      let resultCostUsd: number | null = null
      let resultDurationMs: number | null = null
      let resultModel: string | null = null
      const startedAt = Date.now()
      const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS)
      const alive = () => !this.stopped && this.runs.get(id) === r

      let seenSession: string | null = null
      const onLine = (line: string) => {
        if (launch.translate) {
          for (const m of launch.translate(line)) onMsg(m)
          return
        }
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        onMsg(msg)
      }
      const onMsg = (msg: any) => {
        if (!alive()) return
        if (typeof msg.session_id === "string") seenSession = msg.session_id
        if (msg.type === "stream_event") {
          const ev = msg.event
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") this.hub.broadcast({ type: "thread.delta", threadId: id, text: ev.delta.text })
          return
        }
        if (msg.type === "system" && msg.subtype === "init") {
          sawInit = true
          // Codex names its own thread: that's the session the thread's next question resumes.
          if (starts) this.store.startSideThread(id, starts, launch.cli === "codex" ? (seenSession ?? sessionId) : sessionId)
          return
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          const text = parseNextSteps(
            msg.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("")
              .trim(),
          ).content.trim()
          if (text) {
            const m = this.store.addSideThreadMessage(id, "assistant", text)
            this.hub.broadcast({ type: "thread.message", message: m })
            // Its reply count and unread mark.
            this.publish(id)
          }
          for (const b of msg.message.content) {
            if (b.type !== "tool_use") continue
            const m = this.store.addSideThreadMessage(id, "tool", String(b.name).replace(/^mcp__boxyard__/, ""), { input: b.input })
            this.hub.broadcast({ type: "thread.message", message: m })
          }
          return
        }
        if (msg.type === "result") {
          sawResult = true
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
        r.child = null
        launch.after()
        const noSession = !sawInit
        if (!alive()) return resolve({ ok: false, error: "Stopped.", noSession })
        if (resultUsage || typeof resultCostUsd === "number" || typeof resultDurationMs === "number") {
          this.store.recordClaudeUsage({
            source: host.usage.source,
            runKind: "thread",
            projectId: host.usage.projectId,
            sessionId: seenSession ?? sessionId,
            model: resultModel ?? host.model() ?? "codex",
            startedAt,
            endedAt: Date.now(),
            durationMs: resultDurationMs,
            usage: resultUsage,
            costUsd: resultCostUsd,
            resumed,
          })
        }
        if (err) return resolve({ ok: false, error: `Couldn't run ${cliName}: ${err.message}`, noSession })
        if (code === 0 && !resultError && (sawResult || launch.cli === "claude")) return resolve({ ok: true, error: "", noSession })
        resolve({ ok: false, error: resultError ?? ((launch.cli === "codex" ? codexErrorText(stderr) : stderr.trim()) || `${launch.cli} exited with code ${code}${sawResult ? "" : " before answering"}`), noSession })
      }
      child.on("error", (err) => finish(null, err))
      child.on("close", (code) => finish(code))
      child.stdin!.on("error", () => {})
      child.stdin!.end(prompt)
    })
  }
}
