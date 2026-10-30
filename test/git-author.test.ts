import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { FALLBACK_AUTHOR, GithubAuthors, chooseAuthor, githubAuthor, hostGitScript, parseHostGit, readHostGit, type AuthorChain } from "../server/gitAuthor.js"
import { tmpDir } from "./helpers.js"

// The commit author chain (server/gitAuthor.ts), one step at a time: the project's or identity's author, Settings'
// Git author, this computer's git config (includeIf too), the GitHub account behind the token, then the fallback.

const NONE = { name: "", email: "" }
const ADA = { name: "Ada Lovelace", email: "ada@example.com" }
/** A chain where nothing is there, for each test to fill in. */
const chain = (o: Partial<AuthorChain> = {}): AuthorChain => ({ env: {}, identityAuthor: false, settings: NONE, host: null, github: { skipped: "the turn has no GitHub token" }, ...o })
const authorVars = (a: { name: string; email: string }) => ({ GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email })

/** A fake GitHub GET /user that counts its calls. */
function fakeGithub(accounts: Record<string, { login: string; id: number; name: string | null } | "down">) {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const token = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "")
    calls.push(`${String(input)} ${token}`)
    const a = accounts[token]
    if (a === "down") throw new TypeError("fetch failed")
    if (!a) return Response.json({ message: "Bad credentials" }, { status: 401 })
    return Response.json(a)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe("the author chain", () => {
  it("1. keeps the project's or identity's author that turnEnv set, and asks nothing else", async () => {
    let asked = false
    const github = async () => ((asked = true), ADA)
    expect(await chooseAuthor(chain({ env: authorVars(ADA), identityAuthor: true, settings: { name: "S", email: "s@x" }, github }))).toMatchObject({ source: "identity", author: null })
    expect(await chooseAuthor(chain({ env: authorVars(ADA), identityAuthor: false, github }))).toMatchObject({ source: "project", author: null })
    expect(asked).toBe(false)
  })

  it("2. takes Settings' Git author (GIT_USER_NAME / GIT_USER_EMAIL) before this computer and GitHub, and only with both", async () => {
    let asked = false
    const read = async () => ((asked = true), { name: "Host", email: "host@x", signing: null })
    const settings = await chooseAuthor(chain({ settings: { name: " Sam ", email: "sam@example.com" }, host: { mode: "native", read }, github: async () => ADA }))
    expect(settings).toEqual({ source: "settings", author: { name: "Sam", email: "sam@example.com" }, skipped: ["its identity has no author"], note: null })
    expect(asked).toBe(false)
    // A name alone isn't an author.
    expect((await chooseAuthor(chain({ settings: { name: "Sam", email: "" }, github: async () => ADA }))).source).toBe("github")
  })

  it("3. on the local runner leaves the author to this computer's git, and in a container puts its name and email in the env", async () => {
    const host = { name: "Cody", email: "cody@example.com", signing: { format: "ssh", key: "~/.ssh/id.pub", program: "" } }
    expect(await chooseAuthor(chain({ host: { mode: "native", read: async () => host } }))).toMatchObject({ source: "host", author: null, note: null })
    const docker = await chooseAuthor(chain({ host: { mode: "env", read: async () => host } }))
    expect(docker).toMatchObject({ source: "host", author: { name: "Cody", email: "cody@example.com" } })
    // Its signing key can't follow into the container: the task's log says so.
    expect(docker.note).toMatch(/signs commits \(ssh\), but its key doesn't reach the container/)
    expect((await chooseAuthor(chain({ host: { mode: "env", read: async () => ({ ...host, signing: null }) } }))).note).toBeNull()
    // No user.name or user.email here: on to GitHub.
    const none = await chooseAuthor(chain({ host: { mode: "native", read: async () => null }, github: async () => ADA }))
    expect(none).toMatchObject({ source: "github", author: ADA })
    expect(none.skipped).toContain("this computer's git config has no user.name and user.email")
  })

  it("4. uses the GitHub account behind the token, with its noreply email", async () => {
    expect(githubAuthor({ login: "octocat", id: 583231, name: "The Octocat" })).toEqual({ name: "The Octocat", email: "583231+octocat@users.noreply.github.com" })
    expect(githubAuthor({ login: "octocat", id: 583231, name: null })).toEqual({ name: "octocat", email: "583231+octocat@users.noreply.github.com" })
    expect(githubAuthor({ login: "octocat", id: 583231, name: "  " }).name).toBe("octocat")
    const a = await chooseAuthor(chain({ host: { skipped: "its identity keeps off this computer's git config" }, github: async () => ({ name: "octocat", email: "1+octocat@users.noreply.github.com" }) }))
    expect(a).toMatchObject({ source: "github", author: { name: "octocat", email: "1+octocat@users.noreply.github.com" } })
  })

  it("5. falls back to Box Yard Agent only when every step came up empty, and says why each did", async () => {
    const a = await chooseAuthor(chain({ host: { mode: "native", read: async () => null }, github: async () => "GitHub doesn't accept this token (401): it's wrong, revoked or expired." }))
    expect(a.source).toBe("fallback")
    expect(a.author).toEqual(FALLBACK_AUTHOR)
    expect(a.author).toEqual({ name: "Box Yard Agent", email: "box-yard@users.noreply.github.com" })
    expect(a.skipped).toEqual([
      "its identity has no author",
      "Settings › Credentials › Git author (GIT_USER_NAME / GIT_USER_EMAIL) isn't set",
      "this computer's git config has no user.name and user.email",
      "the GitHub account behind its token couldn't be read: GitHub doesn't accept this token (401): it's wrong, revoked or expired",
    ])
    // A host read that throws counts as nothing there, not as a failed turn.
    expect((await chooseAuthor(chain({ host: { mode: "native", read: async () => { throw new Error("exec failed") } } }))).source).toBe("fallback")
  })
})

describe("GithubAuthors", () => {
  it("asks GitHub once per token and remembers the answer", async () => {
    const gh = fakeGithub({ "tok-a": { login: "octocat", id: 1, name: "Octo" }, "tok-b": { login: "hubot", id: 2, name: null } })
    const authors = new GithubAuthors(gh.fetch)
    const [a1, a2] = await Promise.all([authors.author("tok-a"), authors.author("tok-a")])
    expect(a1).toEqual({ name: "Octo", email: "1+octocat@users.noreply.github.com" })
    expect(a2).toEqual(a1)
    expect(await authors.author("tok-a")).toEqual(a1)
    expect(await authors.author("tok-b")).toEqual({ name: "hubot", email: "2+hubot@users.noreply.github.com" })
    expect(gh.calls).toEqual(["https://api.github.com/user tok-a", "https://api.github.com/user tok-b"])
  })

  it("remembers a failure for a while, then asks again", async () => {
    let now = 1_000_000
    const accounts: Record<string, { login: string; id: number; name: string | null } | "down"> = { "tok-a": "down" }
    const gh = fakeGithub(accounts)
    const authors = new GithubAuthors(gh.fetch, () => now)
    expect(await authors.author("tok-a")).toMatch(/Couldn't reach GitHub/)
    expect(await authors.author("tok-bad")).toMatch(/401/)
    expect(await authors.author("tok-a")).toMatch(/Couldn't reach GitHub/)
    expect(gh.calls).toHaveLength(2)
    accounts["tok-a"] = { login: "octocat", id: 1, name: null }
    now += 11 * 60_000
    expect(await authors.author("tok-a")).toEqual({ name: "octocat", email: "1+octocat@users.noreply.github.com" })
    expect(gh.calls).toHaveLength(3)
    // No answer ever holds the token.
    for (const t of ["tok-a", "tok-bad"]) expect(JSON.stringify(await authors.author(t))).not.toContain(t)
  })
})

describe("this computer's git config", () => {
  /** A HOME with a global author, and an includeIf for repos under work/acme that gives them another one that signs. */
  function home() {
    const root = fs.realpathSync(tmpDir("git-author-"))
    const h = path.join(root, "home")
    fs.mkdirSync(h)
    fs.writeFileSync(
      path.join(h, ".gitconfig"),
      `[user]\n  name = Host Person\n  email = host@example.com\n[includeIf "gitdir:${root}/work/acme/"]\n  path = ${h}/acme.gitconfig\n`,
    )
    fs.writeFileSync(
      path.join(h, "acme.gitconfig"),
      `[user]\n  name = Acme Person\n  email = me@acme.dev\n  signingkey = ${h}/.ssh/id_acme.pub\n[commit]\n  gpgsign = true\n[gpg]\n  format = ssh\n[gpg "ssh"]\n  program = /usr/bin/ssh-keygen\n`,
    )
    const env = { ...process.env, HOME: h, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(h, ".gitconfig") }
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR"]) delete env[k]
    const repo = (rel: string) => {
      const dir = path.join(root, rel)
      fs.mkdirSync(dir, { recursive: true })
      execFileSync("git", ["init", "-q", dir], { env })
      return dir
    }
    const read = (dir: string | null) => parseHostGit(execFileSync("sh", ["-c", hostGitScript(dir)], { env }).toString())
    return { root, env, repo, read }
  }

  it("reads the author the repo's own git would use, includeIf and signing included", async () => {
    const h = home()
    expect(h.read(h.repo("work/other/r"))).toEqual({ name: "Host Person", email: "host@example.com", signing: null })
    const acme = h.repo("work/acme/r")
    expect(h.read(acme)).toEqual({ name: "Acme Person", email: "me@acme.dev", signing: { format: "ssh", key: `${path.join(h.root, "home")}/.ssh/id_acme.pub`, program: "/usr/bin/ssh-keygen" } })
    // Without a repo (a Docker container's repo isn't on this disk): the global config alone.
    expect(h.read(null)).toEqual({ name: "Host Person", email: "host@example.com", signing: null })
    expect(await readHostGit(h.env)).toEqual({ name: "Host Person", email: "host@example.com", signing: null })
  })

  it("drops the fallback author an older clone wrote into the repo's config, and keeps one the repo chose", () => {
    const h = home()
    const acme = h.repo("work/acme/r")
    execFileSync("git", ["-C", acme, "config", "user.name", "Box Yard Agent"], { env: h.env })
    execFileSync("git", ["-C", acme, "config", "user.email", "box-yard@users.noreply.github.com"], { env: h.env })
    expect(h.read(acme)).toMatchObject({ name: "Acme Person", email: "me@acme.dev" })
    expect(execFileSync("git", ["-C", acme, "config", "--local", "--list"], { env: h.env }).toString()).not.toMatch(/user\./)
    // A commit there is by the includeIf author now.
    execFileSync("git", ["-C", acme, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"], { env: h.env })
    expect(execFileSync("git", ["-C", acme, "log", "-1", "--format=%an <%ae>"], { env: h.env }).toString().trim()).toBe("Acme Person <me@acme.dev>")

    const own = h.repo("work/other/own")
    execFileSync("git", ["-C", own, "config", "user.name", "Repo Person"], { env: h.env })
    expect(h.read(own)).toMatchObject({ name: "Repo Person", email: "host@example.com" })
  })

  it("says nothing's there without user.name and user.email", () => {
    const h = home()
    fs.writeFileSync(path.join(h.root, "home", ".gitconfig"), "[user]\n  name = Only A Name\n")
    expect(h.read(h.repo("work/other/r"))).toBeNull()
    expect(h.read(path.join(h.root, "missing"))).toBeNull()
    expect(parseHostGit("")).toBeNull()
  })
})
