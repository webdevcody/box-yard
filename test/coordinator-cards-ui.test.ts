// @vitest-environment happy-dom
// The Coordinator chat as cards: a card per task (a create_tasks call's side by side), the Coordinator card with Cody's thread, opening
// a card, its ✓, links to a message going to its card, "N new" with the ↓ pill, "N done today" and the project bar.
// A card's box replies to its task (the Coordinator only when the task refuses it); with a project picked, the panel
// talks to its Captain, whose card takes the Coordinator card's place; either card folds to its header.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatPanel } from "../web/src/components/ChatPanel.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { resetCardsSeen } from "../web/src/lib/cardsSeen.js"
import { resetChipState } from "../web/src/lib/chipState.js"
import { keys } from "../web/src/lib/queries.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { resetClosedTasks } from "../web/src/lib/closedTasks.js"
import { undoClose } from "../web/src/lib/inbox.js"
import { stopSelecting } from "../web/src/lib/cardSelection.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { COORDINATOR_CHAT, closeThread, forgetThread, openThread, openThreadId } from "../web/src/lib/threads.js"
import { contextLabel } from "../web/src/components/ContextMeter.js"
import { revealChatMessage } from "../web/src/lib/reveal.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, SettingsInfo, Task, TaskStatus } from "../shared/types.js"

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
  // The side panel's store outlives a test: empty it.
  const open = openThreadId(COORDINATOR_CHAT)
  if (open)
    act(() => {
      closeThread(COORDINATOR_CHAT)
      forgetThread(COORDINATOR_CHAT, open)
    })
  act(() => setChatProjectFilter(null))
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
/** Wait for the frames a link to a message takes to page back and scroll. */
const frames = () => act(async () => await new Promise((r) => setTimeout(r, 50)))
const button = (scope: Element, text: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLElement

describe("Coordinator cards", () => {
  it("shows a card per task, a create_tasks call's next to each other, finished ones folded, and Cody's thread in the Coordinator card", () => {
    render()
    // Cards are the only view: no Cards ⇄ Timeline toggle.
    expect(host.querySelector('button[aria-label="Timeline"], button[aria-label="Cards"]')).toBeNull()
    // In the order the chat first named them; a status change or new update never moves one.
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
    // CAMP, done, folds on its own.
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("2 done today")

    const login = card(LOGIN.id)
    expect(login.querySelector('[data-testid="chat-card-title"]')!.textContent).toBe("Fix login")
    expect(login.textContent).toContain("box-yard")
    expect(login.textContent).toContain("Needs you")
    expect(login.querySelector('[data-testid="chat-card-latest"]')!.textContent).toContain("Which page, the old one or the new one?")
    expect(card(CARDS.id).querySelector('a[href="https://github.com/o/r/pull/9"]')).not.toBeNull()

    // No batch cards: each of the call's tasks has a card of its own.
    const hollow = card(HOLLOW.id)
    expect(hollow.querySelector('[data-testid="chat-card-title"]')!.textContent).toBe(HOLLOW.title)
    expect(hollow.textContent).toContain("Working")
    expect(hollow.querySelector('[data-testid="chat-card-latest"]')!.textContent).toBe("Says: the entrance is lit")
    expect(card(DAM.id).textContent).toContain("Queued")
    expect(card(DAM.id).querySelector('[data-testid="chat-card-latest"]')!.textContent).toBe("Just started")
    expect(host.querySelector('[data-testid="batch-tasks"], [data-testid="batch-task"]')).toBeNull()

    // Cody's messages and the replies to them, newest three; tool calls aren't shown.
    const thread = coordinator().textContent ?? ""
    expect(thread).toContain("Shoot every Map 3 area")
    expect(thread).toContain("3 tasks started.")
    expect(thread).toContain("1 earlier")
    expect(thread).not.toContain("create_task")
    // Only the newest reply offers its next steps.
    expect(thread).toContain("Show me the Map 3 batch")
    expect(host.querySelector('[data-testid="new-cards-pill"]')).toBeNull()
  })

  it("opens a card to where it came from and its updates; where it came from goes to that message in the Coordinator card", async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset.chatId ?? this.id)
    })
    render()
    click(head(LOGIN.id))
    const body = card(LOGIN.id).querySelector('[data-testid="chat-card-body"]')!
    const origin = body.querySelector('[data-testid="chat-card-origin"]')!
    expect(origin.textContent).toContain("Fix login and build the cards")
    // Its question.
    expect(body.textContent).toContain("Which page, the old one or the new one?")
    // Its page is a button in its header, not a footer link.
    expect(card(LOGIN.id).querySelector(`[data-testid="chat-card-meta"] a[href="/tasks/${LOGIN.id}"]`)!.textContent).toBe("Task page")
    expect(body.textContent).not.toContain("Task page")
    expect(body.textContent).not.toContain("Open in panel")
    // In its own card a task's update leads with what happened, not the task's name.
    click(head(CARDS.id))
    const chip = card(CARDS.id).querySelector('[data-testid="update-chip"]')!
    expect(chip.querySelector('[data-testid="task-tile"]')).toBeNull()
    expect(chip.textContent).toContain("opened PR #9")
    expect(chip.textContent).not.toContain("Coordinator cards")

    // The message is behind the Coordinator card's "1 earlier": it pages back to it and scrolls there.
    expect(coordinator().textContent).not.toContain("Fix login and build the cards")
    click(origin)
    await frames()
    expect(coordinator().textContent).toContain("Fix login and build the cards")
    expect(coordinator().textContent).not.toContain("1 earlier")
    expect(scrolled).toContain(CHAT[0]!.id)
    vi.restoreAllMocks()
  })

  it("takes a link to a message to its card: unfolds the Coordinator card, shows it again under Tasks only and leaves a project", async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset.chatId ?? this.id)
    })
    render()
    click(coordinator().querySelector('[data-testid="bottom-card-fold"]')!)
    expect(coordinator().textContent).not.toContain("Shoot every Map 3 area")
    click(host.querySelector('[data-testid="tasks-only"]')!)
    act(() => setChatProjectFilter(MAP.id))
    expect(coordinator()).toBeNull()
    // A schedule run's "View in chat", say.
    act(() => revealChatMessage(CHAT[0]!.id))
    await frames()
    expect(host.querySelector('[data-testid="tasks-only"]')!.getAttribute("aria-pressed")).toBe("false")
    expect(coordinator().textContent).toContain("Shoot every Map 3 area")
    expect(coordinator().textContent).toContain("Fix login and build the cards")
    expect(scrolled).toContain(CHAT[0]!.id)

    // An update in a closed card: the card opens and goes there.
    scrolled.length = 0
    const update = CHAT.find((m) => m.role === "notice" && m.meta?.taskId === CARDS.id)!
    expect(card(CARDS.id).dataset.open).toBeUndefined()
    act(() => revealChatMessage(update.id))
    await frames()
    expect(card(CARDS.id).dataset.open).toBe("true")
    expect(scrolled).toContain(update.id)
    // A tool call isn't in any card: nothing happens.
    scrolled.length = 0
    act(() => revealChatMessage(CHAT[1]!.id))
    await frames()
    expect(scrolled).toEqual([])
    vi.restoreAllMocks()
  })

  it("gives each task of a create_tasks call a whole card: its updates, where and how long it has run, its page, ⤢", () => {
    render()
    expect([HOLLOW.id, DAM.id].map((id) => card(id).querySelector('[data-testid="card-placement"]')?.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Runs on: /),
      expect.stringMatching(/^Runs on: /),
    ])
    expect(card(HOLLOW.id).textContent).toContain("12m")
    expect(card(DAM.id).querySelector('[data-testid="chat-card-panel"]')).not.toBeNull()
    click(head(HOLLOW.id))
    const body = card(HOLLOW.id).querySelector('[data-testid="chat-card-body"]')!
    expect(body.textContent).toContain("the entrance is lit")
    expect(body.querySelector('[data-testid="chat-card-origin"]')!.textContent).toContain("Shoot every Map 3 area")
    expect(card(HOLLOW.id).querySelector(`[data-testid="chat-card-meta"] a[href="/tasks/${HOLLOW.id}"]`)).not.toBeNull()
    // The finished one is in "done today", a card like any other.
    click(host.querySelector('[data-testid="cards-done"]')!)
    expect(card(CAMP.id).textContent).toContain("Merged")
  })

  it("says what's new on a card until it's opened, and the ↓ pill goes to it", async () => {
    render()
    await setChat([...CHAT, notice(CARDS, "💬 **Coordinator cards** says: screenshots are up")])
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')!.textContent).toBe("1 new")
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    const pill = host.querySelector('[data-testid="new-cards-pill"]')!
    expect(pill.textContent).toContain("1 new")
    expect(pill.querySelector('[data-testid="new-cards-target"]')!.textContent).toBe("Coordinator cards")
    // The card got news without moving.
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])

    click(head(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    expect(host.querySelector('[data-testid="new-cards-pill"]')).toBeNull()
    // Seen stays seen.
    act(() => root.unmount())
    root = createRoot(host)
    render()
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
  })

  it("lands on the cards in a browser that remembered the Timeline, and forgets it", async () => {
    localStorage.setItem("boxyard:coordinator-timeline", "1")
    vi.resetModules()
    await import("../web/src/lib/coordinatorView.js")
    expect(localStorage.getItem("boxyard:coordinator-timeline")).toBeNull()
    localStorage.setItem("boxyard:coordinator-timeline", "1")
    render()
    expect(host.querySelector('[data-testid="chat-cards"]')).not.toBeNull()
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
  })

  it("keeps one project's cards when the bar filters, with its Captain's card in the Coordinator card's place", () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    expect(cards().map((c) => c.dataset.card)).toEqual([HOLLOW.id, DAM.id])
    // Only Map 3's done task, not box-yard's.
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("1 done today")
    expect(coordinator()).toBeNull()
    expect(host.querySelector('[data-testid="captain-card"]')!.getAttribute("aria-label")).toBe("Map 3 Captain")
    // "All": the Coordinator card again.
    click(button(host.querySelector('[data-testid="project-bar"]')!, "All"))
    expect(coordinator().textContent).toContain("Shoot every Map 3 area")
    expect(host.querySelector('[data-testid="captain-card"]')).toBeNull()
  })

  it("folds the Coordinator card to its header and its newest line, and remembers it", async () => {
    render()
    const fold = () => coordinator().querySelector('[data-testid="bottom-card-fold"]') as HTMLElement
    expect(fold().getAttribute("aria-expanded")).toBe("true")
    expect(coordinator().querySelector('[data-testid="bottom-card-sub"]')!.textContent).toBe("What you type below lands here. Each task it starts gets a card above.")
    click(fold())
    expect(fold().getAttribute("aria-expanded")).toBe("false")
    expect(coordinator().textContent).not.toContain("Shoot every Map 3 area")
    expect(coordinator().querySelector('[data-testid="bottom-card-sub"]')!.textContent).toBe("Coordinator: 3 tasks started.")
    // A reply on its way shows as dots by the title.
    act(() => qc.setQueryData(keys.chatBusy, true))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(coordinator().querySelector('[aria-label="Working"]')).not.toBeNull()
    // This browser remembers it.
    act(() => root.unmount())
    root = createRoot(host)
    render()
    expect(coordinator().textContent).not.toContain("Shoot every Map 3 area")
    // A click on the header (not its buttons) unfolds it.
    click(coordinator().querySelector('[data-testid="bottom-card-head"]')!)
    expect(coordinator().textContent).toContain("Shoot every Map 3 area")
    expect(localStorage.getItem("boxyard:bottom-card-folded")).toBeNull()
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
  it("sends to the task by default, and shows the message and the agent's answer in the card", async () => {
    render()
    click(head(LOGIN.id))
    const box = composer(card(LOGIN.id))
    expect(box.querySelector("textarea")!.placeholder).toBe("Answer the agent…")
    // No Coordinator target to pick: the box is the task's.
    expect(box.querySelector('[data-testid="card-composer-hint"]')!.textContent).toBe("To this task")
    expect(box.querySelectorAll("button[aria-pressed]")).toHaveLength(0)
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
    // It answers Cody, so it reads as the agent's reply, not a chip; the card's header names the task, so it doesn't.
    const reply = body.querySelector('[data-testid="agent-reply"]')!
    expect(reply.textContent).toContain("finished its turn")
    expect(reply.textContent).not.toContain("Fix login")
    expect(reply.textContent).toContain("Switched to the new page.")
    expect(reply.querySelector("strong")?.textContent).toBe("the new page")
    expect([...body.querySelectorAll('[data-testid="update-chip"]')].some((c) => c.textContent?.includes("Switched"))).toBe(false)
    // Closed, the card's latest line is the answer.
    click(head(LOGIN.id))
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-latest"]')!.textContent).toContain("Switched to the new page.")
  })

  it("sends to the Coordinator, with the task's id and why, only when the task refuses it, and says so in the card", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      if (url === `/api/tasks/${CARDS.id}/messages`) return Promise.resolve(new Response(JSON.stringify({ error: "Its runner is gone." }), { status: 409 }))
      if (url === "/api/chat") {
        const { id, content } = JSON.parse(String(init!.body)) as { id: string; content: string }
        return Promise.resolve(new Response(JSON.stringify({ id, role: "user", content, meta: null, createdAt: Date.now() }), { status: 201 }))
      }
      return new Promise(() => {})
    })
    render()
    act(() => setChatProjectFilter(YARD.id))
    click(head(CARDS.id))
    await send(card(CARDS.id), "Is it blocking anything?")
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts.map((p) => p.url)).toEqual([`/api/tasks/${CARDS.id}/messages`, "/api/chat"])
    expect(posts[1]!.body.content).toBe(
      `↪️ Rerouted from my reply to the task "Coordinator cards" (${CARDS.id}), which couldn't take it: Its runner is gone. Please work out where it should go.\n\nIs it blocking anything?`,
    )
    const note = card(CARDS.id).querySelector('[data-testid="card-rerouted"]')!
    expect(note.textContent).toBe("This task couldn't take it (Its runner is gone.), so it went to the Coordinator. Show")
    // Behind the project filter, Show goes to the Coordinator card, where it landed.
    click(button(note, "Show"))
    expect(coordinator().textContent).toContain("Is it blocking anything?")
    expect((card(CARDS.id).querySelector('[data-testid="card-composer"] textarea') as HTMLTextAreaElement).value).toBe("")
  })

  it("doesn't reroute when the server can't be reached: the text goes back in the box", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return Promise.reject(new TypeError("Failed to fetch"))
    })
    render()
    click(head(CARDS.id))
    await send(card(CARDS.id), "Still there?")
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts.map((p) => p.url)).toEqual([`/api/tasks/${CARDS.id}/messages`])
    expect(card(CARDS.id).querySelector('[data-testid="card-rerouted"]')).toBeNull()
    expect((card(CARDS.id).querySelector('[data-testid="card-composer"] textarea') as HTMLTextAreaElement).value).toBe("Still there?")
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
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, HOLLOW.id, DAM.id])
    expect(card(LOGIN.id).querySelector('[data-testid="card-composer"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("3 done today")

    click(head(LOGIN.id))
    expect(cards().map((c) => c.dataset.card)).toEqual([LOGIN.id, HOLLOW.id, DAM.id])
    await setChat([...CHAT, notice(HOLLOW, "💬 **Map 3 PR #406: The Hollow cave** says: halfway")])
    expect(cards().map((c) => c.dataset.card)).toEqual([HOLLOW.id, DAM.id])
    expect(host.querySelector('[data-testid="cards-done"]')!.textContent).toContain("4 done today")
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
    expect(cards().map((c) => c.dataset.card)).toEqual([CAMP.id, LOGIN.id, CARDS.id, DOCS.id, HOLLOW.id, DAM.id])
    expect(card(DOCS.id).querySelector('[data-testid="card-composer"]')).not.toBeNull()
    expect(scrolled).toEqual([`card-${DOCS.id}`])
    vi.restoreAllMocks()
  })

  it("gives each task of a create_tasks call its own box, which sends to it", async () => {
    render()
    click(head(HOLLOW.id))
    click(head(DAM.id))
    expect(card(HOLLOW.id).querySelector('[data-testid="card-working"]')!.textContent).toBe(`${HOLLOW.title} is working`)
    expect(composer(card(HOLLOW.id)).querySelector("textarea")!.placeholder).toBe("Queue another message…")
    expect(card(DAM.id).querySelector('[data-testid="card-working"]')).toBeNull()
    await send(card(DAM.id), "Shoot it at dusk")
    expect(posts).toEqual([{ url: `/api/tasks/${DAM.id}/messages`, body: { content: "Shoot it at dusk", attachments: [], inChat: true } }])
    expect(card(HOLLOW.id).querySelectorAll('[data-testid="card-composer"]')).toHaveLength(1)
    expect(card(DAM.id).querySelectorAll('[data-testid="card-composer"]')).toHaveLength(1)
  })
})

describe("A card in the side panel", () => {
  let posts: { url: string; body: Record<string, unknown> }[]
  beforeEach(() => {
    posts = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} })
      return new Promise(() => {})
    })
  })

  const panel = () => host.querySelector('[data-testid="side-thread"]') as HTMLElement | null
  const expand = (key: string) => card(key).querySelector('[data-testid="chat-card-panel"]') as HTMLElement
  /** Opens the panel's ⋯ and reads its items. */
  const menu = (p: HTMLElement) => {
    if (!document.querySelector('[role="menu"]')) click(p.querySelector('button[aria-label="More card actions"]')!)
    return [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)
  }
  const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label) as HTMLElement

  it("⤢ opens it beside the chat as Tasks › its title, with its header, its history and a box at the bottom; its card is outlined", () => {
    render()
    click(expand(LOGIN.id))
    // The header keeps its click: the card itself stays as it was.
    expect(card(LOGIN.id).dataset.open).toBeUndefined()
    const p = panel()!
    expect(p.dataset.card).toBe(LOGIN.id)
    expect(p.getAttribute("aria-label")).toBe("Task")
    const crumb = p.querySelector('nav[aria-label="Breadcrumb"]')!
    expect(crumb.textContent).toBe("TasksFix login")
    expect(p.querySelector('[data-testid="card-panel-head"]')!.textContent).toContain("Needs you")
    expect(p.querySelector('[data-testid="chat-card-origin"]')!.textContent).toContain("Fix login and build the cards")
    // A question is one of its replies, as the card's header counts them.
    expect(p.querySelector('[data-testid="card-panel-divider"]')!.textContent).toBe("1 reply")
    expect(p.textContent).toContain("Which page, the old one or the new one?")
    // Its box is the panel's footer, after the history.
    const box = p.querySelector('[data-testid="card-composer"]') as HTMLElement
    expect(box.previousElementSibling!.contains(p.querySelector('[data-testid="card-panel-divider"]'))).toBe(true)
    // The thread panel's header: ✓ Mark done, ⋯, Maximize and ×.
    expect(p.querySelector('[data-testid="card-panel-done"]')!.getAttribute("aria-label")).toBe("Mark done")
    expect(p.querySelector('button[aria-label="More card actions"]')).not.toBeNull()
    expect(p.querySelector('[data-testid="card-panel-expand"]')!.getAttribute("aria-label")).toBe("Expand over the chat")
    expect(p.querySelector('header button[aria-label="Close"]')).not.toBeNull()
    expect(p.querySelector("header a")).toBeNull()

    expect(card(LOGIN.id).dataset.inPanel).toBe("true")
    expect(expand(LOGIN.id).getAttribute("aria-pressed")).toBe("true")
    expect(card(CARDS.id).dataset.inPanel).toBeUndefined()
    // Esc closes it; the card loses its outline.
    act(() => void p.querySelector('[data-testid="card-panel"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(card(LOGIN.id).dataset.inPanel).toBeUndefined()
  })

  it("replies to its task from the panel's box", async () => {
    render()
    click(expand(LOGIN.id))
    const box = panel()!.querySelector('[data-testid="card-composer"]') as HTMLElement
    expect(box.querySelector("textarea")!.placeholder).toBe("Answer the agent…")
    const textarea = box.querySelector("textarea")!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea, "The new one")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    for (let i = 0; i < 2; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts).toEqual([{ url: `/api/tasks/${LOGIN.id}/messages`, body: { content: "The new one", attachments: [], inChat: true } }])
  })

  it("reads its news while it's there, and shows every entry, not the card's newest 4", async () => {
    render()
    const more = Array.from({ length: 6 }, (_, i) => notice(CARDS, `💬 **Coordinator cards** says: step ${i + 1}`))
    await setChat([...CHAT, ...more])
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')!.textContent).toBe("6 new")
    click(expand(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
    expect(panel()!.querySelector('[data-testid="card-earlier"]')).toBeNull()
    for (const n of [1, 6]) expect(panel()!.textContent).toContain(`step ${n}`)
    // News while it's in the panel is read too.
    await setChat([...CHAT, ...more, notice(CARDS, "💬 **Coordinator cards** says: step 7")])
    expect(panel()!.textContent).toContain("step 7")
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-unread"]')).toBeNull()
  })

  it("is one panel with reply threads: ⤢ again closes it, and a thread takes its place", () => {
    render()
    click(expand(LOGIN.id))
    // Another card swaps in.
    click(expand(CARDS.id))
    expect(panel()!.dataset.card).toBe(CARDS.id)
    expect(card(LOGIN.id).dataset.inPanel).toBeUndefined()
    expect(card(CARDS.id).dataset.inPanel).toBe("true")
    click(expand(CARDS.id))
    expect(card(CARDS.id).dataset.inPanel).toBeUndefined()
    click(expand(LOGIN.id))
    act(() => openThread(COORDINATOR_CHAT, "thr_somethread"))
    expect(panel()!.getAttribute("aria-label")).toBe("Thread")
    expect(panel()!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent).toContain("Threads")
    expect(card(LOGIN.id).dataset.inPanel).toBeUndefined()
  })

  it("opens from an open card's ⤢, in its header", () => {
    render()
    click(head(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-open-panel"]')).toBeNull()
    click(expand(CARDS.id))
    expect(panel()!.dataset.card).toBe(CARDS.id)
    expect(panel()!.querySelector('[data-testid="card-panel-title"]')!.textContent).toBe("Coordinator cards")
    expect(panel()!.textContent).toContain("opened PR #9")
  })

  it("shows a task of a create_tasks call like any other: its own box, Mark done and task page", () => {
    render()
    click(expand(HOLLOW.id))
    const p = panel()!
    expect(p.querySelector('[data-testid="card-panel-title"]')!.textContent).toBe(HOLLOW.title)
    expect(p.textContent).toContain("the entrance is lit")
    expect(p.querySelector('[data-testid="card-panel-divider"]')!.textContent).toContain("1 update")
    expect(p.querySelector('[data-testid="card-panel-done"]')).not.toBeNull()
    expect(p.querySelector('[data-testid="card-composer"]')).not.toBeNull()
    expect(menu(p)).toEqual(["Open the task page", "Stop answering", "Show its card"])
  })

  it("has the thread panel's ⋯: Open the task page and Show its card", () => {
    render()
    click(expand(LOGIN.id))
    expect(menu(panel()!)).toEqual(["Open the task page", "Show its card"])
  })

  it("stops its task's agent from ⋯ while it works", async () => {
    render()
    await act(async () => {
      qc.setQueryData(keys.tasks, TASKS.map((t) => (t.id === LOGIN.id ? { ...t, status: "working" as const } : t)))
      await new Promise((r) => setTimeout(r, 0))
    })
    click(expand(LOGIN.id))
    const items = menu(panel()!)
    expect(items).toEqual(["Open the task page", "Stop answering", "Show its card"])
    click(menuItem("Stop answering"))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts.map((x) => x.url)).toEqual([`/api/tasks/${LOGIN.id}/stop`])
  })

  it("Show its card opens the card and scrolls to it", async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id.startsWith("card-")) scrolled.push(this.id)
    })
    render()
    click(expand(CARDS.id))
    expect(card(CARDS.id).dataset.open).toBeUndefined()
    menu(panel()!)
    click(menuItem("Show its card"))
    await act(async () => await new Promise((r) => setTimeout(r, 50)))
    expect(card(CARDS.id).dataset.open).toBe("true")
    expect(scrolled).toEqual([`card-${CARDS.id}`])
    // Beside the chat, it stays open.
    expect(panel()!.dataset.card).toBe(CARDS.id)
    vi.restoreAllMocks()
  })

  it("expands over the chat and back, as a thread does", () => {
    render()
    click(expand(LOGIN.id))
    const max = () => panel()!.querySelector('[data-testid="card-panel-expand"]') as HTMLElement
    click(max())
    expect(panel()!.dataset.expanded).toBe("true")
    expect(max().getAttribute("aria-label")).toBe("Back beside the chat")
    expect(max().getAttribute("aria-pressed")).toBe("true")
    click(max())
    expect(panel()!.dataset.expanded).toBeUndefined()
  })

  it("turns ✓ into Reopen once done: in the undo window it undoes Mark done, after it goes to the box", () => {
    render()
    click(expand(LOGIN.id))
    const done = () => panel()!.querySelector('[data-testid="card-panel-done"]') as HTMLElement
    click(done())
    expect(done().getAttribute("aria-label")).toBe("Reopen")
    expect(done().getAttribute("aria-pressed")).toBe("true")
    click(done())
    expect(done().getAttribute("aria-label")).toBe("Mark done")
    expect(posts).toEqual([])
  })

  it("offers Reopen for a task that's done, which goes to its box", () => {
    render()
    click(host.querySelector('[data-testid="cards-done"]')!)
    click(expand(DOCS.id))
    const done = panel()!.querySelector('[data-testid="card-panel-done"]') as HTMLElement
    expect(done.getAttribute("aria-label")).toBe("Reopen")
    click(done)
    const box = panel()!.querySelector("textarea")!
    expect(document.activeElement).toBe(box)
    expect(box.placeholder).toBe("Reply (reopens the task)…")
  })
})

describe("The bottom panel with a project picked", () => {
  let posts: { url: string; body: Record<string, unknown> }[]
  const captainState = (projectId: string, extra: Partial<CaptainState> = {}): CaptainState => ({
    projectId,
    busy: false,
    usage: { tokens: 50_000, window: 200_000, updatedAt: 1 },
    compacting: false,
    compactQueued: false,
    lastCompaction: null,
    compactionsDir: "",
    error: null,
    ...extra,
  })
  const line = (id: string, role: CaptainMessage["role"], content: string, meta: Record<string, unknown> | null = null): CaptainMessage => ({
    id,
    projectId: MAP.id,
    role,
    content,
    meta,
    createdAt: Date.now() - 60_000 + Number(id.slice(-2)) * 1000,
  })
  const CAPTAIN: CaptainMessage[] = [
    line("cap_m01", "user", "Which areas are left?", { source: "cody" }),
    line("cap_m02", "assistant", "Two: the cave and the dam."),
    line("cap_m03", "notice", "✅ **Map 3 PR #399: Dam Hamlet camp** is done: shot it", { taskId: CAMP.id }),
    line("cap_m04", "user", "How's the cave?", { source: "cody" }),
    line("cap_m05", "tool", "list_tasks"),
    line("cap_m06", "assistant", "Lit and **halfway** there.", { nextSteps: ["Shoot the dam next"] }),
  ]
  beforeEach(() => {
    posts = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Promise(() => {})
    })
    qc.setQueryData(keys.captainMessages(MAP.id), CAPTAIN)
    qc.setQueryData(keys.captain(MAP.id), captainState(MAP.id))
    qc.setQueryData(keys.orchestrator, { ...captainState(""), usage: { tokens: 10_000, window: 1_000_000, updatedAt: 1 } })
    qc.setQueryData(keys.agentSettings, { settings: { orchestratorAutoCompact: { enabled: false } } })
  })

  const textarea = () => host.querySelector('[data-testid="chat-panel"] > div > form textarea, form textarea[placeholder$="Captain…"], form textarea[placeholder="Ask the Coordinator…"]') as HTMLTextAreaElement
  const captainCard = () => host.querySelector('[data-testid="captain-card"]') as HTMLElement | null
  const send = async (text: string) => {
    const box = textarea()
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(box, text)
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    for (let i = 0; i < 2; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
  }

  it("talks to the project's Captain: the header names it with its context, and the box sends to it", async () => {
    render()
    expect(host.querySelector('[data-testid="chat-title"]')!.textContent).toBe("Coordinator")
    expect(textarea().placeholder).toBe("Ask the Coordinator…")
    act(() => setChatProjectFilter(MAP.id))
    expect(host.querySelector('[data-testid="chat-title"]')!.textContent).toBe("Map 3 Captain")
    expect(host.querySelector('[data-testid="context-menu-button"]')!.getAttribute("title")).toBe(`Context ${contextLabel(50_000, 200_000)}`)
    expect(textarea().placeholder).toBe("Message the Map 3 Captain…")
    expect(host.querySelector('[data-testid="composer-to"]')!.textContent).toBe("To the Map 3 Captain")
    await send("Shoot the dam at dusk")
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`/api/projects/${MAP.id}/captain/messages`)
    expect(posts[0]!.body).toMatchObject({ content: "Shoot the dam at dusk", attachments: [] })
    // It shows in the Captain's card at once; the Coordinator's chat never gets it.
    expect(captainCard()!.textContent).toContain("Shoot the dam at dusk")
    expect(qc.getQueryData(keys.chat)).toEqual(CHAT)

    // "All": the Coordinator again.
    act(() => setChatProjectFilter(null))
    expect(host.querySelector('[data-testid="chat-title"]')!.textContent).toBe("Coordinator")
    expect(host.querySelector('[data-testid="context-menu-button"]')!.getAttribute("title")).toBe(`Context ${contextLabel(10_000, 1_000_000)}`)
    expect(host.querySelector('[data-testid="composer-to"]')).toBeNull()
    expect(host.querySelector('[data-testid="tasks-only"]')).not.toBeNull()
    await send("What's left?")
    expect(posts[1]!.url).toBe("/api/chat")
  })

  it("Tasks only hides the Captain card for every project, remembers it apart from All, and sending to the Captain shows it again", async () => {
    render()
    const toggle = () => host.querySelector('[data-testid="tasks-only"]') as HTMLElement
    act(() => setChatProjectFilter(MAP.id))
    expect(toggle().getAttribute("aria-pressed")).toBe("false")
    expect(toggle().getAttribute("aria-label")).toBe("Tasks only: hide the Captain card")
    expect(toggle().title).toBe("Tasks only: hide the Captain card under the task cards")
    click(toggle())
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    expect(toggle().title).toBe("Tasks only: the Captain card is hidden. Click to show it")
    expect(captainCard()).toBeNull()
    expect(host.querySelector('[data-testid="captain-hidden"]')!.textContent).toContain("Map 3 Captain card hidden (Tasks only)")
    expect(localStorage.getItem("boxyard:cards-tasks-only-project")).toBe("1")
    expect(localStorage.getItem("boxyard:cards-tasks-only")).toBeNull()

    // "All" keeps its own choice: the Coordinator card is still there.
    act(() => setChatProjectFilter(null))
    expect(toggle().getAttribute("aria-pressed")).toBe("false")
    expect(toggle().getAttribute("aria-label")).toBe("Tasks only: hide the Coordinator card")
    expect(host.querySelector('[data-testid="coordinator-card"]')).not.toBeNull()

    // Back on a project (any project): still hidden; its stand-in shows it again.
    act(() => setChatProjectFilter(MAP.id))
    expect(captainCard()).toBeNull()
    click(host.querySelector('[data-testid="captain-hidden"]')!)
    expect(captainCard()).not.toBeNull()
    expect(toggle().getAttribute("aria-pressed")).toBe("false")

    // Sending to the Captain shows its card, so its answer is in view.
    click(toggle())
    await send("Shoot the dam at dusk")
    expect(captainCard()!.textContent).toContain("Shoot the dam at dusk")
    expect(toggle().getAttribute("aria-pressed")).toBe("false")
  })

  it("shows the Captain's conversation in its card, not task notices or tool calls, and its next steps go to it", async () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    const c = captainCard()!
    expect(c.querySelector('[data-testid="bottom-card-sub"]')!.textContent).toBe("What you type below goes to the Map 3 Captain. The Coordinator doesn't see it.")
    // The newest three, then "1 earlier".
    expect(c.textContent).toContain("How's the cave?")
    expect(c.textContent).toContain("Lit and halfway there.")
    expect(c.textContent).toContain("Two: the cave and the dam.")
    expect(c.textContent).not.toContain("Which areas are left?")
    expect(c.textContent).not.toContain("Dam Hamlet camp")
    expect(c.textContent).not.toContain("list_tasks")
    click(c.querySelector('[data-testid="captain-card-earlier"]')!)
    expect(c.textContent).toContain("Which areas are left?")
    expect(c.querySelector(`a[href="/projects/${MAP.id}?tab=captain"]`)).not.toBeNull()
    click(button(c, "Shoot the dam next"))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts).toEqual([{ url: `/api/projects/${MAP.id}/captain/messages`, body: expect.objectContaining({ content: "Shoot the dam next" }) }])
  })

  it("folds like the Coordinator card, with its newest line and dots while it works", async () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    click(captainCard()!.querySelector('[data-testid="bottom-card-fold"]')!)
    expect(captainCard()!.textContent).not.toContain("How's the cave?")
    expect(captainCard()!.querySelector('[data-testid="bottom-card-sub"]')!.textContent).toBe("Captain: Lit and halfway there.")
    await act(async () => {
      qc.setQueryData(keys.captain(MAP.id), captainState(MAP.id, { busy: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(captainCard()!.querySelector('[aria-label="Working"]')).not.toBeNull()
    // One setting for both: the Coordinator card is folded too.
    act(() => setChatProjectFilter(null))
    expect(coordinator().querySelector('[data-testid="bottom-card-fold"]')!.getAttribute("aria-expanded")).toBe("false")
  })

  it("unfolds the card a prompt goes to, even hidden by Tasks only, and lets Cody fold it again", async () => {
    render()
    const fold = (c: Element) => c.querySelector('[data-testid="bottom-card-fold"]') as HTMLElement
    // Folded and hidden, under "All": a prompt to the Coordinator shows its card, open.
    click(fold(coordinator()))
    click(host.querySelector('[data-testid="tasks-only"]')!)
    expect(coordinator()).toBeNull()
    await send("What's left?")
    expect(posts.at(-1)!.url).toBe("/api/chat")
    expect(fold(coordinator()).getAttribute("aria-expanded")).toBe("true")
    expect(coordinator().textContent).toContain("What's left?")
    // Folding it again sticks until the next prompt.
    click(fold(coordinator()))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(fold(coordinator()).getAttribute("aria-expanded")).toBe("false")
    expect(localStorage.getItem("boxyard:bottom-card-folded")).toBe("1")

    // With a project picked: the prompt goes to its Captain, and its card opens.
    act(() => setChatProjectFilter(MAP.id))
    click(host.querySelector('[data-testid="tasks-only"]')!)
    expect(captainCard()).toBeNull()
    await send("Shoot the dam at dusk")
    expect(posts.at(-1)!.url).toBe(`/api/projects/${MAP.id}/captain/messages`)
    expect(fold(captainCard()!).getAttribute("aria-expanded")).toBe("true")
    expect(captainCard()!.textContent).toContain("Shoot the dam at dusk")
    // "Tasks only" under "All" is its own choice: it stays off, as the first prompt left it.
    expect(localStorage.getItem("boxyard:cards-tasks-only")).toBeNull()
  })

  it("leaves the bottom card folded when Cody replies to a task in its card", async () => {
    render()
    click(coordinator().querySelector('[data-testid="bottom-card-fold"]')!)
    click(card(LOGIN.id).querySelector('[role="button"]')!)
    const box = card(LOGIN.id).querySelector('[data-testid="card-composer"]')!
    const textarea = box.querySelector("textarea")!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea, "The new one")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    for (let i = 0; i < 2; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts.at(-1)!.url).toBe(`/api/tasks/${LOGIN.id}/messages`)
    expect(coordinator().querySelector('[data-testid="bottom-card-fold"]')!.getAttribute("aria-expanded")).toBe("false")
  })

  it("goes back to the Coordinator from the chat switcher", () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    click(host.querySelector('[data-testid="chat-switcher"]')!)
    const items = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[]
    expect(items.find((i) => i.getAttribute("aria-checked") === "true")!.textContent).toContain("Map 3")
    click(items.find((i) => i.textContent?.includes("Coordinator"))!)
    expect(host.querySelector('[data-testid="chat-title"]')!.textContent).toBe("Coordinator")
    expect(host.querySelector('[data-testid="project-bar"] button[aria-pressed="true"]')!.textContent).toContain("All")
  })
})

describe("A card's header", () => {
  const meta = (key: string) => card(key).querySelector('[data-testid="chat-card-meta"]') as HTMLElement
  it("holds the title once, then one row with its status, one PR chip (↗), its age and ✓ ⤢ → and fold", () => {
    render()
    const c = card(CARDS.id)
    expect(c.querySelectorAll('[data-testid="chat-card-title"]')).toHaveLength(1)
    expect(meta(CARDS.id).textContent).toContain("PR ready")
    const pr = meta(CARDS.id).querySelectorAll('a[href="https://github.com/o/r/pull/9"]')
    expect(pr).toHaveLength(1)
    expect(pr[0]!.getAttribute("target")).toBe("_blank")
    expect(pr[0]!.querySelector("[data-external-mark]")).not.toBeNull()
    expect([...meta(CARDS.id).querySelectorAll("button, a")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual([
      expect.stringContaining("PR #9"),
      "Mark done",
      "Open in the side panel",
      "Task page",
      "Open the card",
    ])
    // Open, the body doesn't repeat it: no PR chip, no counts, no footer.
    click(c.querySelector('[data-testid="chat-card-fold"]')!)
    expect(c.dataset.open).toBe("true")
    expect(c.querySelector('[data-testid="chat-card-fold"]')!.getAttribute("aria-label")).toBe("Fold the card")
    const body = c.querySelector('[data-testid="chat-card-body"]')!
    expect(body.querySelector('a[href="https://github.com/o/r/pull/9"]')).toBeNull()
    expect(c.textContent).not.toMatch(/\d+ updates?\b/)
    click(c.querySelector('[data-testid="chat-card-fold"]')!)
    expect(c.dataset.open).toBeUndefined()
  })

  it("says Merged once, in its PR chip", () => {
    render()
    click(host.querySelector('[data-testid="cards-done"]')!)
    expect(meta(CAMP.id).textContent!.match(/Merged/g)).toHaveLength(1)
    expect(meta(CAMP.id).querySelector('[data-pr-state="merged"]')!.textContent).toContain("Merged #399")
  })

  it("names its project only under All", () => {
    render()
    expect(meta(CARDS.id).querySelector('[data-testid="chat-card-project"]')!.textContent).toBe(YARD.name)
    act(() => setChatProjectFilter(YARD.id))
    expect(meta(CARDS.id).querySelector('[data-testid="chat-card-project"]')).toBeNull()
  })
})

describe("A card's event digest", () => {
  const SHA = "ff8fc2305ab9c31e61cfc78f89fadf6c2d5d42ee"
  const hook = notice(CARDS, `🚢 The Captain asked **Coordinator cards** to merge PR #9: https://github.com/o/r/pull/9`)
  const done = notice(CARDS, `✅ **Coordinator cards** is done: PR #9 is merged into main as squash commit ${SHA}.`)
  const report = msg("notice", `Captain for box-yard: I merged PR #9 ([Coordinator cards](/tasks/${CARDS.id})).`, { projectId: YARD.id, captain: true })
  const answer = msg("assistant", `[Coordinator cards](/tasks/${CARDS.id}) is merged. Shall I restart Box Yard?`, { nextSteps: ["Restart Box Yard now", "Not yet"] })

  it("folds the hook, done and report lines into one line with a short SHA; a tap shows each; the reply reads whole", async () => {
    render()
    await setChat([...CHAT, hook, done, report, answer])
    click(head(CARDS.id))
    const body = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    const digest = body.querySelector('[data-testid="event-digest"]')!
    // The PR it opened, the merge request, done and the report.
    expect(digest.querySelector('[data-testid="event-digest-summary"]')!.textContent).toBe("Merged as ff8fc23")
    expect(digest.textContent).toContain("4 events")
    expect(body.textContent).not.toContain(SHA)
    expect(body.querySelectorAll('[data-testid="update-chip"]')).toHaveLength(0)
    expect(body.textContent).toContain("Shall I restart Box Yard?")
    // The Coordinator's reply in a task card has no "from:" line.
    expect(body.querySelector('[data-testid="reply-sources"]')).toBeNull()
    const line = digest.querySelector("button")!
    expect(line.getAttribute("aria-expanded")).toBe("false")
    click(line)
    expect(line.getAttribute("aria-expanded")).toBe("true")
    expect(digest.querySelectorAll('[data-testid="update-chip"]')).toHaveLength(4)
    expect(digest.textContent).toContain("ff8fc23")
    expect(digest.textContent).not.toContain(SHA)
  })

  it("opens to a message a link goes to", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
    render()
    await setChat([...CHAT, hook, done, report, answer])
    act(() => revealChatMessage(done.id))
    await frames()
    await frames()
    expect(card(CARDS.id).dataset.open).toBe("true")
    expect(card(CARDS.id).querySelector('[data-testid="event-digest"]')!.getAttribute("data-open")).toBe("true")
    expect(card(CARDS.id).querySelector(`[data-chat-id="${done.id}"]`)).not.toBeNull()
    vi.restoreAllMocks()
  })

  it("leaves a lone event a quiet chip, and the Coordinator card has no digest", async () => {
    render()
    click(head(CARDS.id))
    expect(card(CARDS.id).querySelector('[data-testid="event-digest"]')).toBeNull()
    expect(card(CARDS.id).querySelectorAll('[data-testid="update-chip"]')).toHaveLength(1)
    expect(coordinator().querySelector('[data-testid="event-digest"]')).toBeNull()
  })
})

describe("Mark done in the cards", () => {
  // Resting since a turn 5 hours ago: past the 3 hour "Idle after".
  const OLD = task("task_old00001", MAP.id, "Map 3 PR #401: East Town", "idle")
  const oldNotice = { ...notice(OLD, "💬 **Map 3 PR #401: East Town** says: shot it"), createdAt: Date.now() - 5 * 3600_000 }
  let posts: string[]
  beforeEach(() => {
    posts = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url)
      return new Promise(() => {})
    })
    qc.setQueryData(keys.tasks, [...TASKS, OLD])
    qc.setQueryData(keys.chat, [oldNotice, ...CHAT])
  })
  afterEach(() => {
    // The undo window and the selection outlive a test: take them back.
    act(() => {
      for (const t of [...TASKS, OLD]) undoClose(t.id)
      stopSelecting()
      for (const t of currentToasts()) dismiss(t.id)
    })
  })

  const settings = (s: Partial<SettingsInfo["settings"]>) => qc.setQueryData(keys.agentSettings, { settings: s } as unknown as SettingsInfo)
  const live = () => cards().map((c) => c.dataset.card)
  const fold = (id: "done" | "idle") => host.querySelector(`[data-testid="cards-${id}"]`) as HTMLElement | null
  const toastTitles = () => currentToasts().map((t) => t.title)
  const undo = () => act(() => currentToasts().at(-1)!.action!.onClick())

  it("folds a resting card with no news for the Idle after hours into \"N idle\", next to \"N done today\"", () => {
    render()
    expect(live()).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
    expect(fold("idle")!.textContent).toContain("1 idle")
    expect(fold("idle")!.title).toContain("3h")
    click(fold("idle")!)
    expect(card(OLD.id).textContent).toContain("Idle")
  })

  it("leaves it up with Idle after at 0, and folds at the hours set", async () => {
    act(() => settings({ cardsIdleHours: 0 }))
    render()
    expect(fold("idle")).toBeNull()
    expect(live()).toContain(OLD.id)
    await act(async () => {
      settings({ cardsIdleHours: 6 })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(live()).toContain(OLD.id)
    await act(async () => {
      settings({ cardsIdleHours: 4 })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(live()).not.toContain(OLD.id)
  })

  it("marks a card done from its ✓, which folds it into done, with an Undo toast; cards have no ⋯", () => {
    render()
    expect(host.querySelector('[data-testid="chat-card-more"]')).toBeNull()
    const check = card(CARDS.id).querySelector('[data-testid="chat-card-check"]') as HTMLElement
    expect(check.getAttribute("aria-label")).toBe("Mark done")
    expect(check.title).toBe("Mark done")
    // Beside the ⤢, under the title, so the title keeps the card's width.
    expect(check.nextElementSibling!.getAttribute("data-testid")).toBe("chat-card-panel")
    expect(card(CARDS.id).querySelector('[data-testid="chat-card-title"]')!.parentElement!.querySelector("button")).toBeNull()
    click(check)
    expect(live()).toEqual([LOGIN.id, HOLLOW.id, DAM.id])
    expect(fold("done")!.textContent).toContain("3 done today")
    expect(toastTitles()).toEqual(["Marked done"])
    // Sent once the undo window is over, not before.
    expect(posts).toEqual([])
    undo()
    expect(live()).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
  })

  it("marks a task waiting on Cody done from the open card's ✓; no ✓ on a closed card that's running or asking", () => {
    render()
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-check"]')).toBeNull()
    click(head(LOGIN.id))
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-mark-done"]')).toBeNull()
    const check = card(LOGIN.id).querySelector('[data-testid="chat-card-check"]') as HTMLElement
    expect(check.title).toContain("Close the task")
    click(check)
    expect(toastTitles()).toEqual(["Marked done"])
    // Open, it stays where it is (it folds once closed), and says it's done.
    expect(live()).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-mark-done"]')).toBeNull()
    expect(card(LOGIN.id).querySelector('[data-testid="chat-card-check"]')).toBeNull()
    expect(card(HOLLOW.id).querySelector('[data-testid="chat-card-check"]')).toBeNull()
    expect(card(DAM.id).querySelector('[data-testid="chat-card-check"]')).toBeNull()
  })

  it("Mark all idle as done (in Select's bar) lists the resting tasks, never the ones running or waiting on Cody, and marks the ticked ones", () => {
    render()
    expect(host.querySelector('[data-testid="cards-clear-idle"]')).toBeNull()
    click(host.querySelector('[data-testid="cards-select"]')!)
    click(host.querySelector('[data-testid="cards-clear-idle"]')!)
    const pop = host.querySelector('[data-testid="cards-clear-idle-popover"]') as HTMLElement
    expect(pop.textContent).toContain("Mark 2 tasks done?")
    expect([...pop.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`${OLD.title}Idle`, `${CARDS.title}PR ready`])
    const boxes = [...pop.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    click(boxes[0]!)
    const confirm = host.querySelector('[data-testid="cards-clear-idle-confirm"]') as HTMLElement
    expect(confirm.textContent).toContain("Mark 1 done")
    click(confirm)
    expect(host.querySelector('[data-testid="cards-clear-idle-popover"]')).toBeNull()
    // Done with Select too.
    expect(host.querySelector('[data-testid="cards-select-bar"]')).toBeNull()
    expect(live()).toEqual([LOGIN.id, HOLLOW.id, DAM.id])
    expect(fold("idle")!.textContent).toContain("1 idle")
    expect(toastTitles()).toEqual(["Marked done"])
  })

  it("keeps to the project bar's filter", () => {
    render()
    act(() => setChatProjectFilter(MAP.id))
    click(host.querySelector('[data-testid="cards-select"]')!)
    click(host.querySelector('[data-testid="cards-clear-idle"]')!)
    const pop = host.querySelector('[data-testid="cards-clear-idle-popover"]') as HTMLElement
    expect(pop.textContent).toContain("Mark 1 task done?")
    expect(pop.textContent).toContain(OLD.title)
  })

  it("selects cards and marks the picked ones done; the ones it can't close can't be picked; Esc cancels", () => {
    const head = (key: string) => card(key).querySelector('[role="button"], [role="checkbox"]') as HTMLElement
    render()
    click(host.querySelector('[data-testid="cards-select"]')!)
    const count = () => host.querySelector('[data-testid="cards-select-count"]')!.textContent
    expect(count()).toBe("Pick cards to mark done")
    expect(head(LOGIN.id).getAttribute("role")).toBe("checkbox")
    expect(head(LOGIN.id).getAttribute("aria-disabled")).toBe("true")
    click(head(LOGIN.id))
    expect(head(LOGIN.id).getAttribute("aria-checked")).toBe("false")
    click(head(CARDS.id))
    expect(head(CARDS.id).getAttribute("aria-checked")).toBe("true")
    expect(card(CARDS.id).dataset.open).toBeUndefined()
    expect(count()).toBe("1 task selected")
    const bar = host.querySelector('[data-testid="cards-select-bar"]')!
    click(button(bar, "Select all"))
    expect(count()).toBe("2 tasks selected")
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(host.querySelector('[data-testid="cards-select-bar"]')).toBeNull()
    expect(head(CARDS.id).getAttribute("role")).toBe("button")

    click(host.querySelector('[data-testid="cards-select"]')!)
    click(head(CARDS.id))
    expect(count()).toBe("1 task selected")
    click(host.querySelector('[data-testid="cards-select-done"]')!)
    expect(host.querySelector('[data-testid="cards-select-bar"]')).toBeNull()
    expect(live()).toEqual([LOGIN.id, HOLLOW.id, DAM.id])
    expect(toastTitles()).toEqual(["Marked done"])
    undo()
    expect(live()).toEqual([LOGIN.id, CARDS.id, HOLLOW.id, DAM.id])
  })
})

describe("Finding your way in the cards", () => {
  /** Where each card sits on screen: the rest are laid out nowhere (happy-dom). */
  const place = (rects: Record<string, { top: number; bottom: number }>) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const r = rects[this.id.replace(/^card-/, "")] ?? { top: 0, bottom: 0 }
      return { ...r, left: 0, right: 100, width: 100, height: r.bottom - r.top, x: 0, y: r.top, toJSON() {} } as DOMRect
    })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const pill = () => host.querySelector('[data-testid="new-cards-pill"]') as HTMLElement | null
  const target = () => pill()!.querySelector('[data-testid="new-cards-target"]')!.textContent

  it("the pill names the card it goes to and points the way, then goes on to the next, round to the first", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
    place({ [LOGIN.id]: { top: -400, bottom: -300 }, [HOLLOW.id]: { top: 2000, bottom: 2100 }, [DAM.id]: { top: 2200, bottom: 2300 } })
    render()
    await setChat([...CHAT, notice(LOGIN, "💬 **Fix login** says: the old page"), notice(HOLLOW, "💬 **Map 3 PR #406: The Hollow cave** says: lit"), notice(DAM, "💬 **Map 3 PR #409: Dam powerhouse** says: started")])
    expect(pill()!.textContent).toContain("3 new")
    expect(target()).toBe("Fix login")
    expect(pill()!.dataset.direction).toBe("up")
    expect(pill()!.querySelector('[data-testid="new-cards-more"]')!.textContent).toBe("+2")

    click(pill()!)
    await act(async () => await new Promise((r) => requestAnimationFrame(() => r(null))))
    // It's there: ringed, and focused for the keyboard and screen readers.
    expect(document.activeElement).toBe(card(LOGIN.id))
    expect(card(LOGIN.id).classList.contains("card-flash")).toBe(true)
    expect(target()).toBe(HOLLOW.title)
    expect(pill()!.dataset.direction).toBe("down")

    click(pill()!)
    expect(target()).toBe(DAM.title)
    click(pill()!)
    expect(target()).toBe("Fix login")
  })

  it("says a card on screen is here", async () => {
    place({ [CARDS.id]: { top: 100, bottom: 200 } })
    render()
    await setChat([...CHAT, notice(CARDS, "💬 **Coordinator cards** says: screenshots are up")])
    expect(pill()!.dataset.direction).toBe("here")
    expect(pill()!.textContent).toContain("on screen")
  })

  it("pulses the stripe of a card at work: running or queued", () => {
    render()
    expect(card(HOLLOW.id).classList.contains("stripe-pulse")).toBe(true)
    expect(card(DAM.id).classList.contains("stripe-pulse")).toBe(true)
    expect(card(CARDS.id).classList.contains("stripe-pulse")).toBe(false)
    expect(card(LOGIN.id).classList.contains("stripe-pulse")).toBe(false)
  })

  it("keeps the Coordinator card's header in reach and folds its history back with Show less", () => {
    render()
    const head = coordinator().querySelector('[data-testid="bottom-card-head"]')!
    expect(head.className).toContain("sticky")
    expect(coordinator().textContent).toContain("1 earlier")
    expect(host.querySelector('[data-testid="coordinator-fold"]')).toBeNull()
    click(coordinator().querySelector('[data-testid="card-earlier"]')!)
    expect(coordinator().textContent).toContain("Fix login and build the cards")
    click(host.querySelector('[data-testid="coordinator-fold"]')!)
    expect(coordinator().textContent).not.toContain("Fix login and build the cards")
    expect(coordinator().textContent).toContain("1 earlier")
    expect(host.querySelector('[data-testid="coordinator-fold"]')).toBeNull()
  })

  it("Tasks only hides the Coordinator card, remembers it, and sending to the Coordinator shows it again", async () => {
    render()
    const toggle = () => host.querySelector('[data-testid="tasks-only"]') as HTMLElement
    click(toggle())
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    expect(coordinator()).toBeNull()
    expect(localStorage.getItem("boxyard:cards-tasks-only")).toBe("1")
    click(host.querySelector('[data-testid="coordinator-hidden"]')!)
    expect(coordinator()).not.toBeNull()
    expect(toggle().getAttribute("aria-pressed")).toBe("false")

    click(toggle())
    const textarea = host.querySelector("textarea")!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea, "What's next?")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(coordinator()).not.toBeNull()
    // A project keeps its own choice: hiding the Coordinator card doesn't hide its Captain's.
    click(toggle())
    act(() => setChatProjectFilter(MAP.id))
    expect(toggle().getAttribute("aria-pressed")).toBe("false")
    expect(toggle().getAttribute("aria-label")).toBe("Tasks only: hide the Captain card")
    expect(host.querySelector('[data-testid="captain-card"]')).not.toBeNull()
  })
})

/** EventSource stand-in: `emit` delivers a server event as the stream would. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: unknown = null
  onopen: unknown = null
  constructor() {
    FakeEventSource.last = this
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("Mark done is instant", () => {
  let posts: string[]
  /** The answers the test hands out: the close's and /api/tasks'. */
  let answerClose: (res: Response) => void
  let answerTasks: ((res: Response) => void) | null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    posts = []
    answerTasks = null
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url)
      if (url.endsWith("/close")) return new Promise<Response>((r) => (answerClose = r))
      if (url === "/api/tasks") return new Promise<Response>((r) => (answerTasks = r))
      return new Promise(() => {})
    })
  })
  afterEach(() => {
    act(() => {
      for (const t of TASKS) undoClose(t.id)
      for (const t of currentToasts()) dismiss(t.id)
    })
    resetClosedTasks()
    vi.useRealTimers()
  })

  function Live() {
    useServerEvents(true)
    return null
  }
  const renderLive = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ChatPanel), createElement(Live))))
  const live = () => cards().map((c) => c.dataset.card)
  const cached = (id: string) => qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === id)!
  /** Time passes (the undo window, a batch of SSE events, the cache's notify timer). */
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
  const sse = (t: Task) =>
    act(async () => {
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: "task", task: t }) })
      await vi.advanceTimersByTimeAsync(300)
    })

  it("drops the card at the click, before the close goes out, and keeps it gone through a slow answer, late updates and a stale refetch", async () => {
    renderLive()
    expect(live()).toContain(CARDS.id)
    click(card(CARDS.id).querySelector('[data-testid="chat-card-check"]')!)
    // Gone at once, and done in the cache, so every list, count and badge drops it too; nothing has been sent.
    expect(live()).not.toContain(CARDS.id)
    expect(cached(CARDS.id).status).toBe("done")
    expect(posts).toEqual([])

    // An update the server sent before the close arrives late: the card stays gone.
    await sse({ ...CARDS, status: "pr_ready", updatedAt: 5 })
    expect(live()).not.toContain(CARDS.id)
    // A refetch (a reconnect) starts before the close and answers after it.
    void qc.refetchQueries({ queryKey: keys.tasks })
    await wait(0)
    const stale = answerTasks!

    // The undo window ends: the close goes out, and takes its time.
    await wait(5000)
    expect(posts).toEqual([`/api/tasks/${CARDS.id}/close`])
    await wait(3000)
    expect(live()).not.toContain(CARDS.id)

    await act(async () => {
      answerClose(json({ ...CARDS, status: "done", updatedAt: 10 }))
      await vi.advanceTimersByTimeAsync(10)
    })
    await act(async () => {
      stale(json(TASKS.map((t) => (t.id === CARDS.id ? { ...t, updatedAt: 5 } : t))))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(cached(CARDS.id).status).toBe("done")
    expect(live()).not.toContain(CARDS.id)
    await sse({ ...CARDS, status: "pr_ready", updatedAt: 10 })
    expect(live()).not.toContain(CARDS.id)

    // Messaged after the close, it's back at work: that's news, and its card is back.
    await sse({ ...CARDS, status: "queued", updatedAt: 20 })
    expect(cached(CARDS.id).status).toBe("queued")
    expect(live()).toContain(CARDS.id)
  })

  it("brings the card back with a toast when the close fails", async () => {
    renderLive()
    click(card(CARDS.id).querySelector('[data-testid="chat-card-check"]')!)
    expect(live()).not.toContain(CARDS.id)
    await wait(5000)
    expect(posts).toEqual([`/api/tasks/${CARDS.id}/close`])
    await act(async () => {
      answerClose(json({ error: "The box is gone" }, 500))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(cached(CARDS.id).status).toBe("pr_ready")
    expect(live()).toContain(CARDS.id)
    expect(currentToasts().map((t) => t.title)).toContain("Couldn't close the task")
  })

  it("Undo puts the task back as it was and sends nothing", async () => {
    renderLive()
    click(card(CARDS.id).querySelector('[data-testid="chat-card-check"]')!)
    expect(cached(CARDS.id).status).toBe("done")
    act(() => currentToasts().at(-1)!.action!.onClick())
    expect(cached(CARDS.id).status).toBe("pr_ready")
    expect(live()).toContain(CARDS.id)
    await wait(6000)
    expect(posts).toEqual([])
  })
})
