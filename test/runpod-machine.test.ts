import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { RunPodApi, type RunPodPod } from "../server/runpod/api.js"
import { RunPodSettingsStore } from "../server/runpod/settings.js"
import { RunPodService } from "../server/runpod/service.js"
import { runpodDir } from "../server/runpod/image.js"
import { RunPodProvider, catalogPrice } from "../server/providers/runpod.js"
import { SshPool } from "../server/runpod/ssh.js"
import type { CredentialStore } from "../server/credentials.js"
import { DEFAULT_RUNPOD_SETTINGS, RUNPOD_GPU_GUIDE, gpuHint, gpuPrice, type ProjectGpuMachine, type RunPodSettings } from "../shared/runpod.js"
import { tmpDir } from "./helpers.js"

// A GPU project's machine (docs/runpod.md): which GPU types, Secure or Community Cloud, and the least host RAM and
// vCPUs its new pods ask RunPod for, and the cap math at each GPU's price on that cloud. Nothing here talks to
// RunPod: every call goes to a fake fetch, whose catalog rows are copied from GET /v2/catalog/gpus.

const A4000 = "NVIDIA RTX A4000"
const ADA = "NVIDIA RTX 4000 Ada Generation"
const RTX3070 = "NVIDIA GeForce RTX 3070"
const A5000 = "NVIDIA RTX A5000"

/** RunPod's catalog as GET /v2/catalog/gpus returned it on 2026-10-25 (the fields Box Yard reads). */
const CATALOG = [
  { id: RTX3070, name: "RTX 3070", memory: 8, secure: false, community: true, price: { secure: 0, community: 0.13 }, availability: "LOW" },
  { id: A4000, name: "RTX A4000", memory: 16, secure: true, community: true, price: { secure: 0.25, community: 0.17 }, availability: "LOW" },
  { id: ADA, name: "RTX 4000 Ada", memory: 20, secure: true, community: true, price: { secure: 0.28, community: 0.2 }, availability: "LOW" },
  { id: A5000, name: "RTX A5000", memory: 24, secure: true, community: true, price: { secure: 0.27, community: 0.16 }, availability: "LOW" },
  { id: "NVIDIA A40", name: "A40", memory: 48, secure: true, community: false, price: { secure: 0.59, community: 0.35 }, availability: "HIGH" },
]

function store() {
  return new Store(openDb(tmpDir(), ":memory:"))
}

/** A fake RunPod: records each POST /pods body, and every pod it makes is gone by the first poll (so wake stops there). */
function fakeRunPod(o: { pods?: RunPodPod[]; volumes?: unknown[] } = {}) {
  const created: Record<string, unknown>[] = []
  const calls: string[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input).replace("https://api.runpod.io/v2", "")
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (method === "POST" && url === "/pods") {
      created.push(JSON.parse(String(init!.body)))
      return json({ id: `pod${created.length}`, name: "x", status: "PROVISIONING", cost: 0.1 })
    }
    if (method === "POST" && url.startsWith("/pods/")) return json({})
    if (method === "GET" && url.startsWith("/pods/")) return json({ detail: "gone" }, 404)
    if (method === "GET" && url.startsWith("/pods")) return json({ pods: o.pods ?? [] })
    if (url.startsWith("/catalog/gpus")) return json({ gpus: CATALOG })
    if (url.startsWith("/catalog/datacenters")) {
      return json({ dataCenters: [{ id: "EU-RO-1", name: "EU-RO-1", networkVolumeTypes: ["STANDARD"], gpuAvailability: CATALOG.map((g) => ({ id: g.id, name: g.name, availability: "HIGH" })) }] })
    }
    if (method === "GET" && url.startsWith("/network-volumes")) return json({ networkVolumes: o.volumes ?? [] })
    if (method === "POST" && url === "/network-volumes") return json({ id: "vol1", name: "v", size: 30, dataCenter: "EU-RO-1", type: "STANDARD" })
    return json({ detail: "not found" }, 404)
  }) as typeof fetch
  return { impl, created, calls }
}

function provider(o: { settings?: Partial<RunPodSettings>; machine?: Partial<ProjectGpuMachine>; cap?: number | null; pods?: RunPodPod[]; volumes?: unknown[] } = {}) {
  const f = fakeRunPod(o)
  const p = new RunPodProvider({
    api: new RunPodApi(() => "k", f.impl),
    ssh: new SshPool(tmpDir()),
    settings: () => ({ ...DEFAULT_RUNPOD_SETTINGS, ...o.settings }),
    install: () => "inst1",
    scriptsDir: runpodDir(),
    projectCap: () => o.cap ?? null,
    projectMachine: () => ({ gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null, ...o.machine }),
  })
  return Object.assign(p, { created: f.created, calls: f.calls })
}

describe("the GPU types for browser and WebGL games", () => {
  it("are RunPod's exact gpuTypeIds, each with VRAM, a rough price and what it's for", () => {
    for (const id of [RTX3070, A4000, ADA, A5000]) expect(CATALOG.map((g) => g.id)).toContain(id)
    expect(Object.keys(RUNPOD_GPU_GUIDE)).toEqual(expect.arrayContaining([RTX3070, A4000, ADA, A5000, "NVIDIA A40", "NVIDIA RTX A6000"]))
    expect(RUNPOD_GPU_GUIDE[A4000]).toMatchObject({ vramGb: 16 })
    expect(RUNPOD_GPU_GUIDE[ADA]).toMatchObject({ vramGb: 20 })
    expect(RUNPOD_GPU_GUIDE[RTX3070]).toMatchObject({ vramGb: 8 })
    expect(gpuHint(A4000)).toBe("16 GB, ~$0.17–0.25/hr, browser and WebGL game testing")
    expect(gpuHint(RTX3070)).toMatch(/^8 GB, ~\$0\.13\/hr, Community only, /)
    expect(gpuHint("NVIDIA H100 80GB HBM3")).toBeNull()
  })

  it("are offered in the picker with both prices, Community-only ones too, cheapest first", async () => {
    const f = fakeRunPod()
    const credentials = { get: () => "k" } as unknown as CredentialStore
    const svc = new RunPodService({ store: store(), credentials, dataDir: tmpDir(), install: () => "inst1", fetch: f.impl })
    const options = await svc.gpuOptions()
    expect(options.map((g) => g.id)).toEqual([RTX3070, A5000, A4000, ADA, "NVIDIA A40"])
    expect(options[0]).toEqual({ id: RTX3070, name: "RTX 3070", memoryGb: 8, securePrice: null, communityPrice: 0.13, availability: "LOW", use: RUNPOD_GPU_GUIDE[RTX3070]!.use })
    expect(options.find((g) => g.id === A4000)).toMatchObject({ securePrice: 0.25, communityPrice: 0.17, use: "browser and WebGL game testing" })
    expect(options.find((g) => g.id === "NVIDIA A40")).toMatchObject({ securePrice: 0.59, communityPrice: null })
    expect(gpuPrice(options[0]!, "SECURE")).toBeNull()
    expect(gpuPrice(options[0]!, "COMMUNITY")).toBe(0.13)
  })
})

describe("RunPod machine settings", () => {
  it("default to Secure Cloud, 24 GB of RAM and 8 vCPUs, and take Community and other minimums", () => {
    const s = new RunPodSettingsStore(store())
    expect(s.get()).toMatchObject({ cloud: "SECURE", minRamGb: 24, minVcpus: 8 })
    expect(s.update({ cloud: "COMMUNITY", minRamGb: 32, minVcpus: 4 })).toMatchObject({ cloud: "COMMUNITY", minRamGb: 32, minVcpus: 4 })
    expect(() => s.update({ cloud: "CHEAP" })).toThrow(/cloud/)
    expect(() => s.update({ minRamGb: 0 })).toThrow(/minRamGb/)
    expect(() => s.update({ minVcpus: 2.5 })).toThrow(/minVcpus/)
  })

  it("are a project's own when it sets them, and null goes back to the global ones", () => {
    const st = store()
    const p = st.createProject({ name: "game", runner: "gpu" })
    expect(p.gpuMachine).toEqual({ gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null })
    st.updateProject(p.id, { gpuMachine: { gpuTypes: [A4000, ADA], cloud: "COMMUNITY", minRamGb: 32 } })
    expect(st.getProject(p.id)!.gpuMachine).toEqual({ gpuTypes: [A4000, ADA], cloud: "COMMUNITY", minRamGb: 32, minVcpus: null })
    expect(st.projectGpuMachine(p.id)).toEqual(st.getProject(p.id)!.gpuMachine)
    st.updateProject(p.id, { gpuMachine: { minVcpus: 12 } })
    expect(st.projectGpuMachine(p.id)).toMatchObject({ cloud: "COMMUNITY", minVcpus: 12 })
    st.updateProject(p.id, { gpuMachine: { gpuTypes: null, cloud: null } })
    expect(st.projectGpuMachine(p.id)).toEqual({ gpuTypes: null, cloud: null, minRamGb: 32, minVcpus: 12 })
  })

  it("go to RunPod with the pod: a Secure pod on the project's volume, with the global minimums", async () => {
    const p = provider()
    await expect(p.wake("runpod-prj_a")).rejects.toThrow(/gone|terminated/)
    expect(p.created).toHaveLength(1)
    expect(p.created[0]).toMatchObject({
      cloud: "SECURE",
      dataCenterIds: ["EU-RO-1"],
      gpu: { id: A5000, count: 1, minRamPerGpu: 24, minVcpuCountPerGpu: 8 },
      mounts: { network: [{ volumeId: "vol1", path: "/workspace" }] },
    })
  })

  it("go to RunPod with the pod: a Community pod has no volume and RunPod picks where, with the project's minimums", async () => {
    const p = provider({ machine: { gpuTypes: [RTX3070, A4000], cloud: "COMMUNITY", minRamGb: 32, minVcpus: 6 } })
    await expect(p.wake("runpod-prj_a")).rejects.toThrow(/gone|terminated/)
    expect(p.created).toHaveLength(1)
    const body = p.created[0]!
    expect(body).toMatchObject({ cloud: "COMMUNITY", gpu: { id: RTX3070, count: 1, minRamPerGpu: 32, minVcpuCountPerGpu: 6 } })
    expect(body).not.toHaveProperty("dataCenterIds")
    expect(body).not.toHaveProperty("mounts")
    expect(p.calls.some((c) => c.includes("network-volumes") || c.includes("datacenters"))).toBe(false)
  })

  it("skip a GPU type the cloud doesn't offer: an RTX 3070 on Secure Cloud tries the next one", async () => {
    const p = provider({ machine: { gpuTypes: [RTX3070, A4000] } })
    await expect(p.wake("runpod-prj_a-2")).rejects.toThrow(/gone|terminated/)
    expect(p.created[0]).toMatchObject({ cloud: "SECURE", gpu: { id: A4000 } })
  })
})

describe("the $/hr caps", () => {
  it("price a GPU on the project's cloud", () => {
    const [rtx3070, a4000] = CATALOG
    expect(catalogPrice(rtx3070!, "SECURE")).toBeNull()
    expect(catalogPrice(rtx3070!, "COMMUNITY")).toBe(0.13)
    expect(catalogPrice(a4000!, "SECURE")).toBe(0.25)
    expect(catalogPrice(a4000!, "COMMUNITY")).toBe(0.17)
    expect(catalogPrice(CATALOG[4]!, "COMMUNITY")).toBeNull()
  })

  it("count the next pod at its GPU's price on that cloud", async () => {
    expect(await provider().nextPodPrice("prj_a")).toEqual({ gpu: "RTX A5000", usd: 0.27 })
    expect(await provider({ settings: { cloud: "COMMUNITY" } }).nextPodPrice("prj_a")).toEqual({ gpu: "RTX A5000 (Community)", usd: 0.16 })
    expect(await provider({ machine: { gpuTypes: [A4000] } }).nextPodPrice("prj_a")).toEqual({ gpu: "RTX A4000", usd: 0.25 })
    expect(await provider({ machine: { gpuTypes: [ADA], cloud: "COMMUNITY" } }).nextPodPrice("prj_a")).toEqual({ gpu: "RTX 4000 Ada Generation (Community)", usd: 0.2 })
    expect(await provider({ machine: { gpuTypes: [RTX3070, A4000], cloud: "COMMUNITY" } }).nextPodPrice("prj_a")).toEqual({ gpu: "RTX 3070 (Community)", usd: 0.13 })
    // Under a $0.20 cap only Community fits: A4000 is $0.25 on Secure, $0.17 on Community.
    expect(await provider({ machine: { gpuTypes: [A4000] }, cap: 0.2 }).nextPodPrice("prj_a")).toBeNull()
    expect(await provider({ machine: { gpuTypes: [A4000], cloud: "COMMUNITY" }, cap: 0.2 }).nextPodPrice("prj_a")).toEqual({ gpu: "RTX A4000 (Community)", usd: 0.17 })
  })

  it("hold a pod back at the project's cap, at its GPU's price on that cloud", async () => {
    const pods: RunPodPod[] = [
      { id: "p1", name: "boxyard-inst1-prj_a", status: "RUNNING", cost: 0.13 },
      { id: "p2", name: "boxyard-inst1-prj_a-2", status: "RUNNING", cost: 0.13 },
    ]
    const p = provider({ pods, machine: { gpuTypes: [RTX3070], cloud: "COMMUNITY" }, cap: 0.35 })
    await expect(p.wake("runpod-prj_a-3")).rejects.toThrow(/RTX 3070 would take the project's pods to \$0\.39\/hr, over its \$0\.35\/hr cap/)
    expect(p.created).toHaveLength(0)
    const fits = provider({ pods, machine: { gpuTypes: [RTX3070], cloud: "COMMUNITY" }, cap: 0.4 })
    await expect(fits.wake("runpod-prj_a-3")).rejects.toThrow(/gone|terminated/)
    expect(fits.created).toHaveLength(1)
  })

  it("say when no GPU type is offered on the cloud within the cap", async () => {
    const p = provider({ machine: { gpuTypes: [RTX3070] } })
    await expect(p.wake("runpod-prj_a")).rejects.toThrow(/None of the project's GPU types \(RTX 3070\) is offered on Secure Cloud within the \$1\/hr cap/)
  })
})
