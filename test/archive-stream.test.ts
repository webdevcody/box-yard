import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { ARCHIVE_END, ArchiveDecoder, archiveOutcome, archiveScript, errorTail } from "../server/archive.js"
import { pushedCheck } from "../server/janitor.js"
import { tmpDir } from "./helpers.js"

// Archives stream off the box as base64 with a trailer line, and the too-big fallback snapshots uncommitted work
// without writing to the repo. The emergency cleanup's pushed check decides which workspaces GitHub fully has.

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env }).toString()

/** A tasks folder with one task whose work/ is a repo with a commit. */
function taskFolder() {
  const root = path.join(tmpDir("archive-"), "tasks")
  const work = path.join(root, "task_a", "work")
  fs.mkdirSync(path.join(root, "task_a", "claude", "projects"), { recursive: true })
  fs.writeFileSync(path.join(root, "task_a", "claude", "projects", "s.jsonl"), "{}\n")
  fs.writeFileSync(path.join(root, "task_a", "events.jsonl"), "{}\n")
  fs.mkdirSync(work, { recursive: true })
  git(work, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(work, "README.md"), "v1\n")
  git(work, "add", ".")
  git(work, "commit", "-qm", "init")
  return { root, work }
}

/** Run the archive script like a box would and decode its output. */
function run(root: string, partial: boolean, maxBytes = 50 * 1024 * 1024, chunk = 0) {
  const script = archiveScript({ root, taskId: "task_a", excludes: ["node_modules"], maxBytes, partial })
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 1 << 28 })
  const parts: Buffer[] = []
  const decoder = new ArchiveDecoder((b) => parts.push(b))
  // Arbitrary chunk boundaries, like a network stream.
  if (chunk) for (let i = 0; i < res.stdout.length; i += chunk) decoder.push(res.stdout.slice(i, i + chunk))
  else decoder.push(res.stdout)
  decoder.end()
  return { outcome: archiveOutcome(decoder, { maxBytes, partial, exitCode: res.status ?? 1 }), data: Buffer.concat(parts), decoder }
}

function extract(data: Buffer) {
  const dir = tmpDir("archive-out-")
  fs.writeFileSync(path.join(dir, "a.tgz"), data)
  execFileSync("tar", ["xzf", "a.tgz"], { cwd: dir })
  return path.join(dir, "task_a")
}

describe("archive stream", () => {
  it("streams the whole task folder, whatever the chunk boundaries", () => {
    const { root, work } = taskFolder()
    fs.writeFileSync(path.join(work, "notes.md"), "uncommitted\n")
    fs.mkdirSync(path.join(work, "node_modules", "dep"), { recursive: true })
    fs.writeFileSync(path.join(work, "node_modules", "dep", "x.js"), "x")
    const { outcome, data } = run(root, false, undefined, 7)
    expect(outcome).toMatchObject({ ok: true, wip: "-" })
    const out = extract(data)
    expect(fs.readFileSync(path.join(out, "work", "notes.md"), "utf8")).toBe("uncommitted\n")
    expect(fs.existsSync(path.join(out, "claude", "projects", "s.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(out, "work", "node_modules"))).toBe(false)
  })

  it("too big: stops after one byte over the cap and says so", () => {
    const { root, work } = taskFolder()
    fs.writeFileSync(path.join(work, "big.bin"), Buffer.from(Array.from({ length: 200_000 }, () => Math.floor(Math.random() * 256))))
    const { outcome, decoder } = run(root, false, 50_000)
    expect(outcome).toEqual({ ok: false, tooBig: true, error: "workspace is too large to archive (over 0 MB compressed)" })
    expect(decoder.bytes).toBe(50_001)
  })

  it("partial: saves uncommitted work on refs/boxyard/wip without touching the repo", () => {
    const { root, work } = taskFolder()
    fs.writeFileSync(path.join(work, "README.md"), "v2 uncommitted\n")
    fs.writeFileSync(path.join(work, "new.txt"), "untracked\n")
    const before = { status: git(work, "status", "--porcelain"), reflog: git(work, "reflog"), objects: git(work, "count-objects", "-v"), refs: git(work, "for-each-ref") }

    const { outcome, data } = run(root, true)
    expect(outcome.ok).toBe(true)
    const wip = outcome.ok ? outcome.wip : ""
    expect(wip).toMatch(/^[0-9a-f]{40}$/)
    // The box's repo is exactly as it was: no objects, refs, reflog entries or index changes.
    expect({ status: git(work, "status", "--porcelain"), reflog: git(work, "reflog"), objects: git(work, "count-objects", "-v"), refs: git(work, "for-each-ref") }).toEqual(before)

    const out = extract(data)
    expect(fs.existsSync(path.join(out, "work", "README.md"))).toBe(false) // only .git, the session and the log
    expect(fs.existsSync(path.join(out, "claude", "projects", "s.jsonl"))).toBe(true)
    const repo = path.join(out, "work")
    expect(git(repo, "rev-parse", "refs/boxyard/wip").trim()).toBe(wip)
    expect(git(repo, "show", "refs/boxyard/wip:README.md")).toBe("v2 uncommitted\n")
    expect(git(repo, "show", "refs/boxyard/wip:new.txt")).toBe("untracked\n")
    expect(git(repo, "log", "--format=%s", "refs/boxyard/wip")).toBe("box-yard: wip snapshot\ninit\n")
    expect(git(repo, "fsck", "--no-progress")).toBe("")
  })

  it("partial with nothing uncommitted makes no snapshot", () => {
    const { root } = taskFolder()
    const { outcome } = run(root, true)
    expect(outcome).toMatchObject({ ok: true, wip: "clean" })
  })

  it("fails a partial archive whose snapshot couldn't be saved, with git's error", () => {
    const { root, work } = taskFolder()
    fs.writeFileSync(path.join(work, "README.md"), "v2\n")
    // An unreadable file makes `git add -A` fail.
    fs.writeFileSync(path.join(work, "secret.txt"), "x")
    fs.chmodSync(path.join(work, "secret.txt"), 0)
    const asRoot = process.getuid?.() === 0
    const { outcome } = run(root, true)
    fs.chmodSync(path.join(work, "secret.txt"), 0o644)
    if (asRoot) return // root reads anything
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error).toMatch(/^couldn't save uncommitted work on refs\/boxyard\/wip: .*secret\.txt/)
  })

  it("reports tar's error when the task folder is missing", () => {
    const root = path.join(tmpDir("archive-"), "tasks")
    fs.mkdirSync(root, { recursive: true })
    const { outcome } = run(root, false)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error).toMatch(/task_a: Cannot stat: No such file or directory/)
  })
})

describe("archive outcome", () => {
  const decode = (text: string) => {
    const d = new ArchiveDecoder(() => {})
    d.push(text)
    d.end()
    return d
  }
  const b64 = (s: string) => Buffer.from(s).toString("base64")

  it("turns tar's stderr into the error", () => {
    const d = decode(`${b64("partial data")}\n${ARCHIVE_END} 2 0 0 0 - ${b64("gzip: stdout: No space left on device\ntar: write error: No space left on device\n")}\n`)
    expect(archiveOutcome(d, { maxBytes: 1000, partial: false, exitCode: 0 })).toEqual({
      ok: false,
      tooBig: false,
      error: "gzip: stdout: No space left on device; tar: write error: No space left on device",
    })
  })

  it("accepts tar's 'file changed as we read it' (exit 1)", () => {
    const d = decode(`${b64("data")}\n${ARCHIVE_END} 1 0 0 0 - ${b64("tar: x: file changed as we read it")}\n`)
    expect(archiveOutcome(d, { maxBytes: 1000, partial: false, exitCode: 0 })).toEqual({ ok: true, bytes: 4, wip: "-" })
  })

  it("a stream cut off before the trailer is a failure, with whatever the shell said", () => {
    const d = decode(`${b64("data")}\nbash: line 3: tar: command not found\n`)
    expect(archiveOutcome(d, { maxBytes: 1000, partial: false, exitCode: 127 })).toEqual({
      ok: false,
      tooBig: false,
      error: "the archive stream ended early (exit 127): bash: line 3: tar: command not found",
    })
  })

  it("keeps error tails short", () => {
    expect(errorTail("a\n\nb\nc\n")).toBe("b; c")
    expect(errorTail("x".repeat(400), 10)).toBe(`…${"x".repeat(10)}`)
  })
})

describe("pushed check", () => {
  /** A clone of a bare origin, on its own branch. */
  function clone() {
    const dir = tmpDir("pushed-")
    const bare = path.join(dir, "origin.git")
    git(dir, "init", "-q", "--bare", "-b", "main", bare)
    const seed = path.join(dir, "seed")
    git(dir, "init", "-q", "-b", "main", seed)
    fs.writeFileSync(path.join(seed, "README.md"), "hi\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "init")
    git(seed, "push", "-q", bare, "main")
    const work = path.join(dir, "work")
    git(dir, "clone", "-q", bare, work)
    git(work, "checkout", "-q", "-b", "boxyard/feature")
    return work
  }
  const check = (work: string) => execFileSync("bash", ["-c", pushedCheck(work)], { env }).toString().trim()

  it("says yes only when GitHub has everything", () => {
    const work = clone()
    expect(check(work)).toBe("boxyard-pushed=yes")

    fs.writeFileSync(path.join(work, "new.txt"), "x\n")
    expect(check(work)).toBe("boxyard-pushed=no uncommitted changes")
    git(work, "add", ".")
    git(work, "commit", "-qm", "local")
    expect(check(work)).toBe("boxyard-pushed=no 1 unpushed commits")
    git(work, "push", "-q", "origin", "boxyard/feature")
    expect(check(work)).toBe("boxyard-pushed=yes")

    fs.writeFileSync(path.join(work, "README.md"), "stashed\n")
    git(work, "stash", "-q")
    expect(check(work)).toBe("boxyard-pushed=no stashed changes")
    git(work, "stash", "drop", "-q")

    // A commit on another local branch counts too.
    git(work, "checkout", "-q", "-b", "side")
    fs.writeFileSync(path.join(work, "side.txt"), "x\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "side")
    git(work, "checkout", "-q", "boxyard/feature")
    expect(check(work)).toBe("boxyard-pushed=no 1 unpushed commits")
  })

  it("says no for folders it can't vouch for", () => {
    expect(check(path.join(tmpDir("pushed-"), "missing"))).toBe("boxyard-pushed=no no work folder")
    expect(check(tmpDir("pushed-"))).toBe("boxyard-pushed=no not a git repo")
    const work = clone()
    git(work, "init", "-q", "nested")
    expect(check(work)).toBe("boxyard-pushed=no it holds more than one repo")
  })
})
