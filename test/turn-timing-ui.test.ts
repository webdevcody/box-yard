// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { Line } from "../web/src/components/TaskView.js"
import type { TurnTiming } from "../shared/turnTimings"
import type { ChatMessage, TaskMessage } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TIMING: TurnTiming = {
  id: "tim_abc",
  role: "captain",
  kind: "turn",
  projectId: "prj_a",
  taskId: null,
  sessionId: "s1",
  model: "claude-opus-5-5",
  effort: "medium",
  trigger: "coordinator",
  resumed: true,
  requestedAt: 1000,
  queueMs: 4100,
  setupMs: null,
  startedAt: 5100,
  endedAt: 13_500,
  startupMs: 420,
  mcpStatus: "boxyard: connected",
  processMs: 330,
  mcpMs: 60,
  firstTokenMs: 2600,
  modelMs: 6100,
  toolMs: 1200,
  modelCalls: 3,
  toolCalls: 2,
  tailMs: 640,
  wallMs: 8400,
  cliMs: 7700,
  apiMs: 6000,
  numTurns: 3,
  inputTokens: 12,
  outputTokens: 900,
  cacheReadTokens: 180_000,
  cacheWriteTokens: 6_000,
  contextTokens: 64_000,
  totalMs: 12_500,
  ok: true,
  steps: [
    { k: "model", at: 420, ms: 3000 },
    { k: "tool", name: "list_tasks", at: 3420, ms: 300 },
    { k: "tool", name: "Bash", at: 3420, ms: 1200 },
    { k: "model", at: 4620, ms: 3100 },
  ],
  stepsDropped: 0,
}

const requests: string[] = []
let root: Root
let host: HTMLElement

function render(el: ReturnType<typeof createElement>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
}

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/turn-timings")) requests.push(url)
    if (url === "/api/turn-timings/tim_abc") return new Response(JSON.stringify(TIMING), { status: 200 })
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
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

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const chip = () => host.querySelector<HTMLButtonElement>("[data-testid=turn-timing]")
const popover = () => document.querySelector("[data-testid=turn-timing-popover]")

const reply = (meta: Record<string, unknown> | null): ChatMessage => ({ id: "chat_1", role: "assistant", content: "All good.", meta, createdAt: Date.now() })

describe("turn timing chip", () => {
  it("shows a reply's total and fetches its stages only when opened", async () => {
    render(createElement(ChatLine, { m: reply({ timingId: "tim_abc", timingMs: 12_500 }), onFollowUp: () => {} }))
    expect(chip()!.textContent).toBe("13 s")
    expect(requests).toEqual([])
    await click(chip()!)
    await settle()
    expect(requests).toEqual(["/api/turn-timings/tim_abc"])
    expect(chip()!.getAttribute("aria-expanded")).toBe("true")
    const p = popover()!
    const text = p.textContent!
    expect(text).toContain("Captain turn · from coordinator · claude-opus-5-5 · medium effort")
    for (const s of ["Queue4.1 s", "Start-up", "process 330 ms · MCP 60 ms · resumed", "First token2.6 s", "3 calls · API 6.0 s", "2 calls · slowest Bash 1.2 s", "Tail640 ms", "Total13 s"]) expect(text).toContain(s)
    // No setup row for a Captain turn.
    expect(text).not.toContain("Setup")
    expect(p.querySelector("[data-testid=timing-tokens]")!.textContent).toBe("in 12out 900cache read 180kcache write 6kcontext 64k")
    expect(p.querySelectorAll("[data-testid=timing-bar] > div")).toHaveLength(5)
    // A press elsewhere closes it.
    await act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).toBeNull()
  })

  it("is absent from replies without a timing, and says so when a timing is gone", async () => {
    render(createElement(ChatLine, { m: reply(null), onFollowUp: () => {} }))
    expect(chip()).toBeNull()
    render(createElement(ChatLine, { m: reply({ timingId: "tim_gone" }), onFollowUp: () => {} }))
    expect(chip()!.textContent).toBe("timing")
    await click(chip()!)
    await settle()
    expect(popover()!.textContent).toContain("Couldn't load this turn's timing")
  })

  it("sits on a task's Turn N finished line", () => {
    const m: TaskMessage = { id: "msg_1", taskId: "task_1", role: "event", content: "Turn 2 finished.", meta: { timingId: "tim_abc", timingMs: 95_000 }, createdAt: Date.now() } as TaskMessage
    render(createElement(Line, { m, onFollowUp: () => {} }))
    expect(host.textContent).toContain("Turn 2 finished.")
    expect(chip()!.textContent).toBe("1 min 35 s")
  })
})
