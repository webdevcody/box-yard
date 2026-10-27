import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { LocalProvider } from "../server/providers/local.js"
import { UPSTASH_MAX_UPLOAD_BYTES, isUploadTooBig, putFile, statedUploadLimit, uploadPartBytes } from "../server/upload.js"
import { ArchiveDecoder, archiveOutcome, archiveScript } from "../server/archive.js"
import { tmpDir } from "./helpers.js"

const KB = 1024

/** A local box whose uploads over `limit` are refused, and that can be told to fail the nth upload or exec. */
class LimitedBox extends LocalProvider {
  readonly uploads: number[] = []
  readonly execs: string[] = []
  failUpload = 0
  doubleExec = false
  /** Refuses uploads over this many bytes without advertising it (maxUploadBytes stays as given). */
  refuseOver = 0
  constructor(
    dir: string,
    readonly maxUploadBytes: number | undefined,
  ) {
    super(dir)
  }
  async uploadFile(boxId: string, localPath: string, destination: string) {
    const bytes = fs.statSync(localPath).size
    this.uploads.push(bytes)
    if (this.maxUploadBytes && bytes > this.maxUploadBytes) throw Object.assign(new Error("file exceeds maximum size of 100 MB"), { statusCode: 400 })
    if (this.refuseOver && bytes > this.refuseOver) throw Object.assign(new Error(`file exceeds maximum size of ${this.refuseOver / 1000} KB`), { statusCode: 400 })
    if (this.uploads.length === this.failUpload) throw new Error("socket hang up")
    return super.uploadFile(boxId, localPath, destination)
  }
  async exec(boxId: string, command: string) {
    this.execs.push(command)
    const res = await super.exec(boxId, command)
    // A retried request: the command runs again after it already ran once.
    return this.doubleExec ? super.exec(boxId, command) : res
  }
}

async function box(limit: number | undefined) {
  const p = new LimitedBox(tmpDir("boxes-"), limit)
  const id = await p.create()
  const src = path.join(tmpDir("box-yard-test-"), "archive.tgz")
  return { p, id, src, dest: path.join(p.root(id), ".boxyard", "restore-task_a.tgz") }
}
const random = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)))

describe("putFile", () => {
  it("parts stay about 10% under the limit and never over 90 MB", () => {
    expect(uploadPartBytes(UPSTASH_MAX_UPLOAD_BYTES)).toBe(90_000_000)
    expect(uploadPartBytes(1000)).toBe(900)
    expect(uploadPartBytes(10_000_000_000)).toBe(90_000_000)
  })

  it("knows a refusal for size", () => {
    expect(isUploadTooBig(new Error("file exceeds maximum size of 100 MB"))).toBe(true)
    expect(isUploadTooBig(Object.assign(new Error("nope"), { statusCode: 413 }))).toBe(true)
    expect(isUploadTooBig(new Error("socket hang up"))).toBe(false)
  })

  it("sends a file under the limit in one upload", async () => {
    const { p, id, src, dest } = await box(100 * KB)
    const data = random(50 * KB)
    fs.writeFileSync(src, data)
    expect(await putFile(p, id, src, dest)).toEqual({ parts: 1 })
    expect(fs.readFileSync(dest).equals(data)).toBe(true)
    expect(p.execs).toEqual([])
  })

  it("splits a file over the limit and joins it on the box, byte for byte", async () => {
    const { p, id, src, dest } = await box(100 * KB)
    const data = random(250 * KB + 7)
    fs.writeFileSync(src, data)
    expect(await putFile(p, id, src, dest)).toEqual({ parts: 3 })
    expect(fs.readFileSync(dest).equals(data)).toBe(true)
    expect(p.uploads.every((b) => b <= 100 * KB)).toBe(true)
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["restore-task_a.tgz"])
  })

  it("an append that runs twice (a retried exec) doesn't append twice", async () => {
    const { p, id, src, dest } = await box(100 * KB)
    p.doubleExec = true
    const data = random(250 * KB)
    fs.writeFileSync(src, data)
    await putFile(p, id, src, dest)
    expect(fs.readFileSync(dest).equals(data)).toBe(true)
  })

  it("a failed part leaves nothing behind on the box", async () => {
    const { p, id, src, dest } = await box(100 * KB)
    p.failUpload = 2
    fs.writeFileSync(src, random(250 * KB))
    await expect(putFile(p, id, src, dest)).rejects.toThrow("socket hang up")
    expect(fs.readdirSync(path.dirname(dest))).toEqual([])
  })

  it("without a known limit it sends the file whole", async () => {
    const { p, id, src, dest } = await box(undefined)
    fs.writeFileSync(src, random(250 * KB))
    await putFile(p, id, src, dest)
    expect(p.uploads).toEqual([250 * KB])
  })

  it("reads the limit a size refusal states", () => {
    expect(statedUploadLimit(new Error("file exceeds maximum size of 100 MB"))).toBe(100_000_000)
    expect(statedUploadLimit(new Error("File exceeds maximum file size of 1.5GB"))).toBe(1_500_000_000)
    expect(statedUploadLimit(new Error("payload too large"))).toBeNull()
  })

  it("a box that refuses a file for its size without advertising a limit gets it in parts under the stated limit", async () => {
    const { p, id, src, dest } = await box(undefined)
    p.refuseOver = 100 * KB
    const data = random(250 * KB + 3)
    fs.writeFileSync(src, data)
    expect(await putFile(p, id, src, dest)).toEqual({ parts: 3 })
    expect(fs.readFileSync(dest).equals(data)).toBe(true)
    // The whole file first, then three parts 10% under the stated limit.
    expect(p.uploads[0]).toBe(250 * KB + 3)
    expect(p.uploads.slice(1).every((b) => b <= 0.9 * 100 * KB)).toBe(true)
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["restore-task_a.tgz"])
  })

  it("a refusal for another reason isn't retried in parts", async () => {
    const { p, id, src, dest } = await box(undefined)
    p.failUpload = 1
    fs.writeFileSync(src, random(250 * KB))
    await expect(putFile(p, id, src, dest)).rejects.toThrow("socket hang up")
    expect(p.uploads).toHaveLength(1)
  })
})

describe("git-first archives leave ignored scratch dirs out", () => {
  it("keeps ignored config but not ignored perf captures, traces or temp files", () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString()
    const root = path.join(tmpDir("archive-"), "tasks")
    const work = path.join(root, "task_a", "work")
    fs.mkdirSync(path.join(root, "task_a", "claude"), { recursive: true })
    fs.writeFileSync(path.join(root, "task_a", "claude", "s.jsonl"), "{}\n")
    fs.mkdirSync(work, { recursive: true })
    git(work, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(work, ".gitignore"), ".env\nshots/\nperf/\ntraces/\ntmp/\n*.log\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "init")
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true })
      fs.writeFileSync(path.join(work, rel), rel)
    }
    for (const f of [".env", "shots/perf/run.jsonl", "perf/trace.json", "game/traces/t.json", "tmp/x", "debug.log"]) put(f)
    const stage = tmpDir("archive-stage-")
    fs.mkdirSync(path.join(stage, "task_a"))
    fs.writeFileSync(path.join(stage, "task_a", "git.manifest"), "head -\n")
    const maxBytes = 50 * 1024 * 1024
    const script = archiveScript({ root, taskId: "task_a", excludes: ["node_modules"], maxBytes, partial: false, git: { stage, ignored: true } })
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 1 << 28 })
    const parts: Buffer[] = []
    const decoder = new ArchiveDecoder((b) => parts.push(b))
    decoder.push(res.stdout)
    decoder.end()
    expect(archiveOutcome(decoder, { maxBytes, partial: false, exitCode: res.status ?? 1 })).toMatchObject({ ok: true })
    const out = tmpDir("archive-out-")
    fs.writeFileSync(path.join(out, "a.tgz"), Buffer.concat(parts))
    const names = execFileSync("tar", ["tzf", "a.tgz"], { cwd: out }).toString().split("\n").filter((n) => n && !n.endsWith("/"))
    expect(names.sort()).toEqual(["task_a/claude/s.jsonl", "task_a/git.manifest", "task_a/work/.env", "task_a/work/debug.log"])
  })
})
