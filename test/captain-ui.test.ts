// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { keys } from "../web/src/lib/queries.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_demo01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  // Nothing here should need the server; leave any request pending.
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const tool = (content: string, meta: Record<string, unknown>): ChatMessage => ({ id: `chat_${content}`, role: "tool", content, meta, createdAt: Date.now() })

describe("Captain tool lines in the Coordinator chat", () => {
  it("link the project's Captain tab and expand to the message sent and the Captain's reply", () => {
    const m = tool("ask_captain", { input: { project: "demo", message: "What's **open**?" }, captain: { projectId: "prj_demo01", reply: "Two tasks need you.", finished: true } })
    render(createElement(ChatLine, { m, onFollowUp: () => {} }))
    const link = host.querySelector<HTMLAnchorElement>('a[href="/projects/prj_demo01?tab=captain"]')
    expect(link?.textContent).toBe("demo Captain")
    expect(host.textContent).not.toContain("Sent to the Captain")

    click(host.querySelector('[data-testid="captain-tool"] [role="button"]')!)
    expect(host.textContent).toContain("Sent to the Captain")
    // The full message, through the markdown renderer.
    expect(host.querySelector("strong")?.textContent).toBe("open")
    expect(host.textContent).toContain("Captain replied")
    expect(host.textContent).toContain("Two tasks need you.")
  })

  it("show no reply section for send_to_captain, and say when wait_for_captain gave up early", () => {
    render(
      createElement("div", null,
        createElement(ChatLine, { m: tool("send_to_captain", { input: { project: "prj_demo01", message: "Ship it" }, captain: { projectId: "prj_demo01", reply: null, finished: null } }), onFollowUp: () => {} }),
        createElement(ChatLine, { m: tool("wait_for_captain", { input: { project: "demo" }, captain: { projectId: "prj_demo01", reply: "Still building", finished: false } }), onFollowUp: () => {} }),
      ),
    )
    for (const row of host.querySelectorAll('[data-testid="captain-tool"] [role="button"]')) click(row)
    const [send, wait] = [...host.querySelectorAll('[data-testid="captain-tool"]')]
    expect(send!.textContent).toContain("Ship it")
    expect(send!.textContent).not.toContain("Captain replied")
    expect(wait!.textContent).toContain("Captain replied (still working)")
    expect(wait!.textContent).toContain("Still building")
  })
})

describe("Captain tab inbound messages", () => {
  it("labels each message to the Captain by sender and folds long ones", () => {
    const msg = (id: string, content: string, meta: Record<string, unknown> | null, at: number): CaptainMessage => ({ id, projectId: project.id, role: "user", content, meta, createdAt: at })
    const long = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: do the thing`).join("\n")
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [
      msg("cap_coord00001", long, { source: "coordinator", tool: "ask_captain" }, 1),
      msg("chat_cody00000001", "Please **retry** the build", { source: "cody" }, 2),
      msg("cap_legacy0001", "Older order without a source", null, 3),
      msg("cap_sched00001", "Nightly check", { source: "schedule" }, 4),
    ])
    qc.setQueryData<CaptainState>(keys.captain(project.id), {
      projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
    })
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="captain-inbound"]')]
    expect(rows.map((r) => r.dataset.source)).toEqual(["coordinator", "cody", "coordinator", "schedule"])
    expect(rows[0]!.textContent).toContain("From Coordinator")
    expect(rows[0]!.textContent).toContain("ask_captain")
    expect(rows[1]!.textContent).toContain("You")
    expect(rows[1]!.querySelector("strong")?.textContent).toBe("retry")
    expect(rows[3]!.textContent).toContain("Scheduled")

    const more = [...rows[0]!.querySelectorAll("button")].find((b) => b.textContent === "Show more")!
    expect(more).toBeTruthy()
    click(more)
    expect(rows[0]!.textContent).toContain("Show less")
    expect(rows[0]!.textContent).toContain("Step 30: do the thing")
  })
})

describe("Captain tab: an agent's message_captain", () => {
  it("says which task sent it, links the task, and shows a waiting or held agent", () => {
    const msg = (id: string, content: string, meta: Record<string, unknown>, at: number): CaptainMessage => ({ id, projectId: project.id, role: "user", content, meta, createdAt: at })
    const agent = { source: "agent", tool: "message_captain", taskId: "task_abc123def", taskTitle: "Fix login" }
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [
      msg("cap_agent00001", "Is the admin page in scope?", { ...agent, waitSeconds: 30 }, 1),
      msg("cap_agent00002", "FYI: signup crashes too", { ...agent, waitSeconds: 0 }, 2),
      msg("cap_agent00003", "Same again", { ...agent, waitSeconds: 0, heldUntil: Date.now() + 60_000 }, 3),
    ])
    qc.setQueryData<CaptainState>(keys.captain(project.id), {
      projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
    })
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="captain-inbound"]')]
    expect(rows.map((r) => r.dataset.source)).toEqual(["agent", "agent", "agent"])
    expect(rows[0]!.textContent).toContain("From task")
    expect(rows[0]!.textContent).toContain("Fix login")
    expect(rows[0]!.textContent).toContain("message_captain")
    expect(rows[0]!.textContent).toContain("waits 30s")
    expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe("/tasks/task_abc123def")
    expect(rows[1]!.textContent).not.toContain("waits")
    expect(rows[2]!.textContent).toContain("held by loop guard")
  })
})
