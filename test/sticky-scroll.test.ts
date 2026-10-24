// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { StickyScroll } from "../web/src/components/StickyScroll.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom has no layout, so this models one: rows stack by their data-h height inside a 400px
// viewport. Like a browser, writing scrollTop clamps it and fires one scroll event later (flush()),
// with whatever position it has by then.

const VIEW = 400

class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>()
  constructor(private cb: () => void) {
    FakeResizeObserver.all.add(this)
  }
  observe() {}
  disconnect() {
    FakeResizeObserver.all.delete(this)
  }
}

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
}

let root: Root
let host: HTMLElement
let scroller: HTMLElement
let content: HTMLElement
let top = 0
let dispatched = 0

const rows = () => [...content.children] as HTMLElement[]
const height = (el: Element) => Number((el as HTMLElement).dataset.h ?? 0)
const contentHeight = () => rows().reduce((sum, r) => sum + height(r), 0)
const max = () => Math.max(0, contentHeight() - VIEW)
const atBottom = () => top === max()
const jumpButton = () => [...host.querySelectorAll("button")].find((b) => /latest|new message/.test(b.textContent ?? ""))

function rowTop(el: Element) {
  let y = 0
  for (const r of rows()) {
    if (r === el) break
    y += height(r)
  }
  return y - top
}

function installLayout() {
  scroller = host.querySelector<HTMLElement>(".overflow-y-auto")!
  content = scroller.firstElementChild as HTMLElement
  Object.defineProperties(scroller, {
    clientHeight: { get: () => VIEW },
    scrollHeight: { get: () => Math.max(VIEW, contentHeight()) },
    scrollTop: {
      get: () => top,
      set: (v: number) => {
        top = Math.min(max(), Math.max(0, v))
      },
    },
  })
  scroller.scrollTo = ((opts: ScrollToOptions) => {
    scroller.scrollTop = opts.top ?? 0
  }) as typeof scroller.scrollTo
}

// The browser's frame: scroll events first, then resize observers.
const flush = () =>
  act(() => {
    if (top !== dispatched) {
      dispatched = top
      scroller.dispatchEvent(new Event("scroll"))
    }
  })
const observe = () => act(() => FakeResizeObserver.all.forEach((ro) => (ro as unknown as { cb: () => void }).cb()))
const frame = () => {
  flush()
  observe()
  flush()
}

// The user moves the list (wheel, drag, keys): the position changes, the event comes later.
const userScroll = (dy: number) => {
  scroller.scrollTop = top + dy
}

function Thread({ heights }: { heights: number[] }) {
  return createElement(
    StickyScroll,
    { count: heights.length, children: heights.map((h, i) => createElement("div", { key: i, "data-h": h }, `row ${i}`)) },
  )
}

let heights: number[]
const render = () => act(() => root.render(createElement(Thread, { heights: [...heights] })))

// One streamed chunk: the last row grows, then the frame runs.
function streamDelta(px = 30) {
  heights[heights.length - 1]! += px
  render()
  frame()
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const y = this === scroller ? 0 : rowTop(this)
    const h = this === scroller ? VIEW : height(this)
    return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} } as DOMRect
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  top = 0
  dispatched = 0
  heights = Array.from({ length: 20 }, () => 100)
  render()
  installLayout()
  // Mounting scrolled before the fake layout existed; start pinned at the bottom.
  scroller.scrollTop = max()
  frame()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  FakeResizeObserver.all.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("StickyScroll", () => {
  it("follows streamed text while pinned to the bottom", () => {
    for (let i = 0; i < 5; i++) streamDelta()
    expect(atBottom()).toBe(true)
    expect(jumpButton()).toBeUndefined()
  })

  it("a 1px wheel nudge up unpins, and streaming then never moves the view", () => {
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })))
    userScroll(-1)
    const reading = top
    for (let i = 0; i < 10; i++) streamDelta()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("wins the race when a chunk lands between the wheel and its scroll", () => {
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true })))
    const before = top
    // The stream grows and the resize observer runs before the browser applies the wheel.
    heights[heights.length - 1]! += 30
    render()
    observe()
    expect(top).toBe(before)
    userScroll(-40)
    frame()
    expect(top).toBe(before - 40)
    streamDelta()
    expect(top).toBe(before - 40)
  })

  it("a small scroll up without a wheel (scrollbar drag, momentum) unpins on its scroll event", () => {
    userScroll(-10)
    flush()
    const reading = top
    for (let i = 0; i < 5; i++) streamDelta()
    expect(top).toBe(reading)
  })

  it("PageUp, ↑ and Home unpin before the scroll they cause arrives", () => {
    for (const key of ["PageUp", "ArrowUp", "Home"]) {
      act(() => void scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
      // Focus stays on <body> after clicking text in the list.
      act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })))
      const before = top
      heights[heights.length - 1]! += 30
      render()
      observe()
      expect(top, key).toBe(before)
      // Back to the bottom re-pins for the next key.
      scroller.scrollTop = max()
      frame()
      expect(jumpButton(), key).toBeUndefined()
    }
  })

  it("ignores scroll keys typed in the composer or after clicking elsewhere", () => {
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    act(() => void textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })))
    act(() => void document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })))
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("a finger dragging down unpins on touch", () => {
    const touch = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true })
      Object.defineProperty(e, "touches", { value: [{ clientX: 100, clientY: y }] })
      act(() => void scroller.dispatchEvent(e))
    }
    touch("touchstart", 200)
    touch("touchmove", 203)
    const before = top
    heights[heights.length - 1]! += 30
    render()
    observe()
    expect(top).toBe(before)
  })

  it("our own scrollTop writes never count as the user scrolling", () => {
    // Every follow write fires a scroll event; none of them unpin.
    for (let i = 0; i < 5; i++) streamDelta()
    expect(jumpButton()).toBeUndefined()

    // A write's scroll event arriving after the user unpinned (before their scroll applied) doesn't re-pin.
    heights[heights.length - 1]! += 30
    render()
    observe() // follow write, its event still queued
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -5, bubbles: true })))
    act(() => void scroller.dispatchEvent(new Event("scroll")))
    dispatched = top
    const reading = top
    streamDelta()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("stays pinned when the list gets shorter and the browser pulls scrollTop down", () => {
    heights.pop()
    render()
    scroller.scrollTop = top // the browser clamps to the new bottom
    frame()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("returning to the very bottom re-pins and following resumes", () => {
    userScroll(-200)
    frame()
    expect(jumpButton()).toBeDefined()
    userScroll(199)
    frame()
    expect(jumpButton(), "1px short is still away").toBeDefined()
    userScroll(1)
    frame()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("Jump to latest re-pins and follows", () => {
    userScroll(-300)
    frame()
    streamDelta()
    act(() => jumpButton()!.click())
    frame()
    expect(atBottom()).toBe(true)
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("holds the row being read still when content above it grows", () => {
    userScroll(-600)
    frame()
    const reading = rows().find((r) => rowTop(r) + height(r) > 0)!
    const offset = rowTop(reading)
    // A row above the view expands (a browser without scroll anchoring wouldn't compensate).
    heights[2]! += 120
    render()
    frame()
    expect(rowTop(reading)).toBe(offset)
    expect(jumpButton()).toBeDefined()
  })

  it("a wheel inside a nested scroller that can still scroll up leaves the list pinned", () => {
    const inner = rows()[rows().length - 1]!
    Object.defineProperties(inner, {
      scrollTop: { value: 50 },
      scrollHeight: { value: 300 },
      clientHeight: { value: 100 },
    })
    inner.style.overflowY = "auto"
    act(() => void inner.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true })))
    streamDelta()
    expect(atBottom()).toBe(true)
  })
})
