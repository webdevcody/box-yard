// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let send: { resolve: () => void; reject: (e: Error) => void }
const onSubmit = vi.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      send = { resolve, reject }
    }),
)

// A phone (coarse pointer, no hover) or a desktop with a mouse.
function device(touch: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: touch && /coarse|hover: none/.test(q), media: q }))
}

beforeEach(() => {
  onSubmit.mockClear()
  // The composer asks the server for its upload limit; there's no server here.
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const panel = createRef<HTMLElement>()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement("section", { ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel })),
      ),
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const textarea = () => document.querySelector("textarea")!
function typeAndSend(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  textarea().focus()
  act(() => {
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
}

describe("Composer send", () => {
  it("on a phone, a successful send blurs the box so the keyboard closes", async () => {
    device(true)
    typeAndSend("hello")
    expect(onSubmit).toHaveBeenCalledWith("hello", [])
    expect(textarea().value).toBe("")
    // Still focused until the server says the send went through.
    expect(document.activeElement).toBe(textarea())
    await act(async () => send.resolve())
    expect(document.activeElement).not.toBe(textarea())
  })

  it("on a desktop, focus stays in the box to keep typing", async () => {
    device(false)
    typeAndSend("hello")
    await act(async () => send.resolve())
    expect(document.activeElement).toBe(textarea())
    expect(textarea().value).toBe("")
  })

  it("a failed send keeps focus and puts the text back", async () => {
    device(true)
    typeAndSend("hello")
    await act(async () => send.reject(new Error("offline")))
    expect(textarea().value).toBe("hello")
    expect(document.activeElement).toBe(textarea())
  })

  it("a failed send doesn't overwrite what was typed since", async () => {
    device(false)
    typeAndSend("hello")
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea(), "next")
      textarea().dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => send.reject(new Error("offline")))
    expect(textarea().value).toBe("next")
  })
})
