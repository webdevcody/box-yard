// @vitest-environment happy-dom
// The task header: three rows (breadcrumb, title + actions, one meta row) with the rest in the ⋯ details.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import type { Artifact, MergeRequest, Project, Task } from "../shared/types.js"
import { LOCAL_UNSANDBOXED } from "../shared/runner.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prUrl = "https://github.com/webdevcody/box-yard/pull/76"
const project: Project = { id: "prj_demo01", name: "box-yard", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], boxSize: null, createdAt: 0, updatedAt: 0 }

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_head000001",
    projectId: project.id,
    title: "Generic hook system (Coordinator/Captain automations on task events)",
    prompt: "",
    status: "working",
    boxId: "pleasing-shepherd-27426",
    sessionId: "s",
    branch: "boxyard/hooks",
    prUrl,
    prState: "open",
    prMergedAt: null,
    prMergedBy: null,
    previews: [{ port: 4020, url: "https://example.com/4020", label: "Demo" }],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 3,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: 576_000,
    contextWindow: 1_000_000,
    compactPending: false,
    compacting: false,
    model: "claude-opus-5-5",
    effort: "xhigh",
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: "big-features",
    routingReason: "Multi-file feature",
    mergeRequest: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    ...over,
  }
}

const file = (i: number): Artifact => ({ id: `art_${i}`, projectId: project.id, taskId: "task_head000001", title: `f${i}.png`, filename: `f${i}.png`, mime: "image/png", size: 1, url: `/artifacts/art_${i}/f${i}.png`, createdAt: 1000 + i })
const requested: MergeRequest = { prNumber: 76, prUrl, requestedAt: 1, deliveredAt: 2 }

describe("TaskHeader", () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    localStorage.clear()
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ""
  })

  const render = (t: Task, files: Artifact[] = []) =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(TaskHeader, { task: t, project, schedule: null, files, showTools: false, onShowTools: () => {} }),
        ),
      ),
    )
  const meta = () => document.querySelector<HTMLElement>('[data-testid="task-meta"]')!
  const metaText = () => meta().textContent!.replace(/\s+/g, " ")

  it("keeps the meta row in a fixed order: status, PR, files, preview, context", () => {
    render(task(), [file(1), file(2)])
    const text = metaText()
    const order = ["Working", "PR #76", "2 files", "Preview :4020", "58%"].map((s) => text.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Details live in the ⋯ popover, not the header.
    expect(document.querySelector("header")!.textContent).not.toContain("claude-opus-5-5")
    expect(text).not.toContain("Active")
  })

  it("folds a pending merge into the PR chip instead of a separate pill or button", () => {
    render(task({ mergeRequest: requested }))
    const chip = document.querySelector('[data-pr-state="open"]')!
    expect(chip.textContent).toContain("PR #76")
    expect(chip.textContent).toContain("merging…")
    expect(document.querySelector("header [data-merge-state]")).toBeNull()
    expect(document.querySelector("header")!.textContent).not.toContain("Merge requested")
  })

  it("shows Merge PR with the actions only while a merge can be sent", () => {
    render(task({ status: "pr_ready" }))
    const btn = document.querySelector<HTMLButtonElement>('[data-merge-state="ready"]')!
    expect(btn.textContent).toContain("Merge PR")
    expect(meta().contains(btn)).toBe(false)
    render(task({ status: "idle", prState: "merged", prMergedAt: 1 }))
    expect(document.querySelector("[data-merge-state]")).toBeNull()
    expect(document.querySelector('[data-pr-state="merged"]')!.textContent).toContain("Merged #76")
  })

  it("marks new files with a dot, not a count badge", () => {
    render(task(), [file(1), file(2), file(3)])
    const chip = [...meta().querySelectorAll("button")].find((b) => b.textContent?.includes("3 files"))!
    expect(chip.getAttribute("aria-label")).toBe("3 files, 3 new")
    expect(chip.querySelector('[data-testid="files-new-dot"]')).not.toBeNull()
    expect(chip.textContent).not.toContain("new")
  })

  it("only offers Compact next to the meter from 75% context", () => {
    render(task({ contextTokens: 700_000 }))
    expect(metaText()).toContain("70%")
    expect(metaText()).not.toContain("Compact")
    render(task({ contextTokens: 810_000 }))
    expect(metaText()).toContain("81% Compact")
  })

  it("puts the full title, model, route, times, box, branch, id and context numbers in the details popover", async () => {
    render(task())
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!
    await act(async () => void trigger.click())
    const panel = document.querySelector('[role="dialog"][aria-label="Task details and actions"]')!
    const text = panel.textContent!
    for (const s of ["Generic hook system (Coordinator/Captain automations on task events)", "task_head000001", "boxyard/hooks", "pleasing-shepherd-27426", "claude-opus-5-5 · xhigh effort", "big-features", "Multi-file feature", "Active", "Created", "576k / 1m · 58%"]) {
      expect(text).toContain(s)
    }
    expect(panel.querySelector('button[aria-label="Copy task id"]')).not.toBeNull()
  })

  it("warns that a local task is unsandboxed, in full on a tap", () => {
    render(task({ boxId: "this-computer" }))
    const chip = document.querySelector<HTMLButtonElement>('[data-testid="local-warning"]')!
    expect(chip.textContent).toContain("This computer · unsandboxed")
    expect(chip.title).toBe(LOCAL_UNSANDBOXED)
    expect(chip.getAttribute("aria-expanded")).toBe("false")
    expect(document.getElementById("local-warning-note")).toBeNull()
    act(() => chip.click())
    expect(chip.getAttribute("aria-expanded")).toBe("true")
    expect(document.getElementById("local-warning-note")!.textContent).toBe(LOCAL_UNSANDBOXED)
    act(() => chip.click())
    expect(document.getElementById("local-warning-note")).toBeNull()
  })

  it("shows the chip for a queued task of a local project, and never on a box task", () => {
    render(task({ boxId: null, status: "queued" }))
    expect(document.querySelector('[data-testid="local-warning"]')).toBeNull()
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(TaskHeader, { task: task({ boxId: null, status: "queued" }), project: { ...project, runner: "local" }, schedule: null, files: [], showTools: false, onShowTools: () => {} }),
        ),
      ),
    )
    expect(document.querySelector('[data-testid="local-warning"]')).not.toBeNull()
  })

  it("follows the task's own runs_on over its project's, both ways, and names it in the details", async () => {
    const header = (t: Task, runner: "box" | "local") =>
      act(() =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(TaskHeader, { task: t, project: { ...project, runner }, schedule: null, files: [], showTools: false, onShowTools: () => {} }),
          ),
        ),
      )
    const chip = () => document.querySelector('[data-testid="local-warning"]')
    // Pinned here in a box project: the chip shows before it has a place.
    render(task({ boxId: null, status: "queued", runsOn: "local" }))
    expect(chip()).not.toBeNull()
    // Pinned to a box in a local project: no chip.
    header(task({ boxId: null, status: "queued", runsOn: "box" }), "local")
    expect(chip()).toBeNull()
    // The ⋯ details say it's this task's own choice. The chip keeps its slot: first, before the PR chip.
    header(task({ boxId: "this-computer", runsOn: "local", prUrl: "https://github.com/o/r/pull/7" }), "box")
    const chips = document.querySelector('[data-testid="task-chips"]')!
    expect(chips.firstElementChild?.getAttribute("data-testid")).toBe("local-warning")
    await act(async () => void document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!.click())
    expect(document.querySelector('[data-testid="task-runs-on"]')!.textContent).toBe("This computer · this task only")
  })
})
