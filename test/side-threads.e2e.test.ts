import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { ChatMessage, SideThread, SideThreadMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

const running: { yard: BoxYard; server: Server }[] = []

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

const fakeSession = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`), "utf8")) as {
    turns: { prompt: string }[]
    forkedFrom?: string
  }

async function start(config?: ReturnType<typeof testConfig>) {
  const port = await freePort()
  const yard = createBoxYard(config ? { ...config, port } : testConfig({ port }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  const call = async <T,>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> => {
    const res = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(data)}`), { status: res.status })
    return data as T
  }
  const idle = () => waitFor(async () => !(await call<{ busy: boolean }>("/api/orchestrator")).busy || null, "the Coordinator to be idle")
  const say = async (content: string) => {
    await call("/api/chat", { content })
    // Its turn may not have started yet: wait for its reply, then for the turn to end.
    await waitFor(async () => (await call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant").length > 0 && (await call<ChatMessage[]>("/api/chat")).at(-1)?.role === "assistant", "a reply")
    await idle()
  }
  const answers = (id: string, n: number) =>
    waitFor(async () => {
      const list = await call<SideThreadMessage[]>(`/api/threads/${id}/messages`)
      const done = list.filter((m) => m.role === "assistant" || m.role === "error")
      const threads = await call<SideThread[]>("/api/threads")
      return done.length >= n && !threads.find((t) => t.id === id)?.busy ? done : null
    }, `${n} side thread answers`)
  return { yard, call, say, idle, answers }
}

const threadOf = async (call: <T>(url: string) => Promise<T>, id: string) => (await call<SideThread[]>("/api/threads")).find((t) => t.id === id)!

describe("side threads", () => {
  it("fork the Coordinator's session at the highlighted message: nothing after it, and the chat is untouched", async () => {
    const { yard, call, say, answers } = await start()
    await say("status one")
    await say("status two")
    await say("status three")
    const chat = await call<ChatMessage[]>("/api/chat")
    const replies = chat.filter((m) => m.role === "assistant")
    expect(replies).toHaveLength(3)
    // Every reply names the session line it came from.
    for (const r of replies) expect(r.meta).toMatchObject({ sessionUuid: expect.any(String), sessionId: expect.any(String) })
    const mainId = String(replies[0]!.meta!.sessionId)
    const mainBefore = fakeSession(mainId)
    expect(mainBefore.turns).toHaveLength(3)

    const anchor = replies[1]!
    const quote = anchor.content.split("\n")[0]!
    const { thread, message } = await call<{ thread: SideThread; message: SideThreadMessage }>("/api/threads", {
      anchorId: anchor.id,
      quote,
      question: "What does this mean?",
    })
    expect(thread).toMatchObject({ projectId: null, anchorId: anchor.id, quote })
    expect(message).toMatchObject({ role: "user", content: "What does this mean?" })
    const [first] = await answers(thread.id, 1)
    expect(first!.role).toBe("assistant")
    // The fork sees the two turns up to the highlighted reply, not the third.
    expect(first!.content).toContain("I can see 2 earlier chat turns (forked)")
    expect(first!.content).toContain('The last one asked: "status two"')

    const saved = (await call<SideThread[]>("/api/threads")).find((t) => t.id === thread.id)!
    expect(saved).toMatchObject({ context: "fork", busy: false })
    const row = yard.store.sideThreadSession(thread.id)!
    const forked = fakeSession(row.sessionId)
    expect(forked.forkedFrom).toBe(mainId)
    expect(forked.turns.map((t) => t.prompt).join("\n")).not.toContain("status three")
    expect(forked.turns[2]!.prompt).toContain("[Box Yard side thread]")
    expect(forked.turns[2]!.prompt).toContain(`> ${quote}`)

    // A follow-up resumes the thread's own session.
    await call(`/api/threads/${thread.id}/messages`, { content: "And then?" })
    const [, second] = await answers(thread.id, 2)
    expect(second!.content).toContain("I can see 2 earlier chat turns (forked)")
    expect(second!.content).toContain("You asked: And then?")

    // The Coordinator's session and its transcript are as they were.
    expect(fakeSession(mainId).turns).toHaveLength(3)
    expect(await call<ChatMessage[]>("/api/chat")).toEqual(chat)
    // Threads survive a reload, and only the ones of this chat are listed.
    expect((await call<SideThread[]>("/api/threads")).map((t) => t.id)).toEqual([thread.id])
  })

  it("can look things up but not change anything", async () => {
    const { yard, call, say, answers } = await start()
    await call("/api/projects", { name: "demo" })
    await say("status")
    const reply = (await call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant").at(-1)!
    const { thread } = await call<{ thread: SideThread }>("/api/threads", { anchorId: reply.id, quote: "the yard", question: "Please try create_task" })
    const [answer] = await answers(thread.id, 1)
    expect(answer!.content).toContain("Side threads are read-only")
    expect(yard.store.listTasks()).toHaveLength(0)
    const tools = (await call<SideThreadMessage[]>(`/api/threads/${thread.id}/messages`)).filter((m) => m.role === "tool")
    expect(tools.map((m) => m.content)).toEqual(["create_task"])

    await call(`/api/threads/${thread.id}/messages`, { content: "Now try list_tasks" })
    const [, lookup] = await answers(thread.id, 2)
    expect(lookup!.content).toContain("list_tasks said: [")
  })

  it("after a compaction, starts fresh from the summary and the messages up to the highlight", async () => {
    const { yard, call, say, idle, answers } = await start()
    await say("status alpha")
    await say("status bravo")
    await say("status charlie")
    await call("/api/orchestrator/compact", {})
    await waitFor(async () => (await call<{ lastCompaction: unknown; compacting: boolean }>("/api/orchestrator")).lastCompaction && !(await call<{ compacting: boolean }>("/api/orchestrator")).compacting, "the compaction")
    await idle()
    const replies = (await call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant")
    const anchor = replies[1]!
    const { thread } = await call<{ thread: SideThread }>("/api/threads", { anchorId: anchor.id, quote: "Here's the yard", question: "Why?" })
    const [answer] = await answers(thread.id, 1)
    expect(answer!.content).toContain("I started fresh from the summary.")
    expect(answer!.content).toContain("I can see 0 earlier chat turns")
    expect((await call<SideThread[]>("/api/threads"))[0]!.context).toBe("summary")
    const prompt = fakeSession(yard.store.sideThreadSession(thread.id)!.sessionId).turns[0]!.prompt
    expect(prompt).toContain("status alpha")
    expect(prompt).toContain("status bravo")
    expect(prompt).not.toContain("status charlie")
  })

  it("are deleted for good, and refuse messages from another chat", async () => {
    const { call, say } = await start()
    await say("status")
    const reply = (await call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant").at(-1)!
    await expect(call("/api/threads", { anchorId: "chat_nope000", quote: "x", question: "y" })).rejects.toMatchObject({ status: 400 })
    const project = await call<{ id: string }>("/api/projects", { name: "demo" })
    // The reply is in the Coordinator chat, not the Captain's.
    await expect(call("/api/threads", { projectId: project.id, anchorId: reply.id, quote: "x", question: "y" })).rejects.toMatchObject({ status: 400 })
    const { thread } = await call<{ thread: SideThread }>("/api/threads", { anchorId: reply.id, quote: "the yard", question: "Hm? [slow]" })
    await call(`/api/threads/${thread.id}`, undefined, "DELETE")
    expect(await call<SideThread[]>("/api/threads")).toEqual([])
    await expect(call(`/api/threads/${thread.id}/messages`)).rejects.toMatchObject({ status: 404 })
  })
})

describe("threaded replies", () => {
  it("stay out of the main chat, answer with the original message as context, and count replies", async () => {
    const { yard, call, say, idle, answers } = await start()
    await say("status one")
    await say("status two")
    const chat = await call<ChatMessage[]>("/api/chat")
    const replies = chat.filter((m) => m.role === "assistant")
    const original = replies[0]!
    const mainId = String(original.meta!.sessionId)

    // A reply needs no quote: the thread quotes the whole message.
    const { thread, message } = await call<{ thread: SideThread; message: SideThreadMessage }>("/api/threads", { kind: "reply", anchorId: original.id, question: "Thanks, and the next step?" })
    expect(thread).toMatchObject({ kind: "reply", anchorId: original.id, quote: original.content, resolvedAt: null })
    expect(message).toMatchObject({ role: "user", content: "Thanks, and the next step?" })
    const [answer] = await answers(thread.id, 1)
    // Forked at the original: it sees the one turn up to it, and its prompt quotes the message in full.
    expect(answer!.content).toContain("I can see 1 earlier chat turn (forked)")
    expect(answer!.content).toContain(`Replying to: "${original.content.split("\n")[0]!.slice(0, 120)}"`)
    expect(answer!.content).toContain("You asked: Thanks, and the next step?")
    const prompt = fakeSession(yard.store.sideThreadSession(thread.id)!.sessionId).turns.at(-1)!.prompt
    expect(prompt).toContain("The message Cody is replying to:")
    expect(prompt).toContain("Cody's reply:\nThanks, and the next step?")

    // The reply and its answer: two replies, and the answer is unread until the thread is seen.
    expect(await threadOf(call, thread.id)).toMatchObject({ replies: 2, unread: true, busy: false })
    expect(await call<SideThread>(`/api/threads/${thread.id}/seen`, {})).toMatchObject({ unread: false })

    // Nothing reached the main chat or the Coordinator's session, and its next turn doesn't see the thread.
    expect(await call<ChatMessage[]>("/api/chat")).toEqual(chat)
    await say("status three")
    await idle()
    const main = fakeSession(mainId).turns.map((t) => t.prompt).join("\n")
    expect(main).not.toContain("Thanks, and the next step?")
    expect((await call<ChatMessage[]>("/api/chat")).map((m) => m.content).join("\n")).not.toContain("Side thread answer")

    // Replying to the same message again adds to its one thread.
    const again = await call<{ thread: SideThread }>("/api/threads", { kind: "reply", anchorId: original.id, question: "One more" })
    expect(again.thread.id).toBe(thread.id)
    await answers(thread.id, 2)
    expect(await threadOf(call, thread.id)).toMatchObject({ replies: 4 })
    expect((await call<SideThread[]>("/api/threads")).filter((t) => t.kind === "reply")).toHaveLength(1)
  })

  it("resolve and reopen, and persist across a restart", async () => {
    const config = testConfig()
    const first = await start(config)
    await first.say("status")
    const original = (await first.call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant").at(-1)!
    const { thread } = await first.call<{ thread: SideThread }>("/api/threads", { kind: "reply", anchorId: original.id, question: "Noted" })
    await first.answers(thread.id, 1)

    const resolved = await first.call<SideThread>(`/api/threads/${thread.id}/resolve`, { resolved: true })
    expect(resolved.resolvedAt).toEqual(expect.any(Number))
    expect(await threadOf(first.call, thread.id)).toMatchObject({ resolvedAt: expect.any(Number), replies: 2 })

    // Box Yard restarts: the thread, its replies and its resolved state are still there.
    const r = running.splice(0)[0]!
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
    const second = await start(config)
    expect(await threadOf(second.call, thread.id)).toMatchObject({ kind: "reply", replies: 2, resolvedAt: expect.any(Number) })
    expect((await second.call<SideThreadMessage[]>(`/api/threads/${thread.id}/messages`)).map((m) => m.role)).toEqual(["user", "assistant"])

    // A new reply reopens it, and resumes its own session.
    await second.call(`/api/threads/${thread.id}/messages`, { content: "Actually, one thing" })
    expect((await threadOf(second.call, thread.id)).resolvedAt).toBeNull()
    const [, answer] = await second.answers(thread.id, 2)
    expect(answer!.content).toContain("You asked: Actually, one thing")
    // Reopen by hand works too.
    await second.call(`/api/threads/${thread.id}/resolve`, { resolved: true })
    expect((await second.call<SideThread>(`/api/threads/${thread.id}/resolve`, { resolved: false })).resolvedAt).toBeNull()
  })

  it("refuse a reply to a message from another chat", async () => {
    const { call, say } = await start()
    await say("status")
    const reply = (await call<ChatMessage[]>("/api/chat")).filter((m) => m.role === "assistant").at(-1)!
    const project = await call<{ id: string }>("/api/projects", { name: "demo" })
    await expect(call("/api/threads", { kind: "reply", projectId: project.id, anchorId: reply.id, question: "y" })).rejects.toMatchObject({ status: 400 })
    // An ask still needs its highlight.
    await expect(call("/api/threads", { anchorId: reply.id, question: "y" })).rejects.toMatchObject({ status: 400 })
  })
})
