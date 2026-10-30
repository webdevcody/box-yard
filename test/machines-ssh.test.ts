// SSH machines (server/machines): the ssh command line and the scripts it carries, Test connection's probe, how a key
// reference becomes ssh's options, the registry's checks, and what runs_on / machine_label resolve to. The scripts run
// here in bash the way the machine's side runs them (`bash -c 'eval "$(cat)"'` with the script on stdin).
import { afterAll, describe, expect, it } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { MachineKeys } from "../server/machines/keys.js"
import { failedTest, loginDirs, parseProbe, probeScript, testFromProbe, toolsScript } from "../server/machines/probe.js"
import { checkDir, MachineRegistry } from "../server/machines/registry.js"
import { REMOTE_SCRIPT, pathPreamble, scriptFor, sshArgs, sshEnv, sshError, uploadCommand, writeFileScript } from "../server/machines/ssh.js"
import { resolveRunsOn } from "../shared/machines.js"
import { tmpDir } from "./helpers.js"

const made: string[] = []
const dir = (prefix: string) => {
  const d = tmpDir(prefix)
  made.push(d)
  return d
}
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
})

/** Run a script the way the machine does: its login shell runs REMOTE_SCRIPT, which reads the script from stdin. */
function remote(script: string, opts: { home?: string; cwd?: string } = {}) {
  const res = spawnSync("sh", ["-c", REMOTE_SCRIPT], {
    input: script,
    cwd: opts.cwd,
    env: { PATH: process.env.PATH, HOME: opts.home ?? process.env.HOME },
    encoding: "utf8",
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

describe("runs_on and machine_label", () => {
  it("resolves the label forms to the ssh runner and a normalized label", () => {
    expect(resolveRunsOn(undefined, undefined, null)).toEqual({ runner: null, machineLabel: null, viaLocal: false })
    expect(resolveRunsOn("label:GPU", undefined, null)).toEqual({ runner: "ssh", machineLabel: "gpu", viaLocal: false })
    expect(resolveRunsOn("ssh:Old Laptops", null, null)).toEqual({ runner: "ssh", machineLabel: "old-laptops", viaLocal: false })
    expect(resolveRunsOn("ssh", "Laptops", null)).toEqual({ runner: "ssh", machineLabel: "laptops", viaLocal: false })
    expect(resolveRunsOn("ssh", null, null)).toEqual({ runner: "ssh", machineLabel: null, viaLocal: false })
    // A label alone means an SSH machine with it.
    expect(resolveRunsOn(undefined, "gpu", null)).toEqual({ runner: "ssh", machineLabel: "gpu", viaLocal: false })
    // Both forms agreeing is fine.
    expect(resolveRunsOn("label:gpu", "GPU", null)).toEqual({ runner: "ssh", machineLabel: "gpu", viaLocal: false })
  })

  it('"local" is this computer unless Cody picked a label for it; this_computer always is', () => {
    expect(resolveRunsOn("local", undefined, null)).toEqual({ runner: "local", machineLabel: null, viaLocal: false })
    expect(resolveRunsOn("local", undefined, "laptops")).toEqual({ runner: "ssh", machineLabel: "laptops", viaLocal: true })
    expect(resolveRunsOn("this_computer", undefined, "laptops")).toEqual({ runner: "local", machineLabel: null, viaLocal: false })
    expect(resolveRunsOn("box", undefined, "laptops")).toEqual({ runner: "box", machineLabel: null, viaLocal: false })
    expect(resolveRunsOn("docker", null, null)).toEqual({ runner: "docker", machineLabel: null, viaLocal: false })
  })

  it("refuses a label with another runner, two different labels, and labels with nothing in them", () => {
    expect(() => resolveRunsOn("docker", "gpu", null)).toThrow(/machine_label goes with SSH machines/)
    expect(() => resolveRunsOn("local", "gpu", "laptops")).toThrow(/machine_label goes with SSH machines/)
    expect(() => resolveRunsOn("label:gpu", "laptops", null)).toThrow()
    expect(() => resolveRunsOn("label:!!", null, null)).toThrow()
    expect(() => resolveRunsOn(undefined, "!!", null)).toThrow(/no letters or digits/)
    expect(() => resolveRunsOn("mainframe", null, null)).toThrow(/isn't a runner/)
  })
})

describe("the ssh command line", () => {
  const e = { host: "old-thinkpad.lan", user: "cody", port: 2222 }
  const auth = { identityFile: "/home/me/.ssh/id_ed25519", identitiesOnly: true }

  it("never asks for a password, trusts a host key once in Box Yard's own file, and forwards nothing", () => {
    const args = sshArgs(e, { auth, knownHosts: "/data/machines/known_hosts-mch_1", controlPath: "/tmp/byssh-abc-%C" })
    const opts = args.flatMap((a, i) => (args[i - 1] === "-o" ? [a] : []))
    expect(opts).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=accept-new",
        "UserKnownHostsFile=/data/machines/known_hosts-mch_1",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "RequestTTY=no",
        "IdentitiesOnly=yes",
        "ControlMaster=auto",
        "ControlPath=/tmp/byssh-abc-%C",
      ]),
    )
    expect(args.slice(0, 4)).toEqual(["-p", "2222", "-l", "cody"])
    expect(args[args.indexOf("-i") + 1]).toBe("/home/me/.ssh/id_ed25519")
    // The destination is last: the remote command (REMOTE_SCRIPT) follows it, and the script itself goes on stdin.
    expect(args.at(-1)).toBe("old-thinkpad.lan")
  })

  it("leaves the key to ssh's defaults for `default`, and can skip the shared connection", () => {
    const args = sshArgs(e, { auth: { identityFile: null, identitiesOnly: false }, knownHosts: "/k", controlPath: null })
    expect(args).not.toContain("-i")
    expect(args).not.toContain("IdentitiesOnly=yes")
    expect(args).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]))
  })

  it("refuses a host or user that ssh would read as an option", () => {
    const o = { auth, knownHosts: "/k", controlPath: null }
    expect(() => sshArgs({ ...e, host: "-oProxyCommand=touch /tmp/x" }, o)).toThrow(/isn't a host/)
    expect(() => sshArgs({ ...e, host: "a b" }, o)).toThrow(/isn't a host/)
    expect(() => sshArgs({ ...e, user: "-x" }, o)).toThrow(/isn't a user/)
    expect(() => sshArgs({ ...e, user: "a;b" }, o)).toThrow(/isn't a user/)
    expect(() => sshArgs({ ...e, host: "192.168.1.20" }, o)).not.toThrow()
    expect(() => sshArgs({ ...e, host: "fe80::1" }, o)).not.toThrow()
  })

  it("runs ssh with a bare environment: none of Box Yard's secrets can ride along", () => {
    const env = sshEnv({ HOME: "/home/me", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/agent", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oat", BOXYARD_SECRET: "s" })
    expect(env).toEqual({ HOME: "/home/me", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/agent" })
  })

  it("shortens ssh's errors to the reason", () => {
    expect(sshError("Warning: Permanently added 'x' (ED25519) to the list of known hosts.\ncody@x: Permission denied (publickey).\n")).toBe("cody@x: Permission denied (publickey).")
    expect(sshError("ssh: connect to host 10.0.0.9 port 22: Connection refused\n")).toBe("connect to host 10.0.0.9 port 22: Connection refused")
    expect(sshError("ssh: Could not resolve hostname nope: Name or service not known\n")).toBe("Could not resolve hostname nope: Name or service not known")
    expect(sshError("@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@\nHost key verification failed.\n")).toMatch(/host key changed .*Forget host key/)
    expect(sshError("")).toBe("ssh failed")
  })
})

describe("the scripts ssh carries", () => {
  it("puts the user's tool folders and the login shell's on PATH, quoted", () => {
    const home = dir("by-ssh-home-")
    const res = remote(`${pathPreamble(["/opt/my tools/bin", "/x'y"])}\necho "$PATH"`, { home })
    expect(res.code).toBe(0)
    const parts = res.stdout.trim().split(":")
    expect(parts.slice(0, 3)).toEqual(["/opt/my tools/bin", "/x'y", `${home}/.local/bin`])
    expect(parts).toContain("/usr/local/bin")
  })

  it("writes a file's bytes from inside the script, never from an argument, readable by the user only", () => {
    const home = dir("by-ssh-write-")
    const file = path.join(home, "tasks", "t 1", "task.json")
    // Content that would break a naive heredoc or shell quoting: the end marker, $(…), quotes and binary bytes.
    const content = Buffer.concat([Buffer.from(`{"token":"ghp_secret$(touch ${home}/pwned)'\\"\nBOXYARD_B64_END\n`), Buffer.from([0, 255, 10, 13])])
    const script = writeFileScript(file, content)
    expect(script).not.toContain("ghp_secret")
    const res = remote(scriptFor(script), { home })
    expect(res.code, res.stderr).toBe(0)
    expect(fs.readFileSync(file)).toEqual(content)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false)
    // No temp file left beside it.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["task.json"])
    // Writing it again replaces it.
    expect(remote(scriptFor(writeFileScript(file, "{}")), { home }).code).toBe(0)
    expect(fs.readFileSync(file, "utf8")).toBe("{}")
  })

  it("uploads raw bytes from stdin to a path with spaces and quotes in it", () => {
    const home = dir("by-ssh-upload-")
    const dest = path.join(home, "it's here", "archive.tgz")
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256))
    // ssh hands the remote command to the user's login shell (sh -c).
    const res = spawnSync("sh", ["-c", uploadCommand(dest)], { input: bytes, env: { PATH: process.env.PATH, HOME: home } })
    expect(res.status, String(res.stderr)).toBe(0)
    expect(fs.readFileSync(dest)).toEqual(bytes)
    expect(fs.existsSync(dest + ".part")).toBe(false)
  })
})

describe("Test connection's probe", () => {
  it("reads only the lines after its marker, keeping repeated keys", () => {
    const m = parseProbe("motd=hello from .bashrc\nBOXYARD_PROBE\nuname=Linux 6.8 x86_64\nlogin=/a/node\nlogin=/b/claude\nBad-Key=x\n=nothing\nnot a fact\n")
    expect([...m.keys()]).toEqual(["uname", "login"])
    expect(m.get("login")).toEqual(["/a/node", "/b/claude"])
    expect(parseProbe("no marker=here")).toEqual(new Map())
  })

  it("keeps the login shell's folders for the tools it looks for", () => {
    const first = parseProbe("BOXYARD_PROBE\nlogin=/home/c/.nvm/versions/node/v20/bin/node\nlogin=/home/c/.nvm/versions/node/v20/bin/claude\nlogin=/usr/bin/git\nlogin=/home/c/bin/rm\n")
    expect(loginDirs(first)).toEqual(["/home/c/.nvm/versions/node/v20/bin", "/usr/bin"])
  })

  const first = parseProbe(
    "BOXYARD_PROBE\nuname=Linux 6.8.0 x86_64\nhostname=thinkpad\nhome=/home/c\nosname=Ubuntu 24.04 LTS\ncpus=4\nmem=8000000000\nworkdir=/home/c/boxyard\ndisk=100000000000 250000000000\n",
  )
  const tools = (over: string) =>
    parseProbe(
      `BOXYARD_PROBE\npath_git=/usr/bin/git\nversion_git=git version 2.43.0\npath_node=/usr/bin/node\nversion_node=v20.11.1\npath_claude=/home/c/.local/bin/claude\nversion_claude=2.0.14 (Claude Code)\nclaude_auth="loggedIn": true\nshm=/dev/shm/boxyard-1000\n${over}`,
    )

  it("turns a ready machine's facts into a passed test", () => {
    const t = testFromProbe({ first, tools: tools(""), pathDirs: [], latencyMs: 40, at: 1 })
    expect(t).toMatchObject({ ok: true, os: "Linux 6.8.0 x86_64", osName: "Ubuntu 24.04 LTS", cpus: 4, memoryBytes: 8e9, diskFreeBytes: 1e11, diskTotalBytes: 2.5e11, workDir: "/home/c/boxyard", claudeLogin: true, secretsDir: "/dev/shm/boxyard-1000", problems: [], notes: [] })
    expect(t.tools.claude).toEqual({ found: true, path: "/home/c/.local/bin/claude", version: "2.0.14 (Claude Code)" })
    expect(t.tools.codex.found).toBe(false)
  })

  it("says what's missing or old, and notes a claude or codex that isn't logged in", () => {
    const t = testFromProbe({
      first: parseProbe("BOXYARD_PROBE\nworkdir_error=can't make ~/boxyard\nmissing=base64\ndisk=1000 2000\n"),
      tools: parseProbe('BOXYARD_PROBE\npath_node=/usr/bin/node\nversion_node=v16.20.0\npath_claude=/usr/bin/claude\nclaude_auth="loggedIn":false\npath_codex=/usr/bin/codex\nversion_codex=codex-cli 0.40.0\ncodex_auth=1\n'),
      pathDirs: [],
      latencyMs: 1,
      at: 1,
    })
    expect(t.problems.join("\n")).toMatch(/work folder/)
    expect(t.problems.join("\n")).toMatch(/node v16.20.0 is too old/)
    expect(t.problems.join("\n")).toMatch(/git isn't installed/)
    expect(t.problems.join("\n")).toMatch(/base64 isn't installed/)
    expect(t.claudeLogin).toBe(false)
    expect(t.notes.join("\n")).toMatch(/claude isn't logged in/)
    expect(t.codexLogin).toBe(false)
    expect(t.notes.join("\n")).toMatch(/codex isn't logged in on it/)
    expect(t.notes.join("\n")).toMatch(/under 2 GB free/)
    expect(t.tools.codex).toMatchObject({ found: true })
    expect(testFromProbe({ first, tools: tools("").set("path_claude", []), pathDirs: [], latencyMs: 1, at: 1 }).problems.join()).toMatch(/neither claude \(Claude Code\) nor codex is installed/)
  })

  it("takes a machine with only codex, for Codex tasks; reads codex's login from its exit code", () => {
    const only = (auth: string) => tools(`path_codex=/usr/bin/codex\nversion_codex=codex-cli 0.40.0\n${auth}`).set("path_claude", []).set("claude_auth", [])
    const t = testFromProbe({ first, tools: only("codex_auth=0\n"), pathDirs: [], latencyMs: 1, at: 1 })
    expect(t).toMatchObject({ problems: [], codexLogin: true, claudeLogin: null })
    expect(t.notes.join("\n")).toMatch(/claude \(Claude Code\) isn't installed, so only Codex tasks run on it/)
    // A timeout (124) or no answer says nothing about the login.
    expect(testFromProbe({ first, tools: only("codex_auth=124\n"), pathDirs: [], latencyMs: 1, at: 1 }).codexLogin).toBeNull()
    expect(testFromProbe({ first, tools: only(""), pathDirs: [], latencyMs: 1, at: 1 }).codexLogin).toBeNull()
    expect(testFromProbe({ first, tools: tools(""), pathDirs: [], latencyMs: 1, at: 1 }).codexLogin).toBeNull()
  })

  it("keeps a failed test's reason and nothing else", () => {
    expect(failedTest("Can't connect: Connection refused", 5)).toMatchObject({ ok: false, error: "Can't connect: Connection refused", at: 5, workDir: null, problems: [] })
  })

  it("runs in bash: makes the work folder and finds this computer's facts and tools", () => {
    const home = dir("by-ssh-probe-")
    const res = remote(scriptFor(probeScript("~/boxyard")), { home })
    expect(res.code, res.stderr).toBe(0)
    const facts = parseProbe(res.stdout)
    expect(facts.get("workdir")).toEqual([fs.realpathSync(path.join(home, "boxyard"))])
    expect(fs.existsSync(path.join(home, "boxyard", "tasks"))).toBe(true)
    expect(fs.statSync(path.join(home, "boxyard", ".boxyard")).mode & 0o777).toBe(0o700)
    expect(Number(facts.get("cpus")?.[0])).toBeGreaterThan(0)
    expect(facts.get("home")).toEqual([home])
    const second = parseProbe(remote(scriptFor(toolsScript()), { home }).stdout)
    expect(second.get("path_node")?.[0]).toMatch(/\/node$/)
    expect(second.get("version_node")?.[0]).toMatch(/^v\d+\./)
  })

  it("reads codex's login from `codex login status`'s exit code alone, never its words", () => {
    const home = dir("by-ssh-probe-")
    const bin = dir("by-ssh-codex-")
    const fake = (exit: number) =>
      fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nif [ "$1" = login ]; then echo "Logged in using an API key - sk-proj-secret"; exit ${exit}; fi\necho "codex-cli 0.40.0"\n`, { mode: 0o755 })
    fake(1)
    const out = remote(scriptFor(toolsScript(), [bin]), { home }).stdout
    expect(out).not.toMatch(/sk-proj/)
    expect(parseProbe(out).get("codex_auth")).toEqual(["1"])
    expect(parseProbe(out).get("version_codex")).toEqual(["codex-cli 0.40.0"])
    fake(0)
    expect(parseProbe(remote(scriptFor(toolsScript(), [bin]), { home }).stdout).get("codex_auth")).toEqual(["0"])
  })
})

describe("SSH key references", () => {
  const home = dir("by-ssh-keys-")
  const ssh = path.join(home, ".ssh")
  fs.mkdirSync(ssh, { mode: 0o700 })
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(ssh, "id_laptops")])
  const pub = fs.readFileSync(path.join(ssh, "id_laptops.pub"), "utf8").trim()
  const fingerprint = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", path.join(ssh, "id_laptops.pub")], { encoding: "utf8" }).split(" ")[1]!
  const outside = dir("by-ssh-outside-")
  fs.copyFileSync(path.join(ssh, "id_laptops"), path.join(outside, "stray_key"))
  fs.symlinkSync(path.join(outside, "stray_key"), path.join(ssh, "linked_key"))
  const keysDir = path.join(dir("by-ssh-data-"), "machines")
  const keys = (agent: { socket?: string; keys?: string[] } = {}) =>
    new MachineKeys({ home, dir: keysDir, agentSocket: () => agent.socket, agentKeys: async () => agent.keys ?? [] })

  it("lets ssh read a private key in ~/.ssh itself", async () => {
    expect(await keys().resolve("file:~/.ssh/id_laptops", "mch_1")).toEqual({ identityFile: fs.realpathSync(path.join(ssh, "id_laptops")), identitiesOnly: true })
    expect(await keys().check("file:~/.ssh/id_laptops")).toBe("file:~/.ssh/id_laptops")
    expect(await keys().resolve("default", "mch_1")).toEqual({ identityFile: null, identitiesOnly: false })
  })

  it("refuses public halves, files outside ~/.ssh (links too) and missing files, naming the file but never its content", async () => {
    const errors = await Promise.all(
      ["file:~/.ssh/id_laptops.pub", `file:${outside}/stray_key`, "file:~/.ssh/linked_key", "file:~/.ssh/nope", "file:~/.ssh/../.bashrc", "password:hunter2", "~/.ssh/id_laptops"].map((ref) =>
        keys()
          .check(ref)
          .then(() => "")
          .catch((err: Error) => err.message),
      ),
    )
    expect(errors[0]).toMatch(/id_laptops.pub isn't an SSH private key: name the private key/)
    expect(errors[1]).toMatch(/only from ~\/.ssh/)
    expect(errors[2]).toMatch(/only from ~\/.ssh/)
    expect(errors[3]).toMatch(/no key file at ~\/.ssh\/nope/)
    expect(errors[4]).toBeTruthy()
    expect(errors[5]).toMatch(/isn't an SSH key reference/)
    expect(errors[6]).toMatch(/isn't an SSH key reference/)
    for (const e of errors) expect(e).not.toMatch(/BEGIN|PRIVATE KEY|AAAA/)
  })

  it("uses the SSH agent only when there is one, and an agent key by its public half", async () => {
    await expect(keys().check("agent")).rejects.toThrow(/SSH_AUTH_SOCK/)
    expect(await keys({ socket: "/run/agent.sock" }).resolve("agent", "mch_1")).toEqual({ identityFile: null, identitiesOnly: false })
    const agent = keys({ socket: "/run/agent.sock", keys: [pub] })
    await expect(keys({ socket: "/run/agent.sock", keys: [] }).check(`agent:${fingerprint}`)).rejects.toThrow(/no key with fingerprint/)
    expect(await agent.check(`agent:${fingerprint}`)).toBe(`agent:${fingerprint}`)
    // Only checked: nothing written.
    expect(fs.existsSync(keysDir)).toBe(false)
    const auth = await agent.resolve(`agent:${fingerprint}`, "mch_1")
    expect(auth).toEqual({ identityFile: path.join(keysDir, "mch_1.pub"), identitiesOnly: true })
    expect(fs.readFileSync(auth.identityFile!, "utf8").trim()).toBe(pub)
    expect(fs.statSync(auth.identityFile!).mode & 0o777).toBe(0o600)
    agent.forget("mch_1")
    expect(fs.existsSync(auth.identityFile!)).toBe(false)
  })
})

describe("the machine registry", () => {
  const kv = new Map<string, string>()
  const registry = () => new MachineRegistry({ db: openDb(dir("by-ssh-db-"), ":memory:"), store: { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => void kv.set(k, v) } })
  const input = { name: "old-thinkpad", host: "192.168.1.20", user: "cody", keyRef: "default" as const }

  it("adds a machine with defaults and normalized labels, and finds it by id or name", () => {
    const r = registry()
    const m = r.add({ ...input, labels: ["Laptops", "local", "laptops"] })
    expect(m).toMatchObject({ name: "old-thinkpad", port: 22, maxTasks: 1, labels: ["laptops", "local"], dir: "~/boxyard", enabled: true, lastTest: null })
    expect(m.id).toMatch(/^mch_/)
    expect(r.find("OLD-THINKPAD")?.id).toBe(m.id)
    expect(r.find(m.id)?.id).toBe(m.id)
    expect(() => r.require("nope")).toThrow(/No SSH machine "nope"/)
    expect(() => r.add({ ...input, name: "Old-ThinkPad" })).toThrow(/already a machine named/)
  })

  it("checks every field", () => {
    const r = registry()
    expect(() => r.add({ ...input, name: "my laptop" })).toThrow(/name/)
    expect(() => r.add({ ...input, host: "-oProxyCommand=x" })).toThrow(/host name/)
    expect(() => r.add({ ...input, user: "root;id" })).toThrow(/user name/)
    expect(() => r.add({ ...input, port: 0 })).toThrow(/port/)
    expect(() => r.add({ ...input, maxTasks: 33 })).toThrow(/Tasks running at once/)
    expect(() => r.add({ ...input, keyRef: "hunter2" as never })).toThrow(/key reference/)
    expect(() => r.add({ ...input, dir: "~" })).toThrow(/work folder/)
    expect(r.list()).toEqual([])
  })

  it("keeps work folders below the home or root, without ..", () => {
    expect(checkDir("")).toBe("~/boxyard")
    expect(checkDir("~/boxyard/")).toBe("~/boxyard")
    expect(checkDir("/srv/boxyard")).toBe("/srv/boxyard")
    for (const bad of ["~", "/", "/srv", "~/../etc", "~/.", "/srv/.", "boxyard", "~/a;rm -rf", "~/$(id)"]) expect(() => checkDir(bad), bad).toThrow()
  })

  it("clears the last test when the address, key or folder changes, and keeps it for labels", () => {
    const r = registry()
    const m = r.add(input)
    r.setTest(m.id, failedTest("x", 1))
    expect(r.update(m.id, { labels: ["gpu"], maxTasks: 2 })).toMatchObject({ reconnect: false, machine: { labels: ["gpu"], maxTasks: 2, lastTest: { error: "x" } } })
    expect(r.update(m.id, { host: "10.0.0.5" })).toMatchObject({ reconnect: true, machine: { host: "10.0.0.5", lastTest: null } })
  })

  it("keeps what \"local\" means, normalized", () => {
    const r = registry()
    expect(r.settings()).toEqual({ localLabel: null })
    expect(r.saveSettings({ localLabel: "My Laptops" })).toEqual({ localLabel: "my-laptops" })
    expect(r.settings()).toEqual({ localLabel: "my-laptops" })
    expect(r.saveSettings({ localLabel: null })).toEqual({ localLabel: null })
  })
})
