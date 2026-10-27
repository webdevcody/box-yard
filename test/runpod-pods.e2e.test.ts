import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxHealth } from "../server/providers/types.js"
import type { RunPodPodState } from "../server/providers/runpod.js"
import type { RunPodPod } from "../server/runpod/api.js"
import type { GpuRunner } from "../server/tasks.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_RUNPOD_SETTINGS, gpuBoxId, type RunPodSettings } from "../shared/runpod.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Several RunPod GPU pods per project (docs/runpod.md): a GPU project gets up to its Max boxes pods, each running its
// Agents per box agents, within the per-project and total $/hr caps; a task a cap holds back waits and says so, on
// the task, in pool_status and to its Captain. Each pod stops on its own when idle. `runpod-<projectId>`, the one pod
// a project had before, is pod #1. RunPod itself is a fake: a "pod" is a folder on this machine.

/** RunPod stand-in: `wake` starts a pod (a folder) at `price`, `destroy` terminates it. */
class FakePods extends LocalProvider {
  pods = new Map<string, RunPodPod>()
  started: string[] = []
  terminated: string[] = []
  price = 0.27
  private n = 0

  constructor(
    dir: string,
    private readonly settings: () => RunPodSettings,
    private readonly projectCap: (projectId: string) => number | null,
  ) {
    super(dir, FAKE_CLAUDE)
  }

  /** A pod that's already up, as one a Box Yard started before a restart. */
  adopt(boxId: string) {
    this.pods.set(boxId, this.pod(boxId))
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
  }

  private pod(boxId: string): RunPodPod {
    return { id: `pod${++this.n}`, name: `boxyard-test-${boxId.slice("runpod-".length)}`, status: "RUNNING", cost: this.price, gpu: { id: "NVIDIA RTX A5000" }, startedAt: new Date().toISOString() } as RunPodPod
  }

  override async wake(boxId: string) {
    if (this.pods.has(boxId)) return
    this.started.push(boxId)
    this.adopt(boxId)
  }

  override async health(boxId: string): Promise<BoxHealth> {
    return this.pods.has(boxId) ? "running" : "paused"
  }

  override async destroy(boxId: string) {
    if (!this.pods.delete(boxId)) return
    this.terminated.push(boxId)
    await super.destroy(boxId)
  }

  async listPods(): Promise<RunPodPodState[]> {
    return [...this.pods].map(([boxId, pod]) => ({ boxId, pod, target: null }))
  }

  cached(boxId: string) {
    return this.pods.get(boxId) ?? null
  }

  capOf(projectId: string) {
    return this.projectCap(projectId) ?? this.settings().maxHourlyUsd
  }

  async nextPodPrice(projectId: string) {
    const cap = this.capOf(projectId)
    return !cap || this.price <= cap ? { gpu: "RTX A5000", usd: this.price } : null
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  pods: FakePods
  settings: RunPodSettings
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(gpuSettings: Partial<RunPodSettings> = {}, overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const settings: RunPodSettings = { ...DEFAULT_RUNPOD_SETTINGS, ...gpuSettings }
  let yard: BoxYard | null = null
  const pods = new FakePods(tmpDir("pods-"), () => settings, (id) => yard?.store.projectGpuCap(id) ?? null)
  const gpu: GpuRunner = { provider: pods, settings: () => settings, enabled: () => true, keepWarmUntil: () => null }
  yard = createBoxYard(config, { webDir: "/nonexistent", gpu })
  const y = yard
  const server = await new Promise<Server>((resolve) => {
    const s = y.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await y.start()
  const r = { yard: y, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, pods, settings }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const gpuProject = (r: Running, name: string, settings: Partial<Pick<Project, "agentsPerBox" | "maxBoxes" | "gpuMaxHourlyUsd">> = {}) =>
  call<Project>(r, "POST", "/api/projects", { name, runner: "gpu", ...settings })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return ok(t) ? t : null
  }, `task ${id} ${what}`)
const working = (r: Running, id: string) => until(r, id, (t) => t.status === "working", "to be working")
const waits = (r: Running, id: string, reason: RegExp) => until(r, id, (t) => t.status === "queued" && reason.test(t.waitReason ?? ""), `to wait (${reason})`)
const hang = async (r: Running, projectId: string, title: string) => (await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "keep going [hang]" })).id
const boxOf = (r: Running, id: string) => r.yard.store.getTaskRow(id)?.box_id
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as ToolRes).content[0]!.text)
}

describe("RunPod GPU: pods per project", () => {
  it("gives each of N queued tasks a pod of its own when the project runs one agent per box", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1, maxBoxes: 4 })
    const ids = [await hang(r, p.id, "lane 1"), await hang(r, p.id, "lane 2"), await hang(r, p.id, "lane 3")]
    for (const id of ids) await working(r, id)
    const boxes = ids.map((id) => boxOf(r, id))
    expect(new Set(boxes).size).toBe(3)
    expect([...boxes].sort()).toEqual([gpuBoxId(p.id), gpuBoxId(p.id, 2), gpuBoxId(p.id, 3)].sort())
    expect([...r.pods.started].sort()).toEqual([...boxes].sort())
  })

  it("shares a pod up to its agents per box before it adds another", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 2, maxBoxes: 3 })
    const ids = [await hang(r, p.id, "a"), await hang(r, p.id, "b"), await hang(r, p.id, "c")]
    for (const id of ids) await working(r, id)
    const per = new Map<string, number>()
    for (const id of ids) per.set(boxOf(r, id)!, (per.get(boxOf(r, id)!) ?? 0) + 1)
    expect([...per.values()].sort()).toEqual([1, 2])
    expect(r.pods.started.length).toBe(2)
  })

  it("never has more pods than the project's Max boxes: the next task waits for a slot and says why", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1, maxBoxes: 2 })
    const a = await hang(r, p.id, "a")
    const b = await hang(r, p.id, "b")
    await working(r, a)
    await working(r, b)
    const c = await hang(r, p.id, "c")
    const t = await waits(r, c, /free slot on its project's 2 GPU pods \(its Max boxes is 2/)
    expect(t.boxId).toBeNull()
    expect(r.pods.started.length).toBe(2)
    // A slot frees up: it takes it, on a pod that's already up.
    await r.yard.tasks.stopTask(a)
    await working(r, c)
    expect([boxOf(r, b), boxOf(r, c)].sort()).toEqual([gpuBoxId(p.id), gpuBoxId(p.id, 2)].sort())
    expect(r.pods.started.length).toBe(2)
  })

  it("holds a task back at the project's $/hr cap, says so on the task, in pool_status and to its Captain, and goes on once it's raised", async () => {
    // $0.27/hr pods under the default $1/hr cap per project: three fit, a fourth would be $1.08/hr.
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1, maxBoxes: 4 })
    const ids = [await hang(r, p.id, "lane 1"), await hang(r, p.id, "lane 2"), await hang(r, p.id, "lane 3")]
    for (const id of ids) await working(r, id)
    const fourth = await hang(r, p.id, "lane 4")
    const t = await waits(r, fourth, /^Waiting: RunPod cap \$1\/hr reached: game's 3 pods cost \$0\.81\/hr and another RTX A5000 is \$0\.27\/hr/)
    expect(t.boxId).toBeNull()
    expect(r.pods.started.length).toBe(3)
    // Its Captain hears it once, as a notice about the task.
    await waitFor(() => r.yard.store.listChat().some((m) => m.content.startsWith("⚠️ **lane 4** waits: RunPod cap $1/hr reached")), "the cap notice")
    await sleep(500)
    expect(r.yard.store.listChat().filter((m) => m.content.includes("**lane 4** waits")).length).toBe(1)

    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const pool = await captain("pool_status")
    expect(pool.queued.join("\n")).toMatch(/lane 4 \(Waiting: RunPod cap \$1\/hr reached/)
    expect(pool.gpu_projects.game).toMatchObject({ maxHourlyUsd: "global: $1/hr (Settings › RunPod GPU › Max per project)", spend: "$0.81/hr" })
    expect(pool.gpu_projects.game.pods).toHaveLength(3)
    const [listed] = await captain("list_projects")
    expect(listed.gpu.maxHourlyUsd).toMatch(/global: \$1\/hr/)

    // The Captain raises its own project's cap: the fourth lane gets its pod.
    const updated = await captain("update_project", { gpu_max_hourly_usd: 1.5 })
    expect(updated.gpu.maxHourlyUsd).toBe("$1.5/hr (this project)")
    expect(r.yard.store.getProject(p.id)?.gpuMaxHourlyUsd).toBe(1.5)
    await working(r, fourth)
    expect(boxOf(r, fourth)).toBe(gpuBoxId(p.id, 4))
  })

  it("lets a Captain pick its project's GPU types, cloud and minimums, and list_projects says whose they are", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", {})
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const [before] = await captain("list_projects")
    expect(before.gpu).toMatchObject({ gpuTypes: "RTX A5000, A40 (global: Settings › RunPod GPU › GPU types)", cloud: "SECURE (global: Settings › RunPod GPU › Cloud)", minRamGb: "24 (global: Settings › RunPod GPU › Min RAM)", minVcpus: "8 (global: Settings › RunPod GPU › Min vCPUs)" })
    const updated = await captain("update_project", { gpu_types: ["NVIDIA RTX A4000", "NVIDIA GeForce RTX 3070"], gpu_cloud: "COMMUNITY", gpu_min_ram_gb: 32 })
    expect(updated.gpu).toMatchObject({ gpuTypes: "RTX A4000, RTX 3070 (this project)", cloud: "COMMUNITY (this project)", minRamGb: "32 (this project)", minVcpus: "8 (global: Settings › RunPod GPU › Min vCPUs)" })
    expect(r.yard.store.getProject(p.id)?.gpuMachine).toEqual({ gpuTypes: ["NVIDIA RTX A4000", "NVIDIA GeForce RTX 3070"], cloud: "COMMUNITY", minRamGb: 32, minVcpus: null })
    await captain("update_project", { gpu_cloud: null, gpu_types: null })
    expect(r.yard.store.getProject(p.id)?.gpuMachine).toEqual({ gpuTypes: null, cloud: null, minRamGb: 32, minVcpus: null })
  })

  it("holds a task back at the total cap across projects", async () => {
    const r = await start({ totalMaxHourlyUsd: 0.6 })
    const a = await gpuProject(r, "alpha", { agentsPerBox: 1 })
    const b = await gpuProject(r, "beta", { agentsPerBox: 1 })
    await working(r, await hang(r, a.id, "a1"))
    await working(r, await hang(r, b.id, "b1"))
    const third = await hang(r, a.id, "a2")
    await waits(r, third, /^Waiting: RunPod total cap \$0\.6\/hr reached: this Box Yard's 2 pods cost \$0\.54\/hr/)
    expect(r.pods.started.length).toBe(2)
  })

  it("stops each idle pod on its own, with the box history saying why", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1, maxBoxes: 2 })
    const a = await hang(r, p.id, "a")
    const b = await hang(r, p.id, "b")
    await working(r, a)
    await working(r, b)
    const idle = boxOf(r, b)!
    const busy = boxOf(r, a)!
    await r.yard.tasks.stopTask(b)
    await waitFor(() => !r.yard.store.getTaskRow(b)?.current_turn_id, "b to stop")
    // The sweep runs once a minute; jump past Settings › RunPod GPU › Stop when idle. A sweep that finds b's
    // workspace still archiving starts the archive and keeps the pod, so each try moves the clock a sweep further:
    // a clock that stood still would leave every later try inside the once-a-minute throttle.
    const sweep = (now: number) => (r.yard.tasks as unknown as { sweepGpuPods(now: number): Promise<void> }).sweepGpuPods(now)
    let clock = Date.now() + 60 * 60_000
    await waitFor(async () => {
      await sweep((clock += 61_000))
      return r.pods.terminated.includes(idle)
    }, "the idle pod to stop")
    expect(r.pods.terminated).toEqual([idle])
    expect(r.pods.pods.has(busy)).toBe(true)
    expect((await getTask(r, a)).status).toBe("working")
    const stopped = r.yard.tasks.history.list({}).find((e) => e.boxId === idle && e.type === "deleted")
    expect(stopped).toMatchObject({ actor: "janitor", boxName: `GPU pod #${idle === gpuBoxId(p.id) ? 1 : 2} · game` })
    expect(stopped?.reason).toMatch(/^Idle for/)

    // Stop from Settings › RunPod GPU ends one pod too, and refuses one with an agent running.
    await expect(r.yard.tasks.stopGpuPod(busy, { actor: { kind: "owner" }, reason: "test" })).rejects.toThrow(/An agent is running/)
  })

  it("adopts the pod a project already has (runpod-<projectId>) as its pod #1", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1, maxBoxes: 3 })
    // The one pod a project had before several were possible, still up from before a restart.
    r.pods.adopt(gpuBoxId(p.id))
    const a = await hang(r, p.id, "lane 1")
    await working(r, a)
    expect(boxOf(r, a)).toBe(gpuBoxId(p.id))
    expect(r.pods.started).toEqual([])
    const b = await hang(r, p.id, "lane 2")
    await working(r, b)
    expect(boxOf(r, b)).toBe(gpuBoxId(p.id, 2))
    expect(r.pods.started).toEqual([gpuBoxId(p.id, 2)])
  })
})
