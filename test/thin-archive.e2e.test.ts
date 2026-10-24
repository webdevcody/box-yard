import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { BoxResize, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Heavy repos can always be archived and moved. A task whose git history alone is over BOXYARD_ARCHIVE_MAX_MB
// (a clone from before tasks shared the box mirror, or one that fetched a big branch itself) gets a thin archive
// and comes back on the new box whole. A merged and fully pushed task needs no archive at all.

const MB = 1024 * 1024

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, maxBoxes: 3, archiveMaxMb: 1, ...overrides }), { webDir: "/nonexistent" })
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
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running"), "resizes to settle").catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 300))
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim()
const random = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)))

/** A file:// origin set up like GitHub, with `commits` × `size` of incompressible history on main. */
function origin(commits: number, size: number) {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(seed, `asset-${i}.bin`), random(size))
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `assets ${i}`)
  }
  git(seed, "push", "-q", bare, "main")
  /** Push a branch with one big commit on top of main. */
  const pushHeavy = (branch: string, bytes: number) => {
    git(seed, "checkout", "-q", "-B", branch, "main")
    fs.writeFileSync(path.join(seed, `${branch}.bin`), random(bytes))
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `heavy ${branch}`)
    git(seed, "push", "-q", bare, branch)
    git(seed, "checkout", "-q", "main")
  }
  return { url: `file://${bare}`, bare, pushHeavy }
}

// Push at turn end off: these tests are about the full-archive chain that a task without a pushed branch falls back to.
async function repoProject(r: Running, name: string, url: string) {
  const p = await call<Project>(r, "POST", "/api/projects", { name, pushAtTurnEnd: false })
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(url, p.id)
  return p
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const doneTask = async (r: Running, projectId: string, title: string) => {
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "write a haiku" })
  const done = await waitFor(async () => {
    const x = await getTask(r, t.id)
    return x.status === "done" && x.lastArchivedAt && x.pendingCount === 0 ? x : null
  }, `task ${t.id} to finish and archive`)
  await new Promise((res) => setTimeout(res, 500))
  return done
}
const workOf = (r: Running, boxId: string, id: string) => path.join(r.yard.tasks.taskDir(boxId, id), "work")
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const stale = (r: Running, id: string) => r.yard.store.updateTask(id, { lastArchivedAt: 1 }, { touch: false })
async function resize(r: Running, boxId: string): Promise<BoxResize> {
  await call(r, "POST", `/api/boxes/${boxId}/resize`, { size: "medium" })
  return waitFor(() => {
    const rep = r.yard.tasks.resizeReport(boxId)
    return rep && rep.status !== "running" ? rep : null
  }, `the resize of ${boxId}`, 60_000)
}
/** Send a message and wait for that turn to end on the task's (new) box. */
async function nextTurn(r: Running, id: string) {
  const before = (await getTask(r, id)).turnCount
  await call(r, "POST", `/api/tasks/${id}/messages`, { content: "one more haiku" })
  return waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && t.turnCount > before && t.pendingCount === 0 ? t : null
  }, `task ${id} to run again`, 60_000)
}

/** Unpushed commits, a staged edit, an unstaged edit and an untracked file. */
function localWork(work: string) {
  fs.writeFileSync(path.join(work, "local.txt"), "committed, never pushed\n")
  git(work, "add", "local.txt")
  git(work, "commit", "-qm", "unpushed work")
  fs.writeFileSync(path.join(work, "README.md"), "staged edit\n")
  git(work, "add", "README.md")
  fs.writeFileSync(path.join(work, "local.txt"), "unstaged edit\n")
  fs.writeFileSync(path.join(work, "notes.md"), "untracked\n")
}
const state = (work: string) => ({
  head: git(work, "rev-parse", "HEAD"),
  branch: git(work, "symbolic-ref", "HEAD"),
  unpushed: git(work, "log", "-1", "--format=%s"),
  // fake-claude rewrites box-yard-demo.md every turn; everything else must be as it was.
  status: git(work, "status", "--porcelain").split("\n").filter((l) => l && !l.includes("box-yard-demo.md")),
  files: Object.fromEntries(["README.md", "local.txt", "notes.md"].map((f) => [f, fs.readFileSync(path.join(work, f), "utf8")])),
})
const archiveSize = (r: Running, id: string) => fs.statSync(r.yard.store.getTaskRow(id)!.archive_path!).size
const THIN_EVENT = "Workspace and git history were too big to archive; saved the Claude session, the branch and the commits GitHub doesn't have."

describe("heavy repos archive thin and move", () => {
  it("an old self-contained clone with heavy history archives under the cap and comes back whole after a resize", async () => {
    const o = origin(4, 2 * MB)
    const r = await start()
    const p = await repoProject(r, "game", o.url)
    const t = await doneTask(r, p.id, "fix lag at dawn")
    const box = t.boxId!
    const work = workOf(r, box, t.id)
    // Make it like a clone from before shared objects: every object in its own .git, nothing borrowed.
    git(work, "repack", "-a", "-d", "-q")
    fs.rmSync(path.join(work, ".git", "objects", "info", "alternates"))
    expect(Number(git(work, "count-objects", "-v").match(/size-pack: (\d+)/)![1])).toBeGreaterThan(7 * 1024)
    localWork(work)
    const before = state(work)
    stale(r, t.id)

    const rep = await resize(r, box)
    expect(rep.error).toBeNull()
    expect(rep.status).toBe("done")
    expect(rep.movedTasks).toEqual([t.id])
    expect(archiveSize(r, t.id)).toBeLessThan(1 * MB)
    expect(events(r, t.id).some((e) => e.startsWith(THIN_EVENT))).toBe(true)

    const back = await nextTurn(r, t.id)
    expect(back.boxId).toBe(rep.newBoxId)
    expect(state(workOf(r, rep.newBoxId!, t.id))).toEqual(before)
  })

  it("a shared-object clone that fetched a heavy branch itself archives thin too", async () => {
    const o = origin(1, 64 * 1024)
    const r = await start()
    const p = await repoProject(r, "game", o.url)
    const t = await doneTask(r, p.id, "merge the asset branch")
    const box = t.boxId!
    const work = workOf(r, box, t.id)
    // Pushed after the box's mirror was synced: the task fetches it into its own objects.
    o.pushHeavy("assets", 3 * MB)
    git(work, "fetch", "-q", "origin", "assets:refs/remotes/origin/assets")
    git(work, "merge", "-q", "--no-edit", "origin/assets")
    expect(fs.existsSync(path.join(work, ".git", "objects", "info", "alternates"))).toBe(true)
    localWork(work)
    const before = state(work)
    stale(r, t.id)

    const rep = await resize(r, box)
    expect(rep.status).toBe("done")
    expect(archiveSize(r, t.id)).toBeLessThan(1 * MB)
    expect(events(r, t.id).some((e) => e.startsWith(THIN_EVENT))).toBe(true)
    await nextTurn(r, t.id)
    const moved = workOf(r, rep.newBoxId!, t.id)
    expect(state(moved)).toEqual(before)
    expect(fs.readFileSync(path.join(moved, "assets.bin")).length).toBe(3 * MB)
  })

  it("a merged and fully pushed task skips the archive during a resize and resumes from a recap", async () => {
    const o = origin(4, 2 * MB)
    const r = await start()
    const p = await repoProject(r, "game", o.url)
    const t = await doneTask(r, p.id, "shipped")
    const box = t.boxId!
    const work = workOf(r, box, t.id)
    git(work, "add", "-A")
    git(work, "commit", "-qm", "haiku")
    git(work, "push", "-q", "origin", "HEAD")
    r.yard.store.updateTask(t.id, { prUrl: "https://github.com/o/r/pull/7", prState: "merged" })
    stale(r, t.id)

    const rep = await resize(r, box)
    expect(rep.status).toBe("done")
    expect(rep.steps.find((s) => s.key === "archive")?.detail).toBe("1 restorable from GitHub (PR merged, nothing unpushed)")
    const row = r.yard.store.getTaskRow(t.id)!
    expect(row.archive_path).toBeNull()
    expect(row.box_id).toBe(rep.newBoxId)
    expect(r.yard.tasks.resumeMode(t.id)).toBe("box")
    expect(events(r, t.id)).toContain(
      "No archive needed to move to the medium box: its PR #7 is merged and nothing in the workspace was unpushed, so GitHub has all of it. The next message starts from a recap.",
    )
    expect(events(r, t.id)).toContain(`Moved to box ${rep.newBoxId} (medium) while ${box} was resized. The next turn starts from a recap, on a fresh checkout of its branch.`)

    const back = await nextTurn(r, t.id)
    expect(back.boxId).toBe(rep.newBoxId)
    expect(events(r, t.id).some((e) => e.startsWith("Resumed from a recap"))).toBe(true)
    expect(git(workOf(r, rep.newBoxId!, t.id), "log", "-1", "--format=%s")).toBe("haiku")
  })

  it("Delete box and Clear box let merged and fully pushed tasks go without an archive too", async () => {
    const o = origin(1, 64 * 1024)
    const r = await start({ archiveWorkspaces: false })
    const p = await repoProject(r, "game", o.url)
    const shipped = async (title: string, pr: number) => {
      // Archiving is off, so wait for the turn only.
      const created = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title, prompt: "write a haiku" })
      const t = await waitFor(async () => {
        const x = await getTask(r, created.id)
        return x.status === "done" && x.pendingCount === 0 ? x : null
      }, `${title} to finish`)
      const work = workOf(r, t.boxId!, t.id)
      git(work, "add", "-A")
      git(work, "commit", "-qm", "haiku")
      git(work, "push", "-q", "origin", "HEAD")
      r.yard.store.updateTask(t.id, { prUrl: `https://github.com/o/r/pull/${pr}`, prState: "merged" })
      return t
    }
    // With archiving off, any task that needed an archive would block both operations.
    const a = await shipped("first", 1)
    const cleared = await call<{ steps: { key: string; removed: string[] }[] }>(r, "POST", `/api/boxes/${a.boxId}/clear`, {})
    expect(cleared.steps.find((s) => s.key === "archive")?.removed).toEqual([`${a.id} (PR merged, nothing unpushed)`])
    expect(r.yard.store.getTaskRow(a.id)!.box_id).toBeNull()

    const b = await shipped("second", 2)
    await call(r, "DELETE", `/api/boxes/${b.boxId}`)
    expect(events(r, b.id)).toContain(
      `No archive needed to delete box ${b.boxId}: its PR #2 is merged and nothing in the workspace was unpushed, so GitHub has all of it. The next message starts from a recap.`,
    )
    expect(r.yard.tasks.resumeMode(b.id)).toBe("recap")
  })
})
