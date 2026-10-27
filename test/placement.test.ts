// Where a task actually runs (shared/placement.ts): the wording cards, the task header and the MCP tools share,
// and the server's Task.placement (now, last, runner and who chose it).
import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { placeKindOf, placeLabel, placeShort, placementLine, placementView, type Place, type TaskPlacement } from "../shared/placement.js"
import { tmpDir } from "./helpers.js"

const upstash: Place = { kind: "box", boxId: "pure-lobster", provider: "upstash", size: "small" }
const pod: Place = { kind: "gpu", boxId: "runpod-prj_demo01", gpu: "RTX A5000", podId: "3x9k2aqz7wplm1" }
const local: Place = { kind: "local", boxId: "this-computer" }
const docker: Place = { kind: "docker", boxId: "docker-task_x1", container: "boxyard-task_x1" }

const placed = (over: Partial<TaskPlacement> = {}): TaskPlacement => ({ now: null, last: null, runner: "box", chosenBy: "project", projectRunner: "box", ...over })
const task = (placement: TaskPlacement, status = "working", lastArchivedAt: number | null = null) => ({ placement, status, boxId: placement.now?.boxId ?? null, lastArchivedAt })

describe("placement labels", () => {
  it("names each runner: full on the task page, compact on cards", () => {
    expect(placeLabel(local)).toBe("This computer")
    expect(placeLabel(upstash)).toBe("Upstash · pure-lobster · small")
    expect(placeLabel(pod)).toBe("RunPod · RTX A5000 · pod 3x9k2a")
    expect(placeLabel(docker)).toBe("Docker · boxyard-task_x1")
    expect([local, upstash, pod, docker].map(placeShort)).toEqual(["This computer", "Upstash · small", "RunPod · RTX A5000", "Docker · boxyard-task_x1"])
  })

  it("falls back sensibly before the server knows the details", () => {
    // A pod this process hasn't seen yet (after a restart): its index stands in for the pod id.
    expect(placeLabel({ kind: "gpu", boxId: "runpod-prj_demo01-2" })).toBe("RunPod · pod #2")
    expect(placeShort({ kind: "gpu", boxId: "runpod-prj_demo01-2" })).toBe("RunPod · pod #2")
    // Mock mode's folder boxes aren't Upstash.
    expect(placeLabel({ kind: "box", boxId: "local-1a2b", provider: "local", size: "medium" })).toBe("Local box · local-1a2b · medium")
    expect(placeKindOf("this-computer")).toBe("local")
    expect(placeKindOf("runpod-prj_demo01-3")).toBe("gpu")
    expect(placeKindOf("pure-lobster")).toBe("box")
  })

  it("shows where it is now, with the setting that chose it", () => {
    const v = placementView(task(placed({ now: upstash })))
    expect(v).toMatchObject({ state: "here", kind: "box", label: "Upstash · pure-lobster · small", pinned: false, chosenBy: "project", reason: null })
    expect(v.setting).toBe("Project's Runs on: an Upstash box")
    const g = placementView(task(placed({ now: pod, runner: "gpu", projectRunner: "gpu" })))
    expect(g).toMatchObject({ state: "here", kind: "gpu", short: "RunPod · RTX A5000" })
  })

  it("shows where a queued or starting task will go, muted, and never its old box", () => {
    for (const status of ["queued", "starting"]) {
      const v = placementView(task(placed({ runner: "local", projectRunner: "local", last: { ...upstash, leftAt: 1 } }), status, 1))
      expect(v).toMatchObject({ state: "next", kind: "local", label: "→ This computer", short: "→ This computer" })
      expect(v.reason).toContain("this computer")
    }
  })

  it("shows the last place a resting, archived task ran, with an archived hint", () => {
    const v = placementView(task(placed({ last: { ...upstash, leftAt: 1 } }), "idle", 1))
    expect(v).toMatchObject({ state: "last", kind: "box", label: "Upstash · pure-lobster · small · archived", short: "Upstash · small · archived" })
    expect(v.place?.boxId).toBe("pure-lobster")
    // Archived before Box Yard remembered the box: the runner, archived.
    expect(placementView(task(placed(), "done", 1))).toMatchObject({ state: "last", label: "Upstash · archived", place: null })
  })

  it("marks a task pinned only when its own runs_on differs from its project's", () => {
    expect(placementView(task(placed({ now: local, runner: "local", chosenBy: "task", projectRunner: "box" }))).pinned).toBe(true)
    // Its own runs_on, but the same as the project's: chosen by the task, not pinned off anything.
    const same = placementView(task(placed({ now: local, runner: "local", chosenBy: "task", projectRunner: "local" })))
    expect(same).toMatchObject({ pinned: false, chosenBy: "task", setting: "This task's Runs on: this computer" })
    expect(placementView(task(placed({ now: upstash }))).pinned).toBe(false)
  })

  it("says why when the workspace hasn't moved to its runner yet", () => {
    const v = placementView(task(placed({ now: upstash, runner: "local", chosenBy: "task", projectRunner: "box" })))
    expect(v).toMatchObject({ state: "here", kind: "box", pinned: true })
    expect(v.reason).toMatch(/set to run on this computer, but its workspace is still here/)
  })

  it("works from boxId and runs_on when the server sent no placement", () => {
    const t = { status: "queued", boxId: null, runsOn: null, lastArchivedAt: null }
    expect(placementView(t, "local").label).toBe("→ This computer")
    expect(placementView({ ...t, runsOn: "local" as const }, "box")).toMatchObject({ label: "→ This computer", pinned: true })
    expect(placementView({ ...t, status: "working", boxId: "this-computer" })).toMatchObject({ state: "here", kind: "local" })
  })

  it("reads as one line in the MCP task tools", () => {
    expect(placementLine(task(placed({ now: upstash })))).toBe("Upstash · pure-lobster · small (project's Runs on)")
    expect(placementLine(task(placed({ runner: "local", chosenBy: "task" }), "queued"))).toBe("not placed yet → This computer (pinned by this task's runs_on)")
  })
})

describe("Task.placement from the store", () => {
  it("fills the box's size and provider, remembers the last place when the box lets go, and adds pod details", () => {
    const store = new Store(openDb(tmpDir(), ":memory:"))
    const project = store.createProject({ name: "demo", description: "", repo: null })
    const now = Date.now()
    store.upsertBox({ id: "pure-lobster", provider: "upstash", status: "ready", created_at: now, last_used_at: now, size: "medium" })
    const t = store.createTask({ projectId: project.id, title: "x", prompt: "y", runsOn: "box" })
    expect(t.placement).toEqual({ now: null, last: null, runner: "box", chosenBy: "task", projectRunner: "box" })

    expect(store.updateTask(t.id, { boxId: "pure-lobster", status: "working" }).placement?.now).toEqual({ kind: "box", boxId: "pure-lobster", provider: "upstash", size: "medium" })
    const rested = store.updateTask(t.id, { boxId: null, status: "idle", lastArchivedAt: now })
    expect(rested.placement?.now).toBeNull()
    expect(rested.placement?.last).toMatchObject({ kind: "box", boxId: "pure-lobster", size: "medium" })
    expect(placementView(rested).label).toBe("Upstash · pure-lobster · medium · archived")
    // A later release with no box keeps the remembered place.
    expect(store.updateTask(t.id, { boxId: null }).placement?.last?.boxId).toBe("pure-lobster")

    store.placeExtra = (id) => (id.startsWith("runpod-") ? { gpu: "RTX A5000", podId: "3x9k2aqz7wplm1" } : null)
    store.updateProject(project.id, { runner: "gpu" })
    const g = store.updateTask(t.id, { boxId: `runpod-${project.id}`, runsOn: null })
    expect(g.placement).toMatchObject({ runner: "gpu", chosenBy: "project", projectRunner: "gpu" })
    expect(placementView(g).label).toBe("RunPod · RTX A5000 · pod 3x9k2a")
  })
})
