import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { SCRATCH_MARKER, depsSaveSummary, stripCounts, stripScript, stripSummary } from "../server/boxSnapshot.js"
import { snapshotJobLine, snapshotSkipReason, SNAPSHOT_STEP_LABELS, type SnapshotJob } from "../shared/snapshots.js"
import { tmpDir } from "./helpers.js"

// The strip script that turns a scratch copy of a box into a project's snapshot, and the lines Box Yard writes
// about it. The end-to-end run is in project-snapshot.e2e.test.ts.

/** A box folder with a task's uncommitted work, a login and a temp file. */
function box() {
  const root = tmpDir("box-yard-strip-")
  const put = (rel: string, content = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  put("tasks/task_1/work/uncommitted.txt", "work\n")
  put("home/.git-credentials", "secret\n")
  put("tmp/scratch.log")
  fs.mkdirSync(path.join(root, ".boxyard", "repos"), { recursive: true })
  const spec = { root, tasks: `${root}/tasks`, home: `${root}/home`, tmp: `${root}/tmp`, keepMirror: null, jobId: "snp_1" }
  const run = (s = spec) => spawnSync("bash", ["-c", stripScript(s)], { encoding: "utf8" })
  return { root, put, spec, run }
}

describe("stripScript", () => {
  it("refuses a box without this job's scratch marker, and removes nothing", () => {
    const b = box()
    const none = b.run()
    expect(none.status).toBe(3)
    expect(none.stderr).toContain("not this snapshot's scratch box: nothing was stripped")
    b.put(SCRATCH_MARKER, "snp_other")
    expect(b.run().status).toBe(3)
    for (const kept of ["tasks/task_1/work/uncommitted.txt", "home/.git-credentials", "tmp/scratch.log"]) expect(fs.existsSync(path.join(b.root, kept)), kept).toBe(true)
  })

  it("refuses an empty or / folder", () => {
    const b = box()
    b.put(SCRATCH_MARKER, "snp_1")
    expect(b.run({ ...b.spec, home: "" }).status).toBe(3)
    expect(b.run({ ...b.spec, tmp: "/" }).status).toBe(3)
    expect(fs.existsSync(path.join(b.root, "tasks/task_1/work/uncommitted.txt"))).toBe(true)
  })

  it("strips the scratch box it's marked for and drops the marker", () => {
    const b = box()
    b.put(SCRATCH_MARKER, "snp_1")
    const res = b.run()
    expect(res.status).toBe(0)
    expect(fs.readdirSync(path.join(b.root, "tasks"))).toEqual([])
    expect(fs.existsSync(path.join(b.root, "home/.git-credentials"))).toBe(false)
    expect(fs.existsSync(path.join(b.root, "tmp/scratch.log"))).toBe(false)
    expect(fs.existsSync(path.join(b.root, SCRATCH_MARKER))).toBe(false)
    expect(stripCounts(res.stdout)).toMatchObject({ workspaces: 1, credentials: 1, tmp: 1, "kept-deps": 0 })
  })
})

describe("snapshot lines", () => {
  it("sums up a strip", () => {
    expect(stripSummary({ workspaces: 3, mirrors: 1, credentials: 3, npmrc: 1, logs: 5, tmp: 6, "boxyard-tmp": 1, "kept-deps": 2 }, "app.git")).toBe(
      "Removed 3 workspaces, 1 other repo mirror, 4 logins and tokens and 12 temp files and logs; kept the app.git mirror and 2 dependency cache entries",
    )
    expect(stripSummary({ workspaces: 1, credentials: 1, "kept-deps": 1 }, null)).toBe(
      "Removed 1 workspace, 1 login or token and 0 temp files and logs; kept 1 dependency cache entry",
    )
  })

  it("sums up the dependency save", () => {
    const out = [
      'boxyard-deps={"action":"saved"}',
      'boxyard-deps={"action":"present"}',
      'boxyard-deps={"action":"skipped","reason":"node_modules doesn\'t match package-lock.json"}',
      "boxyard-deps=node: not found",
      "noise",
    ].join("\n")
    expect(depsSaveSummary(out)).toBe(
      "node_modules to the dependency cache: saved 1, already cached 1, skipped 2 (node_modules doesn't match package-lock.json; node: not found)",
    )
    expect(depsSaveSummary("")).toBeNull()
  })

  it("uses a snapshot only on a box of its provider and its size or bigger", () => {
    const snap = { id: "snap-1", provider: "upstash", size: "medium" as const }
    expect(snapshotSkipReason(snap, "medium", "upstash")).toBeNull()
    expect(snapshotSkipReason(snap, "large", "upstash")).toBeNull()
    expect(snapshotSkipReason(snap, "small", "upstash")).toBe("snapshot snap-1 was taken on a medium box and might not fit a small one (replace it from a small box to use it there)")
    expect(snapshotSkipReason(snap, "medium", "local")).toBe("snapshot snap-1 is from upstash and new boxes come from local")
  })

  it("says where a job is", () => {
    const step = (key: keyof typeof SNAPSHOT_STEP_LABELS, status: SnapshotJob["steps"][number]["status"]) => ({ key, label: SNAPSHOT_STEP_LABELS[key], status, detail: null })
    const job: SnapshotJob = {
      id: "snp_1",
      projectId: "p",
      boxId: "b",
      size: "small",
      status: "running",
      steps: [step("snapshot", "done"), step("restore", "running"), step("strip", "pending"), step("save", "pending"), step("cleanup", "pending")],
      by: { kind: "cody" },
      reason: null,
      scratchBoxId: null,
      snapshotId: null,
      error: null,
      startedAt: 0,
      finishedAt: null,
    }
    expect(snapshotJobLine(job)).toBe("Step 2 of 5: Restore it on a scratch box")
    expect(snapshotJobLine({ ...job, status: "failed", error: "Restore it on a scratch box: no room" })).toBe("Failed: Restore it on a scratch box: no room")
    expect(snapshotJobLine({ ...job, status: "done" })).toBe("Saved")
  })
})
