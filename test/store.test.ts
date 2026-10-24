import { describe, expect, it } from "vitest"
import { openDb, migrate } from "../server/db.js"
import { Store, normalizeRepo, githubSlug, cloneUrl } from "../server/store.js"
import { tmpDir } from "./helpers.js"

const store = () => new Store(openDb(tmpDir()))

describe("repo names", () => {
  it("normalizes the common forms", () => {
    expect(normalizeRepo("webdevcody/box-yard")).toBe("webdevcody/box-yard")
    expect(normalizeRepo("https://github.com/webdevcody/box-yard.git")).toBe("webdevcody/box-yard")
    expect(normalizeRepo("github.com/webdevcody/box-yard/")).toBe("webdevcody/box-yard")
    expect(normalizeRepo("  ")).toBeNull()
    expect(normalizeRepo(null)).toBeNull()
    expect(normalizeRepo("git@gitlab.com:me/x.git")).toBe("git@gitlab.com:me/x")
    expect(() => normalizeRepo("not a repo")).toThrow(/Can't read repo/)
  })
  it("builds clone URLs and slugs", () => {
    expect(cloneUrl("a/b")).toBe("https://github.com/a/b.git")
    expect(githubSlug("a/b")).toBe("a/b")
    expect(githubSlug("https://github.com/a/b.git")).toBe("a/b")
    expect(githubSlug("git@github.com:a/b.git")).toBe("a/b")
    expect(githubSlug(null)).toBeNull()
  })
})

describe("store", () => {
  it("migrations are idempotent", () => {
    const db = openDb(tmpDir())
    migrate(db)
    migrate(db)
    const v = db.prepare("SELECT MAX(version) v FROM _migrations").get() as { v: number }
    expect(v.v).toBeGreaterThan(0)
  })

  it("keeps env values server-side and only exposes names", () => {
    const s = store()
    const p = s.createProject({ name: "site", repo: "a/b", env: { SECRET: "shh" } })
    expect(p.envKeys).toEqual(["SECRET"])
    expect(JSON.stringify(p)).not.toContain("shh")
    expect(s.projectEnv(p.id)).toEqual({ SECRET: "shh" })
    const updated = s.updateProject(p.id, { env: { OTHER: "1" }, removeEnv: ["SECRET"] })
    expect(updated.envKeys).toEqual(["OTHER"])
  })

  it("finds projects by id or name, case-insensitively, and rejects duplicate names", () => {
    const s = store()
    const p = s.createProject({ name: "Docs" })
    expect(s.findProject("docs")?.id).toBe(p.id)
    expect(s.findProject(p.id)?.name).toBe("Docs")
    expect(() => s.createProject({ name: "docs" })).toThrow()
  })

  it("queues inputs in order and delivers only the ones a turn claimed", () => {
    const s = store()
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    s.queueInput(t.id, "cody", "one", [], { message: { source: "cody" } })
    s.queueInput(t.id, "agent:task_x", "two")
    const first = s.claimInputs(t.id, "turn-1")
    expect(first.map((i) => i.content)).toEqual(["one", "two"])
    s.queueInput(t.id, "cody", "three")
    // Only Cody's message gets a transcript line; the agent's goes to the prompt only.
    expect(s.deliverInputs("turn-1").map((m) => m.content)).toEqual(["one"])
    expect(s.peekInputs(t.id).map((i) => i.content)).toEqual(["three"])
    expect(s.getTask(t.id)!.pendingCount).toBe(1)
  })

  it("gives a hook's label to the agent only, and never lets an edit or cancel change a claimed input", () => {
    const s = store()
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    const id = s.queueInput(t.id, "hook:hk_1", "merge it", [], { prefix: "From the hook:\n\n", message: { source: "hook" } })
    expect(s.peekInputs(t.id)[0]!.content).toBe("From the hook:\n\nmerge it")
    expect(s.editInput(t.id, id, "merge it now", 1)).toMatchObject({ ok: true, row: { content: "merge it now", version: 2 } })
    expect(s.editInput(t.id, id, "stale", 1)).toMatchObject({ ok: false, row: { content: "merge it now" } })
    const rev = s.getTask(t.id)!.queueRev
    s.claimInputs(t.id, "turn-1")
    expect(s.getTask(t.id)!.queueRev).not.toBe(rev)
    expect(s.editInput(t.id, id, "late")).toMatchObject({ ok: false, row: { status: "delivering" } })
    expect(s.cancelInput(t.id, id)).toMatchObject({ ok: false, row: { status: "delivering" } })
    expect(s.deliverInputs("turn-1")).toMatchObject([{ content: "merge it now", meta: { source: "hook" } }])
    expect(s.editInput(t.id, id, "gone")).toEqual({ ok: false, row: null })
    expect(s.getTask(t.id)).toMatchObject({ pendingCount: 0, queueRev: "" })
  })

  it("keeps a cancelled input out of the queue but restorable, and drops it once Undo is over", () => {
    const s = store()
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    const a = s.queueInput(t.id, "cody", "a")
    s.queueInput(t.id, "cody", "b")
    expect(s.cancelInput(t.id, a).ok).toBe(true)
    expect(s.listQueuedInputs(t.id).map((i) => i.content)).toEqual(["b"])
    expect(s.getTask(t.id)!.pendingCount).toBe(1)
    expect(s.cancelInput(t.id, a).ok).toBe(false)
    expect(s.restoreInput(t.id, a).ok).toBe(true)
    expect(s.listQueuedInputs(t.id).map((i) => i.content)).toEqual(["a", "b"])
    s.cancelInput(t.id, a)
    // Long cancelled: the next claim clears it for good.
    s.db.prepare("UPDATE task_inputs SET updated_at = 0 WHERE id = ?").run(a)
    expect(s.claimInputs(t.id, "turn-1").map((i) => i.content)).toEqual(["b"])
    expect(s.restoreInput(t.id, a)).toEqual({ ok: false, row: null })
  })

  it("marks notices unseen until the orchestrator takes them", () => {
    const s = store()
    s.addChat("user", "hi")
    s.addChat("notice", "task A needs you")
    expect(s.takeUnseenNotices()).toEqual(["task A needs you"])
    expect(s.takeUnseenNotices()).toEqual([])
  })

  it("lists transcript messages in insertion order even within one millisecond", () => {
    const s = store()
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    for (let i = 0; i < 20; i++) s.addTaskMessage(t.id, "assistant", `m${i}`)
    expect(s.listTaskMessages(t.id).map((m) => m.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`))
    expect(s.listTaskMessages(t.id, 5).map((m) => m.content)).toEqual(["m15", "m16", "m17", "m18", "m19"])
  })
})
