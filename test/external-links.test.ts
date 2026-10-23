// @vitest-environment happy-dom
// Links in rendered agent text: other sites open in a new tab, in-app links navigate in place, and neither
// triggers the clickable card around it (the Coordinator's task notices, task cards).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { Markdown, PrChip } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PR = "https://github.com/webdevcody/box-yard/pull/66"

let root: Root
let host: HTMLElement
let qc: QueryClient
let opened: unknown[][]

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  opened = []
  vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
    opened.push(args)
    return null
  })
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
/** Dispatch a click and report whether the app cancelled the browser's default (following the href). */
const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  return { prevented: e.defaultPrevented }
}
const link = (text: string) => [...host.querySelectorAll("a")].find((a) => a.textContent === text)!
const isNewTab = (a: HTMLAnchorElement) => a.target === "_blank" && a.rel === "noopener noreferrer"

describe("links in rendered markdown", () => {
  const md = (text: string) => render(createElement(Markdown, null, text))

  it("opens a bare URL in a new tab", () => {
    md(`PR #66: ${PR} Before each new workspace…`)
    const a = link(PR)
    expect(a.getAttribute("href")).toBe(PR)
    expect(isNewTab(a)).toBe(true)
    expect(click(a).prevented).toBe(false)
    expect(location.pathname).toBe("/")
  })

  it("opens a markdown link to another site in a new tab", () => {
    md(`See [the PR](${PR}).`)
    expect(isNewTab(link("the PR"))).toBe(true)
  })

  it("navigates a relative /tasks/… link in place, and leaves Cmd/Ctrl-click to the browser", () => {
    md("Open [the task](/tasks/task_abcdef123456).")
    const a = link("the task")
    expect(a.target).toBe("")
    expect(click(a).prevented).toBe(true)
    expect(location.pathname).toBe("/tasks/task_abcdef123456")
    // The browser opens these in a new tab itself.
    expect(click(a, { metaKey: true }).prevented).toBe(false)
    expect(click(a, { ctrlKey: true }).prevented).toBe(false)
  })

  it("treats an absolute link to Box Yard itself as in-app", () => {
    md(`Back to [the yard](${location.origin}/projects/prj_abcdef?tab=tasks).`)
    const a = link("the yard")
    expect(a.getAttribute("href")).toBe("/projects/prj_abcdef?tab=tasks")
    expect(a.target).toBe("")
    expect(click(a).prevented).toBe(true)
    expect(location.pathname + location.search).toBe("/projects/prj_abcdef?tab=tasks")
  })

  it("never lets a link's click reach a clickable card around it", () => {
    const card = vi.fn()
    render(createElement("div", { onClick: card }, createElement(Markdown, null, `${PR} and [a task](/tasks/task_abcdef123456)`)))
    click(link(PR))
    click(link("a task"))
    click(link("a task"), { metaKey: true })
    expect(card).not.toHaveBeenCalled()
  })
})

describe("task notices in the Coordinator chat", () => {
  const notice: ChatMessage = {
    id: "chat_notice1",
    role: "notice",
    content: `✅ **Low-disk handling** is done: PR #66: ${PR} Before each new workspace a df check runs.`,
    meta: { taskId: "task_848359a52eb2" },
    createdAt: Date.now(),
  }

  it("opens the PR link in a new tab instead of the task", () => {
    render(createElement(ChatLine, { m: notice, onFollowUp: () => {} }))
    const a = link(PR)
    // Not nested inside another link, which would swallow the click.
    expect(a.parentElement!.closest("a")).toBeNull()
    expect(isNewTab(a)).toBe(true)
    expect(click(a).prevented).toBe(false)
    expect(location.pathname).toBe("/")
  })

  it("still opens the task when the card itself is clicked (Cmd/Ctrl-click: a new tab)", () => {
    render(createElement(ChatLine, { m: notice, onFollowUp: () => {} }))
    const card = host.querySelector('[role="link"]')!
    click(card, { ctrlKey: true })
    expect(opened).toEqual([["/tasks/task_848359a52eb2", "_blank", "noopener"]])
    expect(location.pathname).toBe("/")
    click(card)
    expect(location.pathname).toBe("/tasks/task_848359a52eb2")
  })
})

describe("PR chip", () => {
  it("opens the PR in a new tab, not the card it sits on", () => {
    const card = vi.fn()
    render(createElement("div", { onClick: card }, createElement(PrChip, { task: { status: "pr_ready", prUrl: PR, prState: "open" } })))
    const a = host.querySelector<HTMLAnchorElement>("a[data-pr-state]")!
    expect(isNewTab(a)).toBe(true)
    expect(click(a).prevented).toBe(false)
    expect(card).not.toHaveBeenCalled()
  })
})
