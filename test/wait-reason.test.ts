// @vitest-environment happy-dom
// A queued task's wait reason links the tasks holding it back (Task.waitFor): a real link in the task banner, and a
// button (no nested anchor) inside a task card or Boxes queue row, which are links themselves.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskCard } from "../web/src/components/TaskCard.js"
import { WaitReason, waitReasonParts } from "../web/src/components/WaitReason.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REASON = "Waiting for Merge PR #78: survive-the-night allows 1 of its tasks at a time on this computer"
const BY = [{ taskId: "task_17063f203d7d", title: "Merge PR #78" }]

const task = (over: Partial<Task> = {}) =>
  ({
    id: "task_984e61b98869",
    projectId: "prj_boxyard",
    title: "Perf lane 1",
    prompt: "",
    status: "queued",
    boxId: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: REASON,
    waitBoxSize: null,
    waitFor: BY,
    turnCount: 0,
    pendingCount: 0,
    prUrl: null,
    prState: null,
    outcome: null,
    mergeRequest: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as unknown as Task

let root: Root
let host: HTMLElement
beforeEach(() => {
  history.replaceState(null, "", "/")
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, node)))

describe("waitReasonParts", () => {
  it("cuts the reason around each named task, in order", () => {
    expect(waitReasonParts(REASON, BY)).toEqual(["Waiting for ", BY[0], ": survive-the-night allows 1 of its tasks at a time on this computer"])
    const two = [
      { taskId: "task_a", title: "A" },
      { taskId: "task_b", title: "B" },
    ]
    expect(waitReasonParts("waiting for A (p) and B (q) here", two)).toEqual(["waiting for ", two[0], " (p) and ", two[1], " (q) here"])
    // A title the text doesn't have (renamed since) is left out: the text stays whole.
    expect(waitReasonParts("waiting", [{ taskId: "task_c", title: "C" }])).toEqual(["waiting"])
  })
})

describe("WaitReason", () => {
  it("links the blocking task in the task banner", () => {
    render(createElement(WaitReason, { task: task() }))
    const link = host.querySelector<HTMLAnchorElement>("a[data-testid=wait-for-link]")!
    expect(link.getAttribute("href")).toBe("/tasks/task_17063f203d7d")
    expect(link.textContent).toBe("Merge PR #78")
    expect(host.textContent).toBe(REASON)
  })

  it("in a task card it's a button that opens the blocker, not the card's own task, and no anchor nests", () => {
    render(createElement(TaskCard, { task: task() }))
    const card = host.querySelector("a")!
    expect(card.getAttribute("href")).toBe("/tasks/task_984e61b98869")
    expect(card.querySelectorAll("a")).toHaveLength(0)
    expect(host.querySelector("[data-testid=wait-reason]")!.textContent).toBe(REASON)
    const button = host.querySelector<HTMLButtonElement>("button[data-testid=wait-for-link]")!
    expect(button.textContent).toBe("Merge PR #78")
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    act(() => void button.dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
    expect(location.pathname).toBe("/tasks/task_17063f203d7d")
  })

  it("shows where a waiting task will go in the card's footer, muted, and pinned when it overrides its project", () => {
    render(createElement(TaskCard, { task: task({ placement: { now: null, last: null, runner: "local", chosenBy: "task", projectRunner: "box" } }) }))
    const chip = host.querySelector<HTMLElement>("[data-testid=card-placement]")!
    expect(chip.textContent).toBe("→ This computer")
    expect(chip.dataset.state).toBe("next")
    expect(chip.querySelector('[aria-label="pinned"]')).not.toBeNull()
    expect(chip.title).toContain("This task's Runs on: this computer")
    render(createElement(TaskCard, { task: task({ status: "working", boxId: "pure-lobster", placement: { now: { kind: "box", boxId: "pure-lobster", provider: "upstash", size: "small" }, last: null, runner: "box", chosenBy: "project", projectRunner: "box" } }) }))
    expect(host.querySelector<HTMLElement>("[data-testid=card-placement]")!.textContent).toBe("Upstash · small")
    expect(host.querySelector<HTMLElement>("[data-testid=card-placement]")!.title).toContain("Upstash · pure-lobster · small")
  })

  it("shows the plain reason when it names no task", () => {
    render(createElement(WaitReason, { task: task({ waitReason: "Waiting for disk cleanup on box-1", waitFor: [] }) }))
    expect(host.querySelector("[data-testid=wait-for-link]")).toBeNull()
    expect(host.textContent).toBe("Waiting for disk cleanup on box-1")
  })
})
