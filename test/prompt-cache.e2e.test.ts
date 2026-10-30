import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { withPromptCacheTtl } from "../server/turnCredentials.js"
import { resultUsageObject } from "../server/usage.js"
import { TurnClock } from "../server/turnTimings.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { CaptainMessage, ChatMessage, Project } from "../shared/types.js"
import type { TurnTiming } from "../shared/turnTimings.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Settings › 1-hour prompt cache: Coordinator and Captain runs ask the CLI for a 1-hour cache TTL (on by default),
// and the usage Box Yard keeps says how the cache writes split between 5 minutes and 1 hour.

describe("withPromptCacheTtl", () => {
  it("on: sets the 1h vars and drops FORCE_PROMPT_CACHING_5M, which would beat them", () => {
    const env = withPromptCacheTtl({ FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", PATH: "/bin" }, true)
    expect(env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", ENABLE_PROMPT_CACHING_1H: "1", PATH: "/bin" })
  })

  it("off: asks for 5 minutes, even on a subscription that defaults to 1 hour", () => {
    const env = withPromptCacheTtl({ ENABLE_PROMPT_CACHING_1H: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, false)
    expect(env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })
  })

  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.promptCache1h).toBe(true)
  })
})

describe("cache write split", () => {
  const usage = { input_tokens: 3, cache_creation_input_tokens: 900, cache_read_input_tokens: 50_000, output_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 } }

  it("resultUsageObject keeps the 5m / 1h split for claude_usage.raw_usage_json", () => {
    expect(resultUsageObject(usage)).toEqual(usage)
    // Older CLIs report no split: nothing is made up.
    const { cache_creation: _, ...old } = usage
    expect(resultUsageObject(old)).toEqual(old)
    expect(resultUsageObject({ input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } })).toBeNull()
  })

  it("a turn's timing counts its 1h cache writes", () => {
    const clock = new TurnClock(1_000)
    clock.line({ type: "system", subtype: "init" }, 1_100)
    clock.line({ type: "result", usage }, 2_000)
    const t = clock.finish(true, 2_100)
    expect(t.cacheWriteTokens).toBe(900)
    expect(t.cacheWrite1hTokens).toBe(900)
  })
})

describe("prompt cache TTL on Coordinator and Captain runs", () => {
  let server: Server | null = null
  let yard: BoxYard | null = null
  const saved = { ...process.env }
  afterEach(async () => {
    for (const k of ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_CACHE_WRITE", "FORCE_PROMPT_CACHING_5M", "ENABLE_PROMPT_CACHING_1H", "CLAUDE_CODE_PROMPT_CACHE_TTL"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    // A Coordinator turn must be over before the server stops.
    if (yard) await waitFor(() => !yard!.orchestrator.busy, "Coordinator idle", 30_000).catch(() => {})
    yard?.stop()
    if (server) await new Promise((res) => server!.close(() => res(null)))
    server = null
    yard = null
  })

  async function roundTrip(settings: Record<string, unknown>) {
    const log = path.join(tmpDir(), "fake-claude.log")
    process.env.FAKE_CLAUDE_LOG = log
    process.env.FAKE_CLAUDE_CACHE_WRITE = "700"
    const port = await freePort()
    yard = createBoxYard(testConfig({ port, orchestratorAutoWake: false }), { webDir: "/nonexistent" })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    const base = `http://127.0.0.1:${port}`
    const call = async <T>(method: string, p: string, body?: unknown) => {
      const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
      return data as T
    }
    if (Object.keys(settings).length) await call("PUT", "/api/agent-settings", settings)
    const p = await call<Project>("POST", "/api/projects", { name: "demo" })
    await call("POST", "/api/chat", { content: "tell captain demo: status" })
    const captainReply = await waitFor(
      async () => (await call<CaptainMessage[]>("GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "assistant" && m.meta?.timingId),
      "the Captain's reply",
    )
    await waitFor(async () => !(await call<{ busy: boolean }>("GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
    await waitFor(async () => !(await call<{ busy: boolean }>("GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)
    const reply = await waitFor(() => yard!.store.listChat(100).find((m: ChatMessage) => m.role === "assistant" && m.meta?.timingId), "the Coordinator's reply")
    const runs = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; cacheTtl: string })
    const usage = yard.store.db.prepare("SELECT source, raw_usage_json FROM claude_usage ORDER BY started_at").all() as { source: string; raw_usage_json: string }[]
    const timings = await Promise.all([reply.meta!.timingId, captainReply.meta!.timingId].map((id) => call<TurnTiming>("GET", `/api/turn-timings/${id}`)))
    return { runs, usage, timings, project: p }
  }

  it("asks for a 1-hour cache by default, over a FORCE_PROMPT_CACHING_5M in the server's env, and records the 1h writes", async () => {
    process.env.FORCE_PROMPT_CACHING_5M = "1"
    const { runs, usage, timings } = await roundTrip({})
    const captainRuns = runs.filter((r) => r.args.join(" ").includes("You are the Box Yard Captain"))
    expect(captainRuns.length).toBeGreaterThan(0)
    expect(runs.length).toBeGreaterThan(captainRuns.length) // the Coordinator ran too
    expect(runs.map((r) => r.cacheTtl)).toEqual(runs.map(() => "1h"))

    const sources = new Set(usage.map((u) => u.source))
    expect(sources).toEqual(new Set(["orchestrator", "captain"]))
    for (const u of usage) expect(JSON.parse(u.raw_usage_json).cache_creation).toEqual({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 })
    for (const t of timings) expect(t).toMatchObject({ cacheWriteTokens: 700, cacheWrite1hTokens: 700 })
  })

  it("asks for 5 minutes when the setting is off, over ENABLE_PROMPT_CACHING_1H in the server's env", async () => {
    process.env.ENABLE_PROMPT_CACHING_1H = "1"
    const { runs, usage, timings } = await roundTrip({ promptCache1h: false })
    expect(runs.length).toBeGreaterThan(1)
    expect(runs.map((r) => r.cacheTtl)).toEqual(runs.map(() => "5m"))
    for (const u of usage) expect(JSON.parse(u.raw_usage_json).cache_creation).toEqual({ ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 0 })
    for (const t of timings) expect(t).toMatchObject({ cacheWriteTokens: 700, cacheWrite1hTokens: 0 })
  })
})
