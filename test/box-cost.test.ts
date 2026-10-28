import { Box } from "@upstash/box"
import { describe, expect, it, vi } from "vitest"
import type { Config } from "../server/config.js"
import { openDb } from "../server/db.js"
import { UpstashProvider } from "../server/providers/upstash.js"
import { Store, boxCost, boxRowCost, meterTick, type BoxRow } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { tmpDir } from "./helpers.js"

// Upstash bills a box's active CPU (core-hours, measured), not the hours it's up: https://upstash.com/pricing/box,
// https://upstash.com/docs/box/overall/how-it-works. Box Yard reads the box's cgroup CPU counter and the provider's
// own totals (Box.list total_cpu_ns, total_compute_cost_usd), and prices what they grew by.

const H = 3_600_000
const MIN = 60_000
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const rates = () => new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates

function boxIn(store: Store, id: string, createdAt: number) {
  store.upsertBox({ id, provider: "upstash", status: "ready", created_at: createdAt, last_used_at: createdAt, size: "small" })
  return () => store.getBox(id) as BoxRow
}

/** One meter tick, as TaskManager.meterBoxes does it. */
function meter(store: Store, row: BoxRow, rate: number, elapsedMs: number, running: boolean, now: number) {
  const tick = meterTick(row, rate, elapsedMs, running)
  store.recordBoxUsageInterval({ boxId: row.id, provider: row.provider, size: "small", keepAlive: false, startedAt: now - elapsedMs, endedAt: now, activeMs: tick.activeMs, uptimeMs: elapsedMs, source: tick.source, computeUsd: tick.computeUsd })
  store.meterBox(row.id, { ...tick.patch, lastMeteredAt: now })
  return tick
}

describe("boxCost", () => {
  it("prices CPU used, not time up: an idle box costs only its disk", () => {
    const r = rates()
    expect(r.boxActiveCpuHourlyUsd.small).toBe(0.1)
    // 2 cores busy for an hour is 2 CPU hours.
    expect(boxCost({ activeMs: 2 * H, uptimeMs: H, size: "small", keepAlive: false }, r)).toBeCloseTo(0.2, 9)
    expect(boxCost({ activeMs: 0, uptimeMs: 24 * H, size: "large", keepAlive: false }, r)).toBe(0)
    const disk = boxCost({ activeMs: 0, uptimeMs: 30 * 24 * H, diskBytes: 10 * 1024 ** 3, size: "small", keepAlive: false }, r)
    expect(disk).toBeGreaterThan(0.9)
    expect(disk).toBeLessThan(1.1)
  })

  it("charges a keep-alive box only its monthly fee, whatever CPU it used", () => {
    const r = rates()
    const month = 30 * 24 * H
    const fee = boxCost({ activeMs: 100 * H, uptimeMs: month, diskBytes: 50 * 1024 ** 3, size: "medium", keepAlive: true }, r)
    expect(fee).toBeCloseTo(r.boxKeepAliveMonthlyUsd.medium, 9)
    expect(fee).toBeCloseTo(boxCost({ activeMs: 0, uptimeMs: month, size: "medium", keepAlive: true }, r), 9)
  })

  it("adds a provider-priced charge as is", () => {
    expect(boxCost({ activeMs: 0, computeUsd: 0.37, uptimeMs: H, size: "small", keepAlive: false }, rates())).toBeCloseTo(0.37, 9)
  })
})

describe("CPU counters", () => {
  it("counts what the box's cgroup counter grew by, all of a new box's first reading, and a restart from zero", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "b1", t0 - MIN)
    store.accrueBoxCpu("b1", "cgroup", 30e6, t0) // a 1-minute-old box: its 30 CPU seconds so far are its own
    expect(row().pending_cpu_ms).toBe(30_000)
    store.accrueBoxCpu("b1", "cgroup", 90e6, t0)
    expect(row().pending_cpu_ms).toBe(90_000)
    store.accrueBoxCpu("b1", "cgroup", 5e6, t0) // went down: the box restarted
    expect(row().pending_cpu_ms).toBe(95_000)
    expect(row().cgroup_cpu_usec).toBe(5e6)
  })

  it("takes only a baseline from a box that was running before this build", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "old", t0 - 3 * 24 * H)
    store.accrueBoxCpu("old", "cgroup", 9e12, t0) // days of CPU must not land on today
    expect(row().pending_cpu_ms).toBe(0)
    store.accrueBoxCompute("old", 40, t0)
    expect(row().pending_compute_usd).toBe(0)
    store.accrueBoxCpu("old", "cgroup", 9e12 + 2e6, t0)
    store.accrueBoxCompute("old", 40.25, t0)
    expect(row().pending_cpu_ms).toBe(2000)
    expect(row().pending_compute_usd).toBeCloseTo(0.25, 9)
  })

  it("uses the provider's CPU total only while the cgroup hasn't been read", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "b", t0 - 3 * 24 * H)
    store.accrueBoxCpu("b", "provider", 1e12, t0)
    store.accrueBoxCpu("b", "provider", 1e12 + 4e9, t0) // +4 CPU seconds
    expect(row().pending_cpu_ms).toBe(4000)
    store.accrueBoxCpu("b", "cgroup", 7e9, t0)
    store.accrueBoxCpu("b", "provider", 1e12 + 9e9, t0) // the cgroup counts now: this only moves the baseline
    store.accrueBoxCpu("b", "cgroup", 7e9 + 1e6, t0)
    expect(row().pending_cpu_ms).toBe(5000)
    expect(row().provider_cpu_ns).toBe(1e12 + 9e9)
  })
})

describe("meterTick", () => {
  it("prices measured CPU at the size's rate, and an idle box's interval costs no CPU", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "b", t0 - 3 * 24 * H)
    store.accrueBoxCpu("b", "cgroup", 1e9, t0)
    store.accrueBoxCpu("b", "cgroup", 1e9 + 2 * H * 1000, t0) // 2 CPU hours (2 cores for an hour)
    const busy = meter(store, row(), 0.1, H, true, t0 + H)
    expect(busy).toMatchObject({ activeMs: 2 * H, computeUsd: null, source: "measured" })
    expect(row()).toMatchObject({ pending_cpu_ms: 0, active_ms: 2 * H, usage_source: "measured" })
    // Up for another hour with nothing running and no CPU: no compute charge, even though the box was up.
    const idle = meter(store, row(), 0.1, H, false, t0 + 2 * H)
    expect(idle.activeMs).toBe(0)
    const spend = store.boxSpendSince(t0, rates())
    expect(spend.byBox.get("b")?.costUsd).toBeCloseTo(0.2, 6)
    expect(spend.totals.source).toBe("measured")
    expect(boxRowCost(row(), rates(), t0 + 2 * H)).toBeCloseTo(0.2, 6)
  })

  it("falls back to wall-clock time while a turn runs on a box nothing measured", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "b", t0 - H)
    expect(meterTick(row(), 0.1, 20_000, true)).toMatchObject({ activeMs: 20_000, computeUsd: null, source: "estimated" })
    expect(meterTick(row(), 0.1, 20_000, false)).toMatchObject({ activeMs: 0, source: "estimated" })
  })

  it("uses the provider's own charge, but never less than the measured CPU's price", () => {
    const store = memStore()
    const t0 = Date.now()
    const row = boxIn(store, "b", t0 - 3 * 24 * H)
    store.accrueBoxCpu("b", "cgroup", 0, t0)
    store.accrueBoxCompute("b", 10, t0)
    // Upstash charged $0.15 for an hour of CPU we price at $0.10: its figure stands.
    store.accrueBoxCpu("b", "cgroup", H * 1000, t0)
    store.accrueBoxCompute("b", 10.15, t0)
    const first = meter(store, row(), 0.1, H, true, t0 + H)
    expect(first.source).toBe("actual")
    expect(first.computeUsd).toBeCloseTo(0.15, 9)
    // Then its total stops moving (say it leaves some CPU out) while the box uses 2 more CPU hours ($0.20 measured).
    store.accrueBoxCpu("b", "cgroup", 3 * H * 1000, t0)
    store.accrueBoxCompute("b", 10.15, t0)
    const second = meter(store, row(), 0.1, H, true, t0 + 2 * H)
    expect(second.source).toBe("measured")
    // The box has cost max($0.30 measured, $0.15 reported) = $0.30, so this hour adds $0.15.
    expect(second.computeUsd).toBeCloseTo(0.15, 9)
    // Its total catches up to $10.45: $0.15 more on top of the $0.30 already counted.
    store.accrueBoxCompute("b", 10.45, t0)
    const third = meter(store, row(), 0.1, H, false, t0 + 3 * H)
    expect(third.source).toBe("actual")
    expect(third.computeUsd).toBeCloseTo(0.15, 9)
    const total = store.boxSpendSince(t0, rates()).byBox.get("b")!.costUsd
    expect(total).toBeCloseTo(0.45, 6)
    // A change of Settings' rates doesn't reprice what the provider priced.
    const r = rates()
    r.boxActiveCpuHourlyUsd.small = 5
    expect(store.boxSpendSince(t0, r).byBox.get("b")!.costUsd).toBeCloseTo(0.45, 6)
    expect(boxRowCost(row(), r, t0 + 3 * H)).toBeCloseTo(0.45, 6)
  })
})

describe("Upstash usage probe", () => {
  it("reads size, keep-alive, CPU and compute cost from one Box.list for every box", async () => {
    const list = vi.spyOn(Box, "list")
    try {
      list.mockResolvedValue([
        { id: "a", status: "running", size: "medium", keep_alive: false, total_cpu_ns: 7.2e12, total_compute_cost_usd: 0.4 },
        { id: "b", status: "running", size: "small", keep_alive: true, total_cpu_ns: 1e9 },
      ] as unknown as Awaited<ReturnType<typeof Box.list>>)
      const p = new UpstashProvider({ upstashBoxApiKey: "key", githubToken: "", workerSize: "small" } as Config)
      vi.spyOn(p, "exec").mockResolvedValue({ exitCode: 0, stdout: "2048\n", stderr: "" })
      expect(await p.usage("a")).toEqual({ size: "medium", keepAlive: false, diskBytes: 2048 * 1024, cpuNs: 7.2e12, computeUsd: 0.4, source: "actual" })
      expect(await p.usage("b")).toMatchObject({ size: "small", keepAlive: true, cpuNs: 1e9, computeUsd: null, source: "measured" })
      // A box the list doesn't have: nothing measured, its size from Settings.
      expect(await p.usage("c")).toMatchObject({ size: "small", keepAlive: false, cpuNs: null, computeUsd: null, source: "estimated" })
      expect(list).toHaveBeenCalledTimes(1)
      expect(p.ownCgroup).toBe(true)
    } finally {
      list.mockRestore()
    }
  })
})
