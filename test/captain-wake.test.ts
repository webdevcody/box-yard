import { describe, expect, it } from "vitest"
import { FYI_MARKER, captainReplyWakes, mustWake, takeFyiMarker } from "../server/captainWake.js"
import { captainPrompt } from "../server/prompts.js"
import type { Project } from "../shared/types.js"

describe("takeFyiMarker", () => {
  it("strips the hidden line and says it was there", () => {
    expect(takeFyiMarker(`All 3 tasks are working.\n\n${FYI_MARKER}`)).toEqual({ text: "All 3 tasks are working.", fyi: true })
    expect(takeFyiMarker("All 3 tasks are working.\n<!--boxyard-coordinator:FYI-->\n")).toEqual({ text: "All 3 tasks are working.", fyi: true })
  })

  it("keeps a next-steps block after it for the chips", () => {
    const r = takeFyiMarker(`Started task X.\n\n${FYI_MARKER}\n\n<!-- boxyard-next-steps\n["Check it"]\n-->`)
    expect(r.fyi).toBe(true)
    expect(r.text).toBe('Started task X.\n\n<!-- boxyard-next-steps\n["Check it"]\n-->')
  })

  it("leaves text without the marker alone", () => {
    expect(takeFyiMarker("  Done.\n")).toEqual({ text: "  Done.\n", fyi: false })
  })
})

describe("mustWake", () => {
  it("lets a plain status through", () => {
    expect(mustWake("[Fix the login bug](/tasks/task_abc123) is working; PR #12 is open and merged into main.")).toBeNull()
    expect(mustWake("Started 3 tasks: see https://github.com/acme/app/pull/12?tab=files and `fix-error-page`.")).toBeNull()
  })

  it("wakes on a question, a failure or a decision", () => {
    expect(mustWake("Should it go out today?")).toMatch(/asks/)
    expect(mustWake("The build failed on the deploy step.")).toMatch(/failure/)
    expect(mustWake("Task X is stuck on a merge conflict.")).toMatch(/failure/)
    expect(mustWake("It couldn't push the branch.")).toMatch(/failure/)
    expect(mustWake("PR #3 is ready and waiting for your approval.")).toMatch(/decision/)
    expect(mustWake("Cody needs to pick a name.")).toMatch(/Cody/)
  })

  it("reads the owner's name", () => {
    expect(mustWake("Sam has to pick a name.", "Sam")).toMatch(/Sam/)
    expect(mustWake("Sam's demo is live.", "Sam")).toBeNull()
  })
})

describe("captainReplyWakes", () => {
  const fyi = { ok: true, text: "Task X is working.", fyi: true }
  it("skips the wake only for an FYI reply nothing else needs", () => {
    expect(captainReplyWakes(fyi)).toEqual({ wake: false, why: "FYI" })
  })

  it("wakes when unsure", () => {
    expect(captainReplyWakes({ ...fyi, fyi: false }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, ok: false }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, coordinatorWaits: true }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, text: "Task X failed." }).wake).toBe(true)
  })
})

describe("the Captain's prompt", () => {
  it("says how to mark an FYI reply", () => {
    const project = { id: "prj_demo01", name: "demo", repo: null, baseBranch: "main", description: "" } as unknown as Project
    expect(captainPrompt(project)).toContain(FYI_MARKER)
  })
})
