import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { DOCKER_NOT_RUNNING } from "../server/docker/engine.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { FolderDockerProvider } from "../server/providers/dockerFolders.js"
import { LocalProvider } from "../server/providers/local.js"
import type { DockerRunner } from "../server/tasks.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_DOCKER_SETTINGS, DOCKER_NEEDS_CLAUDE_KEY, dockerBoxId, type DockerStatus } from "../shared/docker.js"
import { placementView } from "../shared/placement.js"
import type { Identity } from "../shared/identities.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The Docker runner end to end, in mock mode (FolderDockerProvider: a container is a folder): a project set to
// "Runs on: Docker container" runs its tasks in its one container, `docker-<projectId>`, never on a pool box; Stop
// keeps the workspaces, Delete archives them and the next turn restores them into a new container; the box history
// has every step. When Docker can't run, its tasks wait and say why, and never run anywhere else.

/** Pool boxes that count how many were made: a Docker task must never make one. */
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
  /** Set when the test brings its own Docker runner (`problem` decides whether Docker "runs"). */
  docker: { problem: string | null; folders: FolderDockerProvider } | null
}
const running: Running[] = []
const clients: { close: () => Promise<void> }[] = []

async function start(opts: { ownDocker?: boolean; config?: Partial<Config> } = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, ...opts.config })
  const boxes = new Boxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const own = opts.ownDocker ? { problem: DOCKER_NOT_RUNNING as string | null, folders: new FolderDockerProvider(tmpDir("containers-"), FAKE_CLAUDE) } : null
  const docker: DockerRunner | undefined = own ? { provider: own.folders, settings: () => DEFAULT_DOCKER_SETTINGS, problem: async () => own.problem } : undefined
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: boxes, docker })
  if (own) own.folders.onEvent = (e) => yard.tasks.dockerEvent(e)
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, boxes, dataDir: config.dataDir, docker: own }
  running.push(r)
  return r
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
    fs.rmSync(r.dataDir, { recursive: true, force: true })
  }
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
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes
    if (res.isError) throw new Error(res.content[0]!.text)
    return JSON.parse(res.content[0]!.text)
  }
}

const project = (r: Running, name: string, runner: "box" | "docker") => call<Project>(r, "POST", "/api/projects", { name, runner })
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  // A minute: a turn restores and clones on this computer, which may be busy.
  waitFor(() => (ok(getTask(r, id)) ? getTask(r, id) : null), `task ${id} ${what}`, 60_000).catch((err: Error) => {
    const t = getTask(r, id)
    const dir = t.boxId ? r.yard.tasks.taskDir(t.boxId, id) : null
    const log = dir && fs.existsSync(path.join(dir, "runner.log")) ? fs.readFileSync(path.join(dir, "runner.log"), "utf8").split("\n").slice(-12) : null
    const events = r.yard.store.listTaskMessages(id, 500).filter((m) => m.role === "event").map((m) => m.content).slice(-10)
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir) : null
    throw new Error(`${err.message}: ${JSON.stringify({ status: t.status, turns: t.turnCount, boxId: t.boxId, error: t.error, waitReason: t.waitReason, events, log, files, cursor: r.yard.store.getTaskRow(id)?.event_cursor }, null, 1)}`)
  })
const done = (r: Running, id: string, turns = 1) => until(r, id, (t) => t.status === "done" && t.turnCount >= turns && !t.pendingCount && !t.currentTurnId, `to finish turn ${turns}`)
const history = (r: Running, boxId: string) => r.yard.tasks.history.list({ boxId }).map((e) => `${e.type} by ${e.actor}`).reverse()
const dockerStatus = (r: Running) => call<DockerStatus>(r, "GET", "/api/docker")
const containerFolder = (r: Running, projectId: string) => path.join(r.dataDir, "docker-boxes", dockerBoxId(projectId))

describe("Docker runner (mock mode: containers are folders)", () => {
  // Three turns, each waited for up to a minute (`until`), so a slow one says where it stuck instead of timing out.
  it("runs a Docker project's tasks in its own container; Stop keeps the workspaces, Delete archives them for a new one", { timeout: 200_000 }, async () => {
    const r = await start()
    const p = await project(r, "contained", "docker")
    const box = dockerBoxId(p.id)
    const t = r.yard.tasks.createTask({ projectId: p.id, title: "first", prompt: "write a haiku" })
    await done(r, t.id)
    expect(getTask(r, t.id).boxId).toBe(box)
    // Its card and header say it's in its project's Docker container.
    expect(getTask(r, t.id).placement).toMatchObject({ now: { kind: "docker", boxId: box }, runner: "docker", chosenBy: "project" })
    expect(placementView(getTask(r, t.id)).label).toMatch(/^Docker · /)
    expect(r.boxes.created).toBe(0)
    expect(r.yard.store.listBoxes()).toEqual([])
    const work = path.join(r.yard.tasks.taskDir(box, t.id), "work", "box-yard-demo.md")
    expect(fs.existsSync(work)).toBe(true)
    expect(work.startsWith(containerFolder(r, p.id))).toBe(true)

    // Settings › Docker lists it, with its task.
    let s = await dockerStatus(r)
    expect(s.containers).toMatchObject([{ boxId: box, projectId: p.id, projectName: "contained", state: "running", tasks: 1, running: 0 }])

    // pool_status shows the project's container to the Coordinator and to its own Captain.
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const pool = await coordinator("pool_status")
    expect(pool.docker_projects.contained).toMatchObject({ agentsPerContainer: 2, container: `${box}: running, 0/2 tasks running` })

    // Stop: the volume (the folder) keeps the workspace; the next turn starts it again.
    s = await call<DockerStatus>(r, "POST", `/api/docker/containers/${box}/stop`)
    expect(s.containers[0]!.state).toBe("exited")
    expect(fs.existsSync(work)).toBe(true)
    r.yard.tasks.sendInput(t.id, "and another")
    await done(r, t.id, 2)
    expect(getTask(r, t.id).boxId).toBe(box)

    // Delete: archived first, then the container and its volume go; the next turn restores it into a new one.
    const del = await call<{ ok: boolean; archived: string[] }>(r, "DELETE", `/api/boxes/${box}`)
    expect(del.archived).toEqual([t.id])
    expect(fs.existsSync(containerFolder(r, p.id))).toBe(false)
    expect(getTask(r, t.id).boxId).toBeNull()
    r.yard.tasks.sendInput(t.id, "one more")
    await done(r, t.id, 3)
    expect(getTask(r, t.id).boxId).toBe(box)
    expect(fs.readFileSync(work, "utf8")).toContain("one more")

    expect(history(r, box)).toEqual(["created by scheduler", "stopped by owner", "started by scheduler", "deleted by owner", "created by scheduler"])
  })

  it("runs one task of a box project in Docker with runs_on, and its project's container goes when the project is deleted", async () => {
    const r = await start()
    const p = await project(r, "mixed", "box")
    const t = r.yard.tasks.createTask({ projectId: p.id, title: "contained", prompt: "write a haiku", runsOn: "docker" })
    await done(r, t.id)
    expect(getTask(r, t.id).boxId).toBe(dockerBoxId(p.id))
    expect(r.boxes.created).toBe(0)

    await call(r, "DELETE", `/api/projects/${p.id}`)
    await waitFor(() => !fs.existsSync(containerFolder(r, p.id)), "the container to be deleted with its project")
    expect(history(r, dockerBoxId(p.id)).at(-1)).toBe("deleted by owner")
    expect((await dockerStatus(r)).containers).toEqual([])
  })

  it("stops a container that's idle for Settings › Docker › Stop when idle", async () => {
    const r = await start()
    await call(r, "PUT", "/api/docker/settings", { idleMinutes: 5 })
    const p = await project(r, "sleepy", "docker")
    const t = r.yard.tasks.createTask({ projectId: p.id, title: "quick", prompt: "write a haiku" })
    await done(r, t.id)
    expect((await dockerStatus(r)).containers[0]!.state).toBe("running")
    const later = Date.now() + 6 * 60_000
    vi.spyOn(Date, "now").mockReturnValue(later)
    await r.yard.tasks.maintain()
    vi.restoreAllMocks()
    expect((await dockerStatus(r)).containers[0]!.state).toBe("exited")
    expect(history(r, dockerBoxId(p.id)).at(-1)).toBe("stopped by janitor")
  })
})

describe("Docker runner: when Docker can't run", () => {
  it("waits with the reason, tells the Captain once, never runs anywhere else, and starts once Docker runs", async () => {
    const r = await start({ ownDocker: true })
    const p = await project(r, "contained", "docker")
    const t = r.yard.tasks.createTask({ projectId: p.id, title: "patient", prompt: "write a haiku" })
    await until(r, t.id, (x) => x.status === "queued" && x.waitReason === `Waiting: ${DOCKER_NOT_RUNNING}`, "to wait for Docker")
    // A few placement passes later: still waiting, still nowhere, and one notice.
    await new Promise((res) => setTimeout(res, 800))
    expect(getTask(r, t.id)).toMatchObject({ status: "queued", boxId: null })
    expect(r.boxes.created).toBe(0)
    const notices = r.yard.store.listChat().filter((m) => m.role === "notice" && m.content.includes("waits: Docker is installed but not running"))
    expect(notices).toHaveLength(1)

    r.docker!.problem = null
    await done(r, t.id)
    expect(getTask(r, t.id).boxId).toBe(dockerBoxId(p.id))
  })

  it("refuses runs_on docker with Docker's reason when Setup can't use it", async () => {
    const r = await start({ ownDocker: true })
    const p = await project(r, "boxes", "box")
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    await expect(coordinator("create_tasks", { project: p.id, tasks: [{ title: "x", prompt: "y", runs_on: "docker" }] })).rejects.toThrow(/Docker is installed but not running/)
  })

  // Not mock mode, so a Claude key is needed: the one a turn would get (turnCredentials), wherever it comes from.
  it("waits for a Claude key only when the turn would get none: the task's env, its project's or its identity's counts", async () => {
    const r = await start({ ownDocker: true, config: { mock: false } })
    r.docker!.problem = null
    const p = await project(r, "keyless", "docker")
    const keyless = r.yard.tasks.createTask({ projectId: p.id, title: "keyless", prompt: "write a haiku" })
    await until(r, keyless.id, (x) => x.status === "queued" && x.waitReason === `Waiting: ${DOCKER_NEEDS_CLAUDE_KEY}`, "to wait for a Claude key")
    const own = r.yard.tasks.createTask({ projectId: p.id, title: "own key", prompt: "write a haiku", env: { ANTHROPIC_API_KEY: "task-key-0001" } })
    await done(r, own.id)
    expect(getTask(r, keyless.id)).toMatchObject({ status: "queued", boxId: null })

    // The project's identity gets a Claude login: the waiting task starts on it.
    const acme = await call<Identity>(r, "POST", "/api/identities", { name: "Acme" })
    await call(r, "PUT", `/api/identities/${acme.id}/claude`, { kind: "api_key", value: "acme-key-0001" })
    await call(r, "PATCH", `/api/projects/${p.id}`, { identityId: acme.id })
    await done(r, keyless.id)
    expect(getTask(r, keyless.id).boxId).toBe(dockerBoxId(p.id))
  })

  it("refuses runs_on docker without a Claude key for that task, and takes one from the task's env or the project's identity", async () => {
    const r = await start({ ownDocker: true, config: { mock: false } })
    r.docker!.problem = null
    const p = await project(r, "boxes", "box")
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    await expect(coordinator("create_task", { project: p.id, title: "x", prompt: "y", runs_on: "docker" })).rejects.toThrow(DOCKER_NEEDS_CLAUDE_KEY)
    // All or nothing: only the item without a key is a problem.
    const batch = coordinator("create_tasks", { project: p.id, tasks: [{ title: "a", prompt: "y" }, { title: "b", prompt: "y", env: { CLAUDE_CODE_OAUTH_TOKEN: "task-oauth-0001" } }], runs_on: "docker" })
    await expect(batch).rejects.toThrow(/one problem[\s\S]*- #1 "a": runs_on "docker"/)
    const keyed = await coordinator("create_task", { project: p.id, title: "keyed", prompt: "y", runs_on: "docker", env: { ANTHROPIC_API_KEY: "task-key-0002" } })
    expect(getTask(r, keyed.id).runsOn).toBe("docker")
    await done(r, keyed.id)

    const acme = await call<Identity>(r, "POST", "/api/identities", { name: "Acme" })
    await call(r, "PUT", `/api/identities/${acme.id}/claude`, { kind: "oauth_token", value: "acme-oauth-0001" })
    await call(r, "PATCH", `/api/projects/${p.id}`, { identityId: acme.id })
    const created = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "on acme", prompt: "y", runsOn: "docker" })
    expect(created.runsOn).toBe("docker")
  })
})
