import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import type { BoxCleanup, BoxInfo, BoxResize, BoxSize, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A box whose work disk (/workspace on Upstash) has 0 bytes free: archives still work because they stream off the
// box, the emergency cleanup removes only done workspaces GitHub fully has, and a resize that fails cleans up the
// box it made. Its error names the step and each task's own error.

const MB = 1024 * 1024
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env }).toString()
const which = (bin: string) => execFileSync("bash", ["-c", `command -v ${bin}`]).toString().trim()

/**
 * The box exec layer on a full disk: git and tar on PATH that fail, like the real ones at 0 bytes free, when they'd
 * write under the box folder ($FAKE_FULL_ROOT). Writes elsewhere (/tmp is another disk on Upstash) still work.
 * `FAKE_TAR_ERROR` makes every archive tar fail with that message.
 */
const SHIMS = tmpDir("full-disk-shims-")
fs.writeFileSync(
  path.join(SHIMS, "git"),
  `#!/bin/bash
if [ -n "$FAKE_FULL_ROOT" ]; then
  dir=$PWD; sub=; args=("$@"); i=0
  while [ $i -lt \${#args[@]} ]; do
    case "\${args[$i]}" in
      -C) dir=$(cd "$dir" && cd "\${args[$((i+1))]}" && pwd); i=$((i+2));;
      -c) i=$((i+2));;
      -*) i=$((i+1));;
      *) sub=\${args[$i]}; break;;
    esac
  done
  under() { case "$1/" in "$FAKE_FULL_ROOT"/*) return 0;; esac; return 1; }
  obj=\${GIT_OBJECT_DIRECTORY:-$dir}; idx=\${GIT_INDEX_FILE:-$dir}; fail=
  case "$sub" in add|commit|write-tree|commit-tree|hash-object|stash|gc|repack|fetch|clone) under "$obj" && fail=1;; esac
  case "$sub" in add|commit|read-tree|reset|checkout|stash) under "$idx" && fail=1;; esac
  case "$sub" in commit|update-ref|reset|stash|checkout|fetch|gc) under "$dir" && fail=1;; esac
  if [ -n "$fail" ]; then echo "error: unable to write file .git/objects/ab/cdef: No space left on device" >&2; exit 128; fi
fi
exec ${which("git")} "$@"
`,
  { mode: 0o755 },
)
fs.writeFileSync(
  path.join(SHIMS, "tar"),
  `#!/bin/bash
case "$1" in *c*)
  if [ -n "$FAKE_TAR_ERROR" ]; then echo "$FAKE_TAR_ERROR" >&2; exit 2; fi
  if [ -n "$FAKE_FULL_ROOT" ] && [ "$2" != - ]; then
    d=$(cd "$(dirname "$2")" 2>/dev/null && pwd)
    case "$d/" in "$FAKE_FULL_ROOT"/*) echo "tar: $2: Cannot open: No space left on device" >&2; exit 2;; esac
  fi;;
esac
exec ${which("tar")} "$@"
`,
  { mode: 0o755 },
)

/** Disk a folder uses; a `*.ballast` file counts as the byte size written in it. */
function used(file: string): number {
  const st = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!st) return 0
  if (!st.isDirectory()) return file.endsWith(".ballast") ? Number(fs.readFileSync(file, "utf8")) || 0 : st.size
  let total = 0
  for (const e of fs.readdirSync(file)) total += used(path.join(file, e))
  return total
}

/** Local boxes with a pretend disk that can be full, a size, and a provider delete that can fail. */
class FullDiskBoxes extends LocalProvider {
  capacity = new Map<string, number>()
  /** Boxes whose work disk is full: writes under their folder fail with ENOSPC. */
  full = new Set<string>()
  tarError = new Map<string, string>()
  sizes = new Map<string, BoxSize>()
  created: BoxSize[] = []
  destroyed: string[] = []
  /** Fail this many provider deletes. */
  failDestroy = 0

  fill(boxId: string, free: number) {
    this.capacity.set(boxId, used(this.root(boxId)) + free)
  }

  protected override env(boxId: string): NodeJS.ProcessEnv {
    const base = super.env(boxId)
    if (!this.full.has(boxId) && !this.tarError.has(boxId)) return base
    return { ...base, PATH: `${SHIMS}:${base.PATH}`, FAKE_FULL_ROOT: this.full.has(boxId) ? this.root(boxId) : "", FAKE_TAR_ERROR: this.tarError.get(boxId) ?? "" }
  }

  private refuse(boxId: string, file: string) {
    if (this.full.has(boxId) && path.resolve(file).startsWith(this.root(boxId) + path.sep)) throw new Error(`ENOSPC: no space left on device, write '${file}'`)
  }

  override async writeFile(boxId: string, filePath: string, content: string | Buffer) {
    this.refuse(boxId, filePath)
    return super.writeFile(boxId, filePath, content)
  }

  override async uploadFile(boxId: string, localPath: string, destination: string) {
    this.refuse(boxId, destination)
    return super.uploadFile(boxId, localPath, destination)
  }

  override async create(opts?: { labels: string[]; size?: BoxSize }): Promise<string> {
    const id = await super.create()
    this.sizes.set(id, opts?.size ?? "small")
    this.created.push(opts?.size ?? "small")
    return id
  }

  override async destroy(boxId: string) {
    if (this.failDestroy > 0) {
      this.failDestroy--
      throw new Error("provider said 500")
    }
    this.destroyed.push(boxId)
    return super.destroy(boxId)
  }

  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk")) {
      const u = used(this.root(boxId))
      const total = this.capacity.get(boxId) ?? u + 50 * 1024 * MB
      const kb = (n: number) => Math.floor(Math.max(0, n) / 1024)
      return { exitCode: 0, stdout: `fakefs ${kb(total)} ${kb(u)} ${kb(total - u)} 50% ${this.root(boxId)}\n`, stderr: "" }
    }
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: FullDiskBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new FullDiskBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, maxBoxes: 3, ...overrides }), { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    await waitFor(() => r.yard.store.listBoxes().every((b) => r.yard.tasks.resizeReport(b.id)?.status !== "running" && !r.yard.tasks.janitor.isRunning(b.id)), "box work to settle").catch(() => {})
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

/** A project cloning a local bare repo (the API only takes GitHub repos, so it's set in the database). */
async function repoProject(r: Running, name: string) {
  const root = tmpDir("box-yard-repo-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  const p = await call<Project>(r, "POST", "/api/projects", { name })
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(bare, p.id)
  return p
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const boxes = (r: Running) => call<BoxInfo[]>(r, "GET", "/api/boxes")
/** A task that finished its turn and was archived after it. */
async function doneTask(r: Running, projectId: string, title: string) {
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "write a haiku" })
  const done = await waitFor(async () => {
    const x = await getTask(r, t.id)
    return x.status === "done" && x.lastArchivedAt && x.pendingCount === 0 ? x : null
  }, `task ${t.id} to finish and archive`)
  await new Promise((res) => setTimeout(res, 500))
  return done
}
const workDir = (r: Running, boxId: string, taskId: string) => path.join(r.yard.tasks.taskDir(boxId, taskId), "work")
/** Its archive is older than its last activity, so the next box operation has to archive it again. */
const stale = (r: Running, id: string) => r.yard.store.updateTask(id, { lastArchivedAt: 1 }, { touch: false })
const finished = (r: Running, boxId: string) =>
  waitFor(() => {
    const rep = r.yard.tasks.resizeReport(boxId)
    return rep && rep.status !== "running" ? rep : null
  }, `the resize of ${boxId} to finish`)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
/** Unpack a task's archive and return the folder. */
function unpack(r: Running, id: string) {
  const file = r.yard.store.getTaskRow(id)!.archive_path!
  const dir = tmpDir("unpacked-")
  execFileSync("tar", ["xzf", file, "-C", dir])
  return path.join(dir, id)
}
/** What a repo looks like on disk, to show nothing was written to it. */
const repoState = (work: string) => ({
  status: git(work, "status", "--porcelain"),
  reflog: git(work, "reflog"),
  objects: git(work, "count-objects", "-v"),
  refs: git(work, "for-each-ref"),
})

describe("archiving on a full disk", () => {
  it("streams the archive off a box with 0 bytes free, too-big fallback included, and the resize goes through", async () => {
    const r = await start({ archiveMaxMb: 1 })
    const p = await repoProject(r, "alpha")
    const t = await doneTask(r, p.id, "game assets")
    const box = t.boxId!
    const work = workDir(r, box, t.id)
    // An ignored asset cache over the cap (the whole folder is too big), and uncommitted work.
    fs.writeFileSync(path.join(work, ".gitignore"), "cache/\n")
    fs.mkdirSync(path.join(work, "cache"))
    fs.writeFileSync(path.join(work, "cache", "atlas.bin"), Buffer.from(Array.from({ length: 2 * MB }, () => Math.floor(Math.random() * 256))))
    fs.writeFileSync(path.join(work, "README.md"), "edited on a full disk\n")
    r.provider.fill(box, 0)
    r.provider.full.add(box)
    stale(r, t.id)
    const before = repoState(work)

    await r.yard.tasks.archive(t.id)
    const row = r.yard.store.getTaskRow(t.id)!
    expect(row.last_archived_at).toBeGreaterThan(1)
    // Nothing was written to the box's repo: the snapshot lives only in the archive.
    expect(repoState(work)).toEqual(before)
    const repo = path.join(unpack(r, t.id), "work")
    expect(git(repo, "show", "refs/boxyard/wip:README.md")).toBe("edited on a full disk\n")
    expect(git(repo, "show", "refs/boxyard/wip:box-yard-demo.md")).toContain("Mock result")
    expect(events(r, t.id)).toContain("Workspace was too big to archive whole; saved the Claude session and git history (uncommitted work is on refs/boxyard/wip).")

    // The resize that used to fail here: everything moves.
    stale(r, t.id)
    await call(r, "POST", `/api/boxes/${box}/resize`, { size: "medium" })
    const rep = await finished(r, box)
    expect(rep.error).toBeNull()
    expect(rep.status).toBe("done")
    expect(rep.movedTasks).toEqual([t.id])
    expect((await getTask(r, t.id)).boxId).toBe(rep.newBoxId)
  })

  it("names the failed step and each task's error, and deletes the box it made (retrying a failed delete)", async () => {
    const r = await start()
    const p = await repoProject(r, "alpha")
    const a = await doneTask(r, p.id, "first")
    const b = await doneTask(r, p.id, "second")
    const box = a.boxId!
    expect(b.boxId).toBe(box)
    for (const t of [a, b]) stale(r, t.id)
    r.provider.tarError.set(box, "tar: write error: No space left on device")
    r.provider.failDestroy = 1

    await call(r, "POST", `/api/boxes/${box}/resize`, { size: "medium" })
    const rep = await finished(r, box)
    const ids = r.yard.store.listTaskRows({ boxId: box }).map((t) => t.id)
    expect([...ids].sort()).toEqual([a.id, b.id].sort())
    expect(rep.status).toBe("failed")
    expect(rep.error).toBe(
      `archive step failed: Couldn't archive 2 workspaces (${ids.join(", ")}), so nothing moved and ${box} keeps its work: ` +
        ids.map((id) => `archive ${id}: tar: write error: No space left on device`).join("; "),
    )
    const made = rep.newBoxId!
    // The provider refused the first delete: the box stays visible as deleting, and the report says so.
    expect(rep.cleanup).toBe(`Couldn't delete the new box ${made} yet (provider said 500); Box Yard keeps trying.`)
    expect((await boxes(r)).map((x) => [x.id, x.status])).toEqual(
      expect.arrayContaining([
        [box, "ready"],
        [made, "deleting"],
      ]),
    )
    await r.yard.tasks.maintain()
    expect(r.provider.destroyed).toEqual([made])
    expect((await boxes(r)).map((x) => x.id)).toEqual([box])
    expect(r.yard.tasks.resizeReport(box)?.cleanup).toBe(`Deleted the new medium box ${made}.`)
    // Nothing moved.
    for (const t of [a, b]) {
      expect((await getTask(r, t.id)).boxId).toBe(box)
      expect(fs.existsSync(workDir(r, box, t.id))).toBe(true)
    }

    // Once tar works again, the next attempt makes a fresh box and finishes.
    r.provider.tarError.delete(box)
    await call(r, "POST", `/api/boxes/${box}/resize`, { size: "medium" })
    const again = await waitFor(() => {
      const x = r.yard.tasks.resizeReport(box)
      return x && x.id !== rep.id && x.status !== "running" ? x : null
    }, "the second resize")
    expect(again.status).toBe("done")
    expect(r.provider.created).toEqual(["small", "medium", "medium"])
  })

  it("says when a workspace is too big even archived thin (a 2 MB unpushed commit), and how to raise the limit", async () => {
    const r = await start({ archiveMaxMb: 1 })
    const p = await repoProject(r, "alpha")
    const t = await doneTask(r, p.id, "huge history")
    const work = workDir(r, t.boxId!, t.id)
    fs.writeFileSync(path.join(work, "atlas.bin"), Buffer.from(Array.from({ length: 2 * MB }, () => Math.floor(Math.random() * 256))))
    git(work, "add", "-A")
    git(work, "commit", "-qm", "assets")
    stale(r, t.id)
    const res = await fetch(`${r.base}/api/boxes/${t.boxId}`, { method: "DELETE" })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe(
      `Couldn't archive ${t.id}, so ${t.boxId} was not deleted: archive ${t.id}: workspace is too large to archive even without its files and the history GitHub has (Claude session, log, unpushed commits and uncommitted work are over 1 MB compressed; BOXYARD_ARCHIVE_MAX_MB raises the limit)`,
    )
    expect(fs.existsSync(work)).toBe(true)
  })

  it("reclaims an empty box left by a resize that failed before this fix, or by a restart mid-resize", async () => {
    const r = await start()
    const p = await repoProject(r, "alpha")
    const t = await doneTask(r, p.id, "first")
    const box = t.boxId!
    const hourAgo = Date.now() - 60 * 60_000
    const leftover = async (status: BoxResize["status"]) => {
      const id = await r.provider.create({ labels: [], size: "medium" })
      r.yard.store.upsertBox({ id, provider: "local", status: "ready", created_at: hourAgo, last_used_at: hourAgo, size: "medium", keep_alive: 0, usage_source: "estimated" })
      const report: BoxResize = {
        id: `rsz_${id}`,
        boxId: box,
        newBoxId: id,
        from: "small",
        to: "medium",
        mode: "migration",
        status,
        steps: [],
        movedTasks: [],
        by: { kind: "cody" },
        reason: null,
        error: status === "failed" ? `Couldn't archive ${t.id}, so nothing moved and ${box} keeps its work.` : null,
        startedAt: hourAgo - 5000,
        finishedAt: status === "failed" ? hourAgo : null,
      }
      for (const key of [box, id]) r.yard.store.setKv(`box_resize:${key}`, JSON.stringify(report))
      return id
    }

    // A failed resize's empty box, still in the pool (the old code could leave one behind).
    const old = await leftover("failed")
    await r.yard.tasks.maintain()
    expect(r.provider.destroyed).toEqual([old])
    expect((await boxes(r)).map((x) => x.id)).toEqual([box])
    expect(r.yard.tasks.resizeReport(box)?.cleanup).toBe(`Deleted the new medium box ${old}.`)

    // Box Yard restarted while a resize was making its box.
    const half = await leftover("running")
    ;(r.yard.tasks as unknown as { recover(): void }).recover()
    await waitFor(() => r.provider.destroyed.includes(half), "the half-made box to be deleted")
    const rep = await waitFor(() => (r.yard.tasks.resizeReport(box)?.cleanup ? r.yard.tasks.resizeReport(box) : null), "the report to say so")
    expect(rep).toMatchObject({ status: "failed", error: "Box Yard restarted during the resize; nothing was moved. Try again.", cleanup: `Deleted the new medium box ${half}.` })
    expect((await boxes(r)).map((x) => x.id)).toEqual([box])
    expect((await getTask(r, t.id)).boxId).toBe(box)
  })
})

describe("emergency cleanup at 0 bytes free", () => {
  it("removes only done workspaces whose PR is merged and fully pushed, then the rest archive fine", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await repoProject(r, "alpha")
    const pushed = await doneTask(r, p.id, "merged and pushed")
    const dirty = await doneTask(r, p.id, "merged with uncommitted work")
    const unpushed = await doneTask(r, p.id, "merged with an unpushed commit")
    const idle = await doneTask(r, p.id, "idle with uncommitted work")
    const box = pushed.boxId!
    for (const t of [dirty, unpushed, idle]) expect(t.boxId).toBe(box)
    const dir = (t: Task) => r.yard.tasks.taskDir(box, t.id)
    const work = (t: Task) => workDir(r, box, t.id)

    // Merged and pushed: commit fake-claude's file and push the branch. Its session holds 200 MB.
    git(work(pushed), "add", "-A")
    git(work(pushed), "commit", "-qm", "haiku")
    git(work(pushed), "push", "-q", "origin", "HEAD")
    fs.mkdirSync(path.join(dir(pushed), "claude", "projects", "p"), { recursive: true })
    fs.writeFileSync(path.join(dir(pushed), "claude", "projects", "p", "session.ballast"), String(200 * MB))
    // Merged, but with a file nobody committed (fake-claude's) / a commit nobody pushed.
    git(work(unpushed), "add", "-A")
    git(work(unpushed), "commit", "-qm", "local only")
    // Idle with uncommitted work, plus session temp files and a transcript.
    r.yard.store.updateTask(idle.id, { status: "idle" })
    fs.writeFileSync(path.join(work(idle), "README.md"), "half-done edit\n")
    fs.mkdirSync(path.join(dir(idle), "claude", "shell-snapshots"), { recursive: true })
    fs.writeFileSync(path.join(dir(idle), "claude", "shell-snapshots", "snapshot-bash.sh"), "x")
    fs.mkdirSync(path.join(dir(idle), "claude", "projects", "p"), { recursive: true })
    fs.writeFileSync(path.join(dir(idle), "claude", "projects", "p", "s.jsonl"), "{}\n")
    for (const [i, t] of [pushed, dirty, unpushed].entries()) r.yard.store.updateTask(t.id, { prUrl: `https://github.com/o/r/pull/${i + 1}`, prState: "merged" })
    for (const t of [pushed, dirty, unpushed, idle]) stale(r, t.id)
    r.provider.fill(box, 0)
    r.provider.full.add(box)

    const report = await r.yard.tasks.janitor.run(box, { reason: "out-of-space", target: 100 * MB, parkBelow: 100 * MB })
    const step = (c: BoxCleanup, key: string) => c.steps.find((s) => s.key === key)!
    expect(report.steps.map((s) => s.key)).toEqual(["temp", "merged", "partials", "caches", "builds", "git", "archive"])
    expect(step(report, "temp").removed).toEqual(["session temp files of 1 task"])
    expect(fs.existsSync(path.join(dir(idle), "claude", "shell-snapshots"))).toBe(false)
    expect(fs.existsSync(path.join(dir(idle), "claude", "projects", "p", "s.jsonl"))).toBe(true)
    expect(step(report, "merged").removed).toEqual([`${pushed.id} (PR merged, nothing unpushed)`])
    expect(step(report, "merged").freedBytes).toBeGreaterThanOrEqual(200 * MB)
    expect(report.enough).toBe(true)
    expect(step(report, "builds").skipped).toBe("enough room already")

    // The pushed one is gone without an archive and comes back from a recap.
    const gone = r.yard.store.getTaskRow(pushed.id)!
    expect(gone.box_id).toBeNull()
    expect(gone.archive_path).toBeNull()
    expect(fs.existsSync(dir(pushed))).toBe(false)
    expect(r.yard.tasks.resumeMode(pushed.id)).toBe("recap")
    expect(events(r, pushed.id)).toContain(
      `Workspace removed from box ${box} to free disk, without an archive: its PR #1 is merged and nothing in it was unpushed, so GitHub has all of it. The next message starts from a recap.`,
    )
    // Everything else is untouched.
    for (const t of [dirty, unpushed, idle]) expect((await getTask(r, t.id)).boxId).toBe(box)
    expect(fs.readFileSync(path.join(work(idle), "README.md"), "utf8")).toBe("half-done edit\n")
    expect(fs.existsSync(path.join(work(dirty), "box-yard-demo.md"))).toBe(true)
    expect(git(work(unpushed), "log", "-1", "--format=%s").trim()).toBe("local only")

    // The disk is still full for writes, and the rest archive anyway: Clear box takes every workspace off.
    const cleared = await call<BoxCleanup>(r, "POST", `/api/boxes/${box}/clear`, {})
    expect(step(cleared, "archive").removed.sort()).toEqual([dirty.id, unpushed.id, idle.id].sort())
    expect(step(cleared, "archive").skipped).toBeNull()
    expect(fs.readFileSync(path.join(unpack(r, idle.id), "work", "README.md"), "utf8")).toBe("half-done edit\n")
    expect(git(path.join(unpack(r, unpushed.id), "work"), "log", "-1", "--format=%s").trim()).toBe("local only")
    expect(fs.existsSync(path.join(unpack(r, dirty.id), "work", "box-yard-demo.md"))).toBe(true)
  })

  it("keeps the normal order while there's some room", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = await repoProject(r, "alpha")
    const t = await doneTask(r, p.id, "merged and pushed")
    git(workDir(r, t.boxId!, t.id), "add", "-A")
    git(workDir(r, t.boxId!, t.id), "commit", "-qm", "haiku")
    git(workDir(r, t.boxId!, t.id), "push", "-q", "origin", "HEAD")
    r.yard.store.updateTask(t.id, { prUrl: "https://github.com/o/r/pull/1", prState: "merged" })
    r.provider.fill(t.boxId!, 300 * MB)
    const report = await r.yard.tasks.janitor.run(t.boxId!, { reason: "low-disk", target: 400 * MB, parkBelow: 400 * MB })
    expect(report.steps.map((s) => s.key)).toEqual(["partials", "caches", "builds", "git", "archive"])
    // Parked with its archive (the session stays), not dropped.
    expect(r.yard.store.getTaskRow(t.id)!.archive_path).toBeTruthy()
  })
})
