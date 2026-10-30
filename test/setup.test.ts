import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, makeProvider, type BoxYard } from "../server/app.js"
import { CredentialStore, redact } from "../server/credentials.js"
import { AutoProvider } from "../server/providers/auto.js"
import { LocalProvider } from "../server/providers/local.js"
import { providerOf, type BoxProvider } from "../server/providers/types.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import type { Config } from "../server/config.js"
import type { CredentialTest, SetupStatus } from "../shared/setup.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir } from "./helpers.js"

const BOX_KEY = "box_key_secret_0123456789"
const OAUTH = "sk-ant-oat01-secret-oauth-token-abcdef"
const API_KEY = "sk-ant-api03-secret-api-key-123456"
const GH = "github_pat_11SECRETSECRETSECRET_abcdef"
const ENV_GH = "ghp_envtokenSECRET0123456789abcd"
const SECRETS = [BOX_KEY, OAUTH, API_KEY, GH, ENV_GH]

const dirs: string[] = []
const dir = (prefix: string) => {
  const d = tmpDir(prefix)
  dirs.push(d)
  return d
}

/** fake-claude under a name that doesn't say so, so the server treats it as the real CLI (not mock mode). */
function standInClaude() {
  const link = path.join(dir("box-yard-claude-"), "claude-stand-in.mjs")
  fs.symlinkSync(path.resolve("scripts/fake-claude.mjs"), link)
  return `${process.execPath} ${link}`
}

/** A real (non-mock) run with nothing configured. */
const firstRun = (overrides: Partial<Config> = {}) => testConfig({ mock: false, claudeBin: standInClaude(), boxProvider: "", ...overrides })

let server: Server | null = null
let yard: BoxYard | null = null
afterEach(async () => {
  yard?.stop()
  if (server) await new Promise((res) => server!.close(() => res(null)))
  server = null
  yard = null
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function boot(c: Config, opts: Parameters<typeof createBoxYard>[1] = {}) {
  dirs.push(c.dataDir)
  yard = createBoxYard(c, { webDir: "/nonexistent", ...opts })
  server = await new Promise<Server>((resolve) => {
    const s = yard!.app.listen(c.port, "127.0.0.1", () => resolve(s))
  })
  const base = `http://127.0.0.1:${c.port}`
  const call = (method: string, p: string, body?: unknown) =>
    globalThis.fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const json = async <T,>(method: string, p: string, body?: unknown) => {
    const res = await call(method, p, body)
    return { status: res.status, body: (await res.json()) as T }
  }
  return { call, json }
}

describe("GET /api/setup", () => {
  it("lists what's missing on a first run, and nothing in mock mode", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }))
    const { body } = await json<SetupStatus>("GET", "/api/setup")
    expect(body.ready).toBe(false)
    expect(body.mock).toBe(false)
    expect(body.missing).toEqual(["a choice of where agents run", "Claude sign-in"])
    expect(body.credentials).toEqual({
      upstashBoxApiKey: { state: "unset", source: null },
      claudeOauthToken: { state: "unset", source: null },
      anthropicApiKey: { state: "unset", source: null },
      githubToken: { state: "unset", source: null },
      runpodApiKey: { state: "unset", source: null },
      vastApiKey: { state: "unset", source: null },
    })
    expect(body.boxes).toEqual({ provider: "local", required: true })
    expect(body.claude).toEqual({ required: true, state: "unset", using: null })
    expect(body.github).toEqual({ state: "unset" })
    expect(body.owner).toEqual({ name: "Cody", source: "default" })
    expect(body.restart).toEqual([])
  })

  it("is ready in mock mode with nothing set", async () => {
    const { json } = await boot(testConfig({ port: await freePort() }))
    const { body } = await json<SetupStatus>("GET", "/api/setup")
    expect(body).toMatchObject({ ready: true, mock: true, missing: [], boxes: { required: false }, claude: { required: false } })
  })

  it("doesn't need a box key when BOX_PROVIDER=local, and says a saved one needs a restart to matter", async () => {
    const { json } = await boot(firstRun({ port: await freePort(), boxProvider: "local" }))
    expect((await json<SetupStatus>("GET", "/api/setup")).body.missing).toEqual(["Claude sign-in"])
    const saved = await json<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY, anthropicApiKey: API_KEY })
    expect(saved.body.ready).toBe(true)
    expect(saved.body.boxes).toEqual({ provider: "local", required: false })
    expect(saved.body.restart).toEqual([expect.stringContaining("BOX_PROVIDER=local")])
  })
})

describe("saving credentials", () => {
  it("an env var wins and can't be changed in the app; saved values can be replaced and removed", async () => {
    const { json } = await boot(firstRun({ port: await freePort(), githubToken: ENV_GH }))
    let { body } = await json<SetupStatus>("GET", "/api/setup")
    expect(body.credentials.githubToken).toEqual({ state: "set", source: "env" })

    const refused = await json<{ error: string }>("PUT", "/api/setup/credentials", { githubToken: GH })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe("GITHUB_TOKEN is set on the server, and it always wins. Change it there.")
    expect((await json<{ error: string }>("PUT", "/api/setup/credentials", { githubToken: null })).status).toBe(400)
    expect(yard!.settings.credentials.get("githubToken")).toBe(ENV_GH)

    ;({ body } = await json<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY, claudeOauthToken: OAUTH }))
    expect(body.ready).toBe(true)
    expect(body.credentials.upstashBoxApiKey).toEqual({ state: "set", source: "saved" })
    expect(body.claude).toEqual({ required: true, state: "set", using: "claudeOauthToken" })
    expect(yard!.settings.credentials.get("claudeOauthToken")).toBe(OAUTH)

    // Replace, then remove. With both Claude credentials set, Claude Code uses the API key.
    ;({ body } = await json<SetupStatus>("PUT", "/api/setup/credentials", { anthropicApiKey: API_KEY }))
    expect(body.claude.using).toBe("anthropicApiKey")
    ;({ body } = await json<SetupStatus>("PUT", "/api/setup/credentials", { claudeOauthToken: "sk-ant-oat01-a-new-one-123", anthropicApiKey: null }))
    expect(body.claude.using).toBe("claudeOauthToken")
    expect(yard!.settings.credentials.get("claudeOauthToken")).toBe("sk-ant-oat01-a-new-one-123")
    expect(body.credentials.anthropicApiKey).toEqual({ state: "unset", source: null })
  })

  it("rejects bad values and unknown keys", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }))
    expect((await json<{ error: string }>("PUT", "/api/setup/credentials", { githubToken: "short" })).body.error).toMatch(/too short/)
    expect((await json<{ error: string }>("PUT", "/api/setup/credentials", { githubToken: "has a space in it" })).body.error).toMatch(/no spaces/)
    expect((await json<{ error: string }>("PUT", "/api/setup/credentials", { password: "hunter2hunter2" })).status).toBe(400)
  })

  it("saved values survive a restart; the env still wins over them", async () => {
    const c = firstRun({ port: await freePort() })
    const { json } = await boot(c)
    await json("PUT", "/api/setup/credentials", { githubToken: GH })
    yard!.stop()
    await new Promise((res) => server!.close(() => res(null)))
    server = null
    const db = openDb(c.dataDir)
    const store = new Store(db)
    expect(new CredentialStore(store, c).get("githubToken")).toBe(GH)
    const env = new CredentialStore(store, { ...c, githubToken: ENV_GH })
    expect(env.get("githubToken")).toBe(ENV_GH)
    expect(env.source("githubToken")).toBe("env")
    db.close()
  })

  it("broadcasts the new status, and /api/health stops asking for what's now saved", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }))
    const events: string[] = []
    const orig = yard!.hub.broadcast.bind(yard!.hub)
    yard!.hub.broadcast = (ev) => {
      events.push(JSON.stringify(ev))
      orig(ev)
    }
    const before = await json<{ problems: string[] }>("GET", "/api/health")
    expect(before.body.problems.join("\n")).toMatch(/Claude isn't signed in/)
    expect(before.body.problems.join("\n")).toMatch(/No GitHub token/)
    await json("PUT", "/api/setup/credentials", { claudeOauthToken: OAUTH, githubToken: GH })
    const after = await json<{ problems: string[] }>("GET", "/api/health")
    expect(after.body.problems.join("\n")).not.toMatch(/Claude isn't signed in|No GitHub token/)
    expect(events.some((e) => e.includes('"type":"setup"') && e.includes('"ready":false'))).toBe(true)
  })
})

describe("secrets", () => {
  it("never appear in a response, an SSE event or a log line", async () => {
    const logged: string[] = []
    for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")))
    const { call, json } = await boot(firstRun({ port: await freePort(), githubToken: ENV_GH }), {
      setup: { listBoxes: async (k) => Promise.reject(Object.assign(new Error(`bad key ${k}`), { statusCode: 401 })), fetch: async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 }) },
    })
    const events: string[] = []
    const orig = yard!.hub.broadcast.bind(yard!.hub)
    yard!.hub.broadcast = (ev) => {
      events.push(JSON.stringify(ev))
      orig(ev)
    }
    const texts = [await (await call("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY, claudeOauthToken: OAUTH, anthropicApiKey: API_KEY })).text()]
    for (const p of ["/api/setup", "/api/settings", "/api/agent-settings", "/api/health", "/api/tts/settings", "/api/boxes"]) texts.push(await (await call("GET", p)).text())
    texts.push(await (await call("POST", "/api/setup/test/upstashBoxApiKey", {})).text())
    texts.push(await (await call("POST", "/api/setup/test/anthropicApiKey", { value: "sk-ant-api03-typed-but-not-saved-99" })).text())
    // A rejected save echoes nothing back either.
    texts.push(await (await call("PUT", "/api/setup/credentials", { githubToken: GH })).text())
    const all = [...texts, ...events, ...logged].join("\n")
    for (const s of [...SECRETS, "sk-ant-api03-typed-but-not-saved-99"]) expect(all).not.toContain(s)
    expect(texts[7]).toContain("[redacted]")
  })

  it("redact() hides known secrets and anything shaped like a token", () => {
    expect(redact(`key ${BOX_KEY} and ${BOX_KEY}x`, [BOX_KEY])).toBe("key [redacted] and [redacted]x")
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer [redacted]")
    expect(redact("token sk-ant-oat01-zzzzzzzzzzzz leaked")).toBe("token [redacted] leaked")
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_abcdefghijklmnopqrstuv")).toBe("[redacted] and [redacted]")
    // Short values aren't treated as secrets (they'd mangle ordinary text).
    expect(redact("abc abc", ["abc"])).toBe("abc abc")
  })
})

describe("POST /api/setup/test/:key", () => {
  const test = async (json: Awaited<ReturnType<typeof boot>>["json"], key: string, value?: string) =>
    (await json<CredentialTest>("POST", `/api/setup/test/${key}`, value === undefined ? {} : { value })).body

  it("Upstash: lists boxes with the key, and shows the exact error, redacted", async () => {
    const seen: string[] = []
    const { json } = await boot(firstRun({ port: await freePort() }), {
      setup: {
        listBoxes: async (k) => {
          seen.push(k)
          if (k === BOX_KEY) return [{ status: "running" }, { status: "deleted" }, { status: "paused" }]
          throw Object.assign(new Error(`Unauthorized: invalid API key ${k}`), { statusCode: 401 })
        },
      },
    })
    expect(await test(json, "upstashBoxApiKey")).toMatchObject({ ok: false, message: "Nothing to test yet: paste the Upstash Box API key first." })
    expect(await test(json, "upstashBoxApiKey", BOX_KEY)).toMatchObject({ ok: true, message: "Works: Upstash accepted the key and listed 2 boxes on the account." })
    const bad = await test(json, "upstashBoxApiKey", "wrong_key_1234567890")
    expect(bad.ok).toBe(false)
    expect(bad.message).toBe("Upstash rejected the key (HTTP 401): Unauthorized: invalid API key [redacted]")
    // Testing a typed value doesn't save it.
    expect((await json<SetupStatus>("GET", "/api/setup")).body.credentials.upstashBoxApiKey.state).toBe("unset")
    expect(seen).toEqual([BOX_KEY, "wrong_key_1234567890"])
  })

  it("Upstash: a network failure or a hang is reported plainly", async () => {
    let mode: "down" | "hang" = "down"
    const { json } = await boot(firstRun({ port: await freePort() }), {
      setup: {
        timeoutMs: 200,
        listBoxes: (): Promise<{ status?: string }[]> =>
          mode === "down" ? Promise.reject(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })) : new Promise(() => {}),
      },
    })
    expect((await test(json, "upstashBoxApiKey", BOX_KEY)).message).toBe("Can't reach Upstash: ENOTFOUND")
    mode = "hang"
    expect((await test(json, "upstashBoxApiKey", BOX_KEY)).message).toBe("Upstash didn't answer within 0 s.")
  })

  it("Anthropic API key: GET /v1/models, with the API's own error", async () => {
    const calls: { url: string; key: string | null }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key")
      calls.push({ url: String(url), key })
      if (key === API_KEY) return new Response('{"data":[]}', { status: 200 })
      return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401, statusText: "Unauthorized" })
    }) as typeof globalThis.fetch
    const { json } = await boot(firstRun({ port: await freePort() }), { setup: { fetch, anthropicBaseUrl: "http://anthropic.test/" } })
    expect(await test(json, "anthropicApiKey", API_KEY)).toMatchObject({ ok: true, message: "Works: the Anthropic API accepted the key." })
    expect(await test(json, "anthropicApiKey", "sk-ant-api03-nope-nope-nope")).toMatchObject({ ok: false, message: "The Anthropic API rejected the key (HTTP 401): invalid x-api-key" })
    expect(calls[0]!.url).toBe("http://anthropic.test/v1/models?limit=1")
  })

  it("GitHub: GET /user, naming the account and a classic token's scopes", async () => {
    const fetch = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization")
      if (String(url) !== "https://api.github.com/user") return new Response("[]")
      if (auth === `Bearer ${GH}`) return new Response('{"login":"cody"}', { status: 200 })
      if (auth === `Bearer ${ENV_GH}`) return new Response('{"login":"cody"}', { status: 200, headers: { "x-oauth-scopes": "read:user, gist" } })
      return new Response('{"message":"Bad credentials"}', { status: 401, statusText: "Unauthorized" })
    }) as typeof globalThis.fetch
    const { json } = await boot(firstRun({ port: await freePort() }), { github: { fetch, token: () => null } })
    expect(await test(json, "githubToken", GH)).toMatchObject({ ok: true, message: "Works: signed in to GitHub as @cody." })
    expect((await test(json, "githubToken", ENV_GH)).message).toBe("Works: signed in to GitHub as @cody. Classic token scopes: read:user, gist (agents need repo).")
    expect(await test(json, "githubToken", "ghp_wrongwrongwrongwrongwrong")).toMatchObject({ ok: false, message: "GitHub rejected the token (HTTP 401): Bad credentials" })
  })

  it("Claude subscription token: one tiny `claude` call logged in with only that token", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }))
    expect(await test(json, "claudeOauthToken", OAUTH)).toMatchObject({ ok: true, message: "Works: Claude answered using this token." })
    const bad = await test(json, "claudeOauthToken", "sk-ant-oat01-revoked-token-0000")
    expect(bad).toMatchObject({ ok: false, message: "Claude said: Invalid API key · Please run /login" })
  })

  it("unknown keys and bad typed values are a 400", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }))
    expect((await json("POST", "/api/setup/test/password", {})).status).toBe(400)
    expect((await json<{ error: string }>("POST", "/api/setup/test/githubToken", { value: "a b c d e f g h" })).body.error).toMatch(/no spaces/)
  })
})

describe("GET /api/setup/repos", () => {
  /** GitHub's /user/repos, newest push first, answering only to `token`. */
  const github = (token: string, seen: string[] = []) =>
    (async (url: string, init?: RequestInit) => {
      seen.push(String(url))
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return new Response('{"message":"Bad credentials"}', { status: 401 })
      return new Response(
        JSON.stringify([
          { full_name: "cody/box-yard", archived: false },
          { full_name: "cody/old-thing", archived: true },
          { full_name: "acme/site", archived: false },
          { full_name: "cody/dotfiles", archived: false },
          { full_name: "cody/fourth", archived: false },
        ]),
      )
    }) as typeof globalThis.fetch

  it("lists the token's most recently pushed repos (3, archived skipped), and never the token", async () => {
    const seen: string[] = []
    const { call, json } = await boot(firstRun({ port: await freePort() }), { github: { fetch: github(GH, seen), token: () => null } })
    expect((await json("GET", "/api/setup/repos")).body).toEqual({ repos: [] })
    expect(seen).toEqual([])
    await call("PUT", "/api/setup/credentials", { githubToken: GH })
    const res = await call("GET", "/api/setup/repos")
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ repos: ["cody/box-yard", "acme/site", "cody/dotfiles"] })
    expect(text).not.toContain(GH)
    expect(seen).toEqual(["https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=20"])
  })

  it("is empty, not an error, when GitHub refuses or can't be reached, and in mock mode", async () => {
    const { json } = await boot(firstRun({ port: await freePort(), githubToken: ENV_GH }), { github: { fetch: github(GH), token: () => null } })
    expect(await json("GET", "/api/setup/repos")).toEqual({ status: 200, body: { repos: [] } })
    yard!.stop()
    await new Promise((res) => server!.close(() => res(null)))
    const offline = (async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))) as typeof globalThis.fetch
    const second = await boot(firstRun({ port: await freePort(), githubToken: ENV_GH }), { github: { fetch: offline, token: () => null } })
    expect(await second.json("GET", "/api/setup/repos")).toEqual({ status: 200, body: { repos: [] } })
    yard!.stop()
    await new Promise((res) => server!.close(() => res(null)))
    const seen: string[] = []
    const mock = await boot(testConfig({ port: await freePort(), githubToken: GH }), { github: { fetch: github(GH, seen), token: () => null } })
    expect((await mock.json("GET", "/api/setup/repos")).body).toEqual({ repos: [] })
    expect(seen).toEqual([])
  })
})

describe("box provider", () => {
  it("new boxes move to Upstash once a key is saved, with no restart; each box stays with the provider that made it", async () => {
    const c = firstRun({ port: await freePort() })
    const { json } = await boot(c)
    expect((await json<{ provider: string }>("GET", "/api/health")).body.provider).toBe("local")
    const status = (await json<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY })).body
    expect(status.boxes.provider).toBe("upstash")
    expect((await json<{ provider: string }>("GET", "/api/health")).body.provider).toBe("upstash")
    expect((await json<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: null })).body.boxes.provider).toBe("local")
  })

  it("AutoProvider routes each box by its id, and makeProvider keeps env-configured setups as they were", () => {
    const local = new LocalProvider(dir("boxes-"), FAKE_CLAUDE)
    const upstash = { name: "upstash", nodeBin: "node", claudeBin: "claude", root: () => "/workspace/home" } as unknown as BoxProvider
    let on = false
    const auto = new AutoProvider(local, upstash, () => on)
    expect(auto.name).toBe("local")
    on = true
    expect(auto.name).toBe("upstash")
    expect(providerOf(auto, "local-abcd1234")).toBe(local)
    expect(providerOf(auto, "box_123")).toBe(upstash)
    expect(auto.root("box_123")).toBe("/workspace/home")
    expect(providerOf(local, "box_123")).toBe(local)

    const c = testConfig()
    dirs.push(c.dataDir)
    const db = openDb(c.dataDir)
    const creds = new CredentialStore(new Store(db), {})
    expect(makeProvider({ ...c, provider: "upstash", mock: false }, creds).name).toBe("upstash")
    expect(makeProvider({ ...c, mock: true }, creds)).toBeInstanceOf(LocalProvider)
    expect(makeProvider({ ...c, mock: false, boxProvider: "local" }, creds)).toBeInstanceOf(LocalProvider)
    expect(makeProvider({ ...c, mock: false, boxProvider: "" }, creds)).toBeInstanceOf(AutoProvider)
    expect(makeProvider({ ...c, mock: false, boxProvider: "" })).toBeInstanceOf(LocalProvider)
    db.close()
  })
})
