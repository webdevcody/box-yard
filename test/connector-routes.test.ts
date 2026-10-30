import { afterEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Connector, ConnectorSignIn } from "../shared/connectors.js"
import { fakeOAuth } from "./connectorFixtures.js"
import { freePort, testConfig } from "./helpers.js"

// Settings › Connectors' routes and the Coordinator's list_connectors (docs/connectors.md). Secrets go in through the
// API and never come back out: not in a response, an event, a tool result, the callback page or the server's log.

const PW = "correct horse battery staple"
const TOKEN = "lin_api_RouteTestSecretToken0123456789"

type ToolRes = { content: { text: string }[]; isError?: boolean }
const running: { yard: BoxYard; server: Server; close?: () => void }[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    r.close?.()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const fake = await fakeOAuth()
  const port = await freePort()
  const config = testConfig({ port, password: PW })
  // Everything the server logs, to check no secret is in it.
  const logged: string[] = []
  for (const level of ["log", "warn", "error", "info"] as const) {
    const orig = console[level]
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
      void orig
    })
  }
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const events: string[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (e) => {
    events.push(JSON.stringify(e))
    broadcast(e)
  }
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server, close: () => fake.close() })
  const base = `http://127.0.0.1:${port}`
  const cookie = (await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PW }) })).headers.get("set-cookie")!.split(";")[0]!
  const seen: string[] = []
  const raw = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${url}`, { method, headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" })
    const text = await res.text()
    seen.push(text)
    return { status: res.status, text, headers: res.headers, json: <T,>() => JSON.parse(text) as T }
  }
  const as = async (caller: McpCaller) => {
    const deps = { store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, publicUrl: () => "", scheduler: yard.scheduler, captains: yard.captains, settings: yard.settings, notes: yard.notes, uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024), identities: yard.identities, connectors: yard.connectors.store }
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as ToolRes
      const text = r.content.map((c) => c.text).join("\n")
      seen.push(text)
      return { ok: !r.isError, text, json: () => JSON.parse(text) }
    }
  }
  /** No secret anywhere a model, a browser or a log could see it. */
  const noSecrets = () => {
    const secrets = [TOKEN, ...fake.issued]
    for (const [where, texts] of [
      ["responses and tool results", seen],
      ["events", events],
      ["logs", logged],
    ] as const) {
      const all = texts.join("\n")
      for (const s of secrets) expect(all, `${where} hold a secret`).not.toContain(s)
    }
  }
  return { yard, fake, base, raw, as, noSecrets, events }
}

describe("connector routes", () => {
  it("adds, scopes, takes a token and tests a connector; every response holds fingerprints only", async () => {
    const r = await start()
    const app = r.yard.store.createProject({ name: "app", repo: "o/app" })
    expect((await fetch(`${r.base}/api/connectors`)).status).toBe(401)
    const made = await r.raw("POST", "/api/connectors", { name: "remote", label: "Remote", kind: "http", url: r.fake.mcpUrl, auth: "token" })
    expect(made.status, made.text).toBe(201)
    const c = made.json<Connector>()
    expect(c).toMatchObject({ status: "needs_auth", scope: { sessions: ["coordinator"] } })
    expect((await r.raw("PUT", `/api/connectors/${c.id}/token`, { value: TOKEN })).json<Connector>().secrets[0]).toMatchObject({ name: "token", readable: true })
    const tested = (await r.raw("POST", `/api/connectors/${c.id}/test`)).json<Connector>()
    // The fake only takes its own OAuth tokens.
    expect(tested.status).toBe("needs_auth")
    const scoped = await r.raw("PATCH", `/api/connectors/${c.id}`, { scope: { sessions: ["coordinator", "agent"], projects: [app.id], runners: ["local"] } })
    expect(scoped.json<Connector>().scope.projects).toEqual([app.id])
    expect((await r.raw("GET", "/api/connectors")).json<Connector[]>().map((x) => x.name)).toEqual(["remote"])
    expect(r.events.some((e) => e.includes('"type":"connectors"'))).toBe(true)
    expect((await r.raw("DELETE", `/api/connectors/${c.id}/token`)).json<Connector>().secrets).toEqual([])
    expect((await r.raw("DELETE", `/api/connectors/${c.id}`)).status).toBe(200)
    expect((await r.raw("GET", "/api/connectors")).json<Connector[]>()).toEqual([])
    r.noSecrets()
  })

  it("signs in through the public callback page, which shows no token and leaks no code", async () => {
    const r = await start()
    const c = (await r.raw("POST", "/api/connectors", { name: "remote", label: "Remote", kind: "http", url: r.fake.mcpUrl, auth: "oauth" })).json<Connector>()
    const started = await r.raw("POST", `/api/connectors/${c.id}/oauth/start`, {})
    expect(started.status, started.text).toBe(200)
    const s = started.json<ConnectorSignIn>()
    // Browsing at 127.0.0.1 is loopback: the provider comes back by itself.
    expect(s).toMatchObject({ mode: "redirect", redirectUri: `${r.base}/api/connectors/oauth/callback` })
    const back = await r.fake.authorize(s.authorizeUrl)
    // The callback needs no Box Yard login (Safari on an iPhone has none): the state is the gate.
    const page = await fetch(back)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain("Remote is connected.")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/)
    expect(html).not.toContain("<script")
    expect(html).not.toContain(new URL(back).searchParams.get("code")!)
    // Again: refused, and the page escapes what it shows.
    const again = await fetch(back)
    expect(again.status).toBe(400)
    expect(await again.text()).toMatch(/isn&#39;t one Box Yard started/)
    const evil = await fetch(`${r.base}/api/connectors/oauth/callback?state=x&error=%3Cscript%3Ealert(1)%3C/script%3E`)
    expect(await evil.text()).not.toContain("<script>alert")
    const after = (await r.raw("GET", "/api/connectors")).json<Connector[]>()[0]!
    expect(after.oauth).toMatchObject({ refreshable: true, signInHost: new URL(r.fake.issuer).host })
    await vi.waitFor(async () => expect((await r.raw("GET", "/api/connectors")).json<Connector[]>()[0]!.lastTest?.ok).toBe(true), { timeout: 10_000 })
    r.noSecrets()
  })

  it("paste-back finishes a sign-in begun from a phone on plain http", async () => {
    const r = await start()
    const c = (await r.raw("POST", "/api/connectors", { name: "remote", kind: "http", url: r.fake.mcpUrl, auth: "oauth" })).json<Connector>()
    const phone = "http://100.64.0.7:4000"
    // A sign-in only returns to an address the request came in on.
    expect((await r.raw("POST", `/api/connectors/${c.id}/oauth/start`, { origin: "https://evil.example" })).status).toBe(400)
    const s = (await r.raw("POST", `/api/connectors/${c.id}/oauth/start`, {}, { Origin: phone })).json<ConnectorSignIn>()
    expect(s.mode).toBe("paste")
    const back = await r.fake.authorize(s.authorizeUrl)
    const done = await r.raw("POST", "/api/connectors/oauth/complete", { url: back })
    expect(done.status, done.text).toBe(200)
    expect(done.json<Connector>().status).toBe("connected")
    expect((await r.raw("POST", `/api/connectors/${c.id}/sign-out`)).json<Connector>()).toMatchObject({ status: "needs_auth", secrets: [] })
    r.noSecrets()
  })

  it("list_connectors shows the Coordinator status and tools, a Captain only its project's, and never a secret", async () => {
    const r = await start()
    const app = r.yard.store.createProject({ name: "app", repo: "o/app" })
    const other = r.yard.store.createProject({ name: "other", repo: "o/other" })
    const mine = r.yard.connectors.store.create({ name: "linear", label: "Linear", kind: "http", url: "https://mcp.linear.app/mcp/s/abcdef-secret-path", auth: "token", scope: { sessions: ["captain", "agent"], projects: [app.id], runners: ["local", "docker"] } })
    r.yard.connectors.store.saveSecret(mine.id, "token", TOKEN)
    r.yard.connectors.store.create({ name: "notion", kind: "http", url: "https://mcp.notion.com/mcp", auth: "oauth", scope: { sessions: ["captain"], projects: [other.id], runners: ["local"] } })
    r.yard.connectors.store.create({ name: "coord", kind: "http", url: "https://x.example/mcp" })

    const coordinator = await r.as({ kind: "coordinator" })
    const all = (await coordinator("list_connectors")).json().connectors
    expect(all.map((x: { name: string }) => x.name)).toEqual(["coord", "linear", "notion"])
    const linear = all.find((x: { name: string }) => x.name === "linear")
    expect(linear).toMatchObject({ tools: "mcp__linear__*", server: "mcp.linear.app", status: "untested", reaches: "Captains, agents of app (agents on local, docker)" })
    expect(JSON.stringify(all)).not.toContain("abcdef-secret-path")

    const captain = await r.as({ kind: "captain", projectId: app.id })
    const theirs = (await captain("list_connectors")).json().connectors
    expect(theirs.map((x: { name: string }) => x.name)).toEqual(["linear"])
    expect(theirs[0]).toMatchObject({ yours: { captain: true, agents: ["local", "docker"] }, otherProjects: 0 })
    r.noSecrets()
  })
})
