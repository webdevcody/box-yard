import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  IdentityDetector,
  githubOwnerOf,
  parseGhAuthStatus,
  parseGitConfigList,
  parseSshConfig,
  parseTokenRef,
  proposeIdentities,
  readComputer,
  remoteUrls,
  shellWords,
  sshCommandKey,
} from "../server/identity/detect.js"
import { fingerprintOfPublicKey } from "../server/identity/sshKeys.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { tmpDir } from "./helpers.js"
import { STATUS, TOKENS, computer, github } from "./identityFixtures.js"

// Detection reads this computer's gh, git and ssh setup and proposes identities by reference, never by value
// (docs/identities.md › Set up from this computer). Every fixture here is made up: octocat, octo-acme, acme-corp.

describe("parsers", () => {
  it("read gh's accounts and drop every token line", () => {
    const accounts = parseGhAuthStatus(STATUS)
    expect(accounts).toEqual([
      { host: "github.com", login: "octocat", active: true, protocol: "https", scopes: ["gist", "read:org", "repo", "workflow"], storage: "keyring", problem: null },
      { host: "github.com", login: "octo-acme", active: false, protocol: "ssh", scopes: ["repo"], storage: "/home/u/.config/gh/hosts.yml", problem: null },
      { host: "ghe.acme.dev", login: "acme-admin", active: true, protocol: null, scopes: null, storage: "keyring", problem: expect.stringContaining("invalid") },
    ])
    expect(JSON.stringify(accounts)).not.toContain("gho_")
    // gh before 2.40: one account per host, so it's the active one.
    expect(parseGhAuthStatus("github.com\n  ✓ Logged in to github.com as octocat (/home/u/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use ssh protocol.\n  ✓ Token: gho_****\n  ✓ Token scopes: gist, repo\n")).toEqual([
      { host: "github.com", login: "octocat", active: true, protocol: "ssh", scopes: ["gist", "repo"], storage: "/home/u/.config/gh/hosts.yml", problem: null },
    ])
    expect(parseGhAuthStatus("You are not logged into any GitHub hosts. To log in, run: gh auth login\n")).toEqual([])
  })

  it("read git config --list --null --show-origin", () => {
    const out = "file:/h/.gitconfig\0user.name\nOcto Cat\0file:/h/.gitconfig\0includeif.gitdir:~/Work/Acme/.path\nacme.inc\0file:/h/.gitconfig\0core.bare\0file:/h/.gitconfig\0alias.lg\nlog\n--graph\0"
    expect(parseGitConfigList(out)).toEqual([
      { file: "/h/.gitconfig", key: "user.name", value: "Octo Cat" },
      { file: "/h/.gitconfig", key: "includeif.gitdir:~/Work/Acme/.path", value: "acme.inc" },
      { file: "/h/.gitconfig", key: "core.bare", value: null },
      { file: "/h/.gitconfig", key: "alias.lg", value: "log\n--graph" },
    ])
    expect(parseGitConfigList("user.email\na@b.c\0", false)).toEqual([{ file: "", key: "user.email", value: "a@b.c" }])
  })

  it("find the key a core.sshCommand logs in with", () => {
    expect(shellWords(`ssh -i "~/my keys/id" -o 'IdentitiesOnly yes' a\\ b`)).toEqual(["ssh", "-i", "~/my keys/id", "-o", "IdentitiesOnly yes", "a b"])
    expect(sshCommandKey("ssh -i ~/.ssh/acme -o IdentitiesOnly=yes")).toBe("~/.ssh/acme")
    expect(sshCommandKey("ssh -i~/.ssh/acme")).toBe("~/.ssh/acme")
    expect(sshCommandKey("ssh -o IdentityFile=/k/acme -F /dev/null")).toBe("/k/acme")
    expect(sshCommandKey("ssh -v")).toBeNull()
  })

  it("read ~/.ssh/config's Host blocks", () => {
    const text = `IdentityFile ~/.ssh/everywhere
# work
Host github-acme gh-acme
  HostName github.com
  IdentityFile ~/.ssh/acme
  IdentityFile ~/.ssh/ignored
Host github.com
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
Match host *.internal
  IdentityFile ~/.ssh/internal
Host box
  HostName=10.0.0.2
`
    const hosts = parseSshConfig(text)
    expect(hosts.map((h) => h.patterns)).toEqual([["*"], ["github-acme", "gh-acme"], ["github.com"], ["box"]])
    expect(hosts[1]).toEqual({ patterns: ["github-acme", "gh-acme"], hostName: "github.com", identityFiles: ["~/.ssh/acme", "~/.ssh/ignored"], identityAgent: null })
    expect(hosts[2]!.identityAgent).toBe("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock")
    expect(hosts.flatMap((h) => h.identityFiles)).not.toContain("~/.ssh/internal")
    expect(hosts[3]!.hostName).toBe("10.0.0.2")
  })

  it("tell a GitHub owner from a remote URL", () => {
    const aliases = new Set(["github-acme"])
    expect(githubOwnerOf("https://github.com/Acme-Corp/app.git")).toBe("acme-corp")
    expect(githubOwnerOf("git@github.com:octocat/site.git")).toBe("octocat")
    expect(githubOwnerOf("ssh://git@github.com:22/octocat/site")).toBe("octocat")
    expect(githubOwnerOf("https://x-access-token@github.com/octocat/site")).toBe("octocat")
    expect(githubOwnerOf("git@github-acme:acme-corp/app.git", aliases)).toBe("acme-corp")
    expect(githubOwnerOf("git@github-acme:acme-corp/app.git")).toBeNull()
    expect(githubOwnerOf("https://gitlab.com/acme/app")).toBeNull()
    expect(githubOwnerOf("https://github.com/acme/**")).toBe("acme")
    expect(remoteUrls(`[core]\n\turl = nope\n[remote "origin"]\n\turl = git@github.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "up"]\n  url = "https://github.com/c/d"\n[branch "main"]\n\tremote = origin\n`)).toEqual(["git@github.com:a/b.git", "https://github.com/c/d"])
  })

  it("read gh: references", () => {
    expect(parseTokenRef("gh:octocat")).toEqual({ host: "github.com", login: "octocat" })
    expect(parseTokenRef("gh:github.com:octo-acme")).toEqual({ host: "github.com", login: "octo-acme" })
    expect(parseTokenRef("gho_abc")).toBeNull()
    expect(parseTokenRef("gh:bad--name")).toBeNull()
  })

  it("compute a fingerprint as ssh-keygen does", () => {
    const dir = tmpDir("detect-fp-")
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "x", "-f", path.join(dir, "k")])
    const pub = fs.readFileSync(path.join(dir, "k.pub"), "utf8")
    const keygen = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", path.join(dir, "k.pub")], { encoding: "utf8" })
    expect(keygen).toContain(fingerprintOfPublicKey(pub))
  })
})

const PROJECTS = [
  { id: "p_site", name: "site", repo: "https://github.com/octocat/site", identityId: DEFAULT_IDENTITY_ID },
  { id: "p_app", name: "app", repo: "acme-corp/app", identityId: DEFAULT_IDENTITY_ID },
  { id: "p_else", name: "else", repo: "someone/else", identityId: DEFAULT_IDENTITY_ID },
  { id: "p_none", name: "scratch", repo: null, identityId: DEFAULT_IDENTITY_ID },
]
const DEFAULT = { id: DEFAULT_IDENTITY_ID, name: "Default", isDefault: true, githubLogin: null }

describe("detection on a made-up computer", () => {
  it("reads gh, git and ssh, without GH_TOKEN, and no result holds a token or a private key", async () => {
    const c = computer()
    const facts = await readComputer({ home: c.home, env: c.env })
    expect(facts.accounts.map((a) => [a.login, a.active, a.tokenRef])).toEqual([
      ["octocat", true, "gh:github.com:octocat"],
      ["octo-acme", false, "gh:github.com:octo-acme"],
      ["acme-admin", true, "gh:ghe.acme.dev:acme-admin"],
    ])
    const [global, acme] = facts.authors
    expect(global).toMatchObject({ scope: "global", file: "~/.gitconfig", name: "Octo Cat", email: "octocat@example.com", signing: null, repoOwners: [] })
    expect(acme).toMatchObject({
      scope: "gitdir:~/work/acme/",
      file: "~/.gitconfig-acme",
      name: "Acme Octo",
      email: "octo@acme.dev",
      sshKey: "~/.ssh/acme",
      sshKeyFingerprint: fingerprintOfPublicKey(c.keys.acme),
      repoOwners: ["acme-corp"],
      signing: { format: "ssh", kind: "file", ref: "file:~/.ssh/acme_signing", fingerprint: fingerprintOfPublicKey(c.keys.signing), signsByDefault: true, problem: null, warning: null },
    })
    expect(facts.sshHosts).toEqual([{ alias: "github-acme", keyFile: "~/.ssh/acme", keyFingerprint: fingerprintOfPublicKey(c.keys.acme), agent: null }])
    // A helper's name only: the inline one holds a password.
    expect(facts.credentialHelpers).toEqual(["osxkeychain", "a shell command"])
    expect(facts.notes.join("\n")).toContain("~/gone/")
    const text = JSON.stringify(facts)
    for (const secret of [...Object.values(TOKENS), "hunter2", "PRIVATE KEY"]) expect(text).not.toContain(secret)
    expect(fs.readFileSync(c.log, "utf8")).not.toContain("env token seen")
    // Offline, gh is asked who is signed in, never for a token.
    expect(fs.readFileSync(c.log, "utf8").trim().split("\n")).toEqual(["auth status"])
  })

  it("proposes identities offline from owners alone, and says what it couldn't match", async () => {
    const c = computer()
    const d = new IdentityDetector({ home: c.home, env: c.env, github: async () => { throw new Error("offline detection asked GitHub") } })
    const r = await d.detect({ projects: PROJECTS, identities: [DEFAULT], online: false })
    expect(r.proposals.map((p) => [p.login, p.isDefaultToday, p.projects.map((x) => x.id)])).toEqual([
      ["octocat", true, ["p_site"]],
      ["octo-acme", false, []],
    ])
    expect(r.proposals[0]!.author).toEqual({ name: "Octo Cat", email: "octocat@example.com", from: "the global git config (~/.gitconfig)" })
    expect(r.unmatched.map((x) => [x.id, x.why])).toEqual([
      ["p_app", "no account here is or belongs to acme-corp (detect online to check orgs and push access)"],
      ["p_else", "no account here is or belongs to someone (detect online to check orgs and push access)"],
      ["p_none", "it has no GitHub repo"],
    ])
    expect(r.notes.join("\n")).toMatch(/ghe\.acme\.dev.*github\.com only/)
    expect(r.notes.join("\n")).toMatch(/includeIf "gitdir:~\/work\/acme\/" block \(author octo@acme\.dev\) for acme-corp matches no gh account here yet: GitHub wasn't asked[\s\S]*Detect online first/)
    expect(d.recent()).toBe(r)
  })

  it("proposes identities online: orgs, emails, keys and push access tie the acme block and repo to octo-acme", async () => {
    const c = computer()
    const g = github(c.keys)
    const r = await new IdentityDetector({ home: c.home, env: c.env, github: g.fetch }).detect({ projects: PROJECTS, identities: [DEFAULT], online: true })
    const acme = r.proposals.find((p) => p.login === "octo-acme")!
    expect(acme).toMatchObject({
      name: "octo-acme",
      tokenRef: "gh:github.com:octo-acme",
      owners: ["octo-acme", "acme-corp"],
      author: { name: "Acme Octo", email: "octo@acme.dev", from: `includeIf "gitdir:~/work/acme/" (~/.gitconfig-acme)` },
      signing: { kind: "file", ref: "file:~/.ssh/acme_signing" },
      projects: [{ id: "p_app", why: "octo-acme can push to acme-corp/app", currentIdentity: "Default" }],
      isDefaultToday: false,
      existing: null,
    })
    expect(acme.evidence.join("\n")).toContain("its email octo@acme.dev is one of octo-acme's verified emails")
    expect(acme.evidence.join("\n")).toContain("its SSH key ~/.ssh/acme is one of octo-acme's on GitHub")
    expect(acme.evidence.join("\n")).toContain("is on GitHub as octo-acme's signing key")
    expect(r.proposals.find((p) => p.login === "octocat")!.projects.map((x) => x.id)).toEqual(["p_site"])
    expect(r.unmatched.map((x) => [x.id, x.why])).toEqual([
      ["p_else", "no account here can push to someone/else"],
      ["p_none", "it has no GitHub repo"],
    ])
    expect(r.accounts.find((a) => a.login === "octo-acme")).toMatchObject({ githubId: 101, orgs: ["acme-corp"], verifiedEmails: ["octo@acme.dev"], signingKeys: [fingerprintOfPublicKey(c.keys.signing)] })
    // Each token went only to GitHub, for its own account; the failed GHE account wasn't asked about.
    expect(g.calls.every((x) => !x.startsWith("?"))).toBe(true)
    expect(fs.readFileSync(c.log, "utf8")).not.toContain("acme-admin")
    const text = JSON.stringify(r)
    for (const secret of [...Object.values(TOKENS), "PRIVATE KEY"]) expect(text).not.toContain(secret)
  })

  it("keeps a project on the identity it already uses, and names an existing identity for the login", () => {
    const facts = { accounts: [], authors: [], sshHosts: [], credentialHelpers: [], loginKeys: [], notes: [] }
    const account = (login: string, active: boolean) => ({ host: "github.com", login, active, protocol: null, scopes: null, storage: "keyring", tokenRef: `gh:github.com:${login}`, githubId: null, name: null, orgs: ["acme-corp"], verifiedEmails: null, signingKeys: null, sshKeys: null, problem: null })
    const r = proposeIdentities({
      facts: { ...facts, accounts: [account("octocat", true), account("octo-acme", false)] },
      online: false,
      push: null,
      projects: [
        { id: "p1", name: "one", repo: "acme-corp/one", identityId: "idn_acme" },
        { id: "p2", name: "two", repo: "acme-corp/two", identityId: DEFAULT_IDENTITY_ID },
        { id: "p3", name: "three", repo: "acme-corp/three", identityId: "idn_other" },
      ],
      identities: [DEFAULT, { id: "idn_acme", name: "Acme", isDefault: false, githubLogin: "Octo-Acme" }, { id: "idn_other", name: "Other", isDefault: false, githubLogin: "someone" }],
    })
    expect(r.proposals.map((p) => [p.login, p.name, p.existing?.id ?? null, p.projects.map((x) => x.id)])).toEqual([
      ["octocat", "octocat", null, ["p2"]],
      ["octo-acme", "Acme", "idn_acme", ["p1"]],
    ])
    expect(r.unmatched).toEqual([expect.objectContaining({ id: "p3", why: "octocat and octo-acme could each serve acme-corp/three: pick one", currentIdentity: "Other" })])
  })
})

describe("references, resolved on the server", () => {
  it("reads gh's token for a gh: reference, and only for an account gh has", async () => {
    const c = computer()
    const d = new IdentityDetector({ home: c.home, env: c.env })
    expect(await d.tokenFromRef("gh:octo-acme")).toEqual({ host: "github.com", login: "octo-acme", token: TOKENS["octo-acme"] })
    await expect(d.tokenFromRef("gh:nobody")).rejects.toThrow(/gh isn't signed in to nobody on github\.com/)
    await expect(d.tokenFromRef(TOKENS.octocat!)).rejects.toThrow(/isn't a token reference/)
    await expect(d.tokenFromRef("gh:ghe.acme.dev:acme-admin")).rejects.toThrow(/github\.com accounts only/)
    expect(fs.readFileSync(c.log, "utf8")).toContain("auth token --hostname github.com --user octo-acme")
  })

  it("reads a key file only from ~/.ssh or a git config's signing key, and says which keys also log in", async () => {
    const c = computer()
    const d = new IdentityDetector({ home: c.home, env: c.env })
    const acme = await d.signingFromRef("file:~/.ssh/acme_signing", { requireSigned: true })
    expect(acme).toMatchObject({ input: { kind: "file", requireSigned: true }, loginKey: false, label: "~/.ssh/acme_signing" })
    expect((acme.input as { privateKey: string }).privateKey).toContain("BEGIN OPENSSH PRIVATE KEY")
    expect((await d.signingFromRef(`file:${c.home}/.ssh/id_ed25519`)).loginKey).toBe(true)
    expect((await d.signingFromRef("file:~/.ssh/acme")).loginKey).toBe(true)
    // Outside ~/.ssh: refused before it's read, and the error never quotes the file.
    fs.writeFileSync(path.join(c.home, "notes.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-looking\n")
    await expect(d.signingFromRef("file:~/notes.txt")).rejects.toThrow(/only from ~\/\.ssh/)
    await expect(d.signingFromRef("file:~/.ssh/acme_signing.pub")).rejects.toThrow(/agent:<its fingerprint>/)
    await expect(d.signingFromRef("file:~/.ssh/nope")).rejects.toThrow(/no key file at ~\/\.ssh\/nope/)
    fs.symlinkSync(path.join(c.home, "notes.txt"), path.join(c.home, ".ssh", "sneaky"))
    await expect(d.signingFromRef("file:~/.ssh/sneaky")).rejects.toThrow(/only from ~\/\.ssh/)
  })

  it("finds an agent key by fingerprint in the git configs and ~/.ssh", async () => {
    const c = computer()
    const d = new IdentityDetector({ home: c.home, env: { ...c.env, SSH_AUTH_SOCK: "" } })
    const fp = fingerprintOfPublicKey(c.keys.locked)
    expect(await d.signingFromRef(`agent:${fp}`)).toEqual({ input: { kind: "agent", publicKey: c.keys.locked, program: null, requireSigned: undefined }, loginKey: false, label: fp })
    expect((await d.signingFromRef(`agent:${c.keys.acme}`, { program: "/opt/op-ssh-sign" })).input).toMatchObject({ kind: "agent", publicKey: c.keys.acme, program: "/opt/op-ssh-sign" })
    await expect(d.signingFromRef("agent:SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow(/No key with fingerprint/)
    await expect(d.signingFromRef("key::ssh-ed25519 AAAA")).rejects.toThrow(/isn't a signing key reference/)
  })

  it("marks a signing key that is also a login key, and a key with a passphrase as agent-only", async () => {
    const c = computer()
    fs.appendFileSync(path.join(c.home, ".gitconfig"), `[includeIf "gitdir:~/oss/"]\n\tpath = ~/.gitconfig-oss\n[includeIf "gitdir:~/locked/"]\n\tpath = ~/.gitconfig-locked\n`)
    fs.writeFileSync(path.join(c.home, ".gitconfig-oss"), `[user]\n\tsigningKey = ~/.ssh/id_ed25519\n[gpg]\n\tformat = ssh\n`)
    fs.writeFileSync(path.join(c.home, ".gitconfig-locked"), `[user]\n\tsigningKey = ~/.ssh/locked\n[gpg]\n\tformat = ssh\n`)
    const facts = await readComputer({ home: c.home, env: c.env })
    const oss = facts.authors.find((a) => a.scope === "gitdir:~/oss/")!
    expect(oss.signing).toMatchObject({ kind: "file", ref: "file:~/.ssh/id_ed25519", warning: expect.stringContaining("also a key this computer logs in") })
    const locked = facts.authors.find((a) => a.scope === "gitdir:~/locked/")!
    expect(locked.signing).toMatchObject({ kind: "agent", ref: `agent:${fingerprintOfPublicKey(c.keys.locked)}`, problem: expect.stringContaining("has a passphrase") })
    // The global author goes with each block it doesn't override.
    expect(oss).toMatchObject({ name: "Octo Cat", email: "octocat@example.com" })
  })
})
