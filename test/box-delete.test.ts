import { afterAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { boxHead, boxSummary, deleteCheckScript, deleteVerdict, mapLimit, parseDeleteCheck, refusalsOf, type VerdictInput } from "../server/boxDelete.js"
import { pushedCheck } from "../server/janitor.js"
import { deleteAtRisk, type BoxContents } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// The delete safety check (delete_box, delete_idle_boxes, Delete box, Terminate pod): one script reads each
// workspace's git state on the box, and each task gets a verdict by the janitor's rules.

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env }).toString()
const dirs: string[] = []
const dir = () => {
  const d = tmpDir("box-delete-")
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** A clone of a bare origin, on its own pushed branch. */
function clone() {
  const root = dir()
  const bare = path.join(root, "origin.git")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  const work = path.join(root, "work")
  git(root, "clone", "-q", bare, work)
  fs.writeFileSync(path.join(work, "README.md"), "hi\n")
  git(work, "add", ".")
  git(work, "commit", "-qm", "init")
  git(work, "push", "-q", "origin", "main")
  git(work, "checkout", "-q", "-b", "boxyard/feature")
  git(work, "push", "-q", "-u", "origin", "boxyard/feature")
  return work
}
const commit = (work: string, file: string) => {
  fs.writeFileSync(path.join(work, file), "x\n")
  git(work, "add", ".")
  git(work, "commit", "-qm", file)
}
const run = (script: string) => execFileSync("bash", ["-c", script], { env }).toString()

const base: VerdictInput = { status: "done", running: false, wantsTurn: false, prState: null, hasRepo: true, reachable: true, git: null, archived: false }
const v = (over: Partial<VerdictInput>) => {
  const r = deleteVerdict({ ...base, ...over })
  return `${r.verdict}: ${r.detail}`
}

describe("pushedCheck committedOnly", () => {
  it("only asks whether every commit is pushed, whatever is uncommitted or stashed", () => {
    const work = clone()
    const check = (committedOnly: boolean) => run(pushedCheck(work, { committedOnly })).trim()
    fs.writeFileSync(path.join(work, "stray.txt"), "x\n")
    expect(check(false)).toBe("boxyard-pushed=no uncommitted changes")
    expect(check(true)).toBe("boxyard-pushed=yes")
    commit(work, "local.txt")
    expect(check(true)).toBe("boxyard-pushed=no 1 unpushed commits")
    expect(run(pushedCheck(path.join(dir(), "missing"), { committedOnly: true })).trim()).toBe("boxyard-pushed=no no work folder")
  })
})

describe("deleteCheckScript", () => {
  it("reads every workspace in one script: changed files, then the full and the commits-only check", () => {
    const clean = clone()
    const dirty = clone()
    fs.writeFileSync(path.join(dirty, "a.txt"), "x\n")
    fs.writeFileSync(path.join(dirty, "b.txt"), "x\n")
    const ahead = clone()
    commit(ahead, "one.txt")
    commit(ahead, "two.txt")
    const plain = dir()
    const missing = path.join(dir(), "gone")
    const out = parseDeleteCheck(
      run(
        deleteCheckScript([
          { id: "task_clean", work: clean },
          { id: "task_dirty", work: dirty },
          { id: "task_ahead", work: ahead },
          { id: "task_plain", work: plain },
          { id: "task_missing", work: missing },
        ]),
      ),
    )
    expect(Object.fromEntries(out)).toEqual({
      task_clean: { changed: 0, full: "yes", committed: "yes" },
      task_dirty: { changed: 2, full: "no uncommitted changes", committed: "yes" },
      task_ahead: { changed: 0, full: "no 2 unpushed commits", committed: "no 2 unpushed commits" },
      task_plain: { changed: null, full: "no not a git repo", committed: "no not a git repo" },
      task_missing: { changed: null, full: "no no work folder", committed: "no no work folder" },
    })
  })

  it("knows nothing about a task when the box didn't answer", () => {
    expect(parseDeleteCheck("").size).toBe(0)
    expect(parseDeleteCheck("boxyard-task=task_x\n").get("task_x")).toEqual({ changed: null, full: null, committed: null })
  })
})

describe("deleteVerdict", () => {
  it("holds the box for a running agent or a queued turn before anything else", () => {
    expect(v({ running: true, git: { changed: 0, full: "yes", committed: "yes" } })).toBe("running: an agent is running on it")
    expect(v({ status: "working" })).toBe("running: an agent is running on it")
    expect(v({ status: "queued", wantsTurn: true })).toBe("queued: queued for its next turn")
    expect(v({ status: "done", wantsTurn: true, reachable: false })).toBe("queued: has queued messages waiting for a turn")
  })

  it("lets go of work GitHub has, and of a merged PR's leftover files once its branch is fully pushed", () => {
    expect(v({ git: { changed: 0, full: "yes", committed: "yes" } })).toBe("ok: nothing uncommitted or unpushed; archived first")
    expect(v({ git: { changed: 0, full: "yes", committed: "yes" }, archived: true })).toBe("ok: nothing uncommitted or unpushed; its archive is up to date")
    expect(v({ prState: "merged", git: { changed: 0, full: "yes", committed: "yes" } })).toBe("ok: PR merged and nothing unpushed: needs no archive")
    // A GPU pod archives every workspace before it's terminated, merged or not.
    expect(v({ prState: "merged", git: { changed: 0, full: "yes", committed: "yes" }, archivesAll: true })).toBe("ok: nothing uncommitted or unpushed; archived first")
    expect(v({ prState: "merged", git: { changed: 3, full: "no uncommitted changes", committed: "yes" } })).toBe(
      "ok: PR merged and its branch fully pushed; the leftover uncommitted changes are archived first",
    )
    expect(v({ git: { changed: null, full: "no no work folder", committed: "no no work folder" } })).toBe("ok: no workspace on the box")
    expect(v({ hasRepo: false, git: { changed: null, full: "no not a git repo", committed: "no not a git repo" } })).toBe(
      "ok: no repo, so its folder only lives on the box; archived first",
    )
  })

  it("refuses work only the box has", () => {
    expect(v({ prState: "open", git: { changed: 2, full: "no uncommitted changes", committed: "yes" } })).toBe("dirty: uncommitted changes (2 files) and its PR is open")
    expect(v({ git: { changed: 1, full: "no uncommitted changes", committed: "yes" } })).toBe("dirty: uncommitted changes (1 file) and no PR")
    expect(v({ prState: "open", git: { changed: 0, full: "no stashed changes", committed: "yes" } })).toBe("dirty: stashed changes and its PR is open")
    expect(v({ git: { changed: 0, full: "no 1 unpushed commits", committed: "no 1 unpushed commits" } })).toBe("unpushed: 1 unpushed commit")
    // Merged doesn't cover commits GitHub never got.
    expect(v({ prState: "merged", git: { changed: 1, full: "no uncommitted changes", committed: "no 3 unpushed commits" } })).toBe(
      "unpushed: 3 unpushed commits and uncommitted changes",
    )
  })

  it("holds the box when it can't tell", () => {
    expect(v({ reachable: false })).toBe("unchecked: the box didn't answer, so its workspace couldn't be checked")
    expect(v({ git: null })).toBe("unchecked: its workspace couldn't be checked")
    expect(v({ git: { changed: null, full: "no not a git repo", committed: "no not a git repo" } })).toBe("unchecked: can't tell what's unpushed: not a git repo")
    expect(v({ git: { changed: 0, full: "no it holds more than one repo", committed: "yes" } })).toBe("unchecked: can't tell what's unpushed: it holds more than one repo")
  })
})

describe("refusals and summaries", () => {
  const contents = (tasks: Partial<BoxContents["tasks"][number]>[], over: Partial<BoxContents> = {}): BoxContents => ({
    boxId: "box_1",
    kind: "box",
    label: "box_1",
    tasks: tasks.map((t, i) => ({ id: `task_${i}`, title: `T${i}`, projectId: "prj_town", status: "done", running: false, uncommitted: 0, archived: false, prState: null, verdict: "ok", detail: "archived first", ...t })),
    running: 0,
    diskUsedBytes: null,
    diskBytes: null,
    busy: null,
    refusals: [],
    ...over,
  })
  const name = (id: string) => ({ prj_town: "tiny-town", prj_gpu: "vision" })[id] ?? id

  it("lists what holds the box first, then each task that isn't ok; Cody can delete past all but running agents", () => {
    const c = contents([{ verdict: "ok" }, { verdict: "running", detail: "an agent is running on it" }, { verdict: "dirty", detail: "uncommitted changes and no PR" }])
    expect(refusalsOf("This box is being cleared", c.tasks)).toEqual(["This box is being cleared", 'task_1 "T1": an agent is running on it', 'task_2 "T2": uncommitted changes and no PR'])
    expect(deleteAtRisk(c.tasks).map((t) => t.id)).toEqual(["task_2"])
  })

  it("groups a box's tasks by what happens to them, in one line", () => {
    const c = contents([
      { detail: "PR merged and nothing unpushed: needs no archive" },
      { detail: "archived first" },
      { detail: "PR merged and nothing unpushed: needs no archive" },
    ])
    expect(boxSummary(c, name)).toBe("box_1 · tiny-town · 3 tasks: 2 PR merged and nothing unpushed: needs no archive; 1 archived first")
    expect(boxSummary(contents([]), name)).toBe("box_1 · no tasks")
    const pod = contents([{ projectId: "prj_gpu" }], { boxId: "runpod-prj_gpu", kind: "pod", label: "GPU pod #1 · vision" })
    expect(boxHead(pod, name)).toBe("GPU pod #1 · vision · runpod-prj_gpu · vision")
  })
})

describe("mapLimit", () => {
  it("keeps the order and never runs more than the limit at once", async () => {
    let now = 0
    let most = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      most = Math.max(most, ++now)
      await new Promise((r) => setTimeout(r, n * 3))
      now--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(most).toBe(2)
    expect(await mapLimit([], 3, async () => 1)).toEqual([])
  })
})
