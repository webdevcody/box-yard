import { describe, expect, it } from "vitest"
import { composerMaxHeight } from "../web/src/lib/composer.js"

describe("composerMaxHeight", () => {
  it("is 45% of the viewport", () => {
    expect(composerMaxHeight(800)).toBe(360)
  })

  it("is clamped between 160 and 480px", () => {
    expect(composerMaxHeight(200)).toBe(160)
    expect(composerMaxHeight(2000)).toBe(480)
  })

  it("allows 75% of the viewport when expanded", () => {
    expect(composerMaxHeight(1000, true)).toBe(750)
    expect(composerMaxHeight(100, true)).toBe(160)
  })
})
