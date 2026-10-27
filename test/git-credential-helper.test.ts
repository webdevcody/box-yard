import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { GITHUB_HELPER, gitWithHelper, setHelperScript } from "../server/gitShare.js"
import { gitRestoreScript } from "../server/gitFirst.js"
import { thinRestoreScript } from "../server/archive.js"
import { q } from "../server/providers/types.js"
import { tmpDir } from "./helpers.js"

// F1: on an Upstash box whose global git config had `credential.helper=store`, git asked the store first and pushed
// with whatever token it held, never the project's GITHUB_TOKEN. Box Yard's helper now clears the inherited ones.

/** A box's git: a global config with a stored credential and gh's github.com helper, and no system config. */
function box() {
  const dir = tmpDir("f1-")
  const global = path.join(dir, "gitconfig")
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: global, GITHUB_TOKEN: "project-token", GIT_TERMINAL_PROMPT: "0" }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString()
  git(dir, "config", "--global", "credential.helper", "!f() { echo username=stored; echo password=stored-token; }; f")
  git(dir, "config", "--global", "credential.https://github.com.helper", "!f() { echo username=gh; echo password=gh-token; }; f")
  const repo = path.join(dir, "repo")
  git(dir, "init", "-q", repo)
  const sh = (script: string) => execFileSync("bash", ["-c", script], { cwd: repo, env, stdio: "pipe" }).toString()
  /** The password git would send to github.com from the repo. */
  const password = (prefix = "git") => sh(`printf 'protocol=https\\nhost=github.com\\n\\n' | ${prefix} credential fill`).match(/^password=(.*)$/m)?.[1]
  return { dir, repo, git, sh, password }
}

describe("Box Yard's GitHub credential helper (F1)", () => {
  it("the inherited helpers answered first before the fix", () => {
    const b = box()
    b.sh(`git config credential.helper ${q(GITHUB_HELPER)}`)
    expect(b.password()).toBe("stored-token")
    expect(b.password(`git -c credential.helper=${q(GITHUB_HELPER)}`)).toBe("stored-token")
  })

  it("only: the repo's config and one-off git commands use the project's token", () => {
    const b = box()
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.password()).toBe("project-token")
    // Safe to run again (each turn does): still one empty entry and Box Yard's helper.
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.git(b.repo, "config", "--local", "--get-all", "credential.helper").split("\n").filter(Boolean)).toEqual([GITHUB_HELPER])
    expect(fs.readFileSync(path.join(b.repo, ".git", "config"), "utf8")).toMatch(/helper = \n\s*helper = /)
    expect(b.password(gitWithHelper(GITHUB_HELPER, true))).toBe("project-token")
  })

  it("not only (this computer, no project token): the owner's own git login still answers first", () => {
    const b = box()
    b.sh(setHelperScript(GITHUB_HELPER, false))
    expect(b.password()).toBe("stored-token")
    expect(b.password(gitWithHelper(GITHUB_HELPER, false))).toBe("stored-token")
    // Going back to only from there, and the other way, works on the same repo.
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.password()).toBe("project-token")
    b.sh(setHelperScript(GITHUB_HELPER, false))
    expect(b.password()).toBe("stored-token")
  })

  it("the restore scripts set it the same way", () => {
    const helper = { helper: GITHUB_HELPER, only: true }
    const thin = thinRestoreScript("/t", { root: "/r", mirror: "/r/m.git", url: "https://github.com/a/b.git", partial: false, git: "git" }, { ...helper, userName: "t", userEmail: "t@t" })
    expect(thin).toContain(setHelperScript(GITHUB_HELPER, true))
    const first = gitRestoreScript({ dir: "/t", taskId: "t", baseBranch: "main", gitUserName: "t", gitUserEmail: "t@t", clone: { script: "true", ...helper }, git: gitWithHelper(GITHUB_HELPER, true), env: "true" })
    expect(first).toContain(setHelperScript(GITHUB_HELPER, true, "git -C work"))
  })
})
