// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NewTaskButton } from "../web/src/components/NewTask.js"
import { keys } from "../web/src/lib/queries.js"
import { loadDraft } from "../web/src/lib/newTask.js"
import type { Project, SettingsInfo } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The saved sidebar order (useProjects returns projects in it), not alphabetical.
const PROJECTS = [
  { id: "prj_zeta01", name: "zeta", repo: null, description: "", envKeys: [], notes: [] },
  { id: "prj_alpha1", name: "alpha", repo: null, description: "", envKeys: [], notes: [] },
] as unknown as Project[]

let root: Root
let host: HTMLElement
let fetchMock: ReturnType<typeof vi.fn>

function render(props: Parameters<typeof NewTaskButton>[0] = { projectId: "prj_alpha1" }) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada", agentModel: "claude-opus-5-5", agentEffort: "high" } } as unknown as SettingsInfo)
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement("div", null, createElement("p", { "data-testid": "outside", tabIndex: 0 }, "elsewhere"), createElement(NewTaskButton, props)),
      ),
    ),
  )
}

const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!
const popover = () => document.querySelector<HTMLElement>("[role=dialog]")
const textarea = () => popover()!.querySelector("textarea")!
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!
const click = (el: HTMLElement) => act(() => el.click())
const open = () => click(trigger())
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  act(() => void el.dispatchEvent(e))
  return e
}
const type = (el: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
/** The bodies POSTed to /api/tasks (the mutation sends after an await, so wait for `n` of them). */
const sent = async (n = 1) => {
  await vi.waitFor(() => expect(posted()).toHaveLength(n))
  return posted()
}
const posted = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === "/api/tasks" && (init as RequestInit)?.method === "POST").map(([, init]) => JSON.parse(String((init as RequestInit).body)))

beforeEach(() => {
  history.replaceState(null, "", "/projects/prj_alpha1")
  sessionStorage.clear()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("New task popover", () => {
  it("opens from its button as a labelled dialog with the textarea focused", () => {
    render()
    expect(popover()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    open()
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(trigger().getAttribute("aria-controls")).toBe(dialog.id)
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("New task in alpha")
    expect(document.activeElement).toBe(textarea())
    expect(textarea().placeholder).toBe("What should the agent do?")
    // No title field and, with a project in context, no project picker.
    expect(dialog.querySelectorAll("input, select")).toHaveLength(0)
  })

  it("starts the task on Enter, titled from the prompt, and goes to it", async () => {
    render()
    open()
    type(textarea(), "Add a dark mode toggle\nIt should remember the choice.")
    const e = press(textarea(), "Enter")
    expect(e.defaultPrevented).toBe(true)
    expect(location.pathname).toMatch(/^\/tasks\/task_/)
    const [body] = await sent()
    expect(body).toMatchObject({ projectId: "prj_alpha1", title: "Add a dark mode toggle", prompt: "Add a dark mode toggle\nIt should remember the choice." })
    expect(location.pathname).toBe(`/tasks/${body.id}`)
    expect(popover()).toBeNull()
    expect(loadDraft("prj_alpha1")).toBe("")
  })

  it("leaves Shift+Enter to the textarea for a new line and doesn't start an empty task", () => {
    render()
    open()
    type(textarea(), "first line")
    expect(press(textarea(), "Enter", { shiftKey: true }).defaultPrevented).toBe(false)
    type(textarea(), "  ")
    press(textarea(), "Enter")
    expect(posted()).toHaveLength(0)
    expect(popover()).not.toBeNull()
    expect(button("Start task").disabled).toBe(true)
  })

  it("closes on Esc, returns focus to the button and keeps the draft", () => {
    render()
    open()
    type(textarea(), "half a thought")
    const e = press(textarea(), "Escape")
    expect(e.defaultPrevented).toBe(true)
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    open()
    expect(textarea().value).toBe("half a thought")
    expect(textarea().selectionStart).toBe("half a thought".length)
  })

  it("closes on a click outside and keeps the draft; clicks inside don't close it", () => {
    render()
    open()
    type(textarea(), "keep me")
    act(() => void textarea().dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).not.toBeNull()
    act(() => void host.querySelector("[data-testid=outside]")!.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).toBeNull()
    expect(loadDraft("prj_alpha1")).toBe("keep me")
    open()
    expect(textarea().value).toBe("keep me")
  })

  it("keeps drafts per project", () => {
    render({ projectId: "prj_alpha1" })
    open()
    type(textarea(), "for alpha")
    press(textarea(), "Escape")
    render({ projectId: "prj_zeta01" })
    open()
    expect(textarea().value).toBe("")
  })

  it("toggles closed from its own button", () => {
    render()
    open()
    act(() => void trigger().dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).not.toBeNull()
    open()
    expect(popover()).toBeNull()
  })

  it("keeps Tab inside the popover", () => {
    render()
    open()
    type(textarea(), "x")
    const start = button("Start task")
    start.focus()
    expect(press(start, "Tab").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(textarea())
    expect(press(textarea(), "Tab", { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(start)
  })

  it("opens the full dialog from More options with the text in it", async () => {
    render()
    open()
    type(textarea(), "Fix the flaky test\nwith details")
    click(button("More options"))
    const dialog = popover()!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("New task")
    const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!
    expect(prompt.value).toBe("Fix the flaky test\nwith details")
    expect(document.activeElement).toBe(prompt)
    // The title is optional and shows the one it would make.
    expect(dialog.querySelector<HTMLInputElement>("input:not([type=file])")!.placeholder).toBe("Fix the flaky test")
    expect(dialog.querySelector("[data-testid=new-task-model]")).not.toBeNull()
    expect(dialog.querySelector("[data-testid=new-task-effort]")).not.toBeNull()
    expect(button("Attach files")).toBeDefined()

    act(() => {
      const select = dialog.querySelector<HTMLSelectElement>("[data-testid=new-task-effort]")!
      select.value = "max"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    click(button("Start agent"))
    expect((await sent())[0]).toMatchObject({ projectId: "prj_alpha1", title: "Fix the flaky test", prompt: "Fix the flaky test\nwith details", effort: "max", attachments: [] })
    expect(posted()[0].model).toBeUndefined()
    expect(loadDraft("prj_alpha1")).toBe("")
  })

  it("keeps edits made in the full dialog as the draft when it is cancelled", () => {
    render()
    open()
    type(textarea(), "draft")
    click(button("More options"))
    type(popover()!.querySelector("textarea")!, "draft, edited")
    click(button("Cancel"))
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    open()
    expect(textarea().value).toBe("draft, edited")
  })

  it("adds a project picker in the saved order when there's no project in context", async () => {
    render({})
    open()
    const select = popover()!.querySelector<HTMLSelectElement>("select")!
    expect(select.getAttribute("aria-label")).toBe("Project")
    expect([...select.options].map((o) => o.textContent)).toEqual(["zeta", "alpha"])
    expect(select.value).toBe("prj_zeta01")
    act(() => {
      select.value = "prj_alpha1"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    type(textarea(), "anywhere")
    press(textarea(), "Enter")
    expect((await sent())[0]).toMatchObject({ projectId: "prj_alpha1", prompt: "anywhere" })
  })

  it("starts the picker on the given default project", () => {
    render({ defaultProjectId: "prj_alpha1" })
    open()
    expect(popover()!.querySelector("select")!.value).toBe("prj_alpha1")
  })

  it("is a bottom sheet on narrow screens", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }))
    render()
    open()
    const sheet = popover()!
    expect(sheet.getAttribute("aria-modal")).toBe("true")
    expect(sheet.className).toContain("max-sm:rounded-t-2xl")
    expect(sheet.parentElement!.className).toContain("items-end")
    expect(document.activeElement).toBe(textarea())
    type(textarea(), "on the go")
    press(textarea(), "Escape")
    expect(popover()).toBeNull()
    expect(loadDraft("prj_alpha1")).toBe("on the go")
  })
})
