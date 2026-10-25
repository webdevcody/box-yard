import { describe, expect, it } from "vitest"
import { CHAT_MAX, CHAT_MIN, MAIN_MIN, coordinatorDock } from "../web/src/lib/layout"

// The Coordinator panel docks (resizable) whenever the page still fits beside it, not only from Tailwind's xl.
// At 125% zoom a 1440 px laptop is 1152 CSS px and a 1512 px one is about 1210; both used to get the drawer.
describe("coordinatorDock", () => {
  const SIDEBAR = 256

  it("keeps the saved width when there's room", () => {
    expect(coordinatorDock(1440, SIDEBAR, 416)).toEqual({ docked: true, width: 416, max: CHAT_MAX })
    expect(coordinatorDock(1920, SIDEBAR, 600)).toMatchObject({ docked: true, width: 600, max: CHAT_MAX })
  })

  it("stays docked at 125% zoom on a laptop, shrinking the panel to leave the page MAIN_MIN", () => {
    for (const viewport of [1152, 1210]) {
      const dock = coordinatorDock(viewport, SIDEBAR, 416)
      expect(dock.docked).toBe(true)
      expect(viewport - SIDEBAR - dock.width).toBeGreaterThanOrEqual(MAIN_MIN)
      expect(dock.width).toBeGreaterThanOrEqual(CHAT_MIN)
    }
  })

  it("is a drawer when the page can't fit beside the narrowest panel, or the sidebar is a drawer", () => {
    expect(coordinatorDock(SIDEBAR + CHAT_MIN + MAIN_MIN - 1, SIDEBAR, 416).docked).toBe(false)
    expect(coordinatorDock(SIDEBAR + CHAT_MIN + MAIN_MIN, SIDEBAR, 416)).toMatchObject({ docked: true, width: CHAT_MIN })
    expect(coordinatorDock(1100, SIDEBAR, 416).docked).toBe(false)
    expect(coordinatorDock(1023, 0, 416).docked).toBe(false)
    expect(coordinatorDock(390, SIDEBAR, 416).docked).toBe(false)
  })

  it("never renders below CHAT_MIN or above CHAT_MAX", () => {
    expect(coordinatorDock(2560, SIDEBAR, 900).width).toBe(CHAT_MAX)
    expect(coordinatorDock(2560, SIDEBAR, 100).width).toBe(CHAT_MIN)
  })
})
