import { describe, expect, it } from "vitest"
import { dateInput, niceTicks, parseDateInput, pct, periodRange, rangeLabel, sortBreakdown, startOfDay } from "../web/src/lib/usage"
import type { UsageBreakdownRow } from "../shared/types"

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()

describe("periodRange", () => {
  const now = at(2026, 10, 23, 14, 30)

  it("starts Today, 7 days and 30 days at a local midnight and runs to now", () => {
    expect(periodRange("today", now)).toEqual({ key: "today", from: at(2026, 10, 23), to: now })
    expect(periodRange("7d", now)).toEqual({ key: "7d", from: at(2026, 10, 17), to: now })
    expect(periodRange("30d", now)).toEqual({ key: "30d", from: at(2026, 9, 24), to: now })
  })

  it("covers whole days for a custom range and stops at now", () => {
    expect(periodRange("custom", now, { from: "2026-10-01", to: "2026-10-05" })).toEqual({ key: "custom", from: at(2026, 10, 1), to: at(2026, 10, 6) })
    expect(periodRange("custom", now, { from: "2026-10-20", to: "2026-10-23" }).to).toBe(now)
    expect(periodRange("custom", now, { from: "2026-10-20" }).to).toBe(now) // no end: through today
  })

  it("falls back to 7 days for a missing or reversed custom range", () => {
    expect(periodRange("custom", now, { from: "nope", to: "2026-10-05" }).from).toBe(at(2026, 10, 17))
    expect(periodRange("custom", now, { from: "2026-10-09", to: "2026-10-05" }).from).toBe(at(2026, 10, 17))
  })

  it("round-trips date inputs and labels ranges", () => {
    expect(dateInput(now)).toBe("2026-10-23")
    expect(parseDateInput("2026-10-23")).toBe(startOfDay(now))
    expect(parseDateInput("10/23/2026")).toBeNull()
    expect(rangeLabel(at(2026, 10, 23), now)).not.toContain("–")
    expect(rangeLabel(at(2026, 10, 17), now)).toContain("–")
  })
})

describe("sortBreakdown", () => {
  const row = (key: string, costUsd: number, turns: number, other = false): UsageBreakdownRow => ({ key, label: key, costUsd, turns, tokens: turns * 10, other })
  const rows = [row("boxes", 50, 0, true), row("a", 10, 1), row("b", 30, 10), row("coordinator", 99, 5, true), row("c", 20, 2)]

  it("sorts real rows and keeps other rows at the bottom, largest first", () => {
    expect(sortBreakdown(rows, "cost", "desc").map((r) => r.key)).toEqual(["b", "c", "a", "coordinator", "boxes"])
    expect(sortBreakdown(rows, "cost", "asc").map((r) => r.key)).toEqual(["a", "c", "b", "coordinator", "boxes"])
    expect(sortBreakdown(rows, "name", "asc").map((r) => r.key).slice(0, 3)).toEqual(["a", "b", "c"])
    expect(sortBreakdown(rows, "turns", "desc").map((r) => r.key).slice(0, 3)).toEqual(["b", "c", "a"])
    // Avg per turn: a $10, c $10, b $3. Ties fall back to cost.
    expect(sortBreakdown(rows, "avg", "desc").map((r) => r.key).slice(0, 3)).toEqual(["c", "a", "b"])
  })
})

describe("chart and share helpers", () => {
  it("rounds the axis to clean steps", () => {
    expect(niceTicks(37.4)).toEqual([0, 10, 20, 30, 40])
    expect(niceTicks(4.2)).toEqual([0, 2, 4, 6])
    expect(niceTicks(0)).toEqual([0, 1])
  })

  it("formats percentages", () => {
    expect(pct(1, 3)).toBe("33%")
    expect(pct(0.5, 10)).toBe("5.0%")
    expect(pct(0.0001, 10)).toBe("<0.1%")
    expect(pct(1, 0)).toBe("0%")
  })
})
