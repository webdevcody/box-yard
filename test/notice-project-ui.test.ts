// @vitest-environment happy-dom
// Task notices in the Coordinator chat (and Zen mode) link the task's project and that project's Captain.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { PublishedCard } from "../web/src/components/PublishedNotices.js"
import { groupPublished, type PublishedGroup } from "../web/src/lib/publishedNotices.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

const project = { id: "prj_tinytown", name: "tiny-town", repo: "webdevcody/tiny-town" } as Project
const task = { id: "task_painted01", title: "Building: Victorian Painted Lady", projectId: project.id, status: "idle" } as Task

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.tasks, [task])
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

const notice = (content: string, meta: Record<string, unknown> | null): ChatMessage => ({ id: "chat_notice01", role: "notice", content, meta, createdAt: 1 })
const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const line = (m: ChatMessage) => render(createElement(ChatLine, { m, onFollowUp: () => {} }))
const click = (el: Element) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  act(() => void el.dispatchEvent(e))
  return e
}
const chip = () => host.querySelector('[data-testid="notice-project"]')
const linkTo = (href: string) => host.querySelector(`[data-testid="notice-project"] a[href="${href}"]`)

const PR = `🔀 **${task.title}** opened a pull request: https://github.com/webdevcody/tiny-town/pull/106`

describe("task notice project and Captain links", () => {
  it("links the project page and its Captain tab, resolving the project from the task id", () => {
    line(notice(PR, { taskId: task.id }))
    expect(linkTo("/projects/prj_tinytown")?.textContent).toBe("tiny-town")
    expect(linkTo("/projects/prj_tinytown?tab=captain")?.textContent).toBe("Captain")
    // The task title still links the task.
    expect(host.querySelector('a[href="/tasks/task_painted01"]')).toBeTruthy()
  })

  it("the title has a row of its own; project · Captain and the event go on the line under it", () => {
    line(notice(PR, { taskId: task.id }))
    const title = host.querySelector('[data-testid="notice-title"]')!
    expect(title.textContent).toBe(task.title)
    expect(title.querySelectorAll("a")).toHaveLength(1)
    expect(title.querySelector("a")?.getAttribute("href")).toBe("/tasks/task_painted01")
    expect(title.contains(chip())).toBe(false)
    const meta = title.nextElementSibling!
    expect(meta.getAttribute("data-testid")).toBe("notice-meta")
    expect(meta.firstElementChild).toBe(chip())
    // The PR's URL reads as a short link.
    expect(meta.textContent).toContain("opened PR #106")
    expect(meta.querySelector('a[href="https://github.com/webdevcody/tiny-town/pull/106"]')?.textContent).toBe("PR #106")
  })

  it("prefers a project id the notice carries", () => {
    const other = { id: "prj_otherone", name: "other", repo: "x/other" } as Project
    qc.setQueryData(keys.projects, [project, other])
    line(notice(PR, { taskId: task.id, projectId: other.id }))
    expect(linkTo("/projects/prj_otherone")?.textContent).toBe("other")
  })

  it("clicking the project or Captain link navigates there, not to the task", () => {
    line(notice(PR, { taskId: task.id }))
    const e = click(linkTo("/projects/prj_tinytown?tab=captain")!)
    expect(e.defaultPrevented).toBe(true)
    expect(location.pathname + location.search).toBe("/projects/prj_tinytown?tab=captain")

    history.replaceState(null, "", "/")
    click(linkTo("/projects/prj_tinytown")!)
    expect(location.pathname + location.search).toBe("/projects/prj_tinytown")

    // The card itself still opens the task.
    history.replaceState(null, "", "/")
    click(host.querySelector('[role="link"]')!)
    expect(location.pathname).toBe("/tasks/task_painted01")
  })

  it("an old notice whose task (and so project) isn't known still renders, without a chip", () => {
    line(notice("✅ **Gone task** is done: it shipped.", { taskId: "task_unknown01" }))
    expect(host.textContent).toContain("Gone task")
    expect(host.textContent).toContain("it shipped.")
    expect(chip()).toBeNull()
  })

  it("a notice without a task has no chip", () => {
    line(notice("⚠️ Boxes are busy. Retrying in a minute.", null))
    expect(host.textContent).toContain("Boxes are busy")
    expect(chip()).toBeNull()
  })

  it("the published-files card links the project and Captain too", () => {
    const m: ChatMessage = {
      id: "chat_pub0001",
      role: "notice",
      content: `📎 **${task.title}** published Shot: https://yard.example.com/artifacts/art_1/shot.png`,
      meta: { taskId: task.id },
      createdAt: 1,
    }
    const g = groupPublished([m])[0] as { group: PublishedGroup }
    render(createElement(PublishedCard, { group: g.group }))
    expect(host.querySelectorAll('[data-testid="notice-project"]')).toHaveLength(1)
    click(linkTo("/projects/prj_tinytown?tab=captain")!)
    expect(location.pathname + location.search).toBe("/projects/prj_tinytown?tab=captain")
  })
})
