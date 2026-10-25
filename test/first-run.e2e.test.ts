import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ChatMessage, OrchestratorState, Project, Task } from "../shared/types.js"
import type { SetupStatus } from "../shared/setup.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// First run, end to end: a real (non-mock) server with nothing configured, a `claude` that needs a login like
// the real one (FAKE_CLAUDE_LOGIN=required), then credentials saved in the app and the Coordinator and an agent
// working with them, with no restart.

const TOKEN = "sk-ant-oat01-first-run-token-0123456789"
const BOX_KEY = "box_key_first_run_0123456789"

const dirs: string[] = []
let yard: BoxYard | null = null
let server: Server | null = null

beforeAll(() => {
  process.env.FAKE_CLAUDE_LOGIN = "required"
})
afterAll(() => {
  delete process.env.FAKE_CLAUDE_LOGIN
})
afterEach(async () => {
  yard?.stop()
  if (server) await new Promise((res) => server!.close(() => res(null)))
  yard = null
  server = null
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe("first run", () => {
  it("nothing configured, then credentials saved in the app, then the chat and an agent work", async () => {
    const port = await freePort()
    // fake-claude under a neutral name, so the server doesn't treat the run as mock mode.
    const bin = path.join(tmpDir("box-yard-claude-"), "claude-stand-in.mjs")
    dirs.push(path.dirname(bin))
    fs.symlinkSync(path.resolve("scripts/fake-claude.mjs"), bin)
    const c = testConfig({ port, mock: false, claudeBin: `${process.execPath} ${bin}`, boxProvider: "" })
    dirs.push(c.dataDir)
    const boxes = path.join(c.dataDir, "local-boxes")
    // Boxes stay on this machine even once a box key is saved; the Test endpoint gets a stand-in Upstash.
    yard = createBoxYard(c, {
      webDir: "/nonexistent",
      provider: new LocalProvider(boxes, c.claudeBin),
      setup: { listBoxes: async (k) => (k === BOX_KEY ? [] : Promise.reject(Object.assign(new Error("Unauthorized"), { statusCode: 401 }))) },
      github: { fetch: async () => new Response("{}", { status: 404 }), token: () => null },
    })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    const base = `http://127.0.0.1:${port}`
    const call = async <T,>(method: string, p: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
      return data as T
    }
    const idle = () => waitFor(async () => !(await call<OrchestratorState>("GET", "/api/orchestrator")).busy, "the Coordinator to be idle")
    const chatSince = async (n: number) => (await call<ChatMessage[]>("GET", "/api/chat")).slice(n)

    // 1. Nothing configured: setup says what's missing, and the Coordinator can't sign in.
    let status = await call<SetupStatus>("GET", "/api/setup")
    expect(status).toMatchObject({ ready: false, mock: false, missing: ["a choice of where agents run", "Claude sign-in"] })
    await call("POST", "/api/chat", { content: "status" })
    await waitFor(async () => (await chatSince(0)).some((m) => m.role === "error"), "the failed turn")
    await idle()
    const failed = await chatSince(0)
    expect(failed.find((m) => m.role === "error")!.content).toContain("Not logged in")
    expect(failed.some((m) => m.role === "assistant")).toBe(false)

    // 2. Test, then save, the credentials; no restart.
    expect((await call<{ ok: boolean }>("POST", "/api/setup/test/upstashBoxApiKey", { value: BOX_KEY })).ok).toBe(true)
    expect((await call<{ ok: boolean; message: string }>("POST", "/api/setup/test/claudeOauthToken", { value: TOKEN })).ok).toBe(true)
    status = await call<SetupStatus>("PUT", "/api/setup/credentials", { upstashBoxApiKey: BOX_KEY, claudeOauthToken: TOKEN })
    expect(status).toMatchObject({ ready: true, missing: [] })
    const health = await call<{ problems: string[] }>("GET", "/api/health")
    expect(health.problems.join("\n")).not.toMatch(/Claude isn't signed in/)

    // 3. The Coordinator's next turn signs in with the saved token and answers.
    const seen = failed.length
    await call("POST", "/api/chat", { content: "status" })
    await waitFor(async () => (await chatSince(seen)).some((m) => m.role === "assistant"), "the Coordinator's reply")
    await idle()
    expect((await chatSince(seen)).some((m) => m.role === "error")).toBe(false)

    // 4. So does a new agent turn in a box: the task runs to done.
    const project = await call<Project>("POST", "/api/projects", { name: "demo" })
    const task = await call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt: "say hello" })
    const done = await waitFor(async () => {
      const t = await call<Task>("GET", `/api/tasks/${task.id}`)
      return t.status === "done" || t.status === "failed" ? t : null
    }, "the task to finish")
    expect(done.status).toBe("done")
    // The token reached the agent through its turn's task.json, never the browser.
    const taskJson = fs.readFileSync(path.join(boxes, done.boxId!, "tasks", task.id, "task.json"), "utf8")
    expect(JSON.parse(taskJson).env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
    expect(JSON.stringify(await call("GET", `/api/tasks/${task.id}`))).not.toContain(TOKEN)
  })
})
