import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { credentialSet, GLOBAL_CREDENTIALS } from "../server/turnCredentials.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// The box wall: an agent can read everything on its box (other workspaces, their task.json with the turn's tokens,
// the repo mirrors), so tasks of two credential sets never share a pool box. A project with its own Claude login or
// GitHub token in its env has a set of its own; the others share the global one.

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id && t.status !== "starting"), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(overrides: Partial<Config> = {}) {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent" })
  yard.captains.tuning.wakeDebounceMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json()
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
    return data as T
  }
  const project = (name: string, env: Record<string, string> = {}) => call<Project>("POST", "/api/projects", { name, env })
  /** A task's first turn, slow enough that it holds its box while the next one is placed. */
  const task = (p: Project, prompt = "Write a haiku [slow]") => call<Task>("POST", "/api/tasks", { projectId: p.id, title: prompt.slice(0, 20), prompt })
  const boxOf = (id: string) => waitFor(() => yard.store.getTaskRow(id)?.box_id ?? null, `task ${id} to get a box`, 30_000)
  const rest = (id: string) =>
    waitFor(() => {
      const t = yard.store.getTask(id)
      return t && ["done", "waiting", "failed"].includes(t.status) && !yard.store.getTaskRow(id)?.current_turn_id ? t : null
    }, `task ${id} to rest`, 30_000)
  return { yard, call, project, task, boxOf, rest }
}

describe("credentialSet", () => {
  it("is the project's own when its env has a Claude login or GitHub token, else the global one", () => {
    expect(credentialSet("prj_a", {})).toBe(GLOBAL_CREDENTIALS)
    expect(credentialSet("prj_a", { FOO: "1", GITHUB_TOKEN: "" })).toBe(GLOBAL_CREDENTIALS)
    expect(credentialSet("prj_a", { GITHUB_TOKEN: "t" })).toBe("project:prj_a")
    expect(credentialSet("prj_a", { GH_TOKEN: "t" })).toBe("project:prj_a")
    expect(credentialSet("prj_a", { ANTHROPIC_API_KEY: "k" })).toBe("project:prj_a")
    expect(credentialSet("prj_a", { CLAUDE_CODE_OAUTH_TOKEN: "o" })).toBe("project:prj_a")
  })
})

describe("the box wall", () => {
  it("never puts a project with its own credentials on another project's box, and says why it waits", async () => {
    const r = await start({ maxBoxes: 2, slotsPerBox: 4 })
    const plain = await r.project("plain")
    const own = await r.project("own", { GITHUB_TOKEN: "own-gh" })
    const other = await r.project("other")
    const another = await r.project("another", { CLAUDE_CODE_OAUTH_TOKEN: "another-oauth" })

    const a = await r.task(plain)
    const boxA = await r.boxOf(a.id)
    // The plain project's box has free slots, but the project with its own token gets a box of its own.
    const b = await r.task(own)
    const boxB = await r.boxOf(b.id)
    expect(boxB).not.toBe(boxA)
    expect(r.yard.store.getKv(`box_creds:${boxB}`)).toBe(`project:${own.id}`)
    expect(r.yard.store.getKv(`box_creds:${boxA}`)).toBeNull()

    // The pool is full: a project on the global credentials shares the plain project's box, never the other one.
    const c = await r.task(other)
    expect(await r.boxOf(c.id)).toBe(boxA)

    // Another project with its own login has no box it may use and none can be made: it waits, saying why.
    const d = await r.task(another)
    const waiting = await waitFor(() => r.yard.store.getTask(d.id)?.waitReason ?? null, "the task's wait reason")
    expect(waiting).toMatch(/its project has its own Claude login or GitHub token, so it never shares a box/)
    expect(r.yard.store.getTaskRow(d.id)?.box_id).toBeNull()
  })

  it("a resting task moves off its box when its project gets credentials of its own", async () => {
    const r = await start({ maxBoxes: 3, slotsPerBox: 4 })
    const p = await r.project("site")
    const q = await r.project("blog")
    const t = await r.task(p, "Write a haiku")
    const first = await r.boxOf(t.id)
    await r.rest(t.id)
    // Another project's work on the same box: the box stays on the global credentials.
    const u = await r.task(q, "Write a haiku")
    expect(await r.boxOf(u.id)).toBeTruthy()

    await r.call("PATCH", `/api/projects/${p.id}`, { env: { GITHUB_TOKEN: "site-gh" } })
    await r.call("POST", `/api/tasks/${t.id}/messages`, { content: "one more haiku" })
    const moved = await waitFor(() => {
      const box = r.yard.store.getTaskRow(t.id)?.box_id
      return box && box !== first ? box : null
    }, "the task to move to a box of its own", 30_000)
    expect(r.yard.store.getKv(`box_creds:${moved}`)).toBe(`project:${p.id}`)
    await r.rest(t.id)
    const events = r.yard.store.listTaskMessages(t.id, 100).filter((m) => m.role === "event").map((m) => m.content)
    expect(events).toContainEqual(`Moved from ${first} to ${moved}: its project has its own Claude login or GitHub token, so it gets boxes no other project uses.`)
  })
})
