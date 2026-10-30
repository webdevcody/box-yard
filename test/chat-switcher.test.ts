// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { ZEN_PATH } from "../web/src/lib/zen.js"
import { closeZenPanel, openZenPanel, zenPanelState } from "../web/src/lib/zenPanel.js"
import { pickProject, readPins, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { captainHref } from "../web/src/components/ChatSwitcher.js"
import { projectColors } from "../shared/projectColors.js"
import type { Project } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: `webdevcody/${name}`, description: "", notes: [], updatedAt: now }) as unknown as Project
// Sidebar order: the list as the server sends it (PUT /api/projects/order), not alphabetical.
const PROJECTS = [project("prj_yard01", "box-yard"), project("prj_night1", "survive-the-night"), project("prj_alpha1", "alpha")]
const captain = (projectId: string, busy: boolean) => ({
  projectId,
  busy,
  compacting: false,
  compactQueued: false,
  error: null,
  usage: { tokens: null, window: null, updatedAt: null },
})

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement

function render(path: string = ZEN_PATH) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { startInZen: true, ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.projects, PROJECTS)
  // What the live stream left: survive-the-night's Captain is working, box-yard's idle, alpha's never seen.
  qc.setQueryData(keys.captain("prj_yard01"), captain("prj_yard01", false))
  qc.setQueryData(keys.captain("prj_night1"), captain("prj_night1", true))
  for (const p of PROJECTS) qc.setQueryData(keys.captainMessages(p.id), [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const chatPanel = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")!
const zenPanel = () => document.querySelector<HTMLElement>("[data-testid=zen-panel]")
const switcher = (within: ParentNode) => within.querySelector<HTMLButtonElement>("[data-testid=chat-switcher]")!
const menu = () => document.querySelector<HTMLElement>("[data-testid=chat-switcher-menu]")
const items = () => [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])]
const labels = () => items().map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const checked = () => items().filter((el) => el.getAttribute("aria-checked") === "true").map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.replace(/(working|idle)$/, "")
const coordinatorBox = () => chatPanel().querySelector<HTMLTextAreaElement>("textarea[placeholder='Ask the Coordinator…']")!
// "Queue another message…" while it works.
const captainBox = (within: ParentNode = document) => within.querySelector<HTMLTextAreaElement>("[data-testid=captain-chat] textarea")
const panelTitle = () => document.querySelector("[data-testid=zen-panel-title]")?.textContent

const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const key = (k: string, target: Element = document.activeElement ?? document.body, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}
const filterBox = () => menu()?.querySelector<HTMLInputElement>("[data-testid=chat-switcher-filter]") ?? null
/** Types into the filter as React hears it. */
const type = (text: string) =>
  act(() => {
    const input = filterBox()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, input.value + text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const highlighted = () => items().filter((el) => el.dataset.active === "true").map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const title = () => chatPanel().querySelector("[data-testid=chat-title]")!.textContent
const pressedChip = () => chatPanel().querySelector('[data-testid="project-bar"] button[aria-pressed="true"]')?.textContent
/** The composer is focused a frame after the pick. */
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  closeZenPanel()
  setChatProjectFilter(null)
  vi.unstubAllGlobals()
})

describe("the chat switcher in the Coordinator's header", () => {
  it("the title opens a menu: the Coordinator (current) first, then every project's Captain in sidebar order", () => {
    render()
    const button = switcher(chatPanel())
    expect(button.textContent).toContain("Coordinator")
    expect(button.getAttribute("aria-haspopup")).toBe("menu")
    expect(menu()).toBeNull()
    click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(menu()!.getAttribute("role")).toBe("menu")
    expect(button.getAttribute("aria-controls")).toBe(menu()!.id)
    expect(labels()).toEqual(["Coordinator", "box-yard", "survive-the-night", "alpha"])
    expect(checked()).toEqual(["Coordinator"])
    expect(menu()!.querySelector("[role=group]")!.getAttribute("aria-label")).toBe("Captains")
  })

  it("marks each project with its colour, as its sidebar row does", () => {
    render()
    click(switcher(chatPanel()))
    const colors = projectColors(PROJECTS)
    for (const p of PROJECTS) {
      const mark = items().find((el) => el.dataset.chat === p.id)!.querySelector("svg")!
      expect(mark.getAttribute("data-color")).toBe(colors.get(p.id))
      expect(mark.getAttribute("style")).toContain("--pc")
    }
  })

  it("shows each chat's busy dot from what's cached, and none for a Captain it hasn't heard about", () => {
    render()
    click(switcher(chatPanel()))
    const dot = (label: string) => items().find((el) => el.textContent!.startsWith(label))!.querySelector("[data-testid=chat-switcher-busy]")
    expect(dot("Coordinator")!.getAttribute("title")).toBe("Coordinator is idle")
    expect(dot("box-yard")!.getAttribute("title")).toBe("Captain is idle")
    expect(dot("survive-the-night")!.getAttribute("data-busy")).toBe("true")
    expect(dot("survive-the-night")!.getAttribute("title")).toBe("Captain is working")
    expect(dot("alpha")).toBeNull()
    // Nothing fetched to find out.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/captain"))).toEqual([])
  })

  it("arrows move from the current chat, wrapping; Home and End jump; Esc closes back to the title and stays in Zen", () => {
    render()
    const button = switcher(chatPanel())
    click(button)
    expect(focused()).toBe("Coordinator")
    expect(key("ArrowDown").defaultPrevented).toBe(true)
    expect(focused()).toBe("box-yard")
    key("ArrowDown")
    expect(focused()).toBe("survive-the-night")
    key("End")
    expect(focused()).toBe("alpha")
    key("ArrowDown")
    expect(focused()).toBe("Coordinator")
    key("ArrowUp")
    expect(focused()).toBe("alpha")
    key("Home")
    expect(focused()).toBe("Coordinator")
    key("Escape")
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    // Esc was the menu's, so Zen didn't leave.
    expect(document.querySelector("[data-zen]")).not.toBeNull()
  })

  it("a click outside closes it", () => {
    render()
    click(switcher(chatPanel()))
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(menu()).toBeNull()
  })

  it("Enter on a project pins it to the project bar and shows it in this chat, its Captain's box focused, without opening the side panel", async () => {
    render()
    click(switcher(chatPanel()))
    key("ArrowDown")
    key("ArrowDown")
    key("Enter")
    expect(menu()).toBeNull()
    expect(zenPanel()).toBeNull()
    expect(location.pathname).toBe(ZEN_PATH)
    expect(title()).toBe("survive-the-night Captain")
    expect(pressedChip()).toBe("survive-the-night")
    expect(readPins()).toEqual({ prj_night1: "pinned" })
    await frame()
    expect(document.activeElement).toBe(chatPanel().querySelector("textarea"))
    expect(chatPanel().querySelector("textarea")!.placeholder).toBe("Queue another message for the Captain…")
  })

  it("beside a page, a pick stays in the Coordinator too: no navigation to the Captain's tab", () => {
    render("/")
    click(switcher(chatPanel()))
    click(items().find((el) => el.textContent!.startsWith("alpha"))!)
    expect(location.pathname).toBe("/")
    expect(title()).toBe("alpha Captain")
    expect(pressedChip()).toBe("alpha")
  })

  it("Enter on the current chat just closes the menu and focuses its composer", async () => {
    render()
    click(switcher(chatPanel()))
    key("Enter")
    expect(menu()).toBeNull()
    expect(zenPanel()).toBeNull()
    await frame()
    expect(document.activeElement).toBe(coordinatorBox())
  })
})

describe("the chat switcher in a Captain's header", () => {
  it("in Zen's side panel: the Coordinator stays first and this Captain is the checked one", async () => {
    render()
    act(() => openZenPanel(captainHref("prj_alpha1")))
    const button = switcher(zenPanel()!)
    expect(button.textContent).toContain("Captain")
    click(button)
    expect(labels()[0]).toBe("Coordinator")
    expect(labels()).toEqual(["Coordinator", "box-yard", "survive-the-night", "alpha"])
    expect(checked()).toEqual(["alpha"])
    // Opens on the current one.
    expect(focused()).toBe("alpha")
  })

  it("switches to another Captain in the panel, and back to the Coordinator, focusing each composer", async () => {
    render()
    act(() => openZenPanel(captainHref("prj_yard01")))
    expect(panelTitle()).toBe("box-yard Captain")

    click(switcher(zenPanel()!))
    click(items().find((el) => el.textContent!.startsWith("survive-the-night"))!)
    expect(panelTitle()).toBe("survive-the-night Captain")
    await frame()
    expect(document.activeElement).toBe(captainBox(zenPanel()!))

    click(switcher(zenPanel()!))
    key("Home")
    key("Enter")
    expect(zenPanel()).toBeNull()
    expect(location.pathname).toBe(ZEN_PATH)
    await frame()
    expect(document.activeElement).toBe(coordinatorBox())
  })

  it("on the project page: picking a Captain goes to its tab, and the Coordinator opens beside it focused", async () => {
    render("/projects/prj_alpha1?tab=captain")
    let captainChat = document.querySelector<HTMLElement>("[data-testid=captain-chat]")!
    click(switcher(captainChat))
    click(items().find((el) => el.textContent!.startsWith("survive-the-night"))!)
    expect(location.pathname + location.search).toBe("/projects/prj_night1?tab=captain")
    await frame()
    captainChat = document.querySelector<HTMLElement>("[data-testid=captain-chat]")!
    expect(document.activeElement).toBe(captainBox(captainChat))

    // From the project's Captain tab: the Coordinator stays first, this Captain is checked.
    click(switcher(captainChat))
    expect(labels()[0]).toBe("Coordinator")
    expect(checked()).toEqual(["survive-the-night"])
    let opened = 0
    const onOpen = () => opened++
    window.addEventListener("box-yard:open-coordinator", onOpen)
    key("Home")
    key("Enter")
    window.removeEventListener("box-yard:open-coordinator", onOpen)
    expect(opened).toBe(1)
    expect(location.pathname).toBe("/projects/prj_night1")
    await frame()
    expect(document.activeElement).toBe(coordinatorBox())
  })
})

describe("the project picker hotkey (P)", () => {
  it("names the key in the Coordinator's switcher title, and only there", () => {
    render("/projects/prj_alpha1?tab=captain")
    expect(switcher(chatPanel()).title).toBe("Switch to the Coordinator or a project (P)")
    expect(switcher(chatPanel()).getAttribute("aria-keyshortcuts")).toBe("p")
    const captainChat = document.querySelector<HTMLElement>("[data-testid=captain-chat]")!
    expect(switcher(captainChat).title).toBe("Switch to the Coordinator or a project's Captain")
    expect(switcher(captainChat).hasAttribute("aria-keyshortcuts")).toBe(false)
  })

  it("opens the Coordinator's switcher with the filter focused; typing picks the best match, Enter pins and shows it", async () => {
    render()
    expect(key("p", document.body).defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(filterBox())
    // Before typing, the current chat is highlighted.
    expect(highlighted()).toEqual(["Coordinator"])
    type("stn")
    expect(labels()).toEqual(["survive-the-night"])
    expect(highlighted()).toEqual(["survive-the-night"])
    expect(filterBox()!.getAttribute("aria-activedescendant")).toBe(items()[0]!.id)
    key("Enter")
    expect(menu()).toBeNull()
    expect(title()).toBe("survive-the-night Captain")
    expect(pressedChip()).toBe("survive-the-night")
    expect(readPins()).toEqual({ prj_night1: "pinned" })
    await frame()
    expect(document.activeElement).toBe(chatPanel().querySelector("textarea"))
  })

  it("ranks prefix matches first, arrows move the highlight (wrapping), and Esc closes without a pick", () => {
    render()
    key("p", document.body)
    type("a")
    // "alpha" starts with it; the others only contain it.
    expect(labels()[0]).toBe("alpha")
    expect(highlighted()).toEqual(["alpha"])
    expect(key("ArrowDown").defaultPrevented).toBe(true)
    expect(highlighted()).toEqual([labels()[1]])
    key("ArrowUp")
    key("ArrowUp")
    expect(highlighted()).toEqual([labels().at(-1)])
    key("Escape")
    expect(menu()).toBeNull()
    expect(title()).toBe("Box Yard Coordinator")
    expect(readPins()).toEqual({})
    // Esc was the menu's, so Zen didn't leave.
    expect(document.querySelector("[data-zen]")).not.toBeNull()
  })

  it("'all' finds the Coordinator, which shows the whole chat again", () => {
    render()
    act(() => pickProject("prj_yard01"))
    key("p", document.body)
    type("all")
    expect(highlighted()).toEqual(["Coordinator"])
    key("Enter")
    expect(title()).toBe("Box Yard Coordinator")
    expect(pressedChip()).toContain("All")
  })

  it("says so when nothing matches, and Enter does nothing (the menu stays, to fix the typing)", () => {
    render()
    key("p", document.body)
    type("zzz")
    expect(items()).toEqual([])
    expect(menu()!.textContent).toContain("No match.")
    key("Enter")
    expect(menu()).not.toBeNull()
    expect(title()).toBe("Box Yard Coordinator")
  })

  it("doesn't fire while typing in a field, with a modifier, or held down", () => {
    render()
    expect(key("p", coordinatorBox()).defaultPrevented).toBe(false)
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }]) {
      expect(key("p", document.body, init).defaultPrevented).toBe(false)
      expect(menu()).toBeNull()
    }
  })

  it("typing on a menu item (opened by a click) goes to the filter", () => {
    render()
    click(switcher(chatPanel()))
    expect(focused()).toBe("Coordinator")
    key("b")
    expect(document.activeElement).toBe(filterBox())
    expect(filterBox()!.value).toBe("b")
    expect(labels()[0]).toBe("box-yard")
  })
})
