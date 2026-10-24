import { describe, expect, it } from "vitest"
import { titleFromPrompt } from "../shared/taskTitle"

describe("titleFromPrompt", () => {
  it("uses the first line with text, without markdown markers", () => {
    expect(titleFromPrompt("\n\n  ## Add a **dark mode** toggle\nMore detail here")).toBe("Add a dark mode toggle")
    expect(titleFromPrompt("- [x] fix `npm ci`")).toBe("[x] fix npm ci")
    expect(titleFromPrompt("1. Ship it")).toBe("Ship it")
  })

  it("cuts long lines at a word with an ellipsis", () => {
    const title = titleFromPrompt("Make the yard page load faster when there are thousands of tasks, especially on phones over slow networks")
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title).toBe("Make the yard page load faster when there are thousands of tasks…")
  })

  it("never comes back empty", () => {
    expect(titleFromPrompt("   \n ")).toBe("New task")
    expect(titleFromPrompt("x".repeat(200)).length).toBe(72)
  })
})
