import { describe, expect, it } from "vitest"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { buildSelectionTaskPrompt } from "../web/src/lib/selectionTask.js"

describe("next-step parsing", () => {
  it("strips the hidden JSON block and returns up to four suggestions", () => {
    const parsed = parseNextSteps(`Done.\n\n<!-- boxyard-next-steps\n["Review it","Run tests","Open PR","Deploy","Ignore"]\n-->`)
    expect(parsed.content).toBe("Done.")
    expect(parsed.nextSteps).toEqual(["Review it", "Run tests", "Open PR", "Deploy"])
  })

  it("accepts line-based fallback blocks", () => {
    const parsed = parseNextSteps("Done.\n```boxyard-next-steps\n- Follow up\n- Ask for screenshots\n```")
    expect(parsed).toEqual({ content: "Done.", nextSteps: ["Follow up", "Ask for screenshots"] })
  })
})

describe("selection task prompt", () => {
  it("includes project, source task and selected text for orchestrator routing", () => {
    const prompt = buildSelectionTaskPrompt({
      source: {
        kind: "task",
        project: { id: "prj_site", name: "site" },
        task: { id: "task_123", title: "Fix nav", branch: "boxyard/fix-nav", prUrl: "https://github.com/acme/site/pull/4" },
      },
      selectedText: "The nav flickers on mobile.",
      instructions: "Make this a separate investigation.",
    })
    expect(prompt).toContain("create a new task in the relevant project unless an existing task is clearly the better place")
    expect(prompt).toContain("Project: site (prj_site)")
    expect(prompt).toContain("Source task: Fix nav (task_123)")
    expect(prompt).toContain("Source branch: boxyard/fix-nav")
    expect(prompt).toContain("Source pull request: https://github.com/acme/site/pull/4")
    expect(prompt).toContain("> The nav flickers on mobile.")
    expect(prompt).toContain("Make this a separate investigation.")
  })

  it("uses the shared meta key expected by the UI", () => {
    expect(NEXT_STEPS_META_KEY).toBe("nextSteps")
  })
})
