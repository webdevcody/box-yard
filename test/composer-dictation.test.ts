// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import type { RecognitionLike } from "../web/src/lib/dictation.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeRecognition implements RecognitionLike {
  static all: FakeRecognition[] = []
  lang = ""
  continuous = false
  interimResults = false
  onresult: RecognitionLike["onresult"] = null
  onerror: RecognitionLike["onerror"] = null
  onend: RecognitionLike["onend"] = null
  stopped = 0
  aborted = 0
  constructor() {
    FakeRecognition.all.push(this)
  }
  start() {}
  stop() {
    this.stopped++
  }
  abort() {
    this.aborted++
  }
  say(text: string, isFinal: boolean) {
    act(() => this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] }))
  }
  end() {
    act(() => this.onend?.())
  }
}

let root: Root
let host: HTMLElement
const onSubmit = vi.fn()

beforeEach(() => {
  FakeRecognition.all = []
  onSubmit.mockReset()
  localStorage.clear()
  // The composer asks the server for its upload limit; there's no server here.
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  ;(window as any).webkitSpeechRecognition = FakeRecognition
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const panel = createRef<HTMLElement>()
  const qc = new QueryClient()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement("section", { ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel })),
      ),
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as any).webkitSpeechRecognition
  vi.unstubAllGlobals()
})

const textarea = () => document.querySelector("textarea")!
const mic = () => document.querySelector<HTMLButtonElement>("[data-testid=mic]")!
function type(text: string, caret = text.length) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  textarea().setSelectionRange(caret, caret)
}
const keyClick = () => act(() => void mic().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })))

describe("Composer dictation", () => {
  it("shows the mic next to the paperclip when recognition exists", () => {
    expect(mic()).toBeTruthy()
    expect(mic().previousElementSibling?.getAttribute("title")).toBe("Attach files")
  })

  it("shows interim words, puts final ones into the draft at the caret, and never auto-sends", () => {
    type("fix the bug", 3)
    keyClick()
    expect(document.body.textContent).toContain("Listening…")
    const rec = FakeRecognition.all[0]!
    rec.say("quick", false)
    expect(document.querySelector("[data-testid=interim]")!.textContent).toBe("quick")
    expect(textarea().value).toBe("fix the bug")
    rec.say("quickly", true)
    expect(textarea().value).toBe("fix quickly the bug")
    expect(textarea().selectionStart).toBe(11)
    keyClick()
    rec.end()
    expect(document.body.textContent).not.toContain("Listening…")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("Enter while listening stops, waits for the last words, then sends everything", () => {
    type("deploy")
    keyClick()
    const rec = FakeRecognition.all[0]!
    act(() => void textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    expect(rec.stopped).toBe(1)
    expect(onSubmit).not.toHaveBeenCalled()
    rec.say("to staging", true)
    rec.end()
    expect(onSubmit).toHaveBeenCalledWith("deploy to staging", [])
    expect(textarea().value).toBe("")
  })

  it("explains a blocked microphone", () => {
    keyClick()
    const rec = FakeRecognition.all[0]!
    act(() => rec.onerror?.({ error: "not-allowed" }))
    rec.end()
    expect(document.querySelector("[role=alert]")!.textContent).toContain("Microphone access is blocked")
  })

  it("stops listening when the composer unmounts", () => {
    keyClick()
    const rec = FakeRecognition.all[0]!
    act(() => root.render(null))
    expect(rec.aborted).toBe(1)
  })

  it("hides the mic when dictation is off", () => {
    act(() => {
      localStorage.setItem("boxyard:dictation", JSON.stringify({ enabled: false }))
      window.dispatchEvent(new StorageEvent("storage", { key: "boxyard:dictation" }))
    })
    expect(mic()).toBeNull()
  })
})
