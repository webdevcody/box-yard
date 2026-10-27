// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { Line } from "../web/src/components/TaskView.js"
import { SelectionToTask } from "../web/src/components/SelectionToTask.js"
import { quotePreview } from "../web/src/components/NewTask.js"
import { quoteLines } from "../web/src/components/MessageActions.js"
import { keys } from "../web/src/lib/queries.js"
import type { SelectionTaskSource } from "../web/src/lib/selectionTask.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, SettingsInfo, TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_alpha1", name: "alpha", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const ALPHA = { id: "prj_alpha1", name: "alpha" }
const ORCH: SelectionTaskSource = { kind: "orchestrator", project: ALPHA }

/** Longer than the popover's preview (and than the old 12k quote cap), so "the whole message" means something. */
const LONG = ["The retry loop in server/sync.ts never backs off,", "so a dead remote spins the CPU.", ...Array.from({ length: 400 }, (_, i) => `Line ${i + 1}: ${"detail ".repeat(5)}`), "THE END"].join("\n")

let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada", agentModel: "claude-opus-5-5", agentEffort: "high" } } as unknown as SettingsInfo)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const inChat = (source: SelectionTaskSource | null, onPrompt: (p: string) => void, ...children: ReactNode[]) =>
  render(createElement(SelectionToTask, { source, onPrompt }, createElement("div", null, ...children)))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const press = (el: Element, key: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })))
const popover = () => document.querySelector<HTMLElement>("[role=dialog]:not([aria-modal])")
const modal = () => document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]")
const toolbars = () => [...host.querySelectorAll<HTMLElement>("[data-message-actions]")]
const respondIn = (el: Element) => el.querySelector<HTMLButtonElement>("[data-testid=message-respond]")!

const chat = (id: string, role: ChatMessage["role"], content: string, meta: ChatMessage["meta"] = null): ChatMessage => ({ id, role, content, meta, createdAt: 1 })
const line = (m: ChatMessage) => createElement(ChatLine, { key: m.id, m, onFollowUp: () => {} })

describe("the message toolbar", () => {
  it("is on every Coordinator message type but not on tool rows", () => {
    inChat(
      ORCH,
      () => {},
      line(chat("chat_reply0001", "assistant", "A **reply**")),
      line(chat("chat_user00001", "user", "My question")),
      line(chat("chat_sched0001", "user", "Nightly check", { scheduleId: "sch_x" })),
      line(chat("chat_notice001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" })),
      line(chat("chat_error0001", "error", "Coordinator crashed")),
      line(chat("chat_tool00001", "tool", "list_tasks", { input: {} })),
    )
    const bars = toolbars()
    expect(bars).toHaveLength(5)
    for (const bar of bars) {
      expect(bar.getAttribute("role")).toBe("toolbar")
      // Respond first, then Copy and More, each labelled and with a tooltip.
      const buttons = [...bar.querySelectorAll("button")]
      expect(buttons.map((b) => b.dataset.testid)).toEqual(["message-respond", "message-copy", "message-more"])
      for (const b of buttons) {
        expect(b.getAttribute("aria-label")).toBeTruthy()
        expect(b.title).toBeTruthy()
      }
    }
    expect(host.querySelector("[data-testid=chat-reply] [data-message-actions]")).not.toBeNull()
  })

  it("Respond opens the New task popover on the whole message: a short preview, the full text sent", () => {
    const onPrompt = vi.fn()
    inChat(ORCH, onPrompt, line(chat("chat_reply0001", "assistant", LONG)))
    const button = respondIn(host)
    click(button)
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("New task from message")
    expect(dialog.querySelector("[data-testid=selection-quote]")!.textContent).toBe(quotePreview(LONG))
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(toolbars()[0]!.hasAttribute("data-open")).toBe(true)
    // Focus goes to the popover's own box, never the chat's composer.
    expect(document.activeElement).toBe(dialog.querySelector("textarea"))

    press(dialog.querySelector("textarea")!, "Enter")
    expect(onPrompt).toHaveBeenCalledTimes(1)
    const prompt: string = onPrompt.mock.calls[0]![0]
    expect(prompt).toContain(quoteLines(LONG))
    expect(prompt).toContain("> THE END")
    expect(prompt).not.toContain("truncated")
    expect(popover()).toBeNull()
    expect(button.getAttribute("aria-expanded")).toBe("false")
  })

  it("pressing Respond again closes it; Esc closes it and puts focus back on the button", () => {
    inChat(ORCH, () => {}, line(chat("chat_reply0001", "assistant", "Short reply")))
    const button = respondIn(host)
    click(button)
    expect(popover()).not.toBeNull()
    click(button)
    expect(popover()).toBeNull()
    click(button)
    press(popover()!.querySelector("textarea")!, "Escape")
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(toolbars()[0]!.hasAttribute("data-open")).toBe(false)
  })

  it("Respond on another message moves the popover to that message", () => {
    inChat(ORCH, () => {}, line(chat("chat_reply0001", "assistant", "First reply")), line(chat("chat_reply0002", "assistant", "Second reply")))
    const [a, b] = toolbars().map(respondIn)
    click(a!)
    act(() => void b!.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    click(b!)
    expect(popover()!.querySelector("[data-testid=selection-quote]")!.textContent).toBe("Second reply")
    expect(a!.getAttribute("aria-expanded")).toBe("false")
    expect(b!.getAttribute("aria-expanded")).toBe("true")
  })

  it("Respond on a task notice doesn't open the task", () => {
    inChat(ORCH, () => {}, line(chat("chat_notice001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" })))
    click(respondIn(host))
    expect(location.pathname).toBe("/")
    expect(popover()!.querySelector("[data-testid=selection-quote]")!.textContent).toBe(quotePreview("✅ **Fix sync** finished: opened a PR"))
  })

  it("Copy copies the message; the ··· menu copies it as a quote or opens the full New task dialog", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    inChat(ORCH, () => {}, line(chat("chat_reply0001", "assistant", "Line one\n\nLine two")))
    await act(async () => void host.querySelector<HTMLButtonElement>("[data-testid=message-copy]")!.click())
    expect(writeText).toHaveBeenLastCalledWith("Line one\n\nLine two")
    expect(host.querySelector("[data-testid=message-copy]")!.getAttribute("aria-label")).toBe("Copied")

    const more = host.querySelector<HTMLButtonElement>("[data-testid=message-more]")!
    click(more)
    const items = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")]
    expect(items().map((i) => i.textContent)).toEqual(["New task with all options…", "Copy as quote"])
    await act(async () => void items()[1]!.click())
    expect(writeText).toHaveBeenLastCalledWith("> Line one\n>\n> Line two")
    expect(document.querySelector("[role=menu]")).toBeNull()

    click(more)
    click(items()[0]!)
    const prompt = modal()!.querySelector("textarea")!.value
    expect(prompt).toContain("> Line one")
    expect(prompt).toContain("- Project: alpha (prj_alpha1)")
  })

  it("on touch, a tap on the message shows the toolbar and a tap elsewhere hides it; a tap on a link doesn't", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)", media: q, addEventListener() {}, removeEventListener() {} }))
    inChat(ORCH, () => {}, line(chat("chat_reply0001", "assistant", "See [the docs](https://example.com) for more")), line(chat("chat_reply0002", "assistant", "Other")))
    const [bar, other] = toolbars()
    const reply = host.querySelector("[data-testid=chat-reply]")!
    expect(bar!.hasAttribute("data-open")).toBe(false)
    act(() => void reply.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
    expect(bar!.hasAttribute("data-open")).toBe(false)
    click(reply.querySelector("p")!)
    expect(bar!.hasAttribute("data-open")).toBe(true)
    expect(other!.hasAttribute("data-open")).toBe(false)
    act(() => void other!.parentElement!.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(bar!.hasAttribute("data-open")).toBe(false)
  })

  it("hides a tapped toolbar and closes its ··· menu when the app goes to the background", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)", media: q, addEventListener() {}, removeEventListener() {} }))
    inChat(ORCH, () => {}, line(chat("chat_reply0001", "assistant", "A reply")))
    const bar = toolbars()[0]!
    click(host.querySelector("[data-testid=chat-reply] p")!)
    click(bar.querySelector("[data-testid=message-more]")!)
    expect(document.querySelector("[role=menu]")).not.toBeNull()
    act(() => void window.dispatchEvent(new Event("pagehide")))
    expect(document.querySelector("[role=menu]")).toBeNull()
    expect(bar.hasAttribute("data-open")).toBe(false)
  })

  it("has no Respond where there's nowhere to send it, but still Copy", () => {
    inChat(null, () => {}, line(chat("chat_reply0001", "assistant", "A reply")))
    expect(host.querySelector("[data-testid=message-respond]")).toBeNull()
    expect(host.querySelector("[data-testid=message-copy]")).not.toBeNull()
  })

  it("is on task transcript replies, messages and agent messages, and sends with the task as context", () => {
    const onPrompt = vi.fn()
    const source: SelectionTaskSource = { kind: "task", project: ALPHA, task: { id: "task_sync0001", title: "Fix sync", branch: "fix-sync", prUrl: null } }
    const msg = (id: string, role: TaskMessage["role"], content: string, meta: TaskMessage["meta"] = null) =>
      createElement(Line, { key: id, m: { id, taskId: "task_sync0001", role, content, meta, createdAt: 1 } as TaskMessage, onFollowUp: () => {} })
    inChat(
      source,
      onPrompt,
      msg("msg_user00001", "user", "Please fix sync"),
      msg("msg_reply0001", "assistant", LONG),
      msg("msg_agent0001", "agent", "Heads up from another task", { from: "task_other001", fromTitle: "Other" }),
      msg("msg_tool00001", "tool", "Bash ls"),
      msg("msg_event0001", "event", "Turn finished"),
    )
    expect(toolbars()).toHaveLength(3)
    click(respondIn(toolbars()[1]!))
    press(popover()!.querySelector("textarea")!, "Enter")
    const prompt: string = onPrompt.mock.calls[0]![0]
    expect(prompt).toContain("- Source task: Fix sync (task_sync0001)")
    expect(prompt).toContain(quoteLines(LONG))
  })

  it("is on Captain replies, inbound messages and notices, and a notice row doesn't fold open for it", async () => {
    const msg = (id: string, role: CaptainMessage["role"], content: string, meta: CaptainMessage["meta"], at: number): CaptainMessage => ({ id, projectId: project.id, role, content, meta, createdAt: at })
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [
      msg("cap_coord00001", "user", "What's open?", { source: "coordinator" }, 1),
      msg("cap_reply00001", "assistant", "Two tasks need you.", null, 2),
      msg("cap_notice0001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" }, 3),
      msg("cap_reply00002", "assistant", "Done.", null, 4),
    ])
    qc.setQueryData<CaptainState>(keys.captain(project.id), {
      projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
    } as unknown as CaptainState)
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))
    expect(toolbars()).toHaveLength(4)
    const notice = host.querySelector<HTMLElement>("#captain-cap_notice0001")!
    click(respondIn(notice))
    expect(notice.getAttribute("aria-expanded")).toBe("false")
    press(popover()!.querySelector("textarea")!, "Enter")
    // Sent to this Captain (its chat's submit, a POST to the Captain's messages).
    const posts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/captain/") && (init as RequestInit)?.method === "POST")
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    const body = JSON.parse(String((posts()[0]![1] as RequestInit).body))
    expect(body.content).toContain("- Source: the project Captain's chat output")
    expect(body.content).toContain("> ✅ **Fix sync** finished: opened a PR")
  })
})
