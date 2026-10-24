import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ContextMiniBar } from "../web/src/components/ContextMeter.js"

const render = (tokens: number | null, window: number | null, hint?: string) => renderToStaticMarkup(createElement(ContextMiniBar, { tokens, window, hint }))

describe("ContextMiniBar", () => {
  it("labels the bar with the full reading and a short phone label", () => {
    const html = render(78_000, 1_000_000)
    expect(html).toContain("Context 78k / 1m · 8%")
    expect(html).toContain("8% ctx")
    expect(html).toContain("title=\"Context 78k / 1m · 8%. How much of this agent&#x27;s context window is used. Compact when it gets high.\"")
  })

  it("uses a custom tooltip hint", () => {
    expect(render(500_000, 1_000_000, "Captain hint.")).toContain("title=\"Context 500k / 1m · 50%. Captain hint.\"")
  })

  it("renders nothing until the context is measured", () => {
    expect(render(null, 1_000_000)).toBe("")
    expect(render(10_000, null)).toBe("")
  })
})
