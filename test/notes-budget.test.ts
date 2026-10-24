import { describe, expect, it } from "vitest"
import { budgetLine, budgetNotes, estimateTokens, noteAuthorLabel, noteTokens, pruneAdvice, shortTokens } from "../shared/notes.js"
import { captainPrompt, firstTurnPrompt, workerSystemPrompt } from "../server/prompts.js"
import type { Project } from "../shared/types.js"

const note = (i: number, content = `rule ${i}`) => ({ id: `note_${i}`, author: "captain", content })

describe("notes budget", () => {
  it("passes every note through while they fit", () => {
    const notes = [note(1), note(2), note(3)]
    const r = budgetNotes(notes, { maxNotes: 3, maxTokens: 1000 })
    expect(r).toMatchObject({ count: 3, over: false, hidden: [] })
    expect(r.shown).toBe(notes)
    expect(r.tokens).toBe(notes.reduce((n, x) => n + noteTokens(x), 0))
  })

  it("over the note cap, keeps the newest and reports the rest as hidden", () => {
    const notes = [1, 2, 3, 4, 5].map((i) => note(i))
    const r = budgetNotes(notes, { maxNotes: 3, maxTokens: 1000 })
    expect(r.over).toBe(true)
    expect(r.shown.map((n) => n.id)).toEqual(["note_3", "note_4", "note_5"])
    expect(r.hidden.map((n) => n.id)).toEqual(["note_1", "note_2"])
  })

  it("over the token cap, skips a note that doesn't fit and keeps older ones that do", () => {
    const big = note(3, "x".repeat(400)) // ~100 tokens
    const notes = [note(1), note(2), big, note(4)]
    const r = budgetNotes(notes, { maxNotes: 25, maxTokens: 30 })
    expect(r.over).toBe(true)
    expect(r.shown.map((n) => n.id)).toEqual(["note_1", "note_2", "note_4"])
    expect(r.hidden.map((n) => n.id)).toEqual(["note_3"])
    expect(r.shown.reduce((n, x) => n + noteTokens(x), 0)).toBeLessThanOrEqual(30)
  })

  it("says where the notes stand and what to prune, never cutting silently", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(shortTokens(950)).toBe("950")
    expect(shortTokens(2940)).toBe("2.9k")
    expect(shortTokens(12_400)).toBe("12k")
    const r = budgetNotes([1, 2, 3].map((i) => note(i)), { maxNotes: 2, maxTokens: 4000 })
    expect(budgetLine(r)).toMatch(/^3 of 2 notes, ~\d+ of 4k tokens$/)
    const advice = pruneAdvice(r)
    expect(advice).toContain("over budget (3 of 2 notes")
    expect(advice).toContain("1 note is left out of their prompts")
    expect(advice).toMatch(/list_notes, update_note, delete_note/)
    expect(advice).toContain("AGENTS.md")
  })

  it("names the Captain and the Coordinator on the Notes tab", () => {
    expect(noteAuthorLabel("captain")).toBe("Captain")
    expect(noteAuthorLabel("orchestrator")).toBe("Coordinator")
    expect(noteAuthorLabel("Ana")).toBe("Ana")
  })
})

describe("notes in prompts", () => {
  const project = { id: "prj_1", name: "site", description: "", repo: "acme/site", baseBranch: "main", envKeys: [], notes: [], pendingSuggestions: 0, boxSize: null, partialClone: null, createdAt: 0, updatedAt: 0 } satisfies Project

  it("the first prompt lists the budgeted notes and says how many were left out", () => {
    const r = budgetNotes([1, 2, 3].map((i) => note(i)), { maxNotes: 2, maxTokens: 4000 })
    const text = firstTurnPrompt({ task: { title: "T", prompt: "p" }, notes: r.shown, hiddenNotes: r.hidden.length, directory: [], extraInputs: [] })
    expect(text).toContain("## Project notes (lasting rules from Cody and the project's Captain)")
    expect(text).not.toContain("rule 1")
    expect(text).toContain("- (captain) rule 2\n- (captain) rule 3")
    expect(text).toContain("1 older note doesn't fit the notes budget and isn't shown here; read_notes lists every note.")
    expect(firstTurnPrompt({ task: { title: "T", prompt: "p" }, notes: [], directory: [], extraInputs: [] })).not.toContain("Project notes")
  })

  it("workers suggest notes, and are told what a note is for", () => {
    const text = workerSystemPrompt({ project, task: { id: "task_1", title: "T" }, branch: "b", port: 4000 })
    expect(text).toContain("suggest_note")
    expect(text).toContain("with why")
    expect(text).toContain("Run logs, merge reports and code tours go in the PR description instead.")
    expect(text).not.toMatch(/save_note/)
  })

  it("the Captain's prompt explains the note rules, the retro and the budget", () => {
    const text = captainPrompt(project, "Ana", { maxNotes: 12, maxTokens: 3000 })
    expect(text).toContain("budget is 12 notes or about 3k tokens")
    expect(text).toMatch(/list_notes, add_note, update_note, delete_note, list_note_suggestions and resolve_suggestion/)
    expect(text).toContain("Notes retro")
    expect(text).toContain("AGENTS.md")
    expect(text).toContain("(no update)")
    expect(text).toContain("Ana's decisions and preferences")
    expect(text).not.toMatch(/save_note/)
  })
})
