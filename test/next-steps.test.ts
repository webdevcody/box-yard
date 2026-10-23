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

  it("keeps a mid-reply mention of the marker and still reads the real block at the end", () => {
    const body = "The parser looks for `<!-- boxyard-next-steps` at the end.\n<!-- boxyard-next-steps is the marker -->\nMore text after it."
    const parsed = parseNextSteps(`${body}\n\n<!-- boxyard-next-steps\n["Fix it","Test it"]\n-->\n  \n`)
    expect(parsed).toEqual({ content: body, nextSteps: ["Fix it", "Test it"] })
  })

  it("leaves a reply untouched when it mentions the marker but has no real block", () => {
    const text = "Replies end with a `<!-- boxyard-next-steps [...] -->` comment.\n\nHere is the rest of the briefing, which must survive."
    expect(parseNextSteps(text)).toEqual({ content: text, nextSteps: [] })
    const tail = "Example:\n<!-- boxyard-next-steps\n[\"a\"]\n-->\nAnd the reply keeps going."
    expect(parseNextSteps(tail)).toEqual({ content: tail, nextSteps: [] })
  })

  it("only counts the last of several blocks", () => {
    const parsed = parseNextSteps(`Intro.\n<!-- boxyard-next-steps\n["Old"]\n-->\nMiddle.\n<!-- boxyard-next-steps\n["New one","New two"]\n-->`)
    expect(parsed).toEqual({ content: `Intro.\n<!-- boxyard-next-steps\n["Old"]\n-->\nMiddle.`, nextSteps: ["New one", "New two"] })
  })

  it("does not treat a marker mention inside the final line as a block", () => {
    const text = "Done. See <!-- boxyard-next-steps [\"x\"] -->"
    expect(parseNextSteps(text)).toEqual({ content: text, nextSteps: [] })
  })

  it("strips a malformed JSON block without inventing suggestions", () => {
    const parsed = parseNextSteps(`Done.\n\n<!-- boxyard-next-steps\n["Review it", "Run tests"\n-->`)
    expect(parsed).toEqual({ content: "Done.", nextSteps: [] })
  })

  it("returns the reply as-is when there is no block", () => {
    expect(parseNextSteps("Just a normal reply.\n")).toEqual({ content: "Just a normal reply.\n", nextSteps: [] })
    expect(parseNextSteps("")).toEqual({ content: "", nextSteps: [] })
  })

  it("accepts a single-line block on its own line", () => {
    expect(parseNextSteps(`Done.\n<!-- boxyard-next-steps ["A","B"] -->`)).toEqual({ content: "Done.", nextSteps: ["A", "B"] })
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
