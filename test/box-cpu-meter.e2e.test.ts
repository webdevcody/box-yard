import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { ExecResult } from "../server/providers/types.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A box's cost is the CPU it used (Upstash bills active CPU core-hours), read from the box's own cgroup counter by the
// box probe. Store-level pricing is in box-cost.test.ts.

const GB = 1024 ** 3
const H = 3_600_000

/** Local boxes whose df probe reports a pretend cgroup with a CPU counter (`cpu` µs), each box its own cgroup or not. */
class CpuBoxes extends LocalProvider {
  cpu = new Map<string, number>()
  constructor(
    dir: string,
    readonly ownCgroup: boolean,
  ) {
    super(dir, FAKE_CLAUDE)
  }
  override async exec(boxId: string, command: string): Promise<ExecResult> {
    if (!command.startsWith("df -Pk")) return super.exec(boxId, command)
    const stdout = [
      `fakefs 52428800 0 52428800 1% ${this.root(boxId)}`,
      "@@boxyard-mem",
      `memory.current ${GB}`,
      `memory.max ${4 * GB}`,
      `usage_usec ${this.cpu.get(boxId) ?? 0}`,
      "cpu.max 200000 100000",
      "loadavg 0.50 0.40 0.30 2/300 4242",
      "nproc 64",
    ].join("\n")
    return { exitCode: 0, stdout, stderr: "" }
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  provider: CpuBoxes
}
const running: Running[] = []

async function start(ownCgroup: boolean, overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const provider = new CpuBoxes(tmpDir("boxes-"), ownCgroup)
  const yard = createBoxYard(testConfig({ port, archiveWorkspaces: false, ...overrides }), { webDir: "/nonexistent", provider })
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
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
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

/** A project with one agent turn that keeps running ([hang]); resolves with the box it runs on. */
async function busyBox(r: Running): Promise<string> {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "cpu" })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "busy", prompt: "keep going [hang]" })
  const row = await waitFor(() => {
    const row = r.yard.store.getTaskRow(t.id)
    return row?.current_turn_id && row.box_id ? row : null
  }, "the turn to run")
  return row.box_id!
}

describe("box CPU metering", () => {
  it("prices the CPU a box's cgroup used, not the time a turn ran", async () => {
    const r = await start(true)
    const boxId = await busyBox(r)
    // A new box: its counter started with it, so all of it counts. 2 cores busy for an hour = 2 CPU hours.
    r.provider.cpu.set(boxId, 2 * H * 1000)
    await r.yard.tasks.probeDisk(boxId, 0)
    await new Promise((res) => setTimeout(res, 1100)) // the meter ticks at most once a second
    const box = r.yard.tasks.boxes().find((b) => b.id === boxId)!
    expect(box.usageSource).toBe("measured")
    expect(box.activeMs).toBeGreaterThanOrEqual(2 * H)
    const rate = r.yard.settings.get().costRates.boxActiveCpuHourlyUsd[box.size]
    expect(box.estimatedCostUsd).toBeCloseTo((box.activeMs / H) * rate, 6)
    expect(box.estimatedCostUsd).toBeGreaterThanOrEqual(2 * rate)
  })

  it("doesn't take a shared cgroup's CPU as one box's (local folders): running time is the estimate", async () => {
    const r = await start(false)
    const boxId = await busyBox(r)
    r.provider.cpu.set(boxId, 2 * H * 1000)
    await r.yard.tasks.probeDisk(boxId, 0)
    await new Promise((res) => setTimeout(res, 1100))
    const box = r.yard.tasks.boxes().find((b) => b.id === boxId)!
    expect(box.usageSource).toBe("estimated")
    expect(box.activeMs).toBeLessThan(H)
    expect(r.yard.store.getBox(boxId)?.cgroup_cpu_usec).toBeNull()
  })
})
