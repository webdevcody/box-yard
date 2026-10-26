// @vitest-environment happy-dom
// Send now on the task page's Queued rows: the inline confirm while a turn runs, the merge warning, no confirm
// when nothing would be interrupted, and the "Delivered when the current turn ends" wording.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskQueue } from "../web/src/components/QueuedMessages.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts as toasts } from "../web/src/lib/toast.js"
import type { QueuedMessage, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { method: string; url: string; body: unknown }[]
let sendNowReply: { status: number; data: unknown }

const TASK = "task_sendnow1"
const msg = (id: string, text: string): QueuedMessage => ({
  id,
  taskId: TASK,
  source: "cody",
  kind: "owner",
  sender: "Cody",
  text,
  attachments: [],
  status: "queued",
  version: 1,
  createdAt: Date.parse("2026-10-26T10:00:00Z") + Number(id.slice(-1)) * 1000,
  updatedAt: 0,
})

const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  calls = []
  sendNowReply = { status: 200, data: { task: { id: TASK }, delivery: "interrupted", queued: 2 } }
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === `/api/tasks/${TASK}/queue/send-now` && method === "POST") return json(sendNowReply.data, sendNowReply.status)
    if (url === `/api/tasks/${TASK}/queue` && method === "GET") return json([msg("in_bbbbbb1", "use blue"), msg("in_bbbbbb2", "add a footer")])
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const seed = (task: Partial<Task>) => qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: TASK, pendingCount: 2, queueRev: "1", compacting: false, mergeRequest: null, ...task }])
const render = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskQueue, { taskId: TASK }))))
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const rows = () => [...host.querySelectorAll("[data-testid=queued-message]")]
const sendNowButton = (row: Element) => row.querySelector('button[aria-label="Send queued messages now"]')!
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)
const posts = () => calls.filter((c) => c.method === "POST")

describe("Send now on Queued rows", () => {
  it("sits next to Edit and Delete, says when the message goes out, and asks inline before stopping a running turn", async () => {
    seed({ status: "working" })
    render()
    await settle()
    const labels = [...rows()[1]!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
    expect(labels).toEqual(["Send queued messages now", "Edit queued message", "Delete queued message"])
    expect(sendNowButton(rows()[0]!).getAttribute("title")).toBe("Send now: stops the current step and sends the queued messages now")
    expect(rows()[0]!.textContent).toContain("Delivered when the current turn ends.")

    // On the second row, it still sends the whole queue: the confirm says how many, and nothing is sent yet.
    click(sendNowButton(rows()[1]!))
    const dialog = host.querySelector("[role=alertdialog]")!
    expect(rows()[1]!.contains(dialog)).toBe(true)
    expect(host.querySelector(".fixed")).toBeNull() // inline, not a modal
    expect(dialog.textContent).toContain("Stops the current step and sends all 2 queued messages now, in order.")
    expect(posts()).toEqual([])

    // Keep waiting closes it; Escape does too.
    click(button("Keep waiting")!)
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    click(sendNowButton(rows()[0]!))
    act(() => void host.querySelector("[role=alertdialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    expect(posts()).toEqual([])

    click(sendNowButton(rows()[0]!))
    expect(document.activeElement?.textContent?.trim()).toBe("Send now")
    click(button("Send now")!)
    await settle()
    expect(posts()).toEqual([{ method: "POST", url: `/api/tasks/${TASK}/queue/send-now`, body: { allowMergeInterrupt: false } }])
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    expect(toasts().some((t) => t.title === "Sending now" && /all 2 queued messages, in order/.test(t.body ?? ""))).toBe(true)
  })

  it("warns about a merge in progress and only then sends allowMergeInterrupt", async () => {
    seed({ status: "working", mergeRequest: { prNumber: 12, prUrl: "https://github.com/a/b/pull/12", requestedAt: 1, deliveredAt: 2 } })
    render()
    await settle()
    click(sendNowButton(rows()[0]!))
    const dialog = host.querySelector("[role=alertdialog]")!
    expect(dialog.querySelector("[role=alert]")?.textContent).toBe("The agent is merging PR #12 in this turn. Sending now stops the merge midway.")
    expect(button("Send now")).toBeUndefined()
    click(button("Stop the merge and send")!)
    await settle()
    expect(posts()[0]!.body).toEqual({ allowMergeInterrupt: true })
  })

  it("sends at once, without a confirm, when no turn is running", async () => {
    seed({ status: "queued" })
    sendNowReply = { status: 200, data: { task: { id: TASK }, delivery: "next_turn", queued: 2 } }
    render()
    await settle()
    expect(rows()[0]!.textContent).toContain("Delivered when the agent's next turn starts.")
    expect(sendNowButton(rows()[0]!).getAttribute("title")).toBe("Send now")
    click(sendNowButton(rows()[0]!))
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    await settle()
    expect(posts()).toHaveLength(1)
    expect(toasts().some((t) => t.title === "Sending")).toBe(true)
  })

  it("shows the server's refusal", async () => {
    seed({ status: "working" })
    sendNowReply = { status: 409, data: { error: "The agent is merging PR #3 in its current turn, so sending now would stop the merge midway." } }
    render()
    await settle()
    click(sendNowButton(rows()[0]!))
    click(button("Send now")!)
    await settle()
    expect(toasts().some((t) => t.kind === "error" && t.title === "Couldn't send now" && /merging PR #3/.test(t.body ?? ""))).toBe(true)
  })
})
