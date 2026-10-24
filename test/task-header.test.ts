// @vitest-environment happy-dom
// The task header: three rows (breadcrumb, title + actions, one meta row) with the rest in the ⋯ details.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import type { Artifact, MergeRequest, Project, Task } from "../shared/types.js"

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
})
