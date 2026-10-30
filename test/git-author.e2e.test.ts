import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import type { Identity } from "../shared/identities.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { SetupStatus } from "../shared/setup.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Who a turn's commits are by, end to end (server/gitAuthor.ts, docs/identities.md "Git author"): what task.json hands
// the runner for each step of the chain, the fallback's warning in the task's log and in Settings, and on the local
// runner, commits by this computer's own git config (includeIf too).

const OCTO = { login: "octocat", id: 583231, name: "The Octocat" }
const GITHUB_AUTHOR = ["GIT_AUTHOR_EMAIL=583231+octocat@users.noreply.github.com", "GIT_AUTHOR_NAME=The Octocat", "GIT_COMMITTER_EMAIL=583231+octocat@users.noreply.github.com", "GIT_COMMITTER_NAME=The Octocat"]
const FALLBACK = ["GIT_AUTHOR_EMAIL=box-yard@users.noreply.github.com", "GIT_AUTHOR_NAME=Box Yard Agent", "GIT_COMMITTER_EMAIL=box-yard@users.noreply.github.com", "GIT_COMMITTER_NAME=Box Yard Agent"]

/** GitHub's GET /user for the one token it knows; counts the calls. */
function fakeGithub() {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const token = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "")
    calls.push(url)
    if (token !== "tok-octo-0001") return Response.json({ message: "Bad credentials" }, { status: 401 })
    if (url === "https://api.github.com/user") return Response.json(OCTO)
    return Response.json({ message: "Not Found" }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** The local runner with this computer's git config in a temp HOME. */
class HomeRunner extends LocalRunnerProvider {
  constructor(
    dir: string,
    private readonly home: string,
  ) {
    super(dir, FAKE_CLAUDE)
  }
  protected override env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home, GIT_CONFIG_GLOBAL: path.join(this.home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[k]
    return env
  }
  /** What a command run in its turns sees. */
  turnEnv() {
    return this.env()
  }
}

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(o: { config?: Partial<Config>; github?: boolean; local?: LocalRunnerProvider } = {}) {
  const dir = tmpDir("git-author-e2e-")
  const port = await freePort()
  const gh = fakeGithub()
  const config = testConfig({ port, maxBoxes: 4, ...o.config })
  const yard = createBoxYard(config, {
    webDir: "/nonexistent",
    provider: new LocalProvider(path.join(dir, "boxes"), FAKE_CLAUDE),
    localRunner: o.local,
    github: o.github === false ? undefined : { fetch: gh.fetch, token: () => null },
  })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
    return JSON.parse(text) as T
  }
  /** Runs a task (or a follow-up) to the end; returns its task.json's author vars and where they came from. */
  const runTask = async (project: Project, taskId?: string) => {
    const turns = taskId ? yard.store.getTask(taskId)!.turnCount + 1 : 1
    const task = taskId ? yard.store.getTask(taskId)! : await call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt: "Say hi" })
    if (taskId) await call("POST", `/api/tasks/${taskId}/messages`, { content: "again" })
    const done = await waitFor(() => {
      const t = yard.store.getTask(task.id)
      return t?.status === "done" && t.turnCount >= turns && !t.currentTurnId ? t : null
    }, "the task's turn to end", 30_000)
    const json = JSON.parse(fs.readFileSync(path.join(yard.tasks.taskDir(done.boxId!, task.id), "task.json"), "utf8")) as { env: Record<string, string>; authorSource: string }
    const author = Object.entries(json.env)
      .filter(([k]) => /^GIT_(AUTHOR|COMMITTER)_/.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .sort()
    return { task: done, author, source: json.authorSource }
  }
  const events = (taskId: string) =>
    yard.store
      .listTaskMessages(taskId, 500)
      .filter((m) => m.role === "event")
      .map((m) => m.content)
  return { yard, call, runTask, events, gh }
}

describe("a turn's git author", () => {
  it("on a box with no other author is the GitHub account behind its token, asked once per token", async () => {
    const r = await start({ config: { githubToken: "tok-octo-0001" } })
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })
    const first = await r.runTask(plain)
    expect(first).toMatchObject({ author: GITHUB_AUTHOR, source: "github" })
    expect(first.task.boxId).toMatch(/^local-/)
    expect(await r.runTask(plain, first.task.id)).toMatchObject({ author: GITHUB_AUTHOR, source: "github" })
    expect(r.gh.calls.filter((u) => u === "https://api.github.com/user")).toHaveLength(1)
    // Nothing to warn about.
    expect(r.events(first.task.id).join("\n")).not.toMatch(/Box Yard Agent/)
    expect((await r.call<SetupStatus>("GET", "/api/setup")).authorFallbacks).toEqual([])
  })

  it("takes Settings' Git author over GitHub's, GIT_USER_NAME when nothing's saved, and the identity's over both", async () => {
    const fromEnv = await start({ config: { githubToken: "tok-octo-0001", gitUserName: "Env Person", gitUserEmail: "env@example.com" } })
    const p = await fromEnv.call<Project>("POST", "/api/projects", { name: "plain" })
    const t = await fromEnv.runTask(p)
    expect(t).toMatchObject({ source: "settings", author: ["GIT_AUTHOR_EMAIL=env@example.com", "GIT_AUTHOR_NAME=Env Person", "GIT_COMMITTER_EMAIL=env@example.com", "GIT_COMMITTER_NAME=Env Person"] })
    // Saved in Settings › Credentials, it wins over the env var.
    await fromEnv.call("PUT", "/api/agent-settings", { gitUserName: "Saved Person", gitUserEmail: "saved@example.com" })
    expect((await fromEnv.runTask(p, t.task.id)).author).toContain("GIT_AUTHOR_NAME=Saved Person")
    expect(fromEnv.gh.calls).toEqual([])

    // An identity's author beats Settings'.
    const acme = await fromEnv.call<Identity>("POST", "/api/identities", { name: "Acme", author: { name: "Acme Bot", email: "bot@acme.dev" } })
    const onAcme = await fromEnv.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
    expect(await fromEnv.runTask(onAcme)).toMatchObject({ source: "identity", author: ["GIT_AUTHOR_EMAIL=bot@acme.dev", "GIT_AUTHOR_NAME=Acme Bot", "GIT_COMMITTER_EMAIL=bot@acme.dev", "GIT_COMMITTER_NAME=Acme Bot"] })
    // And a project's own GIT_AUTHOR_* env vars beat the identity's.
    await fromEnv.call("PATCH", `/api/projects/${onAcme.id}`, { env: { GIT_AUTHOR_NAME: "Project Person", GIT_AUTHOR_EMAIL: "p@example.com" } })
    const own = await fromEnv.runTask(onAcme)
    expect(own.source).toBe("project")
    expect(own.author).toEqual(expect.arrayContaining(["GIT_AUTHOR_NAME=Project Person", "GIT_AUTHOR_EMAIL=p@example.com"]))
  })

  it("is Box Yard Agent only when nothing else is there, with a warning in the task's log and in Settings until a real author comes back", async () => {
    // No token at all: GitHub can't say whose it is.
    const r = await start()
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })
    const first = await r.runTask(plain)
    expect(first).toMatchObject({ author: FALLBACK, source: "fallback" })
    const warning = r.events(first.task.id).filter((e) => e.startsWith("⚠️ This turn's commits go out as Box Yard Agent"))
    expect(warning).toEqual([
      "⚠️ This turn's commits go out as Box Yard Agent <box-yard@users.noreply.github.com>, unsigned: its identity has no author; Settings › Credentials › Git author (GIT_USER_NAME / GIT_USER_EMAIL) isn't set; the turn has no GitHub token. Set a Git author in Settings › Credentials, or an author on the project's identity (Settings › Identities).",
    ])
    const setup = await r.call<SetupStatus>("GET", "/api/setup")
    expect(setup.authorFallbacks).toEqual([{ projectId: plain.id, project: "plain", taskId: first.task.id, task: "Hello", at: expect.any(Number), why: expect.stringContaining("the turn has no GitHub token") }])

    // Once per task, not every turn.
    await r.runTask(plain, first.task.id)
    expect(r.events(first.task.id).filter((e) => e.startsWith("⚠️ This turn's commits"))).toHaveLength(1)

    // A token GitHub refuses falls back too, and says so.
    await r.call("PATCH", `/api/projects/${plain.id}`, { env: { GITHUB_TOKEN: "tok-revoked-01" } })
    const refused = await r.runTask(plain)
    expect(refused.source).toBe("fallback")
    expect(r.events(refused.task.id).join("\n")).toMatch(/the GitHub account behind its token couldn't be read: GitHub doesn't accept this token \(401\)/)
    expect(r.events(refused.task.id).join("\n")).not.toContain("tok-revoked-01")

    // A Git author in Settings: the next turn has it, and Settings stops warning.
    await r.call("PUT", "/api/agent-settings", { gitUserName: "Cody", gitUserEmail: "cody@example.com" })
    expect((await r.runTask(plain, refused.task.id)).source).toBe("settings")
    expect((await r.call<SetupStatus>("GET", "/api/setup")).authorFallbacks).toEqual([])
  })

  it("never asks a real GitHub in mock mode: without a fake one, a token alone still falls back, loudly", async () => {
    const r = await start({ github: false, config: { githubToken: "tok-octo-0001" } })
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })
    const t = await r.runTask(plain)
    expect(t.source).toBe("fallback")
    expect(r.events(t.task.id).join("\n")).toContain("mock mode doesn't ask GitHub whose token it is")
  })

  it("on this computer is this computer's own git config, includeIf for the repo's path and its signing included", async () => {
    const root = fs.realpathSync(tmpDir("git-author-home-"))
    const home = path.join(root, "home")
    const localDir = path.join(root, "workspaces")
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true })
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "acme", "-f", path.join(home, ".ssh", "id_acme")])
    fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n  name = Host Person\n  email = host@example.com\n[includeIf "gitdir:${localDir}/"]\n  path = ${home}/acme.gitconfig\n`)
    fs.writeFileSync(path.join(home, "acme.gitconfig"), `[user]\n  name = Acme Person\n  email = me@acme.dev\n  signingkey = ${home}/.ssh/id_acme.pub\n[commit]\n  gpgsign = true\n[gpg]\n  format = ssh\n`)
    // An origin to clone, served over file:// like GitHub.
    const bare = path.join(root, "origin.git")
    const seed = path.join(root, "seed")
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim()
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(root, "init", "-q", "-b", "main", seed)
    fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "init")
    git(seed, "push", "-q", bare, "main")

    const local = new HomeRunner(localDir, home)
    const r = await start({ local, config: { localDir, githubToken: "tok-octo-0001", gitPushAtTurnEnd: false } })
    const mac = await r.call<Project>("POST", "/api/projects", { name: "mac", runner: "local" })
    r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(`file://${bare}`, mac.id)
    const t = await r.runTask(mac)
    expect(t.task.boxId).toBe(LOCAL_BOX_ID)
    // Box Yard names no author: git picks it as it always does here. GitHub isn't asked.
    expect(t).toMatchObject({ source: "host", author: [] })
    expect(r.gh.calls).toEqual([])
    const work = path.join(localDir, t.task.id, "work")
    expect(execFileSync("git", ["-C", work, "config", "--local", "--list"]).toString()).not.toMatch(/^user\./m)

    // A commit the agent makes there is by the includeIf author, signed with its key.
    fs.writeFileSync(path.join(work, "note.md"), "hi\n")
    const env = local.turnEnv()
    execFileSync("git", ["-C", work, "add", "note.md"], { env })
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "note"], { env })
    expect(execFileSync("git", ["-C", work, "log", "-1", "--format=%an <%ae>"], { env }).toString().trim()).toBe("Acme Person <me@acme.dev>")
    expect(execFileSync("git", ["-C", work, "cat-file", "commit", "HEAD"], { env }).toString()).toContain("-----BEGIN SSH SIGNATURE-----")

    // A Settings Git author still comes first.
    await r.call("PUT", "/api/agent-settings", { gitUserName: "Cody", gitUserEmail: "cody@example.com" })
    expect((await r.runTask(mac, t.task.id)).source).toBe("settings")
  })

  it("on this computer without a git author goes on to the GitHub account", async () => {
    const root = fs.realpathSync(tmpDir("git-author-home-"))
    const home = path.join(root, "home")
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, ".gitconfig"), "[init]\n  defaultBranch = main\n")
    const r = await start({ local: new HomeRunner(path.join(root, "workspaces"), home), config: { localDir: path.join(root, "workspaces"), githubToken: "tok-octo-0001" } })
    const mac = await r.call<Project>("POST", "/api/projects", { name: "mac", runner: "local" })
    expect(await r.runTask(mac)).toMatchObject({ source: "github", author: GITHUB_AUTHOR })
  })
})
