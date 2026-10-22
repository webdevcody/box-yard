import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deferClose, flushCloses, inInbox, undoClose } from "../web/src/lib/inbox.js"
import type { Task, TaskStatus } from "../shared/types.js"

const task = (id: string, status: TaskStatus) => ({ id, status }) as Task

describe("inbox mark done", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("only needs_input, pr_ready and failed tasks are in the inbox", () => {
    expect(inInbox(task("a", "pr_ready"), new Set())).toBe(true)
    expect(inInbox(task("a", "needs_input"), new Set())).toBe(true)
    expect(inInbox(task("a", "failed"), new Set())).toBe(true)
    expect(inInbox(task("a", "done"), new Set())).toBe(false)
    expect(inInbox(task("a", "working"), new Set())).toBe(false)
    expect(inInbox(task("a", "pr_ready"), new Set(["a"]))).toBe(false)
  })

  it("hides the card at once and closes the task after the undo window", async () => {
    const commit = vi.fn(() => Promise.resolve())
    expect(deferClose("t1", commit, 5000)).toBe(true)
    expect(inInbox(task("t1", "pr_ready"))).toBe(false)
    expect(deferClose("t1", commit, 5000)).toBe(false)
    vi.advanceTimersByTime(4999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledOnce()
    expect(undoClose("t1")).toBe(false)
    await vi.runAllTimersAsync()
    // Released once the close has landed; the task is done by then.
    expect(inInbox(task("t1", "pr_ready"))).toBe(true)
    expect(inInbox(task("t1", "done"))).toBe(false)
  })

  it("undo puts the card back and never closes the task", () => {
    const commit = vi.fn(() => Promise.resolve())
    deferClose("t2", commit, 5000)
    expect(undoClose("t2")).toBe(true)
    expect(inInbox(task("t2", "pr_ready"))).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(commit).not.toHaveBeenCalled()
  })

  it("brings the card back if the close fails", async () => {
    deferClose("t3", () => Promise.reject(new Error("nope")), 5000)
    expect(inInbox(task("t3", "failed"))).toBe(false)
    await vi.runAllTimersAsync()
    expect(inInbox(task("t3", "failed"))).toBe(true)
  })

  it("flush sends pending closes right away (page hide)", () => {
    const commit = vi.fn(() => Promise.resolve())
    deferClose("t4", commit, 5000)
    deferClose("t5", commit, 5000)
    const send = vi.fn()
    flushCloses(send)
    expect(send.mock.calls.map((c) => c[0])).toEqual(["t4", "t5"])
    vi.advanceTimersByTime(10_000)
    expect(commit).not.toHaveBeenCalled()
  })
})
