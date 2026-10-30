// @vitest-environment happy-dom
// Collapsed tool lines (ToolLine in components/ChatLine.tsx) on a narrow row: the tool name never shrinks, the
// preview gives way first, then the target. happy-dom has no layout, so this reads the flex classes that decide it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { keys } from "../web/src/lib/queries.js"
import { ToolLine } from "../web/src/components/ChatLine.js"
import type { ChatMessage, Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

const project = { id: "prj_boxyard1", name: "box-yard", repo: "webdevcody/box-yard" } as Project
const tool = (content: string, input: Record<string, unknown>): ChatMessage => ({ id: `chat_${content}`, role: "tool", content, meta: { input }, createdAt: Date.now() })
const render = (m: ChatMessage) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ToolLine, { m }))))
const $ = (sel: string) => host.querySelector<HTMLElement>(sel)
const classes = (el: Element | null) => new Set((el?.getAttribute("class") ?? "").split(/\s+/))

/** The tool name keeps its width: it doesn't shrink, and nothing lets it shrink to zero. */
function expectFixedName() {
  const name = $('[data-testid="tool-name"]')!
  const c = classes(name)
  expect(c.has("shrink-0")).toBe(true)
  expect(c.has("min-w-0")).toBe(false)
  expect(c.has("flex-1")).toBe(false)
  return name
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes, keys.tasks]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe("collapsed tool lines", () => {
  it("send_to_captain keeps its name whole; the preview gives way first, then the Captain", () => {
    render(tool("send_to_captain", { project: "box-yard", message: "New box-yard request from Cody: fix the collapsed tool cards" }))
    expect(expectFixedName().textContent).toBe("send_to_captain")
    const target = [...host.querySelectorAll("a")].find((a) => a.textContent === "box-yard Captain")!
    expect(classes(target).has("min-w-0")).toBe(true)
    expect(classes(target).has("truncate")).toBe(true)
    expect(classes(target).has("shrink-0")).toBe(false)
    const preview = $('[data-testid="tool-preview"]')!
    expect(preview.textContent).toContain("New box-yard request")
    // flex-1 grows from a zero basis, so the preview only takes the room the name and the Captain leave.
    for (const c of ["min-w-0", "flex-1", "truncate"]) expect(classes(preview).has(c)).toBe(true)
  })

  it("an unknown project's Captain truncates too", () => {
    render(tool("ask_captain", { project: "elsewhere", message: "Is the deploy done?" }))
    expectFixedName()
    const target = $('[data-testid="tool-target"]')!
    expect(target.textContent).toBe("elsewhere Captain")
    expect(classes(target).has("min-w-0")).toBe(true)
  })

  it("other tools keep their name whole and truncate their detail", () => {
    render(tool("create_task", { title: "A very long task title that would otherwise squeeze the tool name away" }))
    expect(expectFixedName().textContent).toBe("create_task")
    const detail = $('[data-testid="tool-target"]')!
    for (const c of ["min-w-0", "truncate"]) expect(classes(detail).has(c)).toBe(true)
  })
})
