// This computer's resources for the machine_stats MCP tool: memory, memory pressure, swap, load, the heaviest
// processes by kind and room for more "Runs on: This computer" tasks, so the Coordinator can watch the machine (and
// a schedule can scale Settings › localAgents) without starting an agent to measure it. pool_status covers the
// Upstash boxes; this is the computer running Box Yard (Cody's Mac, or a Linux server).
//
// Cheap on purpose: a sample a minute in the background from Node's `os` plus, on macOS, one `vm_stat` and one
// `sysctl` (memory_pressure only when sysctl lacks the level); on Linux it reads /proc and the cgroup files. `ps`
// runs only when the tool is called, at most every PROCESS_CACHE_MS.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import { formatBytes } from "../shared/disk.js"
import { MEM_MARK, parseMemory } from "../shared/memory.js"
import { LOCAL_AGENTS_LIMITS } from "../shared/runner.js"

/** What the sampler reads the computer through (tests pass fakes, so they run the same on macOS and Linux). */
export interface MachineReaders {
  platform: NodeJS.Platform
  totalmem(): number
  freemem(): number
  loadavg(): number[]
  cpuCount(): number
  /** A command's stdout, even when it exits non-zero (sysctl does for one unknown name), or null when it can't run. */
  run(bin: string, args: string[]): Promise<string | null>
  /** A file's text, or null when it can't be read. */
  readFile(file: string): string | null
}

const RUN_TIMEOUT_MS = 5_000

export const nodeReaders = (): MachineReaders => ({
  platform: process.platform,
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  loadavg: () => os.loadavg(),
  cpuCount: () => (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length),
  run: (bin, args) =>
    new Promise((resolve) => {
      try {
        execFile(bin, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) =>
          resolve(stdout ? String(stdout) : err ? null : ""),
        )
      } catch {
        resolve(null)
      }
    }),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return null
    }
  },
})

export type PressureLevel = "normal" | "warn" | "critical"

/** One reading of the computer. */
export interface MachineSample {
  at: number
  totalBytes: number
  /** In use, without what the OS can hand back at once (macOS: Activity Monitor's "Memory Used"; Linux: MemTotal − MemAvailable). */
  usedBytes: number
  freeBytes: number
  /** The OS's own pressure level (macOS kern.memorystatus_vm_pressure_level; Linux from PSI and free memory), or null. */
  pressure: PressureLevel | null
  /** macOS memory_pressure's "System-wide memory free percentage", or Linux's available %. */
  freePercent: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  load: [number, number, number]
  cpus: number
}

// ---- Parsers -------------------------------------------------------------------------------------------------------

/** macOS `vm_stat`: the page size and each "Pages …" counter by name ("Pages free" → "free"). */
export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } | null {
  const size = text.match(/page size of (\d+) bytes/)
  if (!size) return null
  const pages: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^"?([^:"]+)"?:\s+(\d+)\.?\s*$/)
    if (!m) continue
    const key = m[1]!
      .trim()
      .toLowerCase()
      .replace(/^pages\s+/, "")
    pages[key] = Number(m[2])
  }
  return { pageSize: Number(size[1]), pages }
}

/**
 * Memory in use from vm_stat, the way Activity Monitor counts "Memory Used": app memory (anonymous − purgeable) +
 * wired + compressed. Without the anonymous counter (older macOS), active + wired + compressed.
 */
export function vmStatUsedBytes(vm: { pageSize: number; pages: Record<string, number> }, totalBytes: number): number | null {
  const p = vm.pages
  const wired = p["wired down"]
  const compressed = p["occupied by compressor"] ?? 0
  if (wired === undefined) return null
  const app = p["anonymous pages"] !== undefined ? p["anonymous pages"] - (p["purgeable"] ?? 0) : p["active"]
  if (app === undefined) return null
  return Math.min(totalBytes, Math.max(0, (app + wired + compressed) * vm.pageSize))
}

const SIZE_UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

/** macOS `sysctl vm.swapusage`: "total = 2048.00M  used = 1067.25M  free = 980.75M  (encrypted)". */
export function parseSwapUsage(text: string): { usedBytes: number; totalBytes: number } | null {
  const val = (k: string) => {
    const m = text.match(new RegExp(`${k} = ([\\d.]+)([KMGT])?`))
    return m ? Number(m[1]) * (m[2] ? SIZE_UNIT[m[2]]! : 1) : null
  }
  const total = val("total")
  const used = val("used")
  return total === null || used === null ? null : { usedBytes: used, totalBytes: total }
}

/** `sysctl` output as name → value ("kern.memorystatus_level: 54"). */
export function parseSysctl(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z0-9_.]+):\s*(.*)$/)
    if (m) out.set(m[1]!, m[2]!.trim())
  }
  return out
}

/** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export function macPressureLevel(value: string | undefined): PressureLevel | null {
  const n = Number(value)
  return n === 1 ? "normal" : n === 2 ? "warn" : n === 4 ? "critical" : null
}

/** macOS `memory_pressure` (no arguments: it only reports): its "System-wide memory free percentage". */
export function parseMemoryPressure(text: string): { freePercent: number } | null {
  const m = text.match(/System-wide memory free percentage:\s*(\d+)%/)
  return m ? { freePercent: Number(m[1]) } : null
}

/** Linux /proc/meminfo, in bytes (its values are kB). */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/)
    if (m) out[m[1]!] = Number(m[2]) * (/kB/.test(line) ? 1024 : 1)
  }
  return out
}

/** Linux /proc/pressure/memory: the "some" and "full" 10-second averages (% of time stalled on memory). */
export function parsePsi(text: string): { some10: number; full10: number } | null {
  const avg = (kind: string) => {
    const m = text.match(new RegExp(`^${kind} avg10=([\\d.]+)`, "m"))
    return m ? Number(m[1]) : null
  }
  const some10 = avg("some")
  return some10 === null ? null : { some10, full10: avg("full") ?? 0 }
}

/** A pressure level for Linux, which has none of its own: stalls (PSI) first, else how much memory is left. */
export function linuxPressure(psi: { some10: number; full10: number } | null, freePercent: number): PressureLevel {
  if (psi && (psi.full10 >= 10 || psi.some10 >= 40)) return "critical"
  if (psi && psi.some10 >= 10) return "warn"
  if (freePercent < 5) return "critical"
  if (freePercent < 15) return "warn"
  return "normal"
}

// ---- Sampling ------------------------------------------------------------------------------------------------------

/** One reading. Node's os for totals and load; the platform's own tools only for what os lacks. */
export async function readSample(r: MachineReaders, now = Date.now()): Promise<MachineSample> {
  const totalBytes = r.totalmem()
  const [l1 = 0, l5 = 0, l15 = 0] = r.loadavg()
  const base = { at: now, totalBytes, load: [l1, l5, l15] as [number, number, number], cpus: Math.max(1, r.cpuCount()) }
  if (r.platform === "darwin") {
    const [vmText, sysText] = await Promise.all([
      r.run("vm_stat", []),
      r.run("sysctl", ["kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "vm.swapusage"]),
    ])
    const vm = vmText ? parseVmStat(vmText) : null
    const sys = parseSysctl(sysText ?? "")
    let freePercent = Number.isFinite(Number(sys.get("kern.memorystatus_level"))) && sys.has("kern.memorystatus_level") ? Number(sys.get("kern.memorystatus_level")) : null
    if (freePercent === null) {
      const mp = await r.run("memory_pressure", [])
      freePercent = mp ? (parseMemoryPressure(mp)?.freePercent ?? null) : null
    }
    // os.freemem() on macOS is only the free pages: most of the rest is cache it hands back at once.
    const usedBytes = (vm ? vmStatUsedBytes(vm, totalBytes) : null) ?? totalBytes - r.freemem()
    const swap = parseSwapUsage(sys.get("vm.swapusage") ?? "")
    return {
      ...base,
      usedBytes,
      freeBytes: Math.max(0, totalBytes - usedBytes),
      pressure: macPressureLevel(sys.get("kern.memorystatus_vm_pressure_level")),
      freePercent,
      swapUsedBytes: swap?.usedBytes ?? null,
      swapTotalBytes: swap?.totalBytes ?? null,
    }
  }
  if (r.platform === "linux") {
    const meminfoText = r.readFile("/proc/meminfo") ?? ""
    const info = parseMeminfo(meminfoText)
    // The same count the box probe makes (shared/memory.ts): a cgroup with a limit (a container) wins over the host.
    const cg = (f: string) => r.readFile(`/sys/fs/cgroup/${f}`)?.trim() ?? ""
    const [current, max] = [cg("memory.current"), cg("memory.max")]
    const probe = [
      MEM_MARK,
      current && `memory.current ${current}`,
      max && `memory.max ${max}`,
      cg("memory.stat")
        .split("\n")
        .find((l) => l.startsWith("inactive_file ")) ?? "",
      ...meminfoText.split("\n").filter((l) => /^(MemTotal|MemAvailable):/.test(l)),
    ].join("\n")
    const mem = parseMemory(probe)
    const total = mem?.totalBytes ?? totalBytes
    const used = mem?.usedBytes ?? total - r.freemem()
    const freePercent = Math.round(((total - used) / Math.max(1, total)) * 100)
    const swapTotal = info.SwapTotal ?? null
    const swapUsed = swapTotal !== null && info.SwapFree !== undefined ? Math.max(0, swapTotal - info.SwapFree) : null
    return {
      ...base,
      totalBytes: total,
      usedBytes: used,
      freeBytes: Math.max(0, total - used),
      pressure: linuxPressure(parsePsi(r.readFile("/proc/pressure/memory") ?? ""), freePercent),
      freePercent,
      swapUsedBytes: swapUsed,
      swapTotalBytes: swapTotal,
    }
  }
  const used = totalBytes - r.freemem()
  return { ...base, usedBytes: used, freeBytes: r.freemem(), pressure: null, freePercent: null, swapUsedBytes: null, swapTotalBytes: null }
}

/** A fixed-size ring of the newest items. */
export class Ring<T> {
  private items: T[] = []
  constructor(readonly capacity: number) {}
  push(item: T) {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  /** Oldest first. */
  list(): T[] {
    return [...this.items]
  }
  get size() {
    return this.items.length
  }
}

/** Swap counts as growing past this much more than the oldest sample in the history. */
export const SWAP_GROWTH_BYTES = 128 * 1024 ** 2

/** Whether swap is growing over the samples (oldest first), and by how much. */
export function swapTrend(samples: Pick<MachineSample, "at" | "swapUsedBytes">[]): { trend: "growing" | "shrinking" | "steady" | "unknown"; deltaBytes: number; overMs: number } {
  const known = samples.filter((s) => s.swapUsedBytes !== null)
  if (known.length < 2) return { trend: "unknown", deltaBytes: 0, overMs: 0 }
  const first = known[0]!
  const last = known[known.length - 1]!
  const deltaBytes = last.swapUsedBytes! - first.swapUsedBytes!
  const overMs = last.at - first.at
  return { trend: deltaBytes >= SWAP_GROWTH_BYTES ? "growing" : deltaBytes <= -SWAP_GROWTH_BYTES ? "shrinking" : "steady", deltaBytes, overMs }
}

// ---- Processes -----------------------------------------------------------------------------------------------------

export const PROCESS_KINDS = ["claude", "chrome", "docker", "node", "other"] as const
export type ProcessKind = (typeof PROCESS_KINDS)[number]

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  rssBytes: number
  /** The executable's name (and a node script's), never the arguments: those hold prompts and tokens. */
  name: string
  kind: ProcessKind
  /** A local task's runner (box-runner.mjs turn): the root of one local agent's processes. */
  runner: boolean
}

/** The command `ps` runs with: every process, full command lines (only to name and sort them), RSS in KB. */
export const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,rss=,args="]

/** "Google Chrome Helper (Renderer)", "claude", "node vitest.mjs": a process's name from its command line. */
export function processName(args: string): string {
  const app = args.match(/\.app\/Contents\/MacOS\/(.+?)(?=\s+-|$)/)
  const exe = app ? app[1]!.trim() : (args.split(/\s+/)[0] ?? "")
  const base = exe.split("/").pop() || exe
  if (/^(node|bun|deno)$/.test(base)) {
    const script = args.split(/\s+/).slice(1).find((a) => !a.startsWith("-"))
    const name = script?.split("/").pop()
    return name ? `${base} ${name}` : base
  }
  return base
}

/** Which kind of consumer a process is, by its command line. claude first: its CLI can be a node script. */
export function processKind(args: string): ProcessKind {
  const name = processName(args)
  if (/^claude\b/.test(name) || /@anthropic-ai\/claude-code|claude-agent-sdk[^/\s]*\/claude\b/.test(args) || /^node claude\b/.test(name)) return "claude"
  if (/Google Chrome|Chromium|chrome_crashpad|\bchrome\b|headless_shell|Microsoft Edge|Brave Browser/i.test(name)) return "chrome"
  if (/docker|com\.docker|containerd|vpnkit|qemu|colima|limactl|Virtualization\.VirtualMachine|OrbStack/i.test(args.split(/\s+-/)[0] ?? args)) return "docker"
  if (/^(node|npm|npx|bun|deno|tsx|pnpm|yarn)\b/.test(name)) return "node"
  return "other"
}

/** `ps -A -ww -o pid=,ppid=,pgid=,rss=,args=` output. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const args = m[5]!.trim()
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      rssBytes: Number(m[4]) * 1024,
      name: processName(args),
      kind: processKind(args),
      runner: /box-runner\.mjs\s+turn\b/.test(args),
    })
  }
  return rows
}

export interface KindTotal {
  kind: ProcessKind
  bytes: number
  processes: number
}

/** Memory by kind, heaviest first (RSS, so shared pages count once per process: a rough upper bound). */
export function breakdown(rows: ProcessRow[]): KindTotal[] {
  const totals = new Map<ProcessKind, KindTotal>(PROCESS_KINDS.map((kind) => [kind, { kind, bytes: 0, processes: 0 }]))
  for (const r of rows) {
    const t = totals.get(r.kind)!
    t.bytes += r.rssBytes
    t.processes++
  }
  return [...totals.values()].filter((t) => t.processes > 0).sort((a, b) => b.bytes - a.bytes)
}

/** The heaviest single processes. Helpers with the same name are summed, so 30 Chrome renderers read as one line. */
export function heaviest(rows: ProcessRow[], n = 5): { name: string; kind: ProcessKind; bytes: number; processes: number }[] {
  const byName = new Map<string, { name: string; kind: ProcessKind; bytes: number; processes: number }>()
  for (const r of rows) {
    const e = byName.get(r.name) ?? { name: r.name, kind: r.kind, bytes: 0, processes: 0 }
    e.bytes += r.rssBytes
    e.processes++
    byName.set(r.name, e)
  }
  return [...byName.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n)
}

/**
 * What each running local task uses: its runner and everything under it (by parent, or in its process group, which
 * the runner leads), so its claude, builds, test runners and browsers count.
 */
export function localAgentFootprints(rows: ProcessRow[]): number[] {
  const children = new Map<number, ProcessRow[]>()
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r])
  return rows
    .filter((r) => r.runner)
    .map((root) => {
      const seen = new Set<number>()
      const stack = [root, ...rows.filter((r) => r.pgid === root.pid)]
      let bytes = 0
      while (stack.length) {
        const p = stack.pop()!
        if (seen.has(p.pid)) continue
        seen.add(p.pid)
        bytes += p.rssBytes
        stack.push(...(children.get(p.pid) ?? []))
      }
      return bytes
    })
}

// ---- Recommendation ------------------------------------------------------------------------------------------------

/** Kept free for the OS and Cody's own apps: the larger of this and RESERVE_FRACTION of the memory. */
export const RESERVE_MIN_BYTES = 2 * 1024 ** 3
export const RESERVE_FRACTION = 0.15
/** A local task's footprint when none has been measured yet (claude plus a build or a test run). */
export const DEFAULT_AGENT_BYTES = 1.5 * 1024 ** 3
/** More tasks wait while the 5-minute load is above this many times the CPUs. */
export const MAX_LOAD_PER_CPU = 1.5
/** One recommendation raises the limit by at most this much, so a schedule steps up and measures again. */
export const MAX_RAISE_STEP = 2

export interface Recommendation {
  action: "raise" | "hold" | "lower"
  /** The localAgents value to set (equal to the limit for hold). */
  localAgents: number
  /** About how many more local tasks fit in memory now. */
  room: number
  line: string
}

export function recommend(input: {
  sample: Pick<MachineSample, "totalBytes" | "freeBytes" | "pressure" | "load" | "cpus">
  swap: ReturnType<typeof swapTrend>["trend"]
  running: number
  limit: number
  perAgentBytes: number
}): Recommendation {
  const { sample, swap, running, limit } = input
  const per = Math.max(256 * 1024 ** 2, input.perAgentBytes)
  const reserve = Math.max(RESERVE_MIN_BYTES, sample.totalBytes * RESERVE_FRACTION)
  const spare = sample.freeBytes - reserve
  const room = Math.max(0, Math.floor(spare / per))
  const clamp = (n: number) => Math.min(LOCAL_AGENTS_LIMITS.max, Math.max(LOCAL_AGENTS_LIMITS.min, n))
  const loadPerCpu = sample.load[1] / Math.max(1, sample.cpus)
  const hold = (why: string): Recommendation => ({ action: "hold", localAgents: limit, room, line: `Keep localAgents at ${limit}: ${why}.` })
  const lower = (why: string): Recommendation => {
    const to = clamp(Math.min(limit, Math.max(running, 1)) - 1)
    return to < limit ? { action: "lower", localAgents: to, room: 0, line: `Lower localAgents ${limit} → ${to}: ${why}.` } : hold(why)
  }
  if (sample.pressure === "critical") return lower("memory pressure is critical")
  if (swap === "growing" && sample.pressure === "warn") return lower("memory pressure is up and swap is growing")
  if (spare < 0 && running > 0) return lower(`only ${formatBytes(sample.freeBytes)} free, under the ${formatBytes(reserve)} kept for the system`)
  if (sample.pressure === "warn") return hold("memory pressure is elevated")
  if (swap === "growing") return hold("swap is growing")
  if (loadPerCpu > MAX_LOAD_PER_CPU) return hold(`the 5-minute load is ${sample.load[1].toFixed(1)} on ${sample.cpus} CPUs`)
  const memo = `${formatBytes(Math.max(0, spare))} spare after ${formatBytes(reserve)} kept for the system, about ${formatBytes(per)} per task`
  const target = clamp(running + room)
  if (target > limit) {
    const to = Math.min(target, limit + MAX_RAISE_STEP)
    return { action: "raise", localAgents: to, room, line: `Room for about ${room} more local task${room === 1 ? "" : "s"} (${memo}): raise localAgents ${limit} → ${to}.` }
  }
  return hold(room ? `room for about ${room} more (${memo}), and the limit already allows it` : `no room for another task (${memo})`)
}

// ---- The sampler ---------------------------------------------------------------------------------------------------

/** One sample a minute, 15 kept: the last quarter hour. */
export const SAMPLE_INTERVAL_MS = 60_000
export const HISTORY_SAMPLES = 15
/** ps runs at most this often (machine_stats calls in a row share it). */
export const PROCESS_CACHE_MS = 15_000
/** A measured footprint stands in for this long once no local task runs. */
export const FOOTPRINT_TTL_MS = 6 * 3600_000

const mb = (n: number | null) => (n === null ? null : Math.round(n / 1024 ** 2))
const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

export class MachineStats {
  private history = new Ring<MachineSample>(HISTORY_SAMPLES)
  private timer: NodeJS.Timeout | null = null
  private sampling: Promise<void> | null = null
  private procs: { at: number; rows: ProcessRow[] | null } | null = null
  private footprint: { bytes: number; at: number; tasks: number } | null = null

  constructor(
    private readonly readers: MachineReaders = nodeReaders(),
    private readonly opts: { intervalMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }

  start() {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? SAMPLE_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Take a background sample (one at a time: a slow reading is never stacked). */
  tick(): Promise<void> {
    this.sampling ??= readSample(this.readers, this.now())
      .then((s) => this.history.push(s))
      .catch(() => {})
      .finally(() => (this.sampling = null))
    return this.sampling
  }

  samples(): MachineSample[] {
    return this.history.list()
  }

  private async processes(): Promise<ProcessRow[] | null> {
    const now = this.now()
    if (this.procs && now - this.procs.at < PROCESS_CACHE_MS) return this.procs.rows
    const text = await this.readers.run("ps", PS_ARGS)
    const rows = text ? parsePs(text) : null
    this.procs = { at: now, rows }
    return rows
  }

  /** The machine_stats result: a fresh reading, the history, the heaviest processes and room for local tasks. */
  async report(agents: { running: number; limit: number }) {
    const now = this.now()
    const [sample, rows] = await Promise.all([readSample(this.readers, now), this.processes()])
    const history = [...this.samples().filter((s) => now - s.at > 5_000), sample]
    const swap = swapTrend(history)
    const kinds = rows ? breakdown(rows) : []
    const footprints = rows ? localAgentFootprints(rows) : []
    if (footprints.length) this.footprint = { bytes: footprints.reduce((a, b) => a + b, 0) / footprints.length, at: now, tasks: footprints.length }
    const known = this.footprint && now - this.footprint.at < FOOTPRINT_TTL_MS ? this.footprint : null
    const perAgentBytes = known?.bytes ?? DEFAULT_AGENT_BYTES
    const perTask = !known
      ? `about ${formatBytes(DEFAULT_AGENT_BYTES)} each (a guess: no local task has been measured yet)`
      : footprints.length
        ? `about ${formatBytes(known.bytes)} each (measured now from ${known.tasks} running: claude and everything it started)`
        : `about ${formatBytes(known.bytes)} each (measured ${ago(now - known.at)} ago from ${known.tasks})`
    const pct = Math.round((sample.usedBytes / Math.max(1, sample.totalBytes)) * 100)
    const swapLine =
      sample.swapUsedBytes === null
        ? "unknown"
        : sample.swapTotalBytes === 0
          ? "no swap"
          : `${formatBytes(sample.swapUsedBytes)} used${sample.swapTotalBytes ? ` of ${formatBytes(sample.swapTotalBytes)}` : ""}${
            swap.trend === "unknown" ? "" : `, ${swap.trend}${swap.trend === "steady" ? "" : ` (${swap.deltaBytes > 0 ? "+" : "−"}${formatBytes(Math.abs(swap.deltaBytes))} in ${ago(swap.overMs)})`}`
          }`
    return {
      computer: `${this.readers.platform === "darwin" ? "macOS" : this.readers.platform}, ${sample.cpus} CPUs, ${formatBytes(sample.totalBytes)} memory`,
      memory: {
        line: `${formatBytes(sample.usedBytes)} of ${formatBytes(sample.totalBytes)} in use (${pct}%), ${formatBytes(sample.freeBytes)} free${sample.pressure ? `, pressure ${sample.pressure}` : ""}`,
        total_mb: mb(sample.totalBytes),
        used_mb: mb(sample.usedBytes),
        free_mb: mb(sample.freeBytes),
        pressure: sample.pressure,
        free_percent: sample.freePercent,
      },
      swap: { line: swapLine, used_mb: mb(sample.swapUsedBytes), total_mb: mb(sample.swapTotalBytes), trend: swap.trend },
      load: {
        line: `${sample.load.map((l) => l.toFixed(2)).join(" / ")} (1 / 5 / 15 min) on ${sample.cpus} CPUs`,
        "1m": round2(sample.load[0]),
        "5m": round2(sample.load[1]),
        "15m": round2(sample.load[2]),
        cpus: sample.cpus,
      },
      heaviest: rows
        ? {
            by_kind: kinds.map((k) => `${k.kind}: ${formatBytes(k.bytes)} in ${k.processes} process${k.processes === 1 ? "" : "es"}`),
            top: heaviest(rows).map((p) => `${p.name} (${p.kind}): ${formatBytes(p.bytes)}${p.processes > 1 ? ` in ${p.processes}` : ""}`),
            note: "Resident memory per process, so shared pages count more than once: a rough guide.",
          }
        : "ps isn't available",
      local_tasks: { running: agents.running, limit: agents.limit, per_task: perTask },
      recommendation: recommend({ sample, swap: swap.trend, running: agents.running, limit: agents.limit, perAgentBytes }),
      history: history.map(
        (s) =>
          `${s === sample ? "now" : `${ago(now - s.at)} ago`}: ${Math.round((s.usedBytes / Math.max(1, s.totalBytes)) * 100)}% used, ${formatBytes(s.freeBytes)} free${
            s.swapUsedBytes !== null ? `, swap ${formatBytes(s.swapUsedBytes)}` : ""
          }, load ${s.load[0].toFixed(1)}${s.pressure ? `, ${s.pressure}` : ""}`,
      ),
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
