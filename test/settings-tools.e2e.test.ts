import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { SettingChange, SettingView } from "../server/settingsTools.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_RUNPOD_SETTINGS } from "../shared/runpod.js"
import { DEFAULT_VAST_SETTINGS } from "../shared/vast.js"
import type { HubEvent, Project, SettingsInfo } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

// The Coordinator's get_settings / update_settings: every Settings value with its default, range and source,
// secrets only as set / not set, and a checked patch saved all or nothing through the Settings UI's own save path.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  events: HubEvent[]
}
const running: Running[] = []
const closers: (() => Promise<void>)[] = []

// testConfig's slotsPerBox 2 / maxResidentPerBox 12 count as overrides; these are the small size's defaults.
const SIZE_DEFAULTED: Partial<Config> = { workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 3 }

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const dataDir = tmpDir()
  const yard = createBoxYard(testConfig({ port, dataDir, ...SIZE_DEFAULTED, ...overrides }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const events: HubEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (e: HubEvent) => (events.push(e), broadcast(e))
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir, events }
  running.push(r)
  return r
}

afterEach(async () => {
  delete process.env.BOX_POOL_MAX
  for (const c of closers.splice(0)) await c()
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function api<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller = { kind: "coordinator" }) {
  const y = r.yard
  const deps = {
    store: y.store,
    tasks: y.tasks,
    hub: y.hub,
    artifacts: null as never,
    publicUrl: () => "",
    scheduler: y.scheduler,
    captains: y.captains,
    settings: y.settings,
    settingsTools: y.settingsTools,
    uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024),
  }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  closers.push(async () => (await client.close(), await mcp.close()))
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  return { client, call }
}

const rows = async (call: (n: string, a?: Record<string, unknown>) => Promise<ToolRes>, group?: string) => {
  const res = await call("get_settings", group ? { group } : {})
  expect(res.isError).toBeFalsy()
  const list = (JSON.parse(res.content[0]!.text) as { settings: SettingView[] }).settings
  return Object.fromEntries(list.map((s) => [s.key, s]))
}
const update = async (call: (n: string, a?: Record<string, unknown>) => Promise<ToolRes>, patch: Record<string, unknown>, reason = "Cody asked for it") =>
  call("update_settings", { patch, reason })
const changed = (res: ToolRes) => (JSON.parse(res.content[0]!.text) as { changed: SettingChange[] }).changed
const settingsNotices = (r: Running) => r.yard.store.listChat().filter((m) => m.role === "notice" && m.meta?.kind === "settings")

describe("get_settings", () => {
  it("lists every setting with its value, default, allowed values and source", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    const all = await rows(call)
    for (const k of Object.keys(DEFAULT_SETTINGS)) expect(all[k], k).toBeDefined()
    for (const k of Object.keys(DEFAULT_RUNPOD_SETTINGS)) expect(all[`runpod.${k}`], k).toBeDefined()
    expect(all.slotsPerBox).toMatchObject({ group: "settings", value: 1, default: 1, allowed: "integer 1–20", source: "default", envVar: "BOX_SLOTS", writable: true })
    expect(all.workerSize).toMatchObject({ value: "small", allowed: "one of: small, medium, large" })
    expect(all.startInZen).toMatchObject({ allowed: "true or false" })
    expect(all.orchestratorAutoCompact.allowed).toContain("token count")
    expect(all["runpod.maxHourlyUsd"]).toMatchObject({ value: 1, default: 1, allowed: "number 0–100", writable: true })
    expect(all["runpod.gpuTypes"].allowed).toMatch(/^list of 1–10 of text/)
    expect(all["voice.provider"]).toMatchObject({ value: "browser", writable: true })
    expect(all.runner).toMatchObject({ value: "box", allowed: "one of: box, local, docker", writable: true })
    expect(all["server.timezone"]).toMatchObject({ envVar: "BOXYARD_TIMEZONE", envLocked: true, writable: false })

    // A group filter returns only that group.
    expect(Object.values(await rows(call, "runpod")).every((s) => s.group === "runpod")).toBe(true)
  })

  it("lists Settings › Vast.ai GPU as vast.*, and saves them through its own store", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    const all = await rows(call)
    for (const k of Object.keys(DEFAULT_VAST_SETTINGS)) expect(all[`vast.${k}`], k).toBeDefined()
    expect(all["vast.defaultForGpu"]).toMatchObject({ group: "vast", value: false, writable: true })
    expect(all["credentials.vastApiKey"]).toMatchObject({ value: "not set", secret: true, envVar: "VAST_API_KEY" })
    expect(changed(await update(call, { "vast.totalMaxHourlyUsd": 2 }))).toEqual([{ key: "vast.totalMaxHourlyUsd", before: 3, after: 2 }])
    expect(r.yard.settingsTools.list("vast").find((s) => s.key === "vast.totalMaxHourlyUsd")?.value).toBe(2)
  })

  it("shows API keys and tokens only as set / not set", async () => {
    const r = await start()
    const token = "ghp_supersecretvalue123456"
    const ttsKey = "sk-openai-secret-987654321"
    await api(r, "PUT", "/api/setup/credentials", { githubToken: token })
    await api(r, "PUT", "/api/tts/settings", { openaiApiKey: ttsKey })
    const { call } = await mcpAs(r)
    const res = await call("get_settings")
    expect(res.content[0]!.text).not.toContain(token)
    expect(res.content[0]!.text).not.toContain(ttsKey)
    const all = await rows(call)
    expect(all["credentials.githubToken"]).toMatchObject({ value: "set", secret: true, writable: false, envVar: "GITHUB_TOKEN" })
    expect(all["credentials.upstashBoxApiKey"]).toMatchObject({ value: "not set", secret: true })
    expect(all["voice.openaiApiKey"]).toMatchObject({ value: "set", secret: true, writable: false })
    expect(all["voice.elevenlabsApiKey"]).toMatchObject({ value: "not set", secret: true })
  })

  it("names the env var that seeds a value, which a save still overrides (as in the Settings UI)", async () => {
    process.env.BOX_POOL_MAX = "4"
    const r = await start({ maxBoxes: 4 })
    const { call } = await mcpAs(r)
    expect((await rows(call)).maxBoxes).toMatchObject({ value: 4, source: "env", envVar: "BOX_POOL_MAX", writable: true })
    expect(changed(await update(call, { maxBoxes: 6 }))).toEqual([{ key: "maxBoxes", before: 4, after: 6 }])
    expect((await rows(call)).maxBoxes).toMatchObject({ value: 6, source: "ui" })
  })
})

describe("update_settings", () => {
  it("saves through the Settings UI's path and returns before → after for each change", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    const res = await update(call, { slotsPerBox: 3, maxBoxes: 20, "runpod.maxHourlyUsd": 2, budget: { dailyUsd: 5 }, voice: { openai: { speed: 1.25 } } }, "Cody asked for more capacity")
    expect(res.isError).toBeFalsy()
    expect(changed(res)).toEqual(
      expect.arrayContaining([
        { key: "slotsPerBox", before: 1, after: 3 },
        { key: "maxBoxes", before: 2, after: 20 },
        { key: "runpod.maxHourlyUsd", before: 1, after: 2 },
        { key: "budget.dailyUsd", before: 10, after: 5 },
        { key: "voice.openai.speed", before: 1, after: 1.25 },
      ]),
    )
    expect(changed(res)).toHaveLength(5)

    // What the Settings UI reads back, and what the pool uses, right away.
    const info = await api<SettingsInfo>(r, "GET", "/api/agent-settings")
    expect(info.settings).toMatchObject({ slotsPerBox: 3, maxBoxes: 20, budget: { dailyUsd: 5, monthlyUsd: 0 } })
    expect(info.sources).toMatchObject({ slotsPerBox: "ui", maxBoxes: "ui", budget: "ui" })
    expect(r.yard.tasks.sizeLimits("small").slotsPerBox).toBe(3)
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(3)
    expect(r.yard.settingsTools.list("runpod").find((s) => s.key === "runpod.maxHourlyUsd")?.value).toBe(2)
    expect(r.yard.ttsSettings.get().openai.speed).toBe(1.25)
    // The same side effects as a save in the UI: open Settings dialogs and the Boxes page refresh.
    expect(r.events.some((e) => e.type === "settings")).toBe(true)
    expect(r.events.some((e) => e.type === "tts")).toBe(true)
    expect(r.events.some((e) => e.type === "boxes")).toBe(true)
  })

  it("tells Cody in a notice what changed, before → after, and why", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    await update(call, { maxBoxes: 7, agentEffort: "max" }, "Cody wants more boxes")
    const notices = settingsNotices(r)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toBe("⚙️ **Settings** changed by the Coordinator: maxBoxes 2 → 7, agentEffort high → max. Reason: Cody wants more boxes")
    expect(notices[0]!.meta).toMatchObject({ kind: "settings", reason: "Cody wants more boxes", changes: [{ key: "maxBoxes", before: 2, after: 7 }, { key: "agentEffort", before: "high", after: "max" }] })
    // It reached the browser like any notice.
    expect(r.events.some((e) => e.type === "chat.message" && e.message.id === notices[0]!.id)).toBe(true)

    // A patch that changes nothing saves nothing and says so.
    const same = await update(call, { maxBoxes: 7 })
    expect(changed(same)).toEqual([])
    expect(settingsNotices(r)).toHaveLength(1)
  })

  it("reports derived changes: a new worker size moves the size-default box limits", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    const diff = changed(await update(call, { workerSize: "large" }))
    expect(diff).toEqual(
      expect.arrayContaining([
        { key: "workerSize", before: "small", after: "large" },
        { key: "slotsPerBox", before: 1, after: 4 },
      ]),
    )
  })

  it("changes where new projects run through the setup's save", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    expect(changed(await update(call, { runner: "local" }))).toEqual([{ key: "runner", before: "box", after: "local" }])
    expect(r.yard.setup.runnerChoice()).toBe("local")
    expect(r.events.some((e) => e.type === "setup")).toBe(true)
  })

  it("rejects unknown keys, out-of-range values and env-only keys, and then changes nothing", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    const before = await api<SettingsInfo>(r, "GET", "/api/agent-settings")
    const res = await update(call, {
      maxBoxes: 9, // valid on its own: must not be applied either
      agentsPerBox: 3,
      slotsPerBox: 50,
      "runpod.maxHourlyUsd": -1,
      workerSize: "huge",
      "server.timezone": "Europe/Paris",
      "server.maxUploadMb": 100,
    })
    expect(res.isError).toBe(true)
    const text = res.content[0]!.text
    expect(text).toMatch(/^Nothing was changed\. 6 problems:/)
    expect(text).toContain("agentsPerBox: unknown setting")
    expect(text).toMatch(/slotsPerBox: .*\(allowed: integer 1–20\)/)
    expect(text).toMatch(/runpod\.maxHourlyUsd: .*\(allowed: number 0–100\)/)
    expect(text).toMatch(/workerSize: .*\(allowed: one of: small, medium, large\)/)
    expect(text).toContain("server.timezone: set by the BOXYARD_TIMEZONE env var on the server, so it can't be changed here")
    expect(text).toContain("server.maxUploadMb: set by the BOXYARD_MAX_UPLOAD_MB env var")

    const after = await api<SettingsInfo>(r, "GET", "/api/agent-settings")
    expect(after).toEqual(before)
    expect(r.yard.settingsTools.list("runpod").find((s) => s.key === "runpod.maxHourlyUsd")?.value).toBe(1)
    expect(settingsNotices(r)).toHaveLength(0)
  })

  it("refuses to write API keys and tokens, however they're named", async () => {
    const r = await start()
    const { call } = await mcpAs(r)
    for (const patch of [{ githubToken: "ghp_x12345678" }, { "credentials.upstashBoxApiKey": "abcdefgh123" }, { voice: { openaiApiKey: "sk-12345678" } }, { "voice.elevenlabsApiKey": "xi-12345678" }, { somePassword: "hunter22" }]) {
      const res = await update(call, { ...patch, maxBoxes: 9 })
      expect(res.isError, JSON.stringify(patch)).toBe(true)
      expect(res.content[0]!.text).toContain("API keys, tokens and passwords can't be read or written with these tools")
    }
    expect(r.yard.settings.credentials.secrets().githubToken).toBeFalsy()
    expect(r.yard.ttsSettings.info().keys.openai.state).toBe("unset")
    expect(r.yard.settings.get().maxBoxes).toBe(2)
  })
})

describe("scope", () => {
  it("gives Captains neither tool, and update_settings refuses a Captain server-side", async () => {
    const r = await start()
    const p = await api<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const names = (await captain.client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain("update_settings")
    expect(names).not.toContain("get_settings")
    const res = await update(captain.call, { maxBoxes: 9 })
    expect(res.isError).toBe(true)
    expect(r.yard.settings.get().maxBoxes).toBe(2)

    const coordinator = await mcpAs(r)
    const all = (await coordinator.client.listTools()).tools.map((t) => t.name)
    expect(all).toEqual(expect.arrayContaining(["get_settings", "update_settings"]))
  })
})
