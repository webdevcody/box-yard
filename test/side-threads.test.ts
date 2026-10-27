import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { forkPoint, sessionLineMeta, summaryContext, threadPrompt } from "../server/sideThreads.js"
import type { ChatMessage } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const msg = (id: string, role: ChatMessage["role"], createdAt: number, meta: Record<string, unknown> | null = null, content = `${role} ${id}`): ChatMessage => ({ id, role, content, meta, createdAt })

describe("side thread storage", () => {
  it("saves threads per chat with their messages, and deletes them with the messages", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const a = store.addChat("assistant", "Coordinator reply")
    const b = store.addCaptainMessage(p.id, "assistant", "Captain reply")
    const coord = store.createSideThread({ projectId: null, anchorId: a.id, quote: "reply", sessionId: "s-1" })
    const cap = store.createSideThread({ projectId: p.id, anchorId: b.id, quote: "Captain", sessionId: "s-2" })
    expect(coord).toMatchObject({ projectId: null, anchorId: a.id, quote: "reply", context: null, busy: false })
    expect(store.listSideThreads(null).map((t) => t.id)).toEqual([coord.id])
    expect(store.listSideThreads(p.id).map((t) => t.id)).toEqual([cap.id])

    store.addSideThreadMessage(coord.id, "user", "What?")
    store.addSideThreadMessage(coord.id, "tool", "get_task", { input: { task: "x" } })
    store.addSideThreadMessage(coord.id, "assistant", "This.")
    expect(store.listSideThreadMessages(coord.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "What?"],
      ["tool", "get_task"],
      ["assistant", "This."],
    ])
    expect(store.listSideThreadMessages(coord.id)[1]!.meta).toEqual({ input: { task: "x" } })

    expect(store.sideThreadSession(coord.id)).toEqual({ sessionId: "s-1", started: false })
    store.startSideThread(coord.id, "fork")
    expect(store.sideThreadSession(coord.id)).toEqual({ sessionId: "s-1", started: true })
    expect(store.getSideThread(coord.id)!.context).toBe("fork")
    store.startSideThread(cap.id, "summary", "s-3")
    expect(store.sideThreadSession(cap.id)).toEqual({ sessionId: "s-3", started: true })

    store.deleteSideThread(coord.id)
    expect(store.getSideThread(coord.id)).toBeNull()
    expect(store.listSideThreadMessages(coord.id)).toEqual([])
    // A project's threads go with the project.
    store.deleteProject(p.id)
    expect(store.getSideThread(cap.id)).toBeNull()
  })

  it("reads a chat up to and including the highlighted message, never after it", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const ids = ["one", "two", "three", "four"].map((t, i) => store.addChat(i % 2 ? "assistant" : "user", t).id)
    const cap = store.addCaptainMessage(p.id, "user", "captain one").id
    store.addCaptainMessage(p.id, "assistant", "captain two")
    expect(store.chatUpTo(null, ids[1]!)!.map((m) => m.content)).toEqual(["one", "two"])
    expect(store.chatUpTo(null, ids[3]!)!.map((m) => m.content)).toEqual(["one", "two", "three", "four"])
    // The newest `limit`, still ending at the highlight.
    expect(store.chatUpTo(null, ids[2]!, 2)!.map((m) => m.content)).toEqual(["two", "three"])
    expect(store.chatUpTo(p.id, cap)!.map((m) => m.content)).toEqual(["captain one"])
    // A message from another chat isn't an anchor.
    expect(store.chatUpTo(p.id, ids[0]!)).toBeNull()
    expect(store.chatUpTo(null, cap)).toBeNull()
  })
})

describe("side thread context", () => {
  const line = (uuid: string, session = "main") => sessionLineMeta({ uuid }, session)

  it("forks at the newest reply at or before the highlight", () => {
    const chat = [msg("u1", "user", 1), msg("a1", "assistant", 2, line("L1")), msg("u2", "user", 3), msg("a2", "assistant", 4, line("L2"))]
    expect(forkPoint(chat, "main", null)).toEqual({ uuid: "L2", atAnchor: true })
    // Highlighting a user message forks at the reply before it; its text goes in the prompt.
    expect(forkPoint(chat.slice(0, 3), "main", null)).toEqual({ uuid: "L1", atAnchor: false })
    expect(forkPoint(chat.slice(0, 1), "main", null)).toBeNull()
  })

  it("falls back to the summary when the fork point is gone", () => {
    const chat = [msg("u1", "user", 1), msg("a1", "assistant", 2, line("L1")), msg("u2", "user", 3), msg("a2", "assistant", 4, line("L2", "old"))]
    // From an earlier session (the chat was reset)...
    expect(forkPoint(chat, "main", null)).toBeNull()
    // ...from before the last compaction...
    expect(forkPoint(chat.slice(0, 2), "main", 2)).toBeNull()
    expect(forkPoint(chat.slice(0, 2), "main", 1)).toEqual({ uuid: "L1", atAnchor: true })
    // ...or a reply that never carried its session line.
    expect(forkPoint([msg("a0", "assistant", 1)], "main", null)).toBeNull()
  })

  it("replays the summary and the messages since it, up to the highlight", () => {
    const chat = [
      msg("u1", "user", 1, null, "before the compaction"),
      msg("u2", "user", 10, null, "after the compaction"),
      msg("a2", "assistant", 11, null, "a reply"),
      msg("t2", "tool", 12, null, "a tool call"),
      msg("x2", "assistant", 13, { cancelled: true }, "a stopped reply"),
      msg("n2", "notice", 14, null, "✅ **Task** finished"),
    ]
    const text = summaryContext(chat, { at: 5, markdown: "---\nat: 5\n---\n# Summary\nThe summary body." }, "Sam")
    expect(text).toContain("The summary body.")
    expect(text).not.toContain("at: 5")
    expect(text).not.toContain("before the compaction")
    expect(text).toContain("[Sam] after the compaction")
    expect(text).toContain("[You] a reply")
    expect(text).toContain("[Box Yard update] ✅ **Task** finished")
    expect(text).not.toContain("a tool call")
    expect(text).not.toContain("a stopped reply")
    // No compaction before the highlight: the whole conversation up to it.
    expect(summaryContext(chat.slice(0, 2), null)).toContain("before the compaction")
  })

  it("asks with the highlight, the read-only rule and the question", () => {
    const prompt = threadPrompt({ quote: "line one\nline two", question: "Why?", anchorText: null, context: null, ownerName: "Sam" })
    expect(prompt.startsWith("[Box Yard side thread]")).toBe(true)
    expect(prompt).toContain("> line one\n> line two")
    expect(prompt).toContain("read-only")
    expect(prompt).toMatch(/Sam's question:\nWhy\?$/)
    expect(prompt).not.toContain("started fresh")
    expect(threadPrompt({ quote: "q", question: "Why?", anchorText: "the user message", context: "the summary", ownerName: "Sam" })).toContain("started fresh, from your notes.]\n\nthe summary")
  })
})
