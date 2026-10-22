import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { HEAVY_TASK_ID, seedHeavy } from "../server/mockHeavy.js"
import { tailStart } from "../web/src/lib/tail.js"
import { tmpDir } from "./helpers.js"

describe("heavy mock fixture", () => {
  it("seeds a long chat, a long task thread and many tasks, once", () => {
    const db = openDb(tmpDir())
    const store = new Store(db)
    expect(seedHeavy(db, store)).toBe(true)
    expect(store.listProjects()).toHaveLength(6)
    expect(store.listTasks()).toHaveLength(60)
    expect(store.listChat(5000)).toHaveLength(1200)
    expect(store.listChat(5000).reduce((n, m) => n + m.content.length, 0)).toBeGreaterThan(500_000)
    expect(store.listTaskMessages(HEAVY_TASK_ID, 5000)).toHaveLength(2000)
    // No task is left runnable, so the mock yard doesn't start working on them.
    expect(store.listTasks().filter((t) => ["queued", "starting", "working"].includes(t.status))).toHaveLength(0)
    // A yard with data is left alone.
    expect(seedHeavy(db, store)).toBe(false)
    expect(store.listChat(5000)).toHaveLength(1200)
  })
})

describe("tailStart", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` }))
  it("starts with the newest items", () => {
    expect(tailStart(items, null, 60)).toBe(140)
    expect(tailStart(items.slice(0, 10), null, 60)).toBe(0)
  })
  it("keeps the pinned first item as new ones arrive", () => {
    expect(tailStart([...items, { id: "m200" }], "m140", 60)).toBe(140)
  })
  it("falls back to the newest items when the pinned one is gone", () => {
    expect(tailStart(items.slice(150), "m140", 60)).toBe(0)
    expect(tailStart(items, "gone", 60)).toBe(140)
  })
})
