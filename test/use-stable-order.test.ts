// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { IDLE_MS, useStableOrder, type StableOrder } from "../web/src/lib/useStableOrder.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Item {
  id: string
  score: number
  open?: boolean
}

let root: Root
let host: HTMLElement
let result: StableOrder<Item>

function Probe({ items, resetKey }: { items: Item[]; resetKey?: string }) {
  result = useStableOrder(items, {
    key: (i) => i.id,
    compare: (a, b) => b.score - a.score,
    include: (i) => i.open !== false,
    resetKey,
  })
  return createElement(
    "div",
    { ref: result.listRef },
    result.entries.map((e) => createElement("div", { key: e.item.id, "data-stable-key": e.item.id }, e.item.id)),
  )
}

function render(items: Item[], resetKey?: string) {
  act(() => root.render(createElement(Probe, { items, resetKey })))
}
const shown = () => result.entries.map((e) => e.item.id)

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const start = [
  { id: "a", score: 3 },
  { id: "b", score: 2 },
  { id: "c", score: 1 },
]

describe("useStableOrder", () => {
  it("sorts on mount, then holds the order through live updates", () => {
    render([...start].reverse())
    expect(shown()).toEqual(["a", "b", "c"])
    render([{ id: "a", score: 3 }, { id: "b", score: 2 }, { id: "c", score: 9 }])
    expect(shown()).toEqual(["a", "b", "c"])
    expect(result.entries[2]!.item.score).toBe(9)
    expect(result.changedCount).toBe(1)
  })

  it("counts new items instead of inserting them, and keeps stale ones in place", () => {
    render(start)
    render([{ id: "a", score: 3 }, { id: "b", score: 2, open: false }, { id: "c", score: 1 }, { id: "d", score: 7 }])
    expect(shown()).toEqual(["a", "b", "c"])
    expect(result.entries[1]!.stale).toBe(true)
    expect(result).toMatchObject({ newCount: 1, changedCount: 1 })
  })

  it("applies the order on resort()", () => {
    render(start)
    render([{ id: "a", score: 3 }, { id: "b", score: 2, open: false }, { id: "c", score: 9 }, { id: "d", score: 7 }])
    act(() => result.resort())
    expect(shown()).toEqual(["c", "d", "a"])
    expect(result).toMatchObject({ newCount: 0, changedCount: 0 })
  })

  it("re-sorts when the resetKey (sort, filter, search) changes", () => {
    render(start, "x")
    const live = [{ id: "a", score: 1 }, { id: "b", score: 2 }, { id: "c", score: 3 }]
    render(live, "x")
    expect(shown()).toEqual(["a", "b", "c"])
    render(live, "y")
    expect(shown()).toEqual(["c", "b", "a"])
  })

  it("takes the fresh order when nothing is on screen yet (first load)", () => {
    render([])
    render(start)
    expect(shown()).toEqual(["a", "b", "c"])
    expect(result.newCount).toBe(0)
  })

  it("re-sorts on its own when the list is left alone, but not while hovered", () => {
    vi.useFakeTimers()
    render(start)
    const list = host.firstElementChild as HTMLElement
    const hovered = vi.spyOn(list, "matches").mockImplementation((sel: string) => sel === ":hover")
    render([{ id: "a", score: 3 }, { id: "b", score: 2 }, { id: "c", score: 9 }])
    act(() => vi.advanceTimersByTime(IDLE_MS * 2))
    expect(shown()).toEqual(["a", "b", "c"])

    hovered.mockReturnValue(false)
    act(() => {
      list.dispatchEvent(new Event("pointerleave"))
      vi.advanceTimersByTime(IDLE_MS)
    })
    expect(shown()).toEqual(["c", "a", "b"])
  })
})
