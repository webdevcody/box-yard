// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SelectionToTask } from "../web/src/components/SelectionToTask.js"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { SideThreadPane, ThreadChatProvider } from "../web/src/components/SideThread.js"
import { keys } from "../web/src/lib/queries.js"
import { COORDINATOR_CHAT, applyThreadEvent, closeThread, forgetThread, openThread, openThreadId, threadKeys } from "../web/src/lib/threads.js"
import { findQuoteRange } from "../web/src/lib/threadHighlight.js"
import { MAIN_MIN_THREAD, THREAD_ROOM, coordinatorDock, threadDockWidth } from "../web/src/lib/layout.js"
import type { ChatMessage, Project, SettingsInfo, SideThread, SideThreadMessage } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPLY: ChatMessage = { id: "chat_reply01", role: "assistant", content: "The retry loop in **server/sync.ts** never backs off,\nso a dead remote spins the CPU.", meta: null, createdAt: 1 }
const thread = (over: Partial<SideThread> = {}): SideThread => ({
  id: "thr_abc123",
  projectId: null,
  anchorId: REPLY.id,
  kind: "ask",
  quote: "never backs off",
  context: "fork",
  busy: false,
  replies: 2,
  unread: false,
  resolvedAt: null,
  createdAt: 2,
  updatedAt: 2,
  ...over,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>

function render(threads: SideThread[] = []) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [] as Project[])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
  qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), threads)
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          ThreadChatProvider,
          { value: COORDINATOR_CHAT },
          createElement(SelectionToTask, { source: { kind: "orchestrator" }, onPrompt: vi.fn() }, createElement(ChatLine, { m: REPLY, onFollowUp: vi.fn() })),
          createElement(SideThreadPane, { chat: COORDINATOR_CHAT }),
        ),
      ),
    ),
  )
}

/** Select `text` in the reply, as a drag would. */
function select(text: string) {
  const range = findQuoteRange(host.querySelector("[data-chat-id]")!, text)!
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => void document.dispatchEvent(new Event("selectionchange")))
}

const click = (el: Element) => act(() => (el as HTMLElement).click())
/** Let the queries' batched notifications (a timeout) reach the components. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 10)))
const askButton = () => document.querySelector<HTMLButtonElement>("[data-testid=selection-ask]")

beforeEach(() => {
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
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
  for (const id of [openThreadId(COORDINATOR_CHAT)]) {
    if (!id) continue
    closeThread(COORDINATOR_CHAT)
    forgetThread(COORDINATOR_CHAT, id)
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Ask about a selection", () => {
  it("offers Ask beside Start new task, and asks in a new side thread anchored at the message", async () => {
    render()
    select("server/sync.ts never backs off")
    expect(askButton()).not.toBeNull()
    // Pressing it keeps the focus and the selection where they are.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    askButton()!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    click(askButton()!)
    const popover = document.querySelector("[data-testid=ask-popover]")!
    expect(popover.querySelector("[data-testid=ask-quote]")!.textContent).toBe("server/sync.ts never backs off")
    const box = popover.querySelector("textarea")!
    expect(document.activeElement).toBe(box)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Why does it spin?")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    await flush()
    const [url, init] = fetchMock.mock.calls.find(([u]) => u === "/api/threads")!
    expect(url).toBe("/api/threads")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({ anchorId: REPLY.id, quote: "server/sync.ts never backs off", question: "Why does it spin?", projectId: null })
    // It opens right away, with the question in it.
    expect(openThreadId(COORDINATOR_CHAT)).toBe(body.id)
    const pane = document.querySelector("[data-testid=side-thread]")!
    expect(pane.querySelector("[data-testid=side-thread-quote]")!.textContent).toBe("server/sync.ts never backs off")
    expect(pane.textContent).toContain("Why does it spin?")
    expect(document.querySelector("[data-testid=ask-popover]")).toBeNull()
  })

  it("isn't offered where the chat has no side threads", () => {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SelectionToTask, { source: { kind: "orchestrator" }, onPrompt: vi.fn() }, createElement("p", { "data-chat-id": "chat_x00001" }, "Some output text")),
        ),
      ),
    )
    const range = document.createRange()
    range.selectNodeContents(host.querySelector("p")!)
    window.getSelection()!.addRange(range)
    act(() => void document.dispatchEvent(new Event("selectionchange")))
    expect(document.querySelector("button[data-selection-task-action]")).not.toBeNull()
    expect(askButton()).toBeNull()
  })
})

describe("side thread markers", () => {
  it("show under the message, open and close the thread, and the thread closes to its marker", () => {
    render([thread()])
    const marker = host.querySelector("[data-testid=thread-marker]")!
    expect(marker.textContent).toContain("never backs off")
    click(marker)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    expect(document.querySelector("[data-testid=side-thread]")).not.toBeNull()
    click(document.querySelector("[aria-label='Close thread']")!)
    // Closing only hides it; the marker stays.
    expect(host.querySelector("[data-testid=thread-marker]")).not.toBeNull()
  })

  it("go when the thread is deleted, and a deleted open thread closes", () => {
    render([thread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    act(() => void applyThreadEvent(qc, { type: "thread.deleted", threadId: "thr_abc123", projectId: null }))
    expect(host.querySelector("[data-testid=thread-marker]")).toBeNull()
    expect(qc.getQueryData(threadKeys.list(COORDINATOR_CHAT))).toEqual([])
  })

  it("stream replies into the open thread", async () => {
    render([thread({ busy: true })])
    qc.setQueryData<SideThreadMessage[]>(threadKeys.messages("thr_abc123"), [{ id: "thm_q00001", threadId: "thr_abc123", role: "user", content: "Why?", meta: null, createdAt: 3 }])
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    act(() => void applyThreadEvent(qc, { type: "thread.delta", threadId: "thr_abc123", text: "Because it " }))
    act(() => void applyThreadEvent(qc, { type: "thread.delta", threadId: "thr_abc123", text: "retries." }))
    await flush()
    expect(document.querySelector("[data-testid=side-thread]")!.textContent).toContain("Because it retries.")
    act(() => void applyThreadEvent(qc, { type: "thread.message", message: { id: "thm_a00001", threadId: "thr_abc123", role: "assistant", content: "Because it retries forever.", meta: null, createdAt: 4 } }))
    await flush()
    expect(qc.getQueryData(threadKeys.stream("thr_abc123"))).toBe("")
    expect(document.querySelector("[data-testid=side-thread-reply]")!.textContent).toContain("Because it retries forever.")
  })
})

/** Type into a textarea and press Enter, as React sees it. */
function typeAndSend(box: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
}

const replyThread = (over: Partial<SideThread> = {}) => thread({ id: "thr_reply01", kind: "reply", quote: REPLY.content, ...over })
const posts = (path: string) => fetchMock.mock.calls.filter(([u, init]) => u === path && (init as RequestInit | undefined)?.method !== "GET" && (init as RequestInit | undefined)?.body !== undefined)

describe("threaded replies", () => {
  it("Reply opens an empty thread on the message; the first reply starts it, out of the main chat", async () => {
    render()
    const reply = host.querySelector<HTMLButtonElement>("[data-testid=message-reply]")!
    expect(reply).not.toBeNull()
    click(reply)
    const pane = document.querySelector("[data-testid=side-thread]")!
    // The original on top, titled by its first line, and nothing sent yet.
    expect(pane.querySelector("[data-testid=side-thread-title]")!.textContent).toBe("The retry loop in server/sync.ts never backs off,")
    expect(pane.querySelector("[data-testid=side-thread-original]")!.textContent).toContain("so a dead remote spins the CPU.")
    expect(pane.textContent).toContain("No replies yet")
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/threads"))).toEqual([])
    const box = pane.querySelector<HTMLTextAreaElement>("textarea")!
    expect(document.activeElement).toBe(box)

    typeAndSend(box, "Can it back off?")
    await flush()
    const [[, init]] = posts("/api/threads")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({ kind: "reply", anchorId: REPLY.id, question: "Can it back off?", projectId: null })
    expect(body.quote).toBeUndefined()
    expect(openThreadId(COORDINATOR_CHAT)).toBe(body.id)
    // Nothing went to the Coordinator's own chat.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/chat"))).toBe(false)
    // The chat shows the count under the message, not the reply; the panel says Claude is working.
    expect(host.querySelector("[data-testid=thread-replies]")!.textContent).toContain("1 reply")
    expect(host.querySelector("[data-chat-id]")!.textContent).not.toContain("Can it back off?")
    expect(document.querySelector("[data-testid=side-thread-working]")!.textContent).toContain("Claude is working")
  })

  it("Reply on a message that has replies opens its thread; questions on highlights stay chips", () => {
    render([replyThread(), thread()])
    expect(host.querySelectorAll("[data-testid=thread-replies]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-testid=thread-marker]")).toHaveLength(1)
    click(host.querySelector("[data-testid=message-reply]")!)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
  })

  it("↰ N replies counts live, shows answering and unread, and opening marks it read", async () => {
    render([replyThread({ busy: true })])
    const button = () => host.querySelector<HTMLButtonElement>("[data-testid=thread-replies]")!
    expect(button().textContent).toBe("2 replies")
    expect(button().getAttribute("aria-label")).toBe("2 replies, answering")
    act(() => void applyThreadEvent(qc, { type: "thread", thread: replyThread({ busy: false, replies: 3, unread: true }) }))
    await flush()
    expect(button().textContent).toBe("3 replies")
    expect(button().dataset.unread).toBe("true")

    click(button())
    await flush()
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
    expect(posts("/api/threads/thr_reply01/seen")).toHaveLength(1)
    expect(button().dataset.unread).toBeUndefined()
    expect(button().getAttribute("aria-pressed")).toBe("true")
  })

  it("resolve folds the thread away under its message; it reopens from there", async () => {
    render([replyThread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_reply01"))
    click(document.querySelector("[data-testid=side-thread-resolve]")!)
    await flush()
    expect(posts("/api/threads/thr_reply01/resolve")).toHaveLength(1)
    expect(JSON.parse((posts("/api/threads/thr_reply01/resolve")[0]![1] as RequestInit).body as string)).toEqual({ resolved: true })
    // It slides away, and the count says resolved.
    expect(document.querySelector<HTMLElement>("[data-testid=side-thread]")!.dataset.open).toBeUndefined()
    const marker = host.querySelector<HTMLButtonElement>("[data-testid=thread-replies]")!
    expect(marker.dataset.resolved).toBe("true")
    expect(marker.getAttribute("aria-label")).toBe("2 replies, resolved")
    act(() => forgetThread(COORDINATOR_CHAT, "thr_reply01"))
    click(marker)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
    expect(document.querySelector("[data-testid=side-thread-resolve]")!.getAttribute("aria-label")).toBe("Reopen thread")
  })

  it("expands over the chat and back", () => {
    render([replyThread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_reply01"))
    const pane = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")!
    expect(pane().dataset.expanded).toBeUndefined()
    click(document.querySelector("[data-testid=side-thread-expand]")!)
    expect(pane().dataset.expanded).toBe("true")
    click(document.querySelector("[data-testid=side-thread-expand]")!)
    expect(pane().dataset.expanded).toBeUndefined()
  })
})

describe("findQuoteRange", () => {
  it("finds a selection's text across elements and line breaks", () => {
    const el = document.createElement("div")
    el.innerHTML = "<p>The retry loop in <strong>server/sync.ts</strong> never</p>\n<p>backs off.</p><div data-thread-markers>never backs off</div>"
    const range = findQuoteRange(el, "sync.ts never\n\nbacks")!
    expect(range.toString()).toBe("sync.ts never</p>\n<p>backs".replace(/<\/?p>/g, ""))
    expect(findQuoteRange(el, "not there")).toBeNull()
  })
})

describe("threadDockWidth", () => {
  const SIDEBAR = 256
  it("widens the docked Coordinator for the thread, leaving the page MAIN_MIN_THREAD", () => {
    expect(threadDockWidth(1920, SIDEBAR, 416)).toBe(416 + THREAD_ROOM)
    const laptop = threadDockWidth(1440, SIDEBAR, 416)
    expect(1440 - SIDEBAR - laptop).toBeGreaterThanOrEqual(MAIN_MIN_THREAD)
    // 125% zoom: still room for both side by side (35.5rem).
    const zoomed = coordinatorDock(1152, SIDEBAR, 416)
    expect(threadDockWidth(1152, SIDEBAR, zoomed.width) - 1).toBeGreaterThanOrEqual(35.5 * 16)
    // Never narrower than without a thread.
    expect(threadDockWidth(1000, SIDEBAR, 500)).toBe(500)
  })
})
