// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AgentIcon } from "../web/src/components/ui.js"

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
})

describe("AgentIcon", () => {
  const icon = () => host.querySelector('[data-testid="agent-icon"]')!
  const live = () => host.querySelector('[aria-live="polite"]')!

  it("animates and announces Working… only while busy", () => {
    act(() => root.render(createElement(AgentIcon, { busy: true })))
    expect(icon().getAttribute("class")).toContain("agent-working")
    expect(live().textContent).toBe("Working…")
    expect(host.querySelector('[title="Working…"]')).not.toBeNull()

    act(() => root.render(createElement(AgentIcon, { busy: false })))
    expect(icon().getAttribute("class")).not.toContain("agent-working")
    expect(live().textContent).toBe("")
    expect(host.querySelector("[title]")).toBeNull()
  })
})
