import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { RunPodApi, RunPodError, rankDataCenters, type RunPodPod } from "../server/runpod/api.js"
import { RunPodSettingsStore } from "../server/runpod/settings.js"
import { IMAGE_FILES, anonymousPullable, imageTag, parseRepo, runpodDir, scanForKeys } from "../server/runpod/image.js"
import { POD_HTTP_PORTS, RunPodProvider, shortGpu } from "../server/providers/runpod.js"
import { SshPool } from "../server/runpod/ssh.js"
import { DEFAULT_RUNPOD_SETTINGS, gpuBoxId, gpuBoxIndex, gpuBoxProject, gpuPodLabel, isGpuBox, type RunPodSettings } from "../shared/runpod.js"
import { RUNNERS, SETUP_RUNNERS, normalizeRunner, parseRunsOn } from "../shared/runner.js"
import { tmpDir } from "./helpers.js"

// The RunPod GPU runner (docs/runpod.md): the runner value, the API client, settings, the image helpers and the
// provider's naming. Nothing here talks to RunPod: every call goes to a fake fetch.

function store() {
  return new Store(openDb(tmpDir(), ":memory:"))
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; auth: string | null }[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null })
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k))
    const r = key ? routes[key]!(init) : { status: 404, body: { detail: "not found" } }
    const text = r.body === undefined ? "" : JSON.stringify(r.body)
    return new Response(method === "HEAD" || !text ? null : text, { status: r.status ?? 200, headers: r.headers })
  }) as typeof fetch
  return { impl, calls }
}

describe("the gpu runner value", () => {
  it("is a runner a project can pick, but not one first-run setup offers", () => {
    expect(RUNNERS).toContain("gpu")
    expect(normalizeRunner("gpu")).toBe("gpu")
    expect(normalizeRunner("nonsense")).toBe("box")
    expect(parseRunsOn("gpu")).toBe("gpu")
    expect(parseRunsOn("GPU")).toBeNull()
    expect(SETUP_RUNNERS).not.toContain("gpu")
  })

  it("names one virtual box per project", () => {
    expect(gpuBoxId("proj_1")).toBe("runpod-proj_1")
    expect(isGpuBox("runpod-proj_1")).toBe(true)
    expect(isGpuBox("this-computer")).toBe(false)
    expect(isGpuBox(null)).toBe(false)
    expect(gpuBoxProject("runpod-proj_1")).toBe("proj_1")
  })

  it("numbers a project's pods: its first keeps the box id a project's one pod always had", () => {
    expect(gpuBoxId("prj_c8ae398599c6", 1)).toBe("runpod-prj_c8ae398599c6")
    expect(gpuBoxId("prj_c8ae398599c6", 3)).toBe("runpod-prj_c8ae398599c6-3")
    expect(gpuBoxProject("runpod-prj_c8ae398599c6-3")).toBe("prj_c8ae398599c6")
    expect(gpuBoxIndex("runpod-prj_c8ae398599c6-3")).toBe(3)
    expect(gpuBoxIndex("runpod-prj_c8ae398599c6")).toBe(1)
    // Hyphens inside a project id (mock data) aren't pod numbers.
    expect(gpuBoxProject("runpod-prj_heavy-survive-2")).toBe("prj_heavy-survive")
    expect(gpuBoxIndex("runpod-prj_heavy-survive")).toBe(1)
    expect(gpuPodLabel("runpod-prj_a-2", "game")).toBe("GPU pod #2 · game")
  })
})

describe("RunPodApi", () => {
  it("sends the key as a bearer token, follows pages and never puts a body on a DELETE", async () => {
    const pod = (id: string): RunPodPod => ({ id, name: `boxyard-i-${id}`, status: "RUNNING" })
    const f = fakeFetch({
      "GET https://api.runpod.io/v2/pods?cursor=c2": () => ({ body: { pods: [pod("b")], pagination: { hasNextPage: false, nextCursor: null } } }),
      "GET https://api.runpod.io/v2/pods": () => ({ body: { pods: [pod("a")], pagination: { hasNextPage: true, nextCursor: "c2" } } }),
      "DELETE https://api.runpod.io/v2/network-volumes/v1": (init) => ({ status: init?.body === undefined ? 204 : 422 }),
    })
    const api = new RunPodApi(() => "rpa_test", f.impl)
    expect((await api.listPods()).map((p) => p.id)).toEqual(["a", "b"])
    expect(f.calls.every((c) => c.auth === "Bearer rpa_test")).toBe(true)
    await api.deleteVolume("v1")
  })

  it("says to add a key when there is none, and marks out-of-stock errors as capacity", async () => {
    await expect(new RunPodApi(() => "").listPods()).rejects.toThrow(/RUNPOD_API_KEY/)
    const f = fakeFetch({ "POST https://api.runpod.io/v2/pods": () => ({ status: 500, body: { detail: "There are no longer any instances available with the requested specifications." } }) })
    const err = (await new RunPodApi(() => "k", f.impl).createPod({ name: "x" } as never).catch((e) => e)) as RunPodError
    expect(err).toBeInstanceOf(RunPodError)
    expect(err.capacity).toBe(true)
  })

  it("ranks data centers by the stock of the GPUs in priority order, only where volumes exist", () => {
    const dc = (id: string, a5000: "NONE" | "LOW" | "MEDIUM" | "HIGH", a40: "NONE" | "LOW" | "MEDIUM" | "HIGH", volumes = ["STANDARD"]) => ({
      id,
      name: id,
      networkVolumeTypes: volumes,
      gpuAvailability: [
        { id: "NVIDIA RTX A5000", name: "A5000", availability: a5000 },
        { id: "NVIDIA A40", name: "A40", availability: a40 },
      ],
    })
    const ranked = rankDataCenters(
      [dc("LOW-A5000", "LOW", "HIGH"), dc("HIGH-A5000", "HIGH", "NONE"), dc("NOVOL", "HIGH", "HIGH", []), dc("NOTHING", "NONE", "NONE")],
      ["NVIDIA RTX A5000", "NVIDIA A40"],
    )
    expect(ranked.map((d) => d.id)).toEqual(["HIGH-A5000", "LOW-A5000"])
    expect(ranked[0]!.volumeType).toBe("STANDARD")
  })
})

describe("RunPodSettingsStore", () => {
  it("starts from the defaults and saves a validated patch", () => {
    const s = new RunPodSettingsStore(store())
    expect(s.get()).toEqual(DEFAULT_RUNPOD_SETTINGS)
    expect(s.update({ idleMinutes: 30, imageRepo: "docker.io/someone/boxyard-gpu" })).toMatchObject({ idleMinutes: 30, imageRepo: "docker.io/someone/boxyard-gpu" })
    expect(s.get().idleMinutes).toBe(30)
  })

  it("refuses bad values, unknown fields and a repository with a tag", () => {
    const s = new RunPodSettingsStore(store())
    expect(() => s.update({ idleMinutes: 0 })).toThrow(/idleMinutes/)
    expect(() => s.update({ gpuTypes: [] })).toThrow(/at least one/)
    expect(() => s.update({ surprise: 1 })).toThrow()
    expect(() => s.update({ imageRepo: "someone/boxyard-gpu:latest" })).toThrow(/no tag/)
    expect(() => s.update({ image: "x; rm -rf /" })).toThrow(/image reference/)
  })

  it("keeps the good fields of a stored value when one is bad", () => {
    const st = store()
    st.setKv("runpod", JSON.stringify({ idleMinutes: -5, agentsPerPod: 2 }))
    const s = new RunPodSettingsStore(st)
    expect(s.get().idleMinutes).toBe(DEFAULT_RUNPOD_SETTINGS.idleMinutes)
    expect(s.get().agentsPerPod).toBe(2)
  })

  it("keeps keep-warm deadlines and drops past ones", () => {
    const s = new RunPodSettingsStore(store())
    const later = Date.now() + 60_000
    s.setKeepWarm("runpod-a", later)
    s.setKeepWarm("runpod-b", Date.now() - 1)
    expect(s.keepWarm()).toEqual({ "runpod-a": later })
    s.setKeepWarm("runpod-a", null)
    expect(s.keepWarm()).toEqual({})
  })
})

describe("the pod image", () => {
  it("is Box Yard's runpod/ folder, tagged by a hash of its files", () => {
    const dir = runpodDir()
    for (const f of IMAGE_FILES) expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
    expect(imageTag(dir)).toMatch(/^bx-[0-9a-f]{12}$/)
    const copy = tmpDir()
    for (const f of IMAGE_FILES) fs.copyFileSync(path.join(dir, f), path.join(copy, f))
    expect(imageTag(copy)).toBe(imageTag(dir))
    fs.appendFileSync(path.join(copy, "start.sh"), "\n# changed\n")
    expect(imageTag(copy)).not.toBe(imageTag(dir))
  })

  it("holds no keys, and a build refuses files that look like they do", () => {
    expect(scanForKeys()).toEqual([])
    const copy = tmpDir()
    for (const f of IMAGE_FILES) fs.copyFileSync(path.join(runpodDir(), f), path.join(copy, f))
    fs.appendFileSync(path.join(copy, "init.sh"), `\nexport GITHUB_TOKEN=ghp_${"a".repeat(30)}\n`)
    expect(scanForKeys(copy)).toEqual([expect.stringMatching(/^init\.sh:\d+$/)])
    // A secret Box Yard holds counts even when it has no known shape.
    const plain = tmpDir()
    for (const f of IMAGE_FILES) fs.copyFileSync(path.join(runpodDir(), f), path.join(plain, f))
    fs.appendFileSync(path.join(plain, "start.sh"), "\necho correct-horse-battery\n")
    expect(scanForKeys(plain, ["correct-horse-battery"])).toEqual([expect.stringMatching(/^start\.sh:\d+$/)])
  })

  it("reads registries out of repository names", () => {
    expect(parseRepo("alice/boxyard-gpu")).toEqual({ registry: "registry-1.docker.io", name: "alice/boxyard-gpu" })
    expect(parseRepo("docker.io/alice/boxyard-gpu")).toEqual({ registry: "registry-1.docker.io", name: "alice/boxyard-gpu" })
    expect(parseRepo("ghcr.io/alice/boxyard-gpu")).toEqual({ registry: "ghcr.io", name: "alice/boxyard-gpu" })
    expect(parseRepo("localhost:5000/x")).toEqual({ registry: "localhost:5000", name: "x" })
  })

  it("checks RunPod could pull a pushed image without a login", async () => {
    const challenge = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:alice/boxyard-gpu:pull"'
    const pub = fakeFetch({
      "GET https://auth.docker.io/token": () => ({ body: { token: "anon" } }),
      "HEAD https://registry-1.docker.io/v2/alice/boxyard-gpu/manifests/bx-1": () => ({ status: 200 }),
    })
    // The first HEAD has no token: answer it with the challenge.
    let first = true
    const withChallenge = (async (input: string | URL, init?: RequestInit) => {
      if (first && init?.method === "HEAD") {
        first = false
        return new Response(null, { status: 401, headers: { "www-authenticate": challenge } })
      }
      return pub.impl(input, init)
    }) as typeof fetch
    expect(await anonymousPullable("alice/boxyard-gpu", "bx-1", withChallenge)).toEqual({ ok: true, detail: "anyone can pull it" })
    expect(pub.calls.find((c) => c.method === "HEAD")?.auth).toBe("Bearer anon")

    const priv = (async () => new Response(null, { status: 401, headers: { "www-authenticate": challenge } })) as unknown as typeof fetch
    expect((await anonymousPullable("alice/boxyard-gpu", "bx-1", priv)).ok).toBe(false)
  })
})

describe("RunPodProvider", () => {
  const gpu = (id: string, price: number) => ({ id, name: id, memory: 24, secure: true, price: { secure: price, community: price }, availability: "HIGH" })
  function provider(
    pods: RunPodPod[],
    o: { settings?: Partial<RunPodSettings>; projectCap?: (id: string) => number | null; volumes?: unknown[]; routes?: Parameters<typeof fakeFetch>[0] } = {},
  ) {
    const f = fakeFetch({
      ...o.routes,
      "GET https://api.runpod.io/v2/pods": () => ({ body: { pods } }),
      "GET https://api.runpod.io/v2/catalog/gpus": () => ({ body: { gpus: [gpu("NVIDIA RTX A5000", 0.27), gpu("NVIDIA A40", 0.4)] } }),
      "GET https://api.runpod.io/v2/catalog/datacenters": () => ({
        body: { dataCenters: [{ id: "CA-MTL-1", name: "CA-MTL-1", networkVolumeTypes: ["STANDARD"], gpuAvailability: [{ id: "NVIDIA RTX A5000", name: "A5000", availability: "HIGH" }] }] },
      }),
      "GET https://api.runpod.io/v2/network-volumes": () => ({ body: { networkVolumes: o.volumes ?? [] } }),
      "POST https://api.runpod.io/v2/pods": () => ({ status: 500, body: { detail: "no pod in this test" } }),
    })
    const p = new RunPodProvider({
      api: new RunPodApi(() => "k", f.impl),
      ssh: new SshPool(tmpDir()),
      settings: () => ({ ...DEFAULT_RUNPOD_SETTINGS, ...o.settings }),
      install: () => "inst1",
      scriptsDir: runpodDir(),
      git: { name: "Box Yard", email: "boxyard@example.com" },
      projectCap: o.projectCap,
    })
    return Object.assign(p, { calls: f.calls })
  }

  it("names pod #n after its box and keeps one volume per project, which only pod #1 mounts", async () => {
    const p = provider([
      { id: "p1", name: "boxyard-inst1-prj_a", status: "RUNNING" },
      { id: "p2", name: "boxyard-inst1-prj_a-2", status: "RUNNING" },
    ])
    expect((await p.listPods(true)).map((x) => x.boxId)).toEqual(["runpod-prj_a", "runpod-prj_a-2"])
    expect(p.resourceName("runpod-prj_a")).toBe("boxyard-inst1-prj_a")
    expect(p.resourceName("runpod-prj_a-2")).toBe("boxyard-inst1-prj_a-2")
    expect(p.volumeName("runpod-prj_a-2")).toBe("boxyard-inst1-prj_a")
    expect(await p.ensureVolume("runpod-prj_a-2")).toBeNull()
    expect(p.calls.some((c) => c.url.includes("network-volumes"))).toBe(false)
  })

  it("prices the next pod at the first GPU type under the project's cap, its own or the global one", async () => {
    const p = provider([], { projectCap: (id) => (id === "prj_cheap" ? 0.3 : id === "prj_tiny" ? 0.1 : null) })
    expect(await p.nextPodPrice("prj_a")).toEqual({ gpu: "RTX A5000", usd: 0.27 })
    expect(p.capOf("prj_a")).toBe(1)
    expect(p.capOf("prj_cheap")).toBe(0.3)
    expect(await p.nextPodPrice("prj_tiny")).toBeNull()
    const a40 = provider([], { settings: { gpuTypes: ["NVIDIA A40", "NVIDIA RTX A5000"] }, projectCap: () => 0.3 })
    expect(await a40.nextPodPrice("prj_a")).toEqual({ gpu: "RTX A5000", usd: 0.27 })
  })

  it("won't start a pod that takes the project's pods over its cap", async () => {
    const pods: RunPodPod[] = [
      { id: "p1", name: "boxyard-inst1-prj_a", status: "RUNNING", cost: 0.4 },
      { id: "p2", name: "boxyard-inst1-prj_a-2", status: "RUNNING", cost: 0.4 },
    ]
    const p = provider(pods)
    await expect(p.wake("runpod-prj_a-3")).rejects.toThrow(/RTX A5000 would take the project's pods to \$1\.07\/hr, over its \$1\/hr cap/)
    expect(p.calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("sees only this install's live pods, by box id", async () => {
    const p = provider([
      { id: "p1", name: "boxyard-inst1-proj_a", status: "RUNNING", ssh: { direct: { host: "1.2.3.4", port: 22001 } } },
      { id: "p2", name: "boxyard-inst2-proj_b", status: "RUNNING" },
      { id: "p3", name: "boxyard-inst1-proj_c", status: "TERMINATED" },
      { id: "p4", name: "someone-elses-pod", status: "RUNNING" },
    ])
    const pods = await p.listPods(true)
    expect(pods.map((x) => [x.boxId, x.pod.id])).toEqual([["runpod-proj_a", "p1"]])
    expect(p.resourceName("runpod-proj_a")).toBe("boxyard-inst1-proj_a")
  })

  it("gives a proxy URL for a task's first port only", async () => {
    const p = provider([{ id: "p1", name: "boxyard-inst1-proj_a", status: "RUNNING" }])
    expect(await p.publicUrl("runpod-proj_a", POD_HTTP_PORTS[1]!)).toBe(`https://p1-${POD_HTTP_PORTS[1]}.proxy.runpod.net`)
    await expect(p.publicUrl("runpod-proj_a", POD_HTTP_PORTS[1]! + 1)).rejects.toThrow(/first port/)
    await expect(p.publicUrl("runpod-proj_x", 4000)).rejects.toThrow(/isn't running/)
  })

  it("terminates a pod (never just stops it) and leaves its network volume alone", async () => {
    const actions: unknown[] = []
    const p = provider([{ id: "p1", name: "boxyard-inst1-prj_a", status: "RUNNING" }], {
      volumes: [{ id: "v1", name: "boxyard-inst1-prj_a", size: 20, dataCenterId: "CA-MTL-1" }],
      routes: { "POST https://api.runpod.io/v2/pods/p1/action": (init) => (actions.push(JSON.parse(String(init?.body))), { body: {} }) },
    })
    await p.destroy("runpod-prj_a")
    expect(actions).toEqual([{ action: "terminate" }])
    expect(p.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.runpod.io/v2/pods/p1/action"])
    expect(p.calls.some((c) => c.url.includes("network-volumes") && c.method !== "GET")).toBe(false)
  })

  it("can't make boxes through the pool", async () => {
    await expect(provider([]).create({ labels: [] })).rejects.toThrow(/runpod-<projectId>\[-<n>\]/)
  })

  it("shortens GPU names for labels", () => {
    expect(shortGpu("NVIDIA RTX A5000")).toBe("RTX A5000")
    expect(shortGpu("NVIDIA GeForce RTX 4090")).toBe("RTX 4090")
  })
})
