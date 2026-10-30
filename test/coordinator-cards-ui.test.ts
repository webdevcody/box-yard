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
import { COORDINATOR_CHAT, closeThread, forgetThread, openThread, openThreadId } from "../web/src/lib/threads.js"
import type { ChatMessage, Project, Task, TaskStatus } from "../shared/types.js"

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
  const setBusy = (busy: boolean) =>
    act(async () => {
      qc.setQueryData(keys.chatBusy, busy)
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

  it("asks the Coordinator about the task instead, and the question waits for its answer in the card", async () => {
    render()
    click(head(CARDS.id))
    expect(composer(card(CARDS.id)).querySelector("textarea")!.placeholder).toBe("Reply to this task…")
    click(button(composer(card(CARDS.id)), "Coordinator"))
    const box = composer(card(CARDS.id))
    expect(box.dataset.to).toBe("coordinator")
    expect(box.querySelector("textarea")!.placeholder).toBe("Ask the Coordinator about this…")
    expect(box.querySelector('[data-testid="card-composer-hint"]')!.textContent).toBe("Goes to the Coordinator, with this task as context")
    await send(card(CARDS.id), "Is it blocking anything?")
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe("/api/chat")
    expect(posts[0]!.body).toMatchObject({ content: "Is it blocking anything?", about: [CARDS.id] })

    // It shows in the card at once, not in the Coordinator card.
    const body = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    expect(body.textContent).toContain("Is it blocking anything?")
    expect(body.querySelector('[data-testid="sent-from"]')!.textContent).toBe("to the Coordinator")
    expect(coordinator().textContent).not.toContain("Is it blocking anything?")
    expect(body.querySelector('[data-testid="card-working"]')!.textContent).toBe("The Coordinator is working")
    await setBusy(false)
    expect(body.querySelector('[data-testid="card-working"]')).toBeNull()

    // The choice holds when the card closes and opens again.
    click(head(CARDS.id))
    click(head(CARDS.id))
    expect(composer(card(CARDS.id)).dataset.to).toBe("coordinator")
  })

  it("shows a question queued mid-turn in its card, and the Timeline says what it's about", async () => {
    qc.setQueryData(keys.chatBusy, true)
    const queued = msg("user", "Can it wait?", { about: [CARDS.id], queued: true })
    qc.setQueryData(keys.chat, [...CHAT, queued])
    render()
    click(head(CARDS.id))
    const body = card(CARDS.id).querySelector('[data-testid="chat-card-body"]')!
    expect(body.textContent).toContain("Can it wait?")
    expect(body.querySelector('[data-testid="card-working"]')!.textContent).toBe("The Coordinator is working")
    expect(coordinator().textContent).not.toContain("Can it wait?")
    click(viewButton("Timeline"))
    const label = [...host.querySelectorAll('[data-testid="sent-from"]')].map((l) => l.textContent)
    expect(label).toEqual(["aboutCoordinator cards·Open card ›"])
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
    expect(posts[1]!.body).toMatchObject({ content: "How far along is the batch?", about: [CAMP.id, HOLLOW.id, DAM.id] })
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
    expect(box.dataset.to).toBe("task")
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

  it("opens from an open card's footer, and stays open in the Timeline", () => {
    render()
    click(head(CARDS.id))
    click(button(card(CARDS.id), "Open in panel"))
    expect(panel()!.dataset.card).toBe(CARDS.id)
    click(viewButton("Timeline"))
    expect(host.querySelector('[data-testid="chat-cards"]')).toBeNull()
    expect(panel()!.querySelector('[data-testid="card-panel-title"]')!.textContent).toBe("Coordinator cards")
    expect(panel()!.textContent).toContain("opened PR #9")
  })

  it("shows a batch with its tasks' rows and a box to the Coordinator, and no Mark done or task page", () => {
    render()
    click(expand(`batch:${B}`))
    const p = panel()!
    expect(p.querySelector('[data-testid="card-panel-title"]')!.textContent).toBe("Map 3 PR")
    expect(p.querySelectorAll('[data-testid="batch-task"]')).toHaveLength(3)
    // Its updates are under its rows, so no "No updates yet".
    expect(p.querySelector('[data-testid="card-panel-divider"]')).toBeNull()
    expect((p.querySelector('[data-testid="card-composer"]') as HTMLElement).dataset.to).toBe("coordinator")
    expect(p.querySelector('[data-testid="card-panel-done"]')).toBeNull()
    expect(menu(p)).toEqual(["Show in timeline", "Show its card"])
  })

  it("has the thread panel's ⋯: Show in timeline, Open the task page and Show its card", () => {
    render()
    click(expand(LOGIN.id))
    expect(menu(panel()!)).toEqual(["Show in timeline", "Open the task page", "Show its card"])
  })

  it("stops its task's agent from ⋯ while it works", async () => {
    render()
    await act(async () => {
      qc.setQueryData(keys.tasks, TASKS.map((t) => (t.id === LOGIN.id ? { ...t, status: "working" as const } : t)))
      await new Promise((r) => setTimeout(r, 0))
    })
    click(expand(LOGIN.id))
    const items = menu(panel()!)
    expect(items).toEqual(["Show in timeline", "Open the task page", "Stop answering", "Show its card"])
    click(menuItem("Stop answering"))
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(posts.map((x) => x.url)).toEqual([`/api/tasks/${LOGIN.id}/stop`])
  })

  it("Show its card goes back to the Cards view, opens the card and scrolls to it", async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.id.startsWith("card-")) scrolled.push(this.id)
    })
    render()
    click(expand(CARDS.id))
    click(viewButton("Timeline"))
    expect(host.querySelector('[data-testid="chat-cards"]')).toBeNull()
    menu(panel()!)
    click(menuItem("Show its card"))
    await act(async () => await new Promise((r) => setTimeout(r, 50)))
    expect(host.querySelector('[data-testid="chat-cards"]')).not.toBeNull()
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
