// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Modal } from "../web/src/components/Modal.js"
import { ConfirmHost } from "../web/src/components/ConfirmDialog.js"
import { confirmDialog, currentConfirm } from "../web/src/lib/confirm.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
})

const render = (node: ReactNode) => act(() => root.render(node))
const key = (k: string, opts: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts })))
const dialogs = () => [...document.querySelectorAll<HTMLElement>("[role=dialog]")]
const backdropOf = (dialog: HTMLElement) => dialog.parentElement!
const mouseDown = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))

function form(onClose: () => void, extra: Partial<Parameters<typeof Modal>[0]> = {}) {
  return createElement(
    Modal,
    { title: "New project", onClose, ...extra },
    createElement("input", { "data-testid": "first" }),
    createElement("button", { type: "button", "data-testid": "last" }, "Go"),
  )
}

describe("Modal", () => {
  it("portals to <body>, outside the tree that rendered it, with a titled dialog", () => {
    render(form(() => {}))
    const [dialog] = dialogs()
    expect(dialog).toBeDefined()
    expect(host.contains(dialog!)).toBe(false)
    expect(backdropOf(dialog!).parentElement).toBe(document.body)
    expect(dialog!.getAttribute("aria-modal")).toBe("true")
    expect(document.getElementById(dialog!.getAttribute("aria-labelledby")!)?.textContent).toBe("New project")
  })

  it("applies the size preset", () => {
    render(form(() => {}, { size: "sm" }))
    expect(dialogs()[0]!.className).toContain("sm:max-w-md")
    render(form(() => {}, { size: "xl" }))
    expect(dialogs()[0]!.className).toContain("sm:max-w-[54rem]")
  })

  it("closes on Esc", () => {
    const onClose = vi.fn()
    render(form(onClose))
    key("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on a backdrop click, but not on a click inside or while dirty", () => {
    const onClose = vi.fn()
    render(form(onClose))
    mouseDown(document.querySelector("[data-testid=first]")!)
    expect(onClose).not.toHaveBeenCalled()
    mouseDown(backdropOf(dialogs()[0]!))
    expect(onClose).toHaveBeenCalledTimes(1)

    render(form(onClose, { dirty: true }))
    mouseDown(backdropOf(dialogs()[0]!))
    expect(onClose).toHaveBeenCalledTimes(1)
    key("Escape")
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("moves focus in, traps Tab, and gives focus back on close", () => {
    const opener = document.createElement("button")
    document.body.append(opener)
    opener.focus()
    render(form(() => {}))
    const dialog = dialogs()[0]!
    expect(dialog.contains(document.activeElement)).toBe(true)

    const last = document.querySelector<HTMLElement>("[data-testid=last]")!
    last.focus()
    key("Tab")
    // Wraps to the first focusable, the header's close button.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close")
    key("Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)

    render(null)
    expect(document.activeElement).toBe(opener)
  })

  it("only the topmost modal reacts to Esc", () => {
    const below = vi.fn()
    const above = vi.fn()
    render(createElement("div", null, form(below), form(above, { title: "Discard?" })))
    key("Escape")
    expect(above).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()
  })

  it("leaves Esc alone when the dialog's own handler already took it", () => {
    const onClose = vi.fn()
    render(form(onClose, { onKeyDown: (e) => e.key === "Escape" && e.preventDefault() }))
    const input = document.querySelector<HTMLElement>("[data-testid=first]")!
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("confirmDialog", () => {
  it("resolves true on confirm and false on cancel or Esc, one at a time", async () => {
    render(createElement(ConfirmHost))
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = confirmDialog({ title: "Delete project?", body: "Can't be undone.", confirmLabel: "Delete project", danger: true })
      second = confirmDialog({ title: "Delete schedule?" })
    })
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0]!.textContent).toContain("Delete project?")

    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete project")!
    act(() => confirm.click())
    await expect(first).resolves.toBe(true)

    expect(dialogs()[0]!.textContent).toContain("Delete schedule?")
    key("Escape")
    await expect(second).resolves.toBe(false)
    expect(dialogs()).toHaveLength(0)
    expect(currentConfirm()).toBeUndefined()
  })
})
