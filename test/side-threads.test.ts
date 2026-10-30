import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { forkPoint, noticeLines, replyPrompt, sessionLineMeta, summaryContext, taskThreadPrompt, threadPrompt } from "../server/sideThreads.js"
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

describe("task threads", () => {
  it("are one per card, and find a card's tasks and their updates in the chat", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const a = store.createTask({ projectId: p.id, title: "Level 1", prompt: "x", batchId: "bat_1" })
    const b = store.createTask({ projectId: p.id, title: "Level 2", prompt: "x", batchId: "bat_1" })
    const c = store.createTask({ projectId: p.id, title: "Other", prompt: "x" })
    expect(store.tasksInBatch("bat_1").map((t) => t.id)).toEqual([a.id, b.id])
    expect(store.tasksInBatch("bat_none")).toEqual([])

    const t = store.createSideThread({ projectId: null, anchorId: a.id, quote: "Level 1", sessionId: "s-1", kind: "task" })
    expect(t.kind).toBe("task")
    expect(store.threadOn(null, a.id, "task")!.id).toBe(t.id)
    // A message's reply thread and a card's thread don't mix.
    expect(store.threadOn(null, a.id, "reply")).toBeNull()

    store.addChat("notice", "✅ **Level 1** is done", { taskId: a.id })
    store.addChat("notice", "✅ **Other** is done", { taskId: c.id })
    store.addChat("assistant", "Both done.")
    store.addChat("notice", "🚧 **Level 2** is working", { taskId: b.id })
    expect(store.taskNotices([a.id]).map((m) => m.content)).toEqual(["✅ **Level 1** is done"])
    expect(store.taskNotices([a.id, b.id]).map((m) => m.content)).toEqual(["✅ **Level 1** is done", "🚧 **Level 2** is working"])
    expect(store.taskNotices([a.id, b.id], 1).map((m) => m.content)).toEqual(["🚧 **Level 2** is working"])
    expect(store.taskNotices([])).toEqual([])
    expect(noticeLines(store.taskNotices([a.id, b.id]))).toBe("- ✅ **Level 1** is done\n- 🚧 **Level 2** is working")
  })

  it("start from the card, the task's state and its updates", () => {
    const prompt = taskThreadPrompt({ title: "Haiku", batch: false, state: "[The task]\n- task_1 \"Haiku\" done", notices: "- ✅ **Haiku** is done", question: "Any good?", context: null, ownerName: "Sam" })
    expect(prompt).toMatch(/^\[Box Yard side thread\] Sam is asking you about a task, from the card of the task "Haiku" in the Coordinator chat\./)
    expect(prompt).toContain("the main chat never sees it")
    expect(prompt).toContain('[The task]\n- task_1 "Haiku" done\n\nIts updates in the chat, oldest first:\n- ✅ **Haiku** is done')
    expect(prompt).toContain("This thread is read-only")
    expect(prompt).toMatch(/Sam's question:\nAny good\?$/)
    expect(prompt).not.toContain("started fresh")

    const batch = taskThreadPrompt({ title: "Level 1 (and 1 more)", batch: true, state: "[These tasks]", notices: "", question: "?", context: "the summary" })
    expect(batch).toContain('from the card of the batch of tasks "Level 1 (and 1 more)"')
    expect(batch).toContain("started fresh, from your notes.]\n\nthe summary")
    expect(batch).toContain("about these tasks")
    expect(batch).not.toContain("updates in the chat")
  })
})

describe("reply threads", () => {
  it("count Cody's messages and the answers, mark answers after the last look unread, and resolve", () => {
    const store = memStore()
    const a = store.addChat("assistant", "Coordinator reply")
    const t = store.createSideThread({ projectId: null, anchorId: a.id, quote: a.content, sessionId: "s-1", kind: "reply" })
    expect(t).toMatchObject({ kind: "reply", replies: 0, unread: false, resolvedAt: null })
    // An older thread (before the kind column) is an ask.
    expect(store.createSideThread({ projectId: null, anchorId: a.id, quote: "x", sessionId: "s-2" }).kind).toBe("ask")
    expect(store.threadOn(null, a.id, "reply")!.id).toBe(t.id)
    expect(store.threadOn(null, "chat_other", "reply")).toBeNull()

    const ask = store.addSideThreadMessage(t.id, "user", "Why?")
    store.seeSideThread(t.id, ask.createdAt)
    expect(store.getSideThread(t.id)).toMatchObject({ replies: 1, unread: false })
    store.addSideThreadMessage(t.id, "tool", "get_task")
    // Tool lines aren't replies, and don't make it unread.
    expect(store.getSideThread(t.id)).toMatchObject({ replies: 1, unread: false })
    const answer = store.addSideThreadMessage(t.id, "assistant", "Because.")
    // Same millisecond as the look: bump the answer so it's after it.
    if (answer.createdAt <= ask.createdAt) store.db.prepare("UPDATE side_thread_messages SET created_at = ? WHERE id = ?").run(ask.createdAt + 1, answer.id)
    expect(store.getSideThread(t.id)).toMatchObject({ replies: 2, unread: true })
    store.seeSideThread(t.id, ask.createdAt + 5)
    expect(store.getSideThread(t.id)!.unread).toBe(false)
    // Seeing never goes back in time.
    store.seeSideThread(t.id, 0)
    expect(store.getSideThread(t.id)!.unread).toBe(false)
    expect(store.listSideThreads(null).find((x) => x.id === t.id)).toMatchObject({ replies: 2 })

    store.resolveSideThread(t.id, true)
    expect(store.getSideThread(t.id)!.resolvedAt).toEqual(expect.any(Number))
    store.resolveSideThread(t.id, false)
    expect(store.getSideThread(t.id)!.resolvedAt).toBeNull()
  })

  it("prompt with the whole original message, quoted, and the reply", () => {
    const p = replyPrompt({ original: "Line one\nLine two", reply: "And then?", context: null, ownerName: "Sam" })
    expect(p).toMatch(/^\[Box Yard side thread\] Sam replied/)
    expect(p).toContain("The message Sam is replying to:\n> Line one\n> Line two")
    expect(p).toContain("read-only")
    expect(p.endsWith("Sam's reply:\nAnd then?")).toBe(true)
    // The original and the reply are Sam's content: never renamed.
    expect(replyPrompt({ original: "Cody said hi", reply: "Cody?", context: null, ownerName: "Sam" })).toContain("> Cody said hi")
    expect(replyPrompt({ original: "x", reply: "y", context: "the summary", ownerName: "Sam" })).toContain("started fresh, from your notes.]\n\nthe summary")
  })
})
