// Per-turn timings (table turn_timings): where the time of one Coordinator, Captain or task turn went, stage by stage.
// The server's TurnClock (server/turnTimings.ts) and the box runner's copy (runner/box-runner.mjs) read them off the
// CLI's stream-json, plus server-side timestamps. Pure, so the server, MCP and the UI's popover agree.

/** How far back turn timings are kept. */
export const TURN_TIMINGS_WINDOW_MS = 30 * 24 * 3_600_000
/** Steps kept per turn; the rest are counted in stepsDropped. */
export const TURN_TIMING_MAX_STEPS = 300

export type TurnRole = "coordinator" | "captain" | "task"
export const TURN_ROLES: TurnRole[] = ["coordinator", "captain", "task"]

/** One model step (an API call and the blocks it streamed) or one tool call, in the order they ran. */
export interface TurnStep {
  k: "model" | "tool"
  /** The tool's name (Box Yard's MCP tools without their mcp__boxyard__ prefix). */
  name?: string
  /** When it began, in ms after the CLI was spawned. */
  at: number
  ms: number
}

/** What the clock measured from one CLI run (TurnClock.finish). Every duration is in ms, null when not seen. */
export interface TurnClockReading {
  startedAt: number
  endedAt: number
  /** spawn → the CLI's `system/init` line: process start, session resume and load, MCP connect. */
  startupMs: number | null
  /** MCP connect as the CLI reported it: `init` names each server's status. */
  mcpStatus: string | null
  /** Ready (init) → the first streamed token, or the first assistant line when the run streams no partials. */
  firstTokenMs: number | null
  modelMs: number
  /** Wall time with at least one tool call running (parallel calls count once). */
  toolMs: number
  modelCalls: number
  toolCalls: number
  /** The `result` line → the process exiting: background shells holding the CLI open, teardown. */
  tailMs: number | null
  wallMs: number
  /** The CLI's own duration_ms and duration_api_ms. */
  cliMs: number | null
  apiMs: number | null
  numTurns: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Of those, written for 1 hour rather than 5 minutes (Settings › 1-hour prompt cache). Missing on older rows. */
  cacheWrite1hTokens?: number
  /** The context after the last API call (its prompt side plus what it wrote). */
  contextTokens: number | null
  ok: boolean
  steps: TurnStep[]
  stepsDropped: number
}

export interface TurnTiming extends TurnClockReading {
  id: string
  role: TurnRole
  /** turn, summary, compact or context (a compaction's passes are runs of their own). */
  kind: string
  projectId: string | null
  taskId: string | null
  sessionId: string | null
  model: string | null
  effort: string | null
  /** What started it: cody, coordinator, agent, hook, updates, schedule, system. */
  trigger: string | null
  resumed: boolean
  /** When it was asked for: the oldest message or update it answers. */
  requestedAt: number | null
  /** requestedAt → spawn (a task: → its launch). */
  queueMs: number | null
  /** A task's launch → the CLI's spawn: box wake, workspace, turn files, runner start, dependency restore. */
  setupMs: number | null
  /** spawn → the MCP server's first request (Node start, settings, the session file read). */
  processMs: number | null
  /** The MCP handshake as the server saw it: initialize → tools/list answered. */
  mcpMs: number | null
  /** requestedAt (else the launch, else spawn) → the end, as the server saw it. */
  totalMs: number
}

/** The stages the summary and the popover show, in the order they happen. */
export const TURN_STAGES = [
  { key: "queueMs", label: "Queue", hint: "Asked for → started: waiting for the previous turn, a wake debounce or a slot" },
  { key: "setupMs", label: "Setup", hint: "A task's launch → the CLI starting: box, workspace, turn files, runner" },
  { key: "startupMs", label: "Start-up", hint: "CLI spawn → ready: Node start, session resume and load, MCP connect" },
  { key: "processMs", label: "Process start", hint: "CLI spawn → its first MCP request" },
  { key: "mcpMs", label: "MCP connect", hint: "The MCP handshake: initialize → tools/list" },
  { key: "firstTokenMs", label: "First token", hint: "Ready → the first streamed token: prompt prefill and cache" },
  { key: "modelMs", label: "Model", hint: "Model steps: thinking and writing between tool calls" },
  { key: "toolMs", label: "Tools", hint: "Tool calls running" },
  { key: "tailMs", label: "Tail", hint: "The CLI's result → its exit" },
  { key: "wallMs", label: "CLI wall", hint: "CLI spawn → exit" },
  { key: "totalMs", label: "Total", hint: "Asked for → done" },
] as const

export type TurnStageKey = (typeof TURN_STAGES)[number]["key"]

export interface Quantiles {
  n: number
  p50: number
  p95: number
  max: number
}

/** Nearest-rank percentiles of a list, or null when it's empty. */
export function quantiles(values: (number | null | undefined)[]): Quantiles | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v[v.length - 1]! }
}

export interface TurnTimingSummary {
  since: number
  turns: number
  byRole: Partial<Record<TurnRole, { turns: number; stages: Partial<Record<TurnStageKey, Quantiles>>; modelStepMs: Quantiles | null; cacheReadShare: number | null }>>
  /** The tools that took the most time in all, with their per-call percentiles. */
  tools: (Quantiles & { name: string; totalMs: number })[]
}

/** p50/p95 per role and stage, the share of prompt tokens read from cache, and the slowest tools. */
export function summarizeTimings(rows: TurnTiming[], since: number, topTools = 12): TurnTimingSummary {
  const byRole: TurnTimingSummary["byRole"] = {}
  for (const role of TURN_ROLES) {
    const mine = rows.filter((r) => r.role === role)
    if (!mine.length) continue
    const stages: Partial<Record<TurnStageKey, Quantiles>> = {}
    for (const s of TURN_STAGES) {
      const q = quantiles(mine.map((r) => r[s.key]))
      if (q) stages[s.key] = q
    }
    const prompt = mine.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0)
    const read = mine.reduce((n, r) => n + r.cacheReadTokens, 0)
    byRole[role] = {
      turns: mine.length,
      stages,
      modelStepMs: quantiles(mine.flatMap((r) => r.steps.filter((s) => s.k === "model").map((s) => s.ms))),
      cacheReadShare: prompt > 0 ? Math.round((read / prompt) * 1000) / 1000 : null,
    }
  }
  const calls = new Map<string, number[]>()
  for (const r of rows) for (const s of r.steps) if (s.k === "tool") calls.set(s.name ?? "?", [...(calls.get(s.name ?? "?") ?? []), s.ms])
  const tools = [...calls]
    .map(([name, ms]) => ({ name, totalMs: ms.reduce((a, b) => a + b, 0), ...quantiles(ms)! }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topTools)
  return { since, turns: rows.length, byRole, tools }
}

/** "820 ms", "4.2 s", "3 min 05 s". */
export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "–"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`
}
