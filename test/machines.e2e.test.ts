import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { machineBoxId, type MachineStatus, type MachinesStatus } from "../shared/machines.js"
import { placementView } from "../shared/placement.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Cody's SSH machines end to end. In mock mode a machine is a folder (FolderTransport): a project set to "Runs on:
// SSH machine" with a label runs its tasks on a free machine with that label and never on a pool box, they queue
// while every matching machine is busy, the MCP tools add and label machines and place tasks with runs_on
// "label:<label>", and "local" goes to a label only when Cody points it there. A second part runs the real
// SshTransport against a stand-in `ssh` (no sshd here): what ssh is given, and that no credential is in its argv or
// stays on the machine after a turn.

/** Pool boxes that count how many were made: a task on an SSH machine must never make one. */
class Boxes extends LocalProvider {
  created = 0
  override async create() {
    this.created++
    return super.create()
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  boxes: Boxes
  dataDir: string
}
const running: Running[] = []
const clients: { close: () => Promise<void> }[] = []
const cleanup: (() => void)[] = []

async function start(opts: { config?: Partial<Config>; machines?: Parameters<typeof createBoxYard>[1]["machines"] } = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...opts.config })
  const boxDir = tmpDir("boxes-")
  const boxes = new Boxes(boxDir, FAKE_CLAUDE)
  cleanup.push(() => fs.rmSync(boxDir, { recursive: true, force: true }))
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: boxes, machines: opts.machines })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, boxes, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
    fs.rmSync(r.dataDir, { recursive: true, force: true })
  }
  for (const fn of cleanup.splice(0)) fn()
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = {
    store: y.store,
    tasks: y.tasks,
    hub: y.hub,
    artifacts: null as never,
    publicUrl: () => "",
    scheduler: y.scheduler,
    captains: y.captains,
    settings: y.settings,
    notes: y.notes,
    uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024),
    machines: y.machineActions,
  }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  const tools = async () => (await client.listTools()).tools.map((t) => t.name)
  const use = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes
    if (res.isError) throw new Error(res.content[0]!.text)
    return JSON.parse(res.content[0]!.text)
  }
  return Object.assign(use, { tools })
}

const addMachine = (r: Running, body: Record<string, unknown>) => call<{ machine: MachineStatus; status: MachinesStatus }>(r, "POST", "/api/machines", { keyRef: "default", ...body })
const machinesStatus = (r: Running) => call<MachinesStatus>(r, "GET", "/api/machines")
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(() => (ok(getTask(r, id)) ? getTask(r, id) : null), `task ${id} ${what}`, 60_000).catch((err: Error) => {
    const t = getTask(r, id)
    const dir = t.boxId ? r.yard.tasks.taskDir(t.boxId, id) : null
    const log = dir && fs.existsSync(path.join(dir, "runner.log")) ? fs.readFileSync(path.join(dir, "runner.log"), "utf8").split("\n").slice(-12) : null
    const events = r.yard.store.listTaskMessages(id, 500).filter((m) => m.role === "event").map((m) => m.content).slice(-10)
    throw new Error(`${err.message}: ${JSON.stringify({ status: t.status, turns: t.turnCount, boxId: t.boxId, error: t.error, waitReason: t.waitReason, events, log }, null, 1)}`)
  })
const done = (r: Running, id: string, turns = 1) => until(r, id, (t) => t.status === "done" && t.turnCount >= turns && !t.pendingCount && !t.currentTurnId, `to finish turn ${turns}`)
const history = (r: Running, boxId: string) => r.yard.tasks.history.list({ boxId }).map((e) => `${e.type} by ${e.actor}`).reverse()

describe("SSH machines (mock mode: machines are folders)", () => {
  it("runs a labelled project's tasks on a free machine with that label, and queues them while it's busy", { timeout: 200_000 }, async () => {
    const r = await start()
    // Tested on add: in mock mode the "machine" has this computer's git and node, and the made-up claude.
    const { machine: laptop } = await addMachine(r, { name: "old-thinkpad", host: "thinkpad.lan", user: "cody", labels: ["Laptops"], maxTasks: 1 })
    expect(laptop).toMatchObject({ state: "ready", labels: ["laptops"], running: 0, boxId: machineBoxId(laptop.id) })
    expect(laptop.lastTest).toMatchObject({ ok: true, claudeLogin: true, problems: [] })
    expect(laptop.lastTest!.tools.node.found).toBe(true)
    const home = path.join(r.dataDir, "ssh-machines", laptop.id, "home")
    expect(laptop.lastTest!.workDir).toBe(fs.realpathSync(path.join(home, "boxyard")))
    const { machine: tower } = await addMachine(r, { name: "gpu-tower", host: "10.0.0.7", user: "cody", labels: ["gpu"] })

    const p = await call<Project>(r, "POST", "/api/projects", { name: "on-laptops", runner: "ssh", machineLabel: "Laptops" })
    expect(p).toMatchObject({ runner: "ssh", machineLabel: "laptops" })
    const box = machineBoxId(laptop.id)
    const first = r.yard.tasks.createTask({ projectId: p.id, title: "first", prompt: "[slow:4] write a haiku" })
    await until(r, first.id, (t) => t.boxId === box && t.status === "working", "to start on the laptop")
    // The laptop runs one task at a time; the tower doesn't have the label, so the second one waits for the laptop.
    const second = r.yard.tasks.createTask({ projectId: p.id, title: "second", prompt: "write another" })
    const waiting = await until(r, second.id, (t) => Boolean(t.waitReason), "to wait")
    expect(waiting.waitReason).toMatch(/free slot on SSH machines labelled "laptops" \(old-thinkpad: 1 of 1 running\)/)
    expect(waiting.boxId).toBeNull()
    expect((await machinesStatus(r)).machines.find((m) => m.id === laptop.id)).toMatchObject({ state: "busy", running: 1 })

    await done(r, first.id)
    await done(r, second.id)
    for (const id of [first.id, second.id]) {
      const t = getTask(r, id)
      expect(t.boxId).toBe(box)
      expect(t.placement).toMatchObject({ now: { kind: "ssh", boxId: box }, runner: "ssh", chosenBy: "project" })
      expect(placementView(t).label).toBe("SSH · old-thinkpad")
      // Its workspace is in the machine's work folder, and no credential is left there after the turn.
      const dir = r.yard.tasks.taskDir(box, id)
      expect(dir.startsWith(fs.realpathSync(path.join(home, "boxyard", "tasks")))).toBe(true)
      expect(fs.existsSync(path.join(dir, "work", "box-yard-demo.md"))).toBe(true)
      expect(fs.existsSync(path.join(dir, "task.json"))).toBe(false)
    }
    expect(r.boxes.created).toBe(0)
    expect(r.yard.store.listBoxes()).toEqual([])
    expect(fs.readdirSync(path.join(r.dataDir, "ssh-machines", tower.id, "home", "boxyard", "tasks"))).toEqual([])
    const st = await machinesStatus(r)
    expect(st.machines.find((m) => m.id === laptop.id)).toMatchObject({ state: "ready", running: 0, tasks: 2 })
    expect(st.machines.find((m) => m.id === tower.id)).toMatchObject({ state: "ready", running: 0, tasks: 0 })
    expect(st.labels).toEqual([
      { label: "gpu", machines: ["gpu-tower"] },
      { label: "laptops", machines: ["old-thinkpad"] },
    ])

    // A label no machine has fails at once; a work folder can't move from under its task folders.
    await expect(call(r, "POST", "/api/tasks", { projectId: p.id, title: "x", prompt: "y", runsOn: "ssh", machineLabel: "mainframe" })).rejects.toThrow(/no SSH machine has that label/)
    await expect(call(r, "PATCH", `/api/machines/${laptop.id}`, { dir: "~/elsewhere" })).rejects.toThrow(/409.*keeps 2 task folders/)

    // Removing the laptop archives each workspace first; its tasks pick up elsewhere next time.
    const removed = await call<{ moved: string[]; lost: string[] }>(r, "DELETE", `/api/machines/${laptop.id}`)
    expect(removed.moved.sort()).toEqual([first.id, second.id].sort())
    expect(removed.lost).toEqual([])
    expect(getTask(r, first.id).boxId).toBeNull()
    expect(history(r, box)).toEqual(["created by owner", "deleted by owner"])
  })

  it("gives a busy machine's next free slot to a high-priority task first", { timeout: 200_000 }, async () => {
    const r = await start()
    const { machine } = await addMachine(r, { name: "old-thinkpad", host: "thinkpad.lan", user: "cody", labels: ["laptops"], maxTasks: 1 })
    const box = machineBoxId(machine.id)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "queue", runner: "ssh", machineLabel: "laptops" })
    const busy = r.yard.tasks.createTask({ projectId: p.id, title: "busy", prompt: "[slow:3] write a haiku" })
    await until(r, busy.id, (t) => t.boxId === box && t.status === "working", "to start")
    const normal = r.yard.tasks.createTask({ projectId: p.id, title: "normal", prompt: "write a haiku" })
    await until(r, normal.id, (t) => Boolean(t.waitReason), "to wait")
    const urgent = r.yard.tasks.createTask({ projectId: p.id, title: "urgent", prompt: "[slow:3] write a haiku", priority: "high" })
    await until(r, urgent.id, (t) => t.status === "working", "to take the free slot")
    expect(getTask(r, normal.id)).toMatchObject({ status: "queued", boxId: null })
    await done(r, urgent.id)
    await done(r, normal.id)
    expect(getTask(r, normal.id).boxId).toBe(box)
  })

  it("lets the Coordinator add and label machines and place tasks by label; \"local\" stays this computer until Cody points it at a label", { timeout: 200_000 }, async () => {
    const r = await start()
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator("list_machines")).none).toMatch(/has no SSH machine yet/)
    const added = await coordinator("add_machine", { name: "gpu-tower", host: "tower.lan", user: "cody", ssh_key: "default", labels: ["GPU"] })
    expect(added).toMatchObject({ name: "gpu-tower", address: "cody@tower.lan", labels: ["gpu"], state: "ready", running: "0/1", last_test: { ok: true } })
    expect(added.last_test.claude).toMatch(/logged in/)
    expect(added.last_test.codex).toBeDefined()
    await expect(coordinator("add_machine", { name: "x", host: "x.lan", user: "cody", ssh_key: "-----BEGIN OPENSSH PRIVATE KEY-----" })).rejects.toThrow(/isn't an SSH key reference/)
    expect(await coordinator("update_machine", { machine: "GPU-TOWER", add_labels: ["linux"], max_tasks: 2 })).toMatchObject({ labels: ["gpu", "linux"], running: "0/2" })

    const p = await call<Project>(r, "POST", "/api/projects", { name: "anywhere", runner: "box" })
    const created = await coordinator("create_task", { project: p.id, title: "render", prompt: "write a haiku", runs_on: "label:gpu" })
    const box = machineBoxId(added.id)
    await done(r, created.id)
    expect(getTask(r, created.id)).toMatchObject({ boxId: box, runsOn: "ssh", machineLabel: "gpu" })
    expect(getTask(r, created.id).placement).toMatchObject({ runner: "ssh", chosenBy: "task" })
    expect(r.boxes.created).toBe(0)
    await expect(coordinator("create_task", { project: p.id, title: "x", prompt: "y", runs_on: "label:mainframe" })).rejects.toThrow(/no SSH machine has that label/)
    await expect(coordinator("create_task", { project: p.id, title: "x", prompt: "y", runs_on: "docker", machine_label: "gpu" })).rejects.toThrow(/machine_label goes with SSH machines/)

    // "local" is this computer until Cody says otherwise in Settings › Machines.
    expect((await coordinator("list_machines")).local_means).toMatch(/runs_on "local" is this computer/)
    await call(r, "PUT", "/api/machines/settings", { localLabel: "Linux" })
    expect((await coordinator("list_machines")).local_means).toMatch(/runs_on "local" goes to SSH machines labelled "linux"/)
    const local = await coordinator("create_task", { project: p.id, title: "local one", prompt: "write a haiku", runs_on: "local" })
    expect(local.runs_on).toMatch(/SSH machines labelled "linux": that's what "local" means in Cody's Settings › Machines/)
    await done(r, local.id)
    expect(getTask(r, local.id)).toMatchObject({ boxId: box, runsOn: "ssh", machineLabel: "linux" })

    // A project's Captain sees the machines (to place tasks by label) but can't change them.
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const names = await captain.tools()
    expect(names).toContain("list_machines")
    for (const t of ["add_machine", "update_machine", "test_machine", "remove_machine"]) expect(names).not.toContain(t)
    expect((await captain("list_machines")).machines.map((m: { name: string }) => m.name)).toEqual(["gpu-tower"])

    expect(await coordinator("remove_machine", { machine: "gpu-tower" })).toMatchObject({ removed: "gpu-tower", tasks_moved: 2 })
    expect(history(r, box)).toEqual(["created by coordinator", "deleted by coordinator"])
  })
})

/**
 * A stand-in for ssh: it logs its argv and stdin, then runs the remote command in a local `sh -c` the way sshd does, with HOME
 * at the "machine's" home and the machine's tools first on PATH. It never connects anywhere; the host
 * `unreachable.invalid` fails like ssh does (exit 255). ssh runs with a bare environment (sshEnv), so every path is
 * written into the script.
 */
function fakeSsh(root: string) {
  const bin = path.join(root, "bin")
  const tools = path.join(root, "machine-tools")
  const home = path.join(root, "machine-home")
  const log = path.join(root, "ssh-argv.log")
  const stdin = path.join(root, "ssh-stdin.log")
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(tools, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const [node, script] = FAKE_CLAUDE.split(" ")
  // claude on the machine isn't logged in (Box Yard forwards its Claude key for the turn); codex is there, unused.
  fs.writeFileSync(path.join(tools, "claude"), `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn": false}'; exit 0; fi\nexec '${node}' '${script}' "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(tools, "codex"), `#!/bin/sh\necho "codex-cli 0.40.0"\n`, { mode: 0o755 })
  fs.writeFileSync(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
control=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-l|-o|-i) shift 2 ;;
    -O) control="$2"; shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host="$1"; shift
[ -n "$control" ] && exit 0
if [ "$host" = unreachable.invalid ]; then echo "ssh: Could not resolve hostname $host: Name or service not known" >&2; exit 255; fi
cd '${home}' || exit 255
export HOME='${home}' PATH='${tools}':"$PATH" SHELL=
tee -a '${stdin}' | sh -c "$*"
`,
    { mode: 0o755 },
  )
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")
  return { ssh: path.join(bin, "ssh"), home, argv: () => read(log), stdin: () => read(stdin) }
}

/** Every file under `dir` whose content has `text`. */
function filesWith(dir: string, text: string): string[] {
  try {
    return execFileSync("grep", ["-rlsF", "--", text, dir], { encoding: "utf8" }).split("\n").filter(Boolean)
  } catch {
    return []
  }
}

describe("SSH machines over ssh (a stand-in ssh: no sshd here)", () => {
  it("logs in with the referenced key and nothing forwarded; credentials go in on stdin for one turn and don't stay", { timeout: 200_000 }, async () => {
    const root = tmpDir("by-fake-ssh-")
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const fake = fakeSsh(root)
    // This computer's ~/.ssh, with the key Box Yard is told to use (by reference).
    const me = path.join(root, "me")
    fs.mkdirSync(path.join(me, ".ssh"), { recursive: true, mode: 0o700 })
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(me, ".ssh", "id_tower")])
    const secrets = { claude: "sk-ant-oat01-fakeclaudetoken0123456789", github: "ghp_fakegithubtoken0123456789abcdef" }
    const r = await start({
      config: { claudeOauthToken: secrets.claude, githubToken: secrets.github },
      machines: { mock: null, sshBin: fake.ssh, keys: { home: me } },
    })

    const { machine } = await addMachine(r, { name: "tower", host: "tower.lan", user: "cody", port: 2222, keyRef: "file:~/.ssh/id_tower", labels: ["gpu"] })
    expect(machine).toMatchObject({ state: "ready", keyRef: "file:~/.ssh/id_tower" })
    expect(machine.lastTest).toMatchObject({ ok: true, claudeLogin: false, workDir: fs.realpathSync(path.join(fake.home, "boxyard")) })
    expect(machine.lastTest!.tools.claude.path).toBe(path.join(root, "machine-tools", "claude"))
    expect(machine.lastTest!.tools.codex).toMatchObject({ found: true, version: "codex-cli 0.40.0" })
    expect(machine.lastTest!.notes.join("\n")).toMatch(/claude isn't logged in on it/)
    expect(machine.lastTest!.notes.join("\n")).toMatch(/codex is installed/)

    const p = await call<Project>(r, "POST", "/api/projects", { name: "on-the-tower", runner: "ssh", machineLabel: "gpu" })
    const t = r.yard.tasks.createTask({ projectId: p.id, title: "haiku", prompt: "write a haiku" })
    await done(r, t.id)
    const box = machineBoxId(machine.id)
    expect(getTask(r, t.id).boxId).toBe(box)
    const dir = r.yard.tasks.taskDir(box, t.id)
    expect(dir.startsWith(fs.realpathSync(fake.home))).toBe(true)
    expect(fs.existsSync(path.join(dir, "work", "box-yard-demo.md"))).toBe(true)

    // Every ssh call: the key by reference, nothing forwarded, never a password prompt, the command on stdin.
    const calls = fake.argv().trim().split("\n")
    expect(calls.length).toBeGreaterThan(5)
    const key = fs.realpathSync(path.join(me, ".ssh", "id_tower"))
    for (const c of calls) {
      expect(c).toContain(`-p 2222 -l cody -o BatchMode=yes -o StrictHostKeyChecking=accept-new`)
      expect(c).toContain(`-i ${key} -o IdentitiesOnly=yes`)
      expect(c).toContain("-o ForwardAgent=no")
      expect(c).toMatch(/ tower\.lan (bash -c 'eval "\$\(cat\)"'|bash -c '.*')$/)
    }
    // The turn's credentials went to the machine on ssh's stdin (inside task.json, base64)... but never in a command
    // line, on the machine's disk after the turn, or in its memory folder.
    const sent = fake.stdin().replace(/\n/g, "")
    for (const s of Object.values(secrets)) {
      expect(fake.stdin()).not.toContain(s)
      expect([0, 1, 2].some((i) => sent.includes(Buffer.from("x".repeat(i) + s).toString("base64").slice(4, 28)))).toBe(true)
      expect(fake.argv()).not.toContain(s)
      expect(filesWith(fake.home, s)).toEqual([])
    }
    expect(fs.existsSync(path.join(dir, "task.json"))).toBe(false)
    const shm = machine.lastTest!.secretsDir
    if (shm) {
      cleanup.push(() => {
        for (const f of fs.existsSync(shm) ? fs.readdirSync(shm) : []) if (f.startsWith(t.id)) fs.rmSync(path.join(shm, f), { force: true })
        // The folder itself only when nothing else is in it.
        try {
          fs.rmdirSync(shm)
        } catch {}
      })
      expect(fs.existsSync(shm) ? fs.readdirSync(shm).filter((f) => f.startsWith(t.id)) : []).toEqual([])
    }

    // A machine that can't be reached: its test says why, and its tasks wait instead of running anywhere else.
    const { machine: moved } = await call<{ machine: MachineStatus }>(r, "PATCH", `/api/machines/${machine.id}`, { host: "unreachable.invalid" })
    expect(moved).toMatchObject({ state: "offline" })
    expect(moved.lastTest!.error).toMatch(/Can't connect: Could not resolve hostname unreachable.invalid/)
    expect(fake.argv()).toMatch(/^-O stop .* tower\.lan$/m)
    const next = r.yard.tasks.createTask({ projectId: p.id, title: "later", prompt: "write a haiku" })
    expect((await until(r, next.id, (x) => Boolean(x.waitReason), "to wait")).waitReason).toMatch(/none of SSH machines labelled "gpu" can take tasks now/)
    expect(getTask(r, next.id).boxId).toBeNull()
    expect(r.boxes.created).toBe(0)
  })
})
