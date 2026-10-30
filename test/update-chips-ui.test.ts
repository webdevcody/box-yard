// @vitest-environment happy-dom
// The Coordinator chat's update chips (components/UpdateChips.tsx): collapsed by default, open in place, attention
// cards that never fold, the reply's "from:" line, per-session state, and no thread-wide re-renders. A card lists its
// entries the same way (CardEntries in CoordinatorCards.tsx): a chip per update, a ChatLine per message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { keys } from "../web/src/lib/queries.js"
import { REVEAL_CHAT_EVENT } from "../web/src/lib/reveal.js"
import { resetChipState } from "../web/src/lib/chipState.js"
import type { ChatMessage, Project } from "../shared/types.js"

// Count renders: NoticeChip reads chipView on every render, a reply reads nextStepsFromMeta.
const renders = vi.hoisted(() => ({ chips: new Map<string, number>(), replies: 0 }))
vi.mock("../web/src/lib/chatUpdates.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../web/src/lib/chatUpdates.js")>()
  return { ...mod, chipView: (m: ChatMessage) => (renders.chips.set(m.id, (renders.chips.get(m.id) ?? 0) + 1), mod.chipView(m)) }
})
vi.mock("../web/src/components/RecommendedNextSteps.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../web/src/components/RecommendedNextSteps.js")>()
  return { ...mod, nextStepsFromMeta: (meta: unknown) => (renders.replies++, mod.nextStepsFromMeta(meta as never)) }
})

const { UpdateChip, useCoordinatorRows } = await import("../web/src/components/UpdateChips.js")
const { ChatLine } = await import("../web/src/components/ChatLine.js")

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let setThread: (m: ChatMessage[]) => void = () => {}

const project = { id: "prj_boxyard1", name: "box-yard", repo: "webdevcody/box-yard" } as Project

let t = 0
const msg = (id: string, role: ChatMessage["role"], content: string, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt: ++t })
const captain = (id: string, text: string) => msg(id, "notice", `Captain for box-yard replied: ${text}`, { projectId: project.id, captain: true })
const done = (id: string, title = "Fix login") => msg(id, "notice", `✅ **${title}** is done: Fixed the redirect.`, { taskId: `task_${id}00` })
const asks = (id: string) => msg(id, "notice", "🙋 **Pick a colour** needs you: Red or blue?", { taskId: `task_${id}00` })

const onFollowUp = () => {}

function Thread({ initial }: { initial: ChatMessage[] }) {
  const [messages, set] = useState(initial)
  setThread = set
  const rows = useCoordinatorRows(messages)
  const newest = rows.findLast((r) => r.type === "message" && r.message.role === "assistant")?.id
  return rows.flatMap((r) =>
    r.type === "message"
      ? [createElement(ChatLine, { key: r.id, m: r.message, sources: r.sources, onFollowUp, next: r.id === newest })]
      : (r.type === "update" ? [r.item] : r.items).map((item) => createElement(UpdateChip, { key: item.id, item })),
  )
}

const render = (messages: ChatMessage[]) =>
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Thread, { initial: messages }))))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const $ = (sel: string) => host.querySelector<HTMLElement>(sel)
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)]

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  resetChipState()
  renders.chips.clear()
  renders.replies = 0
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes, keys.tasks]) qc.setQueryData(k, [])
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

describe("update chips", () => {
  it("a Captain's reply is one collapsed line that opens its full text in place", () => {
    render([captain("c1", "I've sent **the request** to the side-threads task.")])
    const chip = $('[data-testid="update-chip"]')!
    expect(chip.id).toBe("chat-c1")
    const line = chip.querySelector('[data-testid="update-chip-line"]')!
    expect(line.textContent).toContain("box-yard Captain")
    expect(line.textContent).toContain("replied")
    expect(line.getAttribute("aria-expanded")).toBe("false")
    expect(line.querySelector('a[href="/projects/prj_boxyard1?tab=captain"]')).not.toBeNull()
    expect($('[data-testid="update-chip-body"]')).toBeNull()
    click(line)
    expect(line.getAttribute("aria-expanded")).toBe("true")
    const body = $('[data-testid="update-chip-body"]')!
    expect(body.querySelector("strong")?.textContent).toBe("the request")
    expect(body.textContent).not.toContain("Captain for box-yard replied")
    // The #157 toolbar is on the chip.
    expect(chip.querySelector('[data-testid="message-copy"]')).not.toBeNull()
    click(line)
    expect($('[data-testid="update-chip-body"]')).toBeNull()
  })

  it("clicking the chip's link doesn't toggle it", () => {
    render([done("d1")])
    const link = $('[data-testid="update-chip-line"] a')!
    expect(link.getAttribute("href")).toBe("/tasks/task_d100")
    click(link)
    expect($('[data-testid="update-chip-line"]')!.getAttribute("aria-expanded")).toBe("false")
  })

  it("questions, failures and merge requests stay full cards with an accent", () => {
    render([done("d1"), asks("q1"), msg("f1", "notice", "❌ **Build** failed: tsc exited 2", { taskId: "task_f100" })])
    const cards = $$('[data-testid="notice-card"]')
    expect(cards.map((c) => c.dataset.attention)).toEqual(["needs_input", "failed"])
    expect(cards[0]!.textContent).toContain("Red or blue?")
    expect($$('[data-testid="update-chip"]')).toHaveLength(1)
  })

  it("remembers what's open for the session", () => {
    render([captain("c1", "a")])
    click($('[data-testid="update-chip-line"]')!)
    expect(JSON.parse(sessionStorage.getItem("boxyard:chat-open")!)).toEqual(["c1"])
    act(() => root.unmount())
    root = createRoot(host)
    render([captain("c1", "a")])
    expect($('[data-testid="update-chip-line"]')!.getAttribute("aria-expanded")).toBe("true")
  })

  it("an open chip stays open when another update comes in after it", () => {
    const c1 = captain("c1", "a")
    render([c1])
    click($('[data-testid="update-chip-line"]')!)
    act(() => setThread([c1, done("d1")]))
    expect($("#chat-c1 [data-testid='update-chip-body']")).not.toBeNull()
    expect($("#chat-d1 [data-testid='update-chip-body']")).toBeNull()
  })
})

describe("the reply's from: line", () => {
  it("names the updates the reply read and opens them, scrolling to the first", () => {
    const reveals: string[] = []
    const onReveal = (e: Event) => reveals.push((e as CustomEvent<string>).detail)
    window.addEventListener(REVEAL_CHAT_EVENT, onReveal)
    render([captain("c1", "a"), msg("w1", "notice", "⚠️ Boxes are busy."), done("d1"), msg("r1", "assistant", "The Captain sent it on.")])
    const from = $('[data-testid="chat-reply"] [data-testid="reply-sources"]')!
    // The task notice went to its Captain, not the Coordinator, so the reply didn't read it.
    expect(from.textContent).toBe("from:box-yard Captain · Warning")
    expect(from.getAttribute("aria-expanded")).toBe("false")
    click(from)
    expect(from.getAttribute("aria-expanded")).toBe("true")
    expect(reveals).toEqual(["c1"])
    expect($$('[data-testid="update-chip"][data-open]').map((c) => c.id)).toEqual(["chat-c1", "chat-w1"])
    click(from)
    expect(from.getAttribute("aria-expanded")).toBe("false")
    expect($$('[data-testid="update-chip"][data-open]')).toHaveLength(0)
    window.removeEventListener(REVEAL_CHAT_EVENT, onReveal)
  })

  it("a reply with no updates before it has no from: line", () => {
    render([msg("u1", "user", "hi"), msg("r1", "assistant", "Hello.")])
    expect($('[data-testid="reply-sources"]')).toBeNull()
  })
})

describe("next steps", () => {
  it("shows only under the newest reply", () => {
    const next = (id: string, step: string) => msg(id, "assistant", "Done.", { nextSteps: [step] })
    render([next("r1", "Open the PR"), captain("c1", "a"), next("r2", "Check Map 3")])
    const steps = () => $$('[aria-label="Recommended next steps"]').map((s) => s.closest('[data-testid="chat-reply"]')!.id)
    expect(steps()).toEqual(["chat-r2"])
    act(() => setThread([next("r1", "Open the PR"), captain("c1", "a"), next("r2", "Check Map 3"), next("r3", "Ship it")]))
    expect(steps()).toEqual(["chat-r3"])
  })
})

describe("re-renders", () => {
  it("opening a chip or a new message re-renders only what changed", async () => {
    const thread = [captain("c1", "a"), msg("r1", "assistant", "Sent."), captain("c2", "b"), msg("r2", "assistant", "Done.")]
    render(thread)
    // Only the newest reply reads its next steps (the older one's are for a moment that has passed), so the counter
    // sees r2's renders: a thread-wide re-render would re-render it too.
    expect(renders.replies).toBe(1)
    renders.chips.clear()
    renders.replies = 0
    await act(async () => void $("#chat-c2 [data-testid='update-chip-line']")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
    expect(Object.fromEntries(renders.chips)).toEqual({ c2: 1 })
    expect(renders.replies).toBe(0)
    renders.chips.clear()
    await act(async () => setThread([...thread, captain("c3", "c")]))
    expect(Object.fromEntries(renders.chips)).toEqual({ c3: 1 })
    expect(renders.replies).toBe(0)
  })
})
