import { describe, expect, it } from "vitest"
import { GIT_PREP_MARK, RESTORE_MARK, parseGitPrep, parseGitRestore } from "../server/gitFirst.js"

const b64 = (s: string) => Buffer.from(s).toString("base64")
const line = (fields: Record<string, string>) => `${GIT_PREP_MARK} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`
const W = "a".repeat(40)
const I = "b".repeat(40)
const H = "c".repeat(40)

describe("parseGitPrep", () => {
  it("reads a pushed snapshot", () => {
    const out = `noise\n${line({ status: "pushed", stage: "/tmp/boxyard-git-t1", head: H, branch: "boxyard/x", wip: W, index: I, pushed: W, dirty: "1", pack: "yes", branchpush: "yes", why: "" })}\n`
    expect(parseGitPrep(out)).toEqual({
      status: "pushed",
      stage: "/tmp/boxyard-git-t1",
      head: H,
      branch: "boxyard/x",
      wip: W,
      index: I,
      pushedWip: W,
      dirty: true,
      pack: "yes",
      branchPush: "yes",
      reason: null,
    })
  })

  it("reads '-' as nothing, and an unknown pack or status as not asked / failed", () => {
    const r = parseGitPrep(line({ status: "odd", stage: "-", head: "-", branch: "-", wip: "-", index: "-", pushed: "-", dirty: "0", pack: "?", branchpush: "-", why: "" }))
    expect(r).toMatchObject({ status: "failed", stage: null, head: null, branch: null, wip: null, pushedWip: null, dirty: false, pack: "-" })
  })

  it("is a failure, with the end of stderr, when the script never printed its line", () => {
    expect(parseGitPrep("", "line one\nbash: git: command not found\n")).toMatchObject({ status: "failed", reason: "the git snapshot didn't finish: line one; bash: git: command not found" })
    expect(parseGitPrep("")).toMatchObject({ status: "failed", reason: "the git snapshot didn't finish" })
  })

  it("turns a push the token can't make into a quiet skip, naming only git's line, token redacted", () => {
    const why = `git push of refs/boxyard/wip/t1: remote: Permission to o/r.git denied to bot.\nfatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/': The requested URL returned error: 403\n`
    const r = parseGitPrep(line({ status: "failed", stage: "/tmp/s", head: H, branch: "b", wip: W, index: I, pushed: "-", dirty: "1", pack: "yes", branchpush: "-", why: b64(why) }))
    expect(r.status).toBe("skipped")
    expect(r.reason).toBe("no write access to origin (git push of refs/boxyard/wip/t1: remote: Permission to o/r.git denied to bot.)")
    const only403 = parseGitPrep(line({ status: "failed", why: b64("git push: fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/': The requested URL returned error: 403") }))
    expect(only403.status).toBe("skipped")
    expect(only403.reason).toContain("x-access-token:***@github.com")
    expect(only403.reason).not.toContain("ghs_secret")
  })

  it("keeps other failures as failures, on one line", () => {
    const r = parseGitPrep(line({ status: "failed", why: b64("git push: To github.com:o/r.git\n ! [remote rejected] HEAD -> x (protected branch hook declined)\n") }))
    expect(r).toMatchObject({ status: "failed", reason: "git push: To github.com:o/r.git; ! [remote rejected] HEAD -> x (protected branch hook declined)" })
    expect(parseGitPrep(line({ status: "skipped", why: b64("the repo has submodules") })).reason).toBe("the repo has submodules")
  })
})

describe("parseGitRestore", () => {
  it("reads each outcome", () => {
    expect(parseGitRestore(`x\n${RESTORE_MARK} git -\n`)).toEqual({ ok: true, from: "git", reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} partial -`)).toEqual({ ok: true, from: "partial", reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} none -`)).toEqual({ ok: true, from: null, reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} failed ${b64("git clone failed: https://x-access-token:abc@github.com/o/r: 403")}`)).toEqual({
      ok: false,
      from: null,
      reason: "git clone failed: https://x-access-token:***@github.com/o/r: 403",
    })
    expect(parseGitRestore("", "Killed")).toEqual({ ok: false, from: null, reason: "the restore script didn't finish: Killed" })
  })
})
