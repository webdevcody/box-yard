import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxHealth } from "../server/providers/types.js"
import type { GpuPod, GpuRunner, GpuRunnerSettings } from "../server/tasks.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { GPU_BOX_PREFIXES, gpuBoxIdOn, type GpuProvider } from "../shared/gpu.js"
import { DEFAULT_RUNPOD_SETTINGS } from "../shared/runpod.js"
import { DEFAULT_VAST_SETTINGS, type VastStatus } from "../shared/vast.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// "Runs on: GPU" with two clouds (docs/vast.md): a project's GPU boxes are RunPod pods (runpod-<projectId>[-<n>]) or
// Vast.ai instances (vastai-<projectId>[-<n>]), by its own GPU cloud or Settings › Vast.ai GPU › Use for GPU projects.
// Both clouds are fakes: an "instance" is a folder on this machine. Nothing here talks to Vast.ai or RunPod, and the
// real Vast client gets a fetch that fails every call.

/** A GPU cloud stand-in: `wake` starts an instance (a folder) at `price`, `destroy` ends it. */
class FakeCloud extends LocalProvider {
  pods = new Map<string, GpuPod>()
  started: string[] = []
  terminated: string[] = []
  /** Where the real runner reports instances it starts (TaskManager.gpuPodEvent). */
  onEvent: ((e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void) | null = null
  private n = 0

  constructor(
    dir: string,
    readonly cloud: GpuProvider,
    public price: number,
    private readonly settings: () => GpuRunnerSettings,
    private readonly projectCap: (projectId: string) => number | null,
  ) {
    super(dir, FAKE_CLAUDE)
  }

  override async wake(boxId: string) {
    expect(boxId.startsWith(GPU_BOX_PREFIXES[this.cloud])).toBe(true)
    if (this.pods.has(boxId)) return
    this.started.push(boxId)
    this.pods.set(boxId, { id: `${this.cloud}${++this.n}`, status: "RUNNING", cost: this.price, gpu: { id: "RTX A5000" }, startedAt: new Date().toISOString() })
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
    this.onEvent?.({ boxId, kind: "started", detail: `RTX A5000 at $${this.price}/hr` })
  }

  override async health(boxId: string): Promise<BoxHealth> {
    return this.pods.has(boxId) ? "running" : "paused"
  }

  override async destroy(boxId: string) {
    if (!this.pods.delete(boxId)) return
    this.terminated.push(boxId)
    await super.destroy(boxId)
  }

  async listPods() {
    return [...this.pods].map(([boxId, pod]) => ({ boxId, pod }))
  }

  cached(boxId: string) {
    return this.pods.get(boxId) ?? null
  }

  capOf(projectId: string) {
    return this.projectCap(projectId) ?? this.settings().maxHourlyUsd
  }

  async nextPodPrice(projectId: string) {
    const cap = this.capOf(projectId)
    return !cap || this.price <= cap ? { gpu: this.cloud === "vast" ? "RTX A5000 (Vast.ai)" : "RTX A5000", usd: this.price } : null
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  runpod: FakeCloud
  vast: FakeCloud
  vastSettings: GpuRunnerSettings
  /** Every call the real Vast client made (it should make none it can't: no key). */
  vastCalls: string[]
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(o: { vast?: Partial<GpuRunnerSettings> } = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const runpodSettings = { ...DEFAULT_RUNPOD_SETTINGS }
  const vastSettings: GpuRunnerSettings = { ...DEFAULT_VAST_SETTINGS, ...o.vast }
  let yard: BoxYard | null = null
  const cap = (id: string) => yard?.store.projectGpuCap(id) ?? null
  const runpod = new FakeCloud(tmpDir("runpod-"), "runpod", 0.27, () => runpodSettings, cap)
  const vast = new FakeCloud(tmpDir("vast-"), "vast", 0.2, () => vastSettings, cap)
  const gpu: GpuRunner = { provider: runpod, settings: () => runpodSettings, enabled: () => true, keepWarmUntil: () => null }
  const vastRunner: GpuRunner = { kind: "vast", provider: vast, settings: () => vastSettings, enabled: () => true, keepWarmUntil: () => null }
  const vastCalls: string[] = []
  const vastFetch = (async (url: string | URL, init?: RequestInit) => {
    vastCalls.push(`${init?.method ?? "GET"} ${url}`)
    throw new Error("No real Vast.ai in tests")
  }) as typeof fetch
  yard = createBoxYard(config, { webDir: "/nonexistent", gpu, vast: vastRunner, vastFetch })
  const y = yard
  for (const c of [runpod, vast]) c.onEvent = (e) => y.tasks.gpuPodEvent(e)
  const server = await new Promise<Server>((resolve) => {
    const s = y.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await y.start()
  const r = { yard: y, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, runpod, vast, vastSettings, vastCalls }
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

const gpuProject = (r: Running, name: string, settings: Partial<Pick<Project, "agentsPerBox" | "maxBoxes" | "gpuMaxHourlyUsd" | "gpuProvider">> = {}) =>
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
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes
    const text = res.content[0]!.text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

describe("Vast.ai GPU: a second cloud behind Runs on: GPU", () => {
  it("runs a project whose GPU cloud is Vast.ai on vastai-<projectId> instances, and leaves RunPod alone", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { gpuProvider: "vast", agentsPerBox: 1, maxBoxes: 3 })
    expect(p.gpuProvider).toBe("vast")
    const ids = [await hang(r, p.id, "lane 1"), await hang(r, p.id, "lane 2")]
    for (const id of ids) await working(r, id)
    expect(ids.map((id) => boxOf(r, id)).sort()).toEqual([gpuBoxIdOn("vast", p.id), gpuBoxIdOn("vast", p.id, 2)])
    expect(r.vast.started).toHaveLength(2)
    expect(r.runpod.started).toEqual([])
    // Its box history says which cloud made it.
    const made = r.yard.tasks.history.list({}).find((e) => e.boxId === gpuBoxIdOn("vast", p.id) && e.type === "created")
    expect(made).toMatchObject({ actor: "scheduler", reason: "A task of a Vast.ai GPU project needed its pod.", detail: "RTX A5000 at $0.2/hr" })
  })

  it("keeps a GPU project on RunPod by default, and sends it to Vast.ai when Settings › Vast.ai GPU says so", async () => {
    const r = await start()
    const a = await gpuProject(r, "alpha", { agentsPerBox: 1 })
    expect(a.gpuProvider).toBeNull()
    const t1 = await hang(r, a.id, "on runpod")
    await working(r, t1)
    expect(boxOf(r, t1)).toBe(gpuBoxIdOn("runpod", a.id))

    r.vastSettings.defaultForGpu = true
    const b = await gpuProject(r, "beta", { agentsPerBox: 1 })
    const own = await gpuProject(r, "gamma", { agentsPerBox: 1, gpuProvider: "runpod" })
    const t2 = await hang(r, b.id, "on vast")
    const t3 = await hang(r, own.id, "still runpod")
    await working(r, t2)
    await working(r, t3)
    expect(boxOf(r, t2)).toBe(gpuBoxIdOn("vast", b.id))
    expect(boxOf(r, t3)).toBe(gpuBoxIdOn("runpod", own.id))
  })

  it("holds a task back at the Vast.ai project cap and says which cloud's cap it is", async () => {
    // $0.20/hr instances under a $0.5/hr cap: two fit, a third would be $0.60/hr.
    const r = await start({ vast: { maxHourlyUsd: 0.5 } })
    const p = await gpuProject(r, "game", { gpuProvider: "vast", agentsPerBox: 1, maxBoxes: 4 })
    await working(r, await hang(r, p.id, "lane 1"))
    await working(r, await hang(r, p.id, "lane 2"))
    const third = await hang(r, p.id, "lane 3")
    const t = await waits(r, third, /^Waiting: Vast\.ai cap \$0\.5\/hr reached: game's 2 pods cost \$0\.4\/hr and another RTX A5000 \(Vast\.ai\) is \$0\.2\/hr/)
    expect(t.waitReason).toMatch(/Settings › Vast\.ai GPU › Max per project is the default/)
    expect(r.vast.started).toHaveLength(2)

    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const pool = await captain("pool_status")
    expect(pool.gpu_projects.game).toMatchObject({ spend: "$0.4/hr" })
    expect(JSON.stringify(pool.gpu_projects.game)).toMatch(/Vast\.ai/)
    expect(pool.gpu_projects.game.pods).toHaveLength(2)

    await captain("update_project", { gpu_max_hourly_usd: 1 })
    await working(r, third)
    expect(boxOf(r, third)).toBe(gpuBoxIdOn("vast", p.id, 3))
  })

  it("holds a task back at the Vast.ai total cap, which counts only Vast.ai's instances", async () => {
    const r = await start({ vast: { totalMaxHourlyUsd: 0.3 } })
    const onRunpod = await gpuProject(r, "rp", { agentsPerBox: 1 })
    const a = await gpuProject(r, "alpha", { gpuProvider: "vast", agentsPerBox: 1 })
    const b = await gpuProject(r, "beta", { gpuProvider: "vast", agentsPerBox: 1 })
    await working(r, await hang(r, onRunpod.id, "rp1"))
    await working(r, await hang(r, a.id, "a1"))
    const blocked = await hang(r, b.id, "b1")
    await waits(r, blocked, /^Waiting: Vast\.ai total cap \$0\.3\/hr reached/)
    expect(r.vast.started).toHaveLength(1)
  })

  it("lets a Captain move its project to Vast.ai with update_project gpu_provider", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { agentsPerBox: 1 })
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const updated = await captain("update_project", { gpu_provider: "vast" })
    expect(JSON.stringify(updated)).toMatch(/Vast\.ai/)
    expect(r.yard.store.getProject(p.id)?.gpuProvider).toBe("vast")
    const t = await hang(r, p.id, "lane")
    await working(r, t)
    expect(boxOf(r, t)).toBe(gpuBoxIdOn("vast", p.id))
    await captain("update_project", { gpu_provider: null })
    expect(r.yard.store.getProject(p.id)?.gpuProvider).toBeNull()
  })

  it("destroys an idle Vast.ai instance on its own, with the box history saying why", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { gpuProvider: "vast", agentsPerBox: 1, maxBoxes: 2 })
    const a = await hang(r, p.id, "a")
    const b = await hang(r, p.id, "b")
    await working(r, a)
    await working(r, b)
    const idle = boxOf(r, b)!
    const busy = boxOf(r, a)!
    await r.yard.tasks.stopTask(b)
    await waitFor(() => !r.yard.store.getTaskRow(b)?.current_turn_id, "b to stop")
    const sweep = (now: number) => (r.yard.tasks as unknown as { sweepGpuPods(now: number): Promise<void> }).sweepGpuPods(now)
    let clock = Date.now() + 60 * 60_000
    await waitFor(async () => {
      await sweep((clock += 61_000))
      return r.vast.terminated.includes(idle)
    }, "the idle instance to go")
    expect(r.vast.terminated).toEqual([idle])
    expect(r.vast.pods.has(busy)).toBe(true)
    const gone = r.yard.tasks.history.list({}).find((e) => e.boxId === idle && e.type === "deleted")
    expect(gone).toMatchObject({ actor: "janitor" })
    expect(gone?.reason).toMatch(/^Idle for/)
    await expect(r.yard.tasks.stopGpuPod(busy, { actor: { kind: "owner" }, reason: "test" })).rejects.toThrow(/An agent is running/)
  })

  it("delete_box refuses a Vast.ai instance with an agent running, and destroys an idle one", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { gpuProvider: "vast", agentsPerBox: 1, maxBoxes: 2 })
    const a = await hang(r, p.id, "a")
    const b = await hang(r, p.id, "b")
    await working(r, a)
    await working(r, b)
    await r.yard.tasks.stopTask(b)
    await waitFor(() => !r.yard.store.getTaskRow(b)?.current_turn_id, "b to stop")
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const refused = await captain("delete_box", { box: boxOf(r, a), reason: "test the safety check" })
    expect(JSON.stringify(refused)).toMatch(/running/i)
    expect(r.vast.terminated).toEqual([])

    const dry = await captain("delete_idle_boxes", {})
    expect(JSON.stringify(dry.would_delete)).toContain("Vast.ai")
    const idle = boxOf(r, b)!
    const res = await captain("delete_box", { box: idle, reason: "Done with lane b" })
    expect(res.volume).toMatch(/^none \(a Vast\.ai instance's disk goes with it/)
    expect(r.vast.terminated).toEqual([idle])
    expect(r.yard.tasks.history.list({}).find((e) => e.boxId === idle && e.type === "deleted")).toMatchObject({ reason: "Done with lane b" })
  })

  it("serves Settings › Vast.ai GPU without a key and never calls Vast.ai for it", async () => {
    const r = await start()
    const status = await call<VastStatus>(r, "GET", "/api/vast")
    expect(status).toMatchObject({ apiKey: false, instances: [], problem: "Add a Vast.ai API key to run projects on Vast.ai GPUs" })
    const saved = await call<VastStatus>(r, "PUT", "/api/vast/settings", { maxHourlyUsd: 0.75, gpuTypes: ["RTX 4090"] })
    expect(saved.settings).toMatchObject({ maxHourlyUsd: 0.75, gpuTypes: ["RTX 4090"] })
    await expect(call(r, "PUT", "/api/vast/settings", { gpuTypes: [] })).rejects.toThrow(/400/)
    expect(r.vastCalls).toEqual([])
  })
})
