import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { MAX_AUTO_TURNS } from "../server/orchestrator.js"
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

  it(`stops waking itself after ${MAX_AUTO_TURNS} automatic turns in a row, until Cody writes; a hook's message doesn't count`, async () => {
    const port = await freePort()
    const yard = createBoxYard(testConfig({ port, orchestratorAutoWake: true }), { webDir: "/nonexistent" })
    yard.orchestrator.tuning.wakeDebounceMs = 20
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    running.push({ yard, server })
    const base = `http://127.0.0.1:${port}`
    // Every Coordinator turn, auto or not, ends with a reply from the fake claude.
    const replies = () => yard.store.listChat(500).filter((m) => m.role === "assistant").length
    const idle = (what: string) => waitFor(async () => !yard.orchestrator.busy && !(await fetch(base + "/api/orchestrator").then((r) => r.json())).busy, what)
    let n = 0
    /** A task update with no task behind it (so nothing holds the wake back), then the nudge a notice gives. */
    const update = () => {
      yard.store.addChat("notice", `✅ **Update ${++n}** is done: nothing`)
      yard.orchestrator.nudge()
    }
    const autoTurn = async () => {
      const before = replies()
      update()
      await waitFor(() => replies() > before && !yard.store.hasUnseenNotices(), `auto-turn for update ${n}`)
      await idle(`auto-turn for update ${n} to end`)
    }
    /** Give a held-back wake time to happen; it must not. */
    const noAutoTurn = async () => {
      const before = replies()
      update()
      await new Promise((r) => setTimeout(r, 400))
      await idle("the held-back wake")
      expect(replies()).toBe(before)
      expect(yard.store.hasUnseenNotices()).toBe(true)
    }

    for (let i = 0; i < MAX_AUTO_TURNS; i++) await autoTurn()
    await noAutoTurn()

    // A hook is an automation: its message gets a turn (which reads the queued updates) but no fresh allowance.
    yard.orchestrator.hookMessage("nightly check", { source: "hook", hookName: "nightly" })
    await waitFor(() => !yard.store.hasUnseenNotices(), "the hook's turn")
    await idle("the hook's turn to end")
    await noAutoTurn()

    // Cody writing resets the count: the updates go out with his turn, and the next ones wake it again.
    await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "status" }) })
    await waitFor(() => !yard.store.hasUnseenNotices(), "Cody's turn")
    await idle("Cody's turn to end")
    await autoTurn()
  }, 60_000)
})
