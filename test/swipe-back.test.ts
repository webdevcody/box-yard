import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The browser's swipe-back (Mac trackpad two-finger swipe, edge swipe) only starts when the horizontal
// gesture reaches the viewport. Any overscroll-behavior other than auto on the x axis of html/body stops it.
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

/** Declarations of the top-level rules whose selector list includes `selector`. */
function rootRules(selector: string) {
  return [...css.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => m[2]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[3]!)
}

function overscroll(selector: string) {
  const decls = rootRules(selector).join(";")
  const get = (prop: string) => [...decls.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1]!.trim())
  return { both: get("overscroll-behavior"), x: get("overscroll-behavior-x"), y: get("overscroll-behavior-y") }
}

describe("swipe-back", () => {
  it("finds the html and body rules", () => {
    expect(rootRules("html").length).toBeGreaterThan(0)
    expect(rootRules("body").length).toBeGreaterThan(0)
  })

  it.each(["html", "body", "#root"])("%s leaves horizontal overscroll to the browser", (selector) => {
    const o = overscroll(selector)
    expect(o.both).toEqual([])
    expect(o.x.filter((v) => v !== "auto")).toEqual([])
  })

  it("still stops the page bounce and pull-to-refresh on the y axis", () => {
    expect(overscroll("body").y).toEqual(["none"])
  })
})
