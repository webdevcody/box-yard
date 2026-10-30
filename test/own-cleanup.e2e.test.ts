import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The cleanup of task folders on this computer (server/ownCleanup.ts), end to end with the local runner and a real
// git origin: a done task's build output goes once its work is pushed, Task folders kept archives and removes the
// oldest finished folder (which comes back on its next message), and the low-disk pass never touches a running task
// or a folder with uncommitted work.

interface Running {
  yard: BoxYard
  server: Server
  localRoot: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE), localRunner: new LocalRunnerProvider(config.localDir, FAKE_CLAUDE) })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, localRoot: config.localDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: ENV, encoding: "utf8" })

/** A bare origin served as file:// with a .gitignore for build output on main. */
function origin(): string {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\ndist/\ntmp/\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  return `file://${bare}`
}

async function localProject(r: Running, name: string): Promise<Project> {
  const res = await fetch(`http://127.0.0.1:${(r.server.address() as { port: number }).port}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, runner: "local" }),
  })
  const p = (await res.json()) as Project
  r.yard.store.db.prepare("UPDATE projects SET repo=? WHERE id=?").run(origin(), p.id)
  return p
}

const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const settled = (r: Running, id: string, turns = 1) =>
  waitFor(() => {
    const t = getTask(r, id)
    return t.turnCount >= turns && !t.currentTurnId && !t.pendingCount && ["done", "idle", "pr_ready"].includes(t.status) ? t : null
  }, `task ${id} to finish turn ${turns}`)
const work = (r: Running, id: string) => path.join(r.localRoot, id, "work")

/** Everything in the folder committed and its branch pushed (what push at turn end does outside mock mode). */
function pushAll(dir: string) {
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "work", "--allow-empty")
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()
  git(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`)
  git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD")
}

/** Build output and scratch in a work folder. */
function build(dir: string) {
  for (const rel of ["node_modules/pkg/index.js", "dist/out.js", "tmp/notes.txt"]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), "x".repeat(1024))
  }
}

/** A finished local task with a pushed folder (and build output in it). Older tasks first: `ageHours` backdates it. */
async function finished(r: Running, projectId: string, title: string, ageHours = 0): Promise<Task> {
  const t = r.yard.tasks.createTask({ projectId, title, prompt: "write a haiku" })
  await settled(r, t.id)
  pushAll(work(r, t.id))
  build(work(r, t.id))
  r.yard.store.db.prepare("UPDATE tasks SET status='done', last_active_at=? WHERE id=?").run(Date.now() - ageHours * 60 * 60_000, t.id)
  return getTask(r, t.id)
}

describe("cleanup of this computer's task folders", () => {
  it("frees a done task's build output once it's pushed, but not while anything is uncommitted", async () => {
    const r = await start({ localBuildCleanup: true })
    const p = await localProject(r, "laptop")
    const pushed = await finished(r, p.id, "pushed")
    const dirty = await finished(r, p.id, "dirty")
    fs.writeFileSync(path.join(work(r, dirty.id), "README.md"), "changed but not committed\n")

    await r.yard.tasks.ownCleanup.upkeep(LOCAL_BOX_ID)

    expect(fs.existsSync(path.join(work(r, pushed.id), "node_modules"))).toBe(false)
    expect(fs.existsSync(path.join(work(r, pushed.id), "dist"))).toBe(false)
    // Scratch stays, and so does the folder itself.
    expect(fs.existsSync(path.join(work(r, pushed.id), "tmp", "notes.txt"))).toBe(true)
    expect(getTask(r, pushed.id).boxId).toBe(LOCAL_BOX_ID)
    // Uncommitted work: nothing in that folder is touched.
    expect(fs.existsSync(path.join(work(r, dirty.id), "node_modules", "pkg", "index.js"))).toBe(true)
    expect(fs.readFileSync(path.join(work(r, dirty.id), "README.md"), "utf8")).toContain("not committed")
  })

  it("keeps at most Task folders kept: the oldest finished folder is archived, removed, and comes back on its next message", async () => {
    const r = await start({ localFoldersKept: 1 })
    const p = await localProject(r, "laptop")
    const old = await finished(r, p.id, "old", 48)
    const recent = await finished(r, p.id, "recent", 1)

    await r.yard.tasks.ownCleanup.upkeep(LOCAL_BOX_ID)

    const gone = r.yard.store.getTaskRow(old.id)!
    expect(gone.box_id).toBeNull()
    expect(gone.archive_path && fs.existsSync(gone.archive_path)).toBeTruthy()
    expect(fs.existsSync(path.join(r.localRoot, old.id))).toBe(false)
    expect(getTask(r, recent.id).boxId).toBe(LOCAL_BOX_ID)
    expect(fs.existsSync(path.join(work(r, recent.id), "node_modules"))).toBe(true) // build output is its own setting
    expect(r.yard.store.listTaskMessages(old.id, 100).some((m) => m.role === "event" && m.content.includes("to keep at most 1 task folders on this computer"))).toBe(true)

    // Its next message restores it here from the archive, committed work included.
    r.yard.tasks.sendInput(old.id, "one more haiku", "user")
    await settled(r, old.id, 2)
    expect(getTask(r, old.id).boxId).toBe(LOCAL_BOX_ID)
    expect(git(work(r, old.id), "log", "-1", "--format=%s").trim()).toBe("work")
  })

  it("on low disk, frees build output and removes finished folders, but never a running task or a folder with unpushed work", async () => {
    // A floor no disk reaches, so every pass is a low-disk one.
    const r = await start({ localDiskMinFreeGb: 100_000 })
    const p = await localProject(r, "laptop")
    const a = await finished(r, p.id, "a", 30)
    const unpushed = await finished(r, p.id, "unpushed", 40)
    fs.writeFileSync(path.join(work(r, unpushed.id), "new.txt"), "local only\n")
    git(work(r, unpushed.id), "add", "new.txt")
    git(work(r, unpushed.id), "commit", "-qm", "not pushed")
    const busy = r.yard.tasks.createTask({ projectId: p.id, title: "busy", prompt: "keep going [hang]" })
    await waitFor(() => getTask(r, busy.id).status === "working", "the busy task to work")

    await r.yard.tasks.ownCleanup.upkeep(LOCAL_BOX_ID)

    expect(r.yard.store.getTaskRow(a.id)!.box_id).toBeNull()
    expect(fs.existsSync(path.join(r.localRoot, a.id))).toBe(false)
    expect(getTask(r, unpushed.id).boxId).toBe(LOCAL_BOX_ID)
    expect(fs.existsSync(path.join(work(r, unpushed.id), "node_modules", "pkg", "index.js"))).toBe(true)
    expect(git(work(r, unpushed.id), "log", "-1", "--format=%s").trim()).toBe("not pushed")
    expect(getTask(r, busy.id).status).toBe("working")
    expect(fs.existsSync(work(r, busy.id))).toBe(true)
  })
})
