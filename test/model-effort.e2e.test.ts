import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import type { BoxHealth } from "../server/providers/types.js"
import type { RunPodPodState } from "../server/providers/runpod.js"
import type { RunPodPod } from "../server/runpod/api.js"
import type { GpuRunner } from "../server/tasks.js"
import { DEFAULT_RUNPOD_SETTINGS } from "../shared/runpod.js"
import type { ModelCatalog } from "../shared/models.js"
import type { CaptainMessage, ChatMessage, Project, Schedule, SideThread, SideThreadMessage, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The model and effort picked in Settings, on a task or by a project route reach `claude --model … --effort …` for
// every runner (a box, this computer, a Docker container, a GPU pod: all run runner/box-runner.mjs) and every role
// (Coordinator, Captain, their side threads, tasks, schedule runs, hook-made tasks). The fake claude logs its args.

/** RunPod stand-in: a "pod" is a folder on this machine (as in runpod-pods.e2e). */
class FakePods extends LocalProvider {
  pods = new Map<string, RunPodPod>()
  override async wake(boxId: string) {
    if (this.pods.has(boxId)) return
    this.pods.set(boxId, { id: `pod${this.pods.size + 1}`, name: `boxyard-test-${boxId}`, status: "RUNNING", cost: 0.27, gpu: { id: "NVIDIA RTX A5000" }, startedAt: new Date().toISOString() } as RunPodPod)
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
  }
  override async health(boxId: string): Promise<BoxHealth> {
    return this.pods.has(boxId) ? "running" : "paused"
  }
  override async destroy(boxId: string) {
    if (this.pods.delete(boxId)) await super.destroy(boxId)
  }
  async listPods(): Promise<RunPodPodState[]> {
    return [...this.pods].map(([boxId, pod]) => ({ boxId, pod, target: null }))
  }
  cached(boxId: string) {
    return this.pods.get(boxId) ?? null
  }
  capOf() {
    return DEFAULT_RUNPOD_SETTINGS.maxHourlyUsd
  }
  async nextPodPrice() {
    return { gpu: "RTX A5000", usd: 0.27 }
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dirs: string[]
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_LOG_FULL", "FAKE_CLAUDE_MODELS"]

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const dirs = [config.dataDir, tmpDir("boxes-"), tmpDir("pods-")]
  const gpu: GpuRunner = { provider: new FakePods(dirs[2]!, FAKE_CLAUDE), settings: () => DEFAULT_RUNPOD_SETTINGS, enabled: () => true, keepWarmUntil: () => null }
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(dirs[1]!, FAKE_CLAUDE), localRunner: new LocalRunnerProvider(config.localDir, FAKE_CLAUDE), gpu })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dirs }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "the Coordinator to rest").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
    for (const d of r.dirs) fs.rmSync(d, { recursive: true, force: true })
  }
  for (const k of ENV_KEYS) delete process.env[k]
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type Run = { args: string[]; prompt: string }
const logFile = () => {
  const file = path.join(tmpDir(), "fake-claude.log")
  process.env.FAKE_CLAUDE_LOG = file
  process.env.FAKE_CLAUDE_LOG_FULL = "1"
  return (): Run[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as Run)
}
const argOf = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
/** The model and effort of each run that matches. */
const routes = (runs: Run[], match: (r: Run) => boolean) => runs.filter(match).map((r) => [argOf(r.args, "--model"), argOf(r.args, "--effort")])
/** A task's first turn: the run that started its session. */
const taskTurn = (runs: Run[], t: Task) => routes(runs, (r) => argOf(r.args, "--session-id") === t.sessionId)

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const done = (r: Running, id: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && !t.currentTurnId && t.sessionId ? t : null
  }, `task ${id} to finish`, 60_000)

describe("model and effort reach the claude CLI", () => {
  it("on every runner: a box, this computer, a Docker container and a GPU pod", { timeout: 120_000 }, async () => {
    const runs = logFile()
    const r = await start()
    const cases = [
      { runner: "box", model: "claude-sonnet-5-5", effort: "low" },
      { runner: "local", model: "opusplan", effort: "xhigh" },
      { runner: "docker", model: "claude-opus-4-6[1m]", effort: "max" },
      { runner: "gpu", model: "claude-fable-5-1", effort: "medium" },
    ] as const
    const tasks = await Promise.all(
      cases.map(async (c) => {
        const p = await call<Project>(r, "POST", "/api/projects", { name: `on-${c.runner}`, runner: c.runner })
        return call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: `On ${c.runner}`, prompt: "write a haiku", model: c.model, effort: c.effort })
      }),
    )
    const finished = await Promise.all(tasks.map((t) => done(r, t.id)))
    expect(finished.map((t) => t.placement?.runner)).toEqual(["box", "local", "docker", "gpu"])
    expect(finished.map((t) => taskTurn(runs(), t))).toEqual(cases.map((c) => [[c.model, c.effort]]))
  })

  it("for the Coordinator, a Captain, both side threads, Settings' box agents, a project route, a schedule run and a hook's task", { timeout: 120_000 }, async () => {
    const runs = logFile()
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", {
      orchestratorModel: "opusplan",
      orchestratorEffort: "xhigh",
      captainModel: "claude-sonnet-4-6[1m]",
      captainEffort: "max",
      agentModel: "claude-haiku-5-5",
      agentEffort: "low",
      agentRoutingConfig: "projects:\n  routed:\n    model: claude-opus-4-7\n    effort: medium\n",
    })
    const plain = await call<Project>(r, "POST", "/api/projects", { name: "plain" })
    const routed = await call<Project>(r, "POST", "/api/projects", { name: "routed" })

    // The Coordinator, then a side thread on its reply.
    await call(r, "POST", "/api/chat", { content: "hello coordinator" })
    const reply = await waitFor(async () => (await call<ChatMessage[]>(r, "GET", "/api/chat")).find((m) => m.role === "assistant"), "Coordinator reply")
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "the Coordinator to rest")
    const { thread } = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { anchorId: reply.id, quote: reply.content.slice(0, 10), question: "coordinator thread question" })
    await threadReply(r, thread.id)

    // A Captain, then a side thread on its reply.
    await call<CaptainMessage>(r, "POST", `/api/projects/${plain.id}/captain/messages`, { id: "cap_models01", content: "hello captain" })
    const capReply = await waitFor(async () => (await call<CaptainMessage[]>(r, "GET", `/api/projects/${plain.id}/captain/messages`)).find((m) => m.role === "assistant"), "Captain reply")
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${plain.id}/captain`)).busy, "the Captain to rest")
    const capThread = (await call<{ thread: SideThread }>(r, "POST", "/api/threads", { projectId: plain.id, anchorId: capReply.id, quote: capReply.content.slice(0, 10), question: "captain thread question" })).thread
    await threadReply(r, capThread.id, plain.id)

    // Tasks: Settings › Box agents, a project route, a schedule run, and a hook-made task.
    await call(r, "POST", "/api/hooks", { projectId: plain.id, name: "Follow up", trigger: "task.finished", action: "create_task", taskTitle: "Hook follow-up", prompt: "hook follow-up", enabled: true })
    const own = await done(r, (await call<Task>(r, "POST", "/api/tasks", { projectId: plain.id, title: "Settings route", prompt: "write a haiku" })).id)
    const viaRoute = await done(r, (await call<Task>(r, "POST", "/api/tasks", { projectId: routed.id, title: "Project route", prompt: "write a haiku" })).id)
    const schedule = await call<Schedule>(r, "POST", "/api/schedules", { projectId: routed.id, name: "Nightly", cron: "@daily", prompt: "write a haiku" })
    const scheduled = await done(r, (await call<Task>(r, "POST", `/api/schedules/${schedule.id}/run`)).id)
    const hooked = await waitFor(async () => (await call<Task[]>(r, "GET", "/api/tasks")).find((t) => t.prompt.includes("hook follow-up")), "the hook's task")
    const fromHook = await done(r, hooked.id)

    const all = runs()
    const has = (text: string) => (x: Run) => x.prompt.includes(text)
    expect(routes(all, has("hello coordinator"))[0]).toEqual(["opusplan", "xhigh"])
    expect(routes(all, has("coordinator thread question"))[0]).toEqual(["opusplan", "xhigh"])
    expect(routes(all, has("hello captain"))[0]).toEqual(["claude-sonnet-4-6[1m]", "max"])
    expect(routes(all, has("captain thread question"))[0]).toEqual(["claude-sonnet-4-6[1m]", "max"])
    expect(taskTurn(all, own)).toEqual([["claude-haiku-5-5", "low"]])
    expect(taskTurn(all, viaRoute)).toEqual([["claude-opus-4-7", "medium"]])
    expect(taskTurn(all, scheduled)).toEqual([["claude-opus-4-7", "medium"]])
    expect(taskTurn(all, fromHook)).toEqual([["claude-haiku-5-5", "low"]])
  })
})

async function threadReply(r: Running, id: string, projectId?: string) {
  await waitFor(async () => {
    const list = await call<SideThreadMessage[]>(r, "GET", `/api/threads/${id}/messages`)
    const threads = await call<SideThread[]>(r, "GET", `/api/threads${projectId ? `?projectId=${projectId}` : ""}`)
    return list.some((m) => m.role === "assistant") && !threads.find((t) => t.id === id)?.busy
  }, `side thread ${id} to answer`)
}

describe("GET /api/models", () => {
  it("lists the CLI's models over the built-in ones, and falls back to the built-in list when the CLI can't say", async () => {
    process.env.FAKE_CLAUDE_MODELS = JSON.stringify([
      { value: "opus", resolvedModel: "claude-opus-6", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ])
    const r = await start()
    const cli = await call<ModelCatalog>(r, "GET", "/api/models")
    expect(cli.source).toBe("cli")
    expect(cli.models.find((m) => m.id === "opus")).toMatchObject({ group: "alias", note: "Opus 6 now" })
    // A model the CLI names that Box Yard doesn't know yet joins Latest.
    expect(cli.models.find((m) => m.id === "claude-opus-6")).toMatchObject({ label: "Opus 6", group: "latest" })
    expect(cli.models.map((m) => m.id)).toEqual(expect.arrayContaining(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "opusplan", "sonnet[1m]", "claude-opus-4-6"]))

    process.env.FAKE_CLAUDE_MODELS = "fail"
    const again = await call<ModelCatalog>(r, "GET", "/api/models?refresh=1")
    // A list the CLI gave before beats the built-in one.
    expect(again.source).toBe("cli")

    const r2 = await start()
    const builtin = await call<ModelCatalog>(r2, "GET", "/api/models")
    expect(builtin.source).toBe("builtin")
    expect(builtin.error).toMatch(/claude exited/)
    expect(builtin.models.find((m) => m.id === "claude-opus-5-5")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
  })
})
