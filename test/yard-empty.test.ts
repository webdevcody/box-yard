// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ActiveEmpty } from "../web/src/components/YardView.js"

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

const links = () => [...host.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])

describe("Yard Active empty state", () => {
  it("links to the Recent tab", () => {
    act(() => root.render(createElement(ActiveEmpty, { needsYou: 0, needsYouHref: "/?tab=needs_you", recentHref: "/?tab=recent" })))
    expect(host.textContent).toContain("All quiet in the yard")
    expect(links()).toEqual([["See recently finished →", "/?tab=recent"]])
  })

  it("also links to waiting tasks when some need you", () => {
    act(() => root.render(createElement(ActiveEmpty, { needsYou: 2, needsYouHref: "/?tab=needs_you", recentHref: "/?tab=recent" })))
    expect(links()).toEqual([
      ["see the 2 tasks waiting on you", "/?tab=needs_you"],
      ["See recently finished →", "/?tab=recent"],
    ])
  })
})
