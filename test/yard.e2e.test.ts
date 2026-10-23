import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { AppNotification, BoxInfo, ChatMessage, Project, Task, TaskMessage, UsageReport } from "../shared/types.js"
import { NEXT_STEPS_META_KEY } from "../shared/nextSteps.js"
import { fakeRedis, freePort, testConfig, waitFor } from "./helpers.js"

// End-to-end: the real server, task manager, worker runner and MCP servers,
// with local folder "boxes" and the fake claude standing in for the model.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  config: Config
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, config }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const settled = (t: Task) => !["queued", "starting", "working"].includes(t.status) && t.pendingCount === 0

async function project(r: Running, name = "demo") {
  return call<Project>(r, "POST", "/api/projects", { name })
}
async function task(r: Running, projectId: string, title: string, prompt: string) {
  return call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
}
async function untilStatus(r: Running, id: string, status: Task["status"]) {
  return waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === status && settled(t) ? t : null
  }, `task ${id} to be ${status}`)
}

describe("box yard end to end", () => {
  it("runs a task to done, publishes an artifact and saves a project note", async () => {
    const r = await start()
    const p = await project(r)
    const t = await task(r, p.id, "Haiku", "write a haiku [artifact] [note]")
    expect(t.status).toBe("queued")

    const done = await untilStatus(r, t.id, "done")
    expect(done.summary).toContain("mock agent")
    expect(done.turnCount).toBe(1)

    const artifacts = await call<{ url: string; taskId: string }[]>(r, "GET", "/api/artifacts")
    expect(artifacts).toHaveLength(1)
    const file = await fetch(r.base + artifacts[0]!.url)
    expect(await file.text()).toContain("write a haiku")

    const projects = await call<Project[]>(r, "GET", "/api/projects")
    expect(projects[0]!.notes.map((n) => n.content).join()).toContain("npm test")

    // The workspace gets archived so the task can move boxes later.
    await waitFor(async () => (await getTask(r, t.id)).lastArchivedAt, "archive")
    const messages = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    const reply = [...messages].reverse().find((m) => m.role === "assistant")
    expect(reply?.content).not.toContain("boxyard-next-steps")
    expect(reply?.meta?.[NEXT_STEPS_META_KEY]).toEqual(["Review the mock result", "Run a broader check", "Ask for a PR-ready summary"])
  })

  it("records Claude usage per task and project", async () => {
    const r = await start()
    const p = await project(r, "usage")
    const t = await task(r, p.id, "Measure", "write things")
    await untilStatus(r, t.id, "done")

    const taskAfter = await getTask(r, t.id)
    expect(taskAfter.claudeTokens).toBeGreaterThan(0)

    const usage = await call<UsageReport>(r, "GET", "/api/usage")
    expect(usage.windows.find((w) => w.key === "today")!.claude.totalTokens).toBeGreaterThan(0)
    expect(usage.projects.find((x) => x.projectId === p.id)?.claude.totalTokens).toBeGreaterThan(0)
    expect(usage.tasks.find((x) => x.taskId === t.id)?.claude.totalTokens).toBeGreaterThan(0)
  })

  it("pauses new agent turns when a budget is exceeded", async () => {
    const r = await start()
    r.yard.store.recordClaudeUsage({
      source: "orchestrator",
      runKind: "turn",
      startedAt: Date.now(),
      endedAt: Date.now(),
      usage: { input_tokens: 1 },
      costUsd: 2,
    })
    await call(r, "PUT", "/api/agent-settings", { budget: { dailyUsd: 1, monthlyUsd: 0 } })
    const p = await project(r, "budget")
    const t = await task(r, p.id, "Paused", "write things")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const queued = await getTask(r, t.id)
    expect(queued.status).toBe("queued")
    expect(await call<BoxInfo[]>(r, "GET", "/api/boxes")).toHaveLength(0)
    expect((await call<UsageReport>(r, "GET", "/api/usage")).budget.blocked).toBe(true)
  })

  it("asks Cody a question, then resumes the same session with the answer", async () => {
    const r = await start()
    const p = await project(r)
    const t = await task(r, p.id, "Button", "build a button [ask]")
    const asking = await untilStatus(r, t.id, "needs_input")
    expect(asking.question).toMatch(/blue or green/)

    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.some((m) => m.role === "notice" && m.content.includes("needs you"))).toBe(true)

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "blue" })
    const done = await untilStatus(r, t.id, "done")
    expect(done.turnCount).toBe(2)
    expect(done.sessionId).toBe(asking.sessionId)
    expect(done.question).toBeNull()

    const messages = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    expect(messages.some((m) => m.role === "user" && m.content === "blue")).toBe(true)
  })

  it("records a notification each time a task lands on needs-you or done, with read state", async () => {
    const r = await start()
    const p = await project(r, "site")
    const t = await task(r, p.id, "Button", "build a button [ask]")
    await untilStatus(r, t.id, "needs_input")
    let list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list).toMatchObject([{ taskId: t.id, status: "needs_input", title: "Button", projectName: "site", readAt: null }])
    expect(list[0]!.summary).toMatch(/blue or green/)

    const read = await call<{ ids: string[] }>(r, "POST", "/api/notifications/read", { taskId: t.id })
    expect(read.ids).toEqual([list[0]!.id])
    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "blue" })
    await untilStatus(r, t.id, "done")
    list = await call<AppNotification[]>(r, "GET", "/api/notifications")
    expect(list.map((n) => [n.status, n.readAt === null])).toEqual([["done", true], ["needs_input", false]])

    // Cody closing it himself is not news.
    await call(r, "POST", `/api/tasks/${t.id}/close`)
    await waitFor(async () => (await getTask(r, t.id)).boxId === null, "workspace evicted") // let the close finish before teardown
    expect(await call<AppNotification[]>(r, "GET", "/api/notifications")).toHaveLength(2)
  })

  it("marks failures, keeps the error, and retries on request", async () => {
    const r = await start()
    const p = await project(r)
    const t = await task(r, p.id, "Breaker", "[fail] please")
    const failed = await untilStatus(r, t.id, "failed")
    expect(failed.error).toContain("fake failure")
    await call(r, "POST", `/api/tasks/${t.id}/retry`)
    // The fake fails again because the task prompt still says [fail]; the point is the retry ran.
    await waitFor(async () => (await getTask(r, t.id)).turnCount === 2 && settled(await getTask(r, t.id)), "retry turn")
  })

  it("never runs more agents than the pool allows, and queues the rest", async () => {
    const r = await start({ maxBoxes: 1, slotsPerBox: 2 })
    const p = await project(r)
    const tasks = await Promise.all(
      Array.from({ length: 5 }, (_, i) => task(r, p.id, `Slow ${i}`, `slow job ${i} [slow]`)),
    )
    let maxRunning = 0
    let maxBoxes = 0
    await waitFor(async () => {
      const boxes = await call<BoxInfo[]>(r, "GET", "/api/boxes")
      maxBoxes = Math.max(maxBoxes, boxes.length)
      maxRunning = Math.max(maxRunning, ...boxes.map((b) => b.runningTurns), 0)
      const all = await Promise.all(tasks.map((t) => getTask(r, t.id)))
      return all.every((t) => t.status === "done")
    }, "all slow tasks done", 45_000)
    expect(maxBoxes).toBe(1)
    expect(maxRunning).toBeLessThanOrEqual(2)
    expect(maxRunning).toBeGreaterThan(0)
  })

  it("lets agents message each other through the orchestrator", async () => {
    const r = await start()
    const p = await project(r)
    const a = await task(r, p.id, "Receiver", "write things")
    await untilStatus(r, a.id, "done")
    const b = await task(r, p.id, "Sender", `say hi [agent:${a.id}]`)
    await untilStatus(r, b.id, "done")
    // The receiver gets a new turn with the message, in its same session.
    const received = await waitFor(async () => {
      const t = await getTask(r, a.id)
      return t.turnCount === 2 && settled(t) ? t : null
    }, "receiver second turn")
    expect(received.sessionId).toBe(a.sessionId)
    const msgs = await call<TaskMessage[]>(r, "GET", `/api/tasks/${a.id}/messages`)
    const agentMsg = msgs.find((m) => m.role === "agent")
    expect(agentMsg?.content).toContain("Hi from another agent")
    expect(agentMsg?.meta?.from).toBe(b.id)
  })

  it("restores a task's workspace on another box after its box is lost", async () => {
    const r = await start({ maxBoxes: 2 })
    const p = await project(r)
    const t = await task(r, p.id, "Mover", "write things")
    const first = await untilStatus(r, t.id, "done")
    await waitFor(async () => (await getTask(r, t.id)).lastArchivedAt, "archive")
    const oldBox = first.boxId!
    // Pretend the box vanished (deleted in the console, crashed, expired).
    fs.rmSync(`${r.config.dataDir}/local-boxes/${oldBox}`, { recursive: true, force: true })
    await call(r, "DELETE", `/api/boxes/${oldBox}`)

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "keep going" })
    const moved = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount === 2 && settled(x) ? x : null
    }, "turn on new box")
    expect(moved.boxId).not.toBe(oldBox)
    const msgs = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    expect(msgs.some((m) => m.content.startsWith("Workspace restored"))).toBe(true)
    // The restored folder still has the file the agent wrote in turn one.
    expect(fs.existsSync(`${r.config.dataDir}/local-boxes/${moved.boxId}/tasks/${t.id}/work/box-yard-demo.md`)).toBe(true)
  })

  it("stops a running turn", async () => {
    const r = await start()
    const p = await project(r)
    const t = await task(r, p.id, "Long", "think hard [slow]")
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "working")
    await call(r, "POST", `/api/tasks/${t.id}/stop`)
    const stopped = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.status === "idle" ? x : null
    }, "stopped")
    expect(stopped.error).toBeNull()
    // Cody stopped it himself, so no notification.
    expect(await call<AppNotification[]>(r, "GET", "/api/notifications")).toEqual([])
  })

  it("the orchestrator chat creates projects and tasks through MCP tools", async () => {
    const r = await start()
    await call(r, "POST", "/api/chat", { content: "create project site" })
    await waitFor(async () => (await call<Project[]>(r, "GET", "/api/projects")).some((p) => p.name === "site"), "project from chat")
    await call(r, "POST", "/api/chat", { content: "task site: Landing page -- make a landing page [preview]" })
    const created = await waitFor(async () => (await call<Task[]>(r, "GET", "/api/tasks")).find((t) => t.title === "Landing page"), "task from chat")
    const idle = await untilStatus(r, created.id, "idle")
    expect(idle.previews[0]?.port).toBeGreaterThanOrEqual(4000)
    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(expect.arrayContaining(["create_project", "create_task"]))
    expect(chat.some((m) => m.role === "assistant" && m.content.includes("Started task"))).toBe(true)
    const reply = [...chat].reverse().find((m) => m.role === "assistant")
    expect(reply?.content).not.toContain("boxyard-next-steps")
    expect(reply?.meta?.[NEXT_STEPS_META_KEY]).toEqual(["Check the latest yard status", "Start a related task", "Summarize open decisions"])
    // Second message resumed the same orchestrator session.
    expect(r.yard.store.getKv("orchestrator_session_started")).toBe("1")
  })

  it("uses Upstash Redis as the event bus when configured", async () => {
    const redis = await fakeRedis()
    try {
      const r = await start({ redisUrl: redis.url, redisToken: redis.token })
      const p = await project(r)
      const t = await task(r, p.id, "Bus", "write things [artifact]")
      await untilStatus(r, t.id, "done")
      const stream = redis.streams.get(`boxyard:events:${t.id}`) ?? []
      expect(stream.length).toBeGreaterThan(3)
      const health = await call<{ bus: string }>(r, "GET", "/api/health")
      expect(health.bus).toBe("redis")
    } finally {
      redis.close()
    }
  })

  it("requires the password when one is set", async () => {
    const r = await start({ password: "hunter2" })
    const res = await fetch(`${r.base}/api/projects`)
    expect(res.status).toBe(401)
    const login = await fetch(`${r.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    const ok = await fetch(`${r.base}/api/projects`, { headers: { cookie } })
    expect(ok.status).toBe(200)
    const bad = await fetch(`${r.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    })
    expect(bad.status).toBe(401)
  })

  it("returns readable validation errors", async () => {
    const r = await start()
    const res = await fetch(`${r.base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "nope", title: "", prompt: "x" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/title/)
    const missing = await fetch(`${r.base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "prj_doesnotexist", title: "a", prompt: "b" }),
    })
    expect(missing.status).toBe(404)
  })
})
