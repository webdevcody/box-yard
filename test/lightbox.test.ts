// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Markdown } from "../web/src/components/ui.js"
import { LightboxHost } from "../web/src/components/Lightbox.js"
import { clickImage, closeLightbox, imageTarget, lightboxImage, openLightbox } from "../web/src/lib/lightbox.js"
import { closePreview, previewState } from "../web/src/lib/preview.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  history.replaceState(null, "", "/zen")
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  closeLightbox()
  if (previewState()) closePreview()
  vi.unstubAllGlobals()
})

function render(markdown: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  for (const k of [keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Fragment, null, createElement(Markdown, null, markdown), createElement(LightboxHost)))))
}

const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  return e
}
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")
const img = (src: string) => host.querySelector<HTMLImageElement>(`img[src="${src}"]`)!

const fake = (init: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: Element | null }> = {}) => {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: null as Element | null, ...init, preventDefault: vi.fn() }
  return e
}

describe("which clicks on an image open it", () => {
  it("hosted files go to the file preview, any other image to the lightbox", () => {
    expect(imageTarget("/artifacts/art_abc123/shot.png")).toBe("preview")
    expect(imageTarget("/api/uploads/up_1/photo.jpg")).toBe("preview")
    expect(imageTarget("https://example.com/cat.png")).toBe("lightbox")
    expect(imageTarget("/some/other.png")).toBe("lightbox")
    expect(imageTarget("javascript:alert(1)")).toBeNull()
    expect(imageTarget("")).toBeNull()
  })

  it("a plain click opens; modifier and middle clicks, and an image inside a link, are left alone", () => {
    const open = { preview: vi.fn(), lightbox: vi.fn() }
    const plain = fake()
    expect(clickImage(plain, { src: "https://example.com/cat.png", alt: "cat" }, open)).toBe(true)
    expect(plain.preventDefault).toHaveBeenCalled()
    expect(open.lightbox).toHaveBeenCalledWith({ src: "https://example.com/cat.png", alt: "cat" })
    expect(clickImage(fake(), { src: "/artifacts/art_abc123/shot.png" }, open)).toBe(true)
    expect(open.preview).toHaveBeenCalledWith("/artifacts/art_abc123/shot.png")
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const e = fake(init)
      expect(clickImage(e, { src: "https://example.com/cat.png" }, open), JSON.stringify(init)).toBe(false)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    const a = document.createElement("a")
    a.href = "https://example.com"
    const inner = document.createElement("img")
    a.append(inner)
    expect(clickImage(fake({ target: inner }), { src: "https://example.com/cat.png" }, open)).toBe(false)
    expect(open.lightbox).toHaveBeenCalledTimes(1)
  })
})

describe("the lightbox", () => {
  it("a click on an image in a reply opens it centered in the shared Modal, fit to the screen, with the original a tab away", () => {
    render("Here: ![the cat](https://example.com/cat.png)")
    const image = img("https://example.com/cat.png")
    expect(image.className).toContain("cursor-zoom-in")
    expect(click(image).defaultPrevented).toBe(true)
    const d = dialog()!
    expect(d.getAttribute("aria-label")).toBe("the cat")
    // Modal's centered placement on its backdrop.
    expect(d.parentElement!.className).toContain("sm:items-center")
    const big = d.querySelector<HTMLImageElement>("img")!
    expect(big.getAttribute("src")).toBe("https://example.com/cat.png")
    expect(big.className).toContain("max-w-full")
    expect(big.className).toContain("object-contain")
    expect(big.className).toMatch(/max-h-\[calc\(100dvh/)
    const original = [...d.querySelectorAll("a")].find((a) => a.textContent?.includes("Open original"))!
    expect(original.getAttribute("href")).toBe("https://example.com/cat.png")
    expect(original.getAttribute("target")).toBe("_blank")
    expect(original.getAttribute("rel")).toContain("noopener")
  })

  it("closes with Esc, ✕, the backdrop and a click beside the image", () => {
    render("![](https://example.com/cat.png)")
    const open = () => {
      click(img("https://example.com/cat.png"))
      expect(dialog()).not.toBeNull()
    }
    open()
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(dialog()).toBeNull()
    open()
    click(dialog()!.querySelector("[aria-label='Close (Esc)']")!)
    expect(dialog()).toBeNull()
    open()
    const backdrop = dialog()!.parentElement!
    act(() => void backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(dialog()).toBeNull()
    open()
    click(dialog()!.querySelector("[data-testid=lightbox-stage]")!)
    expect(dialog()).toBeNull()
    expect(lightboxImage()).toBeNull()
  })

  it("a click on the image itself keeps it open; a Cmd-click on the chat image doesn't open it", () => {
    render("![](https://example.com/cat.png)")
    expect(click(img("https://example.com/cat.png"), { metaKey: true }).defaultPrevented).toBe(false)
    expect(dialog()).toBeNull()
    click(img("https://example.com/cat.png"))
    click(dialog()!.querySelector("img")!)
    expect(dialog()).not.toBeNull()
  })

  it("an image Box Yard hosts opens in the file preview; a linked image follows its link", () => {
    render("![shot](/artifacts/art_abc123/shot.png) [![badge](https://example.com/b.svg)](https://example.com/ci)")
    click(img("/artifacts/art_abc123/shot.png"))
    expect(previewState()?.items[0]?.url).toBe("/artifacts/art_abc123/shot.png")
    expect(lightboxImage()).toBeNull()
    const linked = click(img("https://example.com/b.svg"))
    expect(lightboxImage()).toBeNull()
    expect(linked.defaultPrevented).toBe(false)
  })

  it("shows a note when the image doesn't load", () => {
    act(() => openLightbox({ src: "https://example.com/gone.png" }))
    render("text")
    const big = dialog()!.querySelector("img")!
    act(() => void big.dispatchEvent(new Event("error")))
    expect(dialog()!.textContent).toContain("Couldn't load this image.")
    expect([...dialog()!.querySelectorAll("a")].some((a) => a.textContent?.includes("Open original"))).toBe(true)
  })
})
