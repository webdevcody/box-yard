import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { envEffort } from "../server/config.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, Project, UsageReport } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const noEnv = { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" as const }

describe("Captain settings", () => {
  it("default to Opus 5.5 at high, as separate settings from the Coordinator's", () => {
    const store = memStore()
    const info = new SettingsStore(store, noEnv).info()
    expect(info.settings.captainModel).toBe("claude-opus-5-5")
    expect(info.settings.captainEffort).toBe("high")
    expect(info.settings.orchestratorModel).toBe("claude-opus-5-5")
    expect(info.settings.orchestratorEffort).toBe("high")
    expect(info.sources.captainModel).toBe("default")
    expect(info.sources.captainEffort).toBe("default")
    // Changing the Coordinator doesn't move the Captain defaults, and vice versa.
    const after = new SettingsStore(store, noEnv).update({ orchestratorModel: "claude-haiku-5-5", orchestratorEffort: "low" })
    expect(after.settings.captainModel).toBe("claude-opus-5-5")
    expect(after.settings.captainEffort).toBe("high")
  })

  it("CAPTAIN_MODEL / CAPTAIN_EFFORT override the defaults, and UI-saved values win over env", () => {
    const store = memStore()
    const settings = new SettingsStore(store, { ...noEnv, captainModel: "claude-haiku-5-5", captainEffort: "low" })
    let info = settings.info()
    expect(info.settings.captainModel).toBe("claude-haiku-5-5")
    expect(info.settings.captainEffort).toBe("low")
    expect(info.sources.captainModel).toBe("env")
    expect(info.sources.captainEffort).toBe("env")
    // Coordinator settings are untouched by Captain env vars.
    expect(info.settings.orchestratorModel).toBe("claude-opus-5-5")

    info = settings.update({ captainModel: "claude-opus-5-5", captainEffort: "high" })
    expect(info.settings.captainModel).toBe("claude-opus-5-5")
    expect(info.settings.captainEffort).toBe("high")
    expect(info.sources.captainEffort).toBe("ui")

    info = settings.reset(["captainModel", "captainEffort"])
    expect(info.settings.captainModel).toBe("claude-haiku-5-5")
    expect(info.settings.captainEffort).toBe("low")
  })

  it("rejects bad Captain values", () => {
    const settings = new SettingsStore(memStore(), noEnv)
    expect(() => settings.update({ captainEffort: "turbo" })).toThrow()
    expect(() => settings.update({ captainModel: "has space" })).toThrow()
  })

  it("reads CAPTAIN_EFFORT leniently and ignores unknown levels", () => {
    expect(envEffort(" Medium ")).toBe("medium")
    expect(envEffort("xhigh")).toBe("xhigh")
    expect(envEffort("turbo")).toBe("")
    expect(envEffort(undefined)).toBe("")
    expect(envEffort("")).toBe("")
  })
})

describe("Captain usage line", () => {
  it("splits Captain spend from the Coordinator, counting old orchestrator rows with a project id as Captain", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const now = Date.now()
    const row = (source: "orchestrator" | "captain" | "task", costUsd: number, projectId: string | null) =>
      store.recordClaudeUsage({ source, runKind: "turn", projectId, startedAt: now, endedAt: now, usage: { input_tokens: 100 }, costUsd })
    row("orchestrator", 1, null) // Coordinator
    row("orchestrator", 2, p.id) // legacy Captain row
    row("captain", 4, p.id) // new Captain row
    row("task", 8, p.id)
    const report = store.usageReport({ costRates: new SettingsStore(store, noEnv).get().costRates, budget: { dailyUsd: 0, monthlyUsd: 0 } }, now)
    expect(report.orchestrator.costUsd).toBe(1)
    expect(report.orchestrator.turns).toBe(1)
    expect(report.captains.costUsd).toBe(6)
    expect(report.captains.turns).toBe(2)
    // Captain runs still count toward the project and the time windows.
    expect(report.projects.find((x) => x.projectId === p.id)?.claude.costUsd).toBe(14)
    expect(report.windows.find((w) => w.key === "today")!.claude.costUsd).toBe(15)
  })
})

describe("Captain runs", () => {
  let server: Server | null = null
  let yard: BoxYard | null = null
  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_LOG
    yard?.stop()
    if (server) await new Promise((res) => server!.close(() => res(null)))
    server = null
    yard = null
  })

  it("use the Captain model and effort, not the Coordinator's, and record usage as captain", async () => {
    const log = path.join(tmpDir(), "fake-claude.log")
    process.env.FAKE_CLAUDE_LOG = log
    const port = await freePort()
    yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    const base = `http://127.0.0.1:${port}`
    const call = async <T>(method: string, p: string, body?: unknown) => {
      const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
      return data as T
    }
    await call("PUT", "/api/agent-settings", { captainModel: "claude-haiku-5-5", captainEffort: "low", orchestratorModel: "claude-opus-5-5", orchestratorEffort: "max" })
    const p = await call<Project>("POST", "/api/projects", { name: "demo" })
    await call<CaptainMessage>("POST", `/api/projects/${p.id}/captain/messages`, { id: "cap_settings01", content: "status" })
    await waitFor(async () => {
      const msgs = await call<CaptainMessage[]>("GET", `/api/projects/${p.id}/captain/messages`)
      return msgs.some((m) => m.role === "assistant") && !(await call<{ busy: boolean }>("GET", `/api/projects/${p.id}/captain`)).busy
    }, "Captain reply")

    const runs = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
      .filter((r) => r.args.join(" ").includes("You are the Box Yard Captain"))
    expect(runs.length).toBeGreaterThan(0)
    const args = runs[0]!.args
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5")
    expect(args[args.indexOf("--effort") + 1]).toBe("low")

    const usage = await waitFor(async () => {
      const u = await call<UsageReport>("GET", "/api/usage")
      return u.captains.turns > 0 ? u : null
    }, "Captain usage")
    const row = yard.store.db.prepare("SELECT source, project_id FROM claude_usage WHERE project_id = ?").get(p.id) as { source: string; project_id: string }
    expect(row.source).toBe("captain")
    expect(usage.captains.turns).toBeGreaterThan(0)
  })
})
