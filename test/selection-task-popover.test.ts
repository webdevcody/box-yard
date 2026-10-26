// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SelectionToTask } from "../web/src/components/SelectionToTask.js"
import { quotePreview } from "../web/src/components/NewTask.js"
import { keys } from "../web/src/lib/queries.js"
import { loadDraft, selectionScope } from "../web/src/lib/newTask.js"
import { buildSelectionTaskBrief, selectionTarget, type SelectionTaskSource } from "../web/src/lib/selectionTask.js"
import type { Project, SettingsInfo } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECTS = [
  { id: "prj_zeta01", name: "zeta", repo: null, description: "", envKeys: [], notes: [] },
  { id: "prj_alpha1", name: "alpha", repo: null, description: "", envKeys: [], notes: [] },
] as unknown as Project[]

const OUTPUT = "The retry loop in server/sync.ts never backs off,\nso a dead remote spins the CPU."
const ALPHA = { id: "prj_alpha1", name: "alpha" }

let root: Root
let host: HTMLElement
let fetchMock: ReturnType<typeof vi.fn>
let onPrompt: ReturnType<typeof vi.fn>

function render(source: SelectionTaskSource = { kind: "orchestrator", project: ALPHA }) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada", agentModel: "claude-opus-5-5", agentEffort: "high" } } as unknown as SettingsInfo)
  onPrompt = vi.fn()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(SelectionToTask, { source, onPrompt }, createElement("p", { "data-testid": "output" }, OUTPUT)),
      ),
    ),
  )
}

/** Select the whole output paragraph, as a drag would. */
function select() {
  const text = host.querySelector("[data-testid=output]")!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, OUTPUT.length)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => void document.dispatchEvent(new Event("selectionchange")))
}

const action = () => document.querySelector<HTMLButtonElement>("button[data-selection-task-action]")
const popover = () => document.querySelector<HTMLElement>("[role=dialog]:not([aria-modal])")
const modal = () => document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]")
const textarea = () => popover()!.querySelector("textarea")!
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!
const click = (el: HTMLElement) => act(() => el.click())
const press = (el: Element, key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  act(() => void el.dispatchEvent(e))
  return e
}
const type = (el: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const openPopover = () => {
  select()
  click(action()!)
}

beforeEach(() => {
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  // happy-dom lays nothing out, so give the selected range a box for the action button to sit on.
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(200, 300, 240, 18)] as unknown as DOMRectList)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Start new task from selected text", () => {
  it("opens the small New task popover with a quote preview, not the full modal", () => {
    render()
    expect(action()).toBeNull()
    select()
    expect(action()!.textContent).toContain("Start new task")
    click(action()!)
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    expect(modal()).toBeNull()
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("New task from selection")
    expect(dialog.querySelector("[data-testid=selection-quote]")!.textContent).toBe(quotePreview(OUTPUT))
    expect(textarea().placeholder).toBe("Additional instructions (optional)")
    expect(document.activeElement).toBe(textarea())
    // The selection's action goes while its popover is open.
    expect(action()).toBeNull()
  })

  it("Enter sends the selected output plus the instructions", () => {
    render()
    openPopover()
    type(textarea(), "Add exponential backoff with a cap")
    expect(press(textarea(), "Enter").defaultPrevented).toBe(true)
    expect(onPrompt).toHaveBeenCalledTimes(1)
    const prompt: string = onPrompt.mock.calls[0]![0]
    expect(prompt).toContain("> The retry loop in server/sync.ts never backs off,\n> so a dead remote spins the CPU.")
    expect(prompt).toContain("## Ada's additional instructions\nAdd exponential backoff with a cap")
    expect(prompt).toContain("- Project: alpha (prj_alpha1)")
    expect(popover()).toBeNull()
    expect(loadDraft(selectionScope(OUTPUT))).toBe("")
  })

  it("Enter with no instructions still sends the selection", () => {
    render()
    openPopover()
    expect(button("Start task").disabled).toBe(false)
    press(textarea(), "Enter")
    const prompt: string = onPrompt.mock.calls[0]![0]
    expect(prompt).toContain("## Selected output")
    expect(prompt).not.toContain("additional instructions")
  })

  it("Esc closes and keeps the draft for the same selection", () => {
    render()
    openPopover()
    type(textarea(), "half-typed thought")
    press(textarea(), "Escape")
    expect(popover()).toBeNull()
    expect(onPrompt).not.toHaveBeenCalled()
    expect(loadDraft(selectionScope(OUTPUT))).toBe("half-typed thought")
    openPopover()
    expect(textarea().value).toBe("half-typed thought")
  })

  it("a click outside closes and keeps the draft", () => {
    render()
    openPopover()
    type(textarea(), "kept")
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).toBeNull()
    expect(loadDraft(selectionScope(OUTPUT))).toBe("kept")
  })

  it("More options opens the full dialog with the instructions and the selection carried over", async () => {
    render()
    openPopover()
    type(textarea(), "Add exponential backoff with a cap")
    click(button("More options"))
    expect(popover()).toBeNull()
    const dialog = modal()!
    expect(dialog).not.toBeNull()
    const prompt = dialog.querySelectorAll("textarea")[0]!.value
    expect(prompt.startsWith("Add exponential backoff with a cap\n")).toBe(true)
    expect(prompt).toContain("> so a dead remote spins the CPU.")
    // The project comes from where the text was selected; no picker.
    expect(dialog.querySelector("[data-testid=new-task-project]")).toBeNull()
    click(button("Start agent"))
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/tasks" && (init as RequestInit)?.method === "POST")).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([url, init]) => url === "/api/tasks" && (init as RequestInit)?.method === "POST")!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toMatchObject({ projectId: "prj_alpha1", title: "Add exponential backoff with a cap" })
    expect(body.prompt).toContain("The retry loop in server/sync.ts never backs off")
    expect(onPrompt).not.toHaveBeenCalled()
    expect(loadDraft(selectionScope(OUTPUT))).toBe("")
  })

  it("More options without a project in context lets you pick one", () => {
    render({ kind: "orchestrator", project: null })
    openPopover()
    click(button("More options"))
    const picker = modal()!.querySelector<HTMLSelectElement>("[data-testid=new-task-project]")!
    expect([...picker.options].map((o) => o.textContent)).toEqual(["zeta", "alpha"])
  })

  it("in the Captain chat it sends to that project's Captain", () => {
    render({ kind: "captain", project: ALPHA })
    openPopover()
    type(textarea(), "fix it")
    press(textarea(), "Enter")
    expect(onPrompt.mock.calls[0]![0]).toContain("- Source: the project Captain's chat output")
  })

  it("is a bottom sheet on phones", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }))
    render()
    openPopover()
    const sheet = modal()!
    expect(sheet).not.toBeNull()
    expect(sheet.textContent).toContain("New task from selection")
    expect(sheet.querySelector("[data-testid=selection-quote]")).not.toBeNull()
  })
})

describe("selection task helpers", () => {
  it("quotePreview flattens whitespace and cuts long quotes with an ellipsis", () => {
    expect(quotePreview("a\n\n  b\tc")).toBe("a b c")
    const long = "word ".repeat(100)
    const p = quotePreview(long, 40)
    expect(p.length).toBeLessThanOrEqual(40)
    expect(p.endsWith("…")).toBe(true)
  })

  it("the brief leads with the instructions and quotes the full selection", () => {
    const brief = buildSelectionTaskBrief({ source: { kind: "captain", project: ALPHA }, selectedText: OUTPUT, instructions: "  Do it  " })
    expect(brief.split("\n")[0]).toBe("Do it")
    expect(brief).toContain("> so a dead remote spins the CPU.")
    expect(buildSelectionTaskBrief({ source: { kind: "orchestrator" }, selectedText: "x y z", instructions: "" }).split("\n")[0]).toBe("Follow up on this Box Yard output.")
  })

  it("names where the prompt went", () => {
    expect(selectionTarget({ kind: "captain", project: ALPHA })).toBe("alpha's Captain")
    expect(selectionTarget({ kind: "orchestrator" })).toBe("the Coordinator")
  })

  it("keeps a draft per selection", () => {
    expect(selectionScope("one")).toBe(selectionScope("one"))
    expect(selectionScope("one")).not.toBe(selectionScope("two"))
  })
})
