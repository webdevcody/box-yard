// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss, isCritical, toast, type Toast } from "../web/src/lib/toast.js"
import { ZEN_PATH, isZenShortcut } from "../web/src/lib/zen.js"
import { HEAD_CONTAINER, NARROW_HEAD_ONLY, WIDE_HEAD_ONLY } from "../web/src/lib/contextVisibility.js"
import type { ChatMessage, Project, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const TASKS = [
  {
    id: "task_zen001",
    projectId: "prj_demo01",
    title: "Write the zen docs",
    prompt: "Write the docs.",
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
  },
] as Task[]
const PROJECTS = [{ id: "prj_demo01", name: "box-yard", repo: "webdevcody/box-yard", description: "", notes: [], updatedAt: now }] as unknown as Project[]
const CHAT: ChatMessage[] = [
  { id: "msg_1", role: "user", content: "What's everyone doing?", meta: null, createdAt: now - 2000 },
  { id: "msg_2", role: "assistant", content: "One agent is on [the docs](/tasks/task_zen001).", meta: null, createdAt: now - 1000 },
]

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

/** `/` renders as a reload of this tab (already landed), so only the tests that ask for it start in Zen. */
function render(path = "/", tokens = 84_000, autoCompact = false) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  const orchestratorAutoCompact = { enabled: autoCompact, unit: "tokens", value: 250_000 }
  qc.setQueryData(keys.agentSettings, { settings: { startInZen: true, ownerName: "Cody", orchestratorAutoCompact }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const chat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")
const inZen = () => Boolean(document.querySelector("[data-zen]"))
const sidebarOrPage = () => document.querySelector("main, aside, nav")
const keydown = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })))
const zenKey = () => keydown({ key: "Ω", code: "KeyZ", altKey: true, shiftKey: true })
/** history.back() lands asynchronously (popstate), like in a browser. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))

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
  vi.unstubAllGlobals()
})

describe("Zen mode", () => {
  it("/zen renders only the Coordinator chat: no sidebar, page or app header", () => {
    render(ZEN_PATH)
    expect(inZen()).toBe(true)
    expect(chat()).not.toBeNull()
    expect(sidebarOrPage()).toBeNull()
    expect(document.querySelector("[aria-label='Open navigation']")).toBeNull()
    // The same chat: transcript, context reading with Compact (no Clear) and composer.
    expect(chat()!.textContent).toContain("One agent is on")
    expect([...chat()!.querySelectorAll("button")].some((b) => b.textContent?.includes("Compact"))).toBe(true)
    expect([...chat()!.querySelectorAll("button")].some((b) => /clear|reset/i.test(b.textContent ?? ""))).toBe(false)
    expect(chat()!.querySelector("textarea")).not.toBeNull()
    expect(chat()!.querySelector("[aria-label='Leave Zen mode']")).not.toBeNull()
    expect(chat()!.querySelector("[aria-label='Zen mode']")).toBeNull()
    expect(chat()!.querySelector("header")!.textContent).toContain("Box Yard Coordinator")
    // Every row pads in to the one centered column: the header, the project bar (a task is running), the thread
    // and the composer.
    expect(chat()!.querySelectorAll(".zen-column").length).toBe(4)
    expect(chat()!.querySelector('[data-testid="project-bar"]')!.classList.contains("zen-column")).toBe(true)
  })

  it("puts the context reading and Compact in the header, left of the other controls, and nowhere else", async () => {
    render(ZEN_PATH)
    const header = chat()!.querySelector("header")!
    const ctx = header.querySelector<HTMLElement>("[data-testid=zen-context]")!
    expect(chat()!.querySelector("[data-testid=context-meter]")).toBeNull()
    expect(ctx.querySelector("[data-testid=context-mini]")!.textContent).toContain("8%")
    expect(ctx.querySelector("[data-testid=context-mini]")!.getAttribute("title")).toContain("84k / 1m")
    const controls = [...header.querySelectorAll("[data-testid=zen-context], [aria-label=Settings], [aria-label='Leave Zen mode']")]
    expect(controls.map((c) => c.getAttribute("data-testid") ?? c.getAttribute("aria-label"))).toEqual(["zen-context", "Settings", "Leave Zen mode"])
    // Quiet below 75%; one fetch per click.
    const compact = ctx.querySelector<HTMLButtonElement>("button[aria-label=Compact]")!
    expect(compact.className).not.toContain("amber")
    await act(async () => {
      compact.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.some(([url, init]) => url.includes("compact") && init?.method === "POST")).toBe(true)
  })

  it("emphasises Compact from 75% and, in a narrow header, offers it only from the ⋯ menu", () => {
    render(ZEN_PATH, 800_000)
    const header = chat()!.querySelector("header")!
    const ctx = header.querySelector<HTMLElement>("[data-testid=zen-context]")!
    expect(ctx.querySelector("button[aria-label=Compact]")!.className).toContain("amber")
    // Container queries on the header, not the viewport: the reading is wide-only, the ⋯ button narrow-only.
    expect(ctx.className).toContain(WIDE_HEAD_ONLY)
    const chip = header.querySelector<HTMLButtonElement>("[data-testid=context-menu-button]")!
    expect(chip.className).toContain(NARROW_HEAD_ONLY)
    expect(chip.className).toContain("amber")
    expect(chip.querySelector("[data-testid=context-mini]")).toBeNull()
    expect(chip.getAttribute("aria-label")).toContain("800k / 1m · 80%")
    act(() => chip.click())
    const menu = header.querySelector("[role=menu]")!
    expect(menu.textContent).toContain("Context 800k / 1m · 80%")
    act(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]")!.click())
    expect(header.querySelector("[role=menu]")).toBeNull()
  })

  it("the side panel keeps its own context meter row (wide only, ⋯ when narrow) and its short title", () => {
    render("/")
    expect(chat()!.querySelector("header")!.textContent).toContain("Coordinator")
    expect(chat()!.querySelector("header")!.textContent).not.toContain("Box Yard Coordinator")
    const row = chat()!.querySelector<HTMLElement>("[data-testid=context-meter]")!
    expect(row.className).toContain(WIDE_HEAD_ONLY)
    expect(row.closest(`[class~="${HEAD_CONTAINER}"]`)).toBe(chat()!.querySelector("header")!.parentElement)
    expect(chat()!.querySelector("[data-testid=zen-context]")).toBeNull()
    expect(chat()!.querySelector("[data-testid=context-menu-button]")!.className).toContain(NARROW_HEAD_ONLY)
  })

  it("with auto-compact on, shows no context reading and no Compact, in Zen or the side panel", () => {
    for (const path of [ZEN_PATH, "/"]) {
      render(path, 900_000, true)
      expect(chat()!.querySelector("[data-testid=zen-context], [data-testid=context-meter], [data-testid=context-mini], [data-testid=context-menu-button]")).toBeNull()
      expect([...chat()!.querySelectorAll("button")].some((b) => /compact/i.test(`${b.textContent} ${b.getAttribute("aria-label")}`))).toBe(false)
      // The rest of the header stays.
      expect(chat()!.querySelector("[aria-label=Settings]")).not.toBeNull()
    }
  })

  it("a reload of / stays on the Yard, and the panel offers the way in", () => {
    render("/")
    expect(inZen()).toBe(false)
    expect(document.querySelector("main")).not.toBeNull()
    expect(chat()!.querySelector("[aria-label='Leave Zen mode']")).toBeNull()
    act(() => chat()!.querySelector<HTMLButtonElement>("[aria-label='Zen mode']")!.click())
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
  })

  it("enters from the palette's Zen mode command, which documents the shortcut", () => {
    render("/")
    act(() => openPalette())
    const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zen")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const option = document.querySelector("[role=option][aria-selected=true]")!
    expect(option.getAttribute("data-key")).toBe("action:zen")
    expect(option.textContent).toContain("Zen mode")
    expect(option.textContent).toMatch(/Alt\+Shift\+Z|⌥⇧Z/)
    keydown({ key: "Enter" }, input)
    expect(document.querySelector("input[role=combobox]")).toBeNull()
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
  })

  it("Alt+Shift+Z toggles Zen, even from the composer, and keeps the same chat (draft included)", async () => {
    render("/inbox")
    const box = chat()!.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "half a thought")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    zenKey()
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
    expect(chat()!.querySelector("textarea")).toBe(box)
    keydown({ key: "Ω", code: "KeyZ", altKey: true, shiftKey: true }, box)
    await settle()
    expect(location.pathname).toBe("/inbox")
    expect(inZen()).toBe(false)
    expect(chat()!.querySelector("textarea")).toBe(box)
    expect(box.value).toBe("half a thought")
  })

  it("matches the shortcut by key position only, with no other modifiers", () => {
    const e = { altKey: true, shiftKey: true, metaKey: false, ctrlKey: false, code: "KeyZ" }
    expect(isZenShortcut(e)).toBe(true)
    expect(isZenShortcut({ ...e, shiftKey: false })).toBe(false)
    expect(isZenShortcut({ ...e, metaKey: true })).toBe(false)
    expect(isZenShortcut({ ...e, ctrlKey: true })).toBe(false)
    expect(isZenShortcut({ ...e, code: "KeyV" })).toBe(false)
  })

  it("Esc goes back to the page Zen was entered from", async () => {
    render("/usage")
    zenKey()
    expect(inZen()).toBe(true)
    keydown({ key: "Escape" })
    await settle()
    expect(location.pathname).toBe("/usage")
    expect(inZen()).toBe(false)
  })

  it("Esc on a /zen opened directly goes to the Yard", () => {
    render(ZEN_PATH)
    keydown({ key: "Escape" })
    expect(location.pathname).toBe("/")
    expect(inZen()).toBe(false)
  })

  it("browser back leaves Zen", async () => {
    render("/")
    zenKey()
    expect(inZen()).toBe(true)
    await act(async () => {
      history.back()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(location.pathname).toBe("/")
    expect(inZen()).toBe(false)
    expect(document.querySelector("main")).not.toBeNull()
  })

  it("Esc closes an open modal (the palette) first and stays in Zen", () => {
    render(ZEN_PATH)
    act(() => openPalette())
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
    keydown({ key: "Escape" })
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
    keydown({ key: "Escape" })
    expect(inZen()).toBe(false)
  })

  it("Esc that something else already claimed doesn't leave", () => {
    render(ZEN_PATH)
    const claim = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener("keydown", claim)
    keydown({ key: "Escape" }, chat()!.querySelector("textarea")!)
    document.removeEventListener("keydown", claim)
    expect(inZen()).toBe(true)
  })

  it("a task link in the transcript opens the side panel and stays in Zen; a Cmd-click is left to the browser", () => {
    render(ZEN_PATH)
    const link = [...chat()!.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/tasks/task_zen001")!
    expect(link).toBeTruthy()
    const cmd = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true })
    act(() => void link.dispatchEvent(cmd))
    expect(cmd.defaultPrevented).toBe(false)
    // happy-dom follows the link itself; a new tab would leave this one on /zen.
    history.replaceState(history.state, "", ZEN_PATH)
    expect(inZen()).toBe(true)
    expect(document.querySelector("[data-testid=zen-panel]")).toBeNull()
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    act(() => void link.dispatchEvent(plain))
    expect(plain.defaultPrevented).toBe(true)
    expect(location.pathname).toBe(ZEN_PATH)
    expect(inZen()).toBe(true)
    expect(document.querySelector("[data-testid=zen-panel-title]")!.textContent).toBe("Write the zen docs")
  })

  it("shows only critical toasts, at the top, clear of the composer", () => {
    render(ZEN_PATH)
    act(() => {
      toast.info("Saved")
      toast.task({ title: "Docs PR ready", href: "/tasks/task_zen001", tone: "green", status: "pr_ready" })
      toast.task({ title: "Build broke", href: "/tasks/task_zen001", tone: "red", status: "failed" })
      toast.error("Couldn't send")
    })
    const stack = document.querySelector<HTMLElement>("[role=status][data-quiet]")!
    expect(stack).not.toBeNull()
    expect(stack.className).toContain("top-")
    expect(stack.className).not.toContain("bottom-")
    expect(stack.textContent).toContain("Build broke")
    expect(stack.textContent).toContain("Couldn't send")
    expect(stack.textContent).not.toContain("Saved")
    expect(stack.textContent).not.toContain("Docs PR ready")
  })

  it("isCritical keeps errors and failed tasks only", () => {
    const t = (x: Partial<Toast>) => ({ id: 1, kind: "info", title: "", ...x }) as Toast
    expect(isCritical(t({ kind: "error" }))).toBe(true)
    expect(isCritical(t({ kind: "task", tone: "red" }))).toBe(true)
    expect(isCritical(t({ kind: "task", tone: "amber" }))).toBe(false)
    expect(isCritical(t({ kind: "info", progress: true }))).toBe(false)
  })
})
