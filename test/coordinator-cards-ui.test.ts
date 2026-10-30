// @vitest-environment happy-dom
// The Coordinator chat as cards: a card per task (a batch's one card), the Coordinator card with Cody's thread, opening
// a card, "Show in timeline" and back, Cards ⇄ Timeline, "N new" with the ↓ pill, "N done today" and the project bar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatPanel } from "../web/src/components/ChatPanel.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { setCoordinatorView, showInTimeline } from "../web/src/lib/coordinatorView.js"
import { resetCardsSeen } from "../web/src/lib/cardsSeen.js"
import { resetChipState } from "../web/src/lib/chipState.js"
import { keys } from "../web/src/lib/queries.js"
import { COORDINATOR_CHAT, applyThreadEvent, threadKeys } from "../web/src/lib/threads.js"
import type { ChatMessage, Project, SideThread, SideThreadMessage, Task, TaskStatus, UiEvent } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

const project = (id: string, name: string, createdAt: number, extra: Partial<Project> = {}) =>
  ({ id, name, repo: null, description: "", envKeys: [], notes: [], identityId: "default", runner: "box", createdAt, color: null, ...extra }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title, status, prompt: "", previews: [], waitFor: [], createdAt: 1, updatedAt: 1, ...extra }) as unknown as Task

const YARD = project("prj_yard0001", "box-yard", 1)
const MAP = project("prj_map00001", "Map 3", 2, { color: "orange" })
const LOGIN = task("task_login001", YARD.id, "Fix login", "needs_input")
const CARDS = task("task_cards001", YARD.id, "Coordinator cards", "pr_ready", { icon: "layers", prUrl: "https://github.com/o/r/pull/9", prState: "open" })
const DOCS = task("task_docs0001", YARD.id, "Write the docs", "done")
const B = "batch_aaaabbbbcccc"
const HOLLOW = task("task_hollow01", MAP.id, "Map 3 PR #406: The Hollow cave", "working", { batchId: B, createdAt: 5, turnStartedAt: Date.now() - 12 * 60_000 })
const DAM = task("task_dam00001", MAP.id, "Map 3 PR #409: Dam powerhouse", "queued", { batchId: B, createdAt: 5, updatedAt: Date.now() - 3 * 60_000 })
const CAMP = task("task_camp0001", MAP.id, "Map 3 PR #399: Dam Hamlet camp", "done", { batchId: B, createdAt: 5, prUrl: "https://github.com/o/r/pull/399", prState: "merged" })
const TASKS = [LOGIN, CARDS, DOCS, HOLLOW, DAM, CAMP]

let seq = 0
const msg = (role: ChatMessage["role"], content: string, meta?: Record<string, unknown>): ChatMessage => ({
  id: `chat_${String(++seq).padStart(4, "0")}`,
  role,
  content,
  meta: meta ?? null,
  createdAt: Date.now() - 600_000 + seq * 1000,
})
const notice = (t: Task, text: string) => msg("notice", text, { taskId: t.id, projectId: t.projectId })

const CHAT = [
  msg("user", "Fix login and build the cards"),
  msg("tool", "create_task", { input: { project: "box-yard", title: "Fix login" }, resultId: LOGIN.id }),
  msg("tool", "create_task", { input: { project: "box-yard", title: "Coordinator cards" }, resultId: CARDS.id }),
  msg("assistant", `Started [Fix login](/tasks/${LOGIN.id}) and [Coordinator cards](/tasks/${CARDS.id}).`),
  notice(LOGIN, "🙋 **Fix login** needs input: Which page, the old one or the new one?"),
  notice(CARDS, "🔀 **Coordinator cards** opened a pull request: https://github.com/o/r/pull/9"),
  notice(DOCS, "✅ **Write the docs** is done"),
  msg("user", "Shoot every Map 3 area"),
  msg("tool", "create_tasks", { input: { project: "Map 3", tasks: [HOLLOW, DAM, CAMP].map((t) => ({ title: t.title, prompt: "x" })) } }),
  msg("assistant", "3 tasks started.", { nextSteps: ["Show me the Map 3 batch"] }),
  notice(HOLLOW, "💬 **Map 3 PR #406: The Hollow cave** says: the entrance is lit"),
]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetCardsSeen()
  resetChipState()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [YARD, MAP])
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => setChatProjectFilter(null))
  act(() => setCoordinatorView("cards"))
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ChatPanel))))
/** The query cache tells its observers on a timer. */
const setChat = (messages: ChatMessage[]) =>
  act(async () => {
    qc.setQueryData(keys.chat, messages)
    await new Promise((r) => setTimeout(r, 0))
  })
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const cards = () => [...host.querySelectorAll('[data-testid="chat-card"]')] as HTMLElement[]
const card = (key: string) => host.querySelector(`[data-testid="chat-card"][data-card="${key}"]`) as HTMLElement
const head = (key: string) => card(key).querySelector('[role="button"]') as HTMLElement
const coordinator = () => host.querySelector('[data-testid="coordinator-card"]') as HTMLElement
const viewButton = (label: string) => host.querySelector(`[data-testid="view-toggle"] button[aria-label="${label}"]`) as HTMLElement
const button = (scope: Element, text: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLElement

describe("Coordinator cards", () => {
  it("shows a card per task, a batch as one card, finished ones folded, and Cody's thread in the Coordinator card", () => {
    render()
    expect(viewButton("Cards").getAttribute("aria-pressed")).toBe("true")
    // In the order the chat first named them; a status change or new update never moves one.
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, `batch:${B}`])
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("1 done today")

    const login = card(LOGIN.id)
    expect(login.querySelector('[data-testid="chat-card-title"]')!.textContent).toBe("Fix login")
    expect(login.textContent).toContain("box-yard")
    expect(login.textContent).toContain("Needs you")
    expect(login.querySelector('[data-testid="chat-card-latest"]')!.textContent).toContain("Which page, the old one or the new one?")
    expect(card(CARDS.id).querySelector('a[href="https://github.com/o/r/pull/9"]')).not.toBeNull()

    const batch = card(`batch:${B}`)
    expect(batch.querySelector('[data-testid="chat-card-title"]')!.textContent).toBe("Map 3 PR · 3 tasks")
    expect(batch.textContent).toContain("1 working")
    expect(batch.querySelector('[data-testid="chat-card-latest"]')!.textContent).toContain("#406: The Hollow cave")

    // Cody's messages and the replies to them, newest three; tool calls are the Timeline's.
    const thread = coordinator().textContent ?? ""
    expect(thread).toContain("Shoot every Map 3 area")
    expect(thread).toContain("3 tasks started.")
    expect(thread).toContain("1 earlier")
    expect(thread).not.toContain("create_task")
    // Only the newest reply offers its next steps.
    expect(thread).toContain("Show me the Map 3 batch")
    expect(host.querySelector('[data-testid="new-cards-pill"]')).toBeNull()
  })

  it("opens a card to where it came from, its updates, and its timeline; and back to the card from there", () => {
    render()
    click(head(LOGIN.id))
    const body = card(LOGIN.id).querySelector('[data-testid="chat-card-body"]')!
    expect(body.querySelector('[data-testid="chat-card-origin"]')!.textContent).toContain("Fix login and build the cards")
    // Its question, as the timeline shows it.
    expect(body.textContent).toContain("Which page, the old one or the new one?")
    expect([...body.querySelectorAll(`a[href="/tasks/${LOGIN.id}"]`)].some((a) => a.textContent === "Task page")).toBe(true)
    // In its own card a task's update leads with what happened, not the task's name.
    click(head(CARDS.id))
    const chip = card(CARDS.id).querySelector('[data-testid="update-chip"]')!
    expect(chip.querySelector('[data-testid="task-tile"]')).toBeNull()
    expect(chip.textContent).toContain("opened PR #9")
    expect(chip.textContent).not.toContain("Coordinator cards")

    click(body.querySelector('[data-testid="chat-card-timeline"]')!)
    expect(viewButton("Timeline").getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector('[data-testid="chat-cards"]')).toBeNull()
    const banner = host.querySelector('[data-testid="timeline-card-banner"]')!
    expect(banner.textContent).toContain("Only Fix login in the timeline")
    const text = host.querySelector('[data-testid="chat-panel"]')!.textContent!
    expect(text).toContain("Fix login and build the cards")
    expect(text).not.toContain("Shoot every Map 3 area")

    click(button(banner, "Full timeline"))
    expect(host.querySelector('[data-testid="timeline-card-banner"]')).toBeNull()
    expect(host.querySelector('[data-testid="chat-panel"]')!.textContent).toContain("Shoot every Map 3 area")

    act(() => showInTimeline({ key: LOGIN.id, taskIds: [LOGIN.id] }))
    click(button(host.querySelector('[data-testid="timeline-card-banner"]')!, "Back to its card"))
    expect(viewButton("Cards").getAttribute("aria-pressed")).toBe("true")
    expect(card(LOGIN.id).dataset.open).toBe("true")
  })

  it("opens a batch into its tasks, each with its own updates, and where and how long the running ones have run", () => {
    render()
    click(head(`batch:${B}`))
    const rows = [...card(`batch:${B}`).querySelectorAll('[data-testid="batch-task"]')] as HTMLElement[]
    expect(rows.map((r) => r.dataset.task)).toEqual([CAMP.id, HOLLOW.id, DAM.id])
    expect(rows.map((r) => r.querySelector("button")!.textContent)).toEqual(["#399: Dam Hamlet campMerged", "#406: The Hollow cave12mWorking", "#409: Dam powerhouse3mQueued"])
    expect(rows.map((r) => r.querySelector('[data-testid="card-placement"]')?.getAttribute("aria-label") ?? null)).toEqual([null, expect.stringMatching(/^Runs on: /), expect.stringMatching(/^Runs on: /)])
    click(rows[1]!.querySelector("button")!)
    expect(rows[1]!.textContent).toContain("the entrance is lit")
    expect(rows[1]!.querySelector(`a[href="/tasks/${HOLLOW.id}"]`)).not.toBeNull()
  })

  it("says what's new on a card until it's opened, and the ↓ pill goes to it", async () => {
    render()
    await setChat([...CHAT, notice(CARDS, "💬 **Coordinator cards** says: screenshots are up")])
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')!.textContent).toBe("1 new")
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    const pill = host.querySelector('[data-testid="new-cards-pill"]')!
    expect(pill.textContent).toContain("1 new in")
    // The card got news without moving.
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, `batch:${B}`])

    click(head(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    expect(host.querySelector('[data-testid="new-cards-pill"]')).toBeNull()
    // Seen stays seen.
    act(() => root.unmount())
    root = createRoot(host)
    render()
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
  })

  it("switches to the Timeline and back, and remembers it", () => {
    render()
    click(viewButton("Timeline"))
    expect(host.querySelector('[data-testid="chat-cards"]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="update-chip"], [data-testid="update-group"]').length).toBeGreaterThan(0)
    expect(localStorage.getItem("boxyard:coordinator-timeline")).toBe("1")
    act(() => root.unmount())
    root = createRoot(host)
    render()
    expect(viewButton("Timeline").getAttribute("aria-pressed")).toBe("true")
    click(viewButton("Cards"))
    expect(host.querySelector('[data-testid="chat-cards"]')).not.toBeNull()
  })

  it("keeps one project's cards and Coordinator thread when the bar filters", () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    expect(cards().map((c) => c.dataset.card)).toEqual([`batch:${B}`])
    expect(host.querySelector('[data-testid="cards-done"]')).toBeNull()
    const thread = coordinator().textContent ?? ""
    expect(thread).toContain("Shoot every Map 3 area")
    expect(thread).not.toContain("Fix login and build the cards")
  })

  it("unfolds what's done", () => {
    render()
    expect(card(DOCS.id)).toBeNull()
    click(host.querySelector('[data-testid="cards-done"]')!)
    expect(card(DOCS.id).textContent).toContain("Done")
  })
})

describe("Reply in a card", () => {
  let posts: { url: string; body: Record<string, unknown> }[]
  beforeEach(() => {
    posts = []
    // Sends stay in flight: what was sent, and what shows meanwhile, is the test.
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Promise(() => {})
    })
  })

  const composer = (scope: Element) => scope.querySelector('[data-testid="card-composer"]') as HTMLElement
  /** Types in the box and sends; the mutation reaches fetch after its onMutate. */
  const send = async (scope: Element, text: string) => {
    const box = scope.matches('[data-testid="card-composer"]') ? scope : composer(scope)
    const textarea = box.querySelector("textarea")!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea, text)
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    // Its onMutate, then the query cache telling the chat.
    for (let i = 0; i < 2; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
  }
  const sent = (t: Task, text: string) => msg("notice", `✉️ **${t.title}** got a message from Cody: ${text}`, { taskId: t.id, projectId: t.projectId, sent: true })
  const threadEvent = (ev: UiEvent) =>
    act(async () => {
      applyThreadEvent(qc, ev)
      await new Promise((r) => setTimeout(r, 0))
    })

  it("sends to the task by default, and shows the message and the agent's answer in the card and the timeline", async () => {
    render()
    click(head(LOGIN.id))
    const box = composer(card(LOGIN.id))
    expect(box.dataset.to).toBe("task")
    expect(box.querySelector("textarea")!.placeholder).toBe("Answer the agent…")
    expect(button(box, "This task").getAttribute("aria-pressed")).toBe("true")
    await send(card(LOGIN.id), "The new one")
    expect(posts).toEqual([{ url: `/api/tasks/${LOGIN.id}/messages`, body: { content: "The new one", attachments: [], inChat: true } }])

    // The server's line about it, then the turn it started.
    const message = sent(LOGIN, "The new one")
    const answer = notice(LOGIN, "💬 **Fix login** finished its turn: Switched to **the new page**.")
    await setChat([...CHAT, message, answer])
    const body = card(LOGIN.id).querySelector('[data-testid="chat-card-body"]')!
    const bubble = body.querySelector('[data-testid="sent-message"]')!
    expect(bubble.textContent).toContain("to this task")
    expect(bubble.textContent).toContain("The new one")
    expect(bubble.textContent).not.toContain("got a message")
    // It answers Cody, so it reads as the agent's reply, not a chip.
    const reply = body.querySelector('[data-testid="agent-reply"]')!
    expect(reply.textContent).toContain("Fix login")
    expect(reply.textContent).toContain("Switched to the new page.")
    expect(reply.querySelector("strong")?.textContent).toBe("the new page")
    expect([...body.querySelectorAll('[data-testid="update-chip"]')].some((c) => c.textContent?.includes("Switched"))).toBe(false)
    // Closed, the card's latest line is the answer.
    click(head(LOGIN.id))
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-latest"]')!.textContent).toContain("Switched to the new page.")

    // The Timeline says which task it went to, and goes back to its card.
    click(viewButton("Timeline"))
    const line = host.querySelector('[data-testid="sent-message"]')!
    expect(line.querySelector('[data-testid="sent-from"]')!.textContent).toBe("toFix login·Open card ›")
    click(button(line, "Open card"))
    expect(viewButton("Cards").getAttribute("aria-pressed")).toBe("true")
    await act(async () => await new Promise((r) => requestAnimationFrame(r)))
    expect(card(LOGIN.id).dataset.open).toBe("true")
  })

  it("asks the Coordinator in the card's own side thread, which the main chat never sees, and shows the answer there", async () => {
    qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), [])
    render()
    click(head(CARDS.id))
    expect(composer(card(CARDS.id)).querySelector("textarea")!.placeholder).toBe("Reply to this task…")
    click(button(composer(card(CARDS.id)), "Coordinator"))
    const box = composer(card(CARDS.id))
    expect(box.dataset.to).toBe("coordinator")
    expect(box.querySelector("textarea")!.placeholder).toBe("Ask the Coordinator about this…")
    expect(box.querySelector('[data-testid="card-composer-hint"]')!.textContent).toBe("A side thread with the Coordinator about this task: it answers, it doesn't act")
    await send(card(CARDS.id), "Is it blocking anything?")
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe("/api/threads")
    expect(posts[0]!.body).toMatchObject({ kind: "task", anchorId: CARDS.id, question: "Is it blocking anything?", projectId: null })

    // It shows in the card at once; the main chat doesn't get it.
    const body = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    expect(body.querySelector('[data-testid="card-thread-question"]')!.textContent).toBe("to the CoordinatorIs it blocking anything?")
    expect(coordinator().textContent).not.toContain("Is it blocking anything?")
    expect(qc.getQueryData(keys.chat)).toEqual(CHAT)
    expect(body.querySelector('[data-testid="card-working"]')!.textContent).toBe("The Coordinator is working")

    // Its answer streams in, then lands as the thread's message.
    const id = String(posts[0]!.body.id)
    const thread = qc.getQueryData<SideThread[]>(threadKeys.list(COORDINATOR_CHAT))!.find((t) => t.id === id)!
    await threadEvent({ type: "thread.delta", threadId: id, text: "Not yet" })
    expect(body.querySelector('[data-testid="card-thread-streaming"]')!.textContent).toContain("Not yet")
    await threadEvent({ type: "thread.message", message: { id: "thm_answer", threadId: id, role: "assistant", content: "No: **nothing** waits on it.", meta: null, createdAt: Date.now() } })
    await threadEvent({ type: "thread", thread: { ...thread, busy: false, context: "fork", replies: 2, updatedAt: Date.now() } })
    const answer = body.querySelector('[data-testid="card-thread-answer"]')!
    expect(answer.textContent).toContain("Coordinator· side thread")
    expect(answer.textContent).toContain("No: nothing waits on it.")
    expect(body.querySelector('[data-testid="card-working"]')).toBeNull()
    expect(body.querySelector('[data-testid="card-thread-streaming"]')).toBeNull()
    expect(coordinator().textContent).not.toContain("waits on it")

    // The choice holds when the card closes and opens again; closed, its latest line is the answer.
    click(head(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-latest"]')!.textContent).toBe("Coordinator: No: nothing waits on it.")
    click(head(CARDS.id))
    expect(composer(card(CARDS.id)).dataset.to).toBe("coordinator")
    // A second question goes to the same thread.
    await send(card(CARDS.id), "And the docs?")
    expect(posts[1]!.body).toMatchObject({ kind: "task", anchorId: CARDS.id, question: "And the docs?" })
    const again = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    expect([...again.querySelectorAll('[data-testid="card-thread-question"]')].map((q) => q.textContent)).toEqual([
      "to the CoordinatorIs it blocking anything?",
      "to the CoordinatorAnd the docs?",
    ])
  })

  it("says a closed card has an answer from the Coordinator, and opening it reads it; the Timeline doesn't show it", async () => {
    const at = Date.now()
    const thread: SideThread = { id: "thr_cards0001", projectId: null, anchorId: CARDS.id, kind: "task", quote: CARDS.title, context: "fork", busy: false, replies: 2, unread: true, resolvedAt: null, createdAt: at - 2000, updatedAt: at }
    qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), [thread])
    qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(thread.id), [
      { id: "thm_q", threadId: thread.id, role: "user", content: "Can it wait?", meta: null, createdAt: at - 2000 },
      { id: "thm_a", threadId: thread.id, role: "assistant", content: "Yes, till Monday.", meta: null, createdAt: at },
    ])
    render()
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')!.textContent).toBe("1 new")
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-latest"]')!.textContent).toBe("Coordinator: Yes, till Monday.")
    click(head(CARDS.id))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts).toEqual([{ url: `/api/threads/${thread.id}/seen`, body: {} }])
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    const body = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    // In time order among the card's updates: after the pull request.
    const order = [...body.querySelectorAll('[data-testid="update-chip"], [data-testid="card-thread-question"], [data-testid="card-thread-answer"]')]
    expect(order.map((e) => (e as HTMLElement).dataset.testid)).toEqual(["update-chip", "card-thread-question", "card-thread-answer"])
    click(viewButton("Timeline"))
    expect(host.textContent).not.toContain("Can it wait?")
    expect(host.textContent).not.toContain("till Monday")
  })

  it("keeps a card that's open where it is when its task finishes; closed, it folds at the next update", async () => {
    const setTasks = (tasks: Task[]) =>
      act(async () => {
        qc.setQueryData(keys.tasks, tasks)
        await new Promise((r) => setTimeout(r, 0))
      })
    render()
    click(head(LOGIN.id))
    await setTasks(TASKS.map((t) => (t.id === LOGIN.id || t.id === CARDS.id ? { ...t, status: "done" as const } : t)))
    // The open one is still in the list, open; the closed one folded straight away.
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, `batch:${B}`])
    expect(card(LOGIN.id).querySelector('[data-testid="card-composer"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("2 done today")

    click(head(LOGIN.id))
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, `batch:${B}`])
    await setChat([...CHAT, notice(HOLLOW, "💬 **Map 3 PR #406: The Hollow cave** says: halfway")])
    expect(cards().map((c) => c.dataset.card)).toEqual([`batch:${B}`])
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("3 done today")
  })

  it("goes with an open card that leaves \"done today\" because its task is back at work", async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id.startsWith("card-")) scrolled.push(this.id)
    })
    render()
    click(host.querySelector('[data-testid="cards-done"]')!)
    click(head(DOCS.id))
    await send(card(DOCS.id), "Add a FAQ")
    await act(async () => {
      qc.setQueryData(keys.tasks, TASKS.map((t) => (t.id === DOCS.id ? { ...t, status: "queued" as const } : t)))
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, DOCS.id, `batch:${B}`])
    expect(card(DOCS.id).querySelector('[data-testid="card-composer"]')).not.toBeNull()
    expect(scrolled).toEqual([`card-${DOCS.id}`])
    vi.restoreAllMocks()
  })

  it("gives each of a batch's tasks its own box, and the batch one for the Coordinator about all of them", async () => {
    render()
    click(head(`batch:${B}`))
    const batch = card(`batch:${B}`)
    const rows = [...batch.querySelectorAll('[data-testid="batch-task"]')] as HTMLElement[]
    click(rows[1]!.querySelector("button")!)
    click(rows[2]!.querySelector("button")!)
    expect(rows[1]!.querySelector('[data-testid="card-working"]')!.textContent).toBe("#406: The Hollow cave is working")
    expect(composer(rows[1]!).querySelector("textarea")!.placeholder).toBe("Queue another message…")
    expect(rows[2]!.querySelector('[data-testid="card-working"]')).toBeNull()
    await send(rows[2]!, "Shoot it at dusk")
    expect(posts).toEqual([{ url: `/api/tasks/${DAM.id}/messages`, body: { content: "Shoot it at dusk", attachments: [], inChat: true } }])

    const own = [...batch.querySelectorAll('[data-testid="card-composer"]')].at(-1) as HTMLElement
    expect(own.closest('[data-testid="batch-task"]')).toBeNull()
    expect(own.dataset.to).toBe("coordinator")
    await send(own, "How far along is the batch?")
    expect(posts[1]).toMatchObject({ url: "/api/threads", body: { kind: "task", anchorId: `batch:${B}`, question: "How far along is the batch?" } })
    expect(own.querySelector('[data-testid="card-composer-hint"]')!.textContent).toBe("A side thread with the Coordinator: it answers, it doesn't act")
    // The batch's question shows under its tasks; the tasks' own threads are theirs.
    const question = batch.querySelector('[data-testid="card-thread-question"]')!
    expect(question.textContent).toContain("How far along is the batch?")
    expect(question.closest('[data-testid="batch-task"]')).toBeNull()
  })
})
