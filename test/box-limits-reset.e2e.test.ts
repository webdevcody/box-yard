import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { SettingsInfo } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

// Agents and task folders per box follow each box's size unless set on purpose. A saved value can be
// forgotten on its own (DELETE /api/agent-settings?keys=…), and pool_status reports the limits per size.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
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
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  delete process.env.BOX_SLOTS
  delete process.env.BOX_MAX_RESIDENT
  for (const c of closers.splice(0)) await c()
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function send(r: Running, method: string, path: string, body?: unknown) {
  const res = await fetch(r.base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as SettingsInfo & { error?: string } }
}
const settings = async (r: Running, method = "GET", path = "/api/agent-settings", body?: unknown) => {
  const res = await send(r, method, path, body)
  if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(res.data)}`)
  return res.data
}

async function poolStatus(r: Running) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, { kind: "coordinator" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  closers.push(async () => (await client.close(), await mcp.close()))
  const res = (await client.callTool({ name: "pool_status", arguments: {} })) as { content: { text: string }[] }
  return JSON.parse(res.content[0]!.text).pool
}

describe("resetting single settings", () => {
  it("forgets only the named keys, so the size defaults apply to them again", async () => {
    const r = await start()
    const saved = await settings(r, "PUT", "/api/agent-settings", { slotsPerBox: 2, maxResidentPerBox: 6, maxBoxes: 4 })
    expect(saved.sources).toMatchObject({ slotsPerBox: "ui", maxResidentPerBox: "ui", maxBoxes: "ui" })
    expect(r.yard.tasks.sizeLimits("small")).toEqual({ slotsPerBox: 2, maxResidentPerBox: 6 })

    const one = await settings(r, "DELETE", "/api/agent-settings?keys=slotsPerBox")
    expect(one.sources).toMatchObject({ slotsPerBox: "default", maxResidentPerBox: "ui", maxBoxes: "ui" })
    expect(one.settings).toMatchObject({ slotsPerBox: 1, maxResidentPerBox: 6, maxBoxes: 4 })
    expect(r.yard.tasks.sizeLimits("small")).toEqual({ slotsPerBox: 1, maxResidentPerBox: 6 })
    expect(r.yard.tasks.sizeLimits("medium").slotsPerBox).toBe(2)
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(4)

    // Comma lists and repeated keys both work; resetting an unsaved key is harmless.
    const both = await settings(r, "DELETE", "/api/agent-settings?keys=maxResidentPerBox,slotsPerBox&keys=maxBoxes")
    expect(both.sources).toMatchObject({ slotsPerBox: "default", maxResidentPerBox: "default", maxBoxes: "default" })
    expect(r.yard.settings.boxLimitOverrides()).toEqual({ slotsPerBox: null, maxResidentPerBox: null })
  })

  it("rejects unknown or missing keys and keeps every saved value", async () => {
    const r = await start()
    await settings(r, "PUT", "/api/agent-settings", { slotsPerBox: 2 })
    const unknown = await send(r, "DELETE", "/api/agent-settings?keys=slotsPerBox,agentsPerBox")
    expect(unknown.status).toBe(400)
    expect(unknown.data.error).toContain("Unknown setting: agentsPerBox")
    expect((await send(r, "DELETE", "/api/agent-settings?keys=__proto__")).status).toBe(400)
    // An empty list must not fall back to "reset everything".
    expect((await send(r, "DELETE", "/api/agent-settings?keys=")).status).toBe(400)
    expect((await settings(r)).sources.slotsPerBox).toBe("ui")
  })

  it("hands a reset value back to BOX_SLOTS when it is set", async () => {
    process.env.BOX_SLOTS = "2"
    const r = await start({ slotsPerBox: 2 })
    expect((await settings(r)).sources.slotsPerBox).toBe("env")
    await settings(r, "PUT", "/api/agent-settings", { slotsPerBox: 3 })
    expect(r.yard.settings.boxLimitInfo().slotsPerBox).toEqual({ value: 3, source: "ui" })

    const reset = await settings(r, "DELETE", "/api/agent-settings?keys=slotsPerBox")
    expect(reset.sources.slotsPerBox).toBe("env")
    expect(reset.settings.slotsPerBox).toBe(2)
    expect(r.yard.settings.boxLimitInfo().slotsPerBox).toEqual({ value: 2, source: "env" })
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(2)
  })
})

describe("pool_status", () => {
  it("reports agents and task folders per box for each size, and what overrides them", async () => {
    const r = await start()
    expect(await poolStatus(r)).toMatchObject({
      agentsPerBox: { small: 1, medium: 2, large: 4 },
      tasksPerBox: { small: 3, medium: 8, large: 18 },
      overridden: { agentsPerBox: null, tasksPerBox: null },
      boxes: 0,
      agentsRunning: 0,
    })

    await settings(r, "PUT", "/api/agent-settings", { slotsPerBox: 2 })
    process.env.BOX_MAX_RESIDENT = "5"
    const pool = await poolStatus(r)
    expect(pool.agentsPerBox).toEqual({ small: 2, medium: 2, large: 2 })
    expect(pool.overridden).toEqual({ agentsPerBox: "saved in Settings › Boxes & limits", tasksPerBox: "BOX_MAX_RESIDENT env var" })
  })

  it("names a config value off the size default as the override", async () => {
    const r = await start({ slotsPerBox: 2 })
    const pool = await poolStatus(r)
    expect(pool.agentsPerBox).toEqual({ small: 2, medium: 2, large: 2 })
    expect(pool.overridden.agentsPerBox).toBe("server config")
  })
})
