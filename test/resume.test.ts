// @vitest-environment happy-dom
// A phone's home-screen app is frozen in the background and thawed later, never reloaded. These are the
// guards that put things right when it comes back (lib/resume.ts, lib/stream.ts, lib/tapDebug.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { installPageGuards, onResume, onSuspend, resetDocumentScroll, resetResumeState } from "../web/src/lib/resume.js"
import { STALE_STREAM_MS, useServerEvents } from "../web/src/lib/stream.js"
import { keys } from "../web/src/lib/queries.js"
import { clearStalls, recordStall, showReport, tapReport } from "../web/src/lib/tapDebug.js"
import { trimmedStart } from "../web/src/lib/tail.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let hidden = false
function setHidden(h: boolean) {
  hidden = h
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  hidden = false
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
  resetResumeState()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("onResume / onSuspend", () => {
  it("reports going away and coming back, with how long it was away", () => {
    vi.useFakeTimers()
    const away: number[] = []
    let suspends = 0
    const off = onResume((ms) => away.push(ms))
    const offS = onSuspend(() => suspends++)
    setHidden(true)
    vi.advanceTimersByTime(45_000)
    setHidden(false)
    expect(suspends).toBe(1)
    expect(away).toEqual([45_000])
    // Visible again without having been hidden: nothing to resume from.
    setHidden(false)
    expect(away).toHaveLength(1)
    off()
    offS()
  })

  it("a page restored from the back/forward cache counts as a resume", () => {
    const away: number[] = []
    const off = onResume((ms) => away.push(ms))
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))
    expect(away).toEqual([0])
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }))
    expect(away).toHaveLength(1)
    off()
  })
})

describe("resetDocumentScroll", () => {
  it("puts back a document the keyboard left scrolled, unless a field still has focus", () => {
    document.body.scrollTop = 120
    const input = document.createElement("textarea")
    document.body.append(input)
    input.focus()
    expect(resetDocumentScroll()).toBe(false)
    input.blur()
    expect(resetDocumentScroll()).toBe(true)
    expect(document.body.scrollTop).toBe(0)
    expect(resetDocumentScroll()).toBe(false)
  })

  it("runs after a field loses focus (the keyboard closing) and when the page comes back", () => {
    vi.useFakeTimers()
    const uninstall = installPageGuards()
    const input = document.createElement("textarea")
    document.body.append(input)
    input.focus()
    document.body.scrollTop = 200
    input.blur()
    expect(document.body.scrollTop).toBe(200)
    vi.advanceTimersByTime(500)
    expect(document.body.scrollTop).toBe(0)

    document.body.scrollTop = 80
    setHidden(true)
    setHidden(false)
    expect(document.body.scrollTop).toBe(0)
    uninstall()
  })
})

class FakeEventSource {
  static all: FakeEventSource[] = []
  static OPEN = 1
  static CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
}

describe("useServerEvents after a resume", () => {
  let root: Root
  let qc: QueryClient
  const latest = () => FakeEventSource.all.at(-1)!

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.all = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    // Frames never come (as on a page iOS just thawed); the fallback timer must apply events anyway.
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    function Probe() {
      useServerEvents(true)
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe))))
    act(() => latest().open())
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it("keeps an open stream after a short trip away", () => {
    setHidden(true)
    vi.advanceTimersByTime(5000)
    act(() => setHidden(false))
    expect(FakeEventSource.all).toHaveLength(1)
    expect(latest().closed).toBe(false)
  })

  it("replaces a stream that sat frozen a while, even if it still says it's open, and refetches", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    setHidden(true)
    vi.advanceTimersByTime(STALE_STREAM_MS + 1000)
    act(() => setHidden(false))
    expect(FakeEventSource.all).toHaveLength(2)
    expect(FakeEventSource.all[0]!.closed).toBe(true)
    act(() => latest().open())
    expect(invalidate).toHaveBeenCalled()
  })

  it("reconnects at once when the stream died while away, instead of waiting for the retry", () => {
    act(() => latest().onerror?.())
    expect(FakeEventSource.all).toHaveLength(1)
    setHidden(true)
    act(() => setHidden(false))
    expect(FakeEventSource.all).toHaveLength(2)
    // The pending retry was cancelled, so there's no second reconnect.
    vi.advanceTimersByTime(5000)
    expect(FakeEventSource.all).toHaveLength(2)
  })

  it("applies events even when no animation frame comes", () => {
    qc.setQueryData(keys.chatBusy, false)
    act(() => latest().onmessage?.({ data: JSON.stringify({ type: "chat.busy", busy: true }) }))
    expect(qc.getQueryData(keys.chatBusy)).toBe(false)
    act(() => void vi.advanceTimersByTime(300))
    expect(qc.getQueryData(keys.chatBusy)).toBe(true)
  })
})

describe("trimmedStart", () => {
  it("drops back to the newest items once more than twice that many are rendered", () => {
    expect(trimmedStart(500, 379, 60)).toBe(440)
    expect(trimmedStart(500, 380, 60)).toBeNull()
    expect(trimmedStart(500, 440, 60)).toBeNull()
    // A page of older items loaded on top of the newest 60 stays.
    expect(trimmedStart(500, 390, 60)).toBeNull()
    expect(trimmedStart(50, 0, 60)).toBeNull()
  })
})

describe("tap debug report", () => {
  it("says what's on top at each finger, and the longest recent main-thread stall", () => {
    clearStalls()
    const overlay = document.createElement("div")
    overlay.className = "fixed inset-0 z-50"
    overlay.setAttribute("role", "dialog")
    document.body.append(overlay)
    vi.spyOn(document, "elementFromPoint").mockReturnValue(overlay)
    expect(tapReport([{ x: 10, y: 20 }]).join("\n")).toContain('(10,20) div.fixed.inset-0.z-50 "dialog"')
    expect(tapReport([]).join("\n")).toContain("dialogs: 1")
    expect(tapReport([]).at(-1)).toBe("main thread: no stalls in 10 min")
    recordStall(1500)
    recordStall(4200)
    recordStall(9000, Date.now() - 11 * 60_000)
    expect(tapReport([]).at(-1)).toBe("main thread blocked 2× in 10 min, longest 4.2 s")
    clearStalls()
  })

  it("shows every line of the report in a panel that a tap closes", () => {
    const panel = showReport(["(10,20) div.a", "dialogs: 0", "main thread: no stalls in 10 min"])
    expect(document.getElementById("boxyard-tap-debug")).toBe(panel)
    expect(panel.textContent).toContain("dialogs: 0\nmain thread: no stalls in 10 min")
    showReport(["again"])
    expect(document.querySelectorAll("#boxyard-tap-debug")).toHaveLength(1)
    document.getElementById("boxyard-tap-debug")!.click()
    expect(document.getElementById("boxyard-tap-debug")).toBeNull()
  })
})
