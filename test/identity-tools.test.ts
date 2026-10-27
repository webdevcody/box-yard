import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { IdentityDetector } from "../server/identity/detect.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities.js"
import { freePort, testConfig } from "./helpers.js"
import { TOKENS, computer, github } from "./identityFixtures.js"

// The identity MCP tools (docs/identities.md): detect, import by reference, create, change, assign and test, with a
// Captain limited to its own project. No tool result may hold a token or a private key.

type ToolRes = { content: { text: string }[]; isError?: boolean }

const running: { yard: BoxYard; server: Server }[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const pc = computer()
  const gh = github(pc.keys)
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch: gh.fetch, token: () => null } })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const detector = new IdentityDetector({ home: pc.home, env: pc.env, github: gh.fetch })
  const project = (name: string, repo: string | null, runner: "box" | "local" = "box") => yard.store.createProject({ name, repo, runner })
  const projects = { site: project("site", "https://github.com/octocat/site"), app: project("app", "acme-corp/app"), else: project("else", "someone/else") }
  /** Every tool result, to check that none holds a secret. */
  const seen: string[] = []
  const as = async (caller: McpCaller) => {
    const y = yard
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024), identities: y.identities, identityDetector: detector }
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
  const noSecrets = () => {
    const all = seen.join("\n")
    for (const secret of Object.values(TOKENS)) expect(all).not.toContain(secret)
    expect(all).not.toContain("PRIVATE KEY")
    for (const name of ["acme_signing", "id_ed25519"]) expect(all).not.toContain(fs.readFileSync(path.join(pc.home, ".ssh", name), "utf8").split("\n")[1]!)
  }
  return { yard, pc, gh, projects, as, noSecrets }
}

describe("identity tools, as the Coordinator", () => {
  it("detects online, imports octo-acme by reference with its token, author and signing key, moves app to it, and tests it", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const detected = await tool("detect_identities")
    expect(detected.ok).toBe(true)
    const d = detected.json()
    expect(d.proposals.map((p: { login: string; projects: { name: string }[] }) => [p.login, p.projects.map((x) => x.name)])).toEqual([
      ["octocat", ["site"]],
      ["octo-acme", ["app"]],
    ])
    expect(d.next).toMatch(/Tell Cody in one message/)
    // Detection changes nothing.
    expect(r.yard.identities.list().map((i) => i.name)).toEqual(["Default"])

    const imported = await tool("import_detected_identity", { login: "octo-acme", name: "Acme", require_signed: true })
    expect(imported.ok, imported.text).toBe(true)
    const { identity, done } = imported.json() as { identity: Identity; done: string[] }
    expect(identity).toMatchObject({ name: "Acme", githubLogin: "octo-acme", owners: ["octo-acme", "acme-corp"], author: { name: "Acme Octo", email: "octo@acme.dev", emailCheck: "verified" } })
    expect(identity.tokens).toEqual([expect.objectContaining({ owner: "", login: "octo-acme", source: "gh:github.com:octo-acme", readable: true })])
    expect(identity.signing).toMatchObject({ kind: "file", requireSigned: true, readable: true })
    expect(done.join("\n")).toMatch(/Made the Acme identity for octo-acme[\s\S]*Saved gh's token for octo-acme[\s\S]*a copy of ~\/\.ssh\/acme_signing, kept encrypted[\s\S]*app: now uses the Acme identity/)
    // The server holds the real values: app's turns get octo-acme's token and the key.
    expect(r.yard.identities.base(r.projects.app.id, "acme-corp/app").githubToken).toBe(TOKENS["octo-acme"])
    expect(r.yard.identities.signingFor(r.projects.app.id)?.privateKey).toBe(fs.readFileSync(path.join(r.pc.home, ".ssh", "acme_signing"), "utf8"))
    expect(r.yard.store.getProject(r.projects.site.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)

    const tested = await tool("test_identity", { identity: "Acme" })
    expect(tested.json()).toEqual({
      identity: "Acme",
      ok: true,
      lines: [
        "The token for every owner: octo-acme, scopes repo, read:org.",
        "acme-corp/app: octo-acme can push.",
        "Author Acme Octo <octo@acme.dev>: verified on octo-acme.",
        expect.stringMatching(/^Signing key SHA256:\S+: on GitHub as octo-acme's signing key, so its commits show Verified\.$/),
        "requireSigned: a push with an unsigned commit is stopped.",
      ],
    })
    expect(r.yard.identities.get(identity.id)!.lastCheck?.ok).toBe(true)

    // Importing the same account again updates it instead of making another.
    const again = await tool("import_detected_identity", { login: "octo-acme", projects: [] })
    expect(again.json()).toMatchObject({ created: false, identity: { id: identity.id } })
    expect(r.yard.identities.list()).toHaveLength(2)
    r.noSecrets()
  })

  it("takes no value in place of a reference, never a login key for box runs, and makes nothing when a reference fails", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const pasted = await tool("create_identity", { name: "Pasted", github_token_ref: TOKENS.octocat })
    expect(pasted.ok).toBe(false)
    expect(pasted.text).toMatch(/isn't a token reference[\s\S]*Settings › Identities/)
    const loginKey = await tool("create_identity", { name: "Oss", github_token_ref: "gh:octocat", signing_key_ref: "file:~/.ssh/id_ed25519" })
    expect(loginKey.ok).toBe(false)
    expect(loginKey.text).toMatch(/~\/\.ssh\/id_ed25519 is also a key this computer logs in to SSH servers with/)
    const outside = await tool("create_identity", { name: "Out", signing_key_ref: "file:/etc/hosts" })
    expect(outside.text).toMatch(/only from ~\/\.ssh/)
    const nobody = await tool("create_identity", { name: "Nobody", github_token_ref: "gh:nobody" })
    expect(nobody.text).toMatch(/gh isn't signed in to nobody/)
    // An error that names what was passed in (a path, an identity) never carries a token or key with it.
    const asPath = await tool("create_identity", { name: "AsPath", signing_key_ref: `file:~/.ssh/${TOKENS.octocat}` })
    expect(asPath.text).toMatch(/There's no key file at ~\/\.ssh\/\[redacted\]/)
    const key = fs.readFileSync(path.join(r.pc.home, ".ssh", "acme_signing"), "utf8")
    expect((await tool("update_identity", { identity: key })).text).toMatch(/^No identity "\[redacted private key\]/)
    expect((await tool("test_identity", { identity: TOKENS["octo-acme"] })).text).toBe('No identity "[redacted]". Use list_identities.')
    expect(r.yard.identities.list().map((i) => i.name)).toEqual(["Default"])
    // On this computer only, a login key may sign: no box ever holds it.
    const here = await tool("create_identity", { name: "Here", runners: ["local"], github_token_ref: "gh:octocat", signing_key_ref: "file:~/.ssh/id_ed25519" })
    expect(here.ok, here.text).toBe(true)
    expect(here.json().identity).toMatchObject({ githubLogin: "octocat", runners: ["local"], signing: { kind: "file" } })
    r.noSecrets()
  })

  it("assigns only where the runner fits and no task is running, and deletes back to Default", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const made = (await tool("create_identity", { name: "Laptop", runners: ["local"] })).json().identity as Identity
    expect((await tool("assign_identity", { project: "app", identity: "Laptop" })).text).toMatch(/app can't use it: the Laptop identity runs only on this computer/)
    const local = r.yard.store.createProject({ name: "here", repo: "octocat/here", runner: "local" })
    const t = r.yard.store.createTask({ projectId: local.id, title: "busy", prompt: "x" })
    r.yard.store.updateTask(t.id, { status: "working" })
    expect((await tool("assign_identity", { project: "here", identity: "Laptop" })).text).toMatch(/here has a task running .*"busy"/)
    r.yard.store.updateTask(t.id, { status: "idle" })
    expect((await tool("assign_identity", { project: "here", identity: "Laptop" })).json().done).toMatch(/here: now uses the Laptop identity/)
    expect((await tool("delete_identity", { identity: "Laptop" })).text).toMatch(/A project uses the Laptop identity/)
    expect((await tool("delete_identity", { identity: made.id, move_projects_to_default: true })).json()).toEqual({ deleted: "Laptop", movedToDefault: ["here"] })
    expect(r.yard.store.getProject(local.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)
  })
})

describe("identity tools, as a Captain", () => {
  it("sees every identity but only its own project in them, and changes only what its project alone uses", async () => {
    const r = await start()
    const coordinator = await r.as({ kind: "coordinator" })
    const shared = (await coordinator("create_identity", { name: "Shared" })).json().identity as Identity
    const other = r.yard.store.createProject({ name: "other", repo: "acme-corp/other" })
    r.yard.identities.assign(other.id, shared.id)
    r.yard.identities.assign(r.projects.app.id, shared.id)
    const tool = await r.as({ kind: "captain", projectId: r.projects.app.id })

    const listed = (await tool("list_identities")).json()
    expect(listed.yours).toBe(shared.id)
    expect(listed.identities.find((i: { id: string }) => i.id === shared.id)).toMatchObject({ yours: true, projectIds: [r.projects.app.id], otherProjects: 1 })
    expect(listed.identities.find((i: { isDefault: boolean }) => i.isDefault)).toMatchObject({ yours: false, projectIds: [] })

    expect((await tool("update_identity", { identity: "Shared", owners: ["acme-corp"] })).text).toMatch(/^Out of scope: the Shared identity is used by other projects too/)
    expect((await tool("delete_identity", { identity: "Shared" })).text).toMatch(/^Out of scope/)
    expect((await tool("update_identity", { identity: "Default", owners: ["x"] })).text).toMatch(/^Out of scope: the Default identity/)
    expect((await tool("assign_identity", { project: "site", identity: "Default" })).text).toMatch(/^Out of scope: project "site" belongs to another Captain/)
    expect((await tool("test_identity", { identity: "Default" })).text).toMatch(/^Out of scope: test_identity checks your project's identity \(Shared\)/)

    // Detection maps its own project only; an import gives the identity its own project and no other.
    const d = (await tool("detect_identities")).json()
    expect([...d.proposals.flatMap((p: { projects: { name: string }[] }) => p.projects), ...d.unmatched].map((x: { name: string }) => x.name)).toEqual(["app"])
    const imported = await tool("import_detected_identity", { login: "octo-acme", name: "Acme" })
    expect(imported.ok, imported.text).toBe(true)
    expect(imported.json().done.join("\n")).toMatch(/app: now uses the Acme identity/)
    expect((await tool("import_detected_identity", { login: "octocat", projects: ["site"] })).json().done.join("\n")).toMatch(/site: not moved: Out of scope/)
    expect(r.yard.store.getProject(r.projects.site.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)

    // Its own identity it may change and test; the test isn't saved as the identity's last check.
    expect((await tool("update_identity", { identity: "Acme", color: "rose" })).ok).toBe(true)
    const tested = (await tool("test_identity")).json()
    expect(tested.lines).toContain("acme-corp/app: octo-acme can push.")
    expect(r.yard.identities.find("Acme")!.lastCheck).toBeNull()
    r.noSecrets()
  })
})
