import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { openDb, MIGRATIONS, migrate } from "../server/db.js"
import Database from "better-sqlite3"
import { Store } from "../server/store.js"
import { Identities } from "../server/identity/identities.js"
import { SecretBox, tokenFingerprint } from "../server/identity/secretBox.js"
import { githubTokenInfo, parseGithubExpiry } from "../server/identity/github.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { credentialSet, turnEnv } from "../server/turnCredentials.js"
import { tmpDir } from "./helpers.js"

describe("SecretBox", () => {
  it("seals with a key file of its own (0600), never in the value, and opens what it sealed", () => {
    const dir = tmpDir("secret-box-")
    const box = new SecretBox({ dataDir: dir })
    const sealed = box.seal("ghp_supersecret_value_1234567890")
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/)
    expect(sealed).not.toContain("supersecret")
    expect(box.open(sealed)).toBe("ghp_supersecret_value_1234567890")
    expect(fs.statSync(box.keyFile).mode & 0o777).toBe(0o600)
    // Another server on the same data dir reads the same key.
    expect(new SecretBox({ dataDir: dir }).open(sealed)).toBe("ghp_supersecret_value_1234567890")
    // Another key, or a damaged value, opens to null rather than throwing.
    expect(new SecretBox({ dataDir: tmpDir("secret-box-") }).open(sealed)).toBeNull()
    expect(box.open(sealed.slice(0, -4) + "AAAA")).toBeNull()
    expect(box.open("plain")).toBeNull()
  })

  it("uses BOXYARD_SECRET_KEY instead of a file when it's set", () => {
    const dir = tmpDir("secret-box-")
    const a = new SecretBox({ dataDir: dir, envKey: "correct horse battery staple" })
    const sealed = a.seal("token")
    expect(fs.existsSync(a.keyFile)).toBe(false)
    expect(new SecretBox({ dataDir: tmpDir("secret-box-"), envKey: "correct horse battery staple" }).open(sealed)).toBe("token")
    expect(new SecretBox({ dataDir: dir }).open(sealed)).toBeNull()
  })

  it("fingerprints are short, stable and not the value", () => {
    expect(tokenFingerprint("abc")).toBe(tokenFingerprint("abc"))
    expect(tokenFingerprint("abc")).toHaveLength(12)
    expect(tokenFingerprint("abc")).not.toBe(tokenFingerprint("abd"))
  })
})

describe("githubTokenInfo", () => {
  const fakeFetch = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch

  it("reads the login, a classic token's scopes and the expiry", async () => {
    const info = await githubTokenInfo("t", fakeFetch(200, { login: "octocat", id: 1, name: "Mona" }, { "x-oauth-scopes": "repo, read:org", "github-authentication-token-expiration": "2026-11-01 00:00:00 UTC" }))
    expect(info).toEqual({ login: "octocat", id: 1, name: "Mona", scopes: ["repo", "read:org"], expiresAt: Date.UTC(2026, 10, 1) })
  })

  it("a fine-grained token has no scopes header, and a refused token says so without echoing it", async () => {
    expect((await githubTokenInfo("t", fakeFetch(200, { login: "octocat", id: 1 }))).scopes).toBeNull()
    await expect(githubTokenInfo("ghp_value_never_echoed", fakeFetch(401, { message: "Bad credentials" }))).rejects.toThrow(/401/)
    await expect(githubTokenInfo("ghp_value_never_echoed", fakeFetch(401, {}))).rejects.not.toThrow(/ghp_value/)
  })

  it("parses GitHub's expiry format", () => {
    expect(parseGithubExpiry("2026-01-02 03:04:05 UTC")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(parseGithubExpiry(null)).toBeNull()
    expect(parseGithubExpiry("soon")).toBeNull()
  })
})

function setup(o: { github?: Record<string, { login: string; id: number }>; globalToken?: string; globalClaude?: Record<string, string> } = {}) {
  const dir = tmpDir("identities-")
  const db = openDb(dir)
  const store = new Store(db)
  const fetch = (async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /, "")
    const who = o.github?.[token]
    return who ? new Response(JSON.stringify(who), { status: 200 }) : new Response("{}", { status: 401 })
  }) as unknown as typeof globalThis.fetch
  const identities = new Identities({
    db,
    secrets: new SecretBox({ dataDir: dir }),
    credentials: { get: (k) => (k === "githubToken" ? (o.globalToken ?? "") : ""), claudeEnv: () => o.globalClaude ?? {} },
    github: fetch,
  })
  return { db, store, identities, dir }
}

describe("Identities", () => {
  it("every project starts on Default, which is Settings › Credentials", () => {
    const { store, identities } = setup({ globalToken: "global-gh", globalClaude: { ANTHROPIC_API_KEY: "global-key" } })
    const p = store.createProject({ name: "site", repo: "acme/site" })
    expect(p.identityId).toBe(DEFAULT_IDENTITY_ID)
    expect(identities.list().map((i) => i.name)).toEqual(["Default"])
    expect(identities.base(p.id, p.repo)).toMatchObject({ identityId: DEFAULT_IDENTITY_ID, isDefault: true, githubToken: "global-gh", claude: { ANTHROPIC_API_KEY: "global-key" }, author: null })
  })

  it("an identity's token for the repo's owner wins over its every-owner token, and the global one never applies", async () => {
    const { store, identities } = setup({ github: { "tok-acme-0001": { login: "cody-work", id: 7 }, "tok-all-00001": { login: "cody-work", id: 7 } }, globalToken: "global-gh" })
    const work = identities.create({ name: "Work", owners: ["acme"], author: { name: "Cody", email: "cody@acme.dev" } })
    const site = store.createProject({ name: "site", repo: "https://github.com/Acme/site.git" })
    const other = store.createProject({ name: "other", repo: "someone/else" })
    identities.assign(site.id, work.id)
    identities.assign(other.id, work.id)
    // No token yet: the turns get none, not the global one.
    expect(identities.base(site.id, site.repo).githubToken).toBe("")
    await identities.saveToken(work.id, { token: "tok-all-00001" })
    await identities.saveToken(work.id, { owner: "acme", token: "tok-acme-0001" })
    expect(identities.base(site.id, site.repo)).toMatchObject({ githubToken: "tok-acme-0001", author: { name: "Cody", email: "cody@acme.dev" } })
    expect(identities.base(other.id, other.repo).githubToken).toBe("tok-all-00001")
    const view = identities.require(work.id)
    expect(view.githubLogin).toBe("cody-work")
    expect(view.tokens.map((t) => [t.owner, t.fingerprint, t.login])).toEqual([["", tokenFingerprint("tok-all-00001"), "cody-work"], ["acme", tokenFingerprint("tok-acme-0001"), "cody-work"]])
    expect(JSON.stringify(identities.list())).not.toMatch(/tok-/)
  })

  it("refuses a token GitHub doesn't accept, or another account's, and the Default identity's secrets", async () => {
    const { identities } = setup({ github: { "tok-alice-001": { login: "alice", id: 1 }, "tok-bob-00001": { login: "bob", id: 2 } } })
    const a = identities.create({ name: "Alice" })
    await expect(identities.saveToken(a.id, { token: "tok-nope-nope" })).rejects.toThrow(/401/)
    await identities.saveToken(a.id, { token: "tok-alice-001" })
    await expect(identities.saveToken(a.id, { owner: "acme", token: "tok-bob-00001" })).rejects.toThrow(/bob's, but the Alice identity is alice/)
    await expect(identities.saveToken(DEFAULT_IDENTITY_ID, { token: "tok-alice-001" })).rejects.toThrow(/Settings › Credentials/)
    expect(() => identities.saveClaude(DEFAULT_IDENTITY_ID, { kind: "api_key", value: "sk-ant-12345678" })).toThrow(/Settings › Credentials/)
  })

  it("stores secrets encrypted: the database holds no value", async () => {
    const { identities, db, dir } = setup({ github: { "ghp_plaintext_marker_123": { login: "alice", id: 1 } } })
    const a = identities.create({ name: "Alice" })
    await identities.saveToken(a.id, { token: "ghp_plaintext_marker_123" })
    identities.saveClaude(a.id, { kind: "oauth_token", value: "sk-ant-oat-plaintext_marker" })
    db.pragma("wal_checkpoint(TRUNCATE)")
    const file = fs.readFileSync(path.join(dir, "box-yard.sqlite"))
    expect(file.includes("plaintext_marker")).toBe(false)
    expect(identities.secretValues().sort()).toEqual(["ghp_plaintext_marker_123", "sk-ant-oat-plaintext_marker"])
  })

  it("a secret this server's key can't open is shown unreadable, and no turn gets it", async () => {
    const { identities, store, db, dir } = setup({ github: { "tok-alice-001": { login: "alice", id: 1 } } })
    const a = identities.create({ name: "Alice" })
    await identities.saveToken(a.id, { token: "tok-alice-001" })
    identities.saveClaude(a.id, { kind: "api_key", value: "alice-key-0001" })
    const p = store.createProject({ name: "site" })
    identities.assign(p.id, a.id)
    expect(identities.require(a.id)).toMatchObject({ tokens: [{ readable: true }], claude: { readable: true } })
    // The key file is replaced (a restore without it): the identity stays, its secrets can't be read.
    fs.writeFileSync(path.join(dir, "secret.key"), randomBytes(32).toString("base64"))
    const after = new Identities({ db, secrets: new SecretBox({ dataDir: dir }), credentials: { get: () => "", claudeEnv: () => ({ ANTHROPIC_API_KEY: "global-key" }) } })
    expect(after.require(a.id)).toMatchObject({ githubLogin: "alice", tokens: [{ readable: false }], claude: { readable: false } })
    expect(after.base(p.id, null)).toMatchObject({ githubToken: "", claude: { ANTHROPIC_API_KEY: "global-key" } })
  })

  it("an identity's Claude login wins over the global one; without one the global login applies", () => {
    const { store, identities } = setup({ globalClaude: { ANTHROPIC_API_KEY: "global-key" } })
    const a = identities.create({ name: "Alice" })
    const p = store.createProject({ name: "site" })
    identities.assign(p.id, a.id)
    expect(identities.base(p.id, null).claude).toEqual({ ANTHROPIC_API_KEY: "global-key" })
    identities.saveClaude(a.id, { kind: "oauth_token", value: "alice-oauth-token" })
    expect(identities.base(p.id, null).claude).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "alice-oauth-token" })
    // turnEnv: exactly that one reaches the turn, and the global key is unset.
    const t = turnEnv({}, identities.base(p.id, null))
    expect(t.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "alice-oauth-token" })
    expect(t.unsetEnv).toContain("ANTHROPIC_API_KEY")
    identities.removeClaude(a.id)
    expect(identities.require(a.id).claude).toBeNull()
  })

  it("names are unique, Default keeps its name and can't be removed, and a used identity needs its projects moved", () => {
    const { store, identities } = setup()
    const a = identities.create({ name: "Work" })
    expect(() => identities.create({ name: "work" })).toThrow(/already exists/)
    expect(() => identities.update(DEFAULT_IDENTITY_ID, { name: "Mine" })).toThrow(/keeps its name/)
    expect(() => identities.delete(DEFAULT_IDENTITY_ID)).toThrow(/can't be removed/)
    const p = store.createProject({ name: "site" })
    identities.assign(p.id, a.id)
    expect(() => identities.delete(a.id)).toThrow(/A project uses the Work identity/)
    expect(identities.delete(a.id, { moveProjects: true }).movedProjectIds).toEqual([p.id])
    expect(store.getProject(p.id)!.identityId).toBe(DEFAULT_IDENTITY_ID)
  })

  it("runners: a project's runner must be one its identity allows", () => {
    const { store, identities } = setup()
    const a = identities.create({ name: "Laptop", runners: ["local", "docker"] })
    expect(identities.runnerProblem(a.id, "box")).toMatch(/the Laptop identity runs only on this computer or/)
    expect(identities.runnerProblem(a.id, "local")).toBeNull()
    expect(identities.runnerProblem(DEFAULT_IDENTITY_ID, "box")).toBeNull()
    const p = store.createProject({ name: "site", runner: "box" })
    const b = identities.create({ name: "Any" })
    identities.assign(p.id, b.id)
    expect(() => identities.update(b.id, { runners: ["local"] })).toThrow(/site uses the Any identity and runs on an Upstash box/)
  })

  it("the box wall: an identity is a credential set of its own; a project's own token is its own set", () => {
    const { store, identities } = setup()
    const a = identities.create({ name: "Work" })
    const p = store.createProject({ name: "site" })
    expect(credentialSet(p.id, {}, identities.idOf(p.id))).toBe("global")
    identities.assign(p.id, a.id)
    expect(credentialSet(p.id, {}, identities.idOf(p.id))).toBe(`identity:${a.id}`)
    expect(credentialSet(p.id, { GITHUB_TOKEN: "x" }, identities.idOf(p.id))).toBe(`project:${p.id}`)
  })
})

describe("signing keys", () => {
  /** A throwaway key pair made for the test (`passphrase` for one that has it). */
  const keyPair = (passphrase = "") => {
    const dir = tmpDir("signing-key-")
    const file = path.join(dir, "key")
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "test@box-yard", "-f", file])
    const pub = fs.readFileSync(`${file}.pub`, "utf8").split(" ").slice(0, 2).join(" ")
    const fingerprint = /SHA256:\S+/.exec(execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${file}.pub`], { encoding: "utf8" }))![0]
    return { privateKey: fs.readFileSync(file, "utf8"), pub, fingerprint }
  }

  it("a key file: only its public key and fingerprint are shown, and the private key is kept encrypted for turns", async () => {
    const { store, identities, db, dir } = setup()
    const key = keyPair()
    const a = identities.create({ name: "Acme" })
    const p = store.createProject({ name: "site" })
    identities.assign(p.id, a.id)
    const saved = await identities.saveSigning(a.id, { kind: "file", privateKey: key.privateKey })
    expect(saved.signing).toEqual({ format: "ssh", kind: "file", publicKey: key.pub, fingerprint: key.fingerprint, program: null, requireSigned: false, readable: true })
    expect(JSON.stringify(identities.list())).not.toContain("PRIVATE KEY")
    const body = key.privateKey.split("\n")[1]!
    db.pragma("wal_checkpoint(TRUNCATE)")
    expect(fs.readFileSync(path.join(dir, "box-yard.sqlite")).includes(body)).toBe(false)
    expect(identities.signingFor(p.id)).toEqual({ identity: "Acme", kind: "file", publicKey: key.pub, fingerprint: key.fingerprint, program: null, requireSigned: false, privateKey: key.privateKey })
    expect(identities.secretValues()).toContain(key.privateKey)
    // requireSigned names the key every push must be signed with.
    expect(identities.requiredSigner(p.id)).toBeNull()
    expect(identities.setRequireSigned(a.id, { requireSigned: true }).signing?.requireSigned).toBe(true)
    expect(identities.requiredSigner(p.id)).toEqual({ identity: "Acme", publicKey: key.pub, fingerprint: key.fingerprint })
    // Another secret key can't open it: the identity says so, and turns don't sign.
    fs.writeFileSync(path.join(dir, "secret.key"), randomBytes(32).toString("base64"))
    const after = new Identities({ db, secrets: new SecretBox({ dataDir: dir }), credentials: { get: () => "", claudeEnv: () => ({}) } })
    expect(after.require(a.id).signing).toMatchObject({ readable: false })
    expect(after.signingFor(p.id)?.privateKey).toBeNull()
    identities.removeSigning(a.id)
    expect(identities.require(a.id).signing).toBeNull()
    expect(identities.signingFor(p.id)).toBeNull()
    expect(db.prepare("SELECT COUNT(*) AS n FROM identity_secrets WHERE kind = 'signing_key'").get()).toEqual({ n: 0 })
    expect(() => identities.setRequireSigned(a.id, { requireSigned: true })).toThrow(/no signing key yet/)
  })

  it("refuses a key with a passphrase, what isn't a key, and a signing program that isn't there", async () => {
    const { identities } = setup()
    const a = identities.create({ name: "Acme", runners: ["local"] })
    await expect(identities.saveSigning(a.id, { kind: "file", privateKey: keyPair("hunter2-hunter2").privateKey })).rejects.toThrow(/has a passphrase/)
    await expect(identities.saveSigning(a.id, { kind: "file", privateKey: "x".repeat(80) })).rejects.toThrow(/isn't an SSH private key/)
    await expect(identities.saveSigning(a.id, { kind: "agent", publicKey: "my laptop's key, the usual one" })).rejects.toThrow(/isn't an SSH public key/)
    await expect(identities.saveSigning(a.id, { kind: "agent", publicKey: "ssh-ed25519 AAAAnotarealkey" })).rejects.toThrow(/couldn't read that public key/)
    const { pub } = keyPair()
    await expect(identities.saveSigning(a.id, { kind: "agent", publicKey: pub, program: "op-ssh-sign" })).rejects.toThrow(/full path/)
    await expect(identities.saveSigning(a.id, { kind: "agent", publicKey: pub, program: "/nonexistent/op-ssh-sign" })).rejects.toThrow(/no program at/)
    expect(identities.require(a.id).signing).toBeNull()
  })

  it("a key in this computer's SSH agent signs only for projects on this computer", async () => {
    const { store, identities } = setup()
    const { pub, fingerprint } = keyPair()
    const a = identities.create({ name: "Laptop" })
    const p = store.createProject({ name: "site", runner: "box" })
    identities.assign(p.id, a.id)
    await expect(identities.saveSigning(a.id, { kind: "agent", publicKey: `${pub} me@laptop` })).rejects.toThrow(/site uses the Laptop identity and runs on an Upstash box/)
    store.updateProject(p.id, { runner: "local" })
    const saved = await identities.saveSigning(a.id, { kind: "agent", publicKey: `${pub} me@laptop`, program: "/bin/sh", requireSigned: true })
    expect(saved.signing).toEqual({ format: "ssh", kind: "agent", publicKey: pub, fingerprint, program: "/bin/sh", requireSigned: true, readable: true })
    expect(identities.signingFor(p.id)).toMatchObject({ kind: "agent", privateKey: null, program: "/bin/sh" })
    expect(identities.runnerProblem(a.id, "box")).toMatch(/signs with a key in this computer's SSH agent/)
    expect(identities.runnerProblem(a.id, "local")).toBeNull()
    expect(() => identities.update(a.id, { runners: ["docker"] })).toThrow()
    const narrowed = identities.create({ name: "Boxes", runners: ["box"] })
    await expect(identities.saveSigning(narrowed.id, { kind: "agent", publicKey: pub })).rejects.toThrow(/runs only on an Upstash box/)
  })
})

describe("the identities migration", () => {
  it("puts every existing project on the Default identity", () => {
    const db = new Database(":memory:")
    const at = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE identities"))
    migrate(db, at)
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_old', 'old', 1, 1)").run()
    migrate(db)
    expect(db.prepare("SELECT identity_id FROM projects WHERE id = 'prj_old'").get()).toEqual({ identity_id: DEFAULT_IDENTITY_ID })
    expect(db.prepare("SELECT id, name, is_default FROM identities").all()).toEqual([{ id: DEFAULT_IDENTITY_ID, name: "Default", is_default: 1 }])
  })
})
