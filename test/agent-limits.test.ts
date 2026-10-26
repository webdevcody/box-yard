import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate } from "../server/db.js"
import { Store } from "../server/store.js"
import { agentRefs, boxBlockReason, limitBlock, localBlockReason, type BoxAgent } from "../server/agentLimits.js"

// The projects' own limits on a box or this computer (server/agentLimits.ts). Cody: "I'd only expect survive the night
// to limit other agents in that same project, not ALL projects". Agents per box caps a project's own agents; only
// Needs the whole machine (off by default) holds back other projects'.

let n = 0
const agent = (projectName: string, over: Partial<BoxAgent> = {}): BoxAgent => ({
  taskId: `task_${++n}`,
  title: `${projectName} ${n}`,
  projectId: `prj_${projectName}`,
  projectName,
  agentsPerBox: null,
  wholeMachine: false,
  ...over,
})

describe("limitBlock", () => {
  it("holds back only the project's own agents at its Agents per box", () => {
    const heavy = (title: string) => agent("survive-the-night", { title, agentsPerBox: 1 })
    const merge = heavy("Merge PR #78")
    // Another project's task runs beside it.
    expect(limitBlock(agent("box-yard"), [merge])).toBeNull()
    expect(limitBlock(agent("box-yard", { agentsPerBox: 1 }), [merge])).toBeNull()
    // Its own second agent waits.
    const second = heavy("Perf lane 1")
    const block = limitBlock(second, [merge, agent("box-yard")])
    expect(block).toEqual({ kind: "own", cap: 1, by: [merge] })
    expect(localBlockReason(second, block!)).toBe("survive-the-night allows 1 of its agents at a time on this computer; waiting for Merge PR #78")
    expect(boxBlockReason(second, block!, "box box-1")).toBe("survive-the-night allows 1 of its agents at a time on a box, and Merge PR #78 is running on box box-1")
    // Below its limit it runs.
    expect(limitBlock(agent("survive-the-night", { agentsPerBox: 2 }), [merge])).toBeNull()
  })

  it("keeps other projects' agents off while one that needs the whole machine runs, and makes it wait for theirs", () => {
    const bench = agent("bench", { title: "Frame-time run", wholeMachine: true })
    const light = agent("notes", { title: "Tidy notes" })
    const held = limitBlock(light, [bench])
    expect(held).toMatchObject({ kind: "whole", project: { projectName: "bench" }, by: [bench] })
    expect(localBlockReason(light, held!)).toBe("bench needs the whole machine; waiting for Frame-time run on this computer")
    // Its own agents aren't held back by it (only by its Agents per box).
    expect(limitBlock(agent("bench", { wholeMachine: true }), [bench])).toBeNull()
    expect(limitBlock(agent("bench", { wholeMachine: true, agentsPerBox: 1 }), [bench])?.kind).toBe("own")
    // The other way round: it waits for the other projects' agents.
    const next = agent("bench", { title: "Next run", wholeMachine: true })
    const waits = limitBlock(next, [light])
    expect(waits).toMatchObject({ kind: "whole", project: { projectName: "bench" }, by: [light] })
    expect(boxBlockReason(next, waits!, "GPU pod #2")).toBe("bench needs the whole machine, and Tidy notes (notes) is running on GPU pod #2")
    // Nothing runs: it starts.
    expect(limitBlock(next, [])).toBeNull()
  })

  it("names the first two blocking tasks, then how many more", () => {
    const [a, b, c] = [agent("p", { title: "A" }), agent("q", { title: "B" }), agent("q", { title: "C" })]
    expect(agentRefs([a])).toBe("A (p)")
    expect(agentRefs([a], "p")).toBe("A")
    expect(agentRefs([a, b], "p")).toBe("A and B (q)")
    expect(agentRefs([a, b, c])).toBe("A (p), B (q) and 1 more")
  })
})

describe("whole_machine and wait_for_json migration", () => {
  it("adds Needs the whole machine off for every project, Agents per box 1 included, and no wait links", () => {
    const db = new Database(":memory:")
    try {
      const at = MIGRATIONS.findIndex((m) => m.includes("whole_machine"))
      migrate(db, at)
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at, agents_per_box) VALUES ('prj_heavy1', 'survive-the-night', 1, 1, 1)").run()
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at, heavy_tasks) VALUES ('prj_whole1', 'old', 1, 1, 'whole-box')").run()
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_light1', 'box-yard', 1, 1)").run()
      migrate(db)
      const store = new Store(db)
      for (const id of ["prj_heavy1", "prj_whole1", "prj_light1"]) {
        expect(store.getProject(id)!.wholeMachine, id).toBe(false)
        expect(store.projectBoxLimits(id).wholeMachine, id).toBe(false)
      }
      expect(store.getProject("prj_heavy1")!.agentsPerBox).toBe(1)
      // A queued task names nothing until a reason does; a reason's tasks round-trip, and clearing the reason clears them.
      const t = store.createTask({ projectId: "prj_light1", title: "t", prompt: "x" })
      expect(store.getTask(t.id)!.waitFor).toEqual([])
      store.updateTask(t.id, { status: "queued", waitReason: "waiting for A", waitFor: [{ taskId: "task_a00001", title: "A" }] })
      expect(store.getTask(t.id)!.waitFor).toEqual([{ taskId: "task_a00001", title: "A" }])
      store.updateTask(t.id, { waitReason: null, waitFor: [] })
      expect(store.getTaskRow(t.id)!.wait_for_json).toBeNull()
      expect(store.getTask(t.id)!.waitFor).toEqual([])
    } finally {
      db.close()
    }
  })
})
