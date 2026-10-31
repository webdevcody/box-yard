// @vitest-environment happy-dom
// The Coordinator chat's project bar: a chip per busy project in its colour, filtering the cards to that project, and
// task tiles leading task links.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatPanel } from "../web/src/components/ChatPanel.js"
import { PINS_KEY, centredScrollLeft, pickProject, readPins, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { keys } from "../web/src/lib/queries.js"
import { projectColors } from "../shared/projectColors.js"
import type { ChatMessage, Project, Task, TaskStatus } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

const project = (id: string, name: string, createdAt: number, extra: Partial<Project> = {}) =>
  ({ id, name, repo: null, description: "", envKeys: [], notes: [], identityId: "default", runner: "box", createdAt, color: null, ...extra }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title, status, prompt: "", previews: [], waitFor: [], createdAt: 1, updatedAt: 1, ...extra }) as unknown as Task

const YARD = project("prj_yard0001", "box-yard", 1)
const MAP = project("prj_map00001", "Map 3", 2, { color: "orange" })
const QUIET = project("prj_quiet001", "Quiet", 3)
const LOGIN = task("task_login001", YARD.id, "Fix login", "needs_input")
const CARDS = task("task_cards001", YARD.id, "Coordinator cards", "working", { icon: "layers" })
const LEVEL = task("task_level001", MAP.id, "Level 7 terrain", "queued")

let seq = 0
const msg = (role: ChatMessage["role"], content: string, meta?: Record<string, unknown>): ChatMessage => ({ id: `chat_${String(++seq).padStart(4, "0")}`, role, content, meta, createdAt: Date.now() - 1000 + seq })

const CHAT = [
  msg("user", "Start the terrain work"),
  msg("tool", "create_task", { input: { project: "Map 3", title: "Level 7 terrain" }, resultId: LEVEL.id }),
  msg("assistant", `Started [Level 7 terrain](/tasks/${LEVEL.id}).`),
  msg("user", "How is login going?"),
  msg("assistant", `[Fix login](/tasks/${LOGIN.id}) is asking you something.`),
  msg("notice", "🪝 **Coordinator cards** hook fired: Review", { taskId: CARDS.id, projectId: YARD.id }),
]

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [YARD, MAP, QUIET])
  qc.setQueryData(keys.tasks, [LOGIN, CARDS, LEVEL])
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => setChatProjectFilter(null))
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const chips = () => [...host.querySelectorAll('[data-testid="project-chip"]')] as HTMLElement[]
const chip = (name: string) => chips().find((c) => c.textContent?.includes(name))!
/** The chip's pill: its button and its unpin ×. */
const pill = (name: string) => chip(name).closest<HTMLElement>("[data-project]")!
const unpin = (name: string) => pill(name).querySelector<HTMLElement>('[data-testid="project-unpin"]')!
const hiddenChip = () => host.querySelector<HTMLElement>('[data-testid="project-bar-hidden"]')
const allChip = () => host.querySelector('[data-testid="project-bar"] button')! as HTMLElement
const text = () => host.querySelector('[data-testid="chat-panel"]')!.textContent ?? ""

describe("project bar", () => {
  it("shows All with the active count, then a chip per busy project in its colour, in the sidebar's order", () => {
    render(createElement(ChatPanel))
    expect(allChip().textContent).toBe("All · 3 active")
    expect(allChip().getAttribute("aria-pressed")).toBe("true")
    // Quiet has no task and the chat never names it.
    expect(chips().map((c) => c.textContent)).toEqual(["box-yard · 1 needs you · 1 running", "Map 3 · 1 queued"])
    const colors = projectColors([YARD, MAP, QUIET])
    expect(pill("Map 3").style.getPropertyValue("--pc")).toBe("#fb923c")
    expect(colors.get(MAP.id)).toBe("orange")
  })

  it("a chip shows only its project's cards, its Captain's card in the Coordinator's place; the chip again or Show all brings it all back", () => {
    render(createElement(ChatPanel))
    const ids = () => [...host.querySelectorAll('[data-testid="chat-card"]')].map((c) => (c as HTMLElement).dataset.card)
    const coordinator = () => host.querySelector('[data-testid="coordinator-card"]')
    expect(ids()).toEqual([LEVEL.id, CARDS.id])
    expect(coordinator()!.textContent).toContain("is asking you something")
    click(chip("Map 3"))
    expect(chip("Map 3").getAttribute("aria-pressed")).toBe("true")
    expect(allChip().getAttribute("aria-pressed")).toBe("false")
    expect(ids()).toEqual([LEVEL.id])
    expect(coordinator()).toBeNull()
    expect(text()).not.toContain("hook fired")
    // One bar: no "Only Map 3 / Show all" banner under it; the picked chip's × is Show all.
    expect(host.querySelector('[data-testid="project-filter-banner"]')).toBeNull()
    expect(text()).not.toContain("Only Map 3")
    expect(pill("Map 3").querySelector('[data-testid="project-unpin"]')).toBeNull()
    click(chip("box-yard"))
    expect(ids()).toEqual([CARDS.id])
    expect(text()).toContain("Coordinator cards")
    click(chip("box-yard"))
    expect(ids()).toEqual([LEVEL.id, CARDS.id])
    click(chip("Map 3"))
    const showAll = pill("Map 3").querySelector<HTMLElement>('[data-testid="project-clear"]')!
    expect(showAll.getAttribute("aria-label")).toBe("Show all projects")
    click(showAll)
    expect(allChip().getAttribute("aria-pressed")).toBe("true")
    expect(pill("Map 3").querySelector('[data-testid="project-clear"]')).toBeNull()
    expect(coordinator()!.textContent).toContain("is asking you something")
  })

  it("leads task links with their tile, in their project's colour", () => {
    render(createElement(ChatPanel))
    // The reply's link, in the Coordinator card.
    const links = [...host.querySelectorAll(`a[href="/tasks/${LEVEL.id}"]`)]
    expect(links).toHaveLength(1)
    for (const link of links) {
      const tile = link.querySelector('[data-testid="task-tile"]')!
      expect(tile.getAttribute("data-color")).toBe("orange")
      expect(tile.getAttribute("data-icon")).toBe("map")
      expect(link.textContent).toBe("Level 7 terrain")
    }
  })

  it("re-colours as soon as a project gets a colour of its own", () => {
    render(createElement(ChatPanel))
    act(() => qc.setQueryData(keys.projects, [{ ...YARD, color: "cyan" }, MAP, QUIET]))
    expect(host.querySelector(`a[href="/tasks/${LOGIN.id}"] [data-testid="task-tile"]`)!.getAttribute("data-color")).toBe("cyan")
    expect(pill("box-yard").style.getPropertyValue("--pc")).toBe("#22d3ee")
  })

  it("has no bar when no project is busy or talked about", () => {
    qc.setQueryData(keys.tasks, [])
    qc.setQueryData(keys.chat, [])
    render(createElement(ChatPanel))
    expect(host.querySelector('[data-testid="project-bar"]')).toBeNull()
  })
})

describe("centring the picked chip", () => {
  it("centredScrollLeft puts the chip in the bar's middle, clamped to what the bar can scroll", () => {
    // Bar 300 wide at x=20 (middle 170); chip 100 wide, 400 into the content, bar scrolled 0.
    expect(centredScrollLeft({ left: 20, width: 300 }, { left: 420, width: 100 }, 0, 300, 1200)).toBe(300)
    // Already scrolled 250: the same chip is now at x=170 on screen.
    expect(centredScrollLeft({ left: 20, width: 300 }, { left: 170, width: 100 }, 250, 300, 1200)).toBe(300)
    // Zen's column: a 10px gutter on each edge, so the scroll area (clientWidth 280) shares the box's middle.
    expect(centredScrollLeft({ left: 0, width: 300 }, { left: 400, width: 100 }, 0, 280, 1200)).toBe(300)
    // Near the start: can't go below 0. Near the end: can't pass scrollWidth - clientWidth.
    expect(centredScrollLeft({ left: 0, width: 300 }, { left: 10, width: 60 }, 0, 300, 1200)).toBe(0)
    expect(centredScrollLeft({ left: 0, width: 300 }, { left: 1150, width: 50 }, 0, 300, 1200)).toBe(900)
  })

  describe("in the bar", () => {
    const PROJECTS = Array.from({ length: 8 }, (_, i) => project(`prj_many000${i}`, `project-${i}`, i + 1))
    let calls: { left: number; behavior: string }[]
    let intoView: number
    let reduced: boolean
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const saved: Record<string, PropertyDescriptor | undefined> = {}
    const bar = () => host.querySelector<HTMLElement>('[data-testid="project-bar"]')!

    beforeEach(() => {
      calls = []
      intoView = 0
      reduced = false
      for (const k of ["getBoundingClientRect", "clientWidth", "scrollWidth", "scrollTo", "scrollIntoView"]) saved[k] = Object.getOwnPropertyDescriptor(Element.prototype, k) ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)
      // A 300px bar at x=0; chip i (All is 0) is 150px apart and 120 wide.
      Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
        configurable: true,
        value(this: HTMLElement) {
          const b = this.closest<HTMLElement>('[data-testid="project-bar"]')
          if (!b) return { left: 0, width: 0, top: 0, height: 0, right: 0, bottom: 0 }
          if (this === b) return { left: 0, width: 300, top: 0, height: 36, right: 300, bottom: 36 }
          const left = [...b.children].indexOf(this) * 150 - b.scrollLeft
          return { left, width: 120, top: 0, height: 28, right: left + 120, bottom: 28 }
        },
      })
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 })
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 150 * 9 })
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value(this: HTMLElement, o: ScrollToOptions) {
          calls.push({ left: o.left!, behavior: o.behavior! })
          this.scrollLeft = o.left!
        },
      })
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => intoView++ })
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion") && reduced, addEventListener() {}, removeEventListener() {} }))
      qc.setQueryData(keys.projects, PROJECTS)
      qc.setQueryData(keys.tasks, [])
      qc.setQueryData(keys.chat, [])
      localStorage.setItem(PINS_KEY, JSON.stringify(Object.fromEntries(PROJECTS.map((p) => [p.id, "pinned"]))))
    })
    afterEach(() => {
      for (const k of Object.keys(saved)) {
        delete proto[k]
        if (saved[k]) Object.defineProperty(Element.prototype, k, saved[k]!)
      }
    })

    it("a pick scrolls only the bar, smoothly, so the picked chip is centred", () => {
      render(createElement(ChatPanel))
      expect(calls).toEqual([])
      // project-5 is the bar's 7th child (All first): 6 * 150 + 60 - 150 = 810.
      act(() => pickProject("prj_many0005"))
      expect(calls).toEqual([{ left: 810, behavior: "smooth" }])
      expect(bar().scrollLeft).toBe(810)
      expect(intoView).toBe(0)
      // A chip near the end goes as far as the bar scrolls (1350 - 300).
      act(() => pickProject("prj_many0007"))
      expect(calls.at(-1)).toEqual({ left: 1050, behavior: "smooth" })
      // Clicking a chip does it too; All goes back to the start.
      click(chip("project-2"))
      expect(calls.at(-1)).toEqual({ left: 360, behavior: "smooth" })
      click(allChip())
      expect(calls.at(-1)).toEqual({ left: 0, behavior: "smooth" })
    })

    it("jumps instead of gliding when motion is reduced", () => {
      reduced = true
      render(createElement(ChatPanel))
      act(() => pickProject("prj_many0004"))
      expect(calls).toEqual([{ left: 660, behavior: "auto" }])
    })

    it("centres a chip that's already picked when the bar first shows, without gliding", () => {
      act(() => setChatProjectFilter("prj_many0006"))
      render(createElement(ChatPanel))
      expect(calls).toEqual([{ left: 960, behavior: "auto" }])
    })
  })
})

describe("pinning and unpinning", () => {
  const names = () => chips().map((c) => c.textContent!.split(" · ")[0])

  it("each project chip, never All, has an unpin × that takes it off the bar, and it stays off after a reload", () => {
    render(createElement(ChatPanel))
    expect(host.querySelectorAll('[data-testid="project-unpin"]')).toHaveLength(2)
    expect(allChip().closest("[data-project]")).toBeNull()
    expect(unpin("Map 3").getAttribute("aria-label")).toBe("Unpin Map 3")
    click(unpin("Map 3"))
    expect(names()).toEqual(["box-yard"])
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual({ [MAP.id]: "unpinned" })
    // A reload: a fresh mount reads it back.
    act(() => root.unmount())
    root = createRoot(host)
    render(createElement(ChatPanel))
    expect(names()).toEqual(["box-yard"])
    // Still busy, so All still counts it.
    expect(allChip().textContent).toBe("All · 3 active")
  })

  it("an unpinned project stays off however busy it gets, until it's picked again", () => {
    render(createElement(ChatPanel))
    click(unpin("Map 3"))
    act(() => qc.setQueryData(keys.tasks, [LOGIN, CARDS, LEVEL, task("task_more0001", MAP.id, "Level 8", "working")]))
    expect(names()).toEqual(["box-yard"])
    act(() => pickProject(MAP.id))
    expect(names()).toEqual(["box-yard", "Map 3"])
    expect(readPins()[MAP.id]).toBe("pinned")
  })

  it("the picked chip's × shows everything again and keeps it on the bar, where it can be unpinned", () => {
    render(createElement(ChatPanel))
    click(chip("Map 3"))
    expect(chip("Map 3").getAttribute("aria-pressed")).toBe("true")
    click(pill("Map 3").querySelector<HTMLElement>('[data-testid="project-clear"]')!)
    expect(allChip().getAttribute("aria-pressed")).toBe("true")
    expect(names()).toEqual(["box-yard", "Map 3"])
    click(unpin("Map 3"))
    expect(names()).toEqual(["box-yard"])
  })

  it("a pinned project stays on the bar with nothing going on", () => {
    render(createElement(ChatPanel))
    expect(names()).not.toContain("Quiet")
    act(() => pickProject(QUIET.id))
    act(() => setChatProjectFilter(null))
    expect(names()).toEqual(["box-yard", "Map 3", "Quiet"])
    expect(chip("Quiet").textContent).toBe("Quiet")
  })

  it("an unpinned project with a task asking you shows as +N needs you, which puts it back and shows it", () => {
    render(createElement(ChatPanel))
    expect(hiddenChip()).toBeNull()
    click(unpin("box-yard"))
    expect(names()).toEqual(["Map 3"])
    expect(hiddenChip()!.textContent).toBe("+1 needs you")
    expect(hiddenChip()!.title).toContain("box-yard")
    click(hiddenChip()!)
    expect(hiddenChip()).toBeNull()
    expect(names()).toEqual(["box-yard", "Map 3"])
    expect(chip("box-yard").getAttribute("aria-pressed")).toBe("true")
    expect(readPins()[YARD.id]).toBe("pinned")
  })

  it("keeps the bar for +N needs you when every chip is unpinned", () => {
    render(createElement(ChatPanel))
    click(unpin("box-yard"))
    click(unpin("Map 3"))
    expect(chips()).toEqual([])
    expect(hiddenChip()!.textContent).toBe("+1 needs you")
  })
})

describe("project colour picker", () => {
  it("offers Auto (the colour from its name) and the palette; a pick is a draft until Save", async () => {
    const { ProjectColorPicker } = await import("../web/src/components/ProjectView.js")
    const picked: (string | null)[] = []
    const auto = projectColors([YARD, MAP, QUIET]).get(YARD.id)
    render(createElement(ProjectColorPicker, { project: YARD, value: null, onChange: (c: string | null) => picked.push(c) }))
    const radios = [...host.querySelectorAll('[data-testid="project-color"] [role="radio"]')]
    expect(radios).toHaveLength(9)
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true")
    expect(radios[0]!.getAttribute("aria-label")).toBe(`Auto (${auto})`)
    click(radios.find((r) => r.getAttribute("aria-label") === "teal")!)
    expect(picked).toEqual(["teal"])
    render(createElement(ProjectColorPicker, { project: { ...YARD, color: "teal" }, value: "teal", onChange: () => {} }))
    const checked = host.querySelector('[data-testid="project-color"] [aria-checked="true"]')!
    expect(checked.getAttribute("aria-label")).toBe("teal")
  })
})
