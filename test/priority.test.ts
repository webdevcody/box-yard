import { describe, expect, it } from "vitest"
import { parsePriority, queueOrder, type QueueEntry } from "../shared/priority.js"
import { migrate, MIGRATIONS, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import Database from "better-sqlite3"
import { tmpDir } from "./helpers.js"

// Task priority's queue order (shared/priority.ts), which the scheduler and the queue lists share, and how the
// store keeps it. test/priority.e2e.test.ts runs it through the scheduler.

const order = (entries: (QueueEntry & { id: string })[]) => [...entries].sort(queueOrder).map((e) => e.id)

describe("queueOrder", () => {
  it("keeps first in, first out within a priority", () => {
    expect(order([{ id: "c", queuedAt: 3 }, { id: "a", queuedAt: 1 }, { id: "b", queuedAt: 2 }])).toEqual(["a", "b", "c"])
    expect(order([{ id: "y", priority: "high", queuedAt: 20 }, { id: "x", priority: "high", queuedAt: 10 }])).toEqual(["x", "y"])
  })

  it("puts high before normal, however long the normal ones have waited", () => {
    expect(
      order([
        { id: "n1", priority: "normal", queuedAt: 1 },
        { id: "h2", priority: "high", queuedAt: 40 },
        { id: "n2", queuedAt: 2 },
        { id: "h1", priority: "high", queuedAt: 30 },
        { id: "n3", priority: null, queuedAt: 3 },
      ]),
    ).toEqual(["h1", "h2", "n1", "n2", "n3"])
  })

  it("reads anything but \"high\" as normal", () => {
    expect(parsePriority("high")).toBe("high")
    for (const v of ["normal", null, undefined, "", "HIGH", 1]) expect(parsePriority(v)).toBe("normal")
  })
})

describe("Store: task priority", () => {
  it("defaults to normal, is set at create or later, and stores normal as NULL", () => {
    const store = new Store(openDb(tmpDir()))
    const p = store.createProject({ name: "p" })
    const n = store.createTask({ projectId: p.id, title: "n", prompt: "x" })
    const h = store.createTask({ projectId: p.id, title: "h", prompt: "x", priority: "high" })
    expect(n.priority).toBe("normal")
    expect(h.priority).toBe("high")
    expect(store.updateTask(n.id, { priority: "high" }).priority).toBe("high")
    expect(store.updateTask(h.id, { priority: "normal" }).priority).toBe("normal")
    expect(store.getTaskRow(h.id)!.priority).toBeNull()
    expect(n.lastActiveAt).toBe(store.getTaskRow(n.id)!.last_active_at)
  })

  it("reads tasks from before the column as normal", () => {
    const db = new Database(":memory:")
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN priority")))
    const store = new Store(db)
    const p = store.createProject({ name: "p" })
    const t = store.createTask({ projectId: p.id, title: "t", prompt: "x" })
    migrate(db)
    expect(store.getTask(t.id)!.priority).toBe("normal")
    db.prepare("UPDATE tasks SET priority = 'bogus' WHERE id = ?").run(t.id)
    expect(store.getTask(t.id)!.priority).toBe("normal")
  })
})
