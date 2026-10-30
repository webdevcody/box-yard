import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import {
  DEFAULT_AGENT_BYTES,
  HISTORY_SAMPLES,
  MachineStats,
  Ring,
  breakdown,
  heaviest,
  linuxPressure,
  localAgentFootprints,
  macPressureLevel,
  parseMemoryPressure,
  parseMeminfo,
  parsePs,
  parsePsi,
  parseSwapUsage,
  parseSysctl,
  parseVmStat,
  processKind,
  processName,
  readSample,
  recommend,
  swapTrend,
  vmStatUsedBytes,
  type MachineReaders,
} from "../server/machineStats.js"
import { THREAD_TOOLS } from "../server/sideThreads.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { testConfig, tmpDir } from "./helpers.js"

const GB = 1024 ** 3
const MB = 1024 ** 2

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               13597.
Pages active:                            301040.
Pages inactive:                          298106.
Pages speculative:                         2153.
Pages throttled:                              0.
Pages wired down:                        161352.
Pages purgeable:                           9532.
"Translation faults":                 1827591620.
Pages copy-on-write:                   44339213.
File-backed pages:                       227587.
Anonymous pages:                         373712.
Pages stored in compressor:              578227.
Pages occupied by compressor:            207424.
Swapins:                                3080893.
Swapouts:                               3632614.
`
const SYSCTL = `kern.memorystatus_vm_pressure_level: 2
kern.memorystatus_level: 31
vm.swapusage: total = 3072.00M  used = 1867.25M  free = 1204.75M  (encrypted)
`
const MEMORY_PRESSURE = `The system has 17179869184 (1048576 pages with a page size of 16384).

Stats:
Pages free: 13597
Pages purgeable: 9532
Swapins: 3080893
Swapouts: 3632614

System-wide memory free percentage: 54%
`
const MEMINFO = `MemTotal:       16303164 kB
MemFree:         1203456 kB
MemAvailable:    6291456 kB
Buffers:          102400 kB
Cached:          4194304 kB
SwapCached:        12288 kB
Active(anon):    5242880 kB
SwapTotal:       4194304 kB
SwapFree:        3145728 kB
`
const PSI = `some avg10=12.50 avg60=4.00 avg300=1.00 total=87578639
full avg10=2.00 avg60=0.50 avg300=0.10 total=84672503
`

const SECRET = "--append-system-prompt You are a Box Yard agent ghp_secret123"
const PS = [
  `    1     0     1   1000 /sbin/launchd`,
  `  100     1   100 400000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  `  101   100   100 300000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en`,
  `  102   100   100 200000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer`,
  `  200     1   200 150000 /usr/local/bin/node /Users/cody/box-yard/dist/server/server/index.js`,
  `  300     1   300 2000000 /Applications/Docker.app/Contents/MacOS/com.docker.backend`,
  `  310     1   310 3000000 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine`,
  // A local task: its runner, the claude under it, a test run under claude, and a headless browser it detached
  // from its parent but left in the runner's process group.
  `  400     1   400  60000 /usr/local/bin/node /Users/cody/boxyard-workspaces/.boxyard/box-runner.mjs turn /Users/cody/boxyard-workspaces/task_a`,
  `  401   400   400 500000 /Users/cody/.local/bin/claude -p --output-format stream-json ${SECRET}`,
  `  402   401   400 700000 node /Users/cody/boxyard-workspaces/task_a/work/node_modules/.bin/vitest run`,
  `  403     1   400 240000 /Users/cody/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless`,
  // A second local task.
  `  500     1   500  60000 /usr/local/bin/node /Users/cody/boxyard-workspaces/.boxyard/box-runner.mjs turn /Users/cody/boxyard-workspaces/task_b`,
  `  501   500   500 440000 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p`,
  // The Coordinator's own claude, not under any runner.
  `  600   200   600 350000 claude -p --mcp-config /tmp/x.json`,
  `  700     1   700  50000 /usr/sbin/mDNSResponder`,
  `garbage line`,
].join("\n")

describe("macOS parsers", () => {
  it("reads vm_stat pages and counts used memory like Activity Monitor", () => {
    const vm = parseVmStat(VM_STAT)!
    expect(vm.pageSize).toBe(16384)
    expect(vm.pages).toMatchObject({ free: 13597, active: 301040, "wired down": 161352, purgeable: 9532, "anonymous pages": 373712, "occupied by compressor": 207424 })
    expect(vm.pages["translation faults"]).toBe(1827591620)
    // (anonymous − purgeable) + wired + compressed.
    expect(vmStatUsedBytes(vm, 16 * GB)).toBe((373712 - 9532 + 161352 + 207424) * 16384)
    // Older vm_stat without the anonymous counter: active + wired + compressed.
    const old = parseVmStat(VM_STAT.replace(/^Anonymous pages:.*\n/m, ""))!
    expect(vmStatUsedBytes(old, 16 * GB)).toBe((301040 + 161352 + 207424) * 16384)
    // Never more than the memory there is.
    expect(vmStatUsedBytes(vm, 1 * GB)).toBe(1 * GB)
    expect(parseVmStat("not vm_stat")).toBeNull()
    expect(vmStatUsedBytes({ pageSize: 4096, pages: { free: 1 } }, GB)).toBeNull()
  })

  it("reads sysctl's pressure level, free percentage and swap", () => {
    const sys = parseSysctl(SYSCTL)
    expect(macPressureLevel(sys.get("kern.memorystatus_vm_pressure_level"))).toBe("warn")
    expect(macPressureLevel("1")).toBe("normal")
    expect(macPressureLevel("4")).toBe("critical")
    expect(macPressureLevel(undefined)).toBeNull()
    expect(sys.get("kern.memorystatus_level")).toBe("31")
    expect(parseSwapUsage(sys.get("vm.swapusage")!)).toEqual({ totalBytes: 3072 * MB, usedBytes: 1867.25 * MB })
    expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({ totalBytes: 0, usedBytes: 0 })
    expect(parseSwapUsage("")).toBeNull()
  })

  it("reads memory_pressure's free percentage", () => {
    expect(parseMemoryPressure(MEMORY_PRESSURE)).toEqual({ freePercent: 54 })
    expect(parseMemoryPressure("nothing")).toBeNull()
  })
})

describe("Linux parsers", () => {
  it("reads /proc/meminfo in bytes", () => {
    const m = parseMeminfo(MEMINFO)
    expect(m.MemTotal).toBe(16303164 * 1024)
    expect(m.MemAvailable).toBe(6291456 * 1024)
    expect(m["Active(anon)"]).toBe(5242880 * 1024)
    expect(m.SwapTotal! - m.SwapFree!).toBe(1048576 * 1024)
  })

  it("turns PSI stalls and free memory into a pressure level", () => {
    const psi = parsePsi(PSI)
    expect(psi).toEqual({ some10: 12.5, full10: 2 })
    expect(linuxPressure(psi, 40)).toBe("warn")
    expect(linuxPressure({ some10: 50, full10: 0 }, 40)).toBe("critical")
    expect(linuxPressure({ some10: 0, full10: 12 }, 40)).toBe("critical")
    // Without PSI (an old kernel): by what's left.
    expect(parsePsi("")).toBeNull()
    expect(linuxPressure(null, 40)).toBe("normal")
    expect(linuxPressure(null, 10)).toBe("warn")
    expect(linuxPressure(null, 3)).toBe("critical")
  })
})

/** A made-up computer. `files` and `commands` answer readFile and run; anything else is missing. */
function fakeReaders(over: Partial<MachineReaders> & { files?: Record<string, string>; commands?: Record<string, string> } = {}): MachineReaders & { calls: string[] } {
  const calls: string[] = []
  return {
    platform: "darwin",
    totalmem: () => 16 * GB,
    freemem: () => 200 * MB,
    loadavg: () => [3.2, 2.9, 2.5],
    cpuCount: () => 10,
    run: async (bin, args) => {
      calls.push([bin, ...args].join(" "))
      return over.commands?.[bin] ?? null
    },
    readFile: (f) => over.files?.[f] ?? null,
    ...over,
    calls,
  }
}

describe("readSample", () => {
  it("on macOS: vm_stat for used memory and one sysctl for pressure and swap", async () => {
    const r = fakeReaders({ commands: { vm_stat: VM_STAT, sysctl: SYSCTL, memory_pressure: MEMORY_PRESSURE } })
    const s = await readSample(r, 1000)
    expect(s).toMatchObject({ at: 1000, totalBytes: 16 * GB, pressure: "warn", freePercent: 31, swapUsedBytes: 1867.25 * MB, swapTotalBytes: 3072 * MB, load: [3.2, 2.9, 2.5], cpus: 10 })
    expect(s.usedBytes).toBe((373712 - 9532 + 161352 + 207424) * 16384)
    expect(s.freeBytes).toBe(16 * GB - s.usedBytes)
    // memory_pressure only when sysctl lacks the level; never ps in the background.
    expect(r.calls).toEqual(["vm_stat", "sysctl kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage"])
  })

  it("on macOS falls back to memory_pressure, then to os.freemem", async () => {
    const r = fakeReaders({ commands: { sysctl: "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M", memory_pressure: MEMORY_PRESSURE } })
    const s = await readSample(r)
    expect(s).toMatchObject({ freePercent: 54, pressure: null, usedBytes: 16 * GB - 200 * MB, swapTotalBytes: 0 })
    expect(r.calls).toContain("memory_pressure")
  })

  it("on Linux reads /proc only: MemAvailable, swap and PSI", async () => {
    const r = fakeReaders({ platform: "linux", files: { "/proc/meminfo": MEMINFO, "/proc/pressure/memory": PSI } })
    const s = await readSample(r)
    expect(s).toMatchObject({ totalBytes: 16303164 * 1024, usedBytes: (16303164 - 6291456) * 1024, swapUsedBytes: 1048576 * 1024, swapTotalBytes: 4194304 * 1024, pressure: "warn" })
    expect(s.freePercent).toBe(39)
    expect(r.calls).toEqual([])
  })

  it("on Linux in a container, counts the cgroup the way the box probe does", async () => {
    const files = {
      "/proc/meminfo": MEMINFO,
      "/sys/fs/cgroup/memory.max": `${4 * GB}\n`,
      "/sys/fs/cgroup/memory.current": `${3 * GB}\n`,
      "/sys/fs/cgroup/memory.stat": `anon 1\ninactive_file ${1 * GB}\n`,
    }
    const s = await readSample(fakeReaders({ platform: "linux", files }))
    expect(s).toMatchObject({ totalBytes: 4 * GB, usedBytes: 2 * GB, freeBytes: 2 * GB, freePercent: 50, pressure: "normal" })
  })
})

describe("history", () => {
  it("keeps only the newest samples, oldest first", () => {
    const ring = new Ring<number>(3)
    for (let i = 1; i <= 5; i++) ring.push(i)
    expect(ring.list()).toEqual([3, 4, 5])
    expect(ring.size).toBe(3)
  })

  it("says whether swap is growing over the window", () => {
    const at = (min: number, swapMb: number | null) => ({ at: min * 60_000, swapUsedBytes: swapMb === null ? null : swapMb * MB })
    expect(swapTrend([at(0, 1000), at(5, 1100), at(10, 1500)])).toEqual({ trend: "growing", deltaBytes: 500 * MB, overMs: 600_000 })
    expect(swapTrend([at(0, 1000), at(10, 1050)]).trend).toBe("steady")
    expect(swapTrend([at(0, 1500), at(10, 1000)]).trend).toBe("shrinking")
    expect(swapTrend([at(0, 1000)]).trend).toBe("unknown")
    expect(swapTrend([at(0, null), at(10, null)]).trend).toBe("unknown")
  })

  it("samples in the background and reports the last 15 minutes", async () => {
    let now = 0
    let swap = 1000
    const r = fakeReaders({ commands: { vm_stat: VM_STAT, ps: PS } })
    r.run = async (bin) => (bin === "sysctl" ? `kern.memorystatus_vm_pressure_level: 1\nkern.memorystatus_level: 60\nvm.swapusage: total = 4096.00M  used = ${swap}.00M  free = 1.00M` : bin === "vm_stat" ? VM_STAT : null)
    const m = new MachineStats(r, { now: () => now })
    for (let i = 0; i < 20; i++) {
      await m.tick()
      now += 60_000
      swap += 50
    }
    expect(m.samples()).toHaveLength(HISTORY_SAMPLES)
    const report = await m.report({ running: 0, limit: 2 })
    expect(report.history).toHaveLength(HISTORY_SAMPLES + 1)
    expect(report.history[0]).toMatch(/^15m ago: \d+% used, .* free, swap .*, load 3\.2, normal$/)
    expect(report.history.at(-1)).toMatch(/^now: /)
    expect(report.swap.trend).toBe("growing")
    expect(report.swap.line).toMatch(/used of 4\.0 GB, growing \(\+750 MB in 15m\)$/)
  })
})

describe("processes", () => {
  it("names processes without their arguments", () => {
    const rows = parsePs(PS)
    expect(rows).toHaveLength(15)
    expect(rows.map((r) => r.name)).toContain("Google Chrome Helper (Renderer)")
    expect(rows.find((r) => r.pid === 401)!.name).toBe("claude")
    expect(rows.find((r) => r.pid === 402)!.name).toBe("node vitest")
    expect(rows.find((r) => r.pid === 200)!.name).toBe("node index.js")
    expect(processName("/usr/bin/node")).toBe("node")
    expect(JSON.stringify(rows)).not.toContain("ghp_secret123")
    expect(JSON.stringify(rows)).not.toContain("Box Yard agent")
  })

  it("sorts them into claude, chrome, docker, node and other", () => {
    const kind = (pid: number) => parsePs(PS).find((r) => r.pid === pid)!.kind
    expect([kind(401), kind(501), kind(600)]).toEqual(["claude", "claude", "claude"])
    expect([kind(100), kind(101), kind(403)]).toEqual(["chrome", "chrome", "chrome"])
    expect([kind(300), kind(310)]).toEqual(["docker", "docker"])
    expect([kind(200), kind(400), kind(402)]).toEqual(["node", "node", "node"])
    expect([kind(1), kind(700)]).toEqual(["other", "other"])
    expect(processKind("/opt/runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude -p")).toBe("claude")
    expect(processKind("/usr/bin/dockerd -H fd://")).toBe("docker")
    expect(processKind("/home/me/.cache/ms-playwright/chromium-1140/chrome-linux/chrome --headless")).toBe("chrome")
  })

  it("totals memory by kind, heaviest first, and sums same-named helpers", () => {
    const rows = parsePs(PS)
    const kinds = breakdown(rows)
    expect(kinds.map((k) => k.kind)).toEqual(["docker", "claude", "chrome", "node", "other"])
    expect(kinds[0]).toEqual({ kind: "docker", bytes: 5_000_000 * 1024, processes: 2 })
    expect(kinds.find((k) => k.kind === "claude")).toEqual({ kind: "claude", bytes: 1_290_000 * 1024, processes: 3 })
    expect(kinds.find((k) => k.kind === "chrome")).toEqual({ kind: "chrome", bytes: 1_140_000 * 1024, processes: 4 })
    const top = heaviest(rows, 6)
    expect(top[0]).toMatchObject({ name: "com.apple.Virtualization.VirtualMachine", kind: "docker" })
    expect(top.find((p) => p.name === "Google Chrome Helper (Renderer)")).toEqual({ name: "Google Chrome Helper (Renderer)", kind: "chrome", bytes: 500_000 * 1024, processes: 2 })
  })

  it("measures each local task: its runner and everything under it or in its group", () => {
    // task_a: runner + claude + vitest + the detached Chromium; task_b: runner + claude. Not the Coordinator's claude.
    expect(localAgentFootprints(parsePs(PS))).toEqual([(60000 + 500000 + 700000 + 240000) * 1024, (60000 + 440000) * 1024])
    expect(localAgentFootprints(parsePs(PS.split("\n").filter((l) => !l.includes("box-runner")).join("\n")))).toEqual([])
  })
})

describe("recommend", () => {
  const sample = (over: Partial<Parameters<typeof recommend>[0]["sample"]> = {}) => ({ totalBytes: 16 * GB, freeBytes: 10 * GB, pressure: "normal" as const, load: [2, 2, 2] as [number, number, number], cpus: 10, ...over })

  it("raises by what fits after the reserve, at most 2 a step", () => {
    // 10 GB free − max(2 GB, 15% of 16 GB = 2.4 GB) = 7.6 GB spare; at 1.5 GB a task that's 5 more.
    const r = recommend({ sample: sample(), swap: "steady", running: 2, limit: 2, perAgentBytes: 1.5 * GB })
    expect(r).toMatchObject({ action: "raise", localAgents: 4, room: 5 })
    expect(r.line).toMatch(/^Room for about 5 more local tasks \(7\.6 GB spare after 2\.4 GB kept for the system, about 1\.5 GB per task\): raise localAgents 2 → 4\.$/)
    // A bigger footprint fits fewer.
    expect(recommend({ sample: sample(), swap: "steady", running: 2, limit: 2, perAgentBytes: 4 * GB })).toMatchObject({ action: "raise", localAgents: 3, room: 1 })
  })

  it("holds when the limit already allows what fits, or there's no room", () => {
    expect(recommend({ sample: sample(), swap: "steady", running: 1, limit: 8, perAgentBytes: 1.5 * GB })).toMatchObject({ action: "hold", localAgents: 8 })
    const none = recommend({ sample: sample({ freeBytes: 3 * GB }), swap: "steady", running: 2, limit: 2, perAgentBytes: 1.5 * GB })
    expect(none).toMatchObject({ action: "hold", localAgents: 2, room: 0 })
    expect(none.line).toMatch(/no room for another task/)
  })

  it("holds on elevated pressure, growing swap or a busy CPU", () => {
    expect(recommend({ sample: sample({ pressure: "warn" }), swap: "steady", running: 2, limit: 2, perAgentBytes: GB }).line).toBe("Keep localAgents at 2: memory pressure is elevated.")
    expect(recommend({ sample: sample(), swap: "growing", running: 2, limit: 2, perAgentBytes: GB }).line).toBe("Keep localAgents at 2: swap is growing.")
    expect(recommend({ sample: sample({ load: [30, 20, 10] }), swap: "steady", running: 2, limit: 2, perAgentBytes: GB }).line).toBe("Keep localAgents at 2: the 5-minute load is 20.0 on 10 CPUs.")
  })

  it("lowers one below what runs under critical pressure, swap growing under pressure, or memory under the reserve", () => {
    expect(recommend({ sample: sample({ pressure: "critical" }), swap: "steady", running: 4, limit: 6, perAgentBytes: GB })).toMatchObject({ action: "lower", localAgents: 3 })
    expect(recommend({ sample: sample({ pressure: "warn" }), swap: "growing", running: 3, limit: 3, perAgentBytes: GB }).line).toBe(
      "Lower localAgents 3 → 2: memory pressure is up and swap is growing.",
    )
    expect(recommend({ sample: sample({ freeBytes: 1 * GB }), swap: "steady", running: 2, limit: 2, perAgentBytes: GB })).toMatchObject({ action: "lower", localAgents: 1 })
    // Never below 1: at 1 it holds.
    expect(recommend({ sample: sample({ pressure: "critical" }), swap: "steady", running: 1, limit: 1, perAgentBytes: GB })).toMatchObject({ action: "hold", localAgents: 1 })
  })
})

describe("MachineStats.report", () => {
  it("uses the measured footprint of running local tasks, and remembers it", async () => {
    let now = 1_000_000
    let ps: string | null = PS
    const r = fakeReaders({ platform: "linux", files: { "/proc/meminfo": MEMINFO } })
    r.run = async (bin) => (bin === "ps" ? ps : null)
    const m = new MachineStats(r, { now: () => now })
    const first = await m.report({ running: 2, limit: 2 })
    expect(first.local_tasks).toEqual({ running: 2, limit: 2, per_task: "about 977 MB each (measured now from 2 running: claude and everything it started)" })
    expect(first.heaviest).toMatchObject({ by_kind: expect.arrayContaining(["claude: 1.2 GB in 3 processes"]) })
    expect(JSON.stringify(first)).not.toContain("ghp_secret123")
    // ps is cached for a moment, then read again; with no local task running the last measurement stands in.
    now += 60_000
    ps = PS.split("\n").filter((l) => !/task_[ab]/.test(l)).join("\n")
    const later = await m.report({ running: 0, limit: 2 })
    expect(later.local_tasks.per_task).toBe("about 977 MB each (measured 60s ago from 2)")
    // Without any measurement, a stated guess.
    const fresh = new MachineStats(r, { now: () => now })
    expect((await fresh.report({ running: 0, limit: 2 })).local_tasks.per_task).toMatch(new RegExp(`^about ${DEFAULT_AGENT_BYTES / GB} GB each \\(a guess`))
  })

  it("reports a computer without ps", async () => {
    const m = new MachineStats(fakeReaders({ platform: "linux", files: { "/proc/meminfo": MEMINFO } }))
    const report = await m.report({ running: 0, limit: 2 })
    expect(report.heaviest).toBe("ps isn't available")
    expect(report.memory).toMatchObject({ total_mb: Math.round((16303164 * 1024) / MB), pressure: "normal" })
    expect(report.swap.line).toBe("1.0 GB used of 4.0 GB")
  })
})

describe("machine_stats tool", () => {
  const yards: BoxYard[] = []
  afterEach(() => {
    for (const y of yards.splice(0)) y.stop()
  })

  async function connect(caller: McpCaller, machine: MachineStats) {
    const y = createBoxYard(testConfig({ dataDir: tmpDir() }), { webDir: "/nonexistent" })
    yards.push(y)
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, settings: y.settings, uploads: new Uploads(uploadsDir(tmpDir()), 1024), machine }
    if (caller.kind === "captain") y.store.createProject({ id: caller.projectId, name: "alpha", repo: "acme/alpha" } as never)
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    return { y, client }
  }

  it("answers the Coordinator with this computer's stats and the localAgents limit", async () => {
    const r = fakeReaders({ commands: { vm_stat: VM_STAT, sysctl: SYSCTL, ps: PS } })
    const { y, client } = await connect({ kind: "coordinator" }, new MachineStats(r))
    const tool = (await client.listTools()).tools.find((t) => t.name === "machine_stats")!
    expect(tool.description).toMatch(/create_schedule without a project/)
    expect(tool.description).toMatch(/update_settings \{ localAgents \}/)
    const res = (await client.callTool({ name: "machine_stats", arguments: {} })) as { content: { text: string }[]; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(res.content[0]!.text)
    expect(body.computer).toBe("macOS, 10 CPUs, 16 GB memory")
    expect(body.memory.pressure).toBe("warn")
    expect(body.local_tasks).toMatchObject({ running: 0, limit: y.settings.get().localAgents })
    expect(body.recommendation.action).toBe("hold")
    await client.close()
  })

  it("is offered to Captains and side threads, read-only", async () => {
    const { client } = await connect({ kind: "captain", projectId: "prj_alpha1" }, new MachineStats(fakeReaders()))
    const tool = (await client.listTools()).tools.find((t) => t.name === "machine_stats")!
    expect(tool.description).toMatch(/Only the Coordinator changes localAgents/)
    expect(THREAD_TOOLS.has("machine_stats")).toBe(true)
    await client.close()
  })
})
