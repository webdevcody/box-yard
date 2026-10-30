// @vitest-environment happy-dom
// The side thread / card panel's draggable width (SideThread.tsx): the column beside a chat, in Zen too (#194's ⤢ card).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { ZEN_PATH } from "../web/src/lib/zen.js"
import { THREAD_CHAT_ROOM, THREAD_MAX, THREAD_MIN, THREAD_ROOM, threadLimit, threadWidthCss } from "../web/src/lib/layout.js"
import { ResizeHandle, useResizable } from "../web/src/lib/resize.js"
import { COORDINATOR_CHAT, closeThread, forgetThread, openCard, openThread, openThreadId, toggleExpanded } from "../web/src/lib/threads.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = "box-yard:thread-width"

describe("the side thread's width limits", () => {
  it("the chat beside it keeps its room, and the thread never goes under its minimum", () => {
    expect(threadLimit(1440)).toBe(1440 - THREAD_CHAT_ROOM)
    expect(threadLimit(800)).toBe(480)
    expect(threadLimit(568)).toBe(THREAD_MIN) // the narrowest column: 35.5rem
    expect(threadLimit(0)).toBe(THREAD_MIN)
  })

  it("the container caps the saved width in CSS, so a smaller window squeezes it without losing what was saved", () => {
    expect(threadWidthCss(600)).toBe(`max(${THREAD_MIN}px, min(600px, calc(100cqw - ${THREAD_CHAT_ROOM}px)))`)
    // In px, not viewport units: 125% zoom keeps the same split.
    expect(threadWidthCss(THREAD_ROOM)).not.toMatch(/v[wh]/)
  })
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  const thread = openThreadId(COORDINATOR_CHAT)
  if (thread) {
    closeThread(COORDINATOR_CHAT)
    forgetThread(COORDINATOR_CHAT, thread)
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const pointer = (el: Element, type: string, clientX: number) =>
  act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX })))

/** Drags `handle` from x 1000 to `to` and lets go. */
function drag(handle: Element, to: number) {
  pointer(handle, "pointerdown", 1000)
  pointer(handle, "pointermove", (1000 + to) / 2)
  pointer(handle, "pointermove", to)
  pointer(handle, "pointerup", to)
}

describe("useResizable on a left edge (the thread's)", () => {
  let width = 0
  function Panel({ limit }: { limit?: number }) {
    const size = useResizable({ key: KEY, defaultWidth: THREAD_ROOM, min: THREAD_MIN, max: THREAD_MAX, limit, edge: "left" })
    width = size.width
    return createElement(ResizeHandle, { ...size.handle, className: "block", inside: true })
  }
  const mount = (limit?: number) => act(() => root.render(createElement(Panel, { limit })))
  const handle = () => host.querySelector("[role=separator]")!

  beforeEach(() => {
    // happy-dom has no pointer capture.
    if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
  })

  it("dragging left widens it, and the width is saved when the drag ends", () => {
    mount(1000)
    expect(width).toBe(THREAD_ROOM)
    pointer(handle(), "pointerdown", 1000)
    pointer(handle(), "pointermove", 900)
    expect(width).toBe(THREAD_ROOM + 100)
    expect(localStorage.getItem(KEY)).toBeNull() // not on every move
    expect(document.body.classList.contains("resizing")).toBe(true)
    pointer(handle(), "pointerup", 900)
    expect(localStorage.getItem(KEY)).toBe(String(THREAD_ROOM + 100))
    expect(document.body.classList.contains("resizing")).toBe(false)
  })

  it("stops at the minimum and at the room the chat leaves", () => {
    mount(600)
    drag(handle(), 2000)
    expect(width).toBe(THREAD_MIN)
    drag(handle(), -2000)
    expect(width).toBe(600)
    expect(localStorage.getItem(KEY)).toBe("600")
  })

  it("comes back at the saved width, and a double-click resets it", () => {
    localStorage.setItem(KEY, "700")
    mount(1000)
    expect(width).toBe(700)
    act(() => void handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
    expect(width).toBe(THREAD_ROOM)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("a saved width out of range loads clamped", () => {
    localStorage.setItem(KEY, "5000")
    mount()
    expect(width).toBe(THREAD_MAX)
  })

  it("the strip sits inside the panel, which clips while it grows", () => {
    mount()
    expect(handle().className).toContain("left-0")
    expect(handle().className).not.toContain("-left-[3px]")
  })
})

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("in Zen, the thread and ⤢ card panel", () => {
  /** A 1400px-wide Zen window (happy-dom lays nothing out). */
  function renderZen() {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1400, height: 900, top: 0, left: 0, right: 1400, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect)
    if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
    history.replaceState(null, "", ZEN_PATH)
    sessionStorage.setItem("box-yard:landed", "1")
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    const now = Date.now()
    qc.setQueryData(keys.me, { authed: true, authRequired: false })
    qc.setQueryData(keys.agentSettings, { settings: { startInZen: true, ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
    qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
    qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
    qc.setQueryData(keys.chat, [])
    qc.setQueryData(keys.chatBusy, false)
    for (const k of [keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  }
  const pane = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")!
  const sep = () => pane().querySelector("[role=separator]")
  const threadW = () => pane().style.getPropertyValue("--thread-w")

  it("has a drag edge where it's a column, by container query, and the width persists", () => {
    renderZen()
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    expect(threadW()).toBe(threadWidthCss(THREAD_ROOM))
    expect(sep()!.className).toContain("@min-[35.5rem]/coord:block")
    expect(sep()!.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):/) // no viewport breakpoints
    drag(sep()!, 800)
    expect(threadW()).toBe(threadWidthCss(THREAD_ROOM + 200))
    expect(localStorage.getItem(KEY)).toBe(String(THREAD_ROOM + 200))

    // A card opened with ⤢ uses the same width; so does a reload.
    act(() => openCard(COORDINATOR_CHAT, "task:task_abc123"))
    expect(pane().getAttribute("data-card")).toBe("task:task_abc123")
    expect(threadW()).toBe(threadWidthCss(THREAD_ROOM + 200))
    act(() => root.unmount())
    root = createRoot(host)
    renderZen()
    expect(threadW()).toBe(threadWidthCss(THREAD_ROOM + 200))
  })

  it("doesn't ease while its edge is dragged", () => {
    renderZen()
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    expect(pane().className).toContain("transition-[translate,width]")
    pointer(sep()!, "pointerdown", 1000)
    expect(pane().className).not.toContain("transition-[translate,width]")
    pointer(sep()!, "pointerup", 1000)
    expect(pane().className).toContain("transition-[translate,width]")
  })

  it("expanded over the whole chat, it has no edge to drag", () => {
    renderZen()
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    act(() => toggleExpanded(COORDINATOR_CHAT))
    expect(sep()).toBeNull()
    act(() => toggleExpanded(COORDINATOR_CHAT))
  })
})
