import { describe, expect, it } from "vitest"
import { freshOrder, hasPending, longestIncreasing, pendingLabel, stableView, type StableOptions } from "../web/src/lib/stableOrder.js"

interface Item {
  id: string
  score: number
  open?: boolean
}
const opts: StableOptions<Item, string> = {
  key: (i) => i.id,
  compare: (a, b) => b.score - a.score,
  include: (i) => i.open !== false,
}
const ids = (xs: { item: Item }[]) => xs.map((x) => x.item.id)

describe("stableView", () => {
  const frozen = freshOrder([{ id: "a", score: 3 }, { id: "b", score: 2 }, { id: "c", score: 1 }], opts)

  it("keeps the frozen order while the live items change", () => {
    const live = [{ id: "a", score: 3 }, { id: "b", score: 2 }, { id: "c", score: 9 }]
    const view = stableView(frozen, live, opts)
    expect(ids(view.entries)).toEqual(["a", "b", "c"])
    // The live item is rendered, the frozen one is kept as `was`.
    expect(view.entries[2]).toMatchObject({ item: { score: 9 }, was: { score: 1 }, stale: false })
    // Only c has to move to get to c, a, b.
    expect(view).toMatchObject({ newCount: 0, changedCount: 1 })
  })

  it("has nothing pending when the order still holds", () => {
    const view = stableView(frozen, [{ id: "a", score: 30 }, { id: "b", score: 20 }, { id: "c", score: 10 }], opts)
    expect(view).toMatchObject({ newCount: 0, changedCount: 0 })
    expect(hasPending(view)).toBe(false)
  })

  it("counts new items without inserting them", () => {
    const view = stableView(frozen, [...frozen, { id: "d", score: 99 }, { id: "e", score: 0, open: false }], opts)
    expect(ids(view.entries)).toEqual(["a", "b", "c"])
    // e doesn't match the filter, so it isn't new to this list.
    expect(view).toMatchObject({ newCount: 1, changedCount: 0 })
    expect(hasPending(view)).toBe(true)
  })

  it("keeps items that stop matching in place, marked stale and counted", () => {
    const view = stableView(frozen, [{ id: "a", score: 3 }, { id: "b", score: 2, open: false }, { id: "c", score: 1 }], opts)
    expect(ids(view.entries)).toEqual(["a", "b", "c"])
    expect(view.entries.map((e) => e.stale)).toEqual([false, true, false])
    expect(view.changedCount).toBe(1)
  })

  it("skips items that are gone, and puts them back in place when they return", () => {
    expect(ids(stableView(frozen, [{ id: "a", score: 3 }, { id: "c", score: 1 }], opts).entries)).toEqual(["a", "c"])
    expect(ids(stableView(frozen, [{ id: "c", score: 1 }, { id: "b", score: 2 }, { id: "a", score: 3 }], opts).entries)).toEqual(["a", "b", "c"])
  })

  it("re-sorting (a fresh freeze) applies the new order, drops stale items and shows new ones", () => {
    const live = [{ id: "a", score: 3 }, { id: "b", score: 2, open: false }, { id: "c", score: 9 }, { id: "d", score: 5 }]
    const view = stableView(freshOrder(live, opts), live, opts)
    expect(ids(view.entries)).toEqual(["c", "d", "a"])
    expect(view).toMatchObject({ newCount: 0, changedCount: 0 })
  })
})

describe("longestIncreasing", () => {
  it("finds the longest run already in order", () => {
    expect(longestIncreasing([])).toBe(0)
    expect(longestIncreasing([0, 1, 2, 3])).toBe(4)
    expect(longestIncreasing([3, 0, 1, 2])).toBe(3)
    expect(longestIncreasing([3, 2, 1, 0])).toBe(1)
    expect(longestIncreasing([1, 0, 3, 2, 5, 4])).toBe(3)
  })
})

describe("pendingLabel", () => {
  it("describes what a re-sort would do", () => {
    expect(pendingLabel(0, 0)).toBe("")
    expect(pendingLabel(2, 0)).toBe("↑ 2 new")
    expect(pendingLabel(0, 3)).toBe("3 updated")
    expect(pendingLabel(2, 3)).toBe("2 new · 3 updated")
  })
})
