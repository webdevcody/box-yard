// @vitest-environment happy-dom
// GitHub references in the app's text: linked to the repo of the task or project the text is about (InRepo), in a
// new tab with the ↗, and a PR a task has wears its state's colours (merged is purple).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { TaskCard } from "../web/src/components/TaskCard.js"
import { InRepo, LinkedText, Markdown } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STN = "https://github.com/webdevcody/survive-the-night"
const projects = [{ id: "prj_survive", name: "survive-the-night", repo: "webdevcody/survive-the-night" }] as Project[]
const hollow = {
  id: "task_hollow0406",
  projectId: "prj_survive",
  title: "Map 3 PR #406: The Hollow cave supply route",
  status: "done",
  prUrl: `${STN}/pull/406`,
  prState: "merged",
  summary: "PR #406 merged clean with map3-epic and was pushed (head 8269e827).",
  previews: [],
  prompt: "",
  claudeCostUsd: 0,
  claudeTokens: 0,
  pendingCount: 0,
  updatedAt: Date.now(),
  createdAt: Date.now(),
} as unknown as Task

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, projects)
  qc.setQueryData(keys.tasks, [hollow])
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
const linkTo = (href: string) => host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
const hasMark = (a: Element) => Boolean(a.querySelector("[data-external-mark]"))
const inTask = (node: ReactNode) => createElement(InRepo, { taskId: "task_hollow0406", children: node })

describe("GitHub references in markdown", () => {
  it("links PR, issue and commit references to the task's repo, in a new tab with the ↗", () => {
    render(inTask(createElement(Markdown, null, "PR #406 merged as 8269e827; #12 is next.")))
    const pr = linkTo(`${STN}/pull/406`)!
    expect(pr.textContent).toBe("PR #406")
    expect(pr.target).toBe("_blank")
    expect(hasMark(pr)).toBe(true)
    const commit = linkTo(`${STN}/commit/8269e827`)!
    expect(commit.textContent).toBe("8269e827")
    expect(hasMark(commit)).toBe(true)
    // An issue nobody's PR has: a plain new-tab link, no PR glyph.
    const issue = linkTo(`${STN}/issues/12`)!
    expect(issue.dataset.prLink).toBeUndefined()
    expect(hasMark(issue)).toBe(true)
  })

  it("colours a PR a task has by its state, a bare #N included", () => {
    render(inTask(createElement(Markdown, null, "PR #406 merged, see #406.")))
    expect(linkTo(`${STN}/pull/406`)!.dataset.prLink).toBe("merged")
    expect(linkTo(`${STN}/pull/406`)!.className).toContain("text-merged-fg")
    const bare = linkTo(`${STN}/issues/406`)!
    expect(bare.dataset.prLink).toBe("merged")
    expect(bare.className).toContain("text-merged-fg")
  })

  it("leaves numbers as text where no repo is known", () => {
    render(createElement(Markdown, null, "PR #406 merged as 8269e827; #12 is next."))
    expect(host.querySelectorAll("a")).toHaveLength(0)
    expect(host.textContent).toBe("PR #406 merged as 8269e827; #12 is next.")
  })
})

describe("where text is shown", () => {
  it("links a task notice's text to its task's repo", () => {
    const m: ChatMessage = {
      id: "chat_hollow01",
      role: "notice",
      content: "✅ **Map 3 PR #406: The Hollow cave supply route** is done: PR #406 merged clean (head 8269e827).",
      meta: { taskId: "task_hollow0406", projectId: "prj_survive" },
      createdAt: Date.now(),
    }
    render(createElement(InRepo, { mentions: true, children: createElement(ChatLine, { m, onFollowUp: () => {} }) }))
    expect(linkTo(`${STN}/pull/406`)!.dataset.prLink).toBe("merged")
    expect(linkTo(`${STN}/commit/8269e827`)).toBeTruthy()
  })

  it("links a task card's summary with buttons, so no anchor nests in the card", () => {
    const opened: unknown[][] = []
    vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
      opened.push(args)
      return null
    })
    render(createElement(TaskCard, { task: { ...hollow, prUrl: null, prState: null } as unknown as Task }))
    const card = host.querySelector("a")!
    expect(card.querySelectorAll("a")).toHaveLength(0)
    const pr = host.querySelector<HTMLButtonElement>(`button[data-href="${STN}/pull/406"]`)!
    expect(pr.textContent).toBe("PR #406")
    expect(pr.title).toBe(`${STN}/pull/406`)
    expect(hasMark(pr)).toBe(true)
    expect(host.querySelector(`button[data-href="${STN}/commit/8269e827"]`)).toBeTruthy()
    const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    act(() => void pr.dispatchEvent(e))
    // GitHub opens in a new tab, and the cancelled click keeps the browser from following the card's link. (happy-dom
    // follows an <a> mid-bubble, before React's handler can cancel it, so the URL can't be checked here.)
    expect(opened).toEqual([[`${STN}/pull/406`, "_blank", "noopener,noreferrer"]])
    expect(e.defaultPrevented).toBe(true)
  })

  it("colours a card's PR reference by the task's PR state", () => {
    render(createElement(TaskCard, { task: hollow }))
    const pr = host.querySelector<HTMLButtonElement>(`button[data-href="${STN}/pull/406"]`)!
    expect(pr.dataset.prLink).toBe("merged")
    expect(pr.className).toContain("text-merged-fg")
  })

  it("keeps plain text plain", () => {
    render(inTask(createElement(LinkedText, { text: "Build and unit tests pass." })))
    expect(host.innerHTML).toBe("Build and unit tests pass.")
  })
})
