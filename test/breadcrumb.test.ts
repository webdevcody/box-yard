import { describe, expect, it, vi } from "vitest"
import { copyIdOnClick, lastProjectTab, projectCrumbHref, projectTabKey, rememberProjectTab } from "../web/src/lib/breadcrumb"

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

function click(extra: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true), ...extra }
  return e
}

describe("project crumb", () => {
  it("links to the project page, with ?tab= only off the default tab", () => {
    expect(projectCrumbHref("prj_demo01")).toBe("/projects/prj_demo01")
    expect(projectCrumbHref("prj_demo01", "tasks")).toBe("/projects/prj_demo01")
    expect(projectCrumbHref("prj_demo01", "files")).toBe("/projects/prj_demo01?tab=files")
  })

  it("returns to the tab used last, per project", () => {
    const s = memory()
    expect(lastProjectTab("prj_a", s)).toBe("tasks")
    rememberProjectTab("prj_a", "notes", s)
    rememberProjectTab("prj_b", "captain", s)
    expect(lastProjectTab("prj_a", s)).toBe("notes")
    expect(projectCrumbHref("prj_b", lastProjectTab("prj_b", s))).toBe("/projects/prj_b?tab=captain")
    // Back on Tasks: the key is cleared rather than stored.
    rememberProjectTab("prj_a", "tasks", s)
    expect(s.m.has(projectTabKey("prj_a"))).toBe(false)
    expect(lastProjectTab("prj_a", s)).toBe("tasks")
  })

  it("ignores unknown or broken stored tabs", () => {
    const s = memory()
    s.setItem(projectTabKey("prj_a"), "nope")
    expect(lastProjectTab("prj_a", s)).toBe("tasks")
    rememberProjectTab("prj_a", "bogus", s)
    expect(s.m.has(projectTabKey("prj_a"))).toBe(false)
    const throwing = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("full") }, removeItem: () => {} }
    expect(lastProjectTab("prj_a", throwing)).toBe("tasks")
    expect(() => rememberProjectTab("prj_a", "files", throwing)).not.toThrow()
  })
})

describe("task id crumb", () => {
  it("copies the id on a plain click and cancels the navigation", async () => {
    const writeText = vi.fn(async () => {})
    const e = click()
    expect(await copyIdOnClick(e, "task_148794a23ab9", { writeText })).toBe("copied")
    expect(writeText).toHaveBeenCalledWith("task_148794a23ab9")
    expect(e.defaultPrevented).toBe(true)
  })

  it("leaves Cmd/Ctrl, Shift and middle clicks to the link", async () => {
    const writeText = vi.fn(async () => {})
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const e = click(extra)
      expect(await copyIdOnClick(e, "task_x", { writeText })).toBe("skipped")
      expect(e.defaultPrevented).toBe(false)
    }
    expect(writeText).not.toHaveBeenCalled()
  })

  it("reports a blocked clipboard", async () => {
    expect(await copyIdOnClick(click(), "task_x", { writeText: async () => Promise.reject(new Error("denied")) })).toBe("failed")
    expect(await copyIdOnClick(click(), "task_x", undefined)).toBe("failed")
  })
})
