import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Commit signing and the local-runner walls, end to end (docs/identities.md): a turn signs its commits with its
// identity's key, the key is gone when the turn ends, requireSigned stops unsigned commits before any branch push,
// and on this computer an identity other than Default gets its own git config and gh folder, not the owner's.
// Real git and ssh-keygen with throwaway keys; origin is a bare repo on disk. This computer's own git config is
// kept out of every git command here (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM).

const saved: Record<string, string | undefined> = {}
let ownerConfig = ""
beforeAll(() => {
  // "The owner's" global git config, for the walls test: an identity other than Default must not see it.
  ownerConfig = path.join(tmpDir("owner-git-"), "gitconfig")
  fs.writeFileSync(ownerConfig, "[user]\n\temail = owner@laptop.example\n")
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GH_CONFIG_DIR"]) saved[k] = process.env[k]
  process.env.GIT_CONFIG_GLOBAL = ownerConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  delete process.env.GH_CONFIG_DIR
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A throwaway ed25519 key pair. */
function keyPair() {
  const file = path.join(tmpDir("signing-key-"), "key")
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", file])
  return { file, privateKey: fs.readFileSync(file, "utf8"), pub: fs.readFileSync(`${file}.pub`, "utf8").trim() }
}

/** A bare origin with a main branch, and the signature status of its commits as `<subject> <%G?>`. */
function origin() {
  const root = tmpDir("signing-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  const ref = (name: string) => git(bare, "for-each-ref", "--format=%(objectname)", name) || null
  const signatures = (rev: string, publicKey: string) => {
    const allowed = path.join(root, "allowed")
    fs.writeFileSync(allowed, `box-yard namespaces="git" ${publicKey}\n`)
    return git(bare, "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "log", "--format=%s %G?", rev, "--not", "main").split("\n").filter(Boolean)
  }
  return { url: `file://${bare}`, ref, signatures }
}

/**
 * `claude` for these tests: does what the prompt's markers ask in work/ ([commit] a signed commit, [unsigned] one
 * with signing turned off, [ownhook] a pre-push hook of the repo's own, [push] git push), writes what it saw to the
 * log, then runs the fake claude with the same prompt.
 */
function wrapper(dir: string, log: string) {
  const claude = path.join(dir, "claude")
  fs.writeFileSync(
    claude,
    `#!/bin/sh
prompt=$(cat)
L=${JSON.stringify(log)}
echo "CWD=$PWD" >> "$L"
case "$prompt" in *"[commit]"*|*"[unsigned]"*) git rev-parse --git-dir >/dev/null 2>&1 || git init -q ;; esac
case "$prompt" in *"[ownhook]"*) h="$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks)"; mkdir -p "$h"; printf '#!/bin/sh\\necho OWN_HOOK_RAN >> %s\\n' "'$L'" > "$h/pre-push"; chmod +x "$h/pre-push" ;; esac
case "$prompt" in *"[commit]"*) echo x >> signed.txt; git add signed.txt; git commit -qm "signed by the turn" >> "$L" 2>&1 || echo COMMIT_FAILED >> "$L" ;; esac
case "$prompt" in *"[unsigned]"*) echo y >> unsigned.txt; git add unsigned.txt; git -c commit.gpgSign=false commit -qm "not signed" >> "$L" 2>&1 ;; esac
case "$prompt" in *"[push]"*) git push -q origin HEAD >> "$L" 2>&1; echo "PUSH_EXIT=$?" >> "$L" ;; esac
k=$(git config user.signingKey 2>/dev/null) && echo "SIGNING_KEY=$k" >> "$L" && [ -f "$k" ] && echo "KEY_MODE=$(stat -f %Lp "$k" 2>/dev/null || stat -c %a "$k")" >> "$L"
git log -3 --format='SIG %s %G?' >> "$L" 2>/dev/null
env | grep -E '^(GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GH_CONFIG_DIR)=' >> "$L"
echo "GLOBAL_EMAIL=$(git config --global --get user.email || echo none)" >> "$L"
echo --- >> "$L"
printf '%s' "$prompt" | exec ${FAKE_CLAUDE} "$@"
`,
    { mode: 0o755 },
  )
  return claude
}

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const dir = tmpDir("signing-e2e-")
  const log = path.join(dir, "claude.log")
  const claude = wrapper(dir, log)
  const port = await freePort()
  const config = testConfig({ port, claudeBin: claude, anthropicApiKey: "global-key", maxBoxes: 4 })
  const yard = createBoxYard(config, {
    webDir: "/nonexistent",
    provider: new LocalProvider(path.join(dir, "boxes"), claude),
    localRunner: new LocalRunnerProvider(config.localDir, claude),
  })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
    return JSON.parse(text) as T
  }
  const turns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("---\n").filter(Boolean) : []).map((t) => t.trim().split("\n"))
  /** A project on `identityId` whose repo is `url` (the API takes only GitHub repos). */
  const project = async (name: string, identityId: string, o: { url?: string; runner?: "local" } = {}) => {
    const p = await call<Project>("POST", "/api/projects", { name, identityId, ...(o.runner ? { runner: o.runner } : {}) })
    if (o.url) yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(o.url, p.id)
    return yard.store.getProject(p.id)!
  }
  /** Run a task to its end (and its archive), and give back what the wrapper logged for its turn. */
  const runTask = async (p: Project, prompt: string) => {
    const before = turns().length
    const task = await call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Work", prompt })
    const done = await waitFor(() => {
      const t = yard.store.getTask(task.id)
      return t?.status === "done" && (t.lastArchivedAt || !p.repo || t.boxId === LOCAL_BOX_ID) && !t.pendingCount ? t : null
    }, "the task's turn to end", 60_000)
    return { lines: turns()[before]!, task: done }
  }
  const events = (taskId: string) =>
    yard.store
      .listTaskMessages(taskId, 200)
      .filter((m) => m.role === "event")
      .map((m) => m.content)
  return { yard, call, project, runTask, events }
}

describe("commit signing", () => {
  it("signs a turn's commits with its identity's key, and the key leaves the box with the turn", async () => {
    const r = await start()
    const key = keyPair()
    const o = origin()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme", author: { name: "Acme Bot", email: "bot@acme.dev" } })
    await r.call("PUT", `/api/identities/${acme.id}/signing`, { kind: "file", privateKey: key.privateKey })
    const p = await r.project("acme-app", acme.id, { url: o.url })

    const { lines, task } = await r.runTask(p, "Add a file [commit]")
    expect(lines).toContain("SIG signed by the turn G")
    expect(lines).toContain("KEY_MODE=600")
    const keyPath = lines.find((l) => l.startsWith("SIGNING_KEY="))!.slice("SIGNING_KEY=".length)
    expect(keyPath.startsWith(path.join(os.tmpdir(), `boxyard-sign-${task.id}`))).toBe(true)
    // Gone with the turn: the key the turn signed with, the one Box Yard sent, and task.json never had it.
    expect(fs.existsSync(path.dirname(keyPath))).toBe(false)
    const dir = r.yard.tasks.taskDir(task.boxId!, task.id)
    expect(fs.existsSync(path.join(dir, "signing.key"))).toBe(false)
    expect(fs.readFileSync(path.join(dir, "task.json"), "utf8")).not.toContain("PRIVATE KEY")
    // The turn-end push took the signed commit to GitHub (here, the bare origin).
    expect(o.signatures(`refs/heads/${task.branch}`, key.pub)).toEqual(["signed by the turn G"])

    // Without a key, the next turn signs nothing.
    await r.call("DELETE", `/api/identities/${acme.id}/signing`)
    const after = await r.runTask(p, "Again [commit]")
    expect(after.lines).toContain("SIG signed by the turn N")
    expect(after.lines.some((l) => l.startsWith("SIGNING_KEY="))).toBe(false)
  })

  it("with requireSigned, a push of unsigned commits is stopped, in the turn and at its end", async () => {
    const r = await start()
    const key = keyPair()
    const o = origin()
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme", author: { name: "Acme Bot", email: "bot@acme.dev" } })
    await r.call("PUT", `/api/identities/${acme.id}/signing`, { kind: "file", privateKey: key.privateKey, requireSigned: true })
    const p = await r.project("acme-app", acme.id, { url: o.url })

    const bad = await r.runTask(p, "Sneak one in [unsigned] [push]")
    expect(bad.lines).toContain("PUSH_EXIT=1")
    expect(bad.lines.join("\n")).toMatch(/the Acme identity requires signed commits, and this push has commits its key \(SHA256:\S+\) didn't sign/)
    // The turn-end push leaves the branch off origin too, says why, and keeps the work on the WIP ref.
    expect(o.ref(`refs/heads/${bad.task.branch}`)).toBeNull()
    expect(o.ref(`refs/boxyard/wip/${bad.task.id}`)).not.toBeNull()
    expect(r.events(bad.task.id).join("\n")).toMatch(/Turn-end push: the Acme identity requires signed commits, and its key \(SHA256:\S+\) didn't sign [0-9a-f]+, so the branch wasn't pushed/)

    // Signed commits go through, and the repo's own pre-push hook still runs.
    const good = await r.runTask(p, "Do it right [ownhook] [commit] [push]")
    expect(good.lines).toContain("PUSH_EXIT=0")
    expect(good.lines).toContain("OWN_HOOK_RAN")
    expect(o.signatures(`refs/heads/${good.task.branch}`, key.pub)).toEqual(["signed by the turn G"])
  })

  it("signs through a key in this computer's agent with its program, only on this computer", async () => {
    const r = await start()
    const key = keyPair()
    // A stand-in for 1Password's op-ssh-sign: signs with the key it holds, whatever git passes as -f, and hands
    // everything else (verifying) to ssh-keygen.
    const program = path.join(tmpDir("op-ssh-sign-"), "op-ssh-sign")
    fs.writeFileSync(program, `#!/bin/sh\ncase "$*" in *"-Y sign"*) for a; do last=$a; done; exec ssh-keygen -Y sign -n git -f ${JSON.stringify(key.file)} "$last" ;; esac\nexec ssh-keygen "$@"\n`, { mode: 0o755 })
    const laptop = await r.call<Identity>("POST", "/api/identities", { name: "Laptop", runners: ["local"], author: { name: "Cody", email: "cody@laptop.example" } })
    const saved = await r.call<Identity>("PUT", `/api/identities/${laptop.id}/signing`, { kind: "agent", publicKey: key.pub, program })
    expect(saved.signing).toMatchObject({ kind: "agent", program, readable: true })
    const p = await r.project("laptop-app", laptop.id, { runner: "local" })
    // The project has no repo: the wrapper makes its scratch folder one, then commits.
    const { lines } = await r.runTask(p, "Commit here [commit]")
    expect(lines.find((l) => l.startsWith("SIGNING_KEY="))).toBe(`SIGNING_KEY=key::${key.pub.split(" ").slice(0, 2).join(" ")}`)
    expect(lines).toContain("SIG signed by the turn G")
    // An agent key can't sign on a box.
    await expect(r.call("PATCH", `/api/projects/${p.id}`, { runner: "box" })).rejects.toThrow(/-> 400: .*only on this computer/)
  })

  it("with requireSigned, a turn that can't sign can't push either, and says why", async () => {
    const r = await start()
    const key = keyPair()
    const o = origin()
    const program = path.join(tmpDir("op-ssh-sign-"), "op-ssh-sign")
    fs.writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const laptop = await r.call<Identity>("POST", "/api/identities", { name: "Laptop", runners: ["local"], author: { name: "Cody", email: "cody@laptop.example" } })
    await r.call("PUT", `/api/identities/${laptop.id}/signing`, { kind: "agent", publicKey: key.pub, program, requireSigned: true })
    const p = await r.project("laptop-app", laptop.id, { url: o.url, runner: "local" })
    // 1Password was uninstalled since.
    fs.rmSync(program)

    const { lines, task } = await r.runTask(p, "Ship it [commit] [push]")
    expect(lines.some((l) => l.startsWith("SIGNING_KEY="))).toBe(false)
    expect(lines).toContain("SIG signed by the turn N")
    expect(lines).toContain("PUSH_EXIT=1")
    expect(o.ref(`refs/heads/${task.branch}`)).toBeNull()
    expect(r.events(task.id).join("\n")).toContain(`This turn's commits aren't signed: the signing program ${program} isn't on this computer; the Laptop identity requires signed commits, so this turn's pushes are stopped.`)
  })
})

describe("the local-runner walls", () => {
  it("an identity other than Default gets its own git config and gh folder on this computer; Default keeps the owner's", async () => {
    const r = await start()
    const solo = await r.call<Identity>("POST", "/api/identities", { name: "Solo" })
    const onSolo = await r.project("solo-app", solo.id, { runner: "local" })
    const mine = await r.project("mine", DEFAULT_IDENTITY_ID, { runner: "local" })

    const home = path.join(r.yard.tasks.taskDir(LOCAL_BOX_ID, "x"), "..", ".boxyard", "identities", solo.id)
    const walled = (await r.runTask(onSolo, "Say hi")).lines
    expect(walled).toEqual(expect.arrayContaining([`GIT_CONFIG_GLOBAL=${path.join(home, "gitconfig")}`, "GIT_CONFIG_NOSYSTEM=1", `GH_CONFIG_DIR=${path.join(home, "gh")}`, "GLOBAL_EMAIL=none"]))
    expect(fs.statSync(path.join(home, "gh")).isDirectory()).toBe(true)

    const owners = (await r.runTask(mine, "Say hi")).lines
    expect(owners).toContain(`GIT_CONFIG_GLOBAL=${ownerConfig}`)
    expect(owners).toContain("GLOBAL_EMAIL=owner@laptop.example")
    expect(owners.some((l) => l.startsWith("GH_CONFIG_DIR="))).toBe(false)
  })
})
