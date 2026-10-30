import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { ONSTART_MAX, VastApi, VastError, hostPort, instanceStatus, offerQuery, sshEndpoint, vastGpuName, type OfferQuery, type VastInstance, type VastOffer } from "../server/vast/api.js"
import { VastSettingsStore } from "../server/vast/settings.js"
import { VastProvider, type VastProjectMachine } from "../server/providers/vast.js"
import { POD_HTTP_PORTS } from "../server/providers/runpod.js"
import { runpodDir } from "../server/runpod/image.js"
import { vastDir } from "../server/vast/service.js"
import type { SshPool, SshTarget } from "../server/runpod/ssh.js"
import { DEFAULT_VAST_SETTINGS, type VastSettings } from "../shared/vast.js"
import { gpuBoxIdOn, gpuBoxProvider } from "../shared/gpu.js"
import { gpuBoxIndex, gpuBoxProject, isGpuBox } from "../shared/runpod.js"
import { workerSystemPrompt } from "../server/prompts.js"
import type { Project } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// The Vast.ai GPU runner (docs/vast.md). Nothing here talks to Vast.ai: every call goes to a fake fetch that keeps
// instances in memory, and SSH is a fake that answers every command. Never point these at the real API: renting an
// offer spends money.

const BASE = "https://console.vast.ai/api/v0"

const offer = (id: number, gpu: string, usd: number, more: Partial<VastOffer> = {}): VastOffer => ({ id, gpu_name: gpu, num_gpus: 1, dph_total: usd, geolocation: "US", ...more })

interface FakeVast {
  impl: typeof fetch
  calls: { method: string; path: string; auth: string | null; body: unknown }[]
  instances: Map<number, VastInstance>
  offers: VastOffer[]
  created: { offerId: number; body: Record<string, unknown> }[]
  /** Offer ids PUT /asks/ answers "no_such_ask" for (taken between search and rent). */
  taken: Set<number>
  /** What each new instance bills, when it isn't its offer's price. */
  billedUsd: number | null
  /** Status each new instance starts in. */
  startStatus: string
  failNext: { status: number; body: unknown }[]
}

/** Vast.ai as fetch sees it: offers, instances by id, an account with credit. */
function fakeVast(o: { offers?: VastOffer[]; instances?: VastInstance[] } = {}): FakeVast {
  const f: FakeVast = {
    impl: null as never,
    calls: [],
    instances: new Map((o.instances ?? []).map((i) => [i.id, i])),
    offers: o.offers ?? [],
    created: [],
    taken: new Set(),
    billedUsd: null,
    startStatus: "running",
    failNext: [],
  }
  let next = 1000
  f.impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    expect(url.startsWith(BASE)).toBe(true)
    const p = url.slice(BASE.length)
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    f.calls.push({ method, path: p, auth: new Headers(init?.headers).get("authorization"), body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    const fail = f.failNext.shift()
    if (fail) return json(fail.body, fail.status)
    if (method === "POST" && p === "/bundles/") return json({ offers: f.offers })
    let m = /^\/asks\/(\d+)\/$/.exec(p)
    if (method === "PUT" && m) {
      const offerId = Number(m[1])
      if (f.taken.has(offerId)) return json({ success: false, error: "no_such_ask", msg: "Instance type no longer available" }, 400)
      const of = f.offers.find((x) => x.id === offerId)!
      const id = next++
      f.created.push({ offerId, body })
      const ports = Object.fromEntries([22, ...POD_HTTP_PORTS].map((port, i) => [`${port}/tcp`, [{ HostIp: "0.0.0.0", HostPort: String(40000 + i) }]]))
      f.instances.set(id, { id, label: body.label, actual_status: f.startStatus, gpu_name: of.gpu_name, dph_total: f.billedUsd ?? of.dph_total, public_ipaddr: "203.0.113.7 ", ports, start_date: 1_790_000_000, geolocation: of.geolocation })
      return json({ success: true, new_contract: id })
    }
    if (method === "GET" && p === "/instances/?owner=me") return json({ instances: [...f.instances.values()] })
    m = /^\/instances\/(\d+)\/(\?owner=me|ssh\/)?$/.exec(p)
    if (m) {
      const id = Number(m[1])
      const inst = f.instances.get(id)
      if (method === "GET") return inst ? json({ instances: inst }) : json({ error: "not found" }, 404)
      if (method === "POST" && m[2] === "ssh/") return inst ? json({ success: true }) : json({ error: "not found" }, 404)
      if (method === "DELETE") return f.instances.delete(id) ? json({ success: true }) : json({ error: "not found" }, 404)
    }
    if (method === "GET" && p === "/users/current/") return json({ id: 1, credit: 12.5 })
    return json({ error: "no route" }, 404)
  }) as typeof fetch
  return f
}

/** SSH that answers every command with `exit` (0 unless a test says otherwise), recording each. */
function fakeSsh() {
  const commands: { target: SshTarget; command: string }[] = []
  const ssh = {
    commands,
    closed: [] as string[],
    forgotten: [] as string[],
    exit: (_cmd: string) => 0,
    publicKey: () => "ssh-ed25519 AAAATESTKEY boxyard-test",
    async run(target: SshTarget, command: string) {
      commands.push({ target, command })
      return { exitCode: ssh.exit(command), stdout: Buffer.from(""), stderr: "" }
    },
    close(t: SshTarget) {
      ssh.closed.push(t.podId)
    },
    forget(podId: string) {
      ssh.forgotten.push(podId)
    },
  }
  return ssh
}

function provider(o: { settings?: Partial<VastSettings>; cap?: number | null; machine?: Partial<VastProjectMachine>; offers?: VastOffer[]; instances?: VastInstance[] } = {}) {
  const vast = fakeVast(o)
  const ssh = fakeSsh()
  const events: { boxId: string; kind: string; detail: string }[] = []
  const progress: string[] = []
  const p = new VastProvider({
    api: new VastApi(() => "vk-test", vast.impl, BASE, [1, 1]),
    ssh: ssh as unknown as SshPool,
    settings: () => ({ ...DEFAULT_VAST_SETTINGS, ...o.settings }),
    image: () => "docker.io/example/boxyard-gpu:1",
    install: () => "inst1",
    bootstrapDir: runpodDir(),
    scriptsDir: vastDir(),
    onEvent: (e) => events.push(e),
    onProgress: (_b, m) => progress.push(m),
    projectCap: () => o.cap ?? null,
    projectMachine: () => ({ gpuTypes: null, minRamGb: null, minVcpus: null, ...o.machine }),
  })
  return { p, vast, ssh, events, progress }
}

const BOX = gpuBoxIdOn("vast", "proj1")
const BOX2 = gpuBoxIdOn("vast", "proj1", 2)

describe("Vast.ai box ids", () => {
  it("are vastai-<projectId>[-<n>], GPU boxes of their project beside RunPod's", () => {
    expect(BOX).toBe("vastai-proj1")
    expect(BOX2).toBe("vastai-proj1-2")
    for (const id of [BOX, BOX2]) {
      expect(gpuBoxProvider(id)).toBe("vast")
      expect(isGpuBox(id)).toBe(true)
      expect(gpuBoxProject(id)).toBe("proj1")
    }
    expect(gpuBoxIndex(BOX2)).toBe(2)
    expect(gpuBoxProvider("runpod-proj1")).toBe("runpod")
    // Upstash names its boxes like "vast-lobster": those aren't Vast.ai's.
    expect(gpuBoxProvider("vast-lobster")).toBeNull()
  })
})

describe("VastApi", () => {
  const q: OfferQuery = { gpuTypes: ["RTX A5000", "RTX 3090"], minRamGb: 24, minVcpus: 8, diskGb: 40, verifiedOnly: true, minReliability: 0.95, minInetDownMbps: 100, minDirectPorts: 21, maxUsd: 0.6 }

  it("searches one on-demand GPU with the filters, cheapest first, with the key as a bearer token", async () => {
    const vast = fakeVast({ offers: [offer(1, "RTX A5000", 0.2)] })
    const api = new VastApi(() => "vk-secret", vast.impl, BASE, [1, 1])
    expect(await api.searchOffers(q)).toHaveLength(1)
    const [c] = vast.calls
    expect(c).toMatchObject({ method: "POST", path: "/bundles/", auth: "Bearer vk-secret" })
    expect(c!.body).toMatchObject({
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_name: { in: ["RTX A5000", "RTX 3090"] },
      cpu_ram: { gte: 24_000 },
      cpu_cores_effective: { gte: 8 },
      disk_space: { gte: 40 },
      direct_port_count: { gte: 21 },
      dph_total: { lte: 0.6 },
      type: "on-demand",
      order: [["dph_total", "asc"]],
    })
    // No price limit at 0, no verified filter when it's off, and no call at all with no GPU types.
    const open = offerQuery({ ...q, maxUsd: 0, verifiedOnly: false })
    expect(open).not.toHaveProperty("dph_total")
    expect(open).not.toHaveProperty("verified")
    expect(await api.searchOffers({ ...q, gpuTypes: [] })).toEqual([])
    expect(vast.calls).toHaveLength(1)
  })

  it("refuses to call Vast without a key", async () => {
    const vast = fakeVast()
    const api = new VastApi(() => "", vast.impl, BASE, [1, 1])
    await expect(api.listInstances()).rejects.toThrow(/No Vast.ai API key: add one in Settings › Credentials/)
    expect(vast.calls).toEqual([])
  })

  it("retries a rate-limited call, but not the daily search quota", async () => {
    const vast = fakeVast({ offers: [offer(1, "RTX A5000", 0.2)] })
    const api = new VastApi(() => "k", vast.impl, BASE, [1, 1])
    vast.failNext.push({ status: 429, body: { error: "rate_limited" } }, { status: 429, body: { error: "rate_limited" } })
    expect(await api.searchOffers(q)).toHaveLength(1)
    expect(vast.calls).toHaveLength(3)
    vast.failNext.push({ status: 429, body: { error: "search_quota_exceeded", msg: "Daily search limit reached" } })
    const err = (await api.searchOffers(q).catch((e) => e)) as VastError
    expect(err).toBeInstanceOf(VastError)
    expect(err.quota).toBe(true)
    expect(err.message).toMatch(/429 search_quota_exceeded: Daily search limit reached/)
    expect(vast.calls).toHaveLength(4)
  })

  it("rents an offer as an SSH instance, publishing each port, and says when it was taken", async () => {
    const vast = fakeVast({ offers: [offer(7, "RTX A5000", 0.2), offer(8, "RTX A5000", 0.21)] })
    const api = new VastApi(() => "k", vast.impl, BASE, [1, 1])
    const id = await api.createInstance(7, { image: "img:1", diskGb: 40, label: "boxyard-x-p", onstart: "echo hi", env: { A: "1" }, ports: [3000, 3010] })
    expect(vast.instances.has(id)).toBe(true)
    expect(vast.created[0]!.body).toEqual({ client_id: "me", image: "img:1", disk: 40, label: "boxyard-x-p", runtype: "ssh_direct", onstart: "echo hi", env: { A: "1", "-p 3000:3000": "1", "-p 3010:3010": "1" }, cancel_unavail: true })
    vast.taken.add(8)
    const err = (await api.createInstance(8, { image: "img:1", diskGb: 40, label: "l", onstart: "", env: {}, ports: [] }).catch((e) => e)) as VastError
    expect(err.gone).toBe(true)
    await expect(api.createInstance(7, { image: "i", diskGb: 40, label: "l", onstart: "x".repeat(ONSTART_MAX + 1), env: {}, ports: [] })).rejects.toThrow(/over Vast's 4048/)
  })

  it("reads a gone instance as null, destroys one that's already gone without an error, and reads the credit", async () => {
    const vast = fakeVast({ instances: [{ id: 5, actual_status: "running" }] })
    const api = new VastApi(() => "k", vast.impl, BASE, [1, 1])
    expect((await api.getInstance(5))?.id).toBe(5)
    expect(await api.getInstance(6)).toBeNull()
    await api.destroyInstance(5)
    await api.destroyInstance(5)
    expect(vast.instances.size).toBe(0)
    expect(await api.balance()).toBe(12.5)
  })

  it("attaches a key to one instance, never to the account", async () => {
    const vast = fakeVast({ instances: [{ id: 5, actual_status: "running" }] })
    const api = new VastApi(() => "k", vast.impl, BASE, [1, 1])
    await api.attachSshKey(5, "ssh-ed25519 AAAA")
    expect(vast.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /instances/5/ssh/"])
  })
})

describe("Vast.ai instances as pods", () => {
  it("maps Vast's statuses onto RunPod's words", () => {
    expect(instanceStatus({ actual_status: "running" })).toBe("RUNNING")
    for (const s of [null, "created", "loading"]) expect(instanceStatus({ actual_status: s })).toBe("STARTING")
    for (const s of ["stopped", "frozen"]) expect(instanceStatus({ actual_status: s })).toBe("EXITED")
    for (const s of ["exited", "unknown", "offline"]) expect(instanceStatus({ actual_status: s })).toBe("ERROR")
  })

  it("SSHes straight to the host when port 22 is published, else through Vast's proxy", () => {
    expect(sshEndpoint({ id: 1, public_ipaddr: "203.0.113.7 ", ports: { "22/tcp": [{ HostPort: "41022" }] }, ssh_host: "ssh4.vast.ai", ssh_port: 12345 })).toEqual({ host: "203.0.113.7", port: 41022 })
    expect(sshEndpoint({ id: 1, ssh_host: "ssh4.vast.ai", ssh_port: 12345 })).toEqual({ host: "ssh4.vast.ai", port: 12345 })
    expect(sshEndpoint({ id: 1 })).toBeNull()
    expect(hostPort({ id: 1, ports: { "3000/tcp": [{ HostPort: 40001 }] } }, 3000)).toBe(40001)
    expect(hostPort({ id: 1 }, 3000)).toBeNull()
  })

  it("names RunPod's GPU ids as Vast does", () => {
    expect(vastGpuName("NVIDIA RTX A5000")).toBe("RTX A5000")
    expect(vastGpuName("NVIDIA GeForce RTX 3090")).toBe("RTX 3090")
    expect(vastGpuName("A40")).toBe("A40")
  })
})

describe("Settings › Vast.ai GPU", () => {
  it("keeps the rest when one stored value is bad, and refuses a bad patch", () => {
    const store = new Store(openDb(tmpDir(), ":memory:"))
    const s = new VastSettingsStore(store)
    expect(s.get()).toEqual(DEFAULT_VAST_SETTINGS)
    expect(s.update({ maxHourlyUsd: 0.5, gpuTypes: ["RTX 4090"], defaultForGpu: true })).toMatchObject({ maxHourlyUsd: 0.5, gpuTypes: ["RTX 4090"], defaultForGpu: true })
    store.setKv("vast", JSON.stringify({ ...s.get(), minRamGb: "lots" }))
    expect(s.get()).toMatchObject({ maxHourlyUsd: 0.5, minRamGb: DEFAULT_VAST_SETTINGS.minRamGb })
    expect(() => s.update({ gpuTypes: [] })).toThrow(/Pick at least one GPU type/)
    expect(() => s.update({ apiKey: "x" })).toThrow()
    s.setKeepWarm(BOX, Date.now() + 60_000)
    expect(Object.keys(s.keepWarm())).toEqual([BOX])
    s.setKeepWarm(BOX, null)
    expect(s.keepWarm()).toEqual({})
  })
})

describe("VastProvider", () => {
  const OFFERS = [offer(1, "RTX 3090", 0.18, { geolocation: "Norway" }), offer(2, "RTX A5000", 0.22), offer(3, "RTX A5000", 0.25), offer(4, "A40", 0.4)]

  it("rents the cheapest offer of the first GPU type that has one, labels it for the box and lets Box Yard's key in", async () => {
    const { p, vast, ssh, events } = provider({ offers: OFFERS })
    await p.wake(BOX)
    // RTX A5000 comes first in the GPU types, so its cheapest goes before a cheaper RTX 3090.
    expect(vast.created.map((c) => c.offerId)).toEqual([2])
    const body = vast.created[0]!.body
    expect(body).toMatchObject({ image: "docker.io/example/boxyard-gpu:1", disk: 40, label: "boxyard-inst1-proj1", runtype: "ssh_direct" })
    for (const port of POD_HTTP_PORTS) expect((body.env as Record<string, string>)[`-p ${port}:${port}`]).toBe("1")
    expect(vast.calls.some((c) => c.method === "POST" && c.path.endsWith("/ssh/"))).toBe(true)
    expect(vast.calls.some((c) => c.path === "/ssh/")).toBe(false)
    expect(events).toEqual([{ boxId: BOX, kind: "started", detail: "RTX A5000 in US at $0.220/hr, instance 1000 (offer 2)" }])
    // It SSHed in straight to the host, uploaded bootstrap.sh and init.sh, and set the git identity.
    expect(ssh.commands[0]!.target).toEqual({ podId: "vast1000", host: "203.0.113.7", port: 40000 })
    expect(ssh.commands.some((c) => c.command.includes("/opt/boxyard/init.sh"))).toBe(true)
    // No author is baked into the instance: each turn brings its own (server/gitAuthor.ts).
    expect(ssh.commands.some((c) => c.command.includes("git config --global user."))).toBe(false)
    expect(await p.health(BOX)).toBe("running")
    expect(await p.publicUrl(BOX, POD_HTTP_PORTS[0]!)).toBe("http://203.0.113.7:40001")
    await expect(p.publicUrl(BOX, 5173)).rejects.toThrow(/Only the first port of each task/)
    expect((await p.listPods()).map((x) => x.boxId)).toEqual([BOX])
  })

  it("reuses a running instance instead of renting another", async () => {
    const { p, vast } = provider({ offers: OFFERS })
    await p.wake(BOX)
    await p.wake(BOX)
    expect(vast.created).toHaveLength(1)
  })

  it("leaves other installs' and other people's instances alone", async () => {
    const { p, vast } = provider({ offers: OFFERS, instances: [{ id: 1, label: "boxyard-other-proj1", actual_status: "running", dph_total: 0.3 }, { id: 2, label: "my-notebook", actual_status: "running", dph_total: 2 }] })
    expect(await p.listPods()).toEqual([])
    await p.wake(BOX)
    expect(vast.instances.has(1) && vast.instances.has(2)).toBe(true)
  })

  it("asks for the project's own GPU types and minimums, as Vast names them", async () => {
    const { p, vast } = provider({ offers: OFFERS, machine: { gpuTypes: ["NVIDIA GeForce RTX 3090"], minRamGb: 64 } })
    expect(p.machineOf("proj1")).toEqual({ gpuTypes: ["RTX 3090"], minRamGb: 64, minVcpus: 8 })
    await p.wake(BOX)
    expect(vast.created.map((c) => c.offerId)).toEqual([1])
    const search = vast.calls.find((c) => c.path === "/bundles/")!.body as Record<string, unknown>
    expect(search).toMatchObject({ gpu_name: { in: ["RTX 3090"] }, cpu_ram: { gte: 64_000 } })
  })

  it("searches only under the room the caps leave, and refuses to rent at all when they're reached", async () => {
    const running = (id: number, label: string, usd: number): VastInstance => ({ id, label, actual_status: "running", dph_total: usd })
    const { p, vast } = provider({ offers: OFFERS, settings: { maxHourlyUsd: 1, totalMaxHourlyUsd: 3 }, instances: [running(1, "boxyard-inst1-proj1", 0.7), running(2, "boxyard-inst1-other", 2)] })
    await p.wake(BOX2)
    const search = vast.calls.find((c) => c.path === "/bundles/")!.body as Record<string, unknown>
    // The project has $0.30/hr left of its $1, the install $0.30/hr of its $3.
    expect((search.dph_total as { lte: number }).lte).toBeCloseTo(0.3)

    const full = provider({ offers: OFFERS, settings: { maxHourlyUsd: 1 }, instances: [running(1, "boxyard-inst1-proj1", 1)] })
    await expect(full.p.wake(BOX2)).rejects.toThrow(/the \$\/hr caps are reached \(the project's instances cost \$1\.00\/hr/)
    expect(full.vast.created).toEqual([])
  })

  it("destroys an instance Vast bills over the caps and tries the next offer", async () => {
    const { p, vast } = provider({ offers: OFFERS, settings: { maxHourlyUsd: 0.3, gpuTypes: ["RTX A5000"] } })
    vast.billedUsd = 0.5
    await expect(p.wake(BOX)).rejects.toThrow(/came back at \$0\.5\/hr, over the caps/)
    expect(vast.created.map((c) => c.offerId)).toEqual([2, 3])
    expect(vast.instances.size).toBe(0)
  })

  it("moves on to the next offer when one is taken between search and rent", async () => {
    const { p, vast } = provider({ offers: OFFERS })
    vast.taken.add(2)
    await p.wake(BOX)
    expect(vast.created.map((c) => c.offerId)).toEqual([3])
  })

  it("says what to change when no offer fits", async () => {
    const { p } = provider({ offers: [] })
    await expect(p.wake(BOX)).rejects.toThrow(/No Vast.ai offer of RTX A5000, RTX 3090, A40 with 24 GB RAM, 8 vCPUs.*Settings › Vast.ai GPU/)
  })

  it("destroys an instance that failed to start, so nothing bills", async () => {
    const { p, vast } = provider({ offers: OFFERS })
    vast.startStatus = "exited"
    await expect(p.wake(BOX)).rejects.toThrow(/instance 1000 exited while starting/)
    expect(vast.instances.size).toBe(0)
    expect(await p.health(BOX)).toBe("paused")
  })

  it("destroys a stopped instance and rents a new one: a stopped Vast instance may never get its GPU back", async () => {
    const { p, vast } = provider({ offers: OFFERS, instances: [{ id: 9, label: "boxyard-inst1-proj1", actual_status: "stopped", dph_total: 0.2 }] })
    expect(await p.health(BOX)).toBe("paused")
    await p.wake(BOX)
    expect(vast.instances.has(9)).toBe(false)
    expect(vast.created).toHaveLength(1)
  })

  it("destroys the box's instance and says so, and destroying a box with none does nothing", async () => {
    const { p, vast, events, ssh } = provider({ offers: OFFERS })
    await p.wake(BOX)
    await p.destroy(BOX)
    expect(vast.instances.size).toBe(0)
    expect(events.at(-1)).toEqual({ boxId: BOX, kind: "terminated", detail: "RTX A5000 instance 1000 destroyed" })
    expect(ssh.forgotten).toEqual(["vast1000"])
    expect(await p.health(BOX)).toBe("paused")
    await p.destroy(BOX2)
    expect(vast.calls.filter((c) => c.method === "DELETE")).toHaveLength(1)
  })

  it("prices the next instance from the cheapest offer of the first GPU type within the cap", async () => {
    const { p } = provider({ offers: OFFERS })
    expect(await p.nextPodPrice("proj1")).toEqual({ gpu: "RTX A5000 (Vast.ai)", usd: 0.22 })
    expect(await provider({ offers: [] }).p.nextPodPrice("proj1")).toBeNull()
    expect(p.capOf("proj1")).toBe(1)
    expect(provider({ cap: 2.5 }).p.capOf("proj1")).toBe(2.5)
  })

  it("caches offer searches for placement (Vast has a daily search quota), but searches again to rent", async () => {
    const { p, vast } = provider({ offers: OFFERS })
    await p.nextPodPrice("proj1")
    await p.nextPodPrice("proj1")
    expect(vast.calls.filter((c) => c.path === "/bundles/")).toHaveLength(1)
    await p.wake(BOX)
    expect(vast.calls.filter((c) => c.path === "/bundles/")).toHaveLength(2)
  })

  it("starts the watchdog from an onstart script within Vast's limit, with no secret of Box Yard's in it", () => {
    const { p } = provider({ settings: { watchdogMinutes: 45 } })
    const s = p.onstart()
    expect(s.length).toBeLessThanOrEqual(ONSTART_MAX)
    expect(s).toContain("ssh-ed25519 AAAATESTKEY boxyard-test")
    expect(s).toContain("/opt/boxyard/watchdog.sh")
    expect(s).toContain("CONTAINER_API_KEY")
    expect(s).toContain('"$CONTAINER_API_KEY" 45 > /opt/boxyard/vast.env')
    expect(s).not.toContain("vk-test")
    // The watchdog destroys this instance with its own instance-scoped key.
    expect(s).toContain('-X DELETE "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/"')
  })

  it("never makes a box through the pool", async () => {
    const { p } = provider()
    await expect(p.create({ labels: [] })).rejects.toThrow(/aren't made through the box pool/)
    await expect(p.wake("runpod-proj1")).rejects.toThrow(/isn't a Vast.ai box/)
  })
})

describe("worker prompt on a GPU instance", () => {
  const project = { id: "prj_1", name: "Game", description: "" } as Project
  const task = { id: "task_1", title: "T" }
  const prompt = (cloud?: "vast") => workerSystemPrompt({ project, task, branch: "b", port: 4000, box: { memoryBytes: null, slots: 2, gpu: { name: "RTX A5000", ...(cloud ? { cloud } : {}) } } })

  it("says Vast.ai, plain-HTTP previews and no network volume", () => {
    const p = prompt("vast")
    expect(p).toContain("running on a Vast.ai GPU instance of your project's own")
    expect(p).toContain("Your instance has an NVIDIA RTX A5000, shared with up to 1 other agents")
    expect(p).toContain("plain HTTP")
    expect(p).toContain("There's no network volume")
    expect(p).not.toMatch(/RunPod|\/workspace\/data/)
  })

  it("is RunPod's when the cloud is unset", () => {
    const p = prompt()
    expect(p).toContain("running on a RunPod GPU pod of your project's own")
    expect(p).toContain("RunPod's HTTPS proxy")
    expect(p).toContain("/workspace/data is the project's network volume")
    expect(p).not.toContain("Vast.ai")
  })
})
