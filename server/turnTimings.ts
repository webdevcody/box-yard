// Per-turn timings (shared/turnTimings.ts): the clock that reads them off one CLI run's stream-json, and the MCP
// handshakes the server saw. The box runner keeps a copy of TurnClock (runner/box-runner.mjs, same algorithm, checked
// by test/turn-timings.test.ts): it runs on the box, which never calls the server.
import { TURN_TIMING_MAX_STEPS, type TurnClockReading, type TurnStep, type TurnTiming } from "../shared/turnTimings.js"

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const toolName = (name: unknown) => String(name ?? "?").replace(/^mcp__boxyard__/, "")

/**
 * Reads one CLI run's stream-json lines as they arrive. A model step runs from ready (or the last tool result) to the
 * last assistant line before the next tool result; a tool call from its tool_use line to its tool_result. Subagent
 * lines (parent_tool_use_id) belong to their Task call. Cheap: a few comparisons per line.
 */
export class TurnClock {
  readonly startedAt: number
  private readyAt: number | null = null
  private mcpStatus: string | null = null
  private firstTokenAt: number | null = null
  private resultAt: number | null = null
  private stepStart: number | null = null
  private stepLast: number | null = null
  private lastToolEnd: number | null = null
  private readonly open = new Map<string, { name: string; at: number }>()
  private readonly ids = new Set<string>()
  private readonly steps: TurnStep[] = []
  private dropped = 0
  private toolSpans: [number, number][] = []
  private result: Record<string, unknown> | null = null
  private contextTokens: number | null = null

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt
  }

  /** The spawn → ready time so far (the `init` line), for the MCP handshake to be matched against. */
  get ready(): number | null {
    return this.readyAt
  }

  line(msg: any, at = Date.now()) {
    if (!msg || typeof msg !== "object" || msg.parent_tool_use_id) return
    if (msg.type === "system" && msg.subtype === "init") {
      if (this.readyAt !== null) return
      this.readyAt = at
      if (Array.isArray(msg.mcp_servers) && msg.mcp_servers.length) {
        this.mcpStatus = msg.mcp_servers.map((s: any) => `${s?.name ?? "?"}: ${s?.status ?? "?"}`).join(", ")
      }
      return
    }
    if (msg.type === "stream_event") {
      if (this.firstTokenAt === null && msg.event?.type === "content_block_delta") this.firstTokenAt = at
      return
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      if (msg.message.model === "<synthetic>") return
      if (this.firstTokenAt === null) this.firstTokenAt = at
      if (typeof msg.message.id === "string") this.ids.add(msg.message.id)
      const u = msg.message.usage
      if (u) {
        const n = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.output_tokens) ?? 0)
        if (n > 0) this.contextTokens = n
      }
      if (this.stepStart === null) this.stepStart = this.lastToolEnd ?? this.readyAt ?? this.startedAt
      this.stepLast = at
      for (const b of msg.message.content) {
        if (b?.type === "tool_use" && typeof b.id === "string") this.open.set(b.id, { name: toolName(b.name), at })
      }
      return
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== "tool_result") continue
        const call = this.open.get(b.tool_use_id)
        if (!call) continue
        this.closeModel()
        this.open.delete(b.tool_use_id)
        this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
        this.toolSpans.push([call.at, at])
        this.lastToolEnd = at
      }
      return
    }
    if (msg.type === "result") {
      this.resultAt = at
      this.result = msg
      this.closeModel()
    }
  }

  private push(step: TurnStep) {
    if (this.steps.length < TURN_TIMING_MAX_STEPS) this.steps.push(step)
    else this.dropped++
  }

  private closeModel() {
    if (this.stepStart === null || this.stepLast === null) return
    this.push({ k: "model", at: this.stepStart - this.startedAt, ms: Math.max(0, this.stepLast - this.stepStart) })
    this.stepStart = null
    this.stepLast = null
  }

  /** The run ended (the process exited at `at`): what it measured. Tool calls still open count until then. */
  finish(ok: boolean, at = Date.now()): TurnClockReading {
    this.closeModel()
    for (const call of this.open.values()) {
      this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
      this.toolSpans.push([call.at, at])
    }
    this.open.clear()
    const r = this.result
    const u = (r?.usage ?? {}) as Record<string, unknown>
    const steps = this.steps
    return {
      startedAt: this.startedAt,
      endedAt: at,
      startupMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      mcpStatus: this.mcpStatus,
      firstTokenMs: this.firstTokenAt === null ? null : this.firstTokenAt - (this.readyAt ?? this.startedAt),
      modelMs: steps.reduce((n, s) => (s.k === "model" ? n + s.ms : n), 0),
      toolMs: unionMs(this.toolSpans),
      modelCalls: this.ids.size || steps.filter((s) => s.k === "model").length,
      toolCalls: steps.filter((s) => s.k === "tool").length + this.dropped,
      tailMs: this.resultAt === null ? null : Math.max(0, at - this.resultAt),
      wallMs: Math.max(0, at - this.startedAt),
      cliMs: num(r?.duration_ms),
      apiMs: num(r?.duration_api_ms),
      numTurns: num(r?.num_turns),
      inputTokens: num(u.input_tokens) ?? 0,
      outputTokens: num(u.output_tokens) ?? 0,
      cacheReadTokens: num(u.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: num(u.cache_creation_input_tokens) ?? 0,
      contextTokens: this.contextTokens,
      ok,
      steps,
      stepsDropped: this.dropped,
    }
  }
}

/** Total length of a set of [start, end] spans, overlaps counted once. */
export function unionMs(spans: [number, number][]): number {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  for (const [a, b] of s) {
    if (b <= end) continue
    total += b - Math.max(a, end)
    end = b
  }
  return total
}

/** One MCP client's handshake with the server's /mcp endpoint. */
export interface McpHandshake {
  /** The first request of the connection (initialize, or the CLI's server/discover probe before it). */
  firstAt: number
  initializeAt: number | null
  /** tools/list answered. */
  readyAt: number | null
}

/**
 * The MCP handshakes /mcp saw, by caller ("coordinator", "captain:<projectId>"), so a Coordinator or Captain turn can
 * split its start-up into the process start and the MCP connect. Only the latest handshake per caller is kept.
 */
export class McpHandshakes {
  private readonly latest = new Map<string, McpHandshake>()

  /** A request to /mcp from `caller` began (at) and was answered (doneAt). `methods`: its JSON-RPC methods. */
  saw(caller: string, methods: string[], at: number, doneAt: number) {
    const cur = this.latest.get(caller)
    if (methods.includes("initialize") || methods.includes("server/discover")) {
      // A new connection, unless this initialize follows its own discover probe.
      if (!cur || cur.readyAt !== null || at - cur.firstAt > 30_000) this.latest.set(caller, { firstAt: at, initializeAt: null, readyAt: null })
      if (methods.includes("initialize")) this.latest.get(caller)!.initializeAt ??= at
    }
    if (methods.includes("tools/list")) {
      const h = this.latest.get(caller)
      if (h && h.readyAt === null) h.readyAt = doneAt
    }
  }

  /** The handshake of a CLI spawned at `spawnedAt` that was ready by `readyBy`, or null when none falls between. */
  since(caller: string, spawnedAt: number, readyBy: number): McpHandshake | null {
    const h = this.latest.get(caller)
    return h && h.firstAt >= spawnedAt && h.firstAt <= readyBy ? h : null
  }
}

/** processMs and mcpMs from a handshake, or nulls. */
export function handshakeStages(h: McpHandshake | null, spawnedAt: number): { processMs: number | null; mcpMs: number | null } {
  if (!h) return { processMs: null, mcpMs: null }
  return { processMs: h.firstAt - spawnedAt, mcpMs: h.readyAt === null ? null : h.readyAt - h.firstAt }
}

/** Who ran a run and why, for its timing row. */
export interface TimingContext {
  id: string
  role: TurnTiming["role"]
  kind: string
  projectId?: string | null
  taskId?: string | null
  sessionId: string | null
  model: string | null
  effort: string | null
  trigger?: string | null
  resumed: boolean
  requestedAt?: number | null
  /** A task's launch (server clock), and the launch → spawn time. */
  launchedAt?: number | null
  setupMs?: number | null
  handshake?: McpHandshake | null
  processMs?: number | null
  mcpMs?: number | null
  /** When the server saw the run end, if later than the reading's end (a task's turn_end, read at the next poll). */
  seenAt?: number | null
}

/** A run's timing row: the clock's reading plus the server's side of it. */
export function turnTiming(r: TurnClockReading, ctx: TimingContext): TurnTiming {
  const begin = ctx.launchedAt ?? r.startedAt
  const requestedAt = typeof ctx.requestedAt === "number" && ctx.requestedAt <= begin ? ctx.requestedAt : null
  const shake = ctx.handshake !== undefined ? handshakeStages(ctx.handshake, r.startedAt) : { processMs: ctx.processMs ?? null, mcpMs: ctx.mcpMs ?? null }
  return {
    ...r,
    id: ctx.id,
    role: ctx.role,
    kind: ctx.kind,
    projectId: ctx.projectId ?? null,
    taskId: ctx.taskId ?? null,
    sessionId: ctx.sessionId,
    model: ctx.model,
    effort: ctx.effort,
    trigger: ctx.trigger ?? null,
    resumed: ctx.resumed,
    requestedAt,
    queueMs: requestedAt === null ? null : begin - requestedAt,
    setupMs: ctx.setupMs ?? null,
    ...shake,
    totalMs: Math.max(0, Math.max(r.endedAt, ctx.seenAt ?? 0) - (requestedAt ?? begin)),
  }
}
