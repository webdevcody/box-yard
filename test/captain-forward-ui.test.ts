// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CaptainAnswerLine, TaskComposer, ToCaptainLine } from "../web/src/components/CaptainForward.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let posts: { url: string; body: unknown }[]
const onSubmit = vi.fn(async () => {})

const task = (patch: Partial<Task> = {}) => ({ id: "task_abc123", projectId: "prj_demo01", title: "Login form", status: "working", pendingCount: 2, ...patch }) as Task
const project = { id: "prj_demo01", name: "demo" } as Project

beforeEach(() => {
  posts = []
  onSubmit.mockClear()
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }))
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      const msg: TaskMessage = { id: "tm_1", taskId: "task_abc123", role: "event", content: "x", meta: { kind: "to_captain" }, createdAt: 1 }
      return new Response(JSON.stringify(msg), { status: 201 })
    }
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(t: Task) {
  const panel = createRef<HTMLElement>()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement("section", { ref: panel }, createElement(TaskComposer, { task: t, project, panelRef: panel, onSubmit })),
      ),
    ),
  )
}

const textarea = () => document.querySelector("textarea")!
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const submitForm = () => act(() => void document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))

describe("TaskComposer: send to the Captain", () => {
  it("offers the Captain chip only while the task is busy or has queued messages", () => {
    render(task({ status: "idle", pendingCount: 0 }))
    expect(q("captain-target")).toBeNull()
    render(task({ status: "idle", pendingCount: 1 }))
    expect(q("captain-target")).not.toBeNull()
    render(task({ status: "working", pendingCount: 0 }))
    expect(q("captain-target")?.getAttribute("aria-pressed")).toBe("false")
  })

  it("by default a message goes to the task, even one that reads like task management", async () => {
    render(task())
    type("split this out into its own task")
    submitForm()
    expect(onSubmit).toHaveBeenCalledWith("split this out into its own task", [])
    expect(posts).toEqual([])
  })

  it("the chip sends the next message to the Captain, then goes back to the task", async () => {
    render(task())
    act(() => q("captain-target")!.click())
    expect(q("captain-target")!.getAttribute("aria-pressed")).toBe("true")
    expect(textarea().placeholder).toContain("demo Captain")
    expect(q("captain-forward-note")!.textContent).toContain("with this task's 2 queued messages")
    type("what's left in the queue")
    await act(async () => submitForm())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(posts).toEqual([{ url: "/api/tasks/task_abc123/captain", body: { content: "what's left in the queue", attachments: [] } }])
    expect(q("captain-target")!.getAttribute("aria-pressed")).toBe("false")
  })

  it("suggests the Captain for a task-management draft and sends it there in one tap; × keeps it for the task", async () => {
    render(task())
    type("fix the footer")
    expect(q("captain-suggest")).toBeNull()
    type("move the dark mode item to a new task")
    expect(q("captain-suggest")).not.toBeNull()
    // Dismissed: the draft stays, and Enter sends it to the task.
    act(() => q("captain-suggest")!.querySelector<HTMLButtonElement>('[aria-label="Keep it for the task"]')!.click())
    expect(q("captain-suggest")).toBeNull()
    expect(textarea().value).toBe("move the dark mode item to a new task")
    submitForm()
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // A new draft is offered again; "Send to Captain" sends it there at once.
    type("reprioritise this below the login fix")
    const send = [...q("captain-suggest")!.querySelectorAll("button")].find((b) => b.textContent?.includes("Send to Captain"))!
    await act(async () => send.click())
    expect(posts).toEqual([{ url: "/api/tasks/task_abc123/captain", body: { content: "reprioritise this below the login fix", attachments: [] } }])
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe("")
  })

  it("doesn't suggest the Captain for a resting task with nothing queued", () => {
    render(task({ status: "idle", pendingCount: 0 }))
    type("split this out into its own task")
    expect(q("captain-suggest")).toBeNull()
  })
})

describe("thread lines", () => {
  const renderLine = (el: ReturnType<typeof createElement>) =>
    act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, el)))

  it("shows a message sent to the Captain with its queue count and a link to the Captain chat", () => {
    const m: TaskMessage = { id: "tm_1", taskId: "task_abc123", role: "event", content: "split it", meta: { kind: "to_captain", captainName: "demo", captainProjectId: "prj_demo01", queued: 2 }, createdAt: Date.now() }
    renderLine(createElement(ToCaptainLine, { m }))
    const line = q("to-captain")!
    expect(line.textContent).toContain("→ demo Captain")
    expect(line.textContent).toContain("sent to the Captain, with 2 queued messages")
    expect(line.textContent).toContain("split it")
    expect(line.querySelector("a")!.getAttribute("href")).toBe("/projects/prj_demo01?tab=captain")
  })

  it("shows the Captain's reply", () => {
    const m: TaskMessage = { id: "tm_2", taskId: "task_abc123", role: "event", content: "Done: started **Dark mode**.", meta: { kind: "captain_answer", captainName: "demo", captainProjectId: "prj_demo01" }, createdAt: Date.now() }
    renderLine(createElement(CaptainAnswerLine, { m }))
    const line = q("captain-answer")!
    expect(line.textContent).toContain("demo Captain · replied")
    expect(line.querySelector("strong")?.textContent).toBe("Dark mode")
  })
})
