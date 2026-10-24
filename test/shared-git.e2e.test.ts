import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { BoxCleanup, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Shared git objects (server/gitShare.ts): task checkouts borrow the box mirror's objects through alternates,
// mirrors are partial clones, and archives stay restorable. Origin is a local bare repo served over file://
// (a plain path would make git ignore --filter), set up like GitHub: filters and fetch-by-id allowed.

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()
const gitOk = (cwd: string, ...args: string[]) => {
  try {
    git(cwd, ...args)
    return true
  } catch {
    return false
  }
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const send = (r: Running, taskId: string, content: string) => call<Task>(r, "POST", `/api/tasks/${taskId}/messages`, { content })
const archivedDone = (r: Running, id: string, turnCount = 1) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && t.turnCount >= turnCount && t.lastArchivedAt ? t : null
  }, `task ${id} to finish and archive`)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)

/** A bare origin whose main has two versions of big.bin, so the first one is an "old blob". */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n")
  fs.writeFileSync(path.join(seed, "big.bin"), "first version of a big asset\n".repeat(200))
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  const oldBlob = git(seed, "rev-parse", "HEAD:big.bin")
  fs.writeFileSync(path.join(seed, "big.bin"), "second version of a big asset\n".repeat(200))
  git(seed, "commit", "-qam", "new asset")
  git(seed, "push", "-q", bare, "main")
  /** A branch on origin with one commit; returns its commit id. */
  const pushBranch = (branch: string) => {
    git(seed, "checkout", "-q", "-B", branch, "main")
    fs.writeFileSync(path.join(seed, `${branch}.txt`), `${branch}\n`)
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `work on ${branch}`)
    git(seed, "push", "-q", bare, branch)
    git(seed, "checkout", "-q", "main")
    return git(seed, "rev-parse", branch)
  }
  /** Delete a branch on origin; `forget` also drops its commits there, the way GitHub eventually does. */
  const deleteBranch = (branch: string, forget = false) => {
    git(bare, "branch", "-q", "-D", branch)
    if (forget) {
      git(bare, "reflog", "expire", "--expire=now", "--all")
      git(bare, "gc", "-q", "--prune=now")
    }
  }
  return { url: `file://${bare}`, bare, oldBlob, pushBranch, deleteBranch }
}

async function repoProject(r: Running, name: string, url: string, patch: Record<string, unknown> = {}) {
  const p = await call<Project>(r, "POST", "/api/projects", { name, ...patch })
  // The API only takes GitHub-style repos; point the project at the local origin instead.
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(url, p.id)
  return p
}

const startTask = async (r: Running, projectId: string, title: string) =>
  archivedDone(r, (await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "write a haiku" })).id)
const workOf = (r: Running, t: Task) => path.join(r.yard.tasks.taskDir(t.boxId!, t.id), "work")
const reposOf = (r: Running, boxId: string) => path.join(r.yard.tasks.taskDir(boxId, "x"), "..", "..", ".boxyard", "repos")
const mirrorOf = (r: Running, boxId: string) => {
  const repos = reposOf(r, boxId)
  const names = fs.readdirSync(repos).filter((n) => n.endsWith(".git"))
  expect(names).toHaveLength(1)
  return path.resolve(repos, names[0]!)
}
const alternates = (work: string) => fs.readFileSync(path.join(work, ".git", "objects", "info", "alternates"), "utf8").trim()
/** The objects a clone stores itself (loose count + packed count), not counting what it borrows. */
const ownObjects = (work: string) => {
  const v = Object.fromEntries(git(work, "count-objects", "-v").split("\n").map((l) => l.split(": ") as [string, string]))
  return Number(v.count) + Number(v["in-pack"])
}
const mirrorMissing = (mirror: string, oid: string) => git(mirror, "rev-list", "--objects", "--all", "--missing=print").split("\n").includes(`?${oid}`)
/** What the box's mirror fetch does before every new workspace. */
const fetchMirror = (mirror: string) => git(mirror, "fetch", "-q", "--prune", "origin")

async function cleanNow(r: Running, boxId: string) {
  await call(r, "POST", `/api/boxes/${boxId}/cleanup`)
  return waitFor(() => {
    const raw = r.yard.store.getKv(`box_cleanup:${boxId}`)
    const c = raw ? (JSON.parse(raw) as BoxCleanup) : null
    return c?.reason === "manual" && c.status !== "running" ? c : null
  }, "manual cleanup to finish")
}

describe("shared git objects", () => {
  it("task checkouts borrow the box mirror's objects, keep their own branches, and fetch old blobs on demand", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const a = await startTask(r, p.id, "first")
    const b = await startTask(r, p.id, "second")
    expect(b.boxId).toBe(a.boxId)

    const mirror = mirrorOf(r, a.boxId!)
    expect(git(mirror, "config", "remote.origin.partialclonefilter")).toBe("blob:none")
    expect(git(mirror, "config", "gc.pruneExpire")).toBe("never")
    for (const t of [a, b]) {
      const work = workOf(r, t)
      expect(alternates(work)).toBe(`${mirror}/objects`)
      expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch)
      expect(git(work, "remote", "get-url", "origin")).toBe(o.url)
      // The checkout's blobs were fetched into the mirror once, so neither task stored any objects itself.
      expect(ownObjects(work)).toBe(0)
      expect(git(work, "status", "--porcelain")).toBe("?? box-yard-demo.md")
    }
    expect(a.branch).not.toBe(b.branch)

    // The old version of big.bin is nowhere on the box until something reads it; then git fetches it.
    expect(mirrorMissing(mirror, o.oldBlob)).toBe(true)
    const work = workOf(r, a)
    expect(git(work, "show", "HEAD~1:big.bin")).toContain("first version of a big asset")
    expect(git(work, "log", "-p", "--format=%s", "-2", "--", "big.bin")).toContain("+second version")
    expect(git(work, "blame", "--porcelain", "HEAD~1", "--", "big.bin")).toContain("init")
    // Commits land in the task's own objects, and its branch pushes to origin.
    fs.writeFileSync(path.join(work, "note.md"), "mine\n")
    git(work, "add", "note.md")
    git(work, "commit", "-qm", "task a's change")
    git(work, "push", "-q", "origin", "HEAD")
    expect(git(o.bare, "log", "-1", "--format=%s", a.branch!)).toBe("task a's change")
    expect(ownObjects(work)).toBeGreaterThan(0)
    expect(ownObjects(workOf(r, b))).toBe(0)
    expect(git(mirror, "rev-list", "--all")).not.toContain(git(work, "rev-parse", "HEAD"))
  })

  // A partial mirror's gc keeps every object it fetched (they sit in promisor packs), so a full mirror is the
  // one where pruning could take objects a task borrows.
  it.each([
    ["full", false],
    ["partial", true],
  ])("deleting one task leaves a %s mirror and the other task intact, even when gc runs after a force-push", async (_mode, partialClone) => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url, { partialClone })
    const doomed = o.pushBranch("doomed")
    const a = await startTask(r, p.id, "first")
    const b = await startTask(r, p.id, "second")
    const mirror = mirrorOf(r, b.boxId!)
    const work = workOf(r, b)
    // b keeps a local branch on a commit it borrowed from the mirror...
    git(work, "branch", "keep-doomed", "origin/doomed")
    expect(ownObjects(work)).toBe(0)
    // ...and then that branch goes away on origin, so the mirror no longer reaches it.
    o.deleteBranch("doomed", true)
    fetchMirror(mirror)
    expect(gitOk(mirror, "rev-parse", "-q", "--verify", "refs/heads/doomed")).toBe(false)

    await call(r, "DELETE", `/api/tasks/${a.id}`)
    expect(fs.existsSync(path.dirname(workOf(r, a)))).toBe(false)
    const report = await cleanNow(r, b.boxId!)
    const gitStep = report.steps.find((s) => s.key === "git")!
    expect(gitStep.removed.join(" ")).toContain("kept unreachable objects: 1 task borrows from it")

    expect(fs.existsSync(mirror)).toBe(true)
    expect(git(work, "cat-file", "-t", doomed)).toBe("commit")
    expect(git(work, "log", "-1", "--format=%s", "keep-doomed")).toBe("work on doomed")
    expect(git(work, "status", "--porcelain")).toBe("?? box-yard-demo.md")
    expect(git(work, "show", "HEAD:README.md")).toBe("hello")

    // The retention pass doesn't remove a mirror a task folder still borrows from, whatever the database says.
    r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run("file:///elsewhere/other.git", p.id)
    await r.yard.tasks.maintain()
    r.yard.store.db.prepare("UPDATE tasks SET box_id = NULL WHERE id = ?").run(b.id)
    await (r.yard.tasks as unknown as { pruneUnusedRepoMirrors(): Promise<void> }).pruneUnusedRepoMirrors()
    expect(fs.existsSync(mirror)).toBe(true)
    expect(git(work, "cat-file", "-t", doomed)).toBe("commit")
  })

  it("archives restore onto a box with a fresh mirror, keeping the task's commits and objects GitHub dropped", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const feature = o.pushBranch("feature")
    const t = await startTask(r, p.id, "round trip")
    const boxId = t.boxId!
    const dir = path.dirname(workOf(r, t))
    const work = workOf(r, t)
    const mirror = mirrorOf(r, boxId)
    // Own work: a commit on the task's branch, plus uncommitted edits.
    fs.writeFileSync(path.join(work, "own.txt"), "committed\n")
    git(work, "add", "own.txt")
    git(work, "commit", "-qm", "own commit")
    const own = git(work, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(work, "README.md"), "edited, not committed\n")
    // Borrowed work: a local branch on origin's feature, which is then deleted there.
    git(work, "branch", "keep-feature", "origin/feature")
    o.deleteBranch("feature", true)
    fetchMirror(mirror)

    await r.yard.tasks.archive(t.id)
    const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
    const listing = execFileSync("tar", ["tzf", archive]).toString().split("\n")
    expect(listing).toContain(`${t.id}/git-keep.pack`)
    expect(listing.some((f) => f.startsWith(`${t.id}/work/.git/objects/pack/`))).toBe(true)
    expect(fs.existsSync(`/tmp/boxyard-archive-keep-${t.id}`)).toBe(false)

    // Another box: no task folder and no mirror yet (this one is fetched fresh from origin, without "feature").
    r.yard.store.updateTask(t.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(mirror, { recursive: true, force: true })
    await send(r, t.id, "continue")
    const back = await archivedDone(r, t.id, 2)
    expect(events(r, t.id)).toContain(`Workspace restored on box ${back.boxId}.`)

    const restored = workOf(r, back)
    const fresh = mirrorOf(r, back.boxId!)
    expect(alternates(restored)).toBe(`${fresh}/objects`)
    expect(gitOk(fresh, "cat-file", "-e", feature)).toBe(false)
    expect(git(restored, "cat-file", "-t", feature)).toBe("commit")
    expect(git(restored, "log", "-1", "--format=%s", "keep-feature")).toBe("work on feature")
    expect(git(restored, "rev-parse", "HEAD")).toBe(own)
    expect(git(restored, "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch)
    expect(fs.readFileSync(path.join(restored, "README.md"), "utf8")).toBe("edited, not committed\n")
    expect(git(restored, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? box-yard-demo.md", "M README.md"])
    expect(git(restored, "show", "HEAD~2:big.bin")).toContain("first version")
    expect(fs.existsSync(path.join(path.dirname(restored), "git-keep.pack"))).toBe(false)
  })

  it("refuses a restore whose shared objects can't be rebuilt, and restores once the repo is reachable again", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "offline restore")
    const dir = path.dirname(workOf(r, t))
    const mirror = mirrorOf(r, t.boxId!)
    r.yard.store.updateTask(t.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(mirror, { recursive: true, force: true })

    // Origin is unreachable: no mirror can be made, and the clone can't fetch what it borrowed either.
    fs.renameSync(o.bare, `${o.bare}.away`)
    await send(r, t.id, "continue")
    const failed = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.status === "failed" ? x : null
    }, "restore to fail")
    expect(failed.error).toContain("borrows objects from the repo mirror")
    expect(fs.existsSync(path.join(r.yard.tasks.taskDir(failed.boxId!, t.id), "work"))).toBe(false)
    expect(fs.existsSync(r.yard.store.getTaskRow(t.id)!.archive_path!)).toBe(true)

    fs.renameSync(`${o.bare}.away`, o.bare)
    await call(r, "POST", `/api/tasks/${t.id}/retry`)
    const back = await archivedDone(r, t.id, 2)
    expect(git(workOf(r, back), "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch)
    expect(git(workOf(r, back), "show", "HEAD~1:big.bin")).toContain("first version")
  })
})

describe("partial clone setting", () => {
  it("follows the project's override, then Settings, and re-makes an unused mirror to match", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url, { partialClone: false })
    expect(p.partialClone).toBe(false)
    const full = await startTask(r, p.id, "full mirror")
    const mirror = mirrorOf(r, full.boxId!)
    expect(gitOk(mirror, "config", "remote.origin.partialclonefilter")).toBe(false)
    expect(mirrorMissing(mirror, o.oldBlob)).toBe(false)
    const work = workOf(r, full)
    expect(alternates(work)).toBe(`${mirror}/objects`)
    expect(gitOk(work, "config", "remote.origin.promisor")).toBe(false)

    // Back to the default (Settings: on). The mirror stays full while a task borrows from it...
    const cleared = await call<Project>(r, "PATCH", `/api/projects/${p.id}`, { partialClone: null })
    expect(cleared.partialClone).toBeNull()
    expect(r.yard.tasks.partialClone(cleared)).toBe(true)
    const second = await startTask(r, p.id, "still full")
    expect(gitOk(mirrorOf(r, second.boxId!), "config", "remote.origin.partialclonefilter")).toBe(false)
    expect(gitOk(workOf(r, second), "config", "remote.origin.promisor")).toBe(false)

    // ...and is re-made as a partial clone once none does.
    await call(r, "DELETE", `/api/tasks/${full.id}`)
    await call(r, "DELETE", `/api/tasks/${second.id}`)
    const partial = await startTask(r, p.id, "partial now")
    const remade = mirrorOf(r, partial.boxId!)
    expect(git(remade, "config", "remote.origin.partialclonefilter")).toBe("blob:none")
    expect(mirrorMissing(remade, o.oldBlob)).toBe(true)
    expect(git(workOf(r, partial), "config", "remote.origin.promisor")).toBe("true")
    expect(events(r, partial.id).some((e) => e.startsWith("Re-created the box's mirror") && e.includes("partial (blob:none)"))).toBe(true)
  })

  it("is on by default and can be turned off in Settings", async () => {
    const on = await start()
    const off = await start({ gitPartialClone: false })
    const project = { partialClone: null }
    expect(on.yard.tasks.partialClone(project)).toBe(true)
    expect(off.yard.tasks.partialClone(project)).toBe(false)
    expect(off.yard.tasks.partialClone({ partialClone: true })).toBe(true)
    expect(on.yard.tasks.partialClone({ partialClone: false })).toBe(false)
    const saved = await call<{ settings: { gitPartialClone: boolean; buildCleanupIdleMinutes: number } }>(on, "PUT", "/api/agent-settings", { gitPartialClone: false, buildCleanupIdleMinutes: 30 })
    expect(saved.settings.gitPartialClone).toBe(false)
    expect(saved.settings.buildCleanupIdleMinutes).toBe(30)
    expect(on.yard.tasks.partialClone(project)).toBe(false)
  })
})
