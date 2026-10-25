import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { dfCommand, parseDf } from "../shared/disk.js"
import { DEFAULT_MEMORY_POLICY, memCommand, memoryPressure, parseMemory } from "../shared/memory.js"
import { workerSystemPrompt } from "../server/prompts.js"
import { memoryMeter } from "../web/src/lib/memoryMeter.js"
import type { Project } from "../shared/types.js"

const MB = 1024 * 1024
const GB = 1024 * MB

// What memCommand printed on a small Upstash box (Oct 24): a 4 GB cgroup with 2.5 GB of it page cache, on a 64-CPU host.
const UPSTASH = [
  "@@boxyard-mem",
  "memory.current 4004118528",
  "memory.max 4294967296",
  "inactive_file 2524737536",
  "MemTotal:       259223872 kB",
  "MemAvailable:   188648976 kB",
  "loadavg 7.85 10.84 12.00 3/8322 857861",
  "nproc 64",
].join("\n")

describe("parseMemory", () => {
  it("reads the cgroup's limit and use, without the reclaimable page cache", () => {
    expect(parseMemory(UPSTASH)).toEqual({ usedBytes: 4004118528 - 2524737536, totalBytes: 4294967296, load1: 7.85, cpus: 64 })
  })

  it("falls back to /proc/meminfo without a cgroup limit", () => {
    const out = ["@@boxyard-mem", "memory.current 123456", "memory.max max", "MemTotal: 8000000 kB", "MemAvailable: 6000000 kB", "loadavg 0.50 0.40 0.30 1/200 99", "nproc 4"].join("\n")
    expect(parseMemory(out)).toEqual({ usedBytes: 2000000 * 1024, totalBytes: 8000000 * 1024, load1: 0.5, cpus: 4 })
    // No cgroup files at all (cgroup v1, macOS-like hosts with /proc): meminfo alone.
    expect(parseMemory("@@boxyard-mem\nMemTotal: 1000 kB\nMemAvailable: 250 kB\nloadavg \nnproc ")).toEqual({ usedBytes: 750 * 1024, totalBytes: 1000 * 1024, load1: 0, cpus: 1 })
  })

  it("ignores a cgroup limit bigger than the machine", () => {
    const out = ["@@boxyard-mem", "memory.current 100", `memory.max ${2 ** 62}`, "MemTotal: 1000 kB", "MemAvailable: 500 kB", "nproc 1"].join("\n")
    expect(parseMemory(out)?.totalBytes).toBe(1000 * 1024)
  })

  it("is null without the memory part or with nothing usable in it", () => {
    expect(parseMemory("fakefs 100 40 60 40% /")).toBeNull()
    expect(parseMemory("@@boxyard-mem\nloadavg 1 1 1 1/1 1\nnproc 2")).toBeNull()
  })

  it("comes with the df probe, and leaves df-only output as it was", () => {
    const df = "/dev/nvme1n1 5242880 4998276 244604 96% /workspace\n@@boxyard-root-df\noverlay 8388608 7864320 524288 94% /\n"
    expect(parseDf(df + UPSTASH)?.memory).toEqual(parseMemory(UPSTASH))
    expect(parseDf(df + UPSTASH)?.root).toEqual({ totalBytes: 8388608 * 1024, freeBytes: 524288 * 1024 })
    expect(parseDf(df)).not.toHaveProperty("memory")
  })

  it("reads this machine with the real script", () => {
    const mem = parseMemory(execFileSync("bash", ["-c", memCommand()], { encoding: "utf8" }))
    expect(mem).not.toBeNull()
    expect(mem!.totalBytes).toBeGreaterThan(0)
    expect(mem!.usedBytes).toBeGreaterThanOrEqual(0)
    expect(mem!.usedBytes).toBeLessThanOrEqual(mem!.totalBytes)
    expect(mem!.cpus).toBeGreaterThan(0)
    const space = parseDf(execFileSync("bash", ["-c", dfCommand("/tmp")], { encoding: "utf8" }))
    expect(space?.memory?.totalBytes).toBe(mem!.totalBytes)
  })
})

describe("memoryPressure", () => {
  const mem = (usedGb: number, load1 = 0.5, cpus = 2) => ({ usedBytes: usedGb * GB, totalBytes: 4 * GB, load1, cpus })
  it("flags a box over the used share, under the free floor, or over the load limit", () => {
    expect(memoryPressure(mem(1.5), DEFAULT_MEMORY_POLICY)).toBeNull()
    expect(memoryPressure(mem(3.5), DEFAULT_MEMORY_POLICY)).toBe("3.5 GB of 4.0 GB memory in use (88%), over 80%")
    expect(memoryPressure(mem(3.5), { ...DEFAULT_MEMORY_POLICY, maxUsedPercent: 0, minFreeMb: 1024 })).toBe("only 512 MB of 4.0 GB memory free")
    expect(memoryPressure(mem(1, 4.5), DEFAULT_MEMORY_POLICY)).toBe("load 4.50 on 2 CPUs, over 2× its CPUs")
    expect(memoryPressure(mem(1, 4), DEFAULT_MEMORY_POLICY)).toBeNull()
  })

  it("turns each rule off at 0, and says nothing without a reading", () => {
    expect(memoryPressure(mem(3.9, 50), { maxUsedPercent: 0, minFreeMb: 0, maxLoadPerCpu: 0 })).toBeNull()
    expect(memoryPressure(null, DEFAULT_MEMORY_POLICY)).toBeNull()
  })
})

describe("memoryMeter", () => {
  it("states use and load, and turns amber when placement skips the box, red near full", () => {
    expect(memoryMeter({ memUsedBytes: null, memTotalBytes: null })).toBeNull()
    const ok = memoryMeter({ memUsedBytes: GB, memTotalBytes: 4 * GB, loadAvg: 0.5, cpuCount: 2, memoryPressure: null })!
    expect(ok).toMatchObject({ label: "1.0 GB of 4.0 GB memory in use (25%)", load: "load 0.50 on 2 CPUs", tone: "ok", busy: null })
    expect(memoryMeter({ memUsedBytes: 3.4 * GB, memTotalBytes: 4 * GB, memoryPressure: "x" })!.tone).toBe("warn")
    expect(memoryMeter({ memUsedBytes: 3.9 * GB, memTotalBytes: 4 * GB, memoryPressure: "x" })!.tone).toBe("error")
  })
})

describe("box prompt", () => {
  it("tells the agent about the box in a way that stays the same from turn to turn", () => {
    const project = { id: "prj_a", name: "alpha", description: "", repo: null, baseBranch: "main", agentsPerBox: null } as unknown as Project
    const prompt = (box: Parameters<typeof workerSystemPrompt>[0]["box"], p = project) => workerSystemPrompt({ project: p, task: { id: "task_a", title: "t" }, branch: null, port: 4000, box })
    expect(prompt({ memoryBytes: 4 * GB, slots: 2 })).toContain("This box has 4.0 GB of memory, shared with up to 1 other agents that may run at the same time.")
    expect(prompt({ memoryBytes: 4 * GB, slots: 3 })).toContain("shared with up to 2 other agents")
    // Agents per box 1: the project's agents run alone.
    expect(prompt({ memoryBytes: 8 * GB, slots: 1, alone: true })).toContain("This box has 8.0 GB of memory, and your project runs its agents alone on a box")
    expect(prompt({ memoryBytes: null, slots: 1 })).toContain("This box's memory is limited. Run heavy jobs")
    expect(prompt(undefined)).not.toContain("Run heavy jobs")
  })
})
