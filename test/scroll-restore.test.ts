// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { StickyScroll } from "../web/src/components/StickyScroll.js"
import { keepScrollOnNextBack, readSpot, resetScrollMemory, saveSpot } from "../web/src/lib/scrollMemory.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The same model as sticky-scroll.test.ts: rows stack by their data-h height in a 400px viewport, and writing
// scrollTop clamps it and fires one scroll event later (flush()). Rows get ids like chat messages do.

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
let top = 0
let dispatched = 0
let heights: number[]
let ids = true

// The list's elements, found fresh: a remount makes new ones.
const isScroller = (el: Element) => el.classList.contains("overflow-y-auto")
const scrollerEl = () => document.querySelector<HTMLElement>(".overflow-y-auto")!
let scroller: HTMLElement
const rows = () => [...(scrollerEl()?.firstElementChild?.children ?? [])] as HTMLElement[]
const height = (el: Element) => Number((el as HTMLElement).dataset.h ?? 0)
const contentHeight = () => rows().reduce((sum, r) => sum + height(r), 0)
const max = () => Math.max(0, contentHeight() - VIEW)
const row = (i: number) => rows().find((r) => r.textContent === `row ${i}`)!

function rowTop(el: Element) {
  let y = 0
  for (const r of rows()) {
    if (r === el) break
    y += height(r)
  }
  return y - top
}

// On the prototype, so the layout is there from the first render of every mount.
const PROPS = ["clientHeight", "scrollHeight", "scrollTop"] as const
// Own getters on HTMLElement.prototype, over happy-dom's further down the chain (removed again after each test).
const inherited = (k: string) => {
  for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, k)
    if (d) return d
  }
  return { get: () => 0, set: () => {} }
}
function installLayout() {
  const orig = Object.fromEntries(PROPS.map((k) => [k, inherited(k)]))
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: Element) { return isScroller(this) ? VIEW : orig.clientHeight.get!.call(this) } },
    scrollHeight: { configurable: true, get(this: Element) { return isScroller(this) ? Math.max(VIEW, contentHeight()) : orig.scrollHeight.get!.call(this) } },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return isScroller(this) ? top : orig.scrollTop.get!.call(this)
      },
      set(this: Element, v: number) {
        if (isScroller(this)) top = Math.min(max(), Math.max(0, v))
        else orig.scrollTop.set!.call(this, v)
      },
    },
  })
}

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

function Thread({ heights }: { heights: number[] }) {
  return createElement(StickyScroll, {
    count: heights.length,
    restoreKey: "chat",
    children: heights.map((h, i) => createElement("div", { key: i, id: ids ? `chat-m${i}` : undefined, "data-h": h }, `row ${i}`)),
  })
}

const render = () => act(() => root.render(createElement(Thread, { heights: [...heights] })))

function mount() {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  render()
  scroller = scrollerEl()
  scroller.scrollTo = ((opts: ScrollToOptions) => {
    scroller.scrollTop = opts.top ?? 0
  }) as typeof scroller.scrollTo
  frame()
}

function unmount() {
  act(() => root.unmount())
  host.remove()
}

// The router: a link pushes (wouter's patched pushState fires "pushState"), Back pops. The unpatched History
// methods change the URL, so each move fires exactly the event it would in a browser.
const go = (to: string) =>
  act(() => {
    History.prototype.pushState.call(history, null, "", to)
    dispatchEvent(new Event("pushState"))
  })
const back = (to: string) =>
  act(() => {
    History.prototype.replaceState.call(history, null, "", to)
    dispatchEvent(new PopStateEvent("popstate"))
  })

// The browser after a layout change: the list got shorter, so scrollTop is clamped, and its event comes later.
function relayout(h: number) {
  heights = heights.map(() => h)
  render()
  scroller.scrollTop = top
  frame()
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)))

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const y = isScroller(this) ? 0 : rowTop(this)
    const h = isScroller(this) ? VIEW : height(this)
    return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} } as DOMRect
  })
  installLayout()
  History.prototype.replaceState.call(history, null, "", "/zen")
  resetScrollMemory()
  top = 0
  dispatched = 0
  ids = true
  heights = Array.from({ length: 20 }, () => 100)
  mount()
})

afterEach(() => {
  if (host.isConnected) unmount()
  document.body.innerHTML = ""
  FakeResizeObserver.all.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const k of PROPS) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
})

// Scroll up so row 13 is at the top of the view (top 1300 of 1600).
function readRow13() {
  scroller.scrollTop = 1300
  flush()
  expect(rowTop(row(13))).toBe(0)
}

describe("StickyScroll restoreKey", () => {
  it("Back puts the row being read where it was, even when the browser clamped the list to its bottom", () => {
    readRow13()
    go("/tasks/a")
    // The narrower side panel: every row wraps taller, and the list holds row 13 at the top (scrollTop 2600).
    relayout(200)
    expect(top).toBe(2600)
    // Back to Zen: the column is wide again and the list half as tall, so the browser clamps scrollTop to the
    // bottom (1600). Safari did that, and the list then took it for the user coming back to the bottom.
    back("/zen")
    relayout(100)
    expect(rowTop(row(13))).toBe(0)
    expect(top).toBe(1300)
    expect(host.textContent).toContain("Jump to latest")
  })

  it("late layout after the restore (markdown, images) doesn't knock it off", () => {
    readRow13()
    go("/tasks/a")
    back("/zen")
    // A row above the one being read grows after the restore.
    heights[2] = 400
    render()
    frame()
    expect(rowTop(row(13))).toBe(0)
  })

  it("new messages arriving after Back don't pull the view down", () => {
    readRow13()
    go("/tasks/a")
    back("/zen")
    heights.push(100, 100, 100)
    render()
    frame()
    expect(rowTop(row(13))).toBe(0)
    expect(host.textContent).toContain("3 new messages")
  })

  it("a list that was at the bottom comes back to the bottom, new messages included", () => {
    go("/tasks/a")
    scroller.scrollTop = 0
    flush()
    back("/zen")
    heights.push(100, 100)
    relayout(100)
    expect(top).toBe(max())
    expect(host.textContent).not.toContain("Jump to latest")
  })

  it("a list that remounts on Back finds the row by its id", () => {
    readRow13()
    go("/tasks/a")
    unmount()
    back("/zen")
    top = 0
    dispatched = 0
    mount()
    expect(rowTop(row(13))).toBe(0)
  })

  it("without ids it comes back to the same distance from the bottom", () => {
    unmount()
    ids = false
    top = 0
    mount()
    readRow13()
    go("/tasks/a")
    unmount()
    back("/zen")
    top = 0
    dispatched = 0
    mount()
    expect(top).toBe(1300)
  })

  it("a link to the page (not Back) starts at the bottom", () => {
    readRow13()
    go("/tasks/a")
    unmount()
    go("/zen")
    top = 0
    dispatched = 0
    mount()
    expect(top).toBe(max())
  })

  it("leaving Zen with Esc (keepScrollOnNextBack) keeps the chat where it is", () => {
    go("/boxes")
    go("/zen")
    readRow13()
    keepScrollOnNextBack()
    back("/boxes")
    frame()
    expect(top).toBe(1300)
  })

  it("the user scrolling during the restore wins", async () => {
    readRow13()
    go("/tasks/a")
    relayout(200)
    back("/zen")
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
    scroller.scrollTop = 500
    flush()
    relayout(100)
    await settle()
    expect(rowTop(row(13))).not.toBe(0)
    expect(top).toBeLessThan(1300)
  })
})

describe("scrollMemory", () => {
  it("keeps spots per list and page in sessionStorage, without the element", () => {
    const node = document.createElement("div")
    saveSpot("chat", "/zen", { bottom: false, fromBottom: 700, id: "chat-m3", offset: 12, node, nodeOffset: 4 })
    expect(readSpot("chat", "/zen")?.node).toBe(node)
    const stored = JSON.parse(sessionStorage.getItem("box-yard:scroll")!)
    expect(stored["chat@/zen"]).toEqual({ bottom: false, fromBottom: 700, id: "chat-m3", offset: 12 })
    expect(readSpot("chat", "/boxes")).toBeNull()
    expect(readSpot("captain", "/zen")).toBeNull()
  })

  it("keeps only the newest 50 spots", () => {
    for (let i = 0; i < 60; i++) saveSpot("chat", `/p${i}`, { bottom: true, fromBottom: 0 })
    const stored = JSON.parse(sessionStorage.getItem("box-yard:scroll")!)
    expect(Object.keys(stored)).toHaveLength(50)
    expect(stored["chat@/p9"]).toBeUndefined()
    expect(stored["chat@/p59"]).toBeDefined()
  })
})
