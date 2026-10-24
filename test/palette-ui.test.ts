// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CommandPalette, openPalette } from "../web/src/components/CommandPalette.js"
import { keys } from "../web/src/lib/queries.js"
import type { Artifact, Project, SettingsInfo, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const task = (id: string, title: string, status: Task["status"], age: number) =>
  ({ id, title, status, projectId: "prj_a", updatedAt: now - age * 60_000, createdAt: 1, prUrl: null, prState: null, summary: null }) as unknown as Task

const TASKS = [
  task("tsk_ask", "Pick a color", "needs_input", 1),
  task("tsk_pr", "Review the palette PR", "pr_ready", 2),
  ...Array.from({ length: 7 }, (_, i) => task(`tsk_w${i}`, `Working task ${i}`, "working", 10 + i)),
  task("tsk_done", "Finished thing", "done", 100),
]
const PROJECTS = [{ id: "prj_a", name: "box-yard", repo: "webdevcody/box-yard", description: "", updatedAt: 1 }] as unknown as Project[]
const ARTIFACTS = [{ id: "art_1", projectId: "prj_a", taskId: null, title: "Screenshot", filename: "shot.png", mime: "image/png", size: 1, url: "/artifacts/art_1/shot.png", createdAt: now }] as Artifact[]

let root: Root
let host: HTMLElement
let qc: QueryClient

function render() {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.artifacts, ARTIFACTS)
  qc.setQueryData(keys.schedules, [])
  qc.setQueryData(keys.boxes, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CommandPalette))))
  act(() => openPalette())
}

beforeEach(() => {
  history.replaceState(null, "", "/")
  localStorage.clear()
  localStorage.setItem("box-yard:recent", JSON.stringify(["project:prj_a", "task:tsk_done", "task:tsk_ask"]))
  localStorage.setItem("box-yard:command-usage", JSON.stringify({ "page:boxes": 3 }))
  vi.stubGlobal("fetch", () => new Promise(() => {}))
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

const input = () => document.querySelector<HTMLInputElement>("input[role=combobox]")!
const groupLabels = () => [...document.querySelectorAll("[role=group]")].map((g) => g.querySelector("[id]")!.textContent)
const groupRows = (key: string) => [...document.querySelectorAll(`[data-group=${key}] [role=option]`)].map((o) => o.textContent!.trim())
const selected = () => document.querySelector("[role=option][aria-selected=true]")!
const press = (key: string, init: KeyboardEventInit = {}) => act(() => void input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })))
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("command palette", () => {
  it("opens on the empty-query sections in order, with the owner's name and no files", () => {
    render()
    expect(groupLabels()).toEqual(["Waiting on Ada", "Working", "Recently viewed", "Commands"])
    expect(groupRows("waiting").map((t) => t.split("Needs")[0]!.split("PR ready")[0])).toEqual(["Pick a colorbox-yard", "Review the palette PRbox-yard"])
    // Tasks already listed above don't repeat under Recently viewed.
    expect(groupRows("recent")[0]).toContain("box-yard")
    expect(groupRows("recent").some((r) => r.startsWith("Finished thing"))).toBe(true)
    expect(groupRows("recent").some((r) => r.startsWith("Pick a color"))).toBe(false)
    expect(groupRows("command")[0]).toContain("Boxes")
    expect(document.querySelector("[data-key^='artifact:']")).toBeNull()
    expect(document.querySelector("[data-testid=palette-prefixes]")!.textContent).toContain("f:Files")
  })

  it("caps a group with a Show all row that expands it inline", () => {
    render()
    const working = groupRows("working")
    expect(working).toHaveLength(6)
    expect(working.at(-1)).toBe("Show all 7 →")
    act(() => void document.querySelector("[data-group=working] [data-testid=palette-show-all]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(groupRows("working")).toHaveLength(7)
    expect(groupRows("working").at(-1)).toContain("Working task 6")
  })

  it("moves with the arrows across groups and through expanded rows", () => {
    render()
    expect(selected().textContent).toContain("Pick a color")
    press("ArrowDown")
    press("ArrowDown")
    expect(selected().textContent).toContain("Working task 0")
    for (let i = 0; i < 5; i++) press("ArrowDown")
    expect(selected().textContent).toBe("Show all 7 →")
    press("Enter")
    // The first row that was hidden takes the Show all row's place, and the arrows go on through the rest.
    expect(selected().textContent).toContain("Working task 5")
    press("ArrowDown")
    expect(selected().textContent).toContain("Working task 6")
    press("ArrowDown")
    expect(selected().closest("[role=group]")!.getAttribute("data-group")).toBe("recent")
    press("ArrowUp")
    press("ArrowUp")
    expect(selected().textContent).toContain("Working task 5")
  })

  it("opens the selected item in a new tab on Cmd/Ctrl+Enter and keeps the palette open", () => {
    const open = vi.fn()
    vi.stubGlobal("open", open)
    render()
    press("Enter", { ctrlKey: true })
    expect(open).toHaveBeenCalledWith("/tasks/tsk_ask", "_blank", "noopener")
    expect(input()).not.toBeNull()
    press("Enter")
    expect(window.location.pathname).toBe("/tasks/tsk_ask")
    expect(document.querySelector("input[role=combobox]")).toBeNull()
  })

  it("ranks by the query: tasks first for a name, files first for an extension", () => {
    render()
    type("palette")
    expect(groupLabels()[0]).toBe("Tasks")
    type(".png")
    expect(groupLabels()[0]).toBe("Files")
    expect(groupRows("artifact")[0]).toContain("Screenshot")
  })

  it("turns a typed prefix into a chip that Backspace removes", () => {
    render()
    type(">")
    expect(document.querySelector("[data-testid=palette-scope]")!.textContent).toContain("Commands")
    expect(input().value).toBe("")
    expect(groupLabels()).toEqual(["Commands"])
    type("box")
    expect(groupRows("command")[0]).toContain("Boxes")
    type("")
    press("Backspace")
    expect(document.querySelector("[data-testid=palette-scope]")).toBeNull()
    expect(groupLabels()[0]).toBe("Waiting on Ada")
  })

  it("doesn't re-render on live updates; the next keystroke picks them up", async () => {
    render()
    // React Query batches observer notifications on a timer, so wait one out.
    await act(async () => {
      qc.setQueryData(keys.tasks, [task("tsk_new", "Late arrival", "needs_input", 0), ...TASKS])
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(groupRows("waiting").some((r) => r.startsWith("Late arrival"))).toBe(false)
    type("late")
    expect(groupRows("task")[0]).toContain("Late arrival")
  })
})
