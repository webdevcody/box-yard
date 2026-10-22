import { describe, expect, it } from "vitest"
import { primaryAction } from "../web/src/lib/taskActions.js"
import { TASK_STATUSES } from "../shared/types.js"

describe("task header primary action", () => {
  it("is Stop while running, Retry when failed, Mark done when resting, nothing when done", () => {
    const got = Object.fromEntries(TASK_STATUSES.map((s) => [s, primaryAction(s)]))
    expect(got).toEqual({
      queued: "stop",
      starting: "stop",
      working: "stop",
      needs_input: "done",
      waiting: "done",
      idle: "done",
      pr_ready: "done",
      done: null,
      failed: "retry",
    })
  })
})
