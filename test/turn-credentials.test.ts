import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { execFileSync } from "node:child_process"
import { Box } from "@upstash/box"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { BOX_GIT_CREDENTIAL_SCRIPT, UpstashProvider } from "../server/providers/upstash.js"
import { turnEnv } from "../server/turnCredentials.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The leaks of the identities report: F1, an Upstash box's own git config stored the global GitHub token, which
// answered before a project's; F2, the global Claude login beat a project's own (Settings won, and box env held it
// for every agent on the box). A turn's credentials now come only from task.json: its project's first, exactly one
// Claude var, and the runner drops the rest from its environment.

const none = { claude: {}, githubToken: "" }

describe("turnEnv", () => {
  it("gives a turn its project's Claude login over a stronger global one", () => {
    const t = turnEnv({ CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" }, { claude: { ANTHROPIC_API_KEY: "global-key", CLAUDE_CODE_OAUTH_TOKEN: "global-oauth" }, githubToken: "" })
    expect(t.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" })
    expect(t.claudeFrom).toBe("project")
    expect(t.unsetEnv).toEqual(expect.arrayContaining(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]))
    expect(t.unsetEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("uses the strongest global login, alone, when the project has none", () => {
    const t = turnEnv({ FOO: "bar" }, { claude: { CLAUDE_CODE_OAUTH_TOKEN: "global-oauth", ANTHROPIC_API_KEY: "global-key" }, githubToken: "" })
    expect(t.env).toEqual({ FOO: "bar", ANTHROPIC_API_KEY: "global-key" })
    expect(t.claudeFrom).toBe("global")
    expect(t.unsetEnv).toEqual(expect.arrayContaining(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]))
  })

  it("keeps only the strongest of a project's own Claude vars, and empty ones don't count", () => {
    expect(turnEnv({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_AUTH_TOKEN: "a" }, none).env).toEqual({ ANTHROPIC_AUTH_TOKEN: "a" })
    expect(turnEnv({ ANTHROPIC_API_KEY: "" }, { claude: { CLAUDE_CODE_OAUTH_TOKEN: "g" }, githubToken: "" }).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "g" })
  })

  it("with no Claude login anywhere, sets none and drops any the box has (a local `claude` login is used)", () => {
    const t = turnEnv({}, none)
    expect(t.claudeFrom).toBeNull()
    expect(t.unsetEnv).toEqual(expect.arrayContaining(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]))
  })

  it("puts the project's GitHub token, else the global one, in both GITHUB_TOKEN and GH_TOKEN", () => {
    expect(turnEnv({ GITHUB_TOKEN: "project-gh" }, { claude: {}, githubToken: "global-gh" }).env).toEqual({ GITHUB_TOKEN: "project-gh", GH_TOKEN: "project-gh" })
    expect(turnEnv({ GH_TOKEN: "project-gh" }, { claude: {}, githubToken: "global-gh" }).env).toEqual({ GITHUB_TOKEN: "project-gh", GH_TOKEN: "project-gh" })
    const global = turnEnv({}, { claude: {}, githubToken: "global-gh" })
    expect(global.env).toEqual({ GITHUB_TOKEN: "global-gh", GH_TOKEN: "global-gh" })
    expect(global.unsetEnv).not.toContain("GH_TOKEN")
  })
})

describe("an Upstash box's own git credential (F1)", () => {
  /** A box's home: a global git config like Box.create's `git` option left, with the token in ~/.git-credentials. */
  function oldBox() {
    const home = tmpDir("f1-home-")
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
    const sh = (script: string, extra: Record<string, string> = {}) => execFileSync("bash", ["-c", script], { cwd: home, env: { ...env, ...extra }, stdio: "pipe" }).toString()
    sh(`git config --global credential.helper store && printf 'https://x-access-token:global-gh@github.com\\n' > "$HOME/.git-credentials"`)
    const password = (token: string) => sh(`printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`, { GITHUB_TOKEN: token }).match(/^password=(.*)$/m)?.[1]
    return { home, sh, password }
  }

  it("answers with the turn's GITHUB_TOKEN once the script ran, and the stored token is gone", () => {
    const box = oldBox()
    expect(box.password("project-gh")).toBe("global-gh")
    box.sh(BOX_GIT_CREDENTIAL_SCRIPT)
    expect(box.password("project-gh")).toBe("project-gh")
    expect(fs.existsSync(path.join(box.home, ".git-credentials"))).toBe(false)
    // Running it again (every server run) changes nothing.
    box.sh(BOX_GIT_CREDENTIAL_SCRIPT)
    expect(box.sh("git config --global --get-all credential.helper | wc -l").trim()).toBe("2")
    expect(box.password("other-gh")).toBe("other-gh")
  })
})

describe("UpstashProvider.create (F1, F2)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("gives a new box no Claude login, GitHub token or git credential, and sets up Box Yard's helper", async () => {
    const commands: string[] = []
    const fake = { id: "box_new", exec: { command: async (c: string) => (commands.push(c), { exitCode: 0, status: "completed", stdout: "", stderr: "", result: "" }) } }
    const create = vi.spyOn(Box, "create").mockResolvedValue(fake as unknown as Box)
    const config = testConfig({ provider: "upstash", upstashBoxApiKey: "box-key", claudeOauthToken: "global-oauth", anthropicApiKey: "global-key", githubToken: "global-gh", workerSnapshotId: "" })
    const creds = { get: (k: string) => ({ upstashBoxApiKey: "box-key", githubToken: "global-gh", claudeOauthToken: "global-oauth", anthropicApiKey: "global-key" })[k] ?? "" }
    const provider = new UpstashProvider(config, creds as never)
    expect(await provider.create({ labels: ["boxyard"] })).toBe("box_new")
    const opts = create.mock.calls[0][0] as Record<string, unknown>
    expect(opts).not.toHaveProperty("git")
    expect(opts.env).toEqual({ DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" })
    expect(JSON.stringify(opts)).not.toMatch(/global-/)
    expect(commands.join("\n")).toContain("git config --global --replace-all credential.helper")
  })
})

// End to end: a box whose own environment still holds the global logins (an Upstash box made before this fix), a
// project with its own, and a `claude` that writes down what it was started with.
class OldBox extends LocalProvider {
  protected override env(): NodeJS.ProcessEnv {
    return { ...process.env, ANTHROPIC_API_KEY: "box-key", CLAUDE_CODE_OAUTH_TOKEN: "box-oauth", GITHUB_TOKEN: "box-gh" }
  }
}

describe("a turn's credentials, end to end", () => {
  const running: { yard: BoxYard; server: Server }[] = []
  afterEach(async () => {
    for (const r of running.splice(0)) {
      r.yard.stop()
      await new Promise((res) => r.server.close(() => res(null)))
    }
  })

  async function start() {
    const dir = tmpDir("creds-e2e-")
    const log = path.join(dir, "claude-env.log")
    // Writes the credential vars it sees, then runs the fake claude.
    const claude = path.join(dir, "claude")
    fs.writeFileSync(
      claude,
      `#!/bin/sh\nenv | grep -E '^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN)=' | sort >> ${JSON.stringify(log)}\necho --- >> ${JSON.stringify(log)}\nexec ${FAKE_CLAUDE} "$@"\n`,
      { mode: 0o755 },
    )
    const port = await freePort()
    const config = testConfig({ port, claudeBin: claude, anthropicApiKey: "global-key", githubToken: "global-gh" })
    const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new OldBox(path.join(dir, "boxes"), claude) })
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    running.push({ yard, server })
    const base = `http://127.0.0.1:${port}`
    const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
      return data as T
    }
    /** What `claude` was started with on each turn so far. */
    const turns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("---\n").filter(Boolean).map((t) => t.trim().split("\n").filter(Boolean)) : [])
    return { yard, call, turns }
  }

  async function runTask(r: Awaited<ReturnType<typeof start>>, env: Record<string, string>) {
    const project = await r.call<Project>("POST", "/api/projects", { name: `p${Math.random().toString(36).slice(2, 7)}`, env })
    const before = r.turns().length
    const task = await r.call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt: "Say hi" })
    await waitFor(() => (r.yard.store.getTask(task.id)?.status === "done" ? true : null), "the task's turn to end", 30_000)
    return r.turns()[before]
  }

  it("a project's own logins beat the global ones and the box's, one Claude var each turn", async () => {
    const r = await start()
    expect(await runTask(r, { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth", GITHUB_TOKEN: "project-gh" })).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN=project-oauth",
      "GH_TOKEN=project-gh",
      "GITHUB_TOKEN=project-gh",
    ])
    // A project with none gets the global ones, never the box's.
    expect(await runTask(r, {})).toEqual(["ANTHROPIC_API_KEY=global-key", "GH_TOKEN=global-gh", "GITHUB_TOKEN=global-gh"])
  })
})
