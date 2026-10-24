import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { CLEANUP_STEPS, cleanupSummary, dfCommand, diskLine, formatBytes, isOutOfSpace, measuredAgo, parseDf, requiredFreeBytes, rootDiskLine, rootLow } from "../shared/disk.js"
import { buildCleanupOrder, parkOrder, staleTaskDir, staleTmpScript, STALE_TMP_PATTERNS } from "../server/janitor.js"
import { tmpDir } from "./helpers.js"
import type { TaskRow } from "../server/store.js"

const MB = 1024 * 1024
const GB = 1024 * MB

describe("parseDf", () => {
  it("reads free and total bytes from df -Pk", () => {
    const out = "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/nvme0n1       5242880 4998276    244604      96% /workspace\n"
    expect(parseDf(out)).toEqual({ totalBytes: 5242880 * 1024, freeBytes: 244604 * 1024, root: null })
  })

  it("copes with spaces in the filesystem name and a bare last line", () => {
    expect(parseDf("map auto_home  100 40 60 40% /System/Volumes/Data/home")).toEqual({ totalBytes: 100 * 1024, freeBytes: 60 * 1024, root: null })
  })

  it("reads the root disk after the mark when /tmp is another filesystem", () => {
    const out = [
      "/dev/nvme1n1       5242880 4998276    244604      96% /workspace",
      "@@boxyard-root-df",
      "overlay            8388608 7864320    524288      94% /",
    ].join("\n")
    expect(parseDf(out)).toEqual({ totalBytes: 5242880 * 1024, freeBytes: 244604 * 1024, root: { totalBytes: 8388608 * 1024, freeBytes: 524288 * 1024 } })
  })

  it("leaves the root disk out when /tmp is on the work disk, or its df failed", () => {
    expect(parseDf("/dev/sda1 100 40 60 40% /\n@@boxyard-root-df\n/dev/sda1 100 40 60 40% /\n")).toEqual({ totalBytes: 100 * 1024, freeBytes: 60 * 1024, root: null })
    expect(parseDf("/dev/sda1 100 40 60 40% /work\n@@boxyard-root-df\n")).toEqual({ totalBytes: 100 * 1024, freeBytes: 60 * 1024, root: null })
  })

  it("returns null for output it can't read", () => {
    expect(parseDf("")).toBeNull()
    expect(parseDf("df: /nope: No such file or directory")).toBeNull()
  })

  it("quotes the path", () => {
    expect(dfCommand("/workspace/home")).toMatch(/^df -Pk '\/workspace\/home' \| tail -n 1; echo @@boxyard-root-df; df -Pk \/tmp 2>\/dev\/null \| tail -n 1; echo @@boxyard-mem; /)
    expect(dfCommand("/a'b")).toContain(`'/a'\\''b'`)
  })
})

describe("diskLine", () => {
  const now = 1_000_000_000
  it("states df free of total, with how old the reading is", () => {
    expect(diskLine({ freeBytes: 943 * MB, totalBytes: 5 * GB, checkedAt: now - 12_000 }, now)).toBe("943 MB free of 5.0 GB · measured 12s ago")
    expect(diskLine({ freeBytes: 943 * MB, totalBytes: 5 * GB }, now)).toBe("943 MB free of 5.0 GB")
  })
  it("says when there is no reading yet", () => {
    expect(diskLine({ freeBytes: null, totalBytes: null, checkedAt: null }, now)).toBe("free space not measured yet")
  })
  it("ages in seconds, minutes, then hours", () => {
    expect(measuredAgo(now - 89_000, now)).toBe("measured 89s ago")
    expect(measuredAgo(now - 5 * 60_000, now)).toBe("measured 5m ago")
    expect(measuredAgo(now - 3 * 3600_000, now)).toBe("measured 3h ago")
  })
})

describe("isOutOfSpace", () => {
  it("recognizes the git clone failure that started this", () => {
    const msg =
      "git clone of webdevcody-aipulsedaily/survive-the-night-fps failed: Cloning into 'work'... fatal: sha1 file '/workspace/home/tasks/task_c202e7063073/work/.git/objects/pack/tmp_pack_td8Dik' write error. Out of diskspace fatal: cannot repack to clean up just now"
    expect(isOutOfSpace(msg)).toBe(true)
  })

  it.each([
    "npm ERR! code ENOSPC",
    "tar: work/x: Cannot write: No space left on device",
    "error: unable to write file: Disk quota exceeded",
    "fatal: write error: Out of disk space",
  ])("matches %s", (msg) => expect(isOutOfSpace(msg)).toBe(true))

  it.each(["git clone failed: Repository not found", "box not responding: timeout", "", null])("ignores %s", (msg) => expect(isOutOfSpace(msg)).toBe(false))
})

describe("requiredFreeBytes", () => {
  const policy = { minFreeMb: 1024, cloneFactor: 2 }
  it("needs the floor when the repo was never cloned", () => {
    expect(requiredFreeBytes(policy, null)).toBe(GB)
  })
  it("needs about twice a big repo's last clone size", () => {
    expect(requiredFreeBytes(policy, 800 * MB)).toBe(1600 * MB)
  })
  it("keeps the floor for small repos", () => {
    expect(requiredFreeBytes(policy, 10 * MB)).toBe(GB)
  })
  it("never multiplies by less than 1", () => {
    expect(requiredFreeBytes({ minFreeMb: 0, cloneFactor: 0.5 }, 100 * MB)).toBe(100 * MB)
  })
})

describe("cleanup summaries", () => {
  it("names each step that freed something", () => {
    const steps = CLEANUP_STEPS.map((s) => ({ key: s.key, label: s.label, freedBytes: 0, removed: [], skipped: null }))
    steps[2]!.freedBytes = 800 * MB
    steps[3]!.freedBytes = 400 * MB
    expect(cleanupSummary({ freedBytes: 1200 * MB, steps })).toBe("freed 1.2 GB (caches 800 MB, builds 400 MB)")
    expect(cleanupSummary({ freedBytes: 0, steps })).toBe("freed nothing")
  })

  it("formats bytes", () => {
    expect(formatBytes(244604 * 1024)).toBe("239 MB")
    expect(formatBytes(5 * GB)).toBe("5.0 GB")
    expect(formatBytes(null)).toBe("—")
  })

  it("runs the steps in the safe order", () => {
    expect(CLEANUP_STEPS.map((s) => s.key)).toEqual(["tmp", "partials", "caches", "builds", "git", "archive"])
  })
})

describe("root disk", () => {
  it("is low under 512 MB free, or under a tenth of a big disk", () => {
    expect(rootLow({ freeBytes: 380 * MB, totalBytes: 5 * GB })).toBe(true)
    expect(rootLow({ freeBytes: 600 * MB, totalBytes: 5 * GB })).toBe(false)
    expect(rootLow({ freeBytes: 1.5 * GB, totalBytes: 20 * GB })).toBe(true)
    expect(rootLow({ freeBytes: 3 * GB, totalBytes: 20 * GB })).toBe(false)
  })

  it("is never low when it isn't measured or is the work disk", () => {
    expect(rootLow(null)).toBe(false)
    expect(rootLow({ freeBytes: null, totalBytes: null })).toBe(false)
    expect(rootDiskLine({ rootFreeBytes: null, rootTotalBytes: null })).toBeNull()
    expect(rootDiskLine({})).toBeNull()
  })

  it("says where it is", () => {
    expect(rootDiskLine({ rootFreeBytes: 380 * MB, rootTotalBytes: 5 * GB })).toBe("380 MB free of 5.0 GB on the root disk (/tmp, home)")
  })
})

describe("stale temp folders", () => {
  const old = (Date.now() - 40 * 60_000) / 1000
  /** A folder with one file; `stale` dates both 40 minutes back. */
  const folder = (dir: string, stale: boolean) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "f"), "x".repeat(4096))
    if (stale) for (const f of [path.join(dir, "f"), dir]) fs.utimesSync(f, old, old)
  }

  it("removes Box Yard's and test runs' folders nothing touched in 30 minutes, and nothing else", () => {
    const base = tmpDir()
    try {
      // The script's /tmp, moved into a scratch folder so this test never sweeps the machine's own.
      const tmp = path.join(base, "tmp")
      const root = path.join(base, "box")
      for (const name of ["box-yard-test-old", "box-yard-origin-old", "thin-old", "archive-old", "boxes-old", "boxyard-git-task_old"]) folder(path.join(tmp, name), true)
      folder(path.join(tmp, "box-yard-test-fresh"), false)
      folder(path.join(tmp, "someone-elses-old"), true)
      // An old folder with a file written a moment ago is still in use.
      folder(path.join(tmp, "archive-busy"), true)
      fs.writeFileSync(path.join(tmp, "archive-busy", "now"), "writing")
      folder(path.join(root, ".boxyard", "tmp", "boxyard-archive-keep-task_old"), true)
      folder(path.join(root, ".boxyard", "tmp", "boxyard-git-task_now"), false)

      // Only the bare /tmp globs: the box's quoted root lives under /tmp here too.
      const script = staleTmpScript(root, false).replaceAll(" /tmp/", ` ${tmp}/`)
      const out = execFileSync("bash", ["-c", script]).toString()
      const removed = out
        .trim()
        .split("\n")
        .map((l) => l.replace(/^\d+ /, ""))
        .sort()
      expect(removed).toEqual(
        [...["archive-old", "box-yard-origin-old", "box-yard-test-old", "boxes-old", "boxyard-git-task_old", "thin-old"].map((n) => path.join(tmp, n)), path.join(root, ".boxyard", "tmp", "boxyard-archive-keep-task_old")].sort(),
      )
      expect(out).toMatch(/^\d+ /)
      expect(fs.readdirSync(tmp).sort()).toEqual(["archive-busy", "box-yard-test-fresh", "someone-elses-old"])
      expect(fs.readdirSync(path.join(root, ".boxyard", "tmp"))).toEqual(["boxyard-git-task_now"])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("leaves /tmp alone on a local box, whose /tmp is this machine's", () => {
    expect(staleTmpScript("/r", true)).not.toContain("/tmp/")
    expect(staleTmpScript("/r", true)).toContain("'/r/.boxyard/tmp'/*")
    for (const p of STALE_TMP_PATTERNS) expect(staleTmpScript("/r", false)).toContain(`/tmp/${p}`)
  })
})

const row = (over: Partial<TaskRow>): TaskRow =>
  ({
    id: "t",
    project_id: "p",
    status: "idle",
    box_id: "box-a",
    session_started: 1,
    current_turn_id: null,
    last_active_at: 0,
    ...over,
  }) as TaskRow

describe("which task folders a cleanup may delete", () => {
  it("deletes folders of tasks Box Yard doesn't know", () => {
    expect(staleTaskDir(null, "box-a", false)).toBe("unknown task")
  })

  it("deletes a folder left behind by a task that moved, when its archive holds the work", () => {
    expect(staleTaskDir(row({ box_id: "box-b" }), "box-a", true)).toBe("moved off this box")
    expect(staleTaskDir(row({ box_id: null, session_started: 0 }), "box-a", false)).toBe("moved off this box")
  })

  it("keeps a moved task's folder when it is the only copy of its work", () => {
    expect(staleTaskDir(row({ box_id: null }), "box-a", false)).toBeNull()
  })

  it("deletes a failed setup's half-made folder, but never a task that ran", () => {
    expect(staleTaskDir(row({ status: "failed", session_started: 0 }), "box-a", false)).toBe("setup failed before its first turn")
    expect(staleTaskDir(row({ status: "failed", session_started: 1 }), "box-a", false)).toBeNull()
  })

  it("never deletes an idle, working or starting task's folder", () => {
    expect(staleTaskDir(row({ status: "idle" }), "box-a", true)).toBeNull()
    expect(staleTaskDir(row({ status: "working", current_turn_id: "turn" }), "box-a", true)).toBeNull()
    expect(staleTaskDir(row({ status: "starting", box_id: "box-b", session_started: 0 }), "box-a", true)).toBeNull()
  })
})

describe("cleanup order inside a step", () => {
  const rows = [
    row({ id: "idle-old", status: "idle", last_active_at: 1 }),
    row({ id: "done-new", status: "done", last_active_at: 9 }),
    row({ id: "done-old", status: "done", last_active_at: 2 }),
    row({ id: "working", status: "working", current_turn_id: "x" }),
    row({ id: "queued", status: "queued" }),
    row({ id: "elsewhere", status: "done", box_id: "box-b" }),
    row({ id: "has-input", status: "idle" }),
  ]
  const hasInputs = (id: string) => id === "has-input"

  it("cleans build output of done tasks first, then the least recently active resting ones", () => {
    expect(buildCleanupOrder(rows, "box-a", hasInputs).map((r) => r.id)).toEqual(["done-old", "done-new", "idle-old"])
  })

  it("parks only done workspaces, oldest first", () => {
    expect(parkOrder(rows, "box-a", hasInputs).map((r) => r.id)).toEqual(["done-old", "done-new"])
  })
})
