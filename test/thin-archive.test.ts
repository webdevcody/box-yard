import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { ArchiveDecoder, THIN_DIR, archiveOutcome, archiveScript, thinRestoreScript } from "../server/archive.js"
import type { MirrorSpec } from "../server/gitShare.js"
import { tmpDir } from "./helpers.js"

// Thin archives: a task whose git history alone is over the cap (a clone from before tasks shared the box mirror)
// archives only what GitHub doesn't have — HEAD, refs, a bundle of unpushed commits, the WIP snapshot — and the
// restore clones the rest again from the mirror or GitHub. Commits that can't be found fail the restore loudly.

const MB = 1024 * 1024
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env }).toString()
const random = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)))

/** A file:// origin with `commits` × `size` of incompressible history on main. */
function origin(commits: number, size: number) {
  const dir = tmpDir("thin-origin-")
  const bare = path.join(dir, "origin.git")
  git(dir, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  const seed = path.join(dir, "seed")
  git(dir, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(seed, `asset-${i}.bin`), random(size))
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `assets ${i}`)
  }
  git(seed, "push", "-q", bare, "main")
  return { url: `file://${bare}`, bare, seed }
}

/** A box: its root with tasks/ and .boxyard/repos/. */
function box() {
  const root = tmpDir("thin-box-")
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true })
  fs.mkdirSync(path.join(root, ".boxyard", "repos"), { recursive: true })
  return root
}
const spec = (root: string, url: string, partial: boolean): MirrorSpec => ({ root, mirror: path.join(root, ".boxyard", "repos", "repo.git"), url, partial, git: "git" })
const git_ = { helper: "", userName: "t", userEmail: "t@t" }

/** A task folder on `root` whose work/ is cloned the old way (self-contained) or the #84 way (borrowing the mirror). */
function task(root: string, url: string, style: "self-contained" | "shared", partial = false) {
  const dir = path.join(root, "tasks", "task_a")
  fs.mkdirSync(path.join(dir, "claude", "projects"), { recursive: true })
  fs.writeFileSync(path.join(dir, "claude", "projects", "s.jsonl"), '{"session":1}\n')
  fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n")
  fs.writeFileSync(path.join(dir, "events.seq"), "7\n")
  if (style === "self-contained") git(dir, "clone", "-q", url, "work")
  else {
    const s = spec(root, url, partial)
    git(root, "clone", "-q", "--mirror", ...(partial ? ["--filter=blob:none"] : []), url, s.mirror)
    git(dir, "clone", "-q", ...(partial ? ["--filter=blob:none"] : []), "--reference", s.mirror, url, "work")
  }
  const work = path.join(dir, "work")
  git(work, "checkout", "-q", "-b", "boxyard/feature")
  return { dir, work }
}

/** Unpushed commits, a staged edit, an unstaged edit, a deletion and an untracked file. */
function localWork(work: string) {
  fs.writeFileSync(path.join(work, "local.txt"), "committed, never pushed\n")
  git(work, "add", ".")
  git(work, "commit", "-qm", "local 1")
  fs.writeFileSync(path.join(work, "local.txt"), "committed twice, never pushed\n")
  git(work, "commit", "-qam", "local 2")
  fs.writeFileSync(path.join(work, "README.md"), "staged edit\n")
  git(work, "add", "README.md")
  fs.writeFileSync(path.join(work, "local.txt"), "unstaged edit\n")
  git(work, "rm", "-q", "asset-0.bin")
  fs.writeFileSync(path.join(work, "notes.md"), "untracked\n")
}

/** Archive like a box would, in thin mode; returns the outcome and the archive bytes. */
function archive(root: string, maxBytes: number, mirror?: string) {
  const script = archiveScript({ root: path.join(root, "tasks"), taskId: "task_a", excludes: ["node_modules"], maxBytes, partial: true, thin: true, mirror })
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 1 << 28, env })
  const parts: Buffer[] = []
  const decoder = new ArchiveDecoder((b) => parts.push(b))
  decoder.push(res.stdout)
  decoder.end()
  return { outcome: archiveOutcome(decoder, { maxBytes, partial: true, exitCode: res.status ?? 1 }), data: Buffer.concat(parts) }
}

/** Unpack an archive on another box and rebuild the repo; returns the task folder and the restore output. */
function restore(data: Buffer, url: string, partial: boolean) {
  const root = box()
  fs.writeFileSync(path.join(root, "a.tgz"), data)
  execFileSync("tar", ["xzf", "a.tgz", "-C", "tasks"], { cwd: root })
  const dir = path.join(root, "tasks", "task_a")
  const res = spawnSync("bash", ["-c", thinRestoreScript(dir, spec(root, url, partial), git_)], { encoding: "utf8", env })
  return { dir, work: path.join(dir, "work"), out: res.stdout + res.stderr, status: res.status }
}

const state = (work: string) => ({
  head: git(work, "rev-parse", "HEAD").trim(),
  branch: git(work, "symbolic-ref", "HEAD").trim(),
  log: git(work, "log", "--format=%s", "-3"),
  status: git(work, "status", "--porcelain").split("\n").filter(Boolean).sort(),
  files: Object.fromEntries(["README.md", "local.txt", "notes.md"].map((f) => [f, fs.readFileSync(path.join(work, f), "utf8")])),
  deleted: !fs.existsSync(path.join(work, "asset-0.bin")),
})

describe("thin archive round trip", () => {
  for (const style of ["self-contained", "shared"] as const) {
    it(`a ${style} repo with ${style === "shared" ? "" : "a heavy "}history on origin archives under the cap and comes back whole`, () => {
      const o = origin(4, 2 * MB)
      const root = box()
      const { work } = task(root, o.url, style)
      localWork(work)
      const before = state(work)
      const objectsBefore = git(work, "count-objects", "-v")

      const cap = 1 * MB
      const { outcome, data } = archive(root, cap, style === "shared" ? spec(root, o.url, false).mirror : undefined)
      expect(outcome.ok).toBe(true)
      expect(data.length).toBeLessThan(64 * 1024) // the 8 MB of history stays on origin
      expect(outcome.ok && outcome.wip).toMatch(/^[0-9a-f]{40}$/)
      // Nothing was written to the box's repo.
      expect(git(work, "count-objects", "-v")).toBe(objectsBefore)
      expect(state(work)).toEqual(before)

      const back = restore(data, o.url, false)
      expect(back.out).toContain("boxyard-thin=ok")
      expect(state(back.work)).toEqual(before)
      expect(fs.readFileSync(path.join(back.dir, "claude", "projects", "s.jsonl"), "utf8")).toBe('{"session":1}\n')
      expect(fs.readFileSync(path.join(back.dir, "events.seq"), "utf8")).toBe("7\n")
      expect(fs.existsSync(path.join(back.dir, THIN_DIR))).toBe(false)
      expect(git(back.work, "fsck", "--no-progress", "--connectivity-only")).toBe("")
    })
  }

  it("works with a partial (blob:none) mirror on both boxes", () => {
    const o = origin(3, 512 * 1024)
    const root = box()
    const { work } = task(root, o.url, "shared", true)
    localWork(work)
    const before = state(work)
    const { outcome, data } = archive(root, 1 * MB, spec(root, o.url, true).mirror)
    expect(outcome.ok).toBe(true)
    const back = restore(data, o.url, true)
    expect(back.out).toContain("boxyard-thin=ok")
    expect(state(back.work)).toEqual(before)
  })

  it("bundles only unpushed commits; with everything pushed there's no bundle at all", () => {
    const o = origin(2, 256 * 1024)
    const root = box()
    const { dir, work } = task(root, o.url, "self-contained")
    fs.writeFileSync(path.join(work, "a.txt"), "1\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "unpushed")
    const one = archive(root, 1 * MB)
    const unpacked = tmpDir("thin-unpacked-")
    fs.writeFileSync(path.join(unpacked, "a.tgz"), one.data)
    execFileSync("tar", ["xzf", "a.tgz"], { cwd: unpacked })
    const bundle = path.join(unpacked, "task_a", THIN_DIR, "unpushed.bundle")
    // One commit, whose parent (on origin) is the prerequisite.
    expect(git(unpacked, "bundle", "list-heads", bundle)).toContain("refs/keep/refs/heads/boxyard/feature")
    const header = fs.readFileSync(bundle).toString("latin1").split("\n\n")[0]!
    expect(header.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(1)

    git(work, "push", "-q", "origin", "HEAD")
    const two = archive(root, 1 * MB)
    const again = tmpDir("thin-unpacked-")
    fs.writeFileSync(path.join(again, "a.tgz"), two.data)
    execFileSync("tar", ["xzf", "a.tgz"], { cwd: again })
    expect(fs.existsSync(path.join(again, "task_a", THIN_DIR, "unpushed.bundle"))).toBe(false)
    expect(two.outcome).toMatchObject({ ok: true, wip: "clean" })
    expect(restore(two.data, o.url, false).out).toContain("boxyard-thin=ok")
    expect(fs.existsSync(dir)).toBe(true)
  })

  it("fails loudly, leaving no work/, when the history the bundle builds on is gone", () => {
    const o = origin(2, 256 * 1024)
    const root = box()
    // A branch someone pushed to origin, that the task built on, and that origin later lost.
    git(o.seed, "checkout", "-q", "-b", "doomed")
    fs.writeFileSync(path.join(o.seed, "doomed.txt"), "x\n")
    git(o.seed, "add", ".")
    git(o.seed, "commit", "-qm", "doomed")
    git(o.seed, "push", "-q", o.bare, "doomed")
    const { work } = task(root, o.url, "self-contained")
    git(work, "checkout", "-q", "-B", "boxyard/feature", "origin/doomed")
    fs.writeFileSync(path.join(work, "mine.txt"), "x\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "on top of doomed")
    const { outcome, data } = archive(root, 1 * MB)
    expect(outcome.ok).toBe(true)
    git(o.bare, "update-ref", "-d", "refs/heads/doomed")
    git(o.bare, "reflog", "expire", "--expire=now", "--all")
    git(o.bare, "gc", "-q", "--prune=now")

    const back = restore(data, o.url, false)
    expect(back.status).not.toBe(0)
    expect(back.out).toMatch(/boxyard-thin=fail the unpushed commits need history the mirror and GitHub don't have: .*prerequisite/)
    expect(fs.existsSync(back.work)).toBe(false)
  })

  it("still says too big when what's left is over the cap", () => {
    const o = origin(1, 64 * 1024)
    const root = box()
    const { work } = task(root, o.url, "self-contained")
    fs.writeFileSync(path.join(work, "huge-local.bin"), random(2 * MB))
    git(work, "add", ".")
    git(work, "commit", "-qm", "huge unpushed")
    const { outcome } = archive(root, 1 * MB)
    expect(outcome).toMatchObject({ ok: false, tooBig: true })
  })
})
