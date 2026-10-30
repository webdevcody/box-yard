// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { ZEN_PATH } from "../web/src/lib/zen.js"
import { closeZenPanel, navigatePanel, openInZenPanel, openZenPanel, panelPage, panelPath, zenPanelState, zenPanelTaskId } from "../web/src/lib/zenPanel.js"
import { COORDINATOR_CHAT, closeThread, forgetThread, openThread, openThreadId } from "../web/src/lib/threads.js"
import { previewState } from "../web/src/lib/preview.js"
import type { ChatMessage, Project, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const task = (id: string, title: string) =>
  ({
    id,
    projectId: "prj_demo01",
    title,
    prompt: "Do it.",
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
    createdAt: now,
    updatedAt: now,
  }) as unknown as Task
const TASKS = [task("task_zen001", "Write the zen docs"), task("task_zen002", "Fix the build")]
const PROJECTS = [{ id: "prj_demo01", name: "box-yard", repo: "webdevcody/box-yard", description: "", notes: [], updatedAt: now }] as unknown as Project[]
const REPLY = [
  "Links: [the docs](/tasks/task_zen001), [the build](/tasks/task_zen002), [the Captain](/projects/prj_demo01?tab=captain),",
  "[the project](/projects/prj_demo01), [boxes](/boxes), [a report](/artifacts/art_report01/report.md),",
  "[GitHub](https://github.com/webdevcody/box-yard).",
].join(" ")
const CHAT: ChatMessage[] = [{ id: "msg_1", role: "assistant", content: REPLY, meta: null, createdAt: now - 1000 }]

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement

function render(path: string = ZEN_PATH) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { startInZen: true, ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const chat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")!
const panel = () => document.querySelector<HTMLElement>("[data-testid=zen-panel]")
const title = () => document.querySelector("[data-testid=zen-panel-title]")?.textContent
const inZen = () => Boolean(document.querySelector("[data-zen]"))
const link = (href: string, within: ParentNode = chat()) => [...within.querySelectorAll("a")].find((a) => a.getAttribute("href") === href)!
/**
 * Clicks `el`. The links stop propagation, so read `defaultPrevented` off the event. A click the app leaves alone is
 * followed by happy-dom itself (it moves the location), as a new tab would leave this one where it is: put it back.
 */
const click = (el: Element, init: MouseEventInit = {}) => {
  const at = location.pathname + location.search
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  if (!e.defaultPrevented) history.replaceState(history.state, "", at)
  return e
}
const esc = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  closeZenPanel()
  const thread = openThreadId(COORDINATOR_CHAT)
  if (thread) {
    closeThread(COORDINATOR_CHAT)
    forgetThread(COORDINATOR_CHAT, thread)
  }
  vi.unstubAllGlobals()
})

describe("panelPath: which links open in Zen's side panel", () => {
  const origin = "http://yard.test"
  it("tasks, projects and a project's tabs (the Captain's) go to the panel", () => {
    expect(panelPath("/tasks/task_abc123")).toBe("/tasks/task_abc123")
    expect(panelPath("/tasks/task_abc123#queue")).toBe("/tasks/task_abc123#queue")
    expect(panelPath("/projects/prj_abc123")).toBe("/projects/prj_abc123")
    expect(panelPath("/projects/prj_abc123?tab=captain")).toBe("/projects/prj_abc123?tab=captain")
    expect(panelPath(`${origin}/tasks/task_abc123`, origin)).toBe("/tasks/task_abc123")
  })

  it("every other page, files and other sites don't", () => {
    for (const href of ["/", "/zen", "/boxes", "/boxes#box1", "/schedules#sch_abc123", "/usage", "/?tab=recent", "/tasks", "/tasks/task_abc123/extra", "/projects/"])
      expect(panelPath(href), href).toBeNull()
    for (const href of ["/artifacts/art_abc123/a.png", "/api/uploads/up_1/a.png", "https://github.com/o/r/pull/1", "//evil.test/tasks/task_abc123", "http://yard.test.evil/tasks/task_abc123", "mailto:x@y.z"])
      expect(panelPath(href, origin), href).toBeNull()
  })

  it("panelPage reads the kind, id and tab", () => {
    expect(panelPage("/tasks/task_abc123#queue")).toEqual({ kind: "task", id: "task_abc123", tab: null })
    expect(panelPage("/projects/prj_abc123?tab=captain&q=x")).toEqual({ kind: "project", id: "prj_abc123", tab: "captain" })
    expect(panelPage("/projects/prj_abc123")).toEqual({ kind: "project", id: "prj_abc123", tab: null })
    expect(panelPage("/boxes")).toBeNull()
  })

  it("only intercepts in Zen", () => {
    history.replaceState(null, "", "/")
    expect(openInZenPanel("/tasks/task_abc123")).toBe(false)
    expect(zenPanelState()).toBeNull()
    history.replaceState(null, "", ZEN_PATH)
    expect(openInZenPanel("/boxes")).toBe(false)
    expect(openInZenPanel("/tasks/task_abc123")).toBe(true)
    expect(zenPanelState()).toEqual({ path: "/tasks/task_abc123" })
    expect(zenPanelTaskId()).toBe("task_abc123")
  })
})

describe("Zen's side panel", () => {
  it("a plain click on a task link opens it beside the chat and stays in Zen", () => {
    render()
    const e = click(link("/tasks/task_zen001"))
    expect(e.defaultPrevented).toBe(true)
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
    expect(panel()).not.toBeNull()
    expect(title()).toBe("Write the zen docs")
    // The existing task page, inside the panel.
    expect(panel()!.textContent).toContain("Write the zen docs")
  })

  it("Cmd, Ctrl, Shift and middle clicks are left to the browser (a new tab)", () => {
    render()
    const a = link("/tasks/task_zen001")
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }] as MouseEventInit[]) {
      const e = click(a, init)
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(false)
    }
    expect(panel()).toBeNull()
    expect(location.pathname).toBe(ZEN_PATH)
  })

  it("a Captain link opens the project on its Captain tab; another link swaps what it shows", () => {
    render()
    click(link("/projects/prj_demo01?tab=captain"))
    expect(title()).toBe("box-yard Captain")
    expect(panel()!.querySelector("nav[aria-label='Project sections'] [aria-current=page]")!.textContent).toContain("Captain")
    click(link("/projects/prj_demo01"))
    expect(title()).toBe("box-yard")
    expect(panel()!.querySelector("nav[aria-label='Project sections'] [aria-current=page]")!.textContent).toContain("Tasks")
    click(link("/tasks/task_zen002"))
    expect(title()).toBe("Fix the build")
    expect(document.querySelectorAll("[data-testid=zen-panel]").length).toBe(1)
  })

  it("the page's own tabs and links move the panel; a link to any other page leaves Zen for it", () => {
    render()
    click(link("/projects/prj_demo01"))
    const tabs = panel()!.querySelector("nav[aria-label='Project sections']")!
    click(link("/projects/prj_demo01?tab=captain", tabs))
    expect(zenPanelState()!.path).toBe("/projects/prj_demo01?tab=captain")
    expect(location.pathname + location.search).toBe(ZEN_PATH)
    act(() => navigatePanel("/boxes"))
    expect(zenPanelState()).toBeNull()
    expect(location.pathname).toBe("/boxes")
    expect(inZen()).toBe(false)
  })

  it("✕ closes it, and Esc closes it before it leaves Zen", () => {
    render()
    click(link("/tasks/task_zen001"))
    click(panel()!.querySelector("[aria-label='Close the panel']")!)
    expect(panel()).toBeNull()
    click(link("/tasks/task_zen001"))
    esc()
    expect(panel()).toBeNull()
    expect(inZen()).toBe(true)
    esc()
    expect(inZen()).toBe(false)
  })

  it("the full view button opens the page outside Zen; a Cmd-click there is a new tab", () => {
    render()
    click(link("/tasks/task_zen001"))
    const full = panel()!.querySelector<HTMLAnchorElement>("[aria-label='Open in full view']")!
    expect(full.getAttribute("href")).toBe("/tasks/task_zen001")
    expect(click(full, { metaKey: true }).defaultPrevented).toBe(false)
    expect(panel()).not.toBeNull()
    expect(click(full).defaultPrevented).toBe(true)
    expect(location.pathname).toBe("/tasks/task_zen001")
    expect(inZen()).toBe(false)
    expect(zenPanelState()).toBeNull()
  })

  it("other links keep working as before: a page that isn't a task or project leaves Zen, files preview, other sites open a tab", () => {
    render()
    const gh = link("https://github.com/webdevcody/box-yard")
    expect(gh.getAttribute("target")).toBe("_blank")
    expect(click(gh).defaultPrevented).toBe(false)
    const file = click(link("/artifacts/art_report01/report.md"))
    expect(file.defaultPrevented).toBe(true)
    expect(previewState()?.items[0]?.url).toBe("/artifacts/art_report01/report.md")
    expect(panel()).toBeNull()
    history.replaceState(null, "", ZEN_PATH)
    click(link("/boxes"))
    expect(location.pathname).toBe("/boxes")
    expect(panel()).toBeNull()
  })

  it("outside Zen, the same links navigate as they always did", () => {
    render("/")
    const e = click(link("/tasks/task_zen001"))
    expect(e.defaultPrevented).toBe(true)
    expect(location.pathname).toBe("/tasks/task_zen001")
    expect(panel()).toBeNull()
    expect(zenPanelState()).toBeNull()
  })

  it("one right panel at a time: a side thread closes the panel, and the panel closes the side thread", () => {
    render()
    click(link("/tasks/task_zen001"))
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    expect(panel()).toBeNull()
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    click(link("/tasks/task_zen001"))
    expect(panel()).not.toBeNull()
    expect(document.querySelector("[data-testid=side-thread]")?.hasAttribute("data-open") ?? false).toBe(false)
  })

  it("is a column on a wide Zen window and a sheet with Back on a narrow one, by container query", () => {
    render()
    click(link("/tasks/task_zen001"))
    const aside = panel()!
    expect(aside.parentElement!.className).toContain("@container/zen")
    expect(aside.className).toContain("@max-[48rem]/zen:absolute")
    expect(aside.className).toContain("@max-[48rem]/zen:inset-0")
    // No viewport breakpoints decide the layout.
    expect(aside.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):/)
    const back = aside.querySelector<HTMLElement>("[aria-label='Back to the chat']")!
    expect(back.className).toContain("@min-[48rem]/zen:hidden")
    expect(aside.querySelector("[aria-label='Close the panel']")!.className).toContain("@min-[48rem]/zen:grid")
    expect(aside.querySelector("header")!.className).toContain("safe-area-inset-top")
    expect(aside.querySelector("[role=separator]")).not.toBeNull()
    click(back)
    expect(panel()).toBeNull()
  })

  it("closes when Zen does", () => {
    render()
    act(() => openZenPanel("/tasks/task_zen001"))
    expect(panel()).not.toBeNull()
    esc() // closes the panel
    esc() // leaves
    expect(inZen()).toBe(false)
    act(() => openZenPanel("/tasks/task_zen001"))
    act(() => history.replaceState(null, "", "/"))
    expect(panel()).toBeNull()
  })
})
