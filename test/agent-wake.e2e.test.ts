import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { HookStore } from "../server/hookStore.js"
import { HookEngine } from "../server/hooks.js"
import type { TaskEvent } from "../server/tasks.js"
import type { Hook } from "../shared/hooks.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Quiet agent-to-agent wakes and the live PR line, end to end: real worker turns (fake-claude), a fake GitHub
// (the createBoxYard seam), and a hook engine whose message_coordinator action is a recording stub.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  /** What the fake GitHub answers for every PR it's asked about. */
  gh: { mode: "open" | "merged" | "fail"; requests: number }
  engine: HookEngine
  /** Hook prompts the engine "sent to the Coordinator". */
  fired: { hookId: string; taskId: string }[]
  events: TaskEvent[]
}
const running: Running[] = []

const HEAD = "beef".padEnd(40, "1")
const MERGED_AT = "2026-10-26T09:15:00Z"

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const gh: Running["gh"] = { mode: "open", requests: 0 }
  const fetch = (async () => {
    gh.requests++
    if (gh.mode === "fail") return new Response("upstream down", { status: 502 })
    const pr =
      gh.mode === "merged"
        ? { state: "MERGED", isDraft: false, mergedAt: MERGED_AT, mergedBy: { login: "webdevcody" }, headRefOid: HEAD, labels: { nodes: [] } }
        : { state: "OPEN", isDraft: false, mergedAt: null, mergedBy: null, headRefOid: HEAD, labels: { nodes: [] } }
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
    for (let i = 0; i < 10; i++) data[`p${i}`] = { pullRequest: pr }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch, token: () => "test-token" } })
  // Captains would wake on task notices and start turns of their own; these tests read what they were sent.
  yard.captains.tuning.wakeDebounceMs = 10 * 60_000
  // Our own hook engine, whose message_coordinator only records, replaces the app's.
  yard.hooks.stop()
  const fired: Running["fired"] = []
  const engine = new HookEngine({
    store: yard.store,
    hooks: new HookStore(yard.db),
    tasks: yard.tasks,
    hub: yard.hub,
    messageCaptain: () => {},
    messageCoordinator: (_content, meta) => void fired.push({ hookId: meta.hookId, taskId: meta.taskId }),
  })
  engine.start()
  const events: TaskEvent[] = []
  yard.tasks.subscribe((e) => events.push(e))
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh, engine, fired, events }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.engine.stop()
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

/** The task once it rests after `turns` turns. */
const rested = (r: Running, id: string, turns: number) =>
  waitFor(() => {
    const row = r.yard.store.getTaskRow(id)
    return row && row.turn_count >= turns && !row.current_turn_id && ["idle", "pr_ready", "done", "needs_input", "failed"].includes(row.status) ? r.yard.store.getTask(id) : null
  }, `task ${id} to rest after turn ${turns}`, 30_000)

const triggers = (r: Running, id: string) => r.yard.store.listTaskTurns(id).map((t) => t.trigger)

/**
 * Notices about a task in the Coordinator chat (what Zen shows too) and in its project's Captain transcript, without
 * the hooks' own "🪝 … hook … messaged the Coordinator" ones.
 */
const notices = (r: Running, task: Task) => ({
  coordinator: (
    r.yard.store.db
      .prepare("SELECT content FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ? AND json_extract(meta_json, '$.kind') IS NOT 'hook' ORDER BY rowid")
      .all(task.id) as { content: string }[]
  ).map((m) => m.content),
  captain: r.yard.store.listCaptainMessages(task.projectId).filter((m) => m.role === "notice" && m.meta?.taskId === task.id && m.meta?.kind !== "hook"),
})

/** Another agent's message_agent, as its runner reports it. */
const messageAgent = (r: Running, from: string, to: string, message: string) =>
  r.yard.tasks.apply(from, { seq: 0, ts: Date.now(), turnId: null, t: "message_agent", to, message, expectReply: false })

const finishedHooks = (r: Running, project: Project) => {
  const base = { projectId: project.id, trigger: "task.finished" as const, action: "message_coordinator" as const, prompt: "{task_title} finished", enabled: true, createdBy: "Cody", maxFiresPerTask: 10 }
  const plain = r.engine.create({ ...base, name: "On finish" })
  const optIn = r.engine.create({ ...base, name: "On finish, agent wakes too", filters: { includeAgentWakes: true } })
  return { plain, optIn }
}
const firesOf = (r: Running, hook: Hook, taskId: string) => r.fired.filter((f) => f.hookId === hook.id && f.taskId === taskId).length

describe("quiet agent-to-agent wakes", () => {
  it("tells only the Captain about a turn another agent's message started, and task.finished hooks skip it unless they opt in", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const hooks = finishedHooks(r, project)

    const b = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Write the notes", prompt: "Write the notes file." })
    await rested(r, b.id, 1)
    const before = notices(r, b)
    expect(before.coordinator).toHaveLength(1)
    expect(before.coordinator[0]).toMatch(/^✅ \*\*Write the notes\*\* is done/)
    const toasts = r.yard.store.listNotifications().filter((n) => n.taskId === b.id).length

    // Another agent pings it: B's next turn carries only that message.
    const a = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Ping the writer", prompt: `Say hi to the writer [agent:${b.id}]` })
    await rested(r, a.id, 1)
    const woken = await rested(r, b.id, 2)
    expect(triggers(r, b.id)).toEqual(["cody", "agent"])

    // Not in the Coordinator chat (or Zen), and no toast; the Captain has it, and so does the transcript.
    const after = notices(r, b)
    expect(after.coordinator).toEqual(before.coordinator)
    expect(r.yard.store.listNotifications().filter((n) => n.taskId === b.id)).toHaveLength(toasts)
    const quiet = after.captain.filter((m) => m.meta?.agentWake)
    expect(quiet).toHaveLength(1)
    expect(quiet[0]!.content).toMatch(/^💬 \*\*Write the notes\*\* finished its turn/)
    const transcript = r.yard.store.listTaskMessages(b.id, 200)
    expect(transcript.find((m) => m.meta?.kind === "agent_wake")?.content).toContain(quiet[0]!.content)
    expect(woken.status).toBe("idle")

    // task.finished fired for the first turn (Cody's) on both hooks, and for the agent wake only on the opt-in one.
    const finished = r.events.filter((e) => e.taskId === b.id && e.type === "task.finished")
    expect(finished.map((e) => Boolean(e.agentWake))).toEqual([false, true])
    expect(firesOf(r, hooks.plain, b.id)).toBe(1)
    expect(firesOf(r, hooks.optIn, b.id)).toBe(2)
    // The sender's own turn was Cody's, so it notified as usual.
    expect(notices(r, a).coordinator.some((c) => c.startsWith("✅ **Ping the writer**"))).toBe(true)
  }, 60_000)

  it("counts a turn with Cody's message and an agent's as Cody's, and notifies as usual", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const hooks = finishedHooks(r, project)
    const a = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Sender", prompt: "Wait for instructions." })
    const b = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Receiver", prompt: "Write the notes file." })
    await rested(r, a.id, 1)
    await rested(r, b.id, 1)
    const before = notices(r, b).coordinator.length

    // Both arrive before the next turn claims its messages, so one turn carries the two.
    void messageAgent(r, a.id, b.id, "What are you working on?")
    r.yard.tasks.sendInput(b.id, "Also add a heading.", "cody")
    await rested(r, b.id, 2)
    expect(triggers(r, b.id)).toEqual(["cody", "cody"])
    const turn = JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(r.yard.store.getTaskRow(b.id)!.box_id!, b.id), "turn.json"), "utf8"))
    expect(turn.prompt).toContain("Message from agent")
    expect(turn.prompt).toContain("Also add a heading.")

    const after = notices(r, b)
    expect(after.coordinator).toHaveLength(before + 1)
    // (fake-claude doesn't mark_done when a message is from an agent, so it rests idle.)
    expect(after.coordinator.at(-1)).toMatch(/^💬 \*\*Receiver\*\* finished its turn/)
    expect(r.events.filter((e) => e.taskId === b.id && e.type === "task.finished").every((e) => !e.agentWake)).toBe(true)
    expect(firesOf(r, hooks.plain, b.id)).toBe(2)
  }, 60_000)

  it("still notifies when an agent wake opens a PR", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const hooks = finishedHooks(r, project)
    const a = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Sender", prompt: "Wait for instructions." })
    const b = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Receiver", prompt: "Write the notes file." })
    await rested(r, a.id, 1)
    await rested(r, b.id, 1)

    // [slow]: the woken turn runs long enough to report a PR mid-turn.
    await messageAgent(r, a.id, b.id, "Please open a PR for the notes [slow]")
    await waitFor(() => r.yard.store.getTaskRow(b.id)?.status === "working", "the agent-wake turn to start")
    await r.yard.tasks.apply(b.id, { seq: 0, ts: Date.now(), turnId: null, t: "pr", url: "https://github.com/acme/site/pull/9", number: 9, branch: "boxyard/notes", headSha: HEAD })
    const done = await rested(r, b.id, 2)
    expect(triggers(r, b.id)).toEqual(["cody", "agent"])
    expect(done.status).toBe("pr_ready")

    const coordinator = notices(r, b).coordinator
    expect(coordinator).toContain("🔀 **Receiver** opened a pull request: https://github.com/acme/site/pull/9")
    expect(coordinator.at(-1)).toMatch(/^💬 \*\*Receiver\*\* finished its turn/)
    expect(r.events.filter((e) => e.taskId === b.id && e.type === "task.finished").map((e) => Boolean(e.agentWake))).toEqual([false, false])
    expect(firesOf(r, hooks.plain, b.id)).toBe(2)
  }, 60_000)
})

describe("the PR's live state in a resumed turn's prompt", () => {
  /** A task resting with an open PR #76, as Box Yard last saw it. */
  async function prTask(r: Running) {
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Night shift", prompt: "Fix the lights. [pr]" })
    await rested(r, t.id, 1)
    r.yard.store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/76", prState: "open", prHeadSha: "0".repeat(40) }, { quiet: true })
    return t
  }
  const turnPrompt = (r: Running, id: string): string =>
    JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(r.yard.store.getTaskRow(id)!.box_id!, id), "turn.json"), "utf8")).prompt

  it("says a PR merged on GitHub is merged, when, by whom and at which commit", async () => {
    const r = await start()
    const t = await prTask(r)
    // Cody merged it on GitHub; Box Yard's own state still says open.
    r.gh.mode = "merged"
    r.yard.tasks.sendInput(t.id, "Anything left?", "cody")
    const after = await rested(r, t.id, 2)
    const prompt = turnPrompt(r, t.id)
    expect(prompt).toMatch(
      /Pull request status \(from Box Yard; [^)]+\): #76 https:\/\/github\.com\/acme\/site\/pull\/76 is MERGED at 2026-10-26 09:15 UTC by webdevcody, head commit beef11111111\./,
    )
    expect(prompt).toContain("It is not waiting for review")
    expect(prompt).toMatch(/base any new work on main \(a new branch and a new PR\)/)
    expect(after).toMatchObject({ prState: "merged", prMergedBy: "webdevcody" })
  }, 60_000)

  it("falls back to Box Yard's last known state when GitHub fails, and the turn still runs", async () => {
    const r = await start()
    const t = await prTask(r)
    r.gh.mode = "fail"
    const asked = r.gh.requests
    r.yard.tasks.sendInput(t.id, "Anything left?", "cody")
    await rested(r, t.id, 2)
    expect(r.gh.requests).toBeGreaterThan(asked)
    const prompt = turnPrompt(r, t.id)
    expect(prompt).toContain("Pull request status (from Box Yard; GitHub couldn't be checked just now; this is Box Yard's last known state): #76")
    expect(prompt).toContain("is OPEN, not merged, head commit 000000000000. Check it with `gh pr view 76 --json state,mergedAt,headRefOid`")
  }, 60_000)
})
