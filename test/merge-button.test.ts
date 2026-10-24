// @vitest-environment happy-dom
// The "Merge PR" button: when it shows, its confirm step, the queued / requested states and the client duplicate guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MergePrButton, MergePrCardButton, MergePrMenuItem } from "../web/src/components/MergePr.js"
import { TaskCard } from "../web/src/components/TaskCard.js"
import { ConfirmHost } from "../web/src/components/ConfirmDialog.js"
import { canRequestMerge, mergeButtonState, sendMergeOnce } from "../web/src/lib/mergePr.js"
import { keys } from "../web/src/lib/queries.js"
import { parseNotice } from "../web/src/lib/captainTranscript.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { MergeRequest, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const url = "https://github.com/webdevcody/box-yard/pull/12"

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_merge00001",
    projectId: "prj_demo01",
    title: "Ship the inbox",
    prompt: "",
    status: "pr_ready",
    boxId: null,
    sessionId: "s",
    branch: "boxyard/ship",
    prUrl: url,
    prState: "open",
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: "Opened the PR.",
    error: null,
    waitReason: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    mergeRequest: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const pending = (deliveredAt: number | null): MergeRequest => ({ prNumber: 12, prUrl: url, requestedAt: 1, deliveredAt })

describe("when the Merge PR button shows", () => {
  it("only for an open PR: not merged, closed, a draft or no PR", () => {
    expect(mergeButtonState(task())).toBe("ready")
    // The server hasn't checked GitHub yet (or can't, in mock mode): open.
    expect(mergeButtonState(task({ prState: null }))).toBe("ready")
    expect(mergeButtonState(task({ prState: "merged" }))).toBe("hidden")
    expect(mergeButtonState(task({ prState: "closed" }))).toBe("hidden")
    expect(mergeButtonState(task({ prState: "draft" }))).toBe("hidden")
    expect(mergeButtonState(task({ prUrl: null, prState: null }))).toBe("hidden")
    // Not a GitHub PR URL: there is no number to merge.
    expect(canRequestMerge({ prUrl: "https://example.com/merge-requests/3", prState: "open" })).toBe(false)
  })

  it("reads queued until the message goes out, then requested, and hides once the PR merges", () => {
    expect(mergeButtonState(task({ status: "working", mergeRequest: pending(null) }))).toBe("queued")
    expect(mergeButtonState(task({ status: "working", mergeRequest: pending(2) }))).toBe("requested")
    expect(mergeButtonState(task({ prState: "merged", mergeRequest: pending(2) }))).toBe("hidden")
  })
})

describe("client duplicate protection", () => {
  it("sends once for concurrent clicks on the same task and PR", async () => {
    let release!: () => void
    const send = vi.fn(() => new Promise<void>((r) => (release = r)))
    const t = task()
    const first = sendMergeOnce(t, send)
    const second = sendMergeOnce(t, send)
    expect(await second).toBe(false)
    expect(mergeButtonState(t)).toBe("sending")
    release()
    expect(await first).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(mergeButtonState(t)).toBe("ready")
  })

  it("doesn't send while a request is pending on the server", async () => {
    const send = vi.fn(async () => {})
    expect(await sendMergeOnce(task({ mergeRequest: pending(null) }), send)).toBe(false)
    expect(await sendMergeOnce(task({ prState: "draft" }), send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe("Merge PR button", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.tasks, [task()])
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ""
    for (const t of currentToasts()) dismiss(t.id)
    vi.unstubAllGlobals()
  })

  const render = (node: ReactNode) =>
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, node, createElement(ConfirmHost))))
  const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
  const button = (state?: string) => document.querySelector<HTMLButtonElement>(state ? `[data-merge-state="${state}"]` : "[data-merge-state]")
  const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))
  const answer = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it("confirms in a popover, sends one POST, then shows the queued state from the server", async () => {
    answer({ task: task({ status: "working", mergeRequest: pending(null) }), delivery: "queued" })
    render(createElement(MergePrButton, { task: qc.getQueryData<Task[]>(keys.tasks)![0]! }))
    expect(button("ready")?.textContent).toContain("Merge PR")

    await click(button("ready")!)
    const popover = document.querySelector('[role="dialog"]')!
    expect(popover.textContent).toContain('Send merge request to "Ship the inbox"?')
    expect(fetchMock).not.toHaveBeenCalled()

    await click(byText("Send merge request")!)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/tasks/task_merge00001/merge")
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" })

    // The cache now holds the server's task: re-render with it, as the task page does.
    render(createElement(MergePrButton, { task: qc.getQueryData<Task[]>(keys.tasks)![0]! }))
    const queued = button("queued")!
    expect(queued.textContent).toContain("Merge queued")
    expect(queued.disabled).toBe(true)
    expect(currentToasts().map((t) => t.title)).toContain("Merge request queued")
  })

  it("is disabled and reads Merge requested… while the agent is on it", () => {
    render(createElement(MergePrButton, { task: task({ mergeRequest: pending(5) }) }))
    expect(button("requested")?.textContent).toContain("Merge requested…")
    expect(button("requested")?.disabled).toBe(true)
  })

  it("renders nothing for merged, closed and draft PRs, in the header, the menu and on cards", () => {
    for (const prState of ["merged", "closed", "draft"] as const) {
      const t = task({ prState })
      render(createElement("div", null, createElement(MergePrButton, { task: t }), createElement(MergePrMenuItem, { task: t, onPicked: () => {} }), createElement(TaskCard, { task: t })))
      expect(button()).toBeNull()
    }
    render(createElement(TaskCard, { task: task() }))
    expect(button("ready")?.textContent).toContain("Merge")
  })

  it("a card button asks with the confirm dialog and doesn't open the task", async () => {
    answer({ task: task({ mergeRequest: pending(3) }), delivery: "now" })
    const opened = vi.fn()
    // The card around it is a link: its click handler must not run, and the browser must not follow it.
    render(createElement("div", { onClick: opened }, createElement(MergePrCardButton, { task: task() })))
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    await act(async () => void button("ready")!.dispatchEvent(ev))
    expect(opened).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
    expect(document.body.textContent).toContain('Send merge request to "Ship the inbox"?')
    await click(byText("Send merge request")!)
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(qc.getQueryData<Task[]>(keys.tasks)![0]!.mergeRequest).toMatchObject({ prNumber: 12, deliveredAt: 3 })
  })

  it("shows the server's refusal of a duplicate", async () => {
    answer({ error: "A merge of PR #12 was already requested and the agent is on it. Wait for that turn to end." }, 409)
    render(createElement(MergePrButton, { task: task() }))
    await click(button("ready")!)
    await click(byText("Send merge request")!)
    await act(async () => {})
    const toast = currentToasts().find((t) => t.title === "Couldn't request the merge")
    expect(toast?.body).toMatch(/already requested/)
    expect(button("ready")).not.toBeNull()
  })
})

describe("merge notices in the Captain tab", () => {
  it("read as the task's title and Cody's request, with the PR linked", () => {
    const n = parseNotice(`🚢 Cody asked **Ship the inbox** to merge PR #12 (Merge button): ${url}`, { taskId: "task_merge00001", kind: "merge_requested" })
    expect(n.kind).toBe("merge")
    expect(n.title).toBe("Ship the inbox")
    expect(n.summary).toEqual([{ text: "Cody asked it to merge " }, { href: url, label: "PR #12" }])
  })
})
