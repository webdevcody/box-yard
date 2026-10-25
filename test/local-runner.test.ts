import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { LocalProvider, LocalRunnerProvider, LocalRunnerRouter, agentEnv } from "../server/providers/local.js"
import { providerOf, tasksRootOf, type BoxProvider } from "../server/providers/types.js"
import { SleepWatch, sleepLength } from "../server/sleep.js"
import { workerSystemPrompt } from "../server/prompts.js"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { DEFAULT_SETTINGS, SettingsStore } from "../server/settings.js"
import { LOCAL_BOX_ID, isLocalRunnerBox, normalizeRunner } from "../shared/runner.js"
import type { Project } from "../shared/types.js"
import { config, homePath, tildePath } from "../server/config.js"
import { FAKE_CLAUDE, testConfig, tmpDir } from "./helpers.js"

// The local runner (a project's "Runs on: This computer"): its provider, the router that fronts the box provider,
// the env its agents get, how Box Yard notices this computer slept, the worker prompt, the setting and its migration.

describe("LocalRunnerProvider", () => {
  it("is one folder: task folders sit right in it, Box Yard's own files in .boxyard", async () => {
    const dir = path.join(tmpDir(), "local-workspaces")
    const p = new LocalRunnerProvider(dir, "claude --x")
    // Made on first use, so a Box Yard that never runs a local agent leaves no folder behind.
    expect(fs.existsSync(dir)).toBe(false)
    expect(p.name).toBe("local")
    expect(p.claudeBin).toBe("claude --x")
    expect(p.root(LOCAL_BOX_ID)).toBe(dir)
    expect(p.tasksRoot(LOCAL_BOX_ID)).toBe(dir)
    expect(tasksRootOf(p, LOCAL_BOX_ID)).toBe(dir)
    // Health always finds this computer, making the folder again if someone removed it.
    fs.rmSync(dir, { recursive: true, force: true })
    expect(await p.health()).toBe("running")
    expect(fs.existsSync(path.join(dir, ".boxyard"))).toBe(true)
    expect(await p.publicUrl(LOCAL_BOX_ID, 4012)).toBe("http://localhost:4012")
  })

  it("never makes another box, and deleting it leaves the folder", async () => {
    const dir = path.join(tmpDir(), "local-workspaces")
    const p = new LocalRunnerProvider(dir)
    await expect(p.create()).rejects.toThrow(/one box/)
    fs.mkdirSync(path.join(dir, "task_abc123"), { recursive: true })
    await p.destroy()
    expect(fs.existsSync(path.join(dir, "task_abc123"))).toBe(true)
    // Cody's folders aren't walked for a size.
    expect(await p.usage()).toEqual({ source: "estimated" })
  })

  it("runs commands in its folder without Box Yard's secrets or Claude Code session markers", async () => {
    const dir = path.join(tmpDir(), "local-workspaces")
    const p = new LocalRunnerProvider(dir)
    const saved = { ...process.env }
    Object.assign(process.env, {
      BOXYARD_PASSWORD: "hunter2",
      UPSTASH_BOX_API_KEY: "ub",
      GITHUB_TOKEN: "ghp_server",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-server",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      LOCAL_RUNNER_TEST_KEEP: "kept",
    })
    try {
      const res = await p.exec(LOCAL_BOX_ID, 'echo "$PWD|${BOXYARD_PASSWORD:-}|${UPSTASH_BOX_API_KEY:-}|${GITHUB_TOKEN:-}|${CLAUDE_CODE_OAUTH_TOKEN:-}|${CLAUDECODE:-}|${CLAUDE_CODE_ENTRYPOINT:-}|$LOCAL_RUNNER_TEST_KEEP|${HOME:+home}"')
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe(`${fs.realpathSync(dir)}|||||||kept|home`)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it("lives outside Box Yard's checkout and data folder by default, where no CLAUDE.md of Box Yard's is above it", () => {
    // Claude Code reads every CLAUDE.md above the folder it runs in: under ./data, Box Yard's own agent rules would
    // reach every local agent.
    const outside = (dir: string, root: string) => path.relative(root, dir).startsWith("..")
    expect(outside(config.localDir, process.cwd())).toBe(true)
    expect(outside(config.localDir, config.dataDir)).toBe(true)
    expect(homePath("~/boxyard-workspaces")).toBe(path.join(os.homedir(), "boxyard-workspaces"))
    expect(homePath("~")).toBe(os.homedir())
    expect(homePath("/Volumes/fast/agents")).toBe("/Volumes/fast/agents")
    expect(homePath("~cody/x")).toBe(path.resolve("~cody/x"))
    expect(tildePath(path.join(os.homedir(), "boxyard-workspaces"))).toBe("~/boxyard-workspaces")
    expect(tildePath("/Volumes/fast/agents")).toBe("/Volumes/fast/agents")
    expect(tildePath(`${os.homedir()}-other/x`)).toBe(`${os.homedir()}-other/x`)
  })

  it("agentEnv keeps the user's own environment", () => {
    const env = agentEnv({ PATH: "/usr/bin", HOME: "/Users/cody", LANG: "en_US.UTF-8", BOXYARD_DATA_DIR: "/x", PORT: "3000", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o", CLAUDE_CODE_SESSION_ID: "s" })
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/cody", LANG: "en_US.UTF-8" })
  })
})

describe("LocalRunnerRouter", () => {
  class Boxes extends LocalProvider {
    created = 0
    override async create() {
      this.created++
      return super.create()
    }
    async listIds() {
      return ["local-a"]
    }
    async liveIds() {
      return ["local-a"]
    }
  }

  it("sends this computer to the local runner and every other box to the box provider", async () => {
    const boxes = new Boxes(tmpDir("boxes-"), "fake")
    const local = new LocalRunnerProvider(path.join(tmpDir(), "local-workspaces"), "claude")
    const r = new LocalRunnerRouter(boxes, local)
    const box = await r.create({ labels: [] })
    expect(boxes.created).toBe(1)
    expect(providerOf(r, LOCAL_BOX_ID)).toBe(local)
    expect(providerOf(r, box)).toBe(boxes)
    expect(r.root(box)).toBe(boxes.root(box))
    expect(r.tasksRoot(box)).toBe(`${boxes.root(box)}/tasks`)
    expect(r.tasksRoot(LOCAL_BOX_ID)).toBe(local.root(LOCAL_BOX_ID))
    // Name, binaries and upload limit are the box provider's.
    expect(r.name).toBe("local")
    expect(r.claudeBin).toBe("fake")
    // Leftover-box sweeps and reconcile only ever ask the box provider, which has never heard of this computer.
    expect(await r.listIds!("x")).toEqual(["local-a"])
    expect(await r.liveIds!()).toEqual(["local-a"])
    expect(r.resize).toBeUndefined()
    expect((await r.exec(LOCAL_BOX_ID, "pwd")).stdout.trim()).toBe(fs.realpathSync(local.root(LOCAL_BOX_ID)))
  })

  it("routes through a box provider's own `of` (AutoProvider)", () => {
    const inner = new Boxes(tmpDir("boxes-"), "inner")
    const outer = { ...new Boxes(tmpDir("boxes-"), "outer"), name: "auto", of: () => inner } as unknown as BoxProvider
    const r = new LocalRunnerRouter(outer, new LocalRunnerProvider(path.join(tmpDir(), "lw")))
    expect(r.of("local-zzz")).toBe(inner)
    expect(r.of(LOCAL_BOX_ID)).not.toBe(inner)
  })

  it("this computer's id is not a mock box id", () => {
    expect(LOCAL_BOX_ID.startsWith("local-")).toBe(false)
    expect(isLocalRunnerBox(LOCAL_BOX_ID)).toBe(true)
    expect(isLocalRunnerBox("local-1234")).toBe(false)
    expect(isLocalRunnerBox(null)).toBe(false)
  })
})

describe("SleepWatch", () => {
  function clock() {
    const c = { wallMs: 1_000_000, monoMs: 500, wall: () => c.wallMs, mono: () => c.monoMs }
    return c
  }

  it("sees a sleep as the wall clock running ahead of the monotonic one", () => {
    const c = clock()
    const w = new SleepWatch(c)
    c.wallMs += 5_000
    c.monoMs += 5_000
    expect(w.check()).toBeNull()
    // Asleep 10 minutes, then 3 s awake.
    const before = c.wallMs
    c.wallMs += 600_000 + 3_000
    c.monoMs += 3_000
    expect(w.check()).toEqual({ from: before, to: c.wallMs, ms: 600_000 })
    expect(w.sleptBetween(before - 1)).toBe(600_000)
    expect(w.sleptBetween(c.wallMs + 1)).toBe(0)
  })

  it("ignores clock adjustments and busy event loops under the threshold", () => {
    const c = clock()
    const w = new SleepWatch(c)
    c.wallMs += 15_000
    c.monoMs += 1_000
    expect(w.check()).toBeNull()
    expect(w.sleptBetween(0)).toBe(0)
  })

  it("needs no timer: the first look after waking sees it", () => {
    const c = clock()
    const w = new SleepWatch(c)
    const start = c.wallMs
    c.wallMs += 3600_000
    expect(w.sleptBetween(start)).toBe(3600_000)
  })

  it("keeps sleeps others saw (the runner's clocks, tests)", () => {
    const w = new SleepWatch(clock())
    w.record(100, 200)
    expect(w.sleptBetween(150, 300)).toBe(100)
    expect(w.sleptBetween(250, 300)).toBe(0)
  })

  it("says how long", () => {
    expect(sleepLength(45_000)).toBe("45s")
    expect(sleepLength(12 * 60_000)).toBe("12 min")
    expect(sleepLength(3.5 * 3600_000)).toBe("3.5 h")
  })
})

describe("worker prompt on this computer", () => {
  const project = { id: "prj_survive", name: "survive-the-night", description: "", repo: "acme/survive", baseBranch: "main" } as Project
  const task = { id: "task_bench1", title: "Overnight bench" }

  it("says it is unsandboxed, on the owner's computer, with localhost previews and sleep", () => {
    const prompt = workerSystemPrompt({ project, task, branch: "b", port: 4010, ownerName: "Sam", box: { memoryBytes: 32 * 1024 ** 3, slots: 2, local: true } })
    expect(prompt).toContain("running directly on Sam's own computer (Box Yard's local runner), not in a sandbox")
    expect(prompt).not.toContain("isolated Upstash Box")
    expect(prompt).toContain("http://localhost:<port>")
    expect(prompt).not.toContain("bound to 0.0.0.0")
    expect(prompt).toContain("real GPU")
    expect(prompt).toContain("shared with up to 1 other local agents and Sam's own apps")
    expect(prompt).toContain("Box Yard resumes a turn that sleep cut off")
    expect(prompt).not.toMatch(/\bCody\b/)
  })

  it("is unchanged on a box", () => {
    const prompt = workerSystemPrompt({ project, task, branch: "b", port: 4010, box: { memoryBytes: 4 * 1024 ** 3, slots: 2 } })
    expect(prompt).toContain("running in an isolated Upstash Box")
    expect(prompt).toContain("bound to 0.0.0.0")
    expect(prompt).not.toContain("local runner")
  })
})

describe("Runs on setting", () => {
  const dbs: Database.Database[] = []
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
  })

  it("defaults to box, and only 'local' runs locally", () => {
    const db = openDb(tmpDir())
    dbs.push(db)
    const store = new Store(db)
    const p = store.createProject({ name: "plain" })
    expect(p.runner).toBe("box")
    expect(store.updateProject(p.id, { runner: "local" }).runner).toBe("local")
    expect(store.projectRunner(p.id)).toBe("local")
    expect(store.updateProject(p.id, { description: "x" }).runner).toBe("local")
    expect(store.updateProject(p.id, { runner: "box" }).runner).toBe("box")
    expect((db.prepare("SELECT runner FROM projects WHERE id = ?").get(p.id) as { runner: string | null }).runner).toBeNull()
    expect(store.createProject({ name: "mac", runner: "local" }).runner).toBe("local")
    expect(normalizeRunner("LOCAL")).toBe("box")
    expect(normalizeRunner(null)).toBe("box")
  })

  it("its migration leaves existing projects on boxes", () => {
    const dir = tmpDir()
    const old = new Database(path.join(dir, "box-yard.sqlite"))
    migrate(old, MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN runner")))
    old.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("prj_old", "old", 1, 1)
    old.close()
    const db = openDb(dir)
    dbs.push(db)
    const store = new Store(db)
    expect(store.getProject("prj_old")?.runner).toBe("box")
    expect(store.projectRunner("prj_old")).toBe("box")
  })
})

describe("Local agents setting", () => {
  const dbs: Database.Database[] = []
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
  })
  const settingsFor = (overrides: Parameters<typeof testConfig>[0] = {}) => {
    const db = openDb(tmpDir())
    dbs.push(db)
    return new SettingsStore(new Store(db), testConfig({ claudeBin: FAKE_CLAUDE, ...overrides }))
  }

  it("is 2 by default, 1 to 32, and BOXYARD_LOCAL_AGENTS sets it", () => {
    expect(DEFAULT_SETTINGS.localAgents).toBe(2)
    const s = settingsFor()
    expect(s.get().localAgents).toBe(2)
    expect(s.update({ localAgents: 5 }).settings.localAgents).toBe(5)
    expect(() => s.update({ localAgents: 0 })).toThrow()
    expect(() => s.update({ localAgents: 33 })).toThrow()
    expect(settingsFor({ localAgents: 4 }).get().localAgents).toBe(4)
  })
})
