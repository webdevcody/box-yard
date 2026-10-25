import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { checkLocal, type LocalCheckResult } from "../server/localCheck.js"
import { NO_RUNNER_CHOICE } from "../server/setup.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { LocalCheck, SetupStatus } from "../shared/setup.js"
import type { BoxInfo, Health, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Onboarding with "This computer": agents run on the computer running Box Yard (the local runner, #120), so setup
// needs no Upstash key, counts this computer's own claude and gh logins, and new projects run locally. Upstash can be
// added later; installs that already use Upstash boxes don't change.

const BOX_KEY = "box_key_secret_0123456789"
const OAUTH = "sk-ant-oat01-secret-oauth-token-abcdef"
const GH_CLI = "gho_ghCliTokenSECRET0123456789abcdef"

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

/** What this computer has, as the stand-in local check reports it. */
function computer(o: { claude?: boolean; claudeLogin?: boolean | null; gh?: boolean; chrome?: boolean } = {}) {
  const calls = { n: 0 }
  const result = (): LocalCheckResult => {
    const check: LocalCheck = {
      tools: [
        { key: "node", found: true, version: "v22.0.0" },
        { key: "claude", found: o.claude ?? true, version: o.claude === false ? null : "2.1.0 (Claude Code)" },
        { key: "gh", found: true, version: "gh version 2.60.0" },
        { key: "chrome", found: o.chrome ?? false, version: o.chrome ? "Google Chrome 130" : null },
      ],
      claudeLogin: o.claudeLogin === undefined ? true : o.claudeLogin,
      ghLogin: o.gh ?? true,
      checkedAt: Date.now(),
    }
    return { check, ghToken: (o.gh ?? true) ? GH_CLI : "" }
  }
  return {
    calls,
    localCheck: async () => {
      calls.n++
      return result()
    },
  }
}

let server: Server | null = null
let yard: BoxYard | null = null
afterEach(async () => {
  if (yard) {
    for (const t of yard.store.listTaskRows()) if (t.current_turn_id) await yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => yard!.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    yard.stop()
  }
  if (server) await new Promise((res) => server!.close(() => res(null)))
  server = null
  yard = null
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function boot(c: Config, opts: Parameters<typeof createBoxYard>[1] = {}, o: { start?: boolean } = {}) {
  dirs.push(c.dataDir)
  yard = createBoxYard(c, { webDir: "/nonexistent", ...opts })
  server = await new Promise<Server>((resolve) => {
    const s = yard!.app.listen(c.port, "127.0.0.1", () => resolve(s))
  })
  if (o.start) await yard.start()
  const base = `http://127.0.0.1:${c.port}`
  const raw = async (method: string, p: string, body?: unknown) => {
    const res = await globalThis.fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  const json = async <T,>(method: string, p: string, body?: unknown) => {
    const r = await raw(method, p, body)
    return { status: r.status, body: JSON.parse(r.text) as T, text: r.text }
  }
  return { raw, json }
}

describe("onboarding with This computer", () => {
  it("completes without an Upstash key: the choice is saved, and this computer's claude and gh logins count", async () => {
    const pc = computer()
    const { json } = await boot(firstRun({ port: await freePort() }), { setup: { localCheck: pc.localCheck } })
    let { body: status } = await json<SetupStatus>("GET", "/api/setup")
    // Before the choice, a box key isn't the only way, so setup asks for the choice instead.
    expect(status.missing).toEqual([NO_RUNNER_CHOICE, "Claude sign-in"])
    expect(status.runner).toEqual({ choice: null, default: "box" })
    expect(status.local).toBeNull()
    expect(pc.calls.n).toBe(0)

    const put = await json<SetupStatus>("PUT", "/api/setup/runner", { runner: "local" })
    expect(put.status).toBe(200)
    status = put.body
    expect(status.ready).toBe(true)
    expect(status.missing).toEqual([])
    expect(status.boxes.required).toBe(false)
    expect(status.runner).toEqual({ choice: "local", default: "local" })
    expect(status.upstash).toEqual({ available: false })
    expect(status.credentials.upstashBoxApiKey).toEqual({ state: "unset", source: null })
    expect(status.claude.state).toBe("set")
    expect(status.local?.tools.map((t) => [t.key, t.found])).toEqual([
      ["node", true],
      ["claude", true],
      ["gh", true],
      ["chrome", false],
    ])
    // gh's login stands in for the GitHub token, and its value never leaves the server.
    expect(status.credentials.githubToken).toEqual({ state: "set", source: "gh" })
    expect(put.text).not.toContain(GH_CLI)
    expect(yard!.settings.credentials.get("githubToken")).toBe(GH_CLI)
    expect(yard!.settings.credentials.secrets()).toContain(GH_CLI)

    // The saved choice survives: GET says the same (the check is reused, not run again within a minute).
    const again = await json<SetupStatus>("GET", "/api/setup")
    expect(again.body.ready).toBe(true)
    expect(again.text).not.toContain(GH_CLI)
    expect(pc.calls.n).toBe(1)
    // "Check again" looks now.
    await json("POST", "/api/setup/local/check")
    expect(pc.calls.n).toBe(2)

    // /api/health doesn't nag about Claude, GitHub or Upstash.
    const health = await json<Health>("GET", "/api/health")
    expect(health.body.problems.filter((p) => /Claude isn't signed in|GitHub token|Upstash/.test(p))).toEqual([])

    // Bad values are a 400.
    expect((await json("PUT", "/api/setup/runner", { runner: "cloud" })).status).toBe(400)
  })

  it("still needs a Claude sign-in and the claude CLI when this computer has neither", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }), { setup: { localCheck: computer({ claudeLogin: false, gh: false }).localCheck } })
    let { body: status } = await json<SetupStatus>("PUT", "/api/setup/runner", { runner: "local" })
    expect(status.ready).toBe(false)
    expect(status.missing).toEqual(["Claude sign-in"])
    expect(status.credentials.githubToken).toEqual({ state: "unset", source: null })
    // A token does it, as on boxes.
    status = (await json<SetupStatus>("PUT", "/api/setup/credentials", { claudeOauthToken: OAUTH })).body
    expect(status).toMatchObject({ ready: true, missing: [] })

    yard!.stop()
    await new Promise((res) => server!.close(() => res(null)))
    yard = null
    server = null
    const noCli = await boot(firstRun({ port: await freePort() }), { setup: { localCheck: computer({ claude: false, claudeLogin: null }).localCheck } })
    status = (await noCli.json<SetupStatus>("PUT", "/api/setup/runner", { runner: "local" })).body
    expect(status.missing).toEqual(["Claude Code on this computer", "Claude sign-in"])
  })

  it("new projects run on this computer once it's chosen; before, on Upstash boxes as always", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }), { setup: { localCheck: computer().localCheck } })
    const before = await json<Project>("POST", "/api/projects", { id: "prj_before1", name: "before" })
    expect(before.body.runner).toBe("box")
    await json("PUT", "/api/setup/runner", { runner: "local" })
    const after = await json<Project>("POST", "/api/projects", { id: "prj_after01", name: "after" })
    expect(after.body.runner).toBe("local")
    // A project that says where it runs gets that.
    const boxed = await json<Project>("POST", "/api/projects", { id: "prj_boxed01", name: "boxed", runner: "box" })
    expect(boxed.body.runner).toBe("box")
    // Projects from before keep running where they did.
    expect(yard!.store.getProject("prj_before1")!.runner).toBe("box")
  })

  it("adding an Upstash key later makes boxes available; local projects stay local", async () => {
    const { json } = await boot(firstRun({ port: await freePort() }), { setup: { localCheck: computer().localCheck } })
    await json("PUT", "/api/setup/runner", { runner: "local" })
    await json<Project>("POST", "/api/projects", { id: "prj_local01", name: "local" })
    const status = (await json<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY })).body
    expect(status.upstash).toEqual({ available: true })
    expect(status.ready).toBe(true)
    // New boxes would now be Upstash boxes (AutoProvider), and nothing moved.
    expect(yard!.store.getProject("prj_local01")!.runner).toBe("local")
    expect(status.runner.default).toBe("local")
    // Switching the default to Upstash boxes: new projects get boxes. The key is set, but this computer's claude
    // login can't reach a box, so boxes need a Claude token.
    const boxes = (await json<SetupStatus>("PUT", "/api/setup/runner", { runner: "box" })).body
    expect(boxes).toMatchObject({ ready: false, missing: ["Claude sign-in"], runner: { choice: "box", default: "box" }, boxes: { required: true }, local: null })
    expect((await json<Project>("POST", "/api/projects", { id: "prj_cloud01", name: "cloud" })).body.runner).toBe("box")
    expect(yard!.store.getProject("prj_local01")!.runner).toBe("local")
    // The gh login only stands in while agents run on this computer.
    expect(boxes.credentials.githubToken).toEqual({ state: "unset", source: null })
  })

  it("an existing Upstash install is unchanged: no choice asked for, boxes by default, gh never used", async () => {
    const pc = computer()
    const { json } = await boot(firstRun({ port: await freePort(), upstashBoxApiKey: BOX_KEY, claudeOauthToken: OAUTH, provider: "upstash" }), { setup: { localCheck: pc.localCheck } })
    const { body: status } = await json<SetupStatus>("GET", "/api/setup")
    expect(status).toMatchObject({
      ready: true,
      missing: [],
      boxes: { provider: "upstash", required: true },
      runner: { choice: null, default: "box" },
      upstash: { available: true },
      local: null,
    })
    expect(status.credentials.githubToken).toEqual({ state: "unset", source: null })
    expect((await json<Project>("POST", "/api/projects", { id: "prj_exist01", name: "existing" })).body.runner).toBe("box")
    expect(pc.calls.n).toBe(0)
  })
})

describe("running on this computer with no Upstash key", () => {
  it("a new project's task runs on this computer; nothing makes a box, errors or warns about Upstash", async () => {
    const warn = vi.spyOn(console, "warn")
    const error = vi.spyOn(console, "error")
    const c = testConfig({ port: await freePort() })
    const { json } = await boot(c, { setup: { localCheck: computer().localCheck } }, { start: true })
    expect((await json<SetupStatus>("PUT", "/api/setup/runner", { runner: "local" })).body.ready).toBe(true)
    const project = (await json<Project>("POST", "/api/projects", { id: "prj_onpc01", name: "on-pc" })).body
    expect(project.runner).toBe("local")
    const task = (await json<Task>("POST", "/api/tasks", { projectId: project.id, title: "Say hi", prompt: "say hi" })).body
    const done = await waitFor(async () => {
      const t = (await json<Task>("GET", `/api/tasks/${task.id}`)).body
      return t.status === "done" || t.status === "failed" ? t : null
    }, "the local task to finish")
    expect(done.status).toBe("done")
    expect(done.boxId).toBe(LOCAL_BOX_ID)
    expect(fs.existsSync(path.join(c.localDir, task.id))).toBe(true)
    // No box was made, and the Boxes page has nothing to list.
    expect((await json<BoxInfo[]>("GET", "/api/boxes")).body).toEqual([])
    expect(yard!.tasks.boxError).toBeNull()
    // A local project has no box to snapshot: a plain 4xx, not a crash.
    const snap = await json<{ error: string }>("POST", `/api/projects/${project.id}/snapshot`, { boxId: LOCAL_BOX_ID })
    expect(snap.status).toBeGreaterThanOrEqual(400)
    expect(snap.status).toBeLessThan(500)
    const said = [...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" "))
    expect(said.filter((l) => /upstash/i.test(l))).toEqual([])
    expect(error.mock.calls).toEqual([])
  })
})


describe("checkLocal", () => {
  /** A shell script on PATH standing in for a CLI. */
  function bin(folder: string, name: string, script: string) {
    const file = path.join(folder, name)
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`)
    fs.chmodSync(file, 0o755)
    return file
  }

  it("finds the tools, reads claude's and gh's logins, and never passes Box Yard's own tokens to them", async () => {
    const folder = dir("box-yard-bin-")
    bin(folder, "gh", `case "$1 $2" in
  "--version ") echo "gh version 2.60.0 (2024-10-01)";;
  "auth status") [ -z "$GITHUB_TOKEN" ] || exit 9; exit 0;;
  "auth token") echo "${GH_CLI}";;
esac`)
    const claude = bin(folder, "my-claude", `case "$1 $2" in
  "--version ") echo "2.1.293 (Claude Code)";;
  "auth status") [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 9; echo '{"loggedIn": true, "authMethod": "claude.ai"}';;
esac`)
    vi.stubEnv("PATH", `${folder}:${process.env.PATH}`)
    vi.stubEnv("GITHUB_TOKEN", "ghp_serverTokenSECRET0123456789")
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", OAUTH)
    try {
      const r = await checkLocal({ claudeBin: claude, fakeClaude: false })
      const tools = Object.fromEntries(r.check.tools.map((t) => [t.key, t]))
      expect(tools.node).toMatchObject({ found: true, version: process.version })
      expect(tools.claude).toMatchObject({ found: true, version: "2.1.293 (Claude Code)" })
      expect(tools.gh).toMatchObject({ found: true, version: "gh version 2.60.0 (2024-10-01)" })
      expect(r.check.claudeLogin).toBe(true)
      expect(r.check.ghLogin).toBe(true)
      expect(r.ghToken).toBe(GH_CLI)
      expect(JSON.stringify(r.check)).not.toContain(GH_CLI)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reports what's missing instead of throwing, and doesn't ask a stand-in claude about its login", async () => {
    const folder = dir("box-yard-bin-")
    const claude = bin(folder, "fake-claude", `echo "fake 1.0"`)
    // Only node on PATH (gh may sit beside it in /usr/local/bin).
    fs.symlinkSync(process.execPath, path.join(folder, "node"))
    vi.stubEnv("PATH", `${folder}:/bin`)
    try {
      const r = await checkLocal({ claudeBin: claude, fakeClaude: true })
      const tools = Object.fromEntries(r.check.tools.map((t) => [t.key, t]))
      expect(tools.claude).toMatchObject({ found: true, version: "fake 1.0" })
      expect(tools.gh).toMatchObject({ found: false, version: null })
      expect(r.check.claudeLogin).toBeNull()
      expect(r.check.ghLogin).toBe(false)
      expect(r.ghToken).toBe("")
      const missing = await checkLocal({ claudeBin: path.join(folder, "nope"), fakeClaude: false })
      expect(missing.check.tools.find((t) => t.key === "claude")).toMatchObject({ found: false })
      expect(missing.check.claudeLogin).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
