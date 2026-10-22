// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { FileLink, PREVIEW_GROUP } from "../web/src/components/FileLink.js"
import { FilePreviewHost } from "../web/src/components/FilePreview.js"
import { closePreview, openPreview, previewState } from "../web/src/lib/preview.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
/** Whether the last click reached the window un-cancelled (i.e. the browser would have followed the link). */
let followed: boolean | null
const stopNavigation = (e: Event) => {
  followed = !e.defaultPrevented
  e.preventDefault()
}

beforeEach(() => {
  history.replaceState(null, "", "/tasks/task_abcdef123456")
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  followed = null
  window.addEventListener("click", stopNavigation)
})

afterEach(() => {
  act(() => root.unmount())
  window.removeEventListener("click", stopNavigation)
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(node))
const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  // FileLink stops a handled click from bubbling (cards are links too), so read it off the event.
  if (followed === null) followed = !e.defaultPrevented
  return e
}
const preview = () => new URL(window.location.href).searchParams.get("preview")

function gallery() {
  return createElement(
    "div",
    PREVIEW_GROUP,
    createElement(FileLink, { href: "/artifacts/art_before01/before.png", id: "before" }, "before"),
    createElement(FileLink, { href: "/artifacts/art_after001/after.png", id: "after" }, "after"),
    createElement(FileLink, { href: "/artifacts/art_notes001/notes.md", id: "notes" }, "notes"),
    createElement(FileLink, { href: "/artifacts/art_bundle01/bundle.zip", id: "zip" }, "zip"),
  )
}
const $ = (id: string) => document.getElementById(id)!

describe("FileLink", () => {
  it("renders a normal new-tab link, so copy link and middle-click keep working", () => {
    render(gallery())
    const a = $("before") as HTMLAnchorElement
    expect(a.getAttribute("href")).toBe("/artifacts/art_before01/before.png")
    expect(a.target).toBe("_blank")
    expect(a.dataset.preview).toBe("image")
    expect(($("zip") as HTMLAnchorElement).dataset.preview).toBeUndefined()
  })

  it("opens the preview on a plain click, with the group's images as the gallery", () => {
    render(gallery())
    click($("after"))
    expect(followed).toBe(false)
    expect(preview()).toBe("art_after001")
    const s = previewState()!
    expect(s.items.map((i) => i.url)).toEqual(["/artifacts/art_before01/before.png", "/artifacts/art_after001/after.png"])
    expect(s.index).toBe(1)
    act(() => closePreview())
  })

  it("passes Cmd, Ctrl, Shift and middle clicks through to the browser", () => {
    render(gallery())
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      followed = null
      click($("before"), init)
      expect(followed).toBe(true)
      expect(preview()).toBeNull()
    }
  })

  it("passes clicks on files it can't show through", () => {
    render(gallery())
    click($("zip"))
    expect(followed).toBe(true)
    expect(preview()).toBeNull()
  })

  it("opens a non-image file on its own, without a gallery", () => {
    render(gallery())
    click($("notes"))
    expect(preview()).toBe("art_notes001")
    expect(previewState()!.items).toHaveLength(1)
    act(() => closePreview())
  })
})

describe("preview URL state", () => {
  it("pushes ?preview= on open and closes with back", async () => {
    const before = history.length
    act(() => openPreview({ url: "/api/uploads/up_1/shot.png" }))
    expect(preview()).toBe("/api/uploads/up_1/shot.png")
    expect(history.length).toBe(before + 1)
    act(() => closePreview())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(preview()).toBeNull()
    expect(window.location.pathname).toBe("/tasks/task_abcdef123456")
  })

  it("swaps the preview in place when opened from inside a preview", () => {
    act(() => openPreview({ url: "/artifacts/art_aaaaaaa1/a.md" }))
    const length = history.length
    act(() => openPreview({ url: "/artifacts/art_bbbbbbb1/b.html" }))
    expect(history.length).toBe(length)
    expect(preview()).toBe("art_bbbbbbb1")
    act(() => closePreview())
  })
})

describe("FilePreviewHost", () => {
  const withClient = (node: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(["artifacts"], [])
    return createElement(QueryClientProvider, { client: qc }, node)
  }
  const respond = (body: string, headers: Record<string, string> = {}) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers })))
  const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))

  it("shows nothing without ?preview=", () => {
    render(withClient(createElement(FilePreviewHost)))
    expect(document.querySelector("[role=dialog]")).toBeNull()
  })

  it("pretty-prints JSON with line numbers and a Raw toggle", async () => {
    respond('{"ok":true,"n":[1,2]}')
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/data.json", size: 22 }))
    await settle()
    const dialog = document.querySelector("[role=dialog]")!
    expect(dialog.getAttribute("aria-label")).toBe("data.json")
    expect(dialog.textContent).toContain('"ok": true')
    expect(dialog.textContent).toContain("1\n2\n3")
    click(dialog.querySelector('[aria-label="Show raw"]')!)
    expect(dialog.textContent).toContain('{"ok":true,"n":[1,2]}')
    act(() => closePreview())
  })

  it("renders CSV as a table", async () => {
    respond("name,count\nalpha,1\nbeta,2\n")
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/rows.csv" }))
    await settle()
    const cells = [...document.querySelectorAll("[role=dialog] th, [role=dialog] td")].map((c) => c.textContent)
    expect(cells).toEqual(["name", "count", "alpha", "1", "beta", "2"])
    act(() => closePreview())
  })

  it("offers a new tab instead of previewing text over the cap", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/huge.log", size: 5 * 1024 * 1024 }))
    await settle()
    const dialog = document.querySelector("[role=dialog]")!
    expect(fetch).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain("too big to preview")
    expect(dialog.querySelector('a[target="_blank"][href="/api/uploads/up_1/huge.log"]')).not.toBeNull()
    act(() => closePreview())
  })

  it("shows HTML in a sandboxed frame without same-origin access", async () => {
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/artifacts/art_96efb3c6cbea/arch.html" }))
    await settle()
    const frame = document.querySelector("[role=dialog] iframe")!
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame.getAttribute("src")).toBe("/artifacts/art_96efb3c6cbea/arch.html")
    act(() => closePreview())
  })

  it("steps through the gallery with the arrow keys", async () => {
    render(withClient(createElement(FilePreviewHost)))
    const items = [{ url: "/artifacts/art_before01/before.png" }, { url: "/artifacts/art_after001/after.png" }]
    act(() => openPreview(items[0]!, items))
    await settle()
    expect(document.querySelector("[role=dialog] img")!.getAttribute("src")).toBe(items[0]!.url)
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })))
    expect(document.querySelector("[role=dialog] img")!.getAttribute("src")).toBe(items[1]!.url)
    expect(preview()).toBe("art_after001")
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })))
    expect(preview()).toBe("art_before01")
    act(() => closePreview())
  })
})
