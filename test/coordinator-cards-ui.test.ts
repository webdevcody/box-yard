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
