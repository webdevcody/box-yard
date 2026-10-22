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

  it("queues inputs in order and deletes only the ones taken", () => {
    const s = store()
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    s.queueInput(t.id, "cody", "one")
    s.queueInput(t.id, "agent:task_x", "two")
    const first = s.peekInputs(t.id)
    expect(first.map((i) => i.content)).toEqual(["one", "two"])
    s.queueInput(t.id, "cody", "three")
    s.deleteInputs(first.map((i) => i.id))
    expect(s.peekInputs(t.id).map((i) => i.content)).toEqual(["three"])
    expect(s.getTask(t.id)!.pendingCount).toBe(1)
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
