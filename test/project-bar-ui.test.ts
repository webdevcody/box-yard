// @vitest-environment happy-dom
// The Coordinator chat's project bar: a chip per busy project in its colour, filtering the cards to that project, and
// task tiles leading task links.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatPanel } from "../web/src/components/ChatPanel.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
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
    expect(chip("Map 3").style.getPropertyValue("--pc")).toBe("#fb923c")
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
    expect(host.querySelector('[data-testid="project-filter-banner"]')?.textContent).toContain("Only Map 3")
    click(chip("box-yard"))
    expect(ids()).toEqual([CARDS.id])
    expect(text()).toContain("Coordinator cards")
    click(chip("box-yard"))
    expect(ids()).toEqual([LEVEL.id, CARDS.id])
    click(chip("Map 3"))
    const showAll = [...host.querySelectorAll('[data-testid="project-filter-banner"] button')].find((b) => b.textContent?.includes("Show all"))!
    click(showAll)
    expect(host.querySelector('[data-testid="project-filter-banner"]')).toBeNull()
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
    expect(chip("box-yard").style.getPropertyValue("--pc")).toBe("#22d3ee")
  })

  it("has no bar when no project is busy or talked about", () => {
    qc.setQueryData(keys.tasks, [])
    qc.setQueryData(keys.chat, [])
    render(createElement(ChatPanel))
    expect(host.querySelector('[data-testid="project-bar"]')).toBeNull()
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
