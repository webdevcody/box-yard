import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ExecResult } from "../server/providers/types.js"
import { boxAttention } from "../web/src/lib/boxOverview.js"
import type { BoxInfo, Health, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The slot limit (Settings › Agents per box, or each size's default) holds on every start path: a new task, a
// follow-up from Cody, the Coordinator, a Captain or a hook, a merge request, a restore from the archive. They
// all queue a turn that the scheduler starts through one check-and-claim (Store.claimTurnSlot), so two starts
// can't both take a box's last slot. A task whose workspace is on a full box waits there with the reason,
// unless it can move without losing work.

/** Local boxes that can run a callback in the middle of a placement's df probe (to race a start against it). */
class RacyBoxes extends LocalProvider {
  onDf: (() => void) | null = null
  onRunnerStart: ((command: string) => void) | null = null
  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (command.startsWith("df -Pk") && this.onDf) {
      const f = this.onDf
      this.onDf = null
      await new Promise((r) => setTimeout(r, 20))
      f()
    }
    if (command.includes("nohup") && this.onRunnerStart) {
      const f = this.onRunnerStart
      this.onRunnerStart = null
      f(command)
    }
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: RacyBoxes
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new RacyBoxes(tmpDir("boxes-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port, maxBoxes: 1, ...overrides }), { webDir: "/nonexistent", provider })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, provider }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
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

const HANG = "keep going [hang]"
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const newTask = (r: Running, projectId: string, title: string, prompt = "write a haiku") => r.yard.tasks.createTask({ projectId, title, prompt })
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(() => {
    const t = getTask(r, id)
    return want(t) ? t : null
  }, what)
const working = (r: Running, id: string) => status(r, id, (t) => t.status === "working", `task ${id} to work`)
const settled = (r: Running, id: string) => status(r, id, (t) => t.status === "done" && Boolean(t.lastArchivedAt) && t.pendingCount === 0, `task ${id} to finish and archive`)
const inUse = (r: Running, boxId: string) => r.yard.store.slotsInUse(boxId)

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin with one commit on main, served over file:// like GitHub. */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  return `file://${bare}`
}

/** Fail the test if any box ever runs more turns than its slots (checked on every broadcast). */
function watchSlots(r: Running) {
  const over: string[] = []
  const orig = r.yard.hub.broadcast.bind(r.yard.hub)
  r.yard.hub.broadcast = (ev) => {
    for (const b of r.yard.store.listBoxes()) {
      const n = inUse(r, b.id)
      const slots = r.yard.tasks.boxes().find((x) => x.id === b.id)?.slots ?? 0
      if (n > slots) over.push(`${b.id}: ${n}/${slots}`)
    }
    return orig(ev)
  }
  return over
}

/** A box with `slots` running agents on it, in a project with one box and a full pool. */
async function fullBox(r: Running, slots = 2) {
  const p = r.yard.store.createProject({ name: "alpha" })
  const hangs = []
  for (let i = 0; i < slots; i++) hangs.push(newTask(r, p.id, `runner ${i + 1}`, HANG))
  const rows = await Promise.all(hangs.map((t) => working(r, t.id)))
  const boxId = rows[0]!.boxId!
  expect(rows.every((t) => t.boxId === boxId)).toBe(true)
  return { project: p, boxId, hangs: rows }
}

describe("slot limit", () => {
  it("claims a box's slot in one step: of several starts for the last free slot, only one gets it", () => {
    const r = { yard: createBoxYard(testConfig({ maxBoxes: 1 }), { webDir: "/nonexistent" }) } as Running
    try {
      const store = r.yard.store
      const p = store.createProject({ name: "alpha" })
      store.upsertBox({ id: "box_race01", provider: "local", status: "ready", created_at: 1, last_used_at: 1, size: "large", keep_alive: 0, usage_source: "estimated" })
      const ids = [1, 2, 3, 4].map((n) => store.createTask({ projectId: p.id, title: `t${n}`, prompt: "x" }).id)
      expect(store.claimTurnSlot(ids[0]!, "box_race01", 2, { status: "starting", currentTurnId: "turn-1" })).toBe(true)
      // Three starts released together with one slot left.
      const won = ids.slice(1).map((id, i) => store.claimTurnSlot(id, "box_race01", 2, { status: "starting", currentTurnId: `turn-${i + 2}` }))
      expect(won).toEqual([true, false, false])
      expect(store.slotsInUse("box_race01")).toBe(2)
      // A task that already has a turn can't claim a second one.
      expect(store.claimTurnSlot(ids[0]!, "box_race01", 9, { status: "starting", currentTurnId: "turn-again" })).toBe(false)
      expect(store.getTaskRow(ids[0]!)!.current_turn_id).toBe("turn-1")
      // Losers are untouched: still queued, no box, no turn.
      for (const id of ids.slice(2)) expect(store.getTaskRow(id)).toMatchObject({ current_turn_id: null, box_id: null, status: "queued" })
      // A task that's starting or working counts even before its turn id lands.
      store.updateTask(ids[0]!, { currentTurnId: null })
      expect(store.slotsInUse("box_race01")).toBe(2)
    } finally {
      r.yard.stop()
    }
  })

  it("lets only one of several queued tasks take the last free slot when they're released in one pass", async () => {
    const r = await start({ maxBoxes: 1 })
    const over = watchSlots(r)
    const { project, boxId } = await fullBox(r, 1)
    // One slot left: three tasks queued in the same tick.
    const queued = [1, 2, 3].map((n) => newTask(r, project.id, `queued ${n}`, HANG))
    await waitFor(() => inUse(r, boxId) === 2, "the free slot to be taken")
    await new Promise((res) => setTimeout(res, 800))
    const rows = queued.map((t) => getTask(r, t.id))
    expect(rows.filter((t) => t.status === "working" || t.status === "starting")).toHaveLength(1)
    const waiting = rows.filter((t) => t.status === "queued")
    expect(waiting).toHaveLength(2)
    for (const t of waiting) expect(t.waitReason).toBe("Waiting for a free slot: every box is full and the pool is at its limit")
    expect(inUse(r, boxId)).toBe(2)
    expect(over).toEqual([])
  })

  it("re-checks the slot when it claims: a start that took the slot while placement awaited wins, the other waits", async () => {
    const r = await start({ maxBoxes: 1, memoryMaxUsedPercent: 99 })
    const over = watchSlots(r)
    const { project, boxId } = await fullBox(r, 1)
    // Another start (here: another server on this database) takes the last slot while placement probes the box.
    const rogue = r.yard.store.createTask({ projectId: project.id, title: "rogue", prompt: "x" })
    r.yard.store.updateTask(rogue.id, { status: "idle" })
    ;(r.yard.tasks as unknown as { diskCache: Map<string, unknown> }).diskCache.clear()
    r.provider.onDf = () => {
      expect(r.yard.store.claimTurnSlot(rogue.id, boxId, 2, { status: "starting", currentTurnId: "rogue-turn" })).toBe(true)
    }
    const t = newTask(r, project.id, "late", HANG)
    const waited = await status(r, t.id, (x) => Boolean(x.waitReason), "the late task to wait")
    expect(waited.status).toBe("queued")
    expect(waited.waitReason).toBe(`Waiting for a free slot on ${boxId}`)
    expect(r.provider.onDf).toBeNull()
    expect(inUse(r, boxId)).toBe(2)
    expect(over).toEqual([])
    r.yard.store.updateTask(rogue.id, { status: "idle", currentTurnId: null })
  })

  it("holds the limit on every start path: follow-ups from Cody, the Coordinator, a Captain and a hook, a merge, a restore, a new task", async () => {
    const r = await start({ maxBoxes: 1 })
    const over = watchSlots(r)
    const p = r.yard.store.createProject({ name: "alpha" })
    // Tasks that rest on the box, then two agents that fill it.
    const resting = [1, 2, 3, 4, 5, 6].map((n) => newTask(r, p.id, `resting ${n}`))
    for (const t of resting) await settled(r, t.id)
    const hangs = [newTask(r, p.id, "runner 1", HANG), newTask(r, p.id, "runner 2", HANG)]
    const boxId = (await working(r, hangs[0]!.id)).boxId!
    await working(r, hangs[1]!.id)
    expect(inUse(r, boxId)).toBe(2)

    const [cody, coordinator, captain, hook, merge, restore] = resting.map((t) => t.id) as [string, string, string, string, string, string]
    r.yard.tasks.sendInput(cody, "one more thing", "cody")
    r.yard.tasks.sendInput(coordinator, "one more thing", "orchestrator")
    r.yard.tasks.sendInput(captain, "one more thing", `captain:${p.id}`)
    r.yard.tasks.sendInput(hook, "on PR ready", "hook:hook_test01", [], null, { prefix: "Hook", meta: { source: "hook", hookId: "hook_test01", hookName: "test" } })
    r.yard.store.updateTask(merge, { prUrl: "https://github.com/o/r/pull/7", prState: "open", status: "pr_ready" })
    r.yard.tasks.requestMerge(merge)
    // Parked in the archive: its next turn restores it.
    r.yard.store.updateTask(restore, { boxId: null, portBase: null })
    r.yard.tasks.sendInput(restore, "pick it back up", "cody")
    const fresh = newTask(r, p.id, "brand new", HANG)
    const all = [cody, coordinator, captain, hook, merge, restore, fresh.id]
    for (const id of all) await status(r, id, (t) => t.status === "queued" && Boolean(t.waitReason), `task ${id} to wait with a reason`)
    await new Promise((res) => setTimeout(res, 800))
    for (const id of all) expect(getTask(r, id).status).toBe("queued")
    // Pinned to the full box (their workspaces live there; archived, but there's no other box to move to).
    for (const id of [cody, coordinator, captain, hook, merge]) expect(getTask(r, id).waitReason).toBe(`Waiting for a free slot on ${boxId}`)
    expect(getTask(r, restore).waitReason).toBe("Waiting for a free slot: every box is full and the pool is at its limit")
    expect(inUse(r, boxId)).toBe(2)

    // A slot frees: exactly one of them takes it.
    await r.yard.tasks.stopTask(hangs[0]!.id)
    await waitFor(() => all.some((id) => getTask(r, id).status !== "queued"), "a waiting task to start")
    expect(over).toEqual([])
    expect(inUse(r, boxId)).toBeLessThanOrEqual(2)
  }, 60_000)

  it("keeps a pinned task without a fresh archive on its full box with the reason, and moves one that can move", async () => {
    const r = await start({ maxBoxes: 2 })
    const over = watchSlots(r)
    const p = r.yard.store.createProject({ name: "alpha" })
    const stuck = newTask(r, p.id, "stuck")
    const movable = newTask(r, p.id, "movable")
    await settled(r, stuck.id)
    await settled(r, movable.id)
    const hangs = [newTask(r, p.id, "runner 1", HANG), newTask(r, p.id, "runner 2", HANG)]
    const boxId = (await working(r, hangs[0]!.id)).boxId!
    await working(r, hangs[1]!.id)
    expect(getTask(r, stuck.id).boxId).toBe(boxId)
    // Its archive is older than its last turn: moving it would lose work, so it waits for a slot on its own box.
    r.yard.store.updateTask(stuck.id, { lastArchivedAt: 1 })
    r.yard.tasks.sendInput(stuck.id, "continue", "cody")
    const waiting = await status(r, stuck.id, (t) => t.waitReason === `Waiting for a free slot on ${boxId}`, "the stuck task's reason")
    expect(waiting.status).toBe("queued")
    expect(waiting.boxId).toBe(boxId)
    // Archived at its turn end: it restores on a box with room (a new one, the pool may grow).
    r.yard.tasks.sendInput(movable.id, "continue", "cody")
    const moved = await status(r, movable.id, (t) => t.status === "done" && t.pendingCount === 0 && t.boxId !== boxId, "the movable task to run elsewhere")
    expect(moved.boxId).toBeTruthy()
    expect(r.yard.store.listTaskMessages(movable.id, 100).some((m) => m.content.startsWith(`Moved from busy box ${boxId}`))).toBe(true)
    expect(getTask(r, stuck.id)).toMatchObject({ status: "queued", boxId })
    expect(over).toEqual([])
  }, 60_000)

  it("keeps a task whose archive is too big to upload on its full box, with the reason", async () => {
    const r = await start({ maxBoxes: 2 })
    const over = watchSlots(r)
    const p = r.yard.store.createProject({ name: "alpha" })
    const big = await settled(r, newTask(r, p.id, "big").id)
    const hangs = [newTask(r, p.id, "runner 1", HANG), newTask(r, p.id, "runner 2", HANG)]
    const boxId = (await working(r, hangs[0]!.id)).boxId!
    await working(r, hangs[1]!.id)
    expect(big.boxId).toBe(boxId)
    // Archived after its last turn, but over what a restore uploads in one file (Upstash: 100 MB).
    fs.truncateSync(r.yard.store.getTaskRow(big.id)!.archive_path!, 91 * 1024 * 1024)
    r.yard.tasks.sendInput(big.id, "continue", "cody")
    await status(r, big.id, (t) => t.waitReason === `Waiting for a free slot on ${boxId}`, "the big task's reason")
    await new Promise((res) => setTimeout(res, 1500))
    expect(getTask(r, big.id)).toMatchObject({ status: "queued", boxId, waitReason: `Waiting for a free slot on ${boxId}` })
    expect(r.yard.store.listBoxes()).toHaveLength(1)
    expect(over).toEqual([])
  }, 60_000)

  it("moves a repo task off its full box only when its last turn's work is on origin", async () => {
    const r = await start({ maxBoxes: 2 })
    const over = watchSlots(r)
    const p = r.yard.store.createProject({ name: "alpha" })
    r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(origin(), p.id)
    const pushed = await settled(r, newTask(r, p.id, "pushed").id)
    const unpushed = await settled(r, newTask(r, p.id, "unpushed").id)
    expect(pushed.pushState?.status).toBe("pushed")
    const hangs = [newTask(r, p.id, "runner 1", HANG), newTask(r, p.id, "runner 2", HANG)]
    const boxId = (await working(r, hangs[0]!.id)).boxId!
    await working(r, hangs[1]!.id)
    expect([pushed.boxId, unpushed.boxId]).toEqual([boxId, boxId])
    // Its turn-end push didn't happen: the archive alone would carry its code, so it stays with its workspace.
    r.yard.store.updateTask(unpushed.id, { pushState: { ...unpushed.pushState!, status: "failed", reason: "no access" } }, { touch: false })
    r.yard.tasks.sendInput(unpushed.id, "continue", "cody")
    await status(r, unpushed.id, (t) => t.waitReason === `Waiting for a free slot on ${boxId}`, "the unpushed task's reason")
    // Origin has its branch and WIP: it restores on a new box from git plus its small archive.
    r.yard.tasks.sendInput(pushed.id, "continue", "cody")
    const moved = await status(r, pushed.id, (t) => t.status === "done" && t.pendingCount === 0 && t.boxId !== boxId, "the pushed task to run elsewhere")
    expect(moved.boxId).toBeTruthy()
    expect(r.yard.store.listTaskMessages(pushed.id, 100).some((m) => m.content.startsWith(`Moved from busy box ${boxId}`))).toBe(true)
    expect(getTask(r, unpushed.id)).toMatchObject({ status: "queued", boxId })
    expect(over).toEqual([])
  }, 90_000)

  it("puts a new task on a box with a free slot (or a new one) instead of a full one", async () => {
    const r = await start({ maxBoxes: 2 })
    const over = watchSlots(r)
    const b = r.yard.store.createProject({ name: "beta" })
    // beta's box sits idle in the pool.
    const done = await settled(r, newTask(r, b.id, "beta first").id)
    const { project, boxId } = await fullBox(r, 2)
    expect(boxId).not.toBe(done.boxId)
    const t = newTask(r, project.id, "one more", HANG)
    const placed = await working(r, t.id)
    expect(placed.boxId).toBe(done.boxId)
    expect(inUse(r, boxId)).toBe(2)
    expect(over).toEqual([])
  }, 60_000)

  it("says on the box when its limit was lowered under running agents, and places nothing new there", async () => {
    const r = await start({ maxBoxes: 1 })
    const { project, boxId } = await fullBox(r, 2)
    r.yard.settings.update({ slotsPerBox: 1 })
    const box = r.yard.tasks.boxes().find((x) => x.id === boxId)! as BoxInfo
    expect(box).toMatchObject({ slots: 1, runningTurns: 2, limitLoweredFrom: 2 })
    const over = boxAttention(box).find((x) => x.key === "over")!
    expect(over.detail).toBe("The limit was lowered from 2 to 1 while 2 agents were running. 2 agents are running on 1 slots. Running work continues; nothing new is placed here until it drops.")
    const t = newTask(r, project.id, "after the change", HANG)
    await status(r, t.id, (x) => Boolean(x.waitReason), "the new task to wait")
    expect(getTask(r, t.id).status).toBe("queued")
    expect(inUse(r, boxId)).toBe(2)
    // Running agents were never stopped.
    expect(r.yard.store.listTaskRows({ boxId }).filter((x) => x.status === "working")).toHaveLength(2)
  }, 60_000)

  it("doesn't start an agent for a turn whose start timed out while it was being set up", async () => {
    const r = await start({ maxBoxes: 1 })
    const p = r.yard.store.createProject({ name: "alpha" })
    let taskId = ""
    // maintain() gives up on the start (failed, slot freed) just before the runner would start.
    r.provider.onRunnerStart = () => r.yard.store.updateTask(taskId, { status: "failed", currentTurnId: null, error: "Starting the agent timed out." })
    taskId = newTask(r, p.id, "slow start", HANG).id
    await waitFor(() => r.provider.onRunnerStart === null, "the runner start")
    await new Promise((res) => setTimeout(res, 1500))
    const row = r.yard.store.getTaskRow(taskId)!
    expect(row).toMatchObject({ status: "failed", current_turn_id: null, error: "Starting the agent timed out." })
    expect(inUse(r, row.box_id!)).toBe(0)
  })

  it("uses a saved Agents per box over each size's default, even next to a value this build doesn't know", async () => {
    const r = await start({ slotsPerBox: 1, maxResidentPerBox: 3 })
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(4)
    r.yard.settings.update({ slotsPerBox: 2 })
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(2)
    // A newer (or older) build's key, or an out-of-range value, next to it.
    const saved = JSON.parse(r.yard.store.getKv("settings") ?? "{}")
    r.yard.store.setKv("settings", JSON.stringify({ ...saved, someFutureSetting: true, maxBoxes: 100_000 }))
    expect(r.yard.tasks.sizeLimits("large").slotsPerBox).toBe(2)
    expect(r.yard.tasks.sizeLimits("small").slotsPerBox).toBe(2)
    expect(r.yard.settings.info().sources.slotsPerBox).toBe("ui")
  })

  it("reports the commit it runs on /api/health", async () => {
    const r = await start()
    const health = await call<Health>(r, "GET", "/api/health")
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    expect(health.build.commit).toBe(head)
    expect(health.build.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it("never runs more agents on a box than its slots under a burst of starts and follow-ups", async () => {
    const r = await start({ maxBoxes: 3 })
    r.yard.settings.update({ workerSize: "large", slotsPerBox: 2, memoryMaxUsedPercent: 99 })
    const over = watchSlots(r)
    const a = r.yard.store.createProject({ name: "alpha" })
    const b = r.yard.store.createProject({ name: "beta" })
    const ids: string[] = []
    const until = Date.now() + 8_000
    let i = 0
    while (Date.now() < until) {
      if (ids.length < 12 && Math.random() < 0.3) ids.push(newTask(r, Math.random() < 0.5 ? a.id : b.id, `burst ${i++}`, "go [slow:1]").id)
      else if (ids.length) r.yard.tasks.sendInput(ids[Math.floor(Math.random() * ids.length)]!, "again [slow:1]", Math.random() < 0.5 ? "cody" : "orchestrator")
      await new Promise((res) => setTimeout(res, Math.random() * 120))
    }
    expect(ids.length).toBeGreaterThan(3)
    expect(over).toEqual([])
  }, 60_000)
})
