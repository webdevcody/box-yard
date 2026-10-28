import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Identities through the API, end to end: secrets go in and only fingerprints come out, and a project's turns get its
// identity's GitHub token, git author and Claude login (docs/identities.md).

/** GitHub's GET /user and /user/emails for the tokens these tests use. */
const ACCOUNTS: Record<string, { login: string; id: number }> = {
  "tok-acme-0001": { login: "acme-bot", id: 42 },
  "tok-acme-0002": { login: "acme-bot", id: 42 },
  "tok-other-001": { login: "someone-else", id: 7 },
}
const github = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const auth = new Headers(init?.headers).get("Authorization") ?? ""
  const account = ACCOUNTS[auth.replace(/^Bearer /, "")]
  if (!url.startsWith("https://api.github.com/user")) return new Response("{}", { status: 404 })
  if (!account) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
  if (url.endsWith("/user/emails")) return Response.json([{ email: "bot@acme.dev", verified: true, primary: true }])
  return Response.json({ login: account.login, id: account.id, name: null }, { headers: { "x-oauth-scopes": "repo, workflow" } })
}

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const dir = tmpDir("identities-e2e-")
  const log = path.join(dir, "claude-env.log")
  // Writes where it runs and the credential and author vars it sees (only whether the secret key is there), then
  // runs the fake claude.
  const claude = path.join(dir, "claude")
  fs.writeFileSync(
    claude,
    `#!/bin/sh\n{ echo "CWD=$PWD"; env | grep -E '^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN|GIT_AUTHOR_[A-Z]+|GIT_COMMITTER_[A-Z]+)='; [ -n "$BOXYARD_SECRET_KEY" ] && echo SECRET_KEY_SET; echo ---; } >> ${JSON.stringify(log)}\nexec ${FAKE_CLAUDE} "$@"\n`,
    { mode: 0o755 },
  )
  const port = await freePort()
  // Room for a box per identity: the box wall never puts two identities' tasks on one box.
  const config = testConfig({ port, claudeBin: claude, anthropicApiKey: "global-key", githubToken: "global-gh", maxBoxes: 4 })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(path.join(dir, "boxes"), claude), github: { fetch: github as typeof fetch, token: () => null } })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  /** The response's status and its raw text, so a test can check that no secret is in it. */
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await raw(method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${r.text}`)
    return JSON.parse(r.text) as T
  }
  /** What `claude` was started with so far, sorted: each agent turn's, or (`captains`) each Captain run's. */
  const turns = (captains = false) =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("---\n").filter(Boolean) : [])
      .map((t) => t.trim().split("\n").filter(Boolean))
      .filter((lines) => lines[0]!.includes(`${path.sep}captains${path.sep}`) === captains)
      .map((lines) => lines.slice(1).sort())
  const runTask = async (project: Project, prompt = "Say hi") => {
    const before = turns().length
    const task = await call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt })
    await waitFor(() => (yard.store.getTask(task.id)?.status === "done" ? true : null), "the task's turn to end", 30_000)
    return { env: turns()[before]!, task }
  }
  return { yard, raw, call, runTask, turns }
}

describe("identities over the API", () => {
  it("take secrets in and give back only logins and fingerprints", async () => {
    const r = await start()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme", owners: ["Acme"], author: { name: "Acme Bot", email: "bot@acme.dev" } })
    expect(acme).toMatchObject({ name: "Acme", isDefault: false, owners: ["Acme"], githubLogin: null, tokens: [], claude: null })

    const withToken = await r.call<Identity>("PUT", `/api/identities/${acme.id}/tokens`, { owner: "acme", token: "tok-acme-0001" })
    expect(withToken.githubLogin).toBe("acme-bot")
    expect(withToken.tokens).toEqual([expect.objectContaining({ owner: "acme", login: "acme-bot", scopes: ["repo", "workflow"], fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) })])
    // The token could read the account's verified emails, and the author's is one of them.
    expect(withToken.author).toEqual({ name: "Acme Bot", email: "bot@acme.dev", emailCheck: "verified" })

    // An identity is one GitHub account, GitHub must accept the token, and Default's are in Settings › Credentials.
    expect(await r.raw("PUT", `/api/identities/${acme.id}/tokens`, { owner: "", token: "tok-other-001" })).toMatchObject({ status: 400, text: expect.stringContaining("someone-else") })
    expect(await r.raw("PUT", `/api/identities/${acme.id}/tokens`, { owner: "", token: "tok-unknown-1" })).toMatchObject({ status: 400 })
    expect(await r.raw("PUT", `/api/identities/${DEFAULT_IDENTITY_ID}/tokens`, { owner: "", token: "tok-acme-0001" })).toMatchObject({ status: 400 })
    expect(await r.raw("PUT", `/api/identities/${DEFAULT_IDENTITY_ID}/claude`, { kind: "api_key", value: "sk-ant-api03-xyz" })).toMatchObject({ status: 400 })

    const withClaude = await r.call<Identity>("PUT", `/api/identities/${acme.id}/claude`, { kind: "oauth_token", value: "acme-oauth-0001" })
    expect(withClaude.claude).toEqual({ kind: "oauth_token", fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/), readable: true })

    const listed = await r.raw("GET", "/api/identities")
    for (const secret of ["tok-acme-0001", "acme-oauth-0001"]) expect(listed.text).not.toContain(secret)
    expect((JSON.parse(listed.text) as Identity[]).map((i) => i.name)).toEqual(["Default", "Acme"])

    const removed = await r.call<Identity>("DELETE", `/api/identities/${acme.id}/tokens?owner=acme`)
    expect(removed).toMatchObject({ tokens: [], githubLogin: null })
  })

  it("give a project's turns its identity's GitHub token, author and Claude login", async () => {
    const r = await start()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme", author: { name: "Acme Bot", email: "bot@acme.dev" } })
    await r.call("PUT", `/api/identities/${acme.id}/tokens`, { owner: "", token: "tok-acme-0002" })
    await r.call("PUT", `/api/identities/${acme.id}/claude`, { kind: "oauth_token", value: "acme-oauth-0001" })
    const solo = await r.call<Identity>("POST", "/api/identities", { name: "Solo" })

    const onAcme = await r.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
    expect(onAcme.identityId).toBe(acme.id)
    expect((await r.runTask(onAcme)).env).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN=acme-oauth-0001",
      "GH_TOKEN=tok-acme-0002",
      "GITHUB_TOKEN=tok-acme-0002",
      "GIT_AUTHOR_EMAIL=bot@acme.dev",
      "GIT_AUTHOR_NAME=Acme Bot",
      "GIT_COMMITTER_EMAIL=bot@acme.dev",
      "GIT_COMMITTER_NAME=Acme Bot",
    ])

    // An identity without a token gets none (never the global one); without a Claude login it uses the global one.
    const onSolo = await r.call<Project>("POST", "/api/projects", { name: "solo-app", identityId: solo.id })
    expect((await r.runTask(onSolo)).env).toEqual(["ANTHROPIC_API_KEY=global-key"])

    // Every other project is on Default: Settings › Credentials, as before.
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })
    expect(plain.identityId).toBe(DEFAULT_IDENTITY_ID)
    expect((await r.runTask(plain)).env).toEqual(["ANTHROPIC_API_KEY=global-key", "GH_TOKEN=global-gh", "GITHUB_TOKEN=global-gh"])

    // A project's own env vars still win over its identity's.
    await r.call("PATCH", `/api/projects/${onAcme.id}`, { env: { GITHUB_TOKEN: "project-gh" } })
    expect((await r.runTask(onAcme)).env).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN=acme-oauth-0001", "GITHUB_TOKEN=project-gh", "GH_TOKEN=project-gh"]))
  })

  it("keep an agent's printed credentials out of every transcript", async () => {
    const r = await start()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme" })
    await r.call("PUT", `/api/identities/${acme.id}/tokens`, { owner: "", token: "tok-acme-0002" })
    await r.call("PUT", `/api/identities/${acme.id}/claude`, { kind: "oauth_token", value: "acme-oauth-0001" })
    const project = await r.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })

    const { task } = await r.runTask(project, "Show your env [print-env]")
    const said = r.yard.store.listTaskMessages(task.id).map((m) => `${m.content} ${JSON.stringify(m.meta)}`)
    expect(said.some((t) => t.includes("GITHUB_TOKEN=[redacted] CLAUDE_CODE_OAUTH_TOKEN=[redacted]"))).toBe(true)
    // Settings › Credentials' values too, on a Default project.
    const { task: other } = await r.runTask(plain, "Show your env [print-env]")
    const saidToo = r.yard.store.listTaskMessages(other.id).map((m) => `${m.content} ${JSON.stringify(m.meta)}`)
    expect(saidToo.some((t) => t.includes("GITHUB_TOKEN=[redacted] ANTHROPIC_API_KEY=[redacted]"))).toBe(true)

    const everything = JSON.stringify([
      ...[task.id, other.id].flatMap((id) => r.yard.store.listTaskMessages(id)),
      ...r.yard.store.listCaptainMessages(project.id),
      ...r.yard.store.listChat(500),
    ])
    for (const secret of ["tok-acme-0002", "acme-oauth-0001", "global-gh", "global-key"]) expect(everything).not.toContain(secret)
  })

  it("run a project's Captain on its identity's Claude login, and never hand it the secret key", async () => {
    process.env.BOXYARD_SECRET_KEY = "a-passphrase-for-this-test"
    try {
      const r = await start()
      const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme" })
      await r.call("PUT", `/api/identities/${acme.id}/claude`, { kind: "api_key", value: "acme-key-0001" })
      const project = await r.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
      await r.call("POST", `/api/projects/${project.id}/captain/messages`, { content: "status" })
      const run = await waitFor(() => r.turns(true)[0] ?? null, "the Captain's run")
      expect(run.filter((l) => /^(ANTHROPIC|CLAUDE_CODE_OAUTH)/.test(l) || l === "SECRET_KEY_SET")).toEqual(["ANTHROPIC_API_KEY=acme-key-0001"])
    } finally {
      delete process.env.BOXYARD_SECRET_KEY
    }
  })

  it("run a side thread like its chat: a Captain's on its identity's Claude login, the Coordinator's on Settings', and neither gets the secret key", async () => {
    process.env.BOXYARD_SECRET_KEY = "a-passphrase-for-this-test"
    try {
      const r = await start()
      const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme" })
      await r.call("PUT", `/api/identities/${acme.id}/claude`, { kind: "api_key", value: "acme-key-0001" })
      const project = await r.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
      await r.call("POST", `/api/projects/${project.id}/captain/messages`, { content: "status" })
      const reply = await waitFor(async () => (await r.call<{ id: string; role: string }[]>("GET", `/api/projects/${project.id}/captain/messages`)).find((m) => m.role === "assistant") ?? null, "the Captain's reply")
      await waitFor(() => r.turns(true)[0] ?? null, "the Captain's run")
      await r.call("POST", "/api/threads", { projectId: project.id, anchorId: reply.id, quote: "status", question: "Why?" })
      const thread = await waitFor(() => r.turns(true)[1] ?? null, "the Captain side thread's run")
      expect(thread.filter((l) => /^(ANTHROPIC|CLAUDE_CODE_OAUTH)/.test(l) || l === "SECRET_KEY_SET")).toEqual(["ANTHROPIC_API_KEY=acme-key-0001"])

      await r.call("POST", "/api/chat", { content: "status" })
      const chat = await waitFor(async () => (await r.call<{ id: string; role: string }[]>("GET", "/api/chat")).find((m) => m.role === "assistant") ?? null, "the Coordinator's reply")
      const before = r.turns().length
      await r.call("POST", "/api/threads", { anchorId: chat.id, quote: "status", question: "Why?" })
      const coordinator = await waitFor(() => r.turns()[before] ?? null, "the Coordinator side thread's run")
      expect(coordinator.filter((l) => /^(ANTHROPIC|CLAUDE_CODE_OAUTH)/.test(l) || l === "SECRET_KEY_SET")).toEqual(["ANTHROPIC_API_KEY=global-key"])
    } finally {
      delete process.env.BOXYARD_SECRET_KEY
    }
  })

  it("keep projects on runners their identity allows, and move them to Default when it's removed", async () => {
    const r = await start()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme", runners: ["docker"] })
    expect(await r.raw("POST", "/api/projects", { name: "acme-app", identityId: acme.id, runner: "box" })).toMatchObject({ status: 400, text: expect.stringContaining("runs only on") })
    const project = await r.call<Project>("POST", "/api/projects", { name: "acme-app", runner: "box" })
    expect(await r.raw("PATCH", `/api/projects/${project.id}`, { identityId: acme.id })).toMatchObject({ status: 400 })
    expect(await r.raw("PATCH", `/api/projects/${project.id}`, { identityId: "idn_nope" })).toMatchObject({ status: 404 })

    await r.call("PATCH", `/api/identities/${acme.id}`, { runners: null })
    expect((await r.call<Project>("PATCH", `/api/projects/${project.id}`, { identityId: acme.id })).identityId).toBe(acme.id)
    // Now that a project on a box uses it, the identity can't be narrowed to Docker.
    expect(await r.raw("PATCH", `/api/identities/${acme.id}`, { runners: ["docker"] })).toMatchObject({ status: 400 })

    // A task can't ask for a runner its identity doesn't allow either.
    await r.call("PATCH", `/api/identities/${acme.id}`, { runners: ["box"] })
    const refused = await r.raw("POST", "/api/tasks", { projectId: project.id, title: "Here", prompt: "Say hi", runsOn: "docker" })
    expect(refused).toMatchObject({ status: 400, text: expect.stringContaining("the Acme identity runs only on") })

    expect(await r.raw("DELETE", `/api/identities/${acme.id}`)).toMatchObject({ status: 409 })
    expect(await r.call("DELETE", `/api/identities/${acme.id}?moveProjects=1`)).toEqual({ ok: true, movedProjectIds: [project.id] })
    expect(r.yard.store.getProject(project.id)?.identityId).toBe(DEFAULT_IDENTITY_ID)
    expect(await r.raw("DELETE", `/api/identities/${DEFAULT_IDENTITY_ID}`)).toMatchObject({ status: 400 })
  })
})
