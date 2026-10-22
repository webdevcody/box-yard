import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { ChatMessage, Project } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// When a task finishes after the orchestrator's turn ended, the orchestrator
// wakes up on its own to report it, without waiting for Cody's next message.

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

describe("orchestrator auto-wake", () => {
  it("reports a finished task on its own", async () => {
    const port = await freePort()
    const yard = createBoxYard(testConfig({ port, orchestratorAutoWake: true }), { webDir: "/nonexistent" })
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    running.push({ yard, server })
    const base = `http://127.0.0.1:${port}`
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json())
    const chat = () => fetch(base + "/api/chat").then((r) => r.json() as Promise<ChatMessage[]>)

    await post("/api/projects", { name: "demo" }) as Project
    await post("/api/chat", { content: "task demo: Haiku -- write a haiku [slow]" })

    // The orchestrator's own turn ends while the agent is still working...
    await waitFor(async () => (await chat()).some((m) => m.role === "assistant" && /Started task/.test(m.content)), "task started")
    // ...then the agent finishes, a notice lands, and the orchestrator speaks again unprompted.
    const after = await waitFor(async () => {
      const list = await chat()
      const notice = list.findIndex((m) => m.role === "notice" && /is done/.test(m.content))
      return notice >= 0 && list.slice(notice + 1).some((m) => m.role === "assistant") ? list : null
    }, "an unprompted orchestrator reply after the done notice", 30_000)
    expect(after.filter((m) => m.role === "user")).toHaveLength(1)
  })
})
