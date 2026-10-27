// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { readHistory, rememberPrompt } from "../web/src/lib/promptHistory.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const onSubmit = vi.fn((_text: string) => Promise.resolve())

function render(historyKey = "task:t1") {
  const panel = createRef<HTMLElement>()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement("section", { ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel, historyKey })),
      ),
    ),
  )
}

beforeEach(() => {
  onSubmit.mockClear()
  localStorage.clear()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  rememberPrompt("task:t1", "first prompt")
  rememberPrompt("task:t1", "second prompt")
  render()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const textarea = () => document.querySelector("textarea")!
const ghost = () => document.querySelector<HTMLElement>("[data-testid=history-ghost]")
function key(k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void textarea().dispatchEvent(e))
  return e
}
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("Composer prompt history", () => {
  it("Up shows the newest prompt as a ghost, not as the value; more Up goes older, Down back to empty", () => {
    textarea().focus()
    expect(key("ArrowUp").defaultPrevented).toBe(true)
    expect(ghost()?.textContent).toBe("second prompt")
    expect(textarea().value).toBe("")
    expect(textarea().placeholder).toBe("")
    key("ArrowUp")
    expect(ghost()?.textContent).toBe("first prompt")
    key("ArrowDown")
    expect(ghost()?.textContent).toBe("second prompt")
    key("ArrowDown")
    expect(ghost()).toBeNull()
    expect(textarea().placeholder).toBe("Ask")
  })

  it("the first Enter takes the prompt (caret at the end) without sending; the next Enter sends it", async () => {
    textarea().focus()
    key("ArrowUp")
    expect(key("Enter").defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(ghost()).toBeNull()
    expect(textarea().value).toBe("second prompt")
    expect(textarea().selectionStart).toBe("second prompt".length)
    await act(async () => void key("Enter"))
    expect(onSubmit).toHaveBeenCalledWith("second prompt", [])
    expect(textarea().value).toBe("")
  })

  it("remembers what was sent, newest first, without repeating the newest", async () => {
    textarea().focus()
    type("third prompt")
    await act(async () => void key("Enter"))
    type("third prompt")
    await act(async () => void key("Enter"))
    expect(readHistory("task:t1")).toEqual(["third prompt", "second prompt", "first prompt"])
    key("ArrowUp")
    expect(ghost()?.textContent).toBe("third prompt")
  })

  it("Escape clears the ghost and doesn't reach page-level handlers", () => {
    const outside = vi.fn()
    document.addEventListener("keydown", outside)
    textarea().focus()
    key("ArrowUp")
    expect(key("Escape").defaultPrevented).toBe(true)
    expect(ghost()).toBeNull()
    expect(outside).not.toHaveBeenCalled()
    document.removeEventListener("keydown", outside)
  })

  it("typing drops the ghost and starts fresh", () => {
    textarea().focus()
    key("ArrowUp")
    type("n")
    expect(ghost()).toBeNull()
    expect(textarea().value).toBe("n")
    // With text in the box, Up is the caret's again.
    expect(key("ArrowUp").defaultPrevented).toBe(false)
  })

  it("does nothing while an IME is composing", () => {
    textarea().focus()
    expect(key("ArrowUp", { isComposing: true }).defaultPrevented).toBe(false)
    expect(ghost()).toBeNull()
    type("にほん")
    key("Enter", { isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("leaving the box clears the ghost", () => {
    textarea().focus()
    key("ArrowUp")
    act(() => textarea().blur())
    expect(ghost()).toBeNull()
  })

  it("each chat has its own history", () => {
    render("task:other")
    textarea().focus()
    expect(key("ArrowUp").defaultPrevented).toBe(false)
    expect(ghost()).toBeNull()
  })
})
