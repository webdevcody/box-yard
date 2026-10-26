import { afterAll, afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxHealth } from "../server/providers/types.js"
import type { RunPodPodState } from "../server/providers/runpod.js"
import type { RunPodPod } from "../server/runpod/api.js"
import type { GpuRunner } from "../server/tasks.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_RUNPOD_SETTINGS, gpuBoxId } from "../shared/runpod.js"
import type { BoxEvent, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// delete_box and delete_idle_boxes (the Coordinator's and the Captains'): the same safety check as Box Yard's own
// cleanups refuses running agents, queued turns and work only the box has; an allowed delete archives first, then
// deletes, then writes the box history row with who and why. A Captain only reaches boxes holding nothing but its
// project's work. A GPU pod is terminated and its network volume stays. Boxes are folders and pods are fakes.

/** RunPod stand-in: `wake` starts a pod (a folder), `destroy` terminates it. It has no volumes to touch. */
class FakePods extends LocalProvider {
  pods = new Map<string, RunPodPod>()
  terminated: string[] = []
  private n = 0

  override async wake(boxId: string) {
    if (this.pods.has(boxId)) return
    this.pods.set(boxId, { id: `pod${++this.n}`, name: `boxyard-test-${boxId}`, status: "RUNNING", cost: 0.27, gpu: { id: "NVIDIA RTX A5000" }, startedAt: new Date().toISOString() } as RunPodPod)
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
  }
  override async health(boxId: string): Promise<BoxHealth> {
    return this.pods.has(boxId) ? "running" : "paused"
  }
  override async destroy(boxId: string) {
    if (!this.pods.delete(boxId)) return
    this.terminated.push(boxId)
    await super.destroy(boxId)
  }
  async listPods(): Promise<RunPodPodState[]> {
    return [...this.pods].map(([boxId, pod]) => ({ boxId, pod, target: null }))
  }
  cached(boxId: string) {
    return this.pods.get(boxId) ?? null
  }
  capOf() {
    return 1
  }
  async nextPodPrice() {
    return { gpu: "RTX A5000", usd: 0.27 }
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  provider: LocalProvider
  pods: FakePods | null
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []
const dirs: string[] = []
const dir = (prefix: string) => {
  const d = tmpDir(prefix)
  dirs.push(d)
  return d
}

async function start(overrides: Partial<Config> = {}, withGpu = false): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port, maxBoxes: 1, slotsPerBox: 1, ...overrides })
  dirs.push(config.dataDir)
  const provider = new LocalProvider(dir("delete-boxes-"), FAKE_CLAUDE)
  const pods = withGpu ? new FakePods(dir("delete-pods-"), FAKE_CLAUDE) : null
  const gpu: GpuRunner | undefined = pods ? { provider: pods, settings: () => DEFAULT_RUNPOD_SETTINGS, enabled: () => true, keepWarmUntil: () => null } : undefined
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider, gpu })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, provider, pods }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => r.yard.store.listBoxes().every((b) => !r.yard.tasks.janitor.isRunning(b.id)), "cleanups to settle").catch(() => {})
    await waitFor(() => !r.yard.captains.anyBusy(), "captains to settle").catch(() => {})
    await new Promise((res) => setTimeout(res, 300))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
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

const project = (r: Running, name: string, runner?: "gpu") => call<Project>(r, "POST", "/api/projects", { name, ...(runner ? { runner } : {}) })
const task = async (r: Running, projectId: string, title: string, prompt = "write a haiku") => (await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt })).id
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return ok(t) ? t : null
  }, `task ${id} ${what}`)
/** Done, archived and resting on its box. */
const settled = async (r: Running, id: string) => {
  const t = await until(r, id, (x) => x.status === "done" && Boolean(x.lastArchivedAt) && x.pendingCount === 0 && Boolean(x.boxId), "to finish and archive")
  await new Promise((res) => setTimeout(res, 300))
  return t
}
const deletedRows = async (r: Running) => (await call<{ events: BoxEvent[] }>(r, "GET", "/api/box-history")).events.filter((e) => e.type === "deleted")
const workDir = (r: Running, taskId: string) => {
  const row = r.yard.store.getTaskRow(taskId)!
  return path.join(r.yard.tasks.taskDir(row.box_id!, taskId), "work")
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString()
/** Make a task's workspace a git repo whose branch is pushed to a bare origin of its own. */
function pushedRepo(r: Running, taskId: string) {
  const work = workDir(r, taskId)
  const bare = path.join(dir("delete-origin-"), "origin.git")
  git(path.dirname(bare), "init", "-q", "--bare", "-b", "main", bare)
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "agent work")
  git(work, "remote", "add", "origin", bare)
  git(work, "push", "-q", "-u", "origin", "main")
  return work
}
/** Pretend the workspace changed after its last archive (no turn ran since), so only the box has the current copy. */
function staleArchive(r: Running, taskId: string, file?: string) {
  if (file) fs.writeFileSync(path.join(workDir(r, taskId), file), "only on the box\n")
  const row = r.yard.store.getTaskRow(taskId)!
  r.yard.store.updateTask(taskId, { lastArchivedAt: row.last_active_at - 60_000 }, { touch: false })
}

type Tool = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; json: <T = Record<string, unknown>>() => T }>
async function mcpAs(r: Running, caller: McpCaller): Promise<Tool> {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name, args = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = res.content[0]!.text
    return { text, isError: Boolean(res.isError), json: <T>() => JSON.parse(text) as T }
  }
}

describe("delete_box: the safety check", () => {
  it("refuses a running agent, a queued task, unpushed commits and an unmerged dirty workspace, and deletes nothing", async () => {
    const r = await start()
    const p = await project(r, "tiny-town")
    const queued = await task(r, p.id, "Queued one")
    const boxId = (await settled(r, queued)).boxId!
    const dirty = await task(r, p.id, "Half done")
    await settled(r, dirty)
    pushedRepo(r, dirty)
    fs.writeFileSync(path.join(workDir(r, dirty), "wip.txt"), "not committed\n")
    r.yard.store.updateTask(dirty, { prState: "open" }, { touch: false })
    const ahead = await task(r, p.id, "Ahead")
    await settled(r, ahead)
    git(workDir(r, ahead), "init", "-q", "-b", "main")
    git(workDir(r, ahead), "add", "-A")
    git(workDir(r, ahead), "commit", "-qm", "never pushed")
    const hang = await task(r, p.id, "Busy", "keep going [hang]")
    await until(r, hang, (t) => t.status === "working", "to be working")
    // The box's one slot is taken, so a follow-up waits on the box.
    await call(r, "POST", `/api/tasks/${queued}/messages`, { content: "one more" })
    await until(r, queued, (t) => t.status === "queued", "to be queued")
    expect([queued, dirty, ahead, hang].map((id) => r.yard.store.getTaskRow(id)!.box_id)).toEqual([boxId, boxId, boxId, boxId])

    const refusal = [
      `${boxId} was not deleted:`,
      `- ${queued} "Queued one": queued for its next turn`,
      `- ${dirty} "Half done": uncommitted changes (1 file) and its PR is open`,
      `- ${ahead} "Ahead": 1 unpushed commit`,
      `- ${hang} "Busy": an agent is running on it`,
    ].join("\n")
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator("delete_box", { box: boxId, reason: "Clearing out tiny-town" })
    expect(res.isError).toBe(true)
    expect(res.text).toBe(refusal)
    // Its own project's Captain gets the same answer.
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    expect((await captain("delete_box", { box: boxId, reason: "Clearing out tiny-town" })).text).toBe(refusal)

    const dry = (await coordinator("delete_idle_boxes", {})).json<{ summary: string; would_delete: string[]; skipped: string[] }>()
    expect(dry.summary).toBe("Would delete 0 of 1 running box; 1 skipped.")
    expect(dry.skipped).toEqual([`${boxId} · tiny-town: ${refusal.split("\n- ").slice(1).join("; ")}`])
    expect((await coordinator("delete_idle_boxes", { dry_run: false, reason: "Clearing out tiny-town" })).json<{ summary: string }>().summary).toBe("Deleted 0 of 1 running box; 1 skipped.")

    expect(r.yard.store.getBox(boxId)).toBeTruthy()
    expect(fs.existsSync(r.provider.root(boxId))).toBe(true)
    expect(await deletedRows(r)).toEqual([])
    expect((await getTask(r, hang)).status).toBe("working")
  })
})

describe("delete_box: an allowed delete", () => {
  it("archives first, then deletes, then records who and why; the tasks restore from their archive on their next turn", async () => {
    const r = await start()
    const p = await project(r, "tiny-town")
    const merged = await task(r, p.id, "Merged")
    const boxId = (await settled(r, merged)).boxId!
    const loose = await task(r, p.id, "No repo")
    await settled(r, loose)
    // Merged and fully pushed: GitHub has it, so it needs no archive. The leftover file is only in the box.
    pushedRepo(r, merged)
    r.yard.store.updateTask(merged, { prState: "merged" }, { touch: false })
    staleArchive(r, merged)
    // A project without a repo: its folder lives only on the box, so it's archived first.
    staleArchive(r, loose, "notes.md")

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const check = (await coordinator("delete_idle_boxes", { project: "tiny-town" })).json<{ summary: string; would_delete: string[]; skipped: string[] }>()
    expect(check).toMatchObject({
      summary: "Would delete 1 of 1 tiny-town-only box; 0 skipped.",
      would_delete: [`${boxId} · tiny-town · 2 tasks: 1 PR merged and nothing unpushed: needs no archive; 1 no repo, so its folder only lives on the box; archived first`],
      skipped: [],
    })
    expect(r.yard.store.getBox(boxId)).toBeTruthy()

    const res = await coordinator("delete_box", { box: boxId, reason: "Idle since tiny-town's PRs merged" })
    expect(res.isError).toBe(false)
    expect(res.json()).toMatchObject({ deleted: boxId, archived: [loose], no_archive_needed: [`${merged} (PR merged, nothing unpushed)`] })

    // Archived before the box went: the archive holds the file only the box had.
    const loosePath = r.yard.store.getTaskRow(loose)!.archive_path!
    expect(execFileSync("tar", ["tzf", loosePath], { encoding: "utf8" })).toContain(`${loose}/work/notes.md`)
    expect(r.yard.store.getBox(boxId)).toBeFalsy()
    expect(fs.existsSync(r.provider.root(boxId))).toBe(false)
    expect([merged, loose].map((id) => r.yard.store.getTaskRow(id)!.box_id)).toEqual([null, null])
    const [row] = await deletedRows(r)
    expect(row).toMatchObject({
      boxId,
      actor: "coordinator",
      reason: "Idle since tiny-town's PRs merged",
      detail: "Deleted with delete_box after the safety check passed: 1 archived, 1 needed no archive (PR merged, nothing unpushed).",
    })
    expect(r.yard.store.listTaskMessages(loose, 200).some((m) => m.content === "Box deleted by the Coordinator. The workspace will be restored from its archive when needed.")).toBe(true)

    // Already gone: asking again is a no-op.
    expect((await coordinator("delete_box", { box: boxId, reason: "again" })).text).toBe(`${boxId} is already gone (deleted earlier, or at the provider): nothing left to delete. box_history has what happened to it.`)

    // The task keeps working: its next message restores the workspace from that archive on a new box.
    await call(r, "POST", `/api/tasks/${loose}/messages`, { content: "one more haiku" })
    const back = await until(r, loose, (t) => t.status === "done" && t.pendingCount === 0 && Boolean(t.boxId), "to run again")
    expect(back.boxId).not.toBe(boxId)
    expect(fs.readFileSync(path.join(workDir(r, loose), "notes.md"), "utf8")).toBe("only on the box\n")
  })
})

describe("delete_box: a Captain's scope", () => {
  it("only deletes a box holding nothing but its own project's work", async () => {
    const r = await start({ maxBoxes: 2 })
    const alpha = await project(r, "alpha")
    const beta = await project(r, "beta")
    const a = await task(r, alpha.id, "Alpha work", "keep going [hang]")
    const alphaBox = (await until(r, a, (t) => t.status === "working" && Boolean(t.boxId), "to be working")).boxId!
    const b = await task(r, beta.id, "Beta work")
    const betaBox = (await settled(r, b)).boxId!
    expect(betaBox).not.toBe(alphaBox)
    await r.yard.tasks.stopTask(a)
    await until(r, a, (t) => t.status !== "working" && t.pendingCount === 0 && Boolean(t.lastArchivedAt), "to stop")

    const captain = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    const other = await captain("delete_box", { box: betaBox, reason: "Not mine" })
    expect(other.isError).toBe(true)
    expect(other.text).toMatch(new RegExp(`^Out of scope: box ${betaBox} holds work of beta, and a Captain can only delete a box that holds nothing but its own project's\\.`))
    expect((await captain("delete_idle_boxes", { project: "beta" })).text).toMatch(/^Out of scope: project "beta" belongs to another Captain/)
    // A box shared with another project is out of reach too.
    r.yard.store.updateTask(b, { boxId: alphaBox }, { touch: false })
    expect((await captain("delete_box", { box: alphaBox, reason: "Mixed" })).text).toMatch(new RegExp(`^Out of scope: box ${alphaBox} holds work of alpha, beta`))
    expect((await captain("delete_idle_boxes", {})).text).toBe("No alpha-only boxes to look at.")
    r.yard.store.updateTask(b, { boxId: betaBox }, { touch: false })

    const dry = (await captain("delete_idle_boxes", {})).json<{ would_delete: string[] }>()
    expect(dry.would_delete).toEqual([`${alphaBox} · alpha · 1 task: 1 no repo, so its folder only lives on the box; its archive is up to date`])
    const res = (await captain("delete_idle_boxes", { dry_run: false, reason: "Alpha is idle" })).json<{ summary: string; deleted: string[] }>()
    expect(res.summary).toBe("Deleted 1 of 1 alpha-only box; 0 skipped.")
    expect(r.yard.store.getBox(alphaBox)).toBeFalsy()
    expect(r.yard.store.getBox(betaBox)).toBeTruthy()
    expect(await deletedRows(r)).toMatchObject([{ boxId: alphaBox, actor: "captain", actorProjectId: alpha.id, reason: "Alpha is idle" }])
    expect(r.yard.store.listTaskMessages(a, 200).some((m) => m.content === "Box deleted by its project's Captain. The workspace will be restored from its archive when needed.")).toBe(true)
  })

  it("wants a reason before a real bulk delete", async () => {
    const r = await start()
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator("delete_idle_boxes", {})).text).toBe("No running boxes to look at.")
    const res = await coordinator("delete_idle_boxes", { dry_run: false })
    expect(res.isError).toBe(true)
    expect(res.text).toBe("Give a reason when dry_run is false; it goes in each box's history.")
    expect((await coordinator("delete_box", { box: "box_nope", reason: "typo" })).text).toBe('No box "box_nope". Use pool_status.')
  })
})

describe("delete_box: RunPod GPU pods", () => {
  it("terminates an idle pod after archiving its workspaces, and its network volume stays", async () => {
    const r = await start({}, true)
    const p = await project(r, "vision", "gpu")
    const t = await task(r, p.id, "Train")
    const podId = gpuBoxId(p.id)
    expect((await settled(r, t)).boxId).toBe(podId)
    staleArchive(r, t, "weights.txt")

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const dry = (await coordinator("delete_idle_boxes", { project: "vision" })).json<{ would_delete: string[] }>()
    expect(dry.would_delete).toEqual([`GPU pod #1 · vision · ${podId} · vision · 1 task: 1 no repo, so its folder only lives on the box; archived first`])
    expect(r.pods!.terminated).toEqual([])

    const res = await coordinator("delete_box", { box: podId, reason: "Vision is done for today" })
    expect(res.json()).toMatchObject({ terminated: `GPU pod #1 · vision (${podId})`, volume: "kept", archived: [t] })
    expect(r.pods!.terminated).toEqual([podId])
    expect(execFileSync("tar", ["tzf", r.yard.store.getTaskRow(t)!.archive_path!], { encoding: "utf8" })).toContain(`${t}/work/weights.txt`)
    const rows = await deletedRows(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ boxId: podId, actor: "coordinator", reason: "Vision is done for today" })
    expect(rows[0]!.detail).toMatch(/Its network volume stays\.$/)

    // Nothing left to terminate.
    const again = await coordinator("delete_box", { box: podId, reason: "again" })
    expect(again.isError).toBe(true)
    expect(again.text).toContain(`GPU pod ${podId} isn't running`)
    expect(r.pods!.terminated).toEqual([podId])
  })
})
