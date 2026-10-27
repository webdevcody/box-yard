import { describe, expect, it } from "vitest"
import { browseStep, HISTORY_LIMIT, HISTORY_SCOPES, promptHistoryKey, readHistory, rememberPrompt, type Browse, type KeyLike } from "../web/src/lib/promptHistory.js"

function memory() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods })

describe("prompt history", () => {
  it("keeps sent prompts newest first, per chat, trimmed", () => {
    const s = memory()
    rememberPrompt("coordinator", "one", s)
    rememberPrompt("coordinator", "  two \n", s)
    rememberPrompt("task:a", "other", s)
    expect(readHistory("coordinator", s)).toEqual(["two", "one"])
    expect(readHistory("task:a", s)).toEqual(["other"])
    expect(readHistory("task:b", s)).toEqual([])
  })

  it("skips a repeat of the newest prompt, but not of an older one", () => {
    const s = memory()
    for (const p of ["a", "b", "b", "a"]) rememberPrompt("c", p, s)
    expect(readHistory("c", s)).toEqual(["a", "b", "a"])
  })

  it("ignores empty prompts and a missing scope", () => {
    const s = memory()
    rememberPrompt("c", "   ", s)
    rememberPrompt(undefined, "x", s)
    expect(s.m.size).toBe(0)
    expect(readHistory(undefined, s)).toEqual([])
  })

  it(`keeps at most ${HISTORY_LIMIT} prompts`, () => {
    const s = memory()
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) rememberPrompt("c", `p${i}`, s)
    const list = readHistory("c", s)
    expect(list).toHaveLength(HISTORY_LIMIT)
    expect(list[0]).toBe(`p${HISTORY_LIMIT + 9}`)
  })

  it(`drops the chat used longest ago past ${HISTORY_SCOPES} chats`, () => {
    const s = memory()
    for (let i = 0; i <= HISTORY_SCOPES; i++) rememberPrompt(`task:${i}`, "hi", s)
    expect(s.m.has(promptHistoryKey("task:0"))).toBe(false)
    expect(readHistory("task:1", s)).toEqual(["hi"])
    // Using a chat again makes it recent.
    rememberPrompt("task:1", "again", s)
    rememberPrompt("task:new", "hi", s)
    expect(readHistory("task:1", s)).toEqual(["again", "hi"])
    expect(readHistory("task:2", s)).toEqual([])
  })

  it("survives broken or blocked storage", () => {
    const s = memory()
    s.setItem(promptHistoryKey("c"), "{not json")
    expect(readHistory("c", s)).toEqual([])
    const blocked = { getItem: () => null, setItem: () => { throw new Error("quota") }, removeItem: () => {} }
    expect(() => rememberPrompt("c", "x", blocked)).not.toThrow()
  })
})

describe("browseStep", () => {
  const list = ["newest", "middle", "oldest"]
  const history = () => list
  const at = (index: number): Browse => ({ index, text: list[index]! })

  it("Up walks older, stopping at the oldest; Down walks newer and back to empty", () => {
    let b: Browse = null
    const press = (k: string) => {
      const step = browseStep(b, key(k), true, history)
      b = step.browse
      return step
    }
    expect(press("ArrowUp")).toEqual({ browse: at(0), handled: true })
    expect(press("ArrowUp").browse).toEqual(at(1))
    expect(press("ArrowUp").browse).toEqual(at(2))
    expect(press("ArrowUp")).toEqual({ browse: at(2), handled: true })
    expect(press("ArrowDown").browse).toEqual(at(1))
    expect(press("ArrowDown").browse).toEqual(at(0))
    expect(press("ArrowDown")).toEqual({ browse: null, handled: true })
    // Not browsing: Down is the textarea's own.
    expect(press("ArrowDown")).toEqual({ browse: null, handled: false })
  })

  it("leaves Up alone with text in the box, no history, or a modifier", () => {
    expect(browseStep(null, key("ArrowUp"), false, history)).toEqual({ browse: null, handled: false })
    expect(browseStep(null, key("ArrowUp"), true, () => [])).toEqual({ browse: null, handled: false })
    expect(browseStep(null, key("ArrowUp", { shiftKey: true }), true, history).handled).toBe(false)
    expect(browseStep(null, key("ArrowUp", { metaKey: true }), true, history).handled).toBe(false)
    expect(browseStep(at(0), key("ArrowDown", { altKey: true }), true, history)).toEqual({ browse: at(0), handled: false })
  })

  it("doesn't read the history for keys that don't need it", () => {
    let reads = 0
    const counted = () => (reads++, list)
    browseStep(null, key("a"), true, counted)
    browseStep(null, key("Enter"), true, counted)
    browseStep(null, key("ArrowUp"), false, counted)
    expect(reads).toBe(0)
  })

  it("Enter takes the shown prompt instead of sending; Enter outside browsing sends as usual", () => {
    expect(browseStep(at(1), key("Enter"), true, history)).toEqual({ browse: null, handled: true, select: "middle" })
    expect(browseStep(null, key("Enter"), true, history)).toEqual({ browse: null, handled: false })
  })

  it("Shift+Enter, Backspace and Delete drop the ghost and keep their normal meaning", () => {
    for (const k of [key("Enter", { shiftKey: true }), key("Backspace"), key("Delete")]) {
      expect(browseStep(at(0), k, true, history)).toEqual({ browse: null, handled: false })
    }
  })

  it("Escape clears the ghost (and is used up); without one it passes through", () => {
    expect(browseStep(at(2), key("Escape"), true, history)).toEqual({ browse: null, handled: true })
    expect(browseStep(null, key("Escape"), true, history)).toEqual({ browse: null, handled: false })
  })

  it("keys that don't change the text keep the ghost", () => {
    for (const k of ["ArrowLeft", "Shift", "Home"]) expect(browseStep(at(1), key(k), true, history)).toEqual({ browse: at(1), handled: false })
  })

  it("copes with a history that shrank meanwhile (another tab)", () => {
    expect(browseStep({ index: 5, text: "gone" }, key("ArrowDown"), true, history).browse).toEqual(at(2))
    expect(browseStep({ index: 5, text: "gone" }, key("ArrowUp"), true, history).browse).toEqual(at(2))
  })
})
