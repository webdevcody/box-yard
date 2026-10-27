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
const linkTo = (href: string) => host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!
const hasMark = (a: Element) => Boolean(a.querySelector("[data-external-mark]"))
const isNewTab = (a: HTMLAnchorElement) => a.target === "_blank" && a.rel === "noopener noreferrer"

describe("links in rendered markdown", () => {
  const md = (text: string) => render(createElement(Markdown, null, text))

  it("opens a bare URL in a new tab", () => {
    md(`PR #66: ${PR} Before each new workspace…`)
    const a = linkTo(PR)
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
    click(linkTo(PR))
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
    const a = linkTo(PR)
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

describe("internal vs external at a glance", () => {
  const md = (text: string) => render(createElement(Markdown, null, text))

  it("marks a link to another site with ↗ and its full URL on hover; in-app links and files get neither", () => {
    md("[docs](https://upstash.com/docs/box), [the task](/tasks/task_abcdef123456), [the yard](/projects/prj_abcdef) and [a shot](/artifacts/art_abcdef/shot.png)")
    const docs = link("docs")
    expect(hasMark(docs)).toBe(true)
    expect(docs.title).toBe("https://upstash.com/docs/box")
    expect(docs.querySelector("[data-external-mark]")!.getAttribute("aria-label")).toBe("(opens in a new tab)")
    for (const a of [link("the task"), link("the yard")]) {
      expect(hasMark(a)).toBe(false)
      expect(a.target).toBe("")
    }
    // An artifact opens in the app's preview, so it's in-app too.
    expect(hasMark(link("a shot"))).toBe(false)
    expect(click(link("a shot")).prevented).toBe(true)
    expect(location.pathname).toBe("/")
  })

  it("shortens a pasted GitHub PR or issue URL and keeps the URL in the href and tooltip", () => {
    md(`Opened ${PR} for https://github.com/webdevcody/box-yard/issues/12.`)
    expect(linkTo(PR).textContent).toBe("PR #66")
    expect(linkTo(PR).title).toBe(PR)
    expect(linkTo("https://github.com/webdevcody/box-yard/issues/12").textContent).toBe("webdevcody/box-yard#12")
    // Text the model chose stays as written.
    md(`See [the fix](${PR}).`)
    expect(linkTo(PR).textContent).toBe("the fix")
  })

  it("keeps the ↗ on one line with the link's last word", () => {
    md("Read [the Upstash Box docs](https://upstash.com/docs/box).")
    const glued = link("the Upstash Box docs").querySelector("[data-external-mark]")!.parentElement!
    expect(glued.className).toContain("whitespace-nowrap")
    expect(glued.textContent).toBe("docs")
  })

  it("colors a PR link by its task's PR state: merged is purple", () => {
    qc.setQueryData(keys.tasks, [{ id: "task_abcdef123456", title: "Fix", status: "done", projectId: "prj_abcdef", prUrl: PR, prState: "merged" }])
    md(`Merged ${PR}.`)
    const a = linkTo(PR)
    expect(a.dataset.prLink).toBe("merged")
    expect(a.className).toContain("text-merged-fg")
    expect(hasMark(a)).toBe(true)
  })
})

describe("shortened notices", () => {
  const long: ChatMessage = {
    id: "chat_notice2",
    role: "notice",
    content: `💬 **PR tracker misses manual merges** finished its turn: I opened the PR: ${PR}. A 403 fro [truncated: 2821 more chars — full reply: call wait_for_tasks or get_task]`,
    meta: { taskId: "task_848359a52eb2" },
    createdAt: Date.now(),
  }

  it("never shows the model's truncation hint, and links the task's full reply instead", () => {
    render(createElement(ChatLine, { m: long, onFollowUp: () => {} }))
    expect(host.textContent).not.toContain("[truncated")
    expect(host.textContent).not.toContain("wait_for_tasks")
    expect(host.textContent).toContain("A 403 fro…")
    const more = link("Read the full reply")
    expect(more.getAttribute("href")).toBe("/tasks/task_848359a52eb2")
    expect(hasMark(more)).toBe(false)
    expect(click(more).prevented).toBe(true)
    expect(location.pathname).toBe("/tasks/task_848359a52eb2")
  })
})

describe("PR chip", () => {
  it("opens the PR in a new tab, not the card it sits on", () => {
    const card = vi.fn()
    render(createElement("div", { onClick: card }, createElement(PrChip, { task: { status: "pr_ready", prUrl: PR, prState: "open" } })))
    const a = host.querySelector<HTMLAnchorElement>("a[data-pr-state]")!
    expect(isNewTab(a)).toBe(true)
    expect(hasMark(a)).toBe(true)
    expect(a.title).toContain(PR)
    expect(click(a).prevented).toBe(false)
    expect(card).not.toHaveBeenCalled()
  })
})
