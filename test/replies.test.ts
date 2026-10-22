import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import { capReply, preview, REPLY_CAP } from "../server/replies.js"
import { testConfig } from "./helpers.js"

describe("capReply / preview", () => {
  it("returns short text untouched and long text with an explicit marker", () => {
    expect(capReply("hi")).toBe("hi")
    const long = "x".repeat(REPLY_CAP + 500)
    const out = capReply(long)
    expect(out.startsWith("x".repeat(REPLY_CAP))).toBe(true)
    expect(out).toContain("[truncated: 500 more chars")
    expect(out).toContain(`offset=${REPLY_CAP}`)
    expect(capReply(long, REPLY_CAP)).toBe("x".repeat(500))
  })
  it("previews say how to read the rest", () => {
    expect(preview("abc", 10)).toBe("abc")
    expect(preview("a".repeat(50), 10)).toContain("[truncated: 40 more chars")
  })
})

const yards: BoxYard[] = []
afterEach(() => yards.splice(0).forEach((y) => y.stop()))

async function setup() {
  const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(yard)
  const server = buildMcpServer({ store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, scheduler: yard.scheduler, publicUrl: () => "" } as never)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "t", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  const p = yard.store.createProject({ name: "p" })
  const t = yard.store.createTask({ projectId: p.id, title: "T", prompt: "go" })
  const get = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: "get_task", arguments: { task: t.id, ...args } })) as { content: { text: string }[] }
    return JSON.parse(r.content[0]!.text)
  }
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text)
  return { yard, t, get, call }
}

describe("get_task", () => {
  it("returns the latest reply in full once, with older lines as previews", async () => {
    const { yard, t, get } = await setup()
    const old = "o".repeat(3000)
    const reply = "r".repeat(5000)
    yard.store.addTaskMessage(t.id, "assistant", old)
    yard.store.addTaskMessage(t.id, "assistant", reply)
    const out = await get({})
    expect(out.lastReply).toBe(reply)
    expect(out.summary).toBeUndefined()
    expect(out.messages[0]).toContain("[truncated:")
    expect(out.messages[1]).not.toContain("rrrr")
    expect(JSON.stringify(out).split("rrrrrrrrrr").length).toBe(Math.floor(5000 / 10) + 1) // appears exactly once
  })

  it("caps huge replies with a marker and reads the rest via offset", async () => {
    const { yard, t, get } = await setup()
    const reply = "a".repeat(REPLY_CAP) + "TAIL"
    yard.store.addTaskMessage(t.id, "assistant", reply)
    const first = await get({})
    expect(first.lastReply).toContain("[truncated: 4 more chars")
    const rest = await get({ full_reply: true, offset: REPLY_CAP })
    expect(rest.lastReply).toBe("TAIL")
  })
})

describe("event dedupe", () => {
  it("applies an event once even if two readers deliver it", async () => {
    const { yard, t } = await setup()
    const ev = { seq: 1, ts: 1, turnId: null, t: "assistant", text: "hello" }
    await yard.tasks.applyEvents(t.id, [ev], { seq: 0, offset: 0, rid: null })
    await yard.tasks.applyEvents(t.id, [ev], { seq: 0, offset: 0, rid: null })
    await Promise.all([yard.tasks.applyEvents(t.id, [{ ...ev, seq: 2 }], { seq: 0, offset: 0, rid: null }), yard.tasks.applyEvents(t.id, [{ ...ev, seq: 2 }], { seq: 0, offset: 0, rid: null })])
    expect(yard.store.listTaskMessages(t.id).filter((m) => m.role === "assistant")).toHaveLength(2)
  })
})

describe("wait_for_tasks", () => {
  it("returns the full reply once, even when summary equals it", async () => {
    const { yard, t, call } = await setup()
    const reply = "w".repeat(8000)
    yard.store.addTaskMessage(t.id, "assistant", reply)
    yard.store.updateTask(t.id, { status: "idle", summary: reply })
    const out = await call("wait_for_tasks", { tasks: [t.id], timeout_seconds: 5 })
    expect(out.tasks[0].lastReply).toBe(reply)
    expect(out.tasks[0].summary).toBeUndefined()
    expect(JSON.stringify(out).split("w".repeat(100)).length).toBe(81)
  })

  it("marks a reply over the cap instead of cutting it silently", async () => {
    const { yard, t, call } = await setup()
    yard.store.addTaskMessage(t.id, "assistant", "z".repeat(REPLY_CAP + 7))
    yard.store.updateTask(t.id, { status: "idle" })
    const out = await call("wait_for_tasks", { tasks: [t.id], timeout_seconds: 5 })
    expect(out.tasks[0].lastReply).toContain("[truncated: 7 more chars")
  })
})
