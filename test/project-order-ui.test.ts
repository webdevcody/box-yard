// @vitest-environment happy-dom
// Sidebar project reordering: Alt+↑/↓ with its screen reader announcement, the optimistic save and its rollback,
// and pointer drags that don't swallow plain or modified clicks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectList } from "../web/src/components/ProjectList.js"
import { keys, useProjects } from "../web/src/lib/queries.js"
import { applyOrder, dropIndex, moveItem, movedAnnouncement, shiftFor } from "../web/src/lib/projectOrder.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (id: string, name: string): Project => ({
  id,
  name,
  description: "",
  repo: null,
  baseBranch: "main",
  envKeys: [],
  notes: [],
  notesMaxCount: null,
  notesMaxTokens: null,
  boxSize: null,
  partialClone: null,
  pushAtTurnEnd: null,
  createdAt: 1,
  updatedAt: 1,
})
const ALPHA = project("prj_alpha1", "alpha")
const BETA = project("prj_beta01", "beta")
const GAMMA = project("prj_gamma1", "gamma")

describe("project order helpers", () => {
  it("applies an id order, keeping unnamed items after the named ones", () => {
    expect(applyOrder([ALPHA, BETA, GAMMA], [GAMMA.id, ALPHA.id]).map((p) => p.name)).toEqual(["gamma", "alpha", "beta"])
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"])
  })

  it("lands a dragged row on the slot its middle is over, and slides only the rows in between", () => {
    expect(dropIndex(0, 14, 30, 4)).toBe(0)
    expect(dropIndex(0, 16, 30, 4)).toBe(1)
    expect(dropIndex(1, -200, 30, 4)).toBe(0)
    expect(dropIndex(1, 500, 30, 4)).toBe(3)
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2))).toEqual([0, -1, -1, 0])
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1))).toEqual([0, 1, 1, 0])
    expect(movedAnnouncement("box-yard", 2, 4)).toBe("Moved box-yard to position 2 of 4")
  })
})

describe("ProjectList", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let server: Project[]
  let refuse: string | null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    window.history.replaceState(null, "", "/")
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    server = [ALPHA, BETA, GAMMA]
    refuse = null
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.projects, server)
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/projects/order") {
        if (refuse) return new Response(JSON.stringify({ error: refuse }), { status: 400 })
        const ids = JSON.parse(String(init!.body)).ids as string[]
        server = applyOrder(server, ids)
        return new Response(JSON.stringify({ ids }))
      }
      if (url === "/api/projects") return new Response(JSON.stringify(server))
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)
    function Harness() {
      const projects = useProjects()
      return createElement(ProjectList, { projects: projects.data, location: "/", active: new Map(), attention: new Set(), onCreate: () => {} })
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    for (const t of currentToasts()) dismiss(t.id)
  })

  const rows = () => [...host.querySelectorAll<HTMLAnchorElement>("a")]
  const names = () => rows().map((a) => a.textContent)
  const row = (name: string) => rows().find((a) => a.textContent === name)!
  const status = () => host.querySelector('[role="status"]')!.textContent
  const placeholder = () => host.querySelector("[aria-hidden].border-dashed")
  const cached = () => qc.getQueryData<Project[]>(keys.projects)!.map((p) => p.name)
  const orderCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/projects/order")
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
  }

  const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
    })

  /** happy-dom has no layout: give the rows a 30px pitch. */
  const layout = () =>
    rows().forEach((a, i) => {
      Object.defineProperty(a, "offsetTop", { configurable: true, value: i * 30 })
      Object.defineProperty(a, "offsetHeight", { configurable: true, value: 28 })
    })
  const pointer = (target: EventTarget, type: string, init: PointerEventInit) =>
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: "mouse", ...init }))
    })
  const click = (el: HTMLElement, init: MouseEventInit = {}) => {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
    act(() => {
      el.dispatchEvent(ev)
    })
    return ev
  }

  it("is described as reorderable, with Alt+arrows", () => {
    const hint = document.getElementById(row("alpha").getAttribute("aria-describedby")!)
    expect(hint?.textContent).toMatch(/Drag to reorder, or press (Alt|Option)\+Up or (Alt|Option)\+Down/)
  })

  it("moves the focused row with Alt+↓/↑, keeps focus on it, announces it and saves the order", async () => {
    row("alpha").focus()
    press(row("alpha"), "ArrowDown", { altKey: true })
    expect(names()).toEqual(["beta", "alpha", "gamma"])
    expect(status()).toBe("Moved alpha to position 2 of 3")
    expect(document.activeElement).toBe(row("alpha"))
    await settle()
    expect(JSON.parse(String(orderCalls()[0]![1].body))).toEqual({ ids: [BETA.id, ALPHA.id, GAMMA.id] })
    expect(cached()).toEqual(["beta", "alpha", "gamma"])

    press(row("gamma"), "ArrowUp", { altKey: true })
    expect(names()).toEqual(["beta", "gamma", "alpha"])
    expect(status()).toBe("Moved gamma to position 2 of 3")
    await settle()
    expect(server.map((p) => p.name)).toEqual(["beta", "gamma", "alpha"])
    expect(names()).toEqual(["beta", "gamma", "alpha"])
  })

  it("says so at either end instead of saving", async () => {
    press(row("alpha"), "ArrowUp", { altKey: true })
    expect(status()).toBe("alpha is already first")
    press(row("gamma"), "ArrowDown", { altKey: true })
    expect(status()).toBe("gamma is already last")
    // Plain arrows and other modifiers are left alone.
    press(row("alpha"), "ArrowDown")
    press(row("alpha"), "ArrowDown", { altKey: true, shiftKey: true })
    await settle()
    expect(orderCalls()).toEqual([])
    expect(names()).toEqual(["alpha", "beta", "gamma"])
  })

  it("rolls back with a toast when the server refuses", async () => {
    refuse = "The order must list every project; missing prj_new001"
    press(row("alpha"), "ArrowDown", { altKey: true })
    expect(names()).toEqual(["beta", "alpha", "gamma"])
    await settle()
    expect(names()).toEqual(["alpha", "beta", "gamma"])
    expect(cached()).toEqual(["alpha", "beta", "gamma"])
    expect(currentToasts().map((t) => [t.kind, t.title, t.body])).toContainEqual(["error", "Couldn't save the project order", refuse])
  })

  it("a plain click still navigates", () => {
    pointer(row("beta"), "pointerdown", { clientX: 10, clientY: 40 })
    pointer(row("beta"), "pointermove", { clientX: 11, clientY: 42 })
    pointer(row("beta"), "pointerup", { clientX: 11, clientY: 42 })
    click(row("beta"))
    expect(window.location.pathname).toBe("/projects/prj_beta01")
    expect(placeholder()).toBeNull()
  })

  it("drags past a small threshold, shows the drop placeholder, then saves without navigating", async () => {
    layout()
    const alpha = row("alpha")
    pointer(alpha, "pointerdown", { clientX: 10, clientY: 10 })
    pointer(alpha, "pointermove", { clientX: 10, clientY: 13 })
    expect(placeholder()).toBeNull()
    pointer(alpha, "pointermove", { clientX: 10, clientY: 20 })
    expect(placeholder()).not.toBeNull()
    pointer(alpha, "pointermove", { clientX: 10, clientY: 72 })
    // Held over slot 3: beta and gamma slide up, the placeholder moves down two rows.
    expect(alpha.style.transform).toBe("translateY(60px)")
    expect(row("beta").style.transform).toBe("translateY(-30px)")
    expect(row("gamma").style.transform).toBe("translateY(-30px)")
    expect((placeholder() as HTMLElement).style.transform).toBe("translateY(60px)")
    expect(names()).toEqual(["alpha", "beta", "gamma"])

    pointer(alpha, "pointerup", { clientX: 10, clientY: 72 })
    expect(click(alpha).defaultPrevented).toBe(true)
    expect(window.location.pathname).toBe("/")
    await settle()
    expect(names()).toEqual(["beta", "gamma", "alpha"])
    expect(rows().map((a) => a.style.transform)).toEqual(["", "", ""])
    expect(placeholder()).toBeNull()
    expect(status()).toBe("Moved alpha to position 3 of 3")
    expect(server.map((p) => p.name)).toEqual(["beta", "gamma", "alpha"])

    // The next click is a click again.
    click(row("beta"))
    expect(window.location.pathname).toBe("/projects/prj_beta01")
  })

  it("Escape cancels a drag", async () => {
    layout()
    const alpha = row("alpha")
    pointer(alpha, "pointerdown", { clientX: 10, clientY: 10 })
    pointer(alpha, "pointermove", { clientX: 10, clientY: 50 })
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    await settle()
    pointer(alpha, "pointerup", { clientX: 10, clientY: 50 })
    expect(names()).toEqual(["alpha", "beta", "gamma"])
    expect(orderCalls()).toEqual([])
  })

  it("Cmd/Ctrl-press never starts a drag, so the link opens a new tab", () => {
    layout()
    const alpha = row("alpha")
    pointer(alpha, "pointerdown", { clientX: 10, clientY: 10, metaKey: true })
    pointer(alpha, "pointermove", { clientX: 10, clientY: 50, metaKey: true })
    expect(placeholder()).toBeNull()
    pointer(alpha, "pointerup", { clientX: 10, clientY: 50, metaKey: true })
    // wouter leaves modified clicks to the browser: not prevented, so it opens a tab.
    expect(click(alpha, { metaKey: true }).defaultPrevented).toBe(false)
  })

  it("on touch, moving before the long press scrolls; holding picks the row up", async () => {
    layout()
    const beta = row("beta")
    pointer(beta, "pointerdown", { clientX: 10, clientY: 40, pointerType: "touch" })
    pointer(beta, "pointermove", { clientX: 10, clientY: 60, pointerType: "touch" })
    await settle()
    expect(placeholder()).toBeNull()
    pointer(beta, "pointerup", { clientX: 10, clientY: 60, pointerType: "touch" })

    pointer(beta, "pointerdown", { clientX: 10, clientY: 40, pointerType: "touch" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360)
    })
    expect(placeholder()).not.toBeNull()
    const move = new TouchEvent("touchmove", { bubbles: true, cancelable: true })
    window.dispatchEvent(move)
    expect(move.defaultPrevented).toBe(true)
    pointer(beta, "pointermove", { clientX: 10, clientY: 10, pointerType: "touch" })
    pointer(beta, "pointerup", { clientX: 10, clientY: 10, pointerType: "touch" })
    await settle()
    expect(names()).toEqual(["beta", "alpha", "gamma"])
  })
})
