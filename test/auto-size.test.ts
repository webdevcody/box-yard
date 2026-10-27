import { describe, expect, it } from "vitest"
import { AUTO_SIZE_WINDOW_MS, autoSizeLabel, pickAutoSize, type TurnPeak } from "../shared/autoSize.js"
import { parseMemory } from "../shared/memory.js"

// Auto-sizing's rule (shared/autoSize.ts): the smallest size with RAM for 1.25 × the 14-day peak, from 3 runs; bigger
// for disk, for CPU kept busy, or above a box a turn ran out of memory on; held to Settings › Max size it may choose.

const GB = 1024 ** 3
const now = Date.UTC(2026, 9, 27, 12)

function run(over: Partial<TurnPeak> = {}): TurnPeak {
  return { boxSize: "small", at: now - 3_600_000, memPeakBytes: 1 * GB, cpuPeakCores: 1, cpuBusyCores: 0.2, diskPeakBytes: 1 * GB, oom: false, ...over }
}
const pick = (peaks: TurnPeak[], maxSize: "small" | "medium" | "large" = "large") => pickAutoSize(peaks, { maxSize, now })

describe("pickAutoSize", () => {
  it("needs 3 measured runs; until then it picks nothing and Worker size applies", () => {
    const two = pick([run(), run()])
    expect(two).toMatchObject({ size: null, runs: 2, basis: null })
    expect(two.label).toBe("not measured yet (2 of 3 runs)")
    expect(pick([run(), run(), run()])).toMatchObject({ size: "small", runs: 3, basis: "memory" })
  })

  it("picks the smallest size with RAM for 1.25 × the peak", () => {
    // 3.2 GB × 1.25 = 4 GB: a small box (4 GB) is just enough; a little more needs a medium.
    expect(pick([run(), run(), run({ memPeakBytes: 3.2 * GB })]).size).toBe("small")
    const medium = pick([run(), run(), run({ memPeakBytes: 3.3 * GB })])
    expect(medium).toMatchObject({ size: "medium", basis: "memory", memPeakBytes: 3.3 * GB, capped: false })
    expect(medium.label).toBe("medium (peak 3.3 GB over 3 runs)")
    expect(pick([run(), run(), run({ memPeakBytes: 7 * GB })]).size).toBe("large")
  })

  it("forgets runs older than 14 days", () => {
    const old = run({ memPeakBytes: 7 * GB, oom: true, at: now - AUTO_SIZE_WINDOW_MS - 1 })
    expect(pick([old, run(), run(), run()])).toMatchObject({ size: "small", runs: 3 })
  })

  it("holds the pick to the max size it may choose, and says so", () => {
    const held = pick([run(), run(), run({ memPeakBytes: 7 * GB })], "medium")
    expect(held).toMatchObject({ size: "medium", capped: true })
    expect(held.label).toBe("medium (peak 7.0 GB over 3 runs; held to the max size)")
  })

  it("goes up for CPU only when the median run kept its cores busy, not for a busy minute", () => {
    // A build that pins both cores for a minute, in a run that mostly waits on the model: small is enough.
    expect(pick([run({ cpuPeakCores: 2 }), run({ cpuPeakCores: 2 }), run({ cpuPeakCores: 2 })]).size).toBe("small")
    // Its median minute at 1.9 of a small box's 2 cores: held back, so one size up.
    const busy = run({ cpuPeakCores: 2, cpuBusyCores: 1.9 })
    const up = pick([busy, busy, run()])
    expect(up).toMatchObject({ size: "medium", basis: "cpu" })
    expect(up.label).toBe("medium (peak 1.0 GB over 3 runs; its runs kept their CPU busy)")
    expect(pick([busy, run(), run()]).size).toBe("small")
    // Once on medium boxes the same work isn't held back, and it stays medium rather than going back down.
    const room = run({ boxSize: "medium", cpuPeakCores: 2.5, cpuBusyCores: 1.9 })
    expect(pick([room, room, room]).size).toBe("medium")
    expect(pick([run({ boxSize: "medium", cpuBusyCores: 0.5 }), run({ boxSize: "medium", cpuBusyCores: 0.5 }), run({ boxSize: "medium", cpuBusyCores: 0.5 })]).size).toBe("small")
  })

  it("makes room for the work disk it used", () => {
    // A small box's work disk is 5 GB: 4.5 GB in use × 1.25 doesn't fit.
    expect(pick([run(), run(), run({ diskPeakBytes: 4.5 * GB })])).toMatchObject({ size: "medium", basis: "disk" })
    // ...unless small boxes have reported a bigger disk of their own.
    expect(pickAutoSize([run(), run(), run({ diskPeakBytes: 4.5 * GB })], { maxSize: "large", now, diskTotal: (s) => (s === "small" ? 10 * GB : null) }).size).toBe("small")
  })

  it("goes one size above a box a turn ran out of memory on, from the first such turn", () => {
    const oom = pick([run({ oom: true })])
    expect(oom).toMatchObject({ size: "medium", basis: "out-of-memory", runs: 1 })
    expect(oom.label).toBe("medium (a turn ran out of memory on a smaller box)")
    expect(pick([run(), run(), run({ oom: true })]).label).toBe("medium (peak 1.0 GB over 3 runs; a turn ran out of memory on a smaller box)")
    // On the largest size there's nowhere to go, and the max size holds it.
    expect(pick([run({ boxSize: "large", oom: true })]).size).toBe("large")
    expect(pick([run({ boxSize: "medium", oom: true })], "medium")).toMatchObject({ size: "medium", capped: true })
  })

  it("labels each case", () => {
    expect(autoSizeLabel(null, 0, null, null)).toBe("not measured yet (0 of 3 runs)")
    expect(autoSizeLabel("medium", 12, 5.1 * GB, "memory")).toBe("medium (peak 5.1 GB over 12 runs)")
    expect(autoSizeLabel("large", 4, 2 * GB, "disk")).toBe("large (peak 2.0 GB over 4 runs; for its disk use)")
  })
})

describe("the box probe's out-of-memory count", () => {
  it("reads the cgroup's oom_kill count, and leaves it out without memory.events", () => {
    const base = ["@@boxyard-mem", "memory.current 1073741824", "memory.max 4294967296", "loadavg 0.5 0.4 0.3 1/1 1", "nproc 2"]
    expect(parseMemory([...base, "oom_kill 2"].join("\n"))?.oomKills).toBe(2)
    expect(parseMemory(base.join("\n"))?.oomKills).toBeUndefined()
  })
})
