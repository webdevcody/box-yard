import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { ConnectorService } from "../server/connectors/service.js"
import { ConnectorSignIns } from "../server/connectors/oauth.js"
import { redact } from "../server/credentials.js"
import { FAKE_MCP_STDIO, fakeOAuth } from "./connectorFixtures.js"
import { tmpDir } from "./helpers.js"

// Connectors (docs/connectors.md): the store keeps secrets sealed and views free of them, an edit that moves a
// connector forgets its secrets, scope decides who gets one, OAuth signs in by the spec (and refuses what it should),
// and Test lists tools over Streamable HTTP and stdio. All against fakes: no real provider or OAuth app.

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const f of cleanups.splice(0)) f()
})

const SECRET_TOKEN = "lin_api_SuperSecretToken1234567890"
const ENV_SECRET = "env-secret-value-0987654321"

function setup(o: { statusOnly?: string[]; fetch?: typeof fetch; port?: number } = {}) {
  const dir = tmpDir()
  const db = openDb(dir)
  const store = new Store(db)
  const secrets = new SecretBox({ dataDir: dir })
  const sealed = new Set<string>()
  let svc: ConnectorService
  const all = () => svc.store.secretValues()
  svc = new ConnectorService({
    db,
    secrets,
    statusOnly: (id) => sealed.has(id) || (o.statusOnly ?? []).includes(id),
    projectExists: (id) => Boolean(store.getProject(id)),
    projectName: (id) => store.getProject(id)?.name ?? null,
    port: o.port ?? 4000,
    redact: (t) => redact(t, all()),
    fetch: o.fetch,
  })
  const projects = { a: store.createProject({ name: "alpha", repo: "o/a" }), b: store.createProject({ name: "beta", repo: "o/b" }) }
  return { dir, db, store, svc, c: svc.store, projects, sealed }
}

describe("connector store", () => {
  it("validates names, addresses and shapes", () => {
    const { c } = setup()
    expect(() => c.create({ name: "boxyard", kind: "http", url: "https://x.example/mcp" })).toThrow(/Box Yard's own MCP server/)
    expect(() => c.create({ name: "Bad Name", kind: "http", url: "https://x.example/mcp" })).toThrow(/lowercase letters/)
    expect(() => c.create({ name: "plain", kind: "http", url: "http://mcp.example.com/mcp" })).toThrow(/must be https/)
    expect(() => c.create({ name: "creds", kind: "http", url: "https://u:p@mcp.example.com/mcp" })).toThrow(/user name or password/)
    expect(() => c.create({ name: "cmd", kind: "stdio" })).toThrow(/needs its command/)
    expect(() => c.create({ name: "cmd", kind: "stdio", command: "node", auth: "token" })).toThrow(/env var its token goes in/)
    expect(() => c.create({ name: "own", kind: "http", url: "https://x.example/mcp", auth: "oauth", oauth: { clientKind: "desktop" } })).toThrow(/client id/)
    expect(() => c.create({ name: "remote-env", kind: "http", url: "https://x.example/mcp", auth: "env" })).toThrow(/command connectors/)
    // Plain http only to this computer.
    expect(c.create({ name: "local", kind: "http", url: "http://127.0.0.1:9999/mcp" }).url).toBe("http://127.0.0.1:9999/mcp")
    const made = c.create({ name: "linear", label: "Linear", kind: "http", url: "https://mcp.linear.app/mcp", auth: "token" })
    expect(made).toMatchObject({ name: "linear", status: "needs_auth", scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } })
    expect(() => c.create({ name: "linear", kind: "http", url: "https://x.example/mcp" })).toThrow(/named linear already/)
    // Names that would share env vars or read as another server's tool.
    c.create({ name: "my-app", kind: "http", url: "https://x.example/mcp" })
    expect(() => c.create({ name: "my_app", kind: "http", url: "https://x.example/mcp" })).toThrow(/too like my-app/)
    expect(() => c.create({ name: "a__b", kind: "http", url: "https://x.example/mcp" })).toThrow(/can't hold __/)
  })

  it("seals secrets: the database and the views hold fingerprints only", () => {
    const { c, db, dir } = setup()
    const made = c.create({ name: "linear", kind: "http", url: "https://mcp.linear.app/mcp", auth: "token" })
    c.saveSecret(made.id, "token", SECRET_TOKEN)
    const view = c.require(made.id)
    expect(view.secrets).toEqual([expect.objectContaining({ name: "token", readable: true, fingerprint: createHash("sha256").update(SECRET_TOKEN).digest("hex").slice(0, 12) })])
    expect(JSON.stringify(c.list())).not.toContain(SECRET_TOKEN)
    const raw = JSON.stringify(db.prepare("SELECT * FROM connector_secrets").all())
    expect(raw).not.toContain(SECRET_TOKEN)
    expect(fs.readFileSync(path.join(dir, "box-yard.sqlite")).includes(Buffer.from(SECRET_TOKEN))).toBe(false)
    expect(c.secret(made.id, "token")).toBe(SECRET_TOKEN)
    expect(c.secretValues()).toContain(SECRET_TOKEN)
    // A secret the connector doesn't use is refused.
    expect(() => c.saveSecret(made.id, "env:FOO", "value-123456")).toThrow(/doesn't use a secret env var/)
    expect(() => c.saveSecret(made.id, "token", "two\nlines")).toThrow(/one line/)
  })

  it("forgets every secret when an edit sends it somewhere else, and keeps them for a label or scope edit", () => {
    const { c, projects } = setup()
    const made = c.create({ name: "linear", kind: "http", url: "https://mcp.linear.app/mcp", auth: "token" })
    c.saveSecret(made.id, "token", SECRET_TOKEN)
    c.update(made.id, { label: "Linear (work)", scope: { sessions: ["coordinator", "captain"], projects: [projects.a.id], runners: ["local"] } })
    expect(c.require(made.id).secrets.map((s) => s.name)).toEqual(["token"])
    c.update(made.id, { url: "https://evil.example/mcp" })
    const moved = c.require(made.id)
    expect(moved.secrets).toEqual([])
    expect(moved.status).toBe("needs_auth")
    // The old value stays on the redaction list for this process's life.
    expect(c.secretValues()).toContain(SECRET_TOKEN)

    const cmd = c.create({ name: "notes", kind: "stdio", command: "node", args: ["a.mjs"], auth: "env" })
    c.saveSecret(cmd.id, "env:API_KEY", ENV_SECRET)
    c.update(cmd.id, { env: { MODE: "x" } })
    expect(c.require(cmd.id).secrets.map((s) => s.name)).toEqual(["env:API_KEY"])
    c.update(cmd.id, { args: ["b.mjs"] })
    expect(c.require(cmd.id).secrets).toEqual([])
  })

  it("decides who gets a connector, and keeps Coordinator connectors away from status-only projects", () => {
    const { c, projects, sealed } = setup()
    const everyone = c.create({ name: "notion", kind: "http", url: "https://mcp.notion.com/mcp", scope: { sessions: ["coordinator", "captain", "agent"], projects: null, runners: ["local", "box"] } })
    const agentsOfA = c.create({ name: "linear", kind: "http", url: "https://mcp.linear.app/mcp", scope: { sessions: ["agent"], projects: [projects.a.id], runners: ["docker"] } })
    expect(c.reaches(everyone, { kind: "coordinator" })).toBe(true)
    expect(c.reaches(everyone, { kind: "agent", projectId: projects.b.id, runner: "box" })).toBe(true)
    expect(c.reaches(everyone, { kind: "agent", projectId: projects.b.id, runner: "gpu" })).toBe(false)
    expect(c.reaches(agentsOfA, { kind: "agent", projectId: projects.a.id, runner: "docker" })).toBe(true)
    expect(c.reaches(agentsOfA, { kind: "agent", projectId: projects.b.id, runner: "docker" })).toBe(false)
    expect(c.reaches(agentsOfA, { kind: "captain", projectId: projects.a.id })).toBe(false)
    expect(c.reaches(agentsOfA, { kind: "coordinator" })).toBe(false)

    // beta becomes status only: the Coordinator's connector stops reaching it, and says so; agents-only ones still do.
    sealed.add(projects.b.id)
    expect(c.reaches(c.require(everyone.id), { kind: "agent", projectId: projects.b.id, runner: "box" })).toBe(false)
    expect(c.reaches(c.require(everyone.id), { kind: "captain", projectId: projects.b.id })).toBe(false)
    expect(c.require(everyone.id).sealedSkipped).toEqual([projects.b.id])
    const agentsOfB = c.create({ name: "b-only", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: [projects.b.id], runners: ["local"] } })
    expect(c.reaches(agentsOfB, { kind: "agent", projectId: projects.b.id, runner: "local" })).toBe(true)
    // Choosing a sealed project for a connector the Coordinator uses is refused, with the reason.
    expect(() => c.update(agentsOfB.id, { scope: { sessions: ["coordinator", "agent"], projects: [projects.b.id], runners: ["local"] } })).toThrow(/beta shows the Coordinator status only/)
    expect(() => c.create({ name: "x", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: ["nope"], runners: ["local"] } })).toThrow(/no project nope/)
    expect(() => c.create({ name: "x", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: null, runners: [] } })).toThrow(/at least one runner/)
  })

  it("gives the box wall a key per connector set, empty when no connector reaches a project's box agents", () => {
    const { c, projects } = setup()
    expect(c.boxKey(projects.a.id)).toBe("")
    const local = c.create({ name: "local-only", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: null, runners: ["local"] } })
    expect(c.boxKey(projects.a.id)).toBe("")
    const box = c.create({ name: "box-a", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: [projects.a.id], runners: ["box"] } })
    const keyA = c.boxKey(projects.a.id)
    expect(keyA).toMatch(/^[0-9a-f]{12}$/)
    expect(c.boxKey(projects.b.id)).toBe("")
    c.update(box.id, { scope: { sessions: ["agent"], projects: null, runners: ["box"] } })
    expect(c.boxKey(projects.b.id)).toBe(keyA)
    c.update(box.id, { enabled: false })
    expect(c.boxKey(projects.a.id)).toBe("")
    void local
  })

  it("drops a deleted project from scopes", () => {
    const { c, projects, store } = setup()
    const made = c.create({ name: "x", kind: "http", url: "https://x.example/mcp", scope: { sessions: ["agent"], projects: [projects.a.id, projects.b.id], runners: ["local"] } })
    store.deleteProject(projects.a.id)
    c.projectDeleted(projects.a.id)
    expect(c.require(made.id).scope.projects).toEqual([projects.b.id])
  })
})

describe("connector OAuth", () => {
  async function signInSetup(opts: Parameters<typeof fakeOAuth>[0] = {}) {
    const fake = await fakeOAuth(opts)
    cleanups.push(() => fake.close())
    const s = setup()
    const made = s.c.create({ name: "remote", label: "Remote", kind: "http", url: fake.mcpUrl, auth: "oauth" })
    return { ...s, fake, made }
  }

  it("signs in by the spec: discovery, registration, PKCE, resource and iss, then lists the server's tools", async () => {
    const { svc, c, fake, made } = await signInSetup()
    const origin = "http://localhost:4000"
    const start = await svc.signIns.start(made.id, origin, [origin])
    expect(start).toMatchObject({ mode: "redirect", redirectUri: `${origin}/api/connectors/oauth/callback`, signInHost: new URL(fake.issuer).host })
    const q = new URL(start.authorizeUrl).searchParams
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("resource")).toBe(fake.mcpUrl)
    expect(q.get("scope")).toBe("read")
    expect(fake.state.registrations[0]).toMatchObject({ client_name: "Box Yard", redirect_uris: [start.redirectUri], token_endpoint_auth_method: "none", application_type: "native" })

    const back = await fake.authorize(start.authorizeUrl)
    const done = await svc.finishSignIn(new URL(back).searchParams)
    expect(done).toMatchObject({ status: "connected", oauth: { refreshable: true, grantedScopes: ["read"], redirectUri: start.redirectUri } })
    expect(done.secrets.map((x) => x.name).sort()).toEqual(["access_token", "refresh_token"])
    // Single use: the same callback again is refused.
    await expect(svc.signIns.finish(new URL(back).searchParams)).rejects.toThrow(/isn't one Box Yard started/)

    const tested = await svc.test(made.id)
    expect(tested.status).toBe("connected")
    expect(tested.lastTest).toMatchObject({ ok: true, tools: [{ name: "echo", description: "Echo the text back" }, { name: "whoami" }] })
    // No token in the views, and every token issued is on the redaction list.
    const views = JSON.stringify(c.list())
    for (const t of fake.issued) expect(views).not.toContain(t)
    const live = fake.issued.filter((t) => c.secretValues().includes(t))
    expect(live.length).toBe(2)
  })

  it("returns to this computer's loopback address for paste-back when Box Yard is on plain http elsewhere", async () => {
    const { svc, fake, made } = await signInSetup()
    const phone = "http://100.64.0.7:4000"
    const start = await svc.signIns.start(made.id, phone, [phone])
    expect(start.mode).toBe("paste")
    expect(start.redirectUri).toBe("http://127.0.0.1:4000/api/connectors/oauth/callback")
    expect(start.note).toMatch(/copy its address and paste it here/)
    const back = await fake.authorize(start.authorizeUrl)
    const done = await svc.finishSignIn(ConnectorSignIns.pasted(back))
    expect(done.status).toBe("connected")
  })

  it("never returns a sign-in to an address the request didn't come from", async () => {
    const { svc, made } = await signInSetup()
    await expect(svc.signIns.start(made.id, "https://evil.example", ["http://localhost:4000"])).rejects.toThrow(/isn't the address this request came in on/)
  })

  it("refuses a callback from another provider, an expired one, and one for a connector edited meanwhile", async () => {
    const { svc, c, fake, made } = await signInSetup()
    const origin = "http://localhost:4000"
    const s1 = await svc.signIns.start(made.id, origin, [origin])
    const back = new URL(await fake.authorize(s1.authorizeUrl))
    back.searchParams.set("iss", "https://evil.example")
    await expect(svc.signIns.finish(back.searchParams)).rejects.toThrow(/wrong provider/)
    back.searchParams.delete("iss")
    // Used up by the refused try, as a state always is.
    await expect(svc.signIns.finish(back.searchParams)).rejects.toThrow(/isn't one Box Yard started/)

    const s2 = await svc.signIns.start(made.id, origin, [origin])
    const back2 = new URL(await fake.authorize(s2.authorizeUrl))
    back2.searchParams.delete("iss")
    // The provider says it sends iss, so a callback without one is refused.
    await expect(svc.signIns.finish(back2.searchParams)).rejects.toThrow(/wrong provider/)

    const s3 = await svc.signIns.start(made.id, origin, [origin])
    const back3 = await fake.authorize(s3.authorizeUrl)
    c.update(made.id, { url: fake.mcpUrl.replace("/mcp", "/other") })
    await expect(svc.signIns.finish(new URL(back3).searchParams)).rejects.toThrow(/was changed while you were signing in/)

    // RFC 9728: the new address's metadata describes another resource (/mcp), so it won't sign in for it.
    await expect(svc.signIns.start(made.id, origin, [origin])).rejects.toThrow(/describes another resource/)
    expect(c.require(made.id).secrets).toEqual([])
  })

  it("refreshes a token running low once, however many sessions ask at the same time, and keeps the rotated one", async () => {
    const { svc, c, fake, made } = await signInSetup({ expiresIn: 600 })
    const origin = "http://localhost:4000"
    const start = await svc.signIns.start(made.id, origin, [origin])
    await svc.finishSignIn(new URL(await fake.authorize(start.authorizeUrl)).searchParams)
    const first = c.secret(made.id, "access_token")!
    const firstRefresh = c.secret(made.id, "refresh_token")!
    // 10 minutes left is under a session's 45: three sessions starting together share one refresh.
    const tokens = await Promise.all([svc.signIns.accessToken(made.id), svc.signIns.accessToken(made.id), svc.signIns.accessToken(made.id)])
    expect(fake.state.refreshCount).toBe(1)
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).not.toBe(first)
    expect(c.secret(made.id, "refresh_token")).not.toBe(firstRefresh)
    // A token with 10 minutes left is fine for a 2-minute test.
    expect(await svc.signIns.accessToken(made.id, 2 * 60_000)).toBe(tokens[0])
    expect(fake.state.refreshCount).toBe(1)
    // The replaced values stay redacted.
    expect(c.secretValues()).toEqual(expect.arrayContaining([first, firstRefresh]))
  })

  it("signs a connector out when the provider refuses its refresh token", async () => {
    const { svc, c, fake, made } = await signInSetup({ expiresIn: 60 })
    const origin = "http://localhost:4000"
    const start = await svc.signIns.start(made.id, origin, [origin])
    await svc.finishSignIn(new URL(await fake.authorize(start.authorizeUrl)).searchParams)
    fake.state.refuseRefresh = true
    expect(await svc.signIns.accessToken(made.id)).toBeNull()
    const after = c.require(made.id)
    expect(after.status).toBe("needs_auth")
    expect(after.statusDetail).toMatch(/refused to renew the sign-in \(invalid_grant\): sign in again/)
    expect(after.secrets).toEqual([])
  })

  it("signs in with Cody's own client at a configured issuer (Google's way), with its extra parameters", async () => {
    const fake = await fakeOAuth({ noRegistration: true, ownClient: { id: "own-client.apps.example", secret: "own-client-secret-123" } })
    cleanups.push(() => fake.close())
    const { svc, c } = setup()
    const made = c.create({ name: "gmail", kind: "stdio", command: "node", args: [FAKE_MCP_STDIO], auth: "oauth", tokenEnv: "GOOGLE_ACCESS_TOKEN", oauth: { clientKind: "desktop", clientId: "own-client.apps.example", issuer: fake.issuer, scopes: ["mail.read"], authParams: { access_type: "offline", prompt: "consent", client_id: "ignored" } } })
    expect(() => svc.saveSecret(made.id, "client_secret", "own-client-secret-123")).not.toThrow()
    const phone = "http://100.64.0.7:4000"
    const start = await svc.signIns.start(made.id, phone, [phone])
    // A Desktop client returns to loopback: paste-back from the phone.
    expect(start.mode).toBe("paste")
    const q = new URL(start.authorizeUrl).searchParams
    expect(q.get("client_id")).toBe("own-client.apps.example")
    expect(q.get("access_type")).toBe("offline")
    expect(q.get("prompt")).toBe("consent")
    expect(q.get("scope")).toBe("mail.read")
    expect(q.get("resource")).toBeNull()
    expect(fake.state.registrations).toEqual([])
    const done = await svc.finishSignIn(new URL(await fake.authorize(start.authorizeUrl)).searchParams)
    expect(done.status).toBe("connected")
    expect(JSON.stringify(c.list())).not.toContain("own-client-secret-123")
  })

  it("refuses providers that don't do PKCE, name another issuer, or put an endpoint on plain http", async () => {
    for (const [metadata, why] of [
      [{ code_challenge_methods_supported: undefined }, /PKCE/],
      [{ issuer: "https://someone-else.example" }, /names another issuer/],
      [{ token_endpoint: "http://tokens.example/token" }, /token endpoint must be https/],
    ] as const) {
      const fake = await fakeOAuth({ metadata })
      cleanups.push(() => fake.close())
      const { svc, c } = setup()
      const made = c.create({ name: "remote", kind: "http", url: fake.mcpUrl, auth: "oauth" })
      await expect(svc.signIns.start(made.id, "http://localhost:4000", ["http://localhost:4000"])).rejects.toThrow(why)
    }
  })

  it("a Web client needs Box Yard on https", async () => {
    const { svc, c } = setup()
    const made = c.create({ name: "slack", kind: "http", url: "https://mcp.slack.example/mcp", auth: "oauth", oauth: { clientKind: "web", clientId: "123.456", issuer: "https://slack.example" } })
    await expect(svc.signIns.start(made.id, "http://100.64.0.7:4000", ["http://100.64.0.7:4000"])).rejects.toThrow(/returns to an https address only/)
  })
})

describe("connector Test", () => {
  it("runs a command with its secret env var and nothing of Box Yard's env, and lists its tools", async () => {
    const { svc, c } = setup()
    process.env.BOXYARD_TEST_LEAK = "should-not-reach"
    cleanups.push(() => delete process.env.BOXYARD_TEST_LEAK)
    const made = c.create({ name: "notes", kind: "stdio", command: process.execPath, args: [FAKE_MCP_STDIO], env: { EXPECT_SHA256: createHash("sha256").update(ENV_SECRET).digest("hex") }, auth: "env" })
    // Without its secret it doesn't start.
    c.saveSecret(made.id, "env:FAKE_SECRET", "the-wrong-secret")
    const bad = await svc.test(made.id)
    expect(bad.status).toBe("error")
    expect(bad.lastTest?.error).toMatch(/FAKE_SECRET is wrong or missing/)
    c.saveSecret(made.id, "env:FAKE_SECRET", ENV_SECRET)
    const good = await svc.test(made.id)
    expect(good.status).toBe("connected")
    expect(good.lastTest?.tools.map((t) => t.name)).toEqual(["ping", "env_keys"])
    expect(JSON.stringify(good)).not.toContain(ENV_SECRET)
  })

  it("marks a remote connector needs_auth when the server turns its token down", async () => {
    const fake = await fakeOAuth()
    cleanups.push(() => fake.close())
    const { svc, c } = setup()
    const made = c.create({ name: "remote", kind: "http", url: fake.mcpUrl, auth: "token" })
    expect((await svc.test(made.id)).statusDetail).toBe("No token saved yet.")
    c.saveSecret(made.id, "token", SECRET_TOKEN)
    const t = await svc.test(made.id)
    expect(t.status).toBe("needs_auth")
    expect(t.statusDetail).toMatch(/turned the token down/)
    expect(JSON.stringify(t)).not.toContain(SECRET_TOKEN)
    // It went in the header the connector names.
    expect(fake.state.mcpAuthHeaders).toContain(`Bearer ${SECRET_TOKEN}`)
  })
})
