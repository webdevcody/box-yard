import { afterEach, describe, expect, it } from "vitest"
import { announceCleanup, cleanupLine, cleanupToast, diskMeter, withCleanup } from "../web/src/lib/diskCleanup"
import { currentToasts, dismiss } from "../web/src/lib/toast"
import { CLEANUP_STEPS } from "../shared/disk"
import type { BoxCleanup, BoxInfo } from "../shared/types"

const MB = 1024 * 1024
const GB = 1024 * MB

const cleanup = (over: Partial<BoxCleanup> = {}): BoxCleanup => ({
  boxId: "pleasing-shepherd-27426",
  reason: "low-disk",
  status: "done",
  startedAt: 1,
  finishedAt: 2,
  targetFreeBytes: GB,
  freeBefore: 240 * MB,
  freeAfter: 1.5 * GB,
  totalBytes: 5 * GB,
  freedBytes: 1.25 * GB,
  steps: CLEANUP_STEPS.map((s) => ({ key: s.key, label: s.label, freedBytes: 0, removed: [], skipped: null })).map((s) =>
    s.key === "caches" ? { ...s, freedBytes: 800 * MB } : s.key === "builds" ? { ...s, freedBytes: 480 * MB } : s,
  ),
  enough: true,
  error: null,
  ...over,
})

afterEach(() => {
  for (const t of currentToasts()) dismiss(t.id)
})

describe("disk meter", () => {
  it("shows free of total and how full the disk is", () => {
    const m = diskMeter({ diskFreeBytes: 239 * MB, diskTotalBytes: 5 * GB, diskLow: false })!
    expect(m.label).toBe("239 MB free of 5.0 GB")
    expect(m.usedRatio).toBeCloseTo(1 - 239 / 5120, 3)
    // Under a tenth of the disk free reads as low even before the server says so.
    expect(m.low).toBe(true)
  })

  it("follows the server's low flag", () => {
    expect(diskMeter({ diskFreeBytes: 3 * GB, diskTotalBytes: 5 * GB, diskLow: false })!.low).toBe(false)
    expect(diskMeter({ diskFreeBytes: 3 * GB, diskTotalBytes: 5 * GB, diskLow: true })!.low).toBe(true)
  })

  it("is null before the first df", () => {
    expect(diskMeter({ diskFreeBytes: null, diskTotalBytes: null, diskLow: false })).toBeNull()
  })
})

describe("cleanup line", () => {
  it("says what a finished cleanup freed, step by step", () => {
    expect(cleanupLine(cleanup())).toBe("Cleaned up because it was low on disk: freed 1.3 GB (caches 800 MB, builds 480 MB)")
    expect(cleanupLine(cleanup({ reason: "manual", targetFreeBytes: null }))).toBe("Cleaned up: freed 1.3 GB (caches 800 MB, builds 480 MB)")
  })

  it("says when it couldn't free enough", () => {
    expect(cleanupLine(cleanup({ enough: false, freedBytes: 0, steps: [] }))).toBe("Cleaned up because it was low on disk: freed nothing; still short of the 1.0 GB new workspaces need")
  })

  it("shows progress while running, and the error when it failed", () => {
    expect(cleanupLine(cleanup({ status: "running", freedBytes: 0, steps: [] }))).toBe("Cleaning up…")
    expect(cleanupLine(cleanup({ status: "running", freedBytes: 171 * MB, steps: cleanup().steps.slice(0, 1) }))).toBe("Cleaning up: freed 171 MB so far (1 of 5 steps)")
    expect(cleanupLine(cleanup({ status: "failed", error: "box not responding" }))).toBe("Cleanup failed: box not responding")
  })
})

describe("cleanup toasts", () => {
  it("toasts how much a finished cleanup freed", () => {
    announceCleanup(cleanup())
    const [t] = currentToasts()
    expect(t).toMatchObject({ kind: "info", title: "Cleaned up pleasing-shepherd-27426", body: "Freed 1.3 GB (caches 800 MB, builds 480 MB). 1.5 GB free now." })
  })

  it("warns when the box is still low", () => {
    expect(cleanupToast(cleanup({ enough: false }))).toMatchObject({ kind: "error", body: expect.stringContaining("Still low") })
  })

  it("stays quiet while running", () => {
    announceCleanup(cleanup({ status: "running" }))
    expect(currentToasts()).toHaveLength(0)
  })
})

describe("withCleanup", () => {
  it("replaces one box's cleanup and leaves other lists alone", () => {
    const list = [{ id: "a", cleanup: null }, { id: "pleasing-shepherd-27426", cleanup: null }] as unknown as BoxInfo[]
    const next = withCleanup(list, cleanup())!
    expect(next[1]!.cleanup?.freedBytes).toBe(1.25 * GB)
    expect(next[0]).toBe(list[0])
    expect(withCleanup(list, cleanup({ boxId: "other" }))).toBe(list)
    expect(withCleanup(undefined, cleanup())).toBeUndefined()
  })
})

describe("clear box report", () => {
  const cleared = (over: Partial<BoxCleanup> = {}) =>
    cleanup({
      reason: "clear",
      targetFreeBytes: null,
      steps: [
        { key: "archive", label: "Archive every workspace, then remove it from the box", freedBytes: 1.25 * GB, removed: ["task_a", "task_b"], skipped: null },
        { key: "git", label: "Repo mirrors", freedBytes: 0, removed: [], skipped: null },
      ],
      ...over,
    })

  it("says how many workspaces were archived and what it freed", () => {
    expect(cleanupLine(cleared())).toBe("Cleared: archived and removed 2 workspaces, freed 1.3 GB (archive 1.3 GB)")
    expect(cleanupToast(cleared())).toEqual({ kind: "info", title: "Cleared pleasing-shepherd-27426", body: "Archived and removed 2 workspaces; freed 1.3 GB (archive 1.3 GB). 1.5 GB free now." })
  })

  it("flags workspaces it had to keep, and running and failed clears", () => {
    const kept = cleared({ steps: [{ key: "archive", label: "x", freedBytes: 0, removed: [], skipped: "kept task_a: couldn't archive it" }] })
    expect(cleanupToast(kept)).toMatchObject({ kind: "error", body: "Archived and removed 0 workspaces; freed 1.3 GB. 1.5 GB free now. Kept task_a: couldn't archive it." })
    expect(cleanupLine(cleared({ status: "running", freedBytes: 0 }))).toBe("Clearing…")
    expect(cleanupLine(cleared({ status: "failed", error: "1 agent is running" }))).toBe("Clear failed: 1 agent is running")
  })
})
