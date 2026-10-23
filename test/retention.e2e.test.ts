import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const project = (r: Running, name: string) => call<Project>(r, "POST", "/api/projects", { name })
const task = (r: Running, projectId: string, title: string, prompt = "write a haiku") => call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })
const send = (r: Running, taskId: string, content: string) => call<Task>(r, "POST", `/api/tasks/${taskId}/messages`, { content })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const put = (file: string, content = "x\n") => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" })
const archivedDone = (r: Running, id: string, turnCount = 1) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && t.turnCount >= turnCount && t.lastArchivedAt ? t : null
  }, `task ${id} to finish and archive`)

describe("workspace retention", () => {
  it("removes generated directories after a resting task is safely archived", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const first = await archivedDone(r, (await task(r, p.id, "cleanup")).id)
    const dir = r.yard.tasks.taskDir(first.boxId!, first.id)
    const generated = path.join(dir, "work", "node_modules", "left-pad")
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, "index.js"), "module.exports = 1\n")

    await send(r, first.id, "continue")
    const second = await archivedDone(r, first.id, 2)

    expect(second.boxId).toBe(first.boxId)
    expect(fs.existsSync(path.join(dir, "work", "box-yard-demo.md"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "work", "node_modules"))).toBe(false)
  })

  it("only removes dirs git ignores and does not track, keeping committed build output", async () => {
    const r = await start()
    const p = await project(r, "alpha")
    const first = await archivedDone(r, (await task(r, p.id, "cleanup repo")).id)
    const work = path.join(r.yard.tasks.taskDir(first.boxId!, first.id), "work")
    const repo = path.join(work, "app") // a repo cloned into a subfolder of a scratch work/
    put(path.join(repo, ".gitignore"), "node_modules/\ndist/\n.next/\n")
    put(path.join(repo, "build", "index.html"), "<h1>committed</h1>\n")
    put(path.join(repo, "dist", "lib.js"), "committed despite .gitignore\n")
    put(path.join(repo, "packages", "ui", "build", "out.css"))
    git(repo, "init", "-q")
    git(repo, "add", ".gitignore", "build", "packages")
    git(repo, "add", "-f", "dist/lib.js")
    git(repo, "commit", "-qm", "init")
    put(path.join(repo, "dist", "extra.js")) // ignored file inside a tracked dir
    put(path.join(repo, "node_modules", "left-pad", "index.js"))
    put(path.join(repo, "packages", "ui", "node_modules", "x", "index.js"))
    put(path.join(repo, ".next", "cache", "a"))
    put(path.join(repo, "coverage", "lcov.info")) // untracked but not ignored: maybe the agent's work
    put(path.join(work, "notes", "build", "draft.md")) // outside any repo: not clearly generated
    put(path.join(work, "notes", "node_modules", "y", "index.js"))

    await send(r, first.id, "continue")
    await archivedDone(r, first.id, 2)

    const exists = (rel: string) => fs.existsSync(path.join(work, rel))
    expect(exists("app/build/index.html")).toBe(true)
    expect(exists("app/dist/lib.js")).toBe(true)
    expect(exists("app/dist/extra.js")).toBe(true)
    expect(exists("app/packages/ui/build/out.css")).toBe(true)
    expect(exists("app/coverage/lcov.info")).toBe(true)
    expect(exists("notes/build/draft.md")).toBe(true)
    expect(exists("app/node_modules")).toBe(false)
    expect(exists("app/packages/ui/node_modules")).toBe(false)
    expect(exists("app/.next")).toBe(false)
    expect(exists("notes/node_modules")).toBe(false)
    expect(git(repo, "status", "--porcelain").toString()).toBe("?? coverage/\n")
  })

  it("parks old resting workspaces only when a fresh archive exists", async () => {
    const old = Date.now() - 2 * 24 * 60 * 60_000
    const r = await start({ workspaceRetentionDays: 1 })
    const p = await project(r, "alpha")
    const done = await archivedDone(r, (await task(r, p.id, "park me")).id)
    const dir = r.yard.tasks.taskDir(done.boxId!, done.id)
    r.yard.store.updateTask(done.id, { lastActiveAt: old }, { touch: false })

    await r.yard.tasks.maintain()
    const parked = await getTask(r, done.id)
    expect(parked.boxId).toBeNull()
    expect(fs.existsSync(dir)).toBe(false)

    const unsafe = await start({ archiveWorkspaces: false, workspaceRetentionDays: 1 })
    const p2 = await project(unsafe, "beta")
    const unarchivedStarted = await task(unsafe, p2.id, "keep me")
    const unarchived = await waitFor(async () => {
      const t = await getTask(unsafe, unarchivedStarted.id)
      return t.status === "done" ? t : null
    }, "unarchived task to finish")
    const unsafeDir = unsafe.yard.tasks.taskDir(unarchived.boxId!, unarchived.id)
    unsafe.yard.store.updateTask(unarchived.id, { lastActiveAt: old }, { touch: false })

    await unsafe.yard.tasks.maintain()
    expect((await getTask(unsafe, unarchived.id)).boxId).toBe(unarchived.boxId)
    expect(fs.existsSync(unsafeDir)).toBe(true)
  })

  it("prunes old long-done archives and unused repo mirrors", async () => {
    const old = Date.now() - 2 * 24 * 60 * 60_000
    const r = await start({ archiveRetentionDays: 1, workspaceRetentionDays: 0 })
    const p = await project(r, "alpha")
    const done = await archivedDone(r, (await task(r, p.id, "archive")).id)
    const row = r.yard.store.getTaskRow(done.id)!
    fs.utimesSync(row.archive_path!, new Date(old), new Date(old))
    r.yard.store.updateTask(done.id, { lastActiveAt: old }, { touch: false })
    const mirror = path.join(r.yard.tasks.taskDir(done.boxId!, done.id), "..", "..", ".boxyard", "repos", "unused.git")
    fs.mkdirSync(mirror, { recursive: true })

    await r.yard.tasks.maintain()
    const pruned = r.yard.store.getTaskRow(done.id)!
    expect(pruned.archive_path).toBeNull()
    expect(fs.existsSync(row.archive_path!)).toBe(false)
    expect(fs.existsSync(mirror)).toBe(false)
  })
})
