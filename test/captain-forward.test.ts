import { describe, expect, it } from "vitest"
import { looksLikeTaskManagement, offersCaptain } from "../web/src/lib/captainForward.js"
import { forwardedFromTask } from "../shared/captain.js"
import { workerSystemPrompt } from "../server/prompts.js"
import type { Project } from "../shared/types.js"

describe("looksLikeTaskManagement (the task chat's 'send this to the Captain?')", () => {
  it.each([
    "split this out into its own task",
    "Can you split off the docs part?",
    "spin the migration off please",
    "break this into two PRs",
    "start a new task for the login bug",
    "make that a separate task",
    "Create a task for the flaky test",
    "move the dark mode item to the other task",
    "hand this over to task_abc123",
    "reprioritise this, the footer matters more",
    "deprioritize the docs work",
    "make it high priority",
    "bump the priority on this",
    "what's queued here?",
    "What is queued for this task",
    "cancel the queued message about colours",
    "clear the queue",
    "edit my queued message",
  ])("yes: %s", (text) => expect(looksLikeTaskManagement(text)).toBe(true))

  it.each([
    "",
    "ok",
    "looks good, ship it",
    "the button text is wrong, fix it",
    "break out of the loop when the list is empty",
    "add a new field to the task form",
    "start the server on port 4000 and take a screenshot",
    "move the button to the left",
    "the priority field in the API is ignored",
    "what does the queue module do?",
    "before you start this task, read the README",
  ])("no: %s", (text) => expect(looksLikeTaskManagement(text)).toBe(false))
})

describe("offersCaptain", () => {
  it("offers the Captain while the task is busy or has queued messages", () => {
    for (const status of ["working", "starting", "queued"] as const) expect(offersCaptain({ status }, 0)).toBe(true)
    expect(offersCaptain({ status: "idle" }, 2)).toBe(true)
    for (const status of ["idle", "done", "needs_input", "failed"] as const) expect(offersCaptain({ status }, 0)).toBe(false)
  })
})

describe("forwardedFromTask", () => {
  it("reads the task and its queue from a Captain message's meta, and nothing from others", () => {
    const queue = [{ id: "in_abc123", sender: "Cody", text: "x" }]
    expect(forwardedFromTask({ source: "cody", viaTask: { taskId: "task_1", taskTitle: "T", queue } })).toEqual({ taskId: "task_1", taskTitle: "T", queue })
    expect(forwardedFromTask({ source: "cody", viaTask: { taskId: "task_1" } })).toEqual({ taskId: "task_1", taskTitle: "task_1", queue: [] })
    expect(forwardedFromTask({ source: "agent", taskId: "task_1" })).toBeNull()
    expect(forwardedFromTask(null)).toBeNull()
  })
})

describe("worker prompt", () => {
  it("tells the agent to forward task management to the Captain at once, with the owner's name", () => {
    const project = { id: "prj_demo01", name: "demo", description: "", repo: null } as unknown as Project
    const prompt = workerSystemPrompt({ project, task: { id: "task_1", title: "T" }, branch: null, port: 4000, ownerName: "Sam" })
    expect(prompt).toContain("Sam asks for task management you can't do (split work out, start or reprioritise tasks, change your queue): forward it with message_captain right away")
  })
})
