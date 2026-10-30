import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { ChatMessage, UiEvent } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

const running: { yard: BoxYard; server: Server }[] = []

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

describe("chat.turn event (voice summaries)", () => {
  it("names each orchestrator turn's final reply, after its tool calls", async () => {
    const port = await freePort()
    const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    running.push({ yard, server })
    const events: UiEvent[] = []
    const broadcast = yard.hub.broadcast.bind(yard.hub)
    yard.hub.broadcast = (ev) => {
      events.push(ev)
      broadcast(ev)
    }
    const base = `http://127.0.0.1:${port}`
    const before = Date.now()
    // The mock orchestrator calls list_tasks, then replies.
    await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "status?" }) })
    const turn = await waitFor(() => events.find((e) => e.type === "chat.turn"), "chat.turn")
    if (turn.type !== "chat.turn") throw new Error("unreachable")
    const chat = (await (await fetch(`${base}/api/chat`)).json()) as ChatMessage[]
    const replies = chat.filter((m) => m.role === "assistant")
    expect(replies.length).toBeGreaterThan(0)
    expect(turn.replyId).toBe(replies.at(-1)!.id)
    expect(turn.startedAt).toBeGreaterThanOrEqual(before)
    // The final reply comes after the tool line, and the turn event after both.
    // A message broadcast again (the reply, once its turn's timing is on it) is an update, not a new line.
    const seen = new Set<string>()
    const order = events
      .filter((e) => e.type === "chat.turn" || (e.type === "chat.message" && !seen.has(e.message.id) && seen.add(e.message.id)))
      .map((e) => (e.type === "chat.turn" ? "turn" : e.type === "chat.message" ? e.message.role : ""))
    expect(order.slice(-3)).toEqual(["tool", "assistant", "turn"])
  })
})
