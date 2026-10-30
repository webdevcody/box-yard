// @vitest-environment happy-dom
// The project picker's pieces: the chat switcher's filter ranking, its P hotkey, and the project bar's pins in
// localStorage.
import { beforeEach, describe, expect, it } from "vitest"
import { isProjectPickerKey, rankChats } from "../web/src/lib/chatSwitch.js"
import { PINS_KEY, chatProjectFilter, pickProject, pinProject, readPins, setChatProjectFilter, unpinProject } from "../web/src/lib/projectBar.js"

const chats = [
  { label: "Coordinator", aliases: ["All"] },
  { label: "survive-the-night" },
  { label: "nebula" },
  { label: "box-yard" },
  { label: "workouts" },
  { label: "webdevcody" },
  { label: "health" },
]
const rank = (q: string) => rankChats(chats, q).map((c) => c.label)

describe("rankChats", () => {
  it("keeps every chat, in order, with nothing typed", () => {
    expect(rank("")).toEqual(chats.map((c) => c.label))
    expect(rank("   ")).toEqual(chats.map((c) => c.label))
  })

  it("puts a prefix first, then word starts and substrings; drops what doesn't match", () => {
    expect(rank("w")[0]).toBe("workouts")
    expect(rank("w")).toEqual(["workouts", "webdevcody"])
    expect(rank("yard")).toEqual(["box-yard"])
    expect(rank("night")).toEqual(["survive-the-night"])
    expect(rank("BOX")).toEqual(["box-yard"])
    expect(rank("qq")).toEqual([])
  })

  it("matches word initials and fuzzy subsequences", () => {
    expect(rank("stn")[0]).toBe("survive-the-night")
    expect(rank("by")[0]).toBe("box-yard")
    expect(rank("wdc")[0]).toBe("webdevcody")
  })

  it("an alias counts, but less than a name: 'a' is alpha's before the Coordinator's 'All'", () => {
    expect(rank("all")[0]).toBe("Coordinator")
    expect(rankChats([{ label: "Coordinator", aliases: ["All"] }, { label: "alpha" }], "a").map((c) => c.label)).toEqual(["alpha", "Coordinator"])
  })

  it("keeps the menu's order on a tie", () => {
    expect(rankChats([{ label: "map b" }, { label: "map a" }], "map").map((c) => c.label)).toEqual(["map b", "map a"])
  })
})

describe("isProjectPickerKey", () => {
  const ev = (init: Partial<KeyboardEvent> & { target?: EventTarget | null } = {}) =>
    ({ key: "p", metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, repeat: false, isComposing: false, target: document.body, ...init }) as KeyboardEvent

  it("is P (either case) with no modifier, outside text fields", () => {
    expect(isProjectPickerKey(ev())).toBe(true)
    expect(isProjectPickerKey(ev({ key: "P" }))).toBe(true)
    expect(isProjectPickerKey(ev({ key: "o" }))).toBe(false)
    expect(isProjectPickerKey(ev({ key: "/" }))).toBe(false)
  })

  it("backs off with ⌘/Ctrl/Alt, held down, mid-composition, already handled, or in a field", () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }])
      expect(isProjectPickerKey(ev(init))).toBe(false)
    for (const tag of ["input", "textarea", "select"]) expect(isProjectPickerKey(ev({ target: document.createElement(tag) }))).toBe(false)
    const editable = document.createElement("div")
    editable.setAttribute("contenteditable", "true")
    const inside = document.createElement("span")
    editable.append(inside)
    expect(isProjectPickerKey(ev({ target: inside }))).toBe(false)
  })
})

describe("project bar pins", () => {
  beforeEach(() => {
    localStorage.clear()
    setChatProjectFilter(null)
  })

  it("are remembered in localStorage, the newest say winning", () => {
    expect(readPins()).toEqual({})
    pinProject("prj_a")
    unpinProject("prj_b")
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual({ prj_a: "pinned", prj_b: "unpinned" })
    unpinProject("prj_a")
    expect(readPins()).toEqual({ prj_a: "unpinned", prj_b: "unpinned" })
  })

  it("read the same object back until they change, so React doesn't re-render for nothing", () => {
    pinProject("prj_a")
    expect(readPins()).toBe(readPins())
    const before = readPins()
    pinProject("prj_a")
    expect(readPins()).toBe(before)
    pinProject("prj_b")
    expect(readPins()).not.toBe(before)
  })

  it("ignore a corrupt or foreign value", () => {
    localStorage.setItem(PINS_KEY, "{not json")
    expect(readPins()).toEqual({})
    localStorage.setItem(PINS_KEY, JSON.stringify({ prj_a: "pinned", prj_b: "maybe", prj_c: 3 }))
    expect(readPins()).toEqual({ prj_a: "pinned" })
    localStorage.setItem(PINS_KEY, "[1,2]")
    expect(readPins()).toEqual({})
  })

  it("picking pins and filters; unpinning the filtered project clears the filter, another one doesn't", () => {
    pickProject("prj_a")
    expect(readPins()).toEqual({ prj_a: "pinned" })
    expect(chatProjectFilter()).toBe("prj_a")
    unpinProject("prj_b")
    expect(chatProjectFilter()).toBe("prj_a")
    unpinProject("prj_a")
    expect(chatProjectFilter()).toBeNull()
  })
})
