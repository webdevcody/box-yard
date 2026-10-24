// @vitest-environment happy-dom
// The task page's Queued rows: edit in place, delete with Undo, the "already delivered" case and the "N queued" link.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { QueuedLink, TaskQueue } from "../web/src/components/QueuedMessages.js"
import { keys } from "../web/src/lib/queries.js"
import { UNDO_MS } from "../web/src/lib/inbox.js"
import { currentToasts as toasts } from "../web/src/lib/toast.js"
import type { QueuedMessage, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let server: QueuedMessage[]
let calls: { method: string; url: string; body: unknown }[]

const TASK = "task_queue01"
const msg = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  taskId: TASK,
  source: "cody",
  kind: "owner",
  sender: "Cody",
  text,
  attachments: [],
  status: "queued",
  version: 1,
  createdAt: Date.parse("2026-10-24T10:00:00Z") + Number(id.slice(-1)) * 1000,
  updatedAt: 0,
  ...extra,
})

const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  history.replaceState(null, "", `/tasks/${TASK}`)
  server = [msg("in_aaaaaa1", "use blue"), msg("in_aaaaaa2", "add a footer", { source: "orchestrator", kind: "coordinator", sender: "Coordinator" })]
  calls = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const m = url.match(/^\/api\/tasks\/[^/]+\/queue(?:\/([^/]+))?(\/restore)?$/)
    if (!m) return new Promise(() => {})
    if (method === "GET") return json(server)
    const found = server.find((x) => x.id === m[1])
    if (method === "PATCH") {
      if (!found) return json({ error: "That message was already delivered to the agent (or the task was stopped), so it can't be changed." }, 409)
      Object.assign(found, { text: body.text, version: found.version + 1 })
      return json(found)
    }
    if (method === "DELETE") {
      server = server.filter((x) => x !== found)
      return json(found)
    }
    return json(m[1])
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: TASK, pendingCount: 2, queueRev: "2.2.0.1" }])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
/** Let fetches resolve and React Query notify (it batches on a timer). */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const click = (el: Element) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  act(() => void el.dispatchEvent(e))
  return e
}
const rows = () => [...host.querySelectorAll("[data-testid=queued-message]")]
const byLabel = (row: Element, label: string) => row.querySelector(`button[aria-label="${label}"]`)!
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!
const type = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("Queued rows", () => {
  it("lists queued messages in send order with Queued, the sender and the time", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.textContent).toContain("Queued")
    expect(rows()[0]!.textContent).toContain("Cody")
    expect(rows()[0]!.textContent).toContain("use blue")
    expect(rows()[1]!.textContent).toContain("Coordinator")
    expect(rows()[0]!.querySelector("time, [title]")).not.toBeNull()
    expect(host.querySelector("[aria-label='Queued messages']")?.id).toBe("task-queue")
  })

  it("edits a row in place: Save sends the text with its version, Cancel and Escape keep the old text", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    click(byLabel(rows()[0]!, "Edit queued message"))
    let area = host.querySelector("textarea")!
    expect(area.value).toBe("use blue")
    type(area, "use green")
    click(button("Cancel"))
    expect(host.querySelector("textarea")).toBeNull()
    expect(rows()[0]!.textContent).toContain("use blue")

    click(byLabel(rows()[0]!, "Edit queued message"))
    area = host.querySelector("textarea")!
    type(area, "use green")
    act(() => void area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })))
    expect(host.querySelector("textarea")).toBeNull()
    // Optimistic: the row shows the new text at once.
    expect(rows()[0]!.textContent).toContain("use green")
    await settle()
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", url: `/api/tasks/${TASK}/queue/in_aaaaaa1`, body: { text: "use green", version: 1 } })
    expect(rows()[0]!.textContent).toContain("use green")

    click(byLabel(rows()[1]!, "Edit queued message"))
    act(() => void host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(host.querySelector("textarea")).toBeNull()
  })

  it("deletes a row, leaves an Undo line in its place, and Undo restores it", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    click(byLabel(rows()[0]!, "Delete queued message"))
    await settle()
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`/api/tasks/${TASK}/queue/in_aaaaaa1`)
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("add a footer")])
    const undo = host.querySelector("[data-testid=queued-deleted]")!
    expect(undo.textContent).toContain("Queued message deleted")
    // Still first: in its old place.
    expect(host.querySelector("[role=list]")!.firstElementChild).toBe(undo)

    server.unshift(msg("in_aaaaaa1", "use blue"))
    click(button("Undo"))
    expect(host.querySelector("[data-testid=queued-deleted]")).toBeNull()
    await settle()
    expect(calls.find((c) => c.url.endsWith("/restore"))).toMatchObject({ method: "POST", url: `/api/tasks/${TASK}/queue/in_aaaaaa1/restore` })
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("use blue"), expect.stringContaining("add a footer")])
  })

  it("drops the Undo line after a few seconds", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    click(byLabel(rows()[1]!, "Delete queued message"))
    await settle()
    expect(host.querySelector("[data-testid=queued-deleted]")).not.toBeNull()
    await act(async () => void (await new Promise((r) => setTimeout(r, UNDO_MS + 50))))
    expect(host.querySelector("[data-testid=queued-deleted]")).toBeNull()
  }, 10_000)

  it("locks a row that is being delivered, and says so when an open edit loses the race", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    click(byLabel(rows()[0]!, "Edit queued message"))
    type(host.querySelector("textarea")!, "too late?")

    // The turn ends and takes the queue: the row is locked, Save is off.
    server = server.map((m) => ({ ...m, status: "delivering" as const }))
    act(() => qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: TASK, pendingCount: 2, queueRev: "2.2.2.1" }]))
    await settle()
    expect(host.querySelector("[role=status]")?.textContent).toMatch(/Being delivered/)
    expect(button("Save").disabled).toBe(true)
    expect(host.querySelector("textarea")!.readOnly).toBe(true)
    expect(byLabel(rows()[1]!, "Delete queued message")).toBeNull()
    expect(rows()[1]!.textContent).toContain("Delivering")

    // Delivered: the row goes and the edit is reported as not saved.
    server = []
    act(() => qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: TASK, pendingCount: 0, queueRev: "" }]))
    await settle()
    expect(rows()).toHaveLength(0)
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Already delivered" })
    expect(calls.some((c) => c.method === "PATCH")).toBe(false)
  })

  it("rolls back an edit the server refuses with 409 and shows why", async () => {
    render(createElement(TaskQueue, { taskId: TASK }))
    await settle()
    click(byLabel(rows()[1]!, "Edit queued message"))
    type(host.querySelector("textarea")!, "changed")
    // Delivered between the last refetch and Save.
    server = server.filter((m) => m.id !== "in_aaaaaa2")
    click(button("Save"))
    await settle()
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Couldn't save the edit", body: expect.stringMatching(/already delivered/) })
    expect(rows().some((r) => r.textContent?.includes("changed"))).toBe(false)
  })
})

describe("N queued link", () => {
  it("opens the task's queue without following the card link around it", () => {
    history.replaceState(null, "", "/")
    const seen: string[] = []
    window.addEventListener("box-yard:reveal-queue", (e) => seen.push((e as CustomEvent<string>).detail))
    render(createElement("a", { href: `/tasks/${TASK}` }, createElement(QueuedLink, { taskId: TASK, count: 3 })))
    const b = host.querySelector("button")!
    expect(b.textContent).toBe("3 queued")
    const e = click(b)
    expect(e.defaultPrevented).toBe(true)
    expect(location.pathname + location.hash).toBe(`/tasks/${TASK}#queue`)
    expect(seen).toEqual([TASK])
  })
})
