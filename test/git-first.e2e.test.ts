import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Git-first archives (server/gitFirst.ts): after every turn the task's branch and its uncommitted work go to
// origin (the work on the hidden ref refs/boxyard/wip/<task>), the archive keeps only what git can't carry, and
// a fresh box rebuilds the folder from both. Origin is a local bare repo served over file://, set up like GitHub.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, ...overrides }), { webDir: "/nonexistent", provider })
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
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running"), "box work to settle").catch(() => {})
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

// Reads don't refresh the index, so comparing it before and after shows what Box Yard wrote.
const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe", env }).toString().trim()

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const send = (r: Running, taskId: string, content: string) => call<Task>(r, "POST", `/api/tasks/${taskId}/messages`, { content })
/** The task finished `turnCount` turns and archived (and pushed) after `since`. */
const archivedDone = (r: Running, id: string, turnCount = 1, since = 0) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return t.status === "done" && t.turnCount >= turnCount && (t.lastArchivedAt ?? 0) > since && !t.pendingCount ? t : null
  }, `task ${id} to finish and archive`)
/** Send a message and wait for that turn's archive. */
async function turn(r: Running, id: string, content: string, turnCount: number) {
  const since = Date.now()
  await send(r, id, content)
  return archivedDone(r, id, turnCount, since)
}
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)

/** A bare origin with a small main branch; `heavy` adds that many MB of incompressible history and a 2 MB asset. */
function origin(o: { heavy?: number } = {}) {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n.env\n")
  fs.mkdirSync(path.join(seed, "src"))
  fs.writeFileSync(path.join(seed, "src", "app.js"), "console.log('app')\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  for (let i = 0; i < (o.heavy ?? 0); i++) {
    fs.writeFileSync(path.join(seed, "asset.bin"), crypto.randomBytes(i === (o.heavy ?? 0) - 1 ? 2 * 1024 * 1024 : 1024 * 1024))
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `asset v${i + 1}`)
  }
  git(seed, "push", "-q", bare, "main")
  const refs = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)")
  const ref = (name: string) => refs().split("\n").find((l) => l.startsWith(`${name} `))?.split(" ")[1] ?? null
  return { url: `file://${bare}`, bare, root, ref }
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
const listing = (archive: string) => execFileSync("tar", ["tzf", archive]).toString().split("\n").filter(Boolean)
const wip = (t: Task) => `refs/boxyard/wip/${t.id}`
/** Lose the box: no task folder and no repo mirror, like a fresh box. */
function freshBox(r: Running, t: Task) {
  const dir = r.yard.tasks.taskDir(t.boxId!, t.id)
  r.yard.store.updateTask(t.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(dir, "..", "..", ".boxyard", "repos"), { recursive: true, force: true })
}
/** Status lines without fake-claude's file, which every turn rewrites. */
const status = (work: string) =>
  git(work, "status", "--porcelain=v2", "--untracked-files=all")
    .split("\n")
    .filter((l) => l && !l.endsWith("box-yard-demo.md"))
    .sort()

/**
 * A task folder with every kind of work in it: a commit on the branch, a staged edit with an unstaged edit on
 * top, an unstaged deletion, a new staged file, an untracked file, ignored files, a local branch and a stash.
 */
function busyWork(work: string) {
  fs.writeFileSync(path.join(work, "own.txt"), "committed\n")
  git(work, "add", "own.txt")
  git(work, "commit", "-qm", "own commit")
  git(work, "branch", "spike")
  git(work, "checkout", "-q", "spike")
  fs.writeFileSync(path.join(work, "spike.txt"), "a side idea\n")
  git(work, "add", "spike.txt")
  git(work, "commit", "-qm", "spike work")
  git(work, "checkout", "-q", "-")
  fs.writeFileSync(path.join(work, "README.md"), "parked edit\n")
  git(work, "stash", "push", "-q", "-m", "parked")
  fs.writeFileSync(path.join(work, "README.md"), "staged edit\n")
  git(work, "add", "README.md")
  fs.writeFileSync(path.join(work, "README.md"), "staged edit\nthen an unstaged one\n")
  fs.writeFileSync(path.join(work, "new.txt"), "new and staged\n")
  git(work, "add", "new.txt")
  fs.rmSync(path.join(work, "src", "app.js"))
  fs.writeFileSync(path.join(work, "notes.md"), "untracked\n")
  fs.writeFileSync(path.join(work, ".env"), "SECRET=1\n")
  fs.mkdirSync(path.join(work, "node_modules", "dep"), { recursive: true })
  fs.writeFileSync(path.join(work, "node_modules", "dep", "index.js"), "module.exports = 1\n")
}

describe("push at turn end", () => {
  it("pushes the branch and the uncommitted work without touching the repo, and the archive keeps only what git can't", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "first")
    // fake-claude's file is untracked: the turn-end push put it on the WIP ref, and the branch has no commits yet.
    expect(git(o.bare, "show", `${wip(t)}:box-yard-demo.md`)).toContain("Mock result")
    expect(o.ref(`refs/heads/${t.branch}`)).toBeNull()
    expect(t.pushState).toMatchObject({ status: "pushed", branch: t.branch, wip: o.ref(wip(t)), reason: null })

    const work = workOf(r, t)
    busyWork(work)
    // Everything a write to the repo would change. (The push itself adds origin/<branch>, git's view of origin.)
    const state = () => ({
      status: git(work, "status", "--porcelain=v2", "--untracked-files=all"),
      index: crypto.createHash("sha256").update(fs.readFileSync(path.join(work, ".git", "index"))).digest("hex"),
      head: git(work, "rev-parse", "HEAD"),
      refs: git(work, "for-each-ref")
        .split("\n")
        .filter((l) => !l.endsWith(`refs/remotes/origin/${t.branch}`))
        .join("\n"),
      reflog: git(work, "reflog"),
      objects: git(work, "count-objects", "-v"),
    })
    const before = state()
    await r.yard.tasks.archive(t.id)
    expect(state()).toEqual(before)

    // Origin: the branch at the task's commit, and the WIP commit with HEAD, the index commit and the extras as
    // parents. Its tree is the working tree; the index commit's is what was staged.
    expect(o.ref(`refs/heads/${t.branch}`)).toBe(before.head)
    const w = o.ref(wip(t))!
    expect(git(o.bare, "rev-parse", `${w}^1`)).toBe(before.head)
    expect(git(o.bare, "show", `${w}:README.md`)).toBe("staged edit\nthen an unstaged one")
    expect(git(o.bare, "show", `${w}^2:README.md`)).toBe("staged edit")
    expect(git(o.bare, "show", `${w}^2:new.txt`)).toBe("new and staged")
    expect(git(o.bare, "show", `${w}:notes.md`)).toBe("untracked")
    expect(git(o.bare, "ls-tree", "--name-only", `${w}^2`, "src")).toBe("src")
    expect(git(o.bare, "ls-tree", "--name-only", w, "src")).toBe("")
    expect(git(o.bare, "ls-tree", "--name-only", w)).not.toContain(".env")
    expect(git(o.bare, "log", "--format=%s", w)).toContain("spike work")
    expect(git(o.bare, "log", "--format=%s", w)).toContain(`On ${t.branch}: parked`)
    expect((await getTask(r, t.id)).pushState).toMatchObject({ status: "pushed", head: before.head, wip: w })

    // The archive: session, log, ignored files and the manifest. No repo, no checkout, no node_modules.
    const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
    const files = listing(archive)
    expect(files).toEqual(expect.arrayContaining([`${t.id}/git.manifest`, `${t.id}/events.jsonl`, `${t.id}/work/.env`]))
    expect(files.filter((f) => f.startsWith(`${t.id}/work/`) && f !== `${t.id}/work/.env`)).toEqual([])
    expect(fs.statSync(archive).size).toBeLessThan(64 * 1024)
  })

  it("restores on a fresh box: branch, HEAD, staged and unstaged changes, untracked and ignored files, local branches and stashes", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "round trip")
    const work = workOf(r, t)
    busyWork(work)
    const before = { status: status(work), staged: git(work, "diff", "--cached"), head: git(work, "rev-parse", "HEAD"), stash: git(work, "stash", "list") }
    await r.yard.tasks.archive(t.id)

    freshBox(r, t)
    const back = await turn(r, t.id, "continue", 2)
    expect(events(r, t.id)).toContain(`Workspace restored on box ${back.boxId}: its session from the archive, its code from git.`)
    const restored = workOf(r, back)
    expect(git(restored, "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch)
    expect(git(restored, "rev-parse", "HEAD")).toBe(before.head)
    expect(git(restored, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${t.branch}`)
    expect(status(restored)).toEqual(before.status)
    expect(git(restored, "diff", "--cached")).toBe(before.staged)
    expect(fs.readFileSync(path.join(restored, "README.md"), "utf8")).toBe("staged edit\nthen an unstaged one\n")
    expect(fs.readFileSync(path.join(restored, "notes.md"), "utf8")).toBe("untracked\n")
    expect(fs.readFileSync(path.join(restored, ".env"), "utf8")).toBe("SECRET=1\n")
    expect(fs.existsSync(path.join(restored, "src", "app.js"))).toBe(false)
    expect(git(restored, "stash", "list")).toBe(before.stash)
    expect(git(restored, "stash", "show", "-p")).toContain("+parked edit")
    expect(git(restored, "log", "-1", "--format=%s", "spike")).toBe("spike work")
    // No leftovers of the restore, and the next turn-end push works on top of it.
    expect(fs.existsSync(path.join(restored, "..", ".boxyard-clone"))).toBe(false)
    expect(fs.existsSync(path.join(restored, "..", "git.pack"))).toBe(false)
    expect(git(restored, "for-each-ref", "refs/boxyard")).toBe("")
    expect(back.pushState).toMatchObject({ status: "pushed", wip: o.ref(wip(t)) })
  })

  it("drops the WIP ref once the work is committed and pushed, when the task is closed, and when it's deleted", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "commits everything")
    const work = workOf(r, t)
    expect(o.ref(wip(t))).not.toBeNull()

    // Everything committed: the branch goes to origin and the WIP ref goes away.
    git(work, "add", "-A")
    git(work, "commit", "-qm", "haiku")
    await r.yard.tasks.archive(t.id)
    expect(o.ref(`refs/heads/${t.branch}`)).toBe(git(work, "rev-parse", "HEAD"))
    expect(o.ref(wip(t))).toBeNull()
    expect((await getTask(r, t.id)).pushState).toMatchObject({ status: "pushed", wip: null })
    expect(listing(r.yard.store.getTaskRow(t.id)!.archive_path!)).toContain(`${t.id}/git.manifest`)

    // Closing: the archive's pack carries the uncommitted work, so the WIP ref goes, and the work still comes back.
    fs.writeFileSync(path.join(work, "notes.md"), "written before closing\n")
    await call(r, "POST", `/api/tasks/${t.id}/close`)
    await waitFor(async () => ((await getTask(r, t.id)).boxId === null ? true : null), "the closed task's workspace to go")
    expect(o.ref(wip(t))).toBeNull()
    expect((await getTask(r, t.id)).pushState?.wip).toBeNull()
    expect(listing(r.yard.store.getTaskRow(t.id)!.archive_path!)).toContain(`${t.id}/git.pack`)
    const back = await turn(r, t.id, "one more thing", 2)
    expect(fs.readFileSync(path.join(workOf(r, back), "notes.md"), "utf8")).toBe("written before closing\n")

    // Deleting the task deletes its WIP ref.
    expect(o.ref(wip(t))).not.toBeNull()
    await call(r, "DELETE", `/api/tasks/${t.id}`)
    expect(o.ref(wip(t))).toBeNull()
    expect(o.ref(`refs/heads/${t.branch}`)).not.toBeNull()
  })

  it("restores from the archive's own pack when origin lost the branch and the WIP ref", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "origin forgets")
    const work = workOf(r, t)
    busyWork(work)
    const before = { status: status(work), head: git(work, "rev-parse", "HEAD") }
    await r.yard.tasks.archive(t.id)
    expect(listing(r.yard.store.getTaskRow(t.id)!.archive_path!)).toContain(`${t.id}/git.pack`)
    // Someone deletes the branch and the hidden ref on origin, and its commits are garbage collected.
    git(o.bare, "update-ref", "-d", `refs/heads/${t.branch}`)
    git(o.bare, "update-ref", "-d", wip(t))
    git(o.bare, "reflog", "expire", "--expire=now", "--all")
    git(o.bare, "gc", "-q", "--prune=now")
    expect(() => git(o.bare, "cat-file", "-e", before.head)).toThrow()

    freshBox(r, t)
    const back = await turn(r, t.id, "continue", 2)
    const restored = workOf(r, back)
    expect(git(restored, "rev-parse", "HEAD")).toBe(before.head)
    expect(status(restored)).toEqual(before.status)
    expect(git(restored, "log", "-1", "--format=%s", "spike")).toBe("spike work")
  })

  it("without write access it skips quietly, says so once, and keeps the full archive", async () => {
    const o = origin()
    // What GitHub says when the token can only read.
    fs.writeFileSync(path.join(o.bare, "hooks", "pre-receive"), `#!/bin/sh\necho "Permission to o/r.git denied to box-yard-bot." >&2\nexit 1\n`, { mode: 0o755 })
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "read only")
    expect(t.pushState).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^no write access to origin \(.*Permission to o\/r\.git denied/) })
    expect(o.ref(wip(t))).toBeNull()
    const skipped = (r2: Running) => events(r2, t.id).filter((e) => e.startsWith("Skipped the turn-end push"))
    expect(skipped(r)).toHaveLength(1)
    expect(skipped(r)[0]).toMatch(/^Skipped the turn-end push \(no write access to origin \(.*\)\)\. The archive keeps the whole workspace instead\.$/)
    const files = listing(r.yard.store.getTaskRow(t.id)!.archive_path!)
    expect(files).toEqual(expect.arrayContaining([`${t.id}/work/box-yard-demo.md`, `${t.id}/work/README.md`, `${t.id}/work/.git/HEAD`]))
    expect(files).not.toContain(`${t.id}/git.manifest`)

    // Another turn: still skipped, no second event.
    await turn(r, t.id, "again", 2)
    expect(skipped(r)).toHaveLength(1)
    expect((await getTask(r, t.id)).pushState?.status).toBe("skipped")
  })

  it("keeps the full archive for what a snapshot can't carry: a merge in progress", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "mid-merge")
    const work = workOf(r, t)
    fs.writeFileSync(path.join(work, ".git", "MERGE_HEAD"), `${git(work, "rev-parse", "HEAD")}\n`)
    await r.yard.tasks.archive(t.id)
    expect((await getTask(r, t.id)).pushState).toMatchObject({ status: "skipped", reason: "a merge, rebase or cherry-pick is in progress" })
    expect(listing(r.yard.store.getTaskRow(t.id)!.archive_path!)).toContain(`${t.id}/work/.git/MERGE_HEAD`)
  })

  it("a restore that can't reach origin stops with an error, leaves no half-built folder, and works once origin is back", async () => {
    const o = origin()
    const r = await start()
    const p = await repoProject(r, "alpha", o.url)
    const t = await startTask(r, p.id, "offline")
    fs.writeFileSync(path.join(workOf(r, t), "notes.md"), "keep me\n")
    await r.yard.tasks.archive(t.id)
    const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
    const dir = r.yard.tasks.taskDir(t.boxId!, t.id)

    freshBox(r, t)
    fs.renameSync(o.bare, `${o.bare}.away`)
    await send(r, t.id, "continue")
    const failed = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.status === "failed" ? x : null
    }, "the restore to fail")
    expect(failed.error).toMatch(/^Couldn't start the agent: restoring workspace failed: git clone failed: .*does not appear to be a git repository/)
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(archive)).toBe(true)

    fs.renameSync(`${o.bare}.away`, o.bare)
    const since = Date.now()
    await call(r, "POST", `/api/tasks/${t.id}/retry`)
    const back = await archivedDone(r, t.id, 2, since)
    expect(fs.readFileSync(path.join(workOf(r, back), "notes.md"), "utf8")).toBe("keep me\n")
  })
})

describe("push at turn end setting", () => {
  it("is on by default, follows the project's override, then Settings, and pushes nothing when off", async () => {
    const o = origin()
    const r = await start()
    const off = await start({ gitPushAtTurnEnd: false })
    expect(r.yard.tasks.pushAtTurnEnd({ repo: o.url, pushAtTurnEnd: null })).toBe(true)
    expect(r.yard.tasks.pushAtTurnEnd({ repo: null, pushAtTurnEnd: true })).toBe(false)
    expect(off.yard.tasks.pushAtTurnEnd({ repo: o.url, pushAtTurnEnd: null })).toBe(false)
    expect(off.yard.tasks.pushAtTurnEnd({ repo: o.url, pushAtTurnEnd: true })).toBe(true)

    const p = await repoProject(r, "alpha", o.url, { pushAtTurnEnd: false })
    expect(p.pushAtTurnEnd).toBe(false)
    const t = await startTask(r, p.id, "kept here")
    expect(o.ref(wip(t))).toBeNull()
    expect(t.pushState ?? null).toBeNull()
    expect(listing(r.yard.store.getTaskRow(t.id)!.archive_path!)).toContain(`${t.id}/work/.git/HEAD`)

    // Back to the default (Settings: on): the next turn pushes.
    const cleared = await call<Project>(r, "PATCH", `/api/projects/${p.id}`, { pushAtTurnEnd: null })
    expect(cleared.pushAtTurnEnd).toBeNull()
    const pushed = await turn(r, t.id, "now push", 2)
    expect(git(o.bare, "show", `${wip(t)}:box-yard-demo.md`)).toContain("now push")
    expect(pushed.pushState).toMatchObject({ status: "pushed" })

    // Settings off: the project follows it again.
    const saved = await call<{ settings: { gitPushAtTurnEnd: boolean } }>(r, "PUT", "/api/agent-settings", { gitPushAtTurnEnd: false })
    expect(saved.settings.gitPushAtTurnEnd).toBe(false)
    expect(r.yard.tasks.pushAtTurnEnd(cleared)).toBe(false)
  })
})

describe("box operations with small archives", () => {
  it("resizes a box of heavy-repo tasks through archives of a few KB, and each task gets its work back", async () => {
    const o = origin({ heavy: 3 })
    const r = await start({ archiveMaxMb: 1, maxBoxes: 3 })
    const p = await repoProject(r, "alpha", o.url)
    const a = await startTask(r, p.id, "first")
    const b = await startTask(r, p.id, "second")
    const box = a.boxId!
    expect(b.boxId).toBe(box)
    // The checkout alone is over the archive cap.
    expect(fs.statSync(path.join(workOf(r, a), "asset.bin")).size).toBe(2 * 1024 * 1024)
    for (const t of [a, b]) fs.writeFileSync(path.join(workOf(r, t), "notes.md"), `notes of ${t.title}\n`)
    for (const t of [a, b]) r.yard.store.updateTask(t.id, { lastArchivedAt: 1 }, { touch: false })

    await call(r, "POST", `/api/boxes/${box}/resize`, { size: "medium" })
    const rep = await waitFor(() => {
      const x = r.yard.tasks.resizeReport(box)
      return x && x.status !== "running" ? x : null
    }, "the resize")
    expect(rep.error).toBeNull()
    expect(rep.status).toBe("done")
    expect([...rep.movedTasks].sort()).toEqual([a.id, b.id].sort())
    for (const t of [a, b]) {
      const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
      expect(fs.statSync(archive).size).toBeLessThan(64 * 1024)
      expect(listing(archive)).not.toContain(`${t.id}/work/asset.bin`)
      expect(events(r, t.id).some((e) => e.startsWith("Workspace was too big"))).toBe(false)
    }

    const since = Date.now()
    for (const t of [a, b]) await send(r, t.id, "carry on")
    for (const t of [a, b]) {
      const back = await archivedDone(r, t.id, 2, since)
      expect(back.boxId).toBe(rep.newBoxId)
      const work = workOf(r, back)
      expect(fs.readFileSync(path.join(work, "notes.md"), "utf8")).toBe(`notes of ${t.title}\n`)
      expect(fs.statSync(path.join(work, "asset.bin")).size).toBe(2 * 1024 * 1024)
      expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch)
    }
  })
})
