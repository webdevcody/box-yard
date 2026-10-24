import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { Attachment, CaptainMessage, ChatMessage, Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

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
    // Let any orchestrator turn and task launch finish before the database closes.
    await waitFor(() => !r.yard.orchestrator.busy, "orchestrator to go idle")
    await waitFor(() => r.yard.store.listTasks({}).every((t) => settled(t)), "tasks to settle")
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const upload = (r: Running, name: string, data: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${r.base}/api/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: new Uint8Array(data),
  })

/** Every byte value, twice, plus a PNG signature: breaks if anything treats it as text. */
const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...[0, 1].map(() => Buffer.from(Array.from({ length: 256 }, (_, i) => i)))])

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const settled = (t: Task) => !["queued", "starting", "working"].includes(t.status) && t.pendingCount === 0

async function untilSettled(r: Running, id: string, turns: number) {
  return waitFor(async () => {
    const t = await getTask(r, id)
    return settled(t) && t.turnCount >= turns ? t : null
  }, `task ${id} to finish turn ${turns}`)
}

const dirOf = (r: Running, t: Task) => r.yard.tasks.taskDir(t.boxId!, t.id)

describe("upload endpoint", () => {
  it("stores a binary file and serves the same bytes back", async () => {
    const r = await start()
    const res = await upload(r, "shot.png", binary)
    expect(res.status).toBe(201)
    const file = (await res.json()) as Attachment & { path?: string }
    expect(file).toMatchObject({ name: "shot.png", size: binary.length, mime: "image/png" })
    expect(file.id).toMatch(/^up_[a-f0-9]{12}$/)
    expect(file.path).toBeUndefined()

    const back = await fetch(`${r.base}/api/uploads/${file.id}/shot.png`)
    expect(back.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await back.arrayBuffer()).equals(binary)).toBe(true)
    expect(fs.existsSync(path.join(r.config.dataDir, "uploads", file.id, "shot.png"))).toBe(true)
  })

  it("rejects files over the limit with a clear message", async () => {
    const r = await start({ maxUploadMb: 1 })
    const res = await upload(r, "big.bin", Buffer.alloc(1024 * 1024 + 1, 7))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('"big.bin" is larger than the 1 MB upload limit.')
  })

  it("rejects a missing name and empty files", async () => {
    const r = await start()
    expect((await fetch(`${r.base}/api/uploads`, { method: "POST", body: "x" })).status).toBe(400)
    expect((await upload(r, "empty.txt", Buffer.alloc(0))).status).toBe(400)
  })

  it("uses the same login as the other API routes", async () => {
    const r = await start({ password: "secret" })
    expect((await upload(r, "a.txt", Buffer.from("hi"))).status).toBe(401)
    expect((await fetch(`${r.base}/api/uploads/up_000000000000/a.txt`)).status).toBe(401)
  })

  it("won't serve ids that are not uploads", async () => {
    const r = await start()
    expect((await fetch(`${r.base}/api/uploads/..%2F..%2Fetc/passwd`)).status).toBe(404)
  })
})

describe("attachments in messages", () => {
  it("rejects a message with neither text nor files, and unknown file ids", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "hello" })
    await expect(call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "" })).rejects.toThrow(/empty/)
    await expect(call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "x", attachments: ["up_000000000000"] })).rejects.toThrow(/not an uploaded file/)
    await expect(call(r, "POST", "/api/chat", { content: "x", attachments: ["/etc/passwd"] })).rejects.toThrow(/not an uploaded file/)
  })

  it("keeps the server path on chat messages so the orchestrator can Read the file", async () => {
    const r = await start()
    const file = (await (await upload(r, "bug.png", binary)).json()) as Attachment
    const msg = await call<ChatMessage>(r, "POST", "/api/chat", { content: "", attachments: [file.id] })
    const [sent] = (msg.meta?.attachments ?? []) as Attachment[]
    expect(sent!.path).toBe(path.join(r.config.dataDir, "uploads", file.id, "bug.png"))
    expect(fs.readFileSync(sent!.path!).equals(binary)).toBe(true)
  })

  it("keeps attachments on direct Captain messages", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const file = (await (await upload(r, "spec.png", binary)).json()) as Attachment
    const msg = await call<CaptainMessage>(r, "POST", `/api/projects/${p.id}/captain/messages`, { id: "cap_attach0001", content: "", attachments: [file.id] })
    const [sent] = (msg.meta?.attachments ?? []) as Attachment[]
    expect(sent!.path).toBe(path.join(r.config.dataDir, "uploads", file.id, "spec.png"))
    await expect(call(r, "POST", `/api/projects/${p.id}/captain/messages`, { id: "cap_attach0002", content: "" })).rejects.toThrow(/empty/)
    // The Captain answers in the background; let it finish before the store closes.
    await waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle")
  })

  it("starts a task with files, a model and an effort from the New task dialog", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const file = (await (await upload(r, "spec.png", binary)).json()) as Attachment
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "build it", model: "claude-haiku-5-5", effort: "low", attachments: [file.id] })
    expect(t).toMatchObject({ model: "claude-haiku-5-5", effort: "low" })
    const [first] = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    expect(first!.meta).toMatchObject({ kind: "task_prompt", attachments: [expect.objectContaining({ id: file.id, name: "spec.png" })] })
    await expect(call(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "x", effort: "huge" })).rejects.toThrow(/400/)
    await expect(call(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "x", attachments: ["/etc/passwd"] })).rejects.toThrow(/not an uploaded file/)
    await untilSettled(r, t.id, 1)
  })

  it("writes binary attachments into the task's box folder and names them in the prompt", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "hello" })
    await untilSettled(r, t.id, 1)
    const file = (await (await upload(r, "shot.png", binary)).json()) as Attachment

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "see this", attachments: [file.id] })
    const done = await untilSettled(r, t.id, 2)

    const target = `${dirOf(r, done)}/attachments/shot.png`
    expect(fs.readFileSync(target).equals(binary)).toBe(true)
    const turn = JSON.parse(fs.readFileSync(`${dirOf(r, done)}/turn.json`, "utf8")) as { prompt: string }
    expect(turn.prompt).toContain("see this")
    expect(turn.prompt).toContain(target)

    const msgs = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    const sent = msgs.find((m) => m.content === "see this")
    expect(sent?.meta?.attachments).toEqual([file])
  })

  it("delivers attachments sent while the agent is mid-turn on its next turn", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "T", prompt: "work [slow]" })
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "working")
    const file = (await (await upload(r, "notes.bin", binary)).json()) as Attachment

    await call(r, "POST", `/api/tasks/${t.id}/messages`, { content: "", attachments: [file.id] })
    expect((await getTask(r, t.id)).pendingCount).toBe(1)

    const done = await untilSettled(r, t.id, 2)
    expect(fs.readFileSync(`${dirOf(r, done)}/attachments/notes.bin`).equals(binary)).toBe(true)
  })

  it("gives a new task its attachments (create_task with attachments)", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const file = (await (await upload(r, "a.png", binary)).json()) as Attachment
    // The orchestrator passes the path it saw in chat; resolve accepts ids and paths.
    const stored = (await call<ChatMessage>(r, "POST", "/api/chat", { content: "", attachments: [file.id] })).meta!.attachments as Attachment[]
    const t = r.yard.tasks.createTask({
      projectId: p.id,
      title: "From chat",
      prompt: "fix the bug in the screenshot",
      attachments: [{ ...stored[0]!, path: stored[0]!.path! }],
    })
    const done = await untilSettled(r, t.id, 1)
    expect(fs.readFileSync(`${dirOf(r, done)}/attachments/a.png`).equals(binary)).toBe(true)
    const turn = JSON.parse(fs.readFileSync(`${dirOf(r, done)}/turn.json`, "utf8")) as { prompt: string }
    expect(turn.prompt).toContain("fix the bug in the screenshot")
    expect(turn.prompt).toContain(`${dirOf(r, done)}/attachments/a.png`)
  })
})
