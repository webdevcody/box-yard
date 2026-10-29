// @vitest-environment happy-dom
// The context reading and Compact: none at all with auto-compact on; with it off, in a wide header, or behind ⋯ in a
// narrow one. The Coordinator's side is in zen-mode.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { keys } from "../web/src/lib/queries.js"
import { HEAD_CONTAINER, NARROW_HEAD_ONLY, WIDE_HEAD_ONLY, contextSpot, spotClass } from "../web/src/lib/contextVisibility.js"
import type { CaptainState, Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("contextSpot", () => {
  it("auto-compact on: nowhere, wide or narrow", () => {
    expect(contextSpot(true, false)).toBe("none")
    expect(contextSpot(true, true)).toBe("none")
    expect(spotClass(true, "header")).toBeNull()
    expect(spotClass(true, "menu")).toBeNull()
  })

  it("auto-compact off: in a wide header, behind ⋯ in a narrow one", () => {
    expect(contextSpot(false, false)).toBe("header")
    expect(contextSpot(false, true)).toBe("menu")
    expect(spotClass(false, "header")).toBe(WIDE_HEAD_ONLY)
    expect(spotClass(false, "menu")).toBe(NARROW_HEAD_ONLY)
  })

  it("switches on the header's own container at one width, never the viewport", () => {
    const at = (c: string) => c.match(/^@(?:max|min)-\[([^\]]+)\]\/head:hidden$/)?.[1]
    expect(at(WIDE_HEAD_ONLY)).toBeTruthy()
    expect(at(WIDE_HEAD_ONLY)).toBe(at(NARROW_HEAD_ONLY))
    expect(HEAD_CONTAINER).toBe("@container/head")
  })
})

const project = { id: "prj_demo01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const ac = (enabled: boolean) => ({ enabled, unit: "percent", value: 80 })

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const settings = (o: { coordinator?: boolean; agent?: boolean }) =>
  qc.setQueryData(keys.agentSettings, {
    settings: { ownerName: "Cody", orchestratorModel: "claude-opus-5-5", orchestratorEffort: "high", orchestratorAutoCompact: ac(o.coordinator ?? false), agentAutoCompact: ac(o.agent ?? false) },
    sources: {},
    defaults: {},
  })
const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const hasCompact = (el: Element) => [...el.querySelectorAll("button")].some((b) => /compact(?!ion)/i.test(b.textContent ?? ""))

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_ctx0000001",
    projectId: project.id,
    title: "Context",
    prompt: "",
    status: "working",
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 3,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: 810_000,
    contextWindow: 1_000_000,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    mergeRequest: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

describe("task header", () => {
  const renderTask = (t: Task) => render(createElement(TaskHeader, { task: t, project, schedule: null, files: [], showTools: false, onShowTools: () => {} }))
  const meta = () => document.querySelector<HTMLElement>('[data-testid="task-meta"]')!
  const details = async () => {
    await act(async () => void document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!.click())
    return document.querySelector('[role="dialog"][aria-label="Task details and actions"]')!
  }

  it("auto-compact off: the bar and Compact are wide-only in the meta row, and the ⋯ details keep the full meter", async () => {
    settings({ agent: false })
    renderTask(task())
    expect(document.querySelector("header")!.className).toContain(HEAD_CONTAINER)
    expect(meta().querySelector("[data-testid=context-mini]")!.className).toContain(WIDE_HEAD_ONLY)
    const compact = [...meta().querySelectorAll("button")].find((b) => b.textContent?.includes("Compact"))!
    expect(compact.className).toContain(WIDE_HEAD_ONLY)
    const panel = await details()
    expect(panel.querySelector("[data-testid=context-meter]")!.textContent).toContain("810k / 1m · 81%")
    expect(hasCompact(panel)).toBe(true)
  })

  it("agent auto-compact on: no bar, percentage or Compact, in the header or its ⋯ details", async () => {
    settings({ agent: true, coordinator: false })
    renderTask(task())
    expect(meta().querySelector("[data-testid=context-mini]")).toBeNull()
    expect(meta().textContent).not.toContain("81%")
    expect(hasCompact(meta())).toBe(false)
    const panel = await details()
    expect(panel.querySelector("[data-testid=context-meter]")).toBeNull()
    expect(panel.textContent).not.toContain("81%")
  })

  it("follows the agents' setting, not the Coordinator's", () => {
    settings({ agent: false, coordinator: true })
    renderTask(task())
    expect(meta().querySelector("[data-testid=context-mini]")).not.toBeNull()
  })

  it("still says when a compaction is running", () => {
    settings({ agent: true })
    renderTask(task({ compacting: true }))
    expect(meta().textContent).toContain("Compacting…")
    expect(meta().querySelector("[data-testid=context-mini]")).toBeNull()
  })
})

describe("Captain header", () => {
  const state = (): CaptainState =>
    ({ projectId: project.id, busy: false, usage: { tokens: 300_000, window: 1_000_000, updatedAt: 1 }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null }) as CaptainState
  const renderCaptain = () => {
    qc.setQueryData(keys.captainMessages(project.id), [])
    qc.setQueryData(keys.captain(project.id), state())
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))
  }
  const header = () => host.querySelector("header")!
  const menu = () => {
    click(host.querySelector('button[aria-label="Captain menu"]')!)
    return host.querySelector('[role="dialog"][aria-label="Captain actions"]')!
  }

  it("auto-compact off: the mini bar is wide-only, and ⋯ has the full meter with Compact", () => {
    settings({ coordinator: false })
    renderCaptain()
    expect(header().className).toContain(HEAD_CONTAINER)
    expect(header().querySelector("[data-testid=context-mini]")!.className).toContain(WIDE_HEAD_ONLY)
    const m = menu()
    expect(m.querySelector("[data-testid=context-meter]")!.textContent).toContain("300k / 1m · 30%")
    expect(hasCompact(m)).toBe(true)
  })

  it("Coordinator auto-compact on (it covers Captains): no bar or Compact anywhere, compaction history stays", () => {
    settings({ coordinator: true, agent: false })
    renderCaptain()
    expect(header().querySelector("[data-testid=context-mini]")).toBeNull()
    expect(header().textContent).not.toContain("30%")
    const m = menu()
    expect(m.querySelector("[data-testid=context-meter]")).toBeNull()
    expect(hasCompact(m)).toBe(false)
    expect(m.textContent).toContain("No compactions yet")
  })
})
