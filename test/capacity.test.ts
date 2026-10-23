import { describe, expect, it } from "vitest"
import { SIZE_DEFAULTS } from "../shared/types"
import { LEGACY_POOL_DEFAULTS, capacityNotice, capacityNoticeText, showCapacityNotice, sizeCapacities } from "../web/src/lib/capacity"

describe("sizeCapacities", () => {
  it("shows each size's defaults when nothing is overridden", () => {
    const rows = sizeCapacities({ workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 3 }, { slotsPerBox: "default", maxResidentPerBox: "default" })
    expect(rows.map((r) => [r.size, r.slotsPerBox, r.maxResidentPerBox, r.current])).toEqual([
      ["small", 1, 3, true],
      ["medium", 2, 8, false],
      ["large", 4, 18, false],
    ])
    for (const r of rows) expect(r.defaults).toEqual(SIZE_DEFAULTS[r.size])
  })

  it("applies a saved or env override to every size", () => {
    const rows = sizeCapacities({ workerSize: "medium", slotsPerBox: 2, maxResidentPerBox: 12 }, { slotsPerBox: "env", maxResidentPerBox: "ui" })
    expect(rows.map((r) => [r.slotsPerBox, r.maxResidentPerBox])).toEqual([
      [2, 12],
      [2, 12],
      [2, 12],
    ])
    expect(rows.every((r) => r.slotsOverridden && r.residentOverridden)).toBe(true)
    expect(rows.find((r) => r.current)?.size).toBe("medium")
  })

  it("treats an unsaved edit as an override, one field at a time", () => {
    const rows = sizeCapacities({ workerSize: "small", slotsPerBox: 3, maxResidentPerBox: 3 }, { slotsPerBox: "default", maxResidentPerBox: "default" }, { slotsPerBox: true })
    expect(rows.map((r) => [r.slotsPerBox, r.maxResidentPerBox])).toEqual([
      [3, 3],
      [3, 8],
      [3, 18],
    ])
  })
})

describe("capacity notice", () => {
  it("appears for the small-box defaults, which are below the old 2 slots / 12 resident", () => {
    const n = capacityNotice({ workerSize: "small", ...SIZE_DEFAULTS.small })
    expect(n).toMatchObject({ slotsPerBox: { now: 1, was: 2 }, maxResidentPerBox: { now: 3, was: 12 }, workerSize: "small" })
    expect(capacityNoticeText(n!)).toBe("1 agent per box (was 2) and 3 resident task folders per box (was 12)")
  })

  it("mentions only the limit that dropped", () => {
    const n = capacityNotice({ workerSize: "medium", ...SIZE_DEFAULTS.medium })
    expect(n?.slotsPerBox).toBeNull()
    expect(capacityNoticeText(n!)).toBe("8 resident task folders per box (was 12)")
  })

  it("stays hidden at or above the old defaults", () => {
    expect(capacityNotice({ workerSize: "small", ...LEGACY_POOL_DEFAULTS })).toBeNull()
    expect(capacityNotice({ workerSize: "large", ...SIZE_DEFAULTS.large })).toBeNull()
  })

  it("is one-time: any dismissal hides it", () => {
    const n = capacityNotice({ workerSize: "small", ...SIZE_DEFAULTS.small })
    expect(showCapacityNotice(n, null)).toBe(true)
    expect(showCapacityNotice(n, n!.key)).toBe(false)
    expect(showCapacityNotice(capacityNotice({ workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 5 }), n!.key)).toBe(false)
    expect(showCapacityNotice(null, null)).toBe(false)
  })
})
