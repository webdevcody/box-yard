import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { buildsDue, ownCleanupOrder } from "../server/ownCleanup.js"
import type { TaskRow } from "../server/store.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import { tmpDir } from "./helpers.js"

// Which folders on this computer (and SSH machines) the local cleanup may touch, in which order, and the runner's
// `clean <dir> builds`, which frees dependency and build output but never scratch or captures.

const H = 60 * 60_000
const now = 1_000 * H
const row = (id: string, over: Partial<TaskRow> = {}): TaskRow =>
  ({ id, box_id: LOCAL_BOX_ID, status: "done", current_turn_id: null, last_active_at: now - H, previews_json: "[]", pr_state: null, ...over }) as TaskRow
const never = () => false

describe("ownCleanupOrder", () => {
  it("takes done folders first, then the least recently active, and only resting ones on that computer", () => {
    const rows = [
      row("idle_new", { status: "idle", last_active_at: now - 2 * H }),
      row("done_new", { last_active_at: now - 3 * H }),
      row("idle_old", { status: "pr_ready", last_active_at: now - 50 * H }),
      row("done_old", { last_active_at: now - 40 * H }),
      row("failed", { status: "failed", last_active_at: now - 60 * H }),
      row("running", { status: "working", current_turn_id: "turn_1" }),
      row("starting", { status: "starting" }),
      row("queued", { status: "queued" }),
      row("asks", { status: "needs_input" }),
      row("waits", { status: "waiting" }),
      row("elsewhere", { box_id: "ssh-tower" }),
    ]
    expect(ownCleanupOrder(rows, LOCAL_BOX_ID, never).map((r) => r.id)).toEqual(["done_old", "done_new", "failed", "idle_old", "idle_new"])
  })

  it("never takes a task with a message or compaction waiting, nor a live preview unless it's done", () => {
    const rows = [
      row("has_input", { status: "idle" }),
      row("preview_idle", { status: "idle", previews_json: '[{"port":4000,"url":"http://localhost:4000"}]' }),
      row("preview_done", { previews_json: '[{"port":4000,"url":"http://localhost:4000"}]' }),
    ]
    expect(ownCleanupOrder(rows, LOCAL_BOX_ID, (r) => r.id === "has_input").map((r) => r.id)).toEqual(["preview_done"])
  })
})

describe("buildsDue", () => {
  it("frees a done task's build output at once and another resting one's after the idle hours", () => {
    const rows = [row("done_now", { last_active_at: now - 1000 }), row("idle_7h", { status: "idle", last_active_at: now - 7 * H }), row("idle_5h", { status: "idle", last_active_at: now - 5 * H })]
    expect(buildsDue(rows, LOCAL_BOX_ID, 6, now, never).map((r) => r.id)).toEqual(["done_now", "idle_7h"])
    // 0 idle hours: only done tasks.
    expect(buildsDue(rows, LOCAL_BOX_ID, 0, now, never).map((r) => r.id)).toEqual(["done_now"])
  })
})

describe("box-runner clean <dir> builds", () => {
  it("removes only ignored, untracked dependency and build output, never scratch, captures or tracked files", () => {
    const taskDir = tmpDir("box-yard-test-clean-")
    const work = path.join(taskDir, "work")
    fs.mkdirSync(work)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true })
      fs.writeFileSync(path.join(work, rel), "x")
    }
    git("init", "-q", "-b", "main")
    fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\ndist/\nbuild/\ntmp/\nshots/\n")
    put("src/index.ts")
    put("docs/build/tracked.md") // a tracked build/ is source
    git("add", ".")
    git("add", "-f", "docs/build/tracked.md")
    git("commit", "-qm", "init")
    for (const rel of ["node_modules/a/index.js", "dist/out.js", "packages/web/build/out.js", "tmp/scratch.txt", "shots/one.png"]) put(rel)

    const out = execFileSync(process.execPath, [path.resolve("runner/box-runner.mjs"), "clean", taskDir, "builds"], { encoding: "utf8" })
    expect(out.split("\n").filter(Boolean).sort()).toEqual(["dist", "node_modules", "packages/web/build"])
    for (const gone of ["node_modules", "dist", "packages/web/build"]) expect(fs.existsSync(path.join(work, gone))).toBe(false)
    for (const kept of ["tmp/scratch.txt", "shots/one.png", "src/index.ts", "docs/build/tracked.md"]) expect(fs.existsSync(path.join(work, kept))).toBe(true)
    // The next prompt says what went.
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, "cleaned.json"), "utf8")).dirs.sort()).toEqual(["dist", "node_modules", "packages/web/build"])
  })
})
