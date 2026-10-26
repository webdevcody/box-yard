// @vitest-environment happy-dom
// The copy button on fenced code blocks in rendered markdown: it copies the block's text exactly, falls back to a
// textarea + execCommand without navigator.clipboard (plain http on the LAN), says "Copied" for a moment, and is labelled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { COPIED_MS, Markdown } from "../web/src/components/ui.js"
import { copyText } from "../web/src/lib/clipboard.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let written: string[]

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  written = []
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (t: string) => void written.push(t) } })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  delete (document as { execCommand?: unknown }).execCommand
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const md = (text: string) => render(createElement(Markdown, null, text))
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-label='Copy code']")]
const press = async (b: HTMLButtonElement) => {
  await act(async () => {
    b.click()
  })
}

// A prompt like the one in Cody's screenshot, with characters markdown or HTML could mangle.
const CODE = "Overnight perf run on Cody's Mac (runs_on local)\n\nSetup\n- Node 24, port 4020.\n  indented `tick` <tag> & $HOME"

describe("copy button on code blocks", () => {
  it("copies the block's text exactly: no language tag, no added trailing newline", async () => {
    md(`Here:\n\n\`\`\`bash\n${CODE}\n\`\`\`\n\nand\n\n\`\`\`\none line\n\`\`\``)
    const [first, second] = buttons()
    expect(buttons()).toHaveLength(2)
    await press(first!)
    await press(second!)
    expect(written).toEqual([CODE, "one line"])
  })

  it("keeps the code's own trailing blank line and whitespace", async () => {
    md("```\n  a\n\tb  \n\n```")
    await press(buttons()[0]!)
    expect(written).toEqual(["  a\n\tb  \n"])
  })

  it("has an aria-label and sits outside the code it copies", () => {
    md("```ts\nconst x = 1\n```")
    const b = buttons()[0]!
    expect(b.getAttribute("aria-label")).toBe("Copy code")
    expect(b.type).toBe("button")
    const pre = host.querySelector("pre")!
    // A sibling of the scrolling <pre>, in its own gutter, never inside the code.
    expect(pre.contains(b)).toBe(false)
    expect(b.parentElement).toBe(pre.parentElement)
    expect(pre.parentElement!.classList.contains("code-block")).toBe(true)
  })

  it("says Copied, then goes back to Copy", async () => {
    vi.useFakeTimers()
    md("```\nx\n```")
    const b = buttons()[0]!
    const status = () => b.querySelector("[role=status]")!
    expect(status().textContent).toBe("")
    await press(b)
    expect(status().textContent).toBe("Copied")
    expect(b.dataset.copied).toBe("true")
    expect(b.title).toBe("Copied")
    await act(async () => void vi.advanceTimersByTime(COPIED_MS - 1))
    expect(status().textContent).toBe("Copied")
    await act(async () => void vi.advanceTimersByTime(1))
    expect(status().textContent).toBe("")
    expect(b.dataset.copied).toBeUndefined()
    expect(b.title).toBe("Copy code")
  })

  it("puts no button on inline code", () => {
    md("Run `npm run build` first.")
    expect(buttons()).toHaveLength(0)
  })

  it("falls back to a textarea and execCommand without navigator.clipboard", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined })
    let selected: string | null = null
    const exec = vi.fn((cmd: string) => {
      const area = document.activeElement as HTMLTextAreaElement | null
      selected = document.querySelector("textarea")?.value ?? area?.value ?? null
      return cmd === "copy"
    })
    ;(document as { execCommand?: unknown }).execCommand = exec
    md("```py\nprint('hi')\n```")
    await press(buttons()[0]!)
    expect(exec).toHaveBeenCalledWith("copy")
    expect(selected).toBe("print('hi')")
    // The helper textarea is gone again.
    expect(document.querySelector("textarea")).toBeNull()
    expect(buttons()[0]!.querySelector("[role=status]")!.textContent).toBe("Copied")
  })
})

describe("copyText", () => {
  it("uses the clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {})
    const exec = vi.fn(() => true)
    ;(document as { execCommand?: unknown }).execCommand = exec
    expect(await copyText("abc", { writeText })).toBe(true)
    expect(writeText).toHaveBeenCalledWith("abc")
    expect(exec).not.toHaveBeenCalled()
  })

  it("falls back when the clipboard API refuses", async () => {
    const exec = vi.fn(() => true)
    ;(document as { execCommand?: unknown }).execCommand = exec
    expect(await copyText("abc", { writeText: () => Promise.reject(new Error("denied")) })).toBe(true)
    expect(exec).toHaveBeenCalledWith("copy")
  })

  it("reports failure when both ways fail", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined })
    ;(document as { execCommand?: unknown }).execCommand = () => false
    expect(await copyText("abc")).toBe(false)
    expect(document.querySelector("textarea")).toBeNull()
  })
})
