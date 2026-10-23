import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

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
const archivedDone = (r: Running, id: string, turnCount = 1) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && t.turnCount >= turnCount && t.lastArchivedAt ? t : null
  }, `task ${id} to finish and archive`)

const DAY = 24 * 60 * 60_000

/** Make a task (and optionally its archive file) look untouched since `at`. */
function age(r: Running, id: string, at: number, archive = true) {
  r.yard.store.db.prepare("UPDATE tasks SET last_active_at = ?, updated_at = ? WHERE id = ?").run(at, at, id)
  const file = r.yard.store.getTaskRow(id)?.archive_path
  if (archive && file) fs.utimesSync(file, new Date(at), new Date(at))
}

const turnJson = (r: Running, t: Task) =>
  JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(t.boxId!, t.id), "turn.json"), "utf8")) as { prompt: string; sessionId: string; resume: boolean }
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)

/** A bare repo with one commit on main, to clone tasks from. */
function bareRepo() {
  const root = tmpDir("box-yard-repo-")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  /** Push a commit with `file` onto `branch` in origin. */
  const pushBranch = (branch: string, file: string) => {
    git(seed, "checkout", "-q", "-B", branch, "main")
    fs.writeFileSync(path.join(seed, file), "pushed\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `work on ${branch}`)
    git(seed, "push", "-q", bare, branch)
  }
  return { bare, pushBranch }
}

describe("resuming after retention", () => {
  it("restores a parked workspace from its archive and resumes the same session", async () => {
    const r = await start({ workspaceRetentionDays: 1, archiveRetentionDays: 0 })
    const p = await project(r, "alpha")
    const done = await archivedDone(r, (await task(r, p.id, "park me")).id)
    const oldDir = r.yard.tasks.taskDir(done.boxId!, done.id)
    // A repo that commits build output the archive leaves out by name, plus uncommitted work.
    const repo = path.join(oldDir, "work", "app")
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), content)
    }
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" })
    write("dist/lib.js", "committed dist\n")
    write("packages/ui/build/out.css", "committed build\n")
    write("src/keep.ts", "v1\n")
    write("src/gone.ts", "deleted on purpose\n")
    git("init", "-q")
    git("add", ".")
    git("commit", "-qm", "init")
    write("src/keep.ts", "v2 uncommitted\n")
    fs.rmSync(path.join(repo, "src", "gone.ts"))
    write("node_modules/left-pad/index.js", "x\n")
    await r.yard.tasks.archive(done.id)
    age(r, done.id, Date.now() - 2 * DAY, false)

    await r.yard.tasks.maintain()
    expect((await getTask(r, done.id)).boxId).toBeNull()
    expect(fs.existsSync(oldDir)).toBe(false)
    expect(r.yard.tasks.resumeMode(done.id)).toBe("archive")

    await send(r, done.id, "one more thing")
    const resumed = await archivedDone(r, done.id, 2)
    const turn = turnJson(r, resumed)
    expect(turn.resume).toBe(true)
    expect(turn.sessionId).toBe(done.sessionId)
    expect(resumed.sessionId).toBe(done.sessionId)
    const work = path.join(r.yard.tasks.taskDir(resumed.boxId!, resumed.id), "work")
    expect(fs.existsSync(path.join(work, "box-yard-demo.md"))).toBe(true)
    // Committed build dirs come back; uncommitted edits and deletions stay as archived.
    expect(fs.readFileSync(path.join(work, "app", "dist", "lib.js"), "utf8")).toBe("committed dist\n")
    expect(fs.readFileSync(path.join(work, "app", "packages", "ui", "build", "out.css"), "utf8")).toBe("committed build\n")
    expect(fs.readFileSync(path.join(work, "app", "src", "keep.ts"), "utf8")).toBe("v2 uncommitted\n")
    expect(fs.existsSync(path.join(work, "app", "src", "gone.ts"))).toBe(false)
    expect(fs.existsSync(path.join(work, "app", "node_modules"))).toBe(false)
    expect(events(r, done.id).some((e) => e.startsWith("Workspace restored on box"))).toBe(true)
    expect(events(r, done.id).some((e) => e.startsWith("Resumed from a recap"))).toBe(false)
  })

  it("starts a fresh session from a recap on a fresh checkout when the archive is gone", async () => {
    const { bare, pushBranch } = bareRepo()
    const r = await start({ workspaceRetentionDays: 1, archiveRetentionDays: 1, archiveKeepTouchedDays: 0 })
    const p = await project(r, "alpha")
    // The API only takes GitHub-style repos; point the project at a local bare repo instead.
    r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(bare, p.id)
    // One task's branch was pushed (it comes back from origin), the other's never was.
    const pushed = await archivedDone(r, (await task(r, p.id, "pushed work")).id)
    const local = await archivedDone(r, (await task(r, p.id, "local work")).id)
    pushBranch(pushed.branch!, "pushed.txt")
    r.yard.store.updateTask(pushed.id, { summary: "Fixed the widget and opened a PR." })
    for (const t of [pushed, local]) age(r, t.id, Date.now() - 2 * DAY)

    await r.yard.tasks.maintain()
    for (const t of [pushed, local]) {
      const row = r.yard.store.getTaskRow(t.id)!
      expect(row.box_id).toBeNull()
      expect(row.archive_path).toBeNull()
      expect(r.yard.tasks.resumeMode(t.id)).toBe("recap")
    }

    await send(r, pushed.id, "please also update the docs")
    const after = await archivedDone(r, pushed.id, 2)
    const turn = turnJson(r, after)
    expect(turn.resume).toBe(false)
    expect(after.sessionId).not.toBe(pushed.sessionId)
    expect(turn.sessionId).toBe(after.sessionId)
    expect(turn.prompt).toContain("Your previous Claude session for this task was lost")
    expect(turn.prompt).toContain(`Branch: ${pushed.branch}`)
    expect(turn.prompt).toContain("Last summary: Fixed the widget and opened a PR.")
    expect(turn.prompt).toContain("checked out from origin")
    expect(turn.prompt).toContain("please also update the docs")
    const work = path.join(r.yard.tasks.taskDir(after.boxId!, after.id), "work")
    expect(fs.readFileSync(path.join(work, "pushed.txt"), "utf8")).toBe("pushed\n")
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: work }).toString().trim()).toBe(pushed.branch)
    expect(events(r, pushed.id).some((e) => e.startsWith("Resumed from a recap") && e.includes(`fresh checkout of branch ${pushed.branch}`))).toBe(true)

    await send(r, local.id, "continue")
    const localAfter = await archivedDone(r, local.id, 2)
    expect(turnJson(r, localAfter).prompt).toContain(`Branch ${local.branch} no longer exists on origin, so it was recreated from main`)
    const localWork = path.join(r.yard.tasks.taskDir(localAfter.boxId!, localAfter.id), "work")
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: localWork }).toString().trim()).toBe(local.branch)
    expect(fs.existsSync(path.join(localWork, "README.md"))).toBe(true)
    expect(events(r, local.id).some((e) => e.startsWith("Resumed from a recap") && e.includes("recreated from main"))).toBe(true)
  })
})

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
    const r = await start({ archiveRetentionDays: 1, workspaceRetentionDays: 0, archiveKeepTouchedDays: 0 })
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

  it("keeps archives of tasks with an unmerged PR or recent activity, and prunes the rest", async () => {
    const r = await start({ archiveRetentionDays: 1, workspaceRetentionDays: 0, archiveKeepTouchedDays: 10 })
    const p = await project(r, "alpha")
    const names = ["open pr", "closed pr", "merged pr", "no pr", "recent"] as const
    const t: Record<(typeof names)[number], Task> = {} as never
    for (const name of names) t[name] = await archivedDone(r, (await task(r, p.id, name)).id)
    const setPr = (id: string, state: string | null) =>
      r.yard.store.db.prepare("UPDATE tasks SET pr_url = ?, pr_state = ? WHERE id = ?").run(`https://github.com/o/r/pull/${id.slice(-3)}`, state, id)
    setPr(t["open pr"].id, "open")
    setPr(t["closed pr"].id, "closed")
    setPr(t["merged pr"].id, "merged")
    // Old enough for archive retention, and past the 10-day "recently touched" guard...
    for (const name of ["open pr", "closed pr", "merged pr", "no pr"] as const) age(r, t[name].id, Date.now() - 20 * DAY)
    // ...except this one: its archive is old but it was touched 3 days ago.
    age(r, t.recent.id, Date.now() - 3 * DAY)
    fs.utimesSync(r.yard.store.getTaskRow(t.recent.id)!.archive_path!, new Date(Date.now() - 20 * DAY), new Date(Date.now() - 20 * DAY))
    const files = Object.fromEntries(names.map((n) => [n, r.yard.store.getTaskRow(t[n].id)!.archive_path!]))

    await r.yard.tasks.maintain()
    const kept = (n: (typeof names)[number]) => fs.existsSync(files[n]!) && r.yard.store.getTaskRow(t[n].id)!.archive_path === files[n]
    expect(kept("open pr")).toBe(true)
    expect(kept("closed pr")).toBe(true) // closed without merging: the work may still be wanted
    expect(kept("recent")).toBe(true)
    expect(kept("merged pr")).toBe(false)
    expect(kept("no pr")).toBe(false)
    expect(r.yard.tasks.resumeMode(t["no pr"].id)).toBe("box") // its folder is still on the box (workspace retention is off)
  })

  it("keeps every archive when archive retention is 0", async () => {
    const r = await start({ archiveRetentionDays: 0, workspaceRetentionDays: 0, archiveKeepTouchedDays: 0 })
    const p = await project(r, "alpha")
    const done = await archivedDone(r, (await task(r, p.id, "keep")).id)
    age(r, done.id, Date.now() - 400 * DAY)
    await r.yard.tasks.maintain()
    expect(r.yard.store.getTaskRow(done.id)!.archive_path).toBeTruthy()
  })
})
