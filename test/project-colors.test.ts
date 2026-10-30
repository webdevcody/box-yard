import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { PROJECT_COLORS, projectColors } from "../shared/projectColors.js"
import { defaultTaskIcon, isTaskIcon, TASK_ICONS, taskIcon } from "../shared/taskIcons.js"
import { tmpDir } from "./helpers.js"

// Project colours and task icons: a project keeps its colour as others are added, the defaults stay distinct while
// the palette lasts, and a task's icon comes from create_task, else its title, else its id.

const project = (id: string, name: string, createdAt: number, color: string | null = null) => ({ id, name, createdAt, color })

describe("projectColors", () => {
  it("gives every project a colour, distinct while the palette lasts", () => {
    const list = PROJECT_COLORS.map((_, i) => project(`p${i}`, `Project ${i}`, i))
    const colors = projectColors(list)
    expect(colors.size).toBe(PROJECT_COLORS.length)
    expect(new Set(colors.values()).size).toBe(PROJECT_COLORS.length)
  })

  it("never changes an older project's colour when a newer one is added", () => {
    const old = [project("a", "box-yard", 1), project("b", "Map 3", 2), project("c", "Pricing", 3)]
    const before = projectColors(old)
    const after = projectColors([...old, project("d", "box-yard 2", 4), project("e", "Notes", 5)])
    for (const p of old) expect(after.get(p.id)).toBe(before.get(p.id))
  })

  it("keeps a project's own colour and steers the others off it", () => {
    const auto = projectColors([project("a", "box-yard", 1)]).get("a")!
    const colors = projectColors([project("a", "box-yard", 1), project("b", "Map 3", 2, auto)])
    expect(colors.get("b")).toBe(auto)
    expect(colors.get("a")).not.toBe(auto)
  })

  it("ignores a colour it doesn't know", () => {
    expect(PROJECT_COLORS).toContain(projectColors([project("a", "x", 1, "chartreuse")]).get("a"))
  })

  it("shares colours once every one is taken, and stays stable", () => {
    const list = Array.from({ length: 20 }, (_, i) => project(`p${i}`, `Project ${i}`, i))
    const a = projectColors(list)
    const b = projectColors([...list].reverse())
    expect(a.size).toBe(20)
    for (const p of list) expect(b.get(p.id)).toBe(a.get(p.id))
  })
})

describe("taskIcon", () => {
  it("picks an icon from the title's words", () => {
    expect(defaultTaskIcon({ id: "t1", title: "Fix the flaky login test" })).toBe("bug")
    expect(defaultTaskIcon({ id: "t1", title: "Screenshot every layout" })).toBe("camera")
    expect(defaultTaskIcon({ id: "t1", title: "Map 3: level 7 terrain" })).toBe("map")
    expect(defaultTaskIcon({ id: "t1", title: "Deploy the release" })).toBe("rocket")
  })

  it("falls back to a shape from the id, the same every time", () => {
    const a = defaultTaskIcon({ id: "task_abc123", title: "Zorp the flibber" })
    expect(isTaskIcon(a)).toBe(true)
    expect(defaultTaskIcon({ id: "task_abc123", title: "Zorp the flibber" })).toBe(a)
  })

  it("uses the task's own icon when it has a known one", () => {
    expect(taskIcon({ id: "t1", title: "Fix the bug", icon: "rocket" })).toBe("rocket")
    expect(taskIcon({ id: "t1", title: "Fix the bug", icon: "not-an-icon" })).toBe("bug")
    expect(taskIcon({ id: "t1", title: "Fix the bug", icon: null })).toBe("bug")
  })

  it("only ever returns icons in the list", () => {
    for (const title of ["", "a", "Write the README", "Pricing page", "Box Yard: zen mode", "🙂"])
      expect(TASK_ICONS).toContain(defaultTaskIcon({ id: `task_${title}`, title }))
  })
})

describe("store", () => {
  const store = () => new Store(openDb(tmpDir(), ":memory:"))

  it("saves a project's colour, and null clears it", () => {
    const s = store()
    const p = s.createProject({ name: "demo", color: "teal" })
    expect(p.color).toBe("teal")
    expect(s.updateProject(p.id, { color: "rose" }).color).toBe("rose")
    expect(s.updateProject(p.id, { name: "demo 2" }).color).toBe("rose")
    expect(s.updateProject(p.id, { color: null }).color).toBeNull()
  })

  it("saves a task's icon", () => {
    const s = store()
    const p = s.createProject({ name: "demo" })
    expect(s.createTask({ projectId: p.id, title: "Fix it", prompt: "x", icon: "rocket" }).icon).toBe("rocket")
    const t = s.createTask({ projectId: p.id, title: "Plain", prompt: "x" })
    expect(t.icon).toBeNull()
    s.setTaskIcon(t.id, "moon")
    expect(s.getTask(t.id)!.icon).toBe("moon")
  })
})
