import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { DEFAULT_SETTINGS, SettingsStore } from "../server/settings.js"
import { BOX_SIZE_SPECS, compareSizes, resizeSummary, scaleDownFit, sizeSpecLine, workDiskBytes, type BoxResize } from "../shared/boxSizes.js"
import { defaultTarget, direction, fitLine, resizeSteps, resizeToast, sizeRows, withResize } from "../web/src/lib/boxResize"
import { currentToasts, dismiss, toast } from "../web/src/lib/toast"
import { boxBusyReason } from "../web/src/lib/boxOverview"
import { planToast, notificationHref } from "../web/src/lib/notifications"
import type { AppNotification, BoxInfo } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const GB = 1024 ** 3
const MB = 1024 ** 2

describe("the shared size table", () => {
  it("has Upstash's numbers and orders sizes", () => {
    expect(BOX_SIZE_SPECS.medium).toMatchObject({ cpu: 4, ramGb: 8, storageGb: 20, activeCpuHourlyUsd: 0.2 })
    expect(sizeSpecLine("large")).toBe("8 vCPU · 16 GB RAM · 30 GB disk")
    expect([compareSizes("small", "large"), compareSizes("large", "medium"), compareSizes("medium", "medium")]).toEqual([-1, 1, 0])
    // Settings' cost rates default to the same table.
    expect(DEFAULT_SETTINGS.costRates.boxActiveCpuHourlyUsd).toEqual({ small: 0.1, medium: 0.2, large: 0.4 })
    expect(DEFAULT_SETTINGS.costRates.boxKeepAliveMonthlyUsd).toEqual({ small: 8, medium: 16, large: 32 })
  })

  it("uses a size's reported work disk over the estimate", () => {
    expect(workDiskBytes("small")).toBe(5 * GB)
    expect(workDiskBytes("small", 4.8 * GB)).toBe(4.8 * GB)
  })
})

describe("scaleDownFit", () => {
  it("fits when what's in use plus the headroom fits the smaller work disk", () => {
    expect(scaleDownFit({ usedBytes: 3 * GB, to: "small", headroomBytes: 1 * GB })).toMatchObject({ ok: true, capacityBytes: 5 * GB, reason: null })
    expect(scaleDownFit({ usedBytes: 4.5 * GB, to: "small", headroomBytes: 1 * GB })).toMatchObject({ ok: false })
    expect(scaleDownFit({ usedBytes: 4.5 * GB, to: "small", headroomBytes: 1 * GB }).reason).toContain("it wouldn't fit")
    // A box of that size reported a bigger disk than the estimate.
    expect(scaleDownFit({ usedBytes: 4.5 * GB, to: "small", headroomBytes: 1 * GB, observedTotalBytes: 6 * GB }).ok).toBe(true)
  })

  it("refuses when disk use hasn't been measured", () => {
    const f = scaleDownFit({ usedBytes: null, to: "small", headroomBytes: 0 })
    expect(f.ok).toBe(false)
    expect(f.reason).toContain("hasn't been measured")
  })
})

describe("per-box limits", () => {
  const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
  afterEach(() => {
    delete process.env.BOX_SLOTS
  })

  it("leaves agents and folders per box to each box's size unless set on purpose", () => {
    const store = memStore()
    const small = new SettingsStore(store, { workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 3 })
    expect(small.boxLimitOverrides()).toEqual({ slotsPerBox: null, maxResidentPerBox: null })
    // A saved worker size isn't an override either: medium boxes get 2, small ones 1.
    small.update({ workerSize: "medium" })
    expect(small.boxLimitOverrides()).toEqual({ slotsPerBox: null, maxResidentPerBox: null })
    small.update({ slotsPerBox: 3 })
    expect(small.boxLimitOverrides()).toEqual({ slotsPerBox: 3, maxResidentPerBox: null })
  })

  it("counts BOX_SLOTS and a non-default config value as overrides", () => {
    expect(new SettingsStore(memStore(), { workerSize: "small", slotsPerBox: 2, maxResidentPerBox: 3 }).boxLimitOverrides().slotsPerBox).toBe(2)
    process.env.BOX_SLOTS = "1"
    expect(new SettingsStore(memStore(), { workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 3 }).boxLimitOverrides().slotsPerBox).toBe(1)
  })

  it("defaults the resize guardrails to allowed, up to large", () => {
    const s = new SettingsStore(memStore(), {})
    expect(s.get()).toMatchObject({ autoResizeEnabled: true, autoResizeMaxSize: "large" })
    expect(s.update({ autoResizeEnabled: false, autoResizeMaxSize: "medium" }).settings).toMatchObject({ autoResizeEnabled: false, autoResizeMaxSize: "medium" })
    expect(() => s.update({ autoResizeMaxSize: "huge" })).toThrow()
  })
})

const report = (patch: Partial<BoxResize> = {}): BoxResize => ({
  id: "rsz_1",
  boxId: "pleasing-shepherd-27426",
  newBoxId: null,
  from: "small",
  to: "medium",
  mode: "migration",
  status: "running",
  steps: [
    { key: "create", label: "Create a medium box", status: "done", detail: "brave-otter-1" },
    { key: "archive", label: "Archive every workspace", status: "running", detail: null },
    { key: "move", label: "Move tasks and projects to the new box", status: "pending", detail: null },
    { key: "delete", label: "Delete pleasing-shepherd-27426", status: "pending", detail: null },
  ],
  movedTasks: [],
  by: { kind: "cody" },
  reason: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  ...patch,
})

describe("Resize modal helpers", () => {
  it("lists every size with current and target marked", () => {
    const rows = sizeRows("small", "medium")
    expect(rows.map((r) => [r.size, r.cpu, r.ram, r.disk, r.price, r.slots, r.current, r.target])).toEqual([
      ["small", "2 vCPU", "4 GB", "10 GB", "$0.10/h", 1, true, false],
      ["medium", "4 vCPU", "8 GB", "20 GB", "$0.20/h", 2, false, true],
      ["large", "8 vCPU", "16 GB", "30 GB", "$0.40/h", 4, false, false],
    ])
    expect([defaultTarget("small"), defaultTarget("medium"), defaultTarget("large")]).toEqual(["medium", "large", "medium"])
    expect([direction("small", "large"), direction("large", "small"), direction("small", "small")]).toEqual(["up", "down", "same"])
  })

  it("says what happens for each mode", () => {
    expect(resizeSteps("in-place", { id: "b1" }, "large", 2)[0]).toBe("Changes b1 to large in place. Its workspaces stay where they are.")
    const steps = resizeSteps("migration", { id: "b1" }, "medium", 3)
    expect(steps[0]).toContain("Creates a new medium box")
    expect(steps[2]).toBe("Moves 3 tasks to the new box, then deletes b1. Each workspace comes back from its archive on the task's next message.")
  })

  it("explains the disk fit", () => {
    expect(fitLine({ to: "small", fit: { ok: true, usedBytes: 2 * GB, capacityBytes: 5 * GB, headroomBytes: 1024 * MB, reason: null } })).toBe(
      "Fits: 2.0 GB in use; a small box has about 5.0 GB, and 1.0 GB stays free for new workspaces.",
    )
    expect(fitLine({ to: "small", fit: null })).toBeNull()
  })
})

describe("resize toasts", () => {
  afterEach(() => {
    for (const t of currentToasts()) dismiss(t.id)
    vi.useRealTimers()
  })

  it("shows progress as one toast that updates, then settles with the result", () => {
    vi.useFakeTimers()
    expect(resizeToast(report())).toEqual({ kind: "progress", title: "Resizing pleasing-shepherd-27426: small → medium", body: "Archive every workspace… (2 of 4)" })
    toast.progress("resize:rsz_1", "Resizing", "step 1")
    toast.progress("resize:rsz_1", "Resizing", "step 2")
    expect(currentToasts().map((t) => [t.body, t.progress])).toEqual([["step 2", true]])
    vi.advanceTimersByTime(60_000)
    expect(currentToasts()).toHaveLength(1)
    const done = report({ status: "done", newBoxId: "brave-otter-1", movedTasks: ["task_a", "task_b"], by: { kind: "coordinator" }, reason: "Low on disk" })
    const t = resizeToast(done)
    expect(t).toEqual({
      kind: "info",
      title: "Resized pleasing-shepherd-27426: small → medium",
      body: "The Coordinator: Low on disk. Moved to brave-otter-1 (medium); 2 tasks restore from their archive on the next message.",
    })
    toast.settle("resize:rsz_1", "info", t.title, t.body)
    expect(currentToasts().map((x) => [x.title, x.progress])).toEqual([[t.title, undefined]])
    vi.advanceTimersByTime(9000)
    expect(currentToasts()).toHaveLength(0)
  })

  it("puts the report on the old and new box, and the busy reason while it runs", () => {
    const box = { id: "pleasing-shepherd-27426", operation: null, resize: null, cleanup: null } as unknown as BoxInfo
    const [b] = withResize([box], report())!
    expect(b).toMatchObject({ operation: "resize", resize: { id: "rsz_1" } })
    expect(boxBusyReason(b!)).toBe("This box is being resized")
    const [after] = withResize([b!], report({ status: "done" }))!
    expect(after!.operation).toBeNull()
    expect(withResize([box], report({ boxId: "other" }))).toEqual([box])
    expect(resizeSummary(report({ status: "failed", error: "nope" }))).toBe("nope")
  })
})

describe("box notifications", () => {
  it("link to the box and don't group with tasks", () => {
    const n = (patch: Partial<AppNotification>): AppNotification => ({ id: "ntf_1", taskId: null, projectId: "", title: "Resized b1", projectName: "", status: "done", summary: null, createdAt: 1, readAt: null, ...patch })
    expect(notificationHref(n({ href: "/boxes#b2" }))).toBe("/boxes#b2")
    expect(notificationHref(n({ taskId: "task_1" }))).toBe("/tasks/task_1")
    const plan = planToast([n({ id: "a", href: "/boxes#b1" }), n({ id: "b", href: "/boxes#b2", createdAt: 2 })], null)
    expect(plan?.kind).toBe("batch")
  })
})
