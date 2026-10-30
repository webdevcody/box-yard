import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { McpHandshakes, TurnClock, timingReport, turnTiming, unionMs } from "../server/turnTimings.js"
import { formatMs, quantiles, summarizeTimings, TURN_TIMING_MAX_STEPS, type TurnClockReading, type TurnTiming } from "../shared/turnTimings.js"

const T0 = 1_700_000_000_000

/** A resumed Captain turn as the CLI streams it: init, a reply with two parallel tool calls, a second step, the result. */
function captainRun(): [number, unknown][] {
  return [
    [310, { type: "system", subtype: "init", session_id: "s1", mcp_servers: [{ name: "boxyard", status: "connected" }] }],
    [320, { type: "system", subtype: "status", status: "requesting" }],
    [2100, { type: "stream_event", event: { type: "message_start" } }],
    [2140, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking" } } }],
    [
      2900,
      {
        type: "assistant",
        message: { id: "msg_1", model: "claude", content: [{ type: "text", text: "Checking" }], usage: { input_tokens: 4, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 2_000, output_tokens: 80 } },
      },
    ],
    [3000, { type: "assistant", message: { id: "msg_1", model: "claude", content: [{ type: "tool_use", id: "t1", name: "mcp__boxyard__list_tasks", input: {} }] } }],
    [3010, { type: "assistant", message: { id: "msg_1", model: "claude", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } }],
    // A subagent's lines belong to their Task call, not to this turn's steps.
    [3050, { type: "assistant", parent_tool_use_id: "t9", message: { id: "msg_sub", content: [{ type: "tool_use", id: "s1", name: "Read" }] } }],
    [3200, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] } }],
    [3800, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }],
    [
      5600,
      {
        type: "assistant",
        message: { id: "msg_2", model: "claude", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 2, cache_read_input_tokens: 62_000, cache_creation_input_tokens: 500, output_tokens: 40 } },
      },
    ],
    [
      5620,
      {
        type: "result",
        duration_ms: 5300,
        duration_api_ms: 4100,
        num_turns: 2,
        usage: { input_tokens: 6, output_tokens: 120, cache_read_input_tokens: 122_000, cache_creation_input_tokens: 2_500 },
      },
    ],
  ]
}

function read(clock: { line(msg: unknown, at?: number): void; finish(ok: boolean, at?: number): TurnClockReading }, lines: [number, unknown][], end: number) {
  for (const [at, msg] of lines) clock.line(msg, T0 + at)
  return clock.finish(true, T0 + end)
}

/** The runner's copy of TurnClock, run from its source (runner/box-runner.mjs is one file copied to boxes). */
function runnerClock(): new (startedAt: number) => { line(msg: unknown, at?: number): void; finish(ok: boolean, at?: number): TurnClockReading } {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../runner/box-runner.mjs"), "utf8")
  const start = src.indexOf("// TurnClock: a copy of server/turnTimings.ts")
  const end = src.indexOf("// end TurnClock")
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`${src.slice(start, end)}\nreturn TurnClock`)()
}

describe("TurnClock", () => {
  it("splits a run into start-up, first token, model steps, tool calls and the tail", () => {
    const r = read(new TurnClock(T0), captainRun(), 6400)
    expect(r).toMatchObject({
      startupMs: 310,
      mcpStatus: "boxyard: connected",
      firstTokenMs: 2140 - 310,
      modelCalls: 2,
      toolCalls: 2,
      tailMs: 780,
      wallMs: 6400,
      cliMs: 5300,
      apiMs: 4100,
      numTurns: 2,
      inputTokens: 6,
      outputTokens: 120,
      cacheReadTokens: 122_000,
      cacheWriteTokens: 2_500,
      contextTokens: 2 + 62_000 + 500 + 40,
      ok: true,
      stepsDropped: 0,
    })
    expect(r.steps).toEqual([
      { k: "model", at: 310, ms: 3010 - 310 },
      { k: "tool", name: "list_tasks", at: 3000, ms: 200 },
      { k: "tool", name: "Bash", at: 3010, ms: 790 },
      { k: "model", at: 3800, ms: 1800 },
    ])
    // The two calls overlapped: 3000 → 3800 once.
    expect(r.toolMs).toBe(800)
    expect(r.modelMs).toBe(2700 + 1800)
  })

  it("times the first token from the first reply when the run streams no partials, and closes open tools at the end", () => {
    const lines = captainRun().filter(([, m]) => (m as { type: string }).type !== "stream_event")
    const cut = lines.filter(([at]) => at < 3200)
    const r = read(new TurnClock(T0), cut, 4000)
    expect(r.firstTokenMs).toBe(2900 - 310)
    expect(r.tailMs).toBeNull()
    expect(r.steps.filter((s) => s.k === "tool")).toEqual([
      { k: "tool", name: "list_tasks", at: 3000, ms: 1000 },
      { k: "tool", name: "Bash", at: 3010, ms: 990 },
    ])
  })

  it("keeps at most TURN_TIMING_MAX_STEPS steps and counts the rest", () => {
    const c = new TurnClock(T0)
    c.line({ type: "system", subtype: "init" }, T0 + 100)
    for (let i = 0; i < TURN_TIMING_MAX_STEPS; i++) {
      c.line({ type: "assistant", message: { id: `m${i}`, content: [{ type: "tool_use", id: `t${i}`, name: "Read" }] } }, T0 + 200 + i * 10)
      c.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}` }] } }, T0 + 205 + i * 10)
    }
    const r = c.finish(true, T0 + 10_000)
    expect(r.steps).toHaveLength(TURN_TIMING_MAX_STEPS)
    expect(r.stepsDropped).toBe(TURN_TIMING_MAX_STEPS)
    expect(r.toolCalls).toBe(TURN_TIMING_MAX_STEPS)
  })

  it("has a twin in the box runner that reads the same stream the same way", () => {
    const Runner = runnerClock()
    const runs: [number, unknown][][] = [captainRun(), captainRun().filter(([at]) => at < 3200), [[400, { type: "system", subtype: "init" }]]]
    for (const lines of runs) expect(read(new Runner(T0), lines, 6400)).toEqual(read(new TurnClock(T0), lines, 6400))
  })
})

describe("timing helpers", () => {
  it("unions overlapping spans", () => {
    expect(unionMs([])).toBe(0)
    expect(
      unionMs([
        [0, 10],
        [5, 20],
        [30, 40],
        [32, 35],
      ]),
    ).toBe(30)
  })

  it("takes nearest-rank percentiles", () => {
    expect(quantiles([])).toBeNull()
    expect(quantiles([null, 5, undefined])).toEqual({ n: 1, p50: 5, p95: 5, max: 5 })
    const q = quantiles(Array.from({ length: 100 }, (_, i) => 100 - i))!
    expect(q).toEqual({ n: 100, p50: 50, p95: 95, max: 100 })
  })

  it("formats durations", () => {
    expect(formatMs(null)).toBe("–")
    expect(formatMs(820)).toBe("820 ms")
    expect(formatMs(4_240)).toBe("4.2 s")
    expect(formatMs(42_000)).toBe("42 s")
    expect(formatMs(185_000)).toBe("3 min 05 s")
  })

  it("matches a CLI to the MCP handshake it made", () => {
    const h = new McpHandshakes()
    h.saw("coordinator", ["server/discover"], T0 + 260, T0 + 262)
    h.saw("coordinator", ["initialize"], T0 + 265, T0 + 270)
    h.saw("coordinator", ["notifications/initialized"], T0 + 271, T0 + 272)
    h.saw("coordinator", ["tools/list"], T0 + 275, T0 + 290)
    expect(h.since("coordinator", T0, T0 + 310)).toEqual({ firstAt: T0 + 260, initializeAt: T0 + 265, readyAt: T0 + 290 })
    // Not this run's: before its spawn, or another caller's.
    expect(h.since("coordinator", T0 + 300, T0 + 900)).toBeNull()
    expect(h.since("captain:prj_a", T0, T0 + 310)).toBeNull()
    // The next CLI's handshake replaces it.
    h.saw("coordinator", ["initialize"], T0 + 5000, T0 + 5004)
    expect(h.since("coordinator", T0 + 4800, T0 + 5100)).toMatchObject({ firstAt: T0 + 5000, readyAt: null })
  })

  it("adds the server's side: queue, setup, the handshake split and the total", () => {
    const reading = read(new TurnClock(T0), captainRun(), 6400)
    const t = turnTiming(reading, {
      id: "tim_1",
      role: "captain",
      kind: "turn",
      projectId: "prj_a",
      sessionId: "s1",
      model: "claude",
      effort: "medium",
      trigger: "coordinator",
      resumed: true,
      requestedAt: T0 - 4_000,
      handshake: { firstAt: T0 + 260, initializeAt: T0 + 265, readyAt: T0 + 290 },
    })
    expect(t).toMatchObject({ queueMs: 4_000, processMs: 260, mcpMs: 30, totalMs: 10_400, setupMs: null })
    // A request time after the start is a clock mix-up, not a negative queue.
    expect(turnTiming(reading, { id: "x", role: "task", kind: "turn", sessionId: null, model: null, effort: null, resumed: false, requestedAt: T0 + 1 }).queueMs).toBeNull()
    // A task: queued until its launch, then set up on the box; the total runs to when the server saw the end.
    const task = turnTiming(reading, {
      id: "tim_2",
      role: "task",
      kind: "turn",
      sessionId: null,
      model: null,
      effort: null,
      resumed: false,
      requestedAt: T0 - 9_000,
      launchedAt: T0 - 3_000,
      setupMs: 3_000,
      processMs: 250,
      mcpMs: 40,
      seenAt: T0 + 7_000,
    })
    expect(task).toMatchObject({ queueMs: 6_000, setupMs: 3_000, processMs: 250, mcpMs: 40, totalMs: 16_000 })
  })

  it("summarizes per role and stage, and keeps hidden rows out of the tools and the recent list", () => {
    const reading = read(new TurnClock(T0), captainRun(), 6400)
    const row = (id: string, role: TurnTiming["role"], projectId: string | null, endedAt: number): TurnTiming => ({
      ...turnTiming({ ...reading, endedAt }, { id, role, kind: "turn", projectId, sessionId: null, model: null, effort: null, resumed: false }),
    })
    const rows = [row("a", "captain", "prj_a", T0 + 9), row("b", "captain", "prj_secret", T0 + 8), row("c", "coordinator", null, T0 + 7)]
    const s = summarizeTimings(rows, T0)
    expect(s.turns).toBe(3)
    expect(s.byRole.captain).toMatchObject({ turns: 2, stages: { startupMs: { n: 2, p50: 310 } } })
    expect(s.byRole.captain!.cacheReadShare).toBeCloseTo(122_000 / (6 + 122_000 + 2_500), 3)
    expect(s.tools.map((x) => x.name)).toEqual(["Bash", "list_tasks"])
    const rep = timingReport(() => rows, { recent: 5, hidden: (t) => t.projectId === "prj_secret" }, T0)
    expect(rep.summary.byRole.captain!.turns).toBe(2)
    expect(rep.recent.map((r) => r.id)).toEqual(["a", "c"])
    expect(rep.hiddenTurns).toBe(1)
    expect(rep.summary.tools.find((x) => x.name === "Bash")!.n).toBe(2)
    expect(rep.recent[0]).toMatchObject({ slowestTool: { name: "Bash", ms: 790 }, tokens: { cacheRead: 122_000 } })
  })
})
