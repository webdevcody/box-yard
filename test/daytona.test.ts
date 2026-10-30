import { describe, expect, it } from "vitest"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { DAYTONA_API, DaytonaApi, DaytonaError, createBody, sandboxGpu, sandboxStatus, type CreateSandboxInput, type DaytonaSandbox } from "../server/daytona/api.js"
import { DaytonaSettingsStore } from "../server/daytona/settings.js"
import { daytonaDir } from "../server/daytona/service.js"
import { DaytonaProvider, STDERR_MARK, daytonaGpuType, sandboxCost, splitResult, type DaytonaProjectMachine } from "../server/providers/daytona.js"
import { runpodDir } from "../server/runpod/image.js"
import { workerSystemPrompt } from "../server/prompts.js"
import { DAYTONA_CPU, DEFAULT_DAYTONA_SETTINGS, daytonaHourlyUsd, daytonaMachine, type DaytonaSettings } from "../shared/daytona.js"
import { effectiveGpuProvider, globalGpuProvider, gpuBoxIdOn, gpuBoxProvider } from "../shared/gpu.js"
import type { Project } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// Daytona sandboxes, the third GPU cloud (docs/daytona.md). Nothing here talks to Daytona: every call goes to a fake
// fetch that keeps sandboxes in memory and answers the toolbox. Never point these at the real API: a GPU sandbox
// spends money from the moment it's made.

const KEY = "dtn_secret_test_key_0123456789"
const TOOLBOX = "https://proxy.test/toolbox"

interface Call {
  method: string
  url: string
  auth: string | null
  source: string | null
}

interface FakeDaytona {
  impl: typeof fetch
  calls: Call[]
  sandboxes: Map<string, DaytonaSandbox & { polls: number }>
  /** POST /sandbox bodies, in order. */
  created: Record<string, unknown>[]
  /** Commands run through the toolbox, as sent (sh -c '…'). */
  execs: string[]
  /** Files in sandboxes, by `<id>:<path>`. */
  files: Map<string, Buffer>
  autostop: { id: string; minutes: number }[]
  signed: { id: string; port: number; seconds: number }[]
  /** Reads of GET /sandbox/{id} before a new sandbox is started. */
  startAfter: number
  /** A sandbox whose Dockerfile runs bootstrap.sh fails to build. */
  bakeFails: boolean
  /** New sandboxes never start. */
  neverStart: boolean
  /** Whether /opt/boxyard/ready is there (the tools are in the image). */
  ready: boolean
  /** What `id -u` says. */
  uid: string
  /** A command's answer, when the test wants a particular one. */
  answer: (command: string) => { exitCode: number; stdout: string; stderr: string } | null
  /** Answer the next calls with these errors. */
  failNext: { status: number; body: unknown }[]
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

/** Daytona as fetch sees it: its REST API (sandboxes by id, labels) and each sandbox's toolbox. */
function fakeDaytona(o: { sandboxes?: DaytonaSandbox[]; paged?: boolean } = {}): FakeDaytona {
  const f: FakeDaytona = {
    impl: null as never,
    calls: [],
    sandboxes: new Map((o.sandboxes ?? []).map((s) => [s.id, { ...s, polls: 0 }])),
    created: [],
    execs: [],
    files: new Map(),
    autostop: [],
    signed: [],
    startAfter: 1,
    bakeFails: false,
    neverStart: false,
    ready: true,
    uid: "0",
    answer: () => null,
    failNext: [],
  }
  let next = 0
  f.impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const h = new Headers(init?.headers)
    f.calls.push({ method, url, auth: h.get("authorization"), source: h.get("x-daytona-source") })
    const failure = f.failNext.shift()
    if (failure) return json(failure.body, failure.status)
    const u = new URL(url)
    if (url.startsWith(TOOLBOX)) {
      const [id, ...rest] = u.pathname.slice(new URL(TOOLBOX).pathname.length + 1).split("/")
      if (!f.sandboxes.has(id!)) return json({ message: "sandbox not found" }, 404)
      const route = rest.join("/")
      if (method === "POST" && route === "process/execute") {
        const { command, timeout } = JSON.parse(String(init!.body)) as { command: string; timeout: number }
        expect(timeout).toBeGreaterThan(0)
        f.execs.push(command)
        const stream = /\/tmp\/\.boxyard-stream-[0-9a-f-]+/.exec(command)?.[0]
        // The command that writes the stream ({ …\n} > file), not the one that removes it after.
        if (stream && command.includes("{ ")) f.files.set(`${id}:${stream}`, Buffer.from("archive bytes\n"))
        const a =
          f.answer(command) ??
          (/id -u/.test(command)
            ? { exitCode: 0, stdout: f.uid, stderr: "" }
            : /test -f \/opt\/boxyard\/ready/.test(command)
              ? { exitCode: f.ready ? 0 : 1, stdout: "", stderr: "" }
              : /init\.sh/.test(command)
                ? { exitCode: 0, stdout: "boxyard-init ok\nv22.0.0\n2.0.0 (Claude Code)", stderr: "" }
                : { exitCode: 0, stdout: "", stderr: "" })
        return json({ exitCode: a.exitCode, result: `${a.stdout}\n${STDERR_MARK}\n${a.stderr}` })
      }
      if (method === "POST" && route === "files/upload-v2") {
        const file = (init!.body as FormData).get("file") as Blob
        f.files.set(`${id}:${u.searchParams.get("path")}`, Buffer.from(await file.arrayBuffer()))
        return new Response(null, { status: 200 })
      }
      if (method === "GET" && route === "files/download") {
        const data = f.files.get(`${id}:${u.searchParams.get("path")}`)
        return data ? new Response(new Uint8Array(data)) : json({ message: "file not found" }, 404)
      }
      throw new Error(`The fake toolbox has no ${method} ${route}`)
    }
    expect(url.startsWith(`${DAYTONA_API}/sandbox`)).toBe(true)
    const p = u.pathname.slice(new URL(DAYTONA_API).pathname.length)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (method === "POST" && p === "/sandbox") {
      f.created.push(body)
      const id = `sb-${++next}`
      const sb = {
        id,
        state: "pending_build",
        labels: body.labels,
        cpu: body.cpu,
        memory: body.memory,
        disk: body.disk,
        gpu: body.gpu ?? 0,
        gpuType: body.gpuType ?? null,
        spot: body.spot ?? false,
        autoStopInterval: body.autoStopInterval,
        createdAt: new Date().toISOString(),
        toolboxProxyUrl: TOOLBOX,
        dockerfile: body.buildInfo.dockerfileContent as string,
        polls: 0,
      }
      f.sandboxes.set(id, sb)
      return json(sb)
    }
    if (method === "GET" && p === "/sandbox") {
      const want = JSON.parse(u.searchParams.get("labels") ?? "{}") as Record<string, string>
      const items = [...f.sandboxes.values()].filter((s) => Object.entries(want).every(([k, v]) => s.labels?.[k] === v))
      return json(o.paged ? { items, total: items.length, nextCursor: null } : items)
    }
    const one = /^\/sandbox\/([^/]+)(\/.*)?$/.exec(p)
    if (!one) throw new Error(`The fake Daytona has no ${method} ${p}`)
    const sb = f.sandboxes.get(decodeURIComponent(one[1]!))
    if (!sb) return json({ statusCode: 404, message: "Sandbox not found" }, 404)
    const sub = one[2] ?? ""
    if (method === "GET" && !sub) {
      if (sb.state === "pending_build" && !f.neverStart && ++sb.polls >= f.startAfter) {
        const baked = /bootstrap\.sh/.test((sb as unknown as { dockerfile: string }).dockerfile)
        sb.state = baked && f.bakeFails ? "build_failed" : "started"
        if (sb.state === "build_failed") sb.errorReason = "RUN bash /opt/boxyard/bootstrap.sh: exit 1"
      }
      return json(sb)
    }
    if (method === "DELETE" && !sub) {
      f.sandboxes.delete(sb.id)
      return json({})
    }
    const stop = /^\/autostop\/(\d+)$/.exec(sub)
    if (method === "POST" && stop) {
      f.autostop.push({ id: sb.id, minutes: Number(stop[1]) })
      return new Response(null, { status: 200 })
    }
    const port = /^\/ports\/(\d+)\/signed-preview-url$/.exec(sub)
    if (method === "GET" && port) {
      const seconds = Number(u.searchParams.get("expiresInSeconds"))
      f.signed.push({ id: sb.id, port: Number(port[1]), seconds })
      return json({ port: Number(port[1]), url: `https://${port[1]}-signed${f.signed.length}.proxy.test`, token: "t" })
    }
    throw new Error(`The fake Daytona has no ${method} ${p}`)
  }) as typeof fetch
  return f
}

const api = (f: FakeDaytona, key = KEY) => new DaytonaApi(() => key, f.impl, DAYTONA_API, [0, 0])

const sandbox = (id: string, more: Partial<DaytonaSandbox> = {}): DaytonaSandbox => ({
  id,
  state: "started",
  labels: { "boxyard-install": "inst-1", "boxyard-box": "prj_a" },
  cpu: 8,
  memory: 32,
  disk: 60,
  gpu: 1,
  gpuType: ["RTX-4090"],
  createdAt: new Date().toISOString(),
  toolboxProxyUrl: TOOLBOX,
  ...more,
})

const GPU_INPUT: CreateSandboxInput = {
  labels: { "boxyard-install": "inst-1", "boxyard-box": "prj_a" },
  dockerfile: "FROM img\n",
  gpuTypes: ["RTX-4090", "RTX-5090"],
  gpus: 1,
  vcpus: 8,
  memoryGb: 32,
  diskGb: 60,
  spot: false,
  autoStopMinutes: 30,
}

describe("Daytona API client", () => {
  it("makes private, ephemeral sandboxes from a Dockerfile, with a GPU only when one is asked for", () => {
    expect(createBody(GPU_INPUT)).toEqual({
      user: "root",
      labels: GPU_INPUT.labels,
      public: false,
      buildInfo: { dockerfileContent: "FROM img\n" },
      cpu: 8,
      memory: 32,
      disk: 60,
      gpu: 1,
      gpuType: ["RTX-4090", "RTX-5090"],
      autoStopInterval: 30,
      autoDeleteInterval: 0,
    })
    expect(createBody({ ...GPU_INPUT, spot: true })).toMatchObject({ spot: true })
    const cpu = createBody({ ...GPU_INPUT, gpus: 0, gpuTypes: [], spot: true })
    expect(cpu).not.toHaveProperty("gpu")
    expect(cpu).not.toHaveProperty("gpuType")
    expect(cpu).not.toHaveProperty("spot")
    expect(cpu).toMatchObject({ autoDeleteInterval: 0, public: false })
  })

  it("calls only sandbox endpoints, with the key as a bearer token and Box Yard as the source", async () => {
    const f = fakeDaytona({ sandboxes: [sandbox("sb-x")] })
    const a = api(f)
    const sb = await a.createSandbox(GPU_INPUT)
    await a.listSandboxes({ "boxyard-install": "inst-1" })
    await a.getSandbox(sb.id)
    await a.setAutoStop(sb.id, 45.4)
    await a.signedPreviewUrl(sb.id, 4000, 86_400)
    await a.execute(sb, "true", 30)
    await a.deleteSandbox(sb.id)
    for (const c of f.calls) {
      expect(c.url).toMatch(/^https:\/\/(app\.daytona\.io\/api\/sandbox|proxy\.test\/toolbox\/)/)
      expect(c.auth).toBe(`Bearer ${KEY}`)
      expect(c.source).toBe("box-yard")
    }
    expect(f.autostop).toEqual([{ id: sb.id, minutes: 45 }])
    expect(f.signed).toEqual([{ id: sb.id, port: 4000, seconds: 86_400 }])
  })

  it("asks for nothing without a key", async () => {
    const f = fakeDaytona()
    await expect(api(f, "").listSandboxes({})).rejects.toThrow(/No Daytona API key/)
    expect(f.calls).toEqual([])
  })

  it("names the path in errors, never the key, host or query", async () => {
    const f = fakeDaytona()
    f.failNext.push({ status: 500, body: { message: "internal error" } })
    const err = (await api(f)
      .listSandboxes({ "boxyard-install": "inst-1" })
      .catch((e) => e)) as DaytonaError
    expect(err).toBeInstanceOf(DaytonaError)
    expect(err.status).toBe(500)
    expect(err.message).toBe("Daytona GET /sandbox: 500 internal error")
    expect(err.message).not.toContain(KEY)
  })

  it("retries a 429, then gives up with its status", async () => {
    const f = fakeDaytona()
    f.failNext.push({ status: 429, body: { message: "slow down" } })
    expect(await api(f).listSandboxes({})).toEqual([])
    f.failNext.push(...[1, 2, 3].map(() => ({ status: 429, body: { message: "slow down" } })))
    await expect(api(f).listSandboxes({})).rejects.toMatchObject({ status: 429 })
  })

  it("lists by label in either shape, leaving deleted sandboxes out", async () => {
    const mine = sandbox("a")
    const other = sandbox("b", { labels: { "boxyard-install": "inst-2", "boxyard-box": "prj_a" } })
    const gone = sandbox("c", { state: "destroyed" })
    for (const paged of [false, true]) {
      const f = fakeDaytona({ sandboxes: [mine, other, gone], paged })
      expect((await api(f).listSandboxes({ "boxyard-install": "inst-1" })).map((s) => s.id)).toEqual(["a"])
      expect(new URL(f.calls[0]!.url).searchParams.get("labels")).toBe('{"boxyard-install":"inst-1"}')
    }
  })

  it("reads a missing sandbox as gone, and deleting one that's gone as done", async () => {
    const f = fakeDaytona()
    expect(await api(f).getSandbox("nope")).toBeNull()
    await expect(api(f).deleteSandbox("nope")).resolves.toBeUndefined()
  })

  it("only sends the key to a sandbox's own toolbox over HTTPS", () => {
    const a = api(fakeDaytona())
    expect(a.toolbox({ id: "x", toolboxProxyUrl: "https://eu.proxy.daytona.works/toolbox/" })).toBe("https://eu.proxy.daytona.works/toolbox/x")
    expect(a.toolbox({ id: "x", toolboxProxyUrl: "http://evil.test/toolbox" })).toBe("https://proxy.app.daytona.io/toolbox/x")
    expect(a.toolbox({ id: "x", toolboxProxyUrl: null })).toBe("https://proxy.app.daytona.io/toolbox/x")
  })

  it("reads Daytona's states as the pod words every GPU cloud uses", () => {
    expect(sandboxStatus({ state: "started" })).toBe("RUNNING")
    for (const s of ["creating", "pending_build", "building_snapshot", "starting", "restoring", undefined]) expect(sandboxStatus({ state: s })).toBe("STARTING")
    for (const s of ["stopped", "stopping", "archived", "destroyed"]) expect(sandboxStatus({ state: s })).toBe("EXITED")
    for (const s of ["error", "build_failed"]) expect(sandboxStatus({ state: s })).toBe("ERROR")
    expect(sandboxGpu({ gpu: 0 })).toBe("CPU only")
    expect(sandboxGpu({ gpu: 1, gpuType: "RTX-4090" })).toBe("RTX 4090")
    expect(sandboxGpu({ gpu: 2, gpuType: ["H100"] })).toBe("2× H100")
    expect(sandboxGpu({ gpu: 1, gpuType: ["RTX-4090", "RTX-5090"] })).toBe("RTX 4090 or RTX 5090")
  })
})

describe("Daytona prices and names", () => {
  it("prices a sandbox at its dearest GPU type plus its CPU, memory and disk", () => {
    // $0.99 + 8 × $0.0504 + 32 × $0.0162 + (60 − 5) × $0.000108
    expect(daytonaHourlyUsd({ gpuTypes: ["RTX-4090"], gpus: 1, vcpus: 8, memoryGb: 32, diskGb: 60, spot: false })).toBe(1.9175)
    expect(daytonaHourlyUsd({ gpuTypes: ["RTX-4090", "H100"], gpus: 2, vcpus: 0, memoryGb: 0, diskGb: 0, spot: false })).toBe(7.9)
    expect(daytonaHourlyUsd({ gpuTypes: ["RTX-4090"], gpus: 1, vcpus: 0, memoryGb: 0, diskGb: 0, spot: true })).toBe(0.57)
    // A type the guide doesn't know counts at the dearest one it does.
    expect(daytonaHourlyUsd({ gpuTypes: ["X-9000"], gpus: 1, vcpus: 0, memoryGb: 0, diskGb: 0, spot: false })).toBe(6.25)
    // CPU only: 4 vCPUs, 8 GiB, 10 GiB disk.
    expect(daytonaHourlyUsd({ gpuTypes: [], gpus: 0, vcpus: 4, memoryGb: 8, diskGb: 10, spot: false })).toBe(0.3317)
    expect(sandboxCost(sandbox("a"))).toBe(1.9175)
  })

  it("reads RunPod's and Vast.ai's GPU names as Daytona's", () => {
    expect(daytonaGpuType("NVIDIA GeForce RTX 4090")).toBe("RTX-4090")
    expect(daytonaGpuType("RTX 5090")).toBe("RTX-5090")
    expect(daytonaGpuType("NVIDIA H100 80GB HBM3")).toBe("H100")
    expect(daytonaGpuType("H200 NVL")).toBe("H200")
    expect(daytonaGpuType("NVIDIA RTX PRO 6000 Blackwell")).toBe("RTX-PRO-6000")
    expect(daytonaGpuType("AMD MI355X")).toBe("MI355X")
    expect(daytonaGpuType(DAYTONA_CPU)).toBe(DAYTONA_CPU)
    expect(daytonaGpuType("NVIDIA GeForce RTX 3070")).toBeNull()
  })

  it("splits the toolbox's one result into stdout and stderr", () => {
    expect(splitResult(3, `hi\nthere\n\n${STDERR_MARK}\noops\n`)).toEqual({ exitCode: 3, stdout: "hi\nthere\n", stderr: "oops\n" })
    expect(splitResult(0, "no marker")).toEqual({ exitCode: 0, stdout: "no marker", stderr: "" })
  })

  it("lets Daytona win over Vast.ai as the global cloud", () => {
    expect(globalGpuProvider(false, false)).toBe("runpod")
    expect(globalGpuProvider(true, false)).toBe("vast")
    expect(globalGpuProvider(true, true)).toBe("daytona")
    expect(effectiveGpuProvider("runpod", true, true)).toBe("runpod")
    expect(gpuBoxProvider(gpuBoxIdOn("daytona", "prj_a", 2))).toBe("daytona")
    expect(gpuBoxIdOn("daytona", "prj_a", 2)).toBe("daytona-prj_a-2")
  })

  it("reads a sandbox's size as the Min RAM and vCPUs a project's own replace", () => {
    expect(daytonaMachine(DEFAULT_DAYTONA_SETTINGS)).toEqual({ minRamGb: 32, minVcpus: 8 })
    expect(daytonaMachine({ ...DEFAULT_DAYTONA_SETTINGS, gpuTypes: [DAYTONA_CPU] })).toEqual({ minRamGb: 8, minVcpus: 4 })
  })
})

interface Harness {
  p: DaytonaProvider
  f: FakeDaytona
  settings: DaytonaSettings
  events: { boxId: string; kind: string; detail: string }[]
  progress: string[]
  set: (o: { cap?: number | null; machine?: Partial<DaytonaProjectMachine>; warm?: number | null; blocked?: string | null }) => void
}

function provider(o: { settings?: Partial<DaytonaSettings>; sandboxes?: DaytonaSandbox[] } = {}): Harness {
  const f = fakeDaytona({ sandboxes: o.sandboxes })
  const settings: DaytonaSettings = { ...DEFAULT_DAYTONA_SETTINGS, ...o.settings }
  const events: Harness["events"] = []
  const progress: string[] = []
  let cap: number | null = null
  let machine: DaytonaProjectMachine = { gpuTypes: null, minRamGb: null, minVcpus: null }
  let warm: number | null = null
  let blocked: string | null = null
  const p = new DaytonaProvider({
    api: api(f),
    settings: () => settings,
    image: () => "docker.io/box/boxyard-gpu:bx-1",
    install: () => "inst-1",
    bootstrapDir: runpodDir(),
    scriptsDir: daytonaDir(),
    onEvent: (e) => events.push(e),
    onProgress: (_boxId, message) => progress.push(message),
    projectCap: () => cap,
    projectMachine: () => machine,
    keepWarmUntil: () => warm,
    spendBlock: () => blocked,
    pollMs: 1,
  })
  return {
    p,
    f,
    settings,
    events,
    progress,
    set: (x) => {
      if (x.cap !== undefined) cap = x.cap
      if (x.machine) machine = { ...machine, ...x.machine }
      if (x.warm !== undefined) warm = x.warm
      if (x.blocked !== undefined) blocked = x.blocked
    },
  }
}

const BOX = gpuBoxIdOn("daytona", "prj_a")
const dockerfileOf = (body: Record<string, unknown>) => (body.buildInfo as { dockerfileContent: string }).dockerfileContent

describe("DaytonaProvider", () => {
  it("makes a labelled sandbox with the tools built into its image, then runs commands and moves files through the toolbox", async () => {
    const h = provider()
    await h.p.wake(BOX)
    expect(h.f.created).toHaveLength(1)
    const body = h.f.created[0]!
    expect(body).toMatchObject({
      user: "root",
      public: false,
      labels: { "boxyard-install": "inst-1", "boxyard-box": "prj_a" },
      gpu: 1,
      gpuType: ["RTX-4090", "RTX-5090"],
      cpu: 8,
      memory: 32,
      disk: 60,
      autoStopInterval: 30,
      autoDeleteInterval: 0,
    })
    const dockerfile = dockerfileOf(body)
    expect(dockerfile).toMatch(/^FROM docker\.io\/box\/boxyard-gpu:bx-1\nUSER root\nRUN mkdir -p \/opt\/boxyard && echo [A-Za-z0-9+/=]+ \| base64 -d > \/opt\/boxyard\/bootstrap\.sh && bash \/opt\/boxyard\/bootstrap\.sh\n$/)
    const b64 = /echo (\S+) \|/.exec(dockerfile)![1]!
    expect(Buffer.from(b64, "base64").toString()).toBe(fs.readFileSync(path.join(runpodDir(), "bootstrap.sh"), "utf8"))
    // Priced at the dearest type it may get (an RTX 5090).
    expect(h.events).toEqual([{ boxId: BOX, kind: "started", detail: "RTX 4090 or RTX 5090, 8 vCPUs, 32 GiB at about $2.22/hr, sandbox sb-1" }])
    // Prepared: bootstrap.sh and init.sh copied in, init run as root (no sudo), the image's tools found ready.
    expect([...h.f.files.keys()].sort()).toEqual(["sb-1:/tmp/boxyard-bootstrap.sh", "sb-1:/tmp/boxyard-init.sh"])
    expect(h.f.files.get("sb-1:/tmp/boxyard-init.sh")!.toString()).toBe(fs.readFileSync(path.join(daytonaDir(), "init.sh"), "utf8"))
    expect(h.f.execs.some((c) => c.includes("init.sh") && !c.includes("sudo"))).toBe(true)
    expect(h.f.execs.some((c) => /bootstrap\.sh > \/tmp\/boxyard-bootstrap\.log/.test(c))).toBe(false)
    for (const c of h.f.execs) expect(c).toMatch(/^sh -c '.*bash -lc /s)

    // Commands: stdout and stderr apart, exit code kept.
    h.f.answer = (c) => (c.includes("make test") ? { exitCode: 2, stdout: "ran 3", stderr: "1 failed" } : null)
    expect(await h.p.exec(BOX, "make test")).toEqual({ exitCode: 2, stdout: "ran 3", stderr: "1 failed" })
    expect(await h.p.health(BOX)).toBe("running")

    // Files: uploaded beside the target, then moved into place.
    await h.p.writeFile(BOX, "/box/tasks/t1/prompt.txt", "hello")
    expect(h.f.files.get("sb-1:/box/tasks/t1/prompt.txt.by-tmp")!.toString()).toBe("hello")
    expect(h.f.execs.at(-1)).toMatch(/mv -f .*\/box\/tasks\/t1\/prompt\.txt\.by-tmp.* .*\/box\/tasks\/t1\/prompt\.txt/)
    const local = path.join(tmpDir(), "big.tar")
    fs.writeFileSync(local, "tarball")
    await h.p.uploadFile(BOX, local, "/box/tasks/t1.tar")
    expect(h.f.files.get("sb-1:/box/tasks/t1.tar.by-tmp")!.toString()).toBe("tarball")
    h.f.files.set("sb-1:/box/tasks/t1/events.jsonl", Buffer.from('{"type":"x"}\n'))
    expect((await h.p.readFile(BOX, "/box/tasks/t1/events.jsonl")).toString()).toBe('{"type":"x"}\n')
    await expect(h.p.readFile(BOX, "/box/nope")).rejects.toMatchObject({ code: "ENOENT" })

    // An archive streams down from a file in /tmp, which is removed after.
    let out = ""
    expect(await h.p.execStream(BOX, "tar -cz -C /box/tasks t1", (c) => (out += c))).toEqual({ exitCode: 0 })
    expect(out).toBe("archive bytes\n")
    expect(h.f.execs.at(-1)).toMatch(/rm -f .*\/tmp\/\.boxyard-stream-/)
  })

  it("wraps a command so a real shell runs it as given, with its stderr after the marker", async () => {
    const h = provider()
    await h.p.wake(BOX)
    const inner = `printf '%s\\n' "it's \\$HOME"; echo "err  2" >&2; exit 3`
    await h.p.exec(BOX, inner)
    const sent = h.f.execs.at(-1)!
    // What the toolbox would do: run it in a shell, stdout and stderr together.
    const r = spawnSync("sh", ["-c", `${sent} 2>&1`], { encoding: "utf8" })
    expect(splitResult(r.status ?? -1, r.stdout)).toEqual({ exitCode: 3, stdout: "it's $HOME\n", stderr: "err  2\n" })
  })

  it("signs one URL per preview port, for a day, and keeps it until it nearly lapses", async () => {
    const h = provider()
    await h.p.wake(BOX)
    const a = await h.p.publicUrl(BOX, 4000)
    expect(await h.p.publicUrl(BOX, 4000)).toBe(a)
    const b = await h.p.publicUrl(BOX, 4003)
    expect(b).not.toBe(a)
    expect(h.f.signed).toEqual([
      { id: "sb-1", port: 4000, seconds: 86_400 },
      { id: "sb-1", port: 4003, seconds: 86_400 },
    ])
  })

  it("deletes the sandbox on destroy, and says so", async () => {
    const h = provider()
    await h.p.wake(BOX)
    await h.p.destroy(BOX)
    expect(h.f.sandboxes.size).toBe(0)
    expect(h.events.at(-1)).toEqual({ boxId: BOX, kind: "terminated", detail: "RTX 4090 or RTX 5090 sandbox sb-1 deleted" })
    expect(await h.p.health(BOX)).toBe("paused")
    await h.p.destroy(BOX)
    expect(h.events.filter((e) => e.kind === "terminated")).toHaveLength(1)
  })

  it("asks only for GPU types the project's cap leaves room for, and makes none when none fits", async () => {
    const h = provider()
    // $2/hr: an RTX 4090 sandbox ($1.92) fits, an RTX 5090 one ($2.22) doesn't.
    h.set({ cap: 2 })
    expect(await h.p.nextPodPrice("prj_a")).toEqual({ gpu: "RTX 4090 sandbox (Daytona)", usd: 1.9175 })
    await h.p.wake(BOX)
    expect(h.f.created[0]).toMatchObject({ gpuType: ["RTX-4090"] })

    h.set({ cap: 1 })
    expect(await h.p.nextPodPrice("prj_a")).toBeNull()
    await expect(h.p.wake(gpuBoxIdOn("daytona", "prj_a", 2))).rejects.toThrow(/\$1\.00\/hr the caps leave|caps are reached/)
    expect(h.f.created).toHaveLength(1)
  })

  it("counts this install's sandboxes against the total cap, and no other install's", async () => {
    const other = sandbox("theirs", { labels: { "boxyard-install": "inst-2", "boxyard-box": "prj_b" }, gpu: 8, gpuType: ["B300"] })
    const h = provider({ settings: { totalMaxHourlyUsd: 3 }, sandboxes: [other] })
    await h.p.wake(gpuBoxIdOn("daytona", "prj_b"))
    expect(h.f.created).toHaveLength(1)
    // $2.22 of $3 is used: the next ($2.22 at most) doesn't fit.
    await expect(h.p.wake(BOX)).rejects.toThrow(/over the \$0\.78\/hr the caps leave/)
    expect((await h.p.listPods(true)).map((x) => x.boxId)).toEqual([gpuBoxIdOn("daytona", "prj_b")])
  })

  it("makes CPU-only sandboxes from the small image, sized by the project's own RAM and vCPUs", async () => {
    const h = provider()
    h.set({ machine: { gpuTypes: [DAYTONA_CPU], minRamGb: 16 } })
    expect(await h.p.nextPodPrice("prj_a")).toEqual({ gpu: "CPU-only sandbox (Daytona)", usd: 0.4613 })
    await h.p.wake(BOX)
    const body = h.f.created[0]!
    expect(body).toMatchObject({ cpu: 4, memory: 16, disk: 10 })
    expect(body).not.toHaveProperty("gpu")
    expect(dockerfileOf(body)).toMatch(/^FROM ubuntu:24\.04\n/)
    expect(h.events[0]!.detail).toMatch(/^CPU-only, 4 vCPUs, 16 GiB/)
  })

  it("reads a project's RunPod GPU names as Daytona's", async () => {
    const h = provider()
    h.set({ machine: { gpuTypes: ["NVIDIA H100 80GB HBM3", "NVIDIA GeForce RTX 3070"] } })
    expect(h.p.shapeOf("prj_a").gpuTypes).toEqual(["H100"])
    // None of them on Daytona: Settings › Daytona's types.
    h.set({ machine: { gpuTypes: ["NVIDIA GeForce RTX 3070"] } })
    expect(h.p.shapeOf("prj_a").gpuTypes).toEqual(["RTX-4090", "RTX-5090"])
  })

  it("starts from the plain image and installs the tools when Daytona can't build them in", async () => {
    const h = provider()
    h.f.bakeFails = true
    h.f.ready = false
    await h.p.wake(BOX)
    expect(h.f.created).toHaveLength(2)
    expect(dockerfileOf(h.f.created[1]!)).toBe("FROM docker.io/box/boxyard-gpu:bx-1\nUSER root\n")
    expect([...h.f.sandboxes.keys()]).toEqual(["sb-2"])
    expect(h.f.execs.some((c) => /bash \/opt\/boxyard\/bootstrap\.sh > \/tmp\/boxyard-bootstrap\.log/.test(c))).toBe(true)
    expect(h.progress.some((m) => /couldn't build Box Yard's tools into the image/.test(m))).toBe(true)
  })

  it("goes through sudo when Daytona runs commands as another user", async () => {
    const h = provider()
    h.f.uid = "1000"
    await h.p.wake(BOX)
    expect(h.f.execs.some((c) => c.includes("sudo -n bash /opt/boxyard/init.sh"))).toBe(true)
  })

  it("deletes a sandbox that doesn't start in time", async () => {
    const h = provider({ settings: { startMinutes: 0.0005 } })
    h.f.neverStart = true
    await expect(h.p.wake(BOX)).rejects.toThrow(/didn't start within/)
    expect(h.f.sandboxes.size).toBe(0)
  })

  it("starts none while a cloud limit is reached", async () => {
    const h = provider()
    h.set({ blocked: "today's $5.00 limit is reached" })
    await expect(h.p.wake(BOX)).rejects.toThrow(/count toward the cloud limit, and today's \$5\.00 limit is reached/)
    expect(h.f.created).toEqual([])
  })

  it("holds Daytona's auto-stop off past a keep-warm, and puts it back after", async () => {
    const h = provider()
    const until = Date.now() + 60 * 60_000
    h.set({ warm: until })
    await h.p.wake(BOX)
    expect(h.f.created[0]!.autoStopInterval).toBe(90)
    await h.p.keepWarm(BOX, null)
    await h.p.keepWarm(BOX, until)
    expect(h.f.autostop).toEqual([
      { id: "sb-1", minutes: 30 },
      { id: "sb-1", minutes: 90 },
    ])
  })

  it("replaces a sandbox that stopped (and so is on its way out) on the next wake", async () => {
    const h = provider()
    await h.p.wake(BOX)
    h.f.sandboxes.get("sb-1")!.state = "stopped"
    expect(await h.p.health(BOX)).toBe("paused")
    await h.p.wake(BOX)
    expect([...h.f.sandboxes.keys()]).toEqual(["sb-2"])
  })

  it("never makes a box through the pool, or wakes another cloud's", async () => {
    const h = provider()
    await expect(h.p.create({ labels: [] })).rejects.toThrow(/aren't made through the box pool/)
    await expect(h.p.wake("vastai-prj_a")).rejects.toThrow(/isn't a Daytona box/)
  })
})

describe("Settings › Daytona", () => {
  it("keeps valid fields and refuses bad ones", () => {
    const s = new DaytonaSettingsStore(new Store(openDb(tmpDir(), ":memory:")))
    expect(s.get()).toEqual(DEFAULT_DAYTONA_SETTINGS)
    expect(s.update({ gpuTypes: ["H100"], gpus: 2, maxHourlyUsd: 12 })).toMatchObject({ gpuTypes: ["H100"], gpus: 2, maxHourlyUsd: 12 })
    expect(s.update({ gpuTypes: [DAYTONA_CPU] }).gpuTypes).toEqual([DAYTONA_CPU])
    expect(() => s.update({ gpuTypes: [DAYTONA_CPU, "H100"] })).toThrow(/CPU only can't be mixed/)
    expect(() => s.update({ gpuTypes: [] })).toThrow(/at least one GPU type/)
    expect(() => s.update({ image: "not an image!" })).toThrow(/image reference/)
    expect(() => s.update({ apiKey: "dtn_x" })).toThrow()
    expect(s.get().gpus).toBe(2)
  })

  it("keeps keep-warm deadlines only while they're ahead", () => {
    const s = new DaytonaSettingsStore(new Store(openDb(tmpDir(), ":memory:")))
    const until = Date.now() + 60_000
    s.setKeepWarm(BOX, until)
    s.setKeepWarm("daytona-prj_b", Date.now() - 1)
    expect(s.keepWarm()).toEqual({ [BOX]: until })
    s.setKeepWarm(BOX, null)
    expect(s.keepWarm()).toEqual({})
  })
})

describe("worker prompt in a Daytona sandbox", () => {
  const project = { id: "prj_1", name: "Game", description: "" } as Project
  const task = { id: "task_1", title: "T" }
  const prompt = (name: string) => workerSystemPrompt({ project, task, branch: "b", port: 4000, box: { memoryBytes: null, slots: 2, gpu: { name, cloud: "daytona" } } })

  it("says Daytona, signed per-port previews and no network volume", () => {
    const p = prompt("RTX 4090")
    expect(p).toContain("running in a Daytona sandbox of your project's own")
    expect(p).toContain("Your sandbox has an NVIDIA RTX 4090, shared with up to 1 other agents")
    expect(p).toContain("Your ports are 4000-4009")
    expect(p).toContain("There's no network volume")
    expect(p).not.toMatch(/RunPod|Vast|\/workspace\/data/)
  })

  it("has no GPU lines on a CPU-only sandbox, and ROCm on AMD", () => {
    expect(prompt("CPU only")).toContain("Your Daytona sandbox has no GPU (CPU only)")
    expect(prompt("CPU only")).not.toContain("nvidia-smi")
    expect(prompt("MI355X")).toContain("It runs ROCm, not CUDA")
  })
})
