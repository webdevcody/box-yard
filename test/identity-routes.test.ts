import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { DEFAULT_IDENTITY_ID, type Identity, type IdentityCheckResult, type IdentityDetection } from "../shared/identities.js"
import type { Project } from "../shared/types.js"
import { freePort, testConfig } from "./helpers.js"
import { TOKENS, computer, github } from "./identityFixtures.js"

// Settings › Identities' routes (docs/identities.md › Set up from this computer): detect, import a proposal and test,
// plus the project picker's PATCH. No response may hold a token or a private key.

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const pc = computer()
  const gh = github(pc.keys)
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", github: { fetch: gh.fetch, token: () => null }, detect: { home: pc.home, env: pc.env } })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const projects = { site: yard.store.createProject({ name: "site", repo: "octocat/site" }), app: yard.store.createProject({ name: "app", repo: "acme-corp/app" }) }
  const seen: string[] = []
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    seen.push(text)
    return { status: res.status, text, json: <T,>() => JSON.parse(text) as T }
  }
  const noSecrets = () => {
    const all = seen.join("\n")
    for (const secret of Object.values(TOKENS)) expect(all).not.toContain(secret)
    expect(all).not.toContain("PRIVATE KEY")
    expect(all).not.toContain(fs.readFileSync(path.join(pc.home, ".ssh", "acme_signing"), "utf8").split("\n")[1]!)
  }
  return { yard, projects, raw, noSecrets }
}

describe("identity routes", () => {
  it("detects without changing anything, imports a proposal with its projects, and tests it", async () => {
    const r = await start()
    expect((await r.raw("POST", "/api/identities/detect", { online: false })).json<IdentityDetection>().online).toBe(false)
    const detected = await r.raw("POST", "/api/identities/detect", {})
    expect(detected.status).toBe(200)
    const d = detected.json<IdentityDetection>()
    expect(d.online).toBe(true)
    expect(d.proposals.map((p) => [p.login, p.tokenRef, p.projects.map((x) => x.name)])).toEqual([
      ["octocat", "gh:github.com:octocat", ["site"]],
      ["octo-acme", "gh:github.com:octo-acme", ["app"]],
    ])
    expect(r.yard.identities.list().map((i) => i.name)).toEqual(["Default"])

    const imported = await r.raw("POST", "/api/identities/import", { login: "octo-acme", name: "Acme", requireSigned: true })
    expect(imported.status, imported.text).toBe(201)
    const { identity, created, lines } = imported.json<{ identity: Identity; created: boolean; lines: string[] }>()
    expect(created).toBe(true)
    expect(identity).toMatchObject({ name: "Acme", githubLogin: "octo-acme", owners: ["octo-acme", "acme-corp"], signing: { kind: "file", requireSigned: true } })
    expect(lines.join("\n")).toMatch(/Made the Acme identity for octo-acme[\s\S]*app: now uses the Acme identity/)
    expect(r.yard.store.getProject(r.projects.app.id)!.identityId).toBe(identity.id)
    expect(r.yard.store.getProject(r.projects.site.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)

    const tested = await r.raw("POST", `/api/identities/${identity.id}/test`)
    expect(tested.json<IdentityCheckResult>()).toMatchObject({ ok: true, lines: expect.arrayContaining(["acme-corp/app: octo-acme can push.", "Author Acme Octo <octo@acme.dev>: verified on octo-acme."]) })
    expect((await r.raw("GET", "/api/identities")).json<Identity[]>().find((i) => i.id === identity.id)!.lastCheck?.ok).toBe(true)

    // Again: the same identity, updated, and no project moved when none is asked for.
    const again = await r.raw("POST", "/api/identities/import", { login: "octo-acme", projects: [] })
    expect(again.status).toBe(200)
    expect(again.json<{ created: boolean; identity: Identity }>()).toMatchObject({ created: false, identity: { id: identity.id } })
    expect((await r.raw("POST", "/api/identities/import", { login: "nobody" })).json<{ error: string }>().error).toMatch(/^Detection found no gh account "nobody" on this computer \(it found octocat, octo-acme\)/)
    expect((await r.raw("POST", "/api/identities/import", { login: "octocat", token: TOKENS.octocat })).status).toBe(400)
    r.noSecrets()
  })

  it("a project keeps its identity while a turn of it runs, and the import leaves it where it is", async () => {
    const r = await start()
    const t = r.yard.store.createTask({ projectId: r.projects.app.id, title: "busy", prompt: "x" })
    r.yard.store.updateTask(t.id, { status: "working" })
    await r.raw("POST", "/api/identities/detect", {})
    const imported = (await r.raw("POST", "/api/identities/import", { login: "octo-acme" })).json<{ identity: Identity; lines: string[] }>()
    expect(imported.lines.join("\n")).toMatch(/app: not moved: app has a task running .*"busy"/)
    expect(r.yard.store.getProject(r.projects.app.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)

    const patched = await r.raw("PATCH", `/api/projects/${r.projects.app.id}`, { identityId: imported.identity.id })
    expect(patched.status).toBe(409)
    expect(patched.json<{ error: string }>().error).toMatch(/^app has a task running \("busy"\)/)
    // Anything else about the project still saves, and so does its identity once the task rests.
    expect((await r.raw("PATCH", `/api/projects/${r.projects.app.id}`, { identityId: DEFAULT_IDENTITY_ID, description: "d" })).status).toBe(200)
    r.yard.store.updateTask(t.id, { status: "idle" })
    const moved = await r.raw("PATCH", `/api/projects/${r.projects.app.id}`, { identityId: imported.identity.id })
    expect(moved.json<Project>().identityId).toBe(imported.identity.id)
    r.noSecrets()
  })
})
