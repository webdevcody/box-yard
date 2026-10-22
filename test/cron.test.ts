import { describe, expect, it } from "vitest"
import { describeCron, expandCron, isValidTimeZone, nextRun, nextRuns, parseCron } from "../shared/cron.js"

const utc = (s: string) => Date.parse(s.endsWith("Z") ? s : `${s}Z`)
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString().slice(0, 16))

describe("cron parsing", () => {
  it("reads lists, ranges, steps, names and macros", () => {
    const c = parseCron("*/15 9-17 * jan,jul mon-fri")
    expect([...c.minutes]).toEqual([0, 15, 30, 45])
    expect(c.hours.size).toBe(9)
    expect([...c.months]).toEqual([1, 7])
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0])
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45])
    expect(expandCron("@daily")).toBe("0 0 * * *")
    expect(expandCron("  0   9 * *   1 ")).toBe("0 9 * * 1")
  })
  it("rejects bad expressions with a readable message", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/)
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/)
    expect(() => parseCron("* * * * funday")).toThrow(/weekday/)
    expect(() => parseCron("5-1 * * * *")).toThrow(/backwards/)
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/)
  })
  it("validates time zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true)
    expect(isValidTimeZone("Mars/Olympus")).toBe(false)
  })
})

describe("next run", () => {
  it("is strictly after the given time", () => {
    expect(iso(nextRun("*/15 * * * *", utc("2026-10-22T13:00")))).toBe("2026-10-22T13:15")
    expect(iso(nextRun("*/15 * * * *", utc("2026-10-22T13:07:30")))).toBe("2026-10-22T13:15")
    expect(iso(nextRun("0 9 * * *", utc("2026-10-22T09:00")))).toBe("2026-10-23T09:00")
  })
  it("respects the time zone, across a DST change", () => {
    // 9:00 New York is 13:00 UTC in October (EDT) and 14:00 UTC in November (EST).
    expect(iso(nextRun("0 9 * * *", utc("2026-10-22T12:00"), "America/New_York"))).toBe("2026-10-22T13:00")
    expect(iso(nextRun("0 9 * * *", utc("2026-11-02T00:00"), "America/New_York"))).toBe("2026-11-02T14:00")
    // A half-hour offset zone.
    expect(iso(nextRun("0 9 * * *", utc("2026-10-22T00:00"), "Asia/Kolkata"))).toBe("2026-10-22T03:30")
  })
  it("matches day-of-month OR day-of-week when both are set (like cron)", () => {
    // The 1st of the month, or any Monday. 2026-10-26 is a Monday.
    const runs = nextRuns("0 0 1 * 1", utc("2026-10-22T00:00"), "UTC", 3).map(iso)
    expect(runs).toEqual(["2026-10-26T00:00", "2026-11-01T00:00", "2026-11-02T00:00"])
  })
  it("handles weekdays, months and leap days", () => {
    // 2026-10-24 is a Saturday, so the next weekday 9:00 is Monday the 26th.
    expect(iso(nextRun("0 9 * * 1-5", utc("2026-10-23T10:00")))).toBe("2026-10-26T09:00")
    expect(iso(nextRun("@yearly", utc("2026-10-22T00:00")))).toBe("2027-01-01T00:00")
    expect(iso(nextRun("0 0 29 2 *", utc("2026-10-22T00:00")))).toBe("2028-02-29T00:00")
    expect(nextRun("0 0 30 2 *", utc("2026-10-22T00:00"))).toBeNull()
  })
})

describe("describeCron", () => {
  it("reads the common shapes", () => {
    expect(describeCron("* * * * *")).toBe("Every minute")
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes")
    expect(describeCron("@hourly")).toBe("Every hour")
    expect(describeCron("30 * * * *")).toBe("Every hour at :30")
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00")
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00")
    expect(describeCron("0 10 * * 1")).toBe("Every Monday at 10:00")
    expect(describeCron("0 8 1 * *")).toBe("Monthly on day 1 at 08:00")
    expect(describeCron("0 9,17 * * *")).toBe("0 9,17 * * *")
  })
})
