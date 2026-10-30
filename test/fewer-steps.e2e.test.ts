import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { COORDINATOR_NAMED_HEADING, NAMED_TASKS_HEADING } from "../server/handoff.js"
import type { Project } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Speed step 2, fewer model steps per hop: Cody's message and the Coordinator's message to a Captain arrive with the
// state of the tasks they name, and relay-only Coordinator turns can run on Settings' lighter model.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(orchestratorAutoWake = false): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake }), { webDir: "/nonexistent" })
  yard.orchestrator.tuning.wakeDebounceMs = 50
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

interface FakeTurn {
  prompt: string
  model: string | null
  effort: string | null
}
/** Every turn a fake Claude session ran (scripts/fake-claude.mjs keeps them in its session file). */
function sessionTurns(r: Running, kvKey: string): FakeTurn[] {
  const id = r.yard.store.getKv(kvKey)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: FakeTurn[] }).turns
}

const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)

/** A project with one task that has a PR and a reply, like a finished speed step. */
async function seed(r: Running) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
  const t = r.yard.store.createTask({ id: "task_timing01", projectId: p.id, title: "Per-turn timing instrumentation", prompt: "p" })
  r.yard.store.updateTask(t.id, { status: "idle", prUrl: "https://github.com/webdevcody/box-yard/pull/184", prState: "open" })
  r.yard.store.addTaskMessage(t.id, "assistant", "Opened PR #184: the turn_timings table and the bench.")
  return { p, t }
}

describe("state up front", () => {
  it("hands the Coordinator the state of the tasks and projects Cody's message names", async () => {
    const r = await start()
    const { p } = await seed(r)
    await call(r, "POST", "/api/chat", { content: "status: how is task_timing01 doing, and what's open in demo?" })
    const turn = await waitFor(() => sessionTurns(r, "orchestrator_session")[0], "the Coordinator's turn", 30_000)
    await coordinatorIdle(r)
    const prompt = turn.prompt
    expect(prompt).toContain(COORDINATOR_NAMED_HEADING)
    expect(prompt).toContain(`- task_timing01 "Per-turn timing instrumentation" [demo] idle · PR #184 open`)
    expect(prompt).toContain("Last reply: Opened PR #184: the turn_timings table and the bench.")
    expect(prompt).toContain(`- demo (${p.id}): 1 open task`)
    // The block sits after [Yard now] and before Cody's words.
    expect(prompt.indexOf("[Yard now]")).toBeLessThan(prompt.indexOf(COORDINATOR_NAMED_HEADING))
    expect(prompt.indexOf(COORDINATOR_NAMED_HEADING)).toBeLessThan(prompt.indexOf("status: how is task_timing01"))
  })

  it("leaves the prompt alone when Cody's message names nothing", async () => {
    const r = await start()
    await seed(r)
    await call(r, "POST", "/api/chat", { content: "status" })
    const turn = await waitFor(() => sessionTurns(r, "orchestrator_session")[0], "the Coordinator's turn", 30_000)
    await coordinatorIdle(r)
    expect(turn.prompt).not.toContain(COORDINATOR_NAMED_HEADING)
  })

  it("hands a Captain the state of the tasks the Coordinator's message names", async () => {
    const r = await start()
    const { p } = await seed(r)
    await call(r, "POST", "/api/chat", { content: "tell captain demo: is task_timing01 ready to merge?" })
    const turn = await waitFor(() => sessionTurns(r, `captain_session:${p.id}`)[0], "the Captain's turn", 30_000)
    await captainIdle(r, p)
    await coordinatorIdle(r)
    expect(turn.prompt).toContain(NAMED_TASKS_HEADING)
    expect(turn.prompt).toContain(`- task_timing01 "Per-turn timing instrumentation" idle · PR #184 open`)
    expect(turn.prompt).toContain("Last reply: Opened PR #184")
    expect(turn.prompt.indexOf(NAMED_TASKS_HEADING)).toBeLessThan(turn.prompt.indexOf("is task_timing01 ready to merge?"))
  })
})

describe("relay-only Coordinator turns", () => {
  /** Cody's message, then the automatic turn the Captain's reply wakes. */
  async function roundTrip(r: Running, p: Project) {
    const before = sessionTurns(r, "orchestrator_session").length
    await call(r, "POST", "/api/chat", { content: "tell captain demo: status" })
    await waitFor(() => sessionTurns(r, "orchestrator_session").length >= before + 2, "the Coordinator's wake on the reply", 30_000)
    await captainIdle(r, p)
    await coordinatorIdle(r)
    const turns = sessionTurns(r, "orchestrator_session").slice(before)
    expect(turns[1]!.prompt).toContain("Automatic wake-up")
    const timings = r.yard.store.listTurnTimings({ since: 0, limit: 100 }).filter((t) => t.role === "coordinator" && t.kind === "turn")
    return { turns, timings }
  }

  it("run on the Coordinator's own model and effort by default", async () => {
    const r = await start(true)
    const { p } = await seed(r)
    expect(r.yard.settings.get().orchestratorRelay.enabled).toBe(false)
    const { turns } = await roundTrip(r, p)
    const st = r.yard.settings.get()
    for (const t of turns) expect(t).toMatchObject({ model: st.orchestratorModel, effort: st.orchestratorEffort })
  })

  it("run on the relay model and effort when it's on; Cody's messages never do", async () => {
    const r = await start(true)
    const { p } = await seed(r)
    await call(r, "PUT", "/api/agent-settings", { orchestratorRelay: { enabled: true, model: "claude-haiku-5-5", effort: "low" } })
    const { turns, timings } = await roundTrip(r, p)
    const st = r.yard.settings.get()
    expect(turns[0]).toMatchObject({ model: st.orchestratorModel, effort: st.orchestratorEffort })
    expect(turns[1]).toMatchObject({ model: "claude-haiku-5-5", effort: "low" })
    // The timings say which model and effort each turn ran on.
    expect(timings.find((t) => t.trigger === "cody")).toMatchObject({ effort: st.orchestratorEffort })
    expect(timings.find((t) => t.trigger === "updates")).toMatchObject({ model: "claude-haiku-5-5", effort: "low" })
  })

  it("rejects a relay setting with a bad model or effort", async () => {
    const r = await start()
    await expect(call(r, "PUT", "/api/agent-settings", { orchestratorRelay: { enabled: true, model: "has spaces", effort: "low" } })).rejects.toThrow(/400/)
    await expect(call(r, "PUT", "/api/agent-settings", { orchestratorRelay: { enabled: true, model: "claude-haiku-5-5", effort: "huge" } })).rejects.toThrow(/400/)
    expect(r.yard.settings.get().orchestratorRelay.enabled).toBe(false)
  })
})
