import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { WorkerSize } from "../shared/types.js"
import { FAKE_CLAUDE, testConfig, waitFor } from "./helpers.js"

// Creating boxes for a queue: several at once up to Settings › Boxes created at once, never past Max boxes, only as
// many as the queued tasks need, and a failed or rate-limited create backs off without holding up the rest.

/** Creates finish only when the test says so. A task's turn is a `sleep`: agents take 3 node processes each. */
class GatedBoxes extends LocalProvider {
  private waiting: { resolve: () => void; reject: (err: unknown) => void }[] = []
  starts: { at: number; labels: string[]; size?: WorkerSize }[] = []
  inFlight = 0
  peak = 0
  override create(opts: { labels: string[]; size?: WorkerSize }): Promise<string> {
    this.inFlight++
    this.peak = Math.max(this.peak, this.inFlight)
    this.starts.push({ at: Date.now(), ...opts })
    return new Promise<string>((resolve, reject) => {
      this.waiting.push({ resolve: () => void super.create().then(resolve, reject), reject })
    }).finally(() => this.inFlight--)
  }
  get pending() {
    return this.waiting.length
  }
  /** Let the oldest waiting create finish, or fail it with `err`. */
  finish(err?: unknown) {
    const c = this.waiting.shift()
    if (!c) throw new Error("No create is waiting")
    if (err) c.reject(err)
    else c.resolve()
  }
  override exec(boxId: string, command: string) {
    const turn = /^cd ('[^']*') && .*box-runner\.mjs'? turn /.exec(command)
    if (turn) return super.exec(boxId, `cd ${turn[1]} && (nohup sleep 300 > /dev/null 2>&1 < /dev/null & echo $! > turn.pid) && cat turn.pid`)
    return super.exec(boxId, command)
  }
}

interface Running {
  yard: BoxYard
  provider: GatedBoxes
  boxesDir: string
}
const running: Running[] = []

afterEach(() => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    // The sleeps standing in for agents.
    for (const box of fs.readdirSync(r.boxesDir)) {
      const tasks = path.join(r.boxesDir, box, "tasks")
      for (const t of fs.existsSync(tasks) ? fs.readdirSync(tasks) : []) {
        const pidFile = path.join(tasks, t, "turn.pid")
        if (!fs.existsSync(pidFile)) continue
        try {
          process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()))
        } catch {}
      }
    }
  }
})

async function start(overrides: Partial<Config>, tuning: Partial<BoxYard["tasks"]["boxCreateTuning"]> = {}): Promise<Running> {
  const config = testConfig({ slotsPerBox: 1, ...overrides })
  const boxesDir = path.join(config.dataDir, "local-boxes")
  const provider = new GatedBoxes(boxesDir, FAKE_CLAUDE)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider })
  Object.assign(yard.tasks.boxCreateTuning, { retryBaseMs: 200, retryMaxMs: 2000, rateLimitMs: 400, ...tuning })
  await yard.start()
  const r = { yard, provider, boxesDir }
  running.push(r)
  return r
}

const queue = (r: Running, projectId: string, n: number, prefix = "Lot") =>
  r.yard.tasks.createTasks(Array.from({ length: n }, (_, i) => ({ projectId, title: `${prefix} ${i + 1}`, prompt: `Build on lot ${i + 1}.` })))
const working = (r: Running) => r.yard.store.listTasks().filter((t) => t.status === "working").length
const creating = (r: Running) => r.yard.tasks.poolLimits().boxesCreating
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** Finish `n` waiting creates, one at a time, letting each finished one run its scheduling pass. */
async function finish(r: Running, n: number) {
  for (let i = 0; i < n; i++) {
    await waitFor(() => r.provider.pending > 0, "a waiting create")
    r.provider.finish()
    await pause(20)
  }
}

describe("parallel box creation", () => {
  it("creates boxes several at a time up to the cap, never past Max boxes", async () => {
    const r = await start({ maxBoxes: 5, boxCreateConcurrency: 3 })
    const p = r.yard.store.createProject({ name: "town" })
    queue(r, p.id, 8)

    await waitFor(() => r.provider.pending === 3, "3 creates at once")
    await pause(300)
    expect(r.provider.starts).toHaveLength(3)
    expect(r.yard.store.listBoxes().map((b) => b.status)).toEqual(["creating", "creating", "creating"])
    expect(creating(r)).toMatchObject({ now: 3, atOnce: 3 })

    // Each box that comes up makes room for the next create, until the pool is at Max boxes.
    await finish(r, 1)
    await waitFor(() => r.provider.starts.length === 4, "a 4th create")
    await finish(r, 4)
    await waitFor(() => working(r) === 5, "5 agents")
    await pause(300)
    expect(r.provider.starts).toHaveLength(5)
    expect(r.provider.peak).toBe(3)
    expect(r.yard.store.listBoxes()).toHaveLength(5)
    const queued = r.yard.store.listTasks().filter((t) => t.status === "queued")
    expect(queued).toHaveLength(3)
    for (const t of queued) expect(t.waitReason).toBe("Waiting for a free slot: every box is full and the pool is at its limit")

    // Every new box is in the box history, with who made it and why.
    const created = r.yard.tasks.history.list().filter((e) => e.type === "created")
    expect(created).toHaveLength(5)
    for (const e of created) expect(e).toMatchObject({ actor: "scheduler", reason: "Project town needed a box for its tasks." })
  })

  it("creates only the boxes the queue needs, counting the ones on their way", async () => {
    const r = await start({ maxBoxes: 10, slotsPerBox: 2, boxCreateConcurrency: 10 })
    const p = r.yard.store.createProject({ name: "town" })
    queue(r, p.id, 3)
    await waitFor(() => r.provider.pending === 2, "2 creates for 3 tasks")
    await pause(300)
    expect(r.provider.starts).toHaveLength(2)

    // Two more tasks while those are on their way: five tasks need three boxes, so one more.
    queue(r, p.id, 2, "More")
    await waitFor(() => r.provider.pending === 3, "a 3rd create")
    await pause(300)
    expect(r.provider.starts).toHaveLength(3)

    await finish(r, 3)
    await waitFor(() => working(r) === 5, "5 agents")
    await pause(300)
    expect(r.provider.starts).toHaveLength(3)
    expect(r.yard.store.listBoxes()).toHaveLength(3)
  })

  it("backs off briefly after a failed create, and the others go on", async () => {
    const r = await start({ maxBoxes: 10, boxCreateConcurrency: 3 }, { retryBaseMs: 1000 })
    const p = r.yard.store.createProject({ name: "town" })
    queue(r, p.id, 3)
    await waitFor(() => r.provider.pending === 3, "3 creates")

    const failedAt = Date.now()
    r.provider.finish(new Error("boom"))
    await waitFor(() => creating(r).backoff, "the backoff")
    expect(creating(r).backoff).toMatch(/^the next create waits 1s after 1 failure: Couldn't create a worker box: boom$/)
    const notice = r.yard.store.db.prepare("SELECT content FROM chat_messages WHERE role = 'notice' ORDER BY id DESC LIMIT 1").get() as { content: string }
    expect(notice.content).toBe("⚠️ Couldn't create a worker box: boom. Retrying in 1s.")

    // The two other creates aren't held up.
    await finish(r, 2)
    await waitFor(() => working(r) === 2, "2 agents")
    expect(r.provider.starts).toHaveLength(3)

    // After the backoff (about a second, not the minute it used to be) the third task gets its box.
    await waitFor(() => r.provider.starts.length === 4, "the retry", 5000)
    expect(r.provider.starts[3]!.at - failedAt).toBeGreaterThanOrEqual(850)
    expect(r.provider.starts[3]!.at - failedAt).toBeLessThan(2500)
    await finish(r, 1)
    await waitFor(() => working(r) === 3, "3 agents")
    expect(creating(r).backoff).toBeUndefined()
    expect(r.provider.starts).toHaveLength(4)
  })

  it("creates fewer at once after a rate limit, and grows back as boxes come up", async () => {
    const r = await start({ maxBoxes: 10, boxCreateConcurrency: 4 }, { retryBaseMs: 100, rateLimitMs: 800 })
    const p = r.yard.store.createProject({ name: "town" })
    queue(r, p.id, 6)
    await waitFor(() => r.provider.pending === 4, "4 creates")

    const limitedAt = Date.now()
    r.provider.finish(Object.assign(new Error("Too many requests"), { statusCode: 429 }))
    await waitFor(() => typeof creating(r).atOnce === "string", "a lowered cap")
    expect(creating(r).atOnce).toBe("2 (lowered after a rate limit; Settings › Boxes created at once is 4)")

    // Past the rate limit's wait, three creates are still on their way: more than two, so none starts yet.
    await pause(Math.max(0, limitedAt + 1100 - Date.now()))
    expect(r.provider.starts).toHaveLength(4)

    // Each box that comes up lets one more run at once, back up to the setting.
    await finish(r, 1)
    await waitFor(() => r.provider.starts.length === 5, "a 5th create")
    expect(creating(r).atOnce).toBe("3 (lowered after a rate limit; Settings › Boxes created at once is 4)")
    await finish(r, 1)
    await waitFor(() => r.provider.starts.length === 7, "the last two creates")
    expect(creating(r).atOnce).toBe(4)
    await finish(r, 4)
    await waitFor(() => working(r) === 6, "6 agents")
    expect(r.provider.starts).toHaveLength(7)
  })

  it("gives the next create to the project with the fewest on their way, at its box size", async () => {
    const r = await start({ maxBoxes: 10, boxCreateConcurrency: 2 })
    const town = r.yard.store.createProject({ name: "town", boxSize: "medium" })
    const docs = r.yard.store.createProject({ name: "docs" })
    queue(r, town.id, 5)
    await waitFor(() => r.provider.pending === 2, "2 creates for town")
    queue(r, docs.id, 1, "Docs")
    await pause(200)
    expect(r.provider.starts).toHaveLength(2)

    // A town box comes up: town still needs boxes, but docs has none on its way, so it goes next.
    await finish(r, 1)
    await waitFor(() => r.provider.starts.length === 3, "a 3rd create")
    const [first, , third] = r.provider.starts
    expect(first!.labels).toContain("p-town")
    expect(first!.size).toBe("medium")
    expect(third!.labels).toContain("p-docs")
    expect(third!.size).toBe(r.yard.settings.get().workerSize)
  })

  it("is set in Settings › Boxes & limits", async () => {
    const r = await start({ maxBoxes: 10, boxCreateConcurrency: 10 })
    expect(r.yard.settings.get().boxCreateConcurrency).toBe(10)
    r.yard.settings.update({ boxCreateConcurrency: 2 })
    expect(() => r.yard.settings.update({ boxCreateConcurrency: 0 })).toThrow()
    expect(() => r.yard.settings.update({ boxCreateConcurrency: 51 })).toThrow()
    const p = r.yard.store.createProject({ name: "town" })
    queue(r, p.id, 4)
    await waitFor(() => r.provider.pending === 2, "2 creates")
    await pause(300)
    expect(r.provider.starts).toHaveLength(2)
  })
})
