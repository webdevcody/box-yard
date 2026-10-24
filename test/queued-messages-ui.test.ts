// @vitest-environment happy-dom
// A message sent while the Coordinator (or a Captain) is mid-turn: it shows at once under the streaming reply,
// labelled queued, and survives the stream ending, its delivery and a refetch, in the right place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { keys } from "../web/src/lib/queries.js"
import { placeMessage, settleOptimistic, splitQueued } from "../web/src/lib/queued.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, UiEvent } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const msg = (id: string, role: ChatMessage["role"], content: string, createdAt: number, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt })

let es: FakeEventSource | null = null
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: unknown = null
  onopen: unknown = null
  constructor() {
    es = this
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

/** What the server holds: GET /api/chat answers with it. */
let server: ChatMessage[] = []
/** The POST /api/chat answer. */
let posted: ChatMessage | null = null

let root: Root
let host: HTMLElement
let qc: QueryClient

const flush = () => act(() => new Promise((r) => setTimeout(r, 40)))
const emit = async (...events: UiEvent[]) => {
  act(() => {
    for (const ev of events) es!.onmessage!({ data: JSON.stringify(ev) })
  })
  await flush()
}

/** The chat panel's rows top to bottom, as text: user bubbles, replies and the streaming reply (not the typing dots). */
const rows = () => {
  const list = document.querySelector("[data-testid=chat-panel] .space-y-3")!
  return [...list.children].map((el) => el.textContent!.trim()).filter(Boolean)
}
const queuedLabels = () => document.querySelectorAll("[data-testid=chat-panel] [data-testid=queued-label]").length

function renderApp() {
  history.replaceState(null, "", "/zen")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: true, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: true, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, server)
  qc.setQueryData(keys.chatBusy, true)
  qc.setQueryData(keys.chatStream, "Here is a long reply that is still")
  for (const k of [keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

function type(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>("[data-testid=chat-panel] textarea")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
}

beforeEach(() => {
  localStorage.clear()
  es = null
  server = [msg("chat_ask000001", "user", "Build the thing", now - 3000), msg("chat_tool00001", "tool", "list_tasks", now - 2000, { input: {} })]
  posted = null
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (path: string, init?: { method?: string; body?: string }) => {
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }))
    if (path === "/api/chat" && init?.method === "POST") {
      const body = JSON.parse(init.body!) as { id: string; content: string }
      posted = msg(body.id, "user", body.content, now - 1500 + server.filter((m) => m.meta?.queued).length, { queued: true })
      server = [...server, posted]
      return json(posted, 201)
    }
    if (path === "/api/chat") return json(server)
    return new Promise(() => {})
  })
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

describe("Coordinator chat: a message sent mid-stream", () => {
  it("shows at once under the streaming reply, labelled queued, and stays put through the stream end, delivery and a refetch", async () => {
    renderApp()
    expect(es).not.toBeNull()
    // The POST stays open for now: this is the optimistic bubble.
    let respond!: () => void
    const realFetch = globalThis.fetch
    vi.stubGlobal("fetch", (path: string, init?: { method?: string }) =>
      init?.method === "POST" ? new Promise<Response>((r) => (respond = () => void realFetch(path, init).then(r))) : realFetch(path, init),
    )
    type("k it works perfect")
    await flush()
    // Right away, below the streaming text, queued.
    expect(rows().slice(-2)).toEqual(["Here is a long reply that is still", expect.stringContaining("k it works perfect")])
    expect(queuedLabels()).toBe(1)
    respond()
    await flush()
    const id = posted!.id
    expect(rows().at(-1)).toContain("k it works perfect")
    expect(queuedLabels()).toBe(1)

    // The SSE echo of our own message, and a refetch mid-stream (refocus), keep it under the stream.
    await emit({ type: "chat.message", message: posted! })
    await act(() => qc.refetchQueries({ queryKey: keys.chat }))
    expect(rows().slice(-2)).toEqual(["Here is a long reply that is still", expect.stringContaining("k it works perfect")])

    // The streamed reply lands (its row is newer than ours), and the turn ends: ours stays below it, still queued.
    const reply = msg("chat_reply0001", "assistant", "Here is a long reply that is still going. Done.", now - 1000)
    server = [...server.filter((m) => m.id !== id), reply, ...server.filter((m) => m.id === id)]
    await emit({ type: "chat.message", message: reply }, { type: "chat.turn", startedAt: now - 2500, replyId: reply.id })
    expect(rows().slice(-2)).toEqual([expect.stringContaining("Done."), expect.stringContaining("k it works perfect")])
    expect(queuedLabels()).toBe(1)

    // The next turn reads it: the server moves it to that turn's start, and it answers.
    const delivered = { ...posted!, createdAt: now - 500, meta: { queuedAt: posted!.createdAt } }
    const answer = msg("chat_reply0002", "assistant", "Great, glad it works.", now - 100)
    server = [...server.filter((m) => m.id !== id), delivered, answer]
    await emit({ type: "chat.message", message: delivered }, { type: "chat.message", message: answer }, { type: "chat.busy", busy: false })
    const expected = ["Build the thing", "list_tasks", expect.stringContaining("Done."), "k it works perfect", "Great, glad it works."]
    expect(rows()).toEqual(expected)
    expect(queuedLabels()).toBe(0)

    // A refetch (reconnect, reload) gives the same thread.
    await act(() => qc.refetchQueries({ queryKey: keys.chat }))
    expect(rows()).toEqual(expected)
  })
})

describe("Coordinator chat: several messages sent mid-stream", () => {
  it("stack under the streaming reply in send order, and keep it through delivery and a refetch", async () => {
    renderApp()
    type("first thought")
    await flush()
    type("second thought")
    await flush()
    const stream = "Here is a long reply that is still"
    expect(rows().slice(-3)).toEqual([stream, expect.stringContaining("first thought"), expect.stringContaining("second thought")])
    expect(queuedLabels()).toBe(2)
    await act(() => qc.refetchQueries({ queryKey: keys.chat }))
    expect(rows().slice(-3)).toEqual([stream, expect.stringContaining("first thought"), expect.stringContaining("second thought")])

    // The reply lands; the next turn reads both at once, so they share its start time.
    const reply = msg("chat_reply0001", "assistant", "Here is a long reply that is still going. Done.", now - 1000)
    const [q1, q2] = server.filter((m) => m.meta?.queued)
    const at = now - 500
    const d1 = { ...q1!, createdAt: at, meta: { queuedAt: q1!.createdAt } }
    const d2 = { ...q2!, createdAt: at, meta: { queuedAt: q2!.createdAt } }
    const answer = msg("chat_reply0002", "assistant", "Noted both.", now - 100)
    server = [...server.filter((m) => !m.meta?.queued), reply, d1, d2, answer]
    await emit({ type: "chat.message", message: reply }, { type: "chat.turn", startedAt: now - 2500, replyId: reply.id })
    expect(rows().slice(-3)).toEqual([expect.stringContaining("Done."), expect.stringContaining("first thought"), expect.stringContaining("second thought")])
    await emit({ type: "chat.message", message: d1 }, { type: "chat.message", message: d2 }, { type: "chat.message", message: answer }, { type: "chat.busy", busy: false })
    const expected = ["Build the thing", "list_tasks", expect.stringContaining("Done."), "first thought", "second thought", "Noted both."]
    expect(rows()).toEqual(expected)
    expect(queuedLabels()).toBe(0)
    await act(() => qc.refetchQueries({ queryKey: keys.chat }))
    expect(rows()).toEqual(expected)
  })
})

describe("Captain tab: a message sent mid-turn", () => {
  const project = { id: "prj_demo01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
  const cap = (id: string, role: CaptainMessage["role"], content: string, createdAt: number, meta: Record<string, unknown> | null = null): CaptainMessage => ({ id, projectId: project.id, role, content, meta, createdAt })
  const state = (busy: boolean): CaptainState => ({ projectId: project.id, busy, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })

  it("waits under 'Captain is working…', labelled queued, then sits after the reply it was typed over", async () => {
    qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
    qc.setQueryData(keys.projects, [project])
    qc.setQueryData(keys.captainCompactions(project.id), [])
    qc.setQueryData(keys.captain(project.id), state(true))
    const queued = cap("cap_queued0001", "user", "also check the docs", now - 1500, { source: "cody", queued: true })
    qc.setQueryData(keys.captainMessages(project.id), [cap("cap_first00001", "user", "status?", now - 3000, { source: "cody" }), queued])
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CaptainTab, { project }))))

    const inbound = () => [...host.querySelectorAll<HTMLElement>('[data-testid="captain-inbound"]')]
    const list = host.querySelector("[data-testid=captain-chat] .space-y-3")!
    const texts = () => [...list.children].map((el) => el.textContent!)
    expect(texts().at(-2)).toContain("Captain is working…")
    expect(texts().at(-1)).toContain("also check the docs")
    expect(inbound().at(-1)!.querySelector("[data-testid=queued-label]")).not.toBeNull()

    // The turn's reply lands, then the next turn delivers ours (the live stream's placeMessage).
    const apply = (m: CaptainMessage) => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), (l) => placeMessage(l!, m))
    act(() => apply(cap("cap_reply00001", "assistant", "All green.", now - 1000)))
    await flush()
    expect(texts().at(-1)).toContain("also check the docs")
    act(() => apply({ ...queued, createdAt: now - 500, meta: { source: "cody", queuedAt: queued.createdAt } }))
    act(() => apply(cap("cap_reply00002", "assistant", "Docs look fine.", now - 100)))
    act(() => qc.setQueryData(keys.captain(project.id), state(false)))
    await flush()
    expect(texts().map((t) => t.replace(/\s+/g, " "))).toEqual([
      expect.stringContaining("status?"),
      expect.stringContaining("All green."),
      expect.stringContaining("also check the docs"),
      expect.stringContaining("Docs look fine."),
    ])
    expect(host.querySelector("[data-testid=queued-label]")).toBeNull()
  })
})

describe("queued helpers", () => {
  const a = msg("chat_a0000001", "user", "a", 1)
  const b = msg("chat_b0000001", "assistant", "b", 2)
  const q = msg("chat_q0000001", "user", "q", 1.5, { queued: true })

  it("splitQueued keeps the very list when nothing is queued, so memos hold", () => {
    const list = [a, b]
    expect(splitQueued(list).settled).toBe(list)
    expect(splitQueued([a, q, b])).toEqual({ settled: [a, b], queued: [q] })
  })

  it("placeMessage updates in place, appends new ones, and moves one whose time changed", () => {
    const list = [a, q, b]
    expect(placeMessage(list, { ...q, content: "q2" }).map((m) => m.content)).toEqual(["a", "q2", "b"])
    expect(placeMessage(list, msg("chat_c0000001", "tool", "c", 0)).map((m) => m.content)).toEqual(["a", "q", "b", "c"])
    expect(placeMessage(list, { ...q, createdAt: 3, meta: { queuedAt: 1.5 } }).map((m) => m.content)).toEqual(["a", "b", "q"])
  })

  it("settleOptimistic replaces only our optimistic copy, never a newer one from the live stream", () => {
    const optimistic = { ...q, meta: { pending: true, queued: true } }
    expect(settleOptimistic([a, optimistic], q)).toEqual([a, q])
    const delivered = { ...q, createdAt: 3, meta: { queuedAt: 1.5 } }
    const list = [a, delivered]
    expect(settleOptimistic(list, q)).toBe(list)
  })
})
