// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { EffortPicker, ModelPicker } from "../web/src/components/ModelPicker.js"
import { keys } from "../web/src/lib/queries.js"
import { BUILTIN_MODELS, mergeCliModels, type ModelCatalog } from "../shared/models.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shared model and effort pickers: grouped models plus a custom ID, and effort levels a model doesn't take greyed
// out with a line saying what the CLI runs instead.

let root: Root
let host: HTMLElement
const seen: { model: string; effort: string }[] = []

function Pickers({ model: m0, effort: e0, disabled }: { model: string; effort: string; disabled?: boolean }) {
  const [model, setModel] = useState(m0)
  const [effort, setEffort] = useState(e0)
  seen.push({ model, effort })
  return createElement(
    "div",
    null,
    createElement(ModelPicker, { value: model, onChange: setModel, testId: "model", disabled }),
    createElement(EffortPicker, { value: effort, onChange: setEffort, model, testId: "effort", disabled }),
  )
}

function render(model: string, effort: string, catalog?: ModelCatalog, disabled?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  if (catalog) qc.setQueryData(keys.models, catalog)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Pickers, { model, effort, disabled }))))
}

const $ = <T extends Element>(sel: string) => host.querySelector<T>(sel)
const pick = (sel: string, value: string) =>
  act(() => {
    const el = $<HTMLSelectElement>(sel)!
    el.value = value
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
const effortOptions = () => [...$<HTMLSelectElement>("[data-testid=effort]")!.options].map((o) => `${o.textContent}${o.disabled ? " [off]" : ""}`)
const last = () => seen.at(-1)!

beforeEach(() => {
  seen.length = 0
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe("ModelPicker", () => {
  it("groups the built-in list until the CLI's arrives, and picks a model", () => {
    render("claude-opus-5-5", "high")
    const select = $<HTMLSelectElement>("[data-testid=model]")!
    expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Latest", "Aliases", "Older"])
    expect(select.value).toBe("claude-opus-5-5")
    expect([...select.options].map((o) => o.value)).toContain("opusplan")
    expect([...select.options].at(-1)!.textContent).toBe("Custom model ID…")
    expect($("[data-testid=model-custom]")).toBeNull()
    pick("[data-testid=model]", "sonnet[1m]")
    expect(last().model).toBe("sonnet[1m]")
  })

  it("shows the CLI's list, with what each alias runs on now", () => {
    const models = mergeCliModels(BUILTIN_MODELS, [{ value: "opus", resolvedModel: "claude-opus-6", supportsEffort: true }])
    render("opus", "high", { models, source: "cli", cliVersion: "9.9.9", fetchedAt: 1 })
    const options = [...$<HTMLSelectElement>("[data-testid=model]")!.options]
    expect(options.find((o) => o.value === "opus")!.textContent).toBe("opus · Opus 6 now")
    expect(options.find((o) => o.value === "claude-opus-6")!.textContent).toBe("Opus 6 · claude-opus-6")
  })

  it("keeps a model id the list doesn't have in the custom field, and opens it on Custom model ID", () => {
    render("my-gateway/claude-x", "high")
    expect($<HTMLSelectElement>("[data-testid=model]")!.selectedOptions[0]!.textContent).toBe("Custom model ID…")
    expect($<HTMLInputElement>("[data-testid=model-custom]")!.value).toBe("my-gateway/claude-x")
    pick("[data-testid=model]", "claude-haiku-5-5")
    expect($("[data-testid=model-custom]")).toBeNull()
    pick("[data-testid=model]", "\u0000custom")
    // The field starts with the model picked so far.
    expect($<HTMLInputElement>("[data-testid=model-custom]")!.value).toBe("claude-haiku-5-5")
    act(() => {
      const input = $<HTMLInputElement>("[data-testid=model-custom]")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "claude-opus-4-1-20250805")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(last().model).toBe("claude-opus-4-1-20250805")
    expect($("[data-testid=model-custom]")).not.toBeNull()
  })
})

describe("EffortPicker", () => {
  it("offers every level for today's models, with no warning", () => {
    render("claude-fable-5-1", "max")
    expect(effortOptions()).toEqual(["Low", "Medium", "High", "Extra high", "Max"])
    expect($("[data-testid=effort-warning]")).toBeNull()
  })

  it("greys out a level the model doesn't take, and says what runs instead when it's picked", () => {
    render("claude-opus-4-6", "xhigh")
    // The saved level stays selectable, so it shows; the warning says what the CLI does with it.
    expect(effortOptions()).toEqual(["Low", "Medium", "High", "Extra high (not on Opus 4.6)", "Max"])
    expect($("[data-testid=effort-warning]")!.textContent).toBe("Opus 4.6 has no Extra high effort, so the CLI runs it at High.")
    pick("[data-testid=effort]", "high")
    expect($("[data-testid=effort-warning]")).toBeNull()
    expect(effortOptions()).toContain("Extra high (not on Opus 4.6) [off]")
  })

  it("follows the model picked next to it", () => {
    render("claude-opus-5-5", "low")
    pick("[data-testid=model]", "claude-haiku-4-5")
    expect(effortOptions().every((o) => o.includes("(not on Haiku 4.5)"))).toBe(true)
    expect($("[data-testid=effort-warning]")!.textContent).toBe("Haiku 4.5 takes no effort level, so the CLI sends none.")
  })

  it("is greyed out with no warning while its setting is off (Settings › Coordinator › Relay turns)", () => {
    render("claude-opus-4-6", "xhigh", undefined, true)
    expect(last()).toEqual({ model: "claude-opus-4-6", effort: "xhigh" })
    expect($<HTMLSelectElement>("[data-testid=model]")!.disabled).toBe(true)
    expect($<HTMLSelectElement>("[data-testid=effort]")!.disabled).toBe(true)
    expect($("[data-testid=effort-warning]")).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    render("my-gateway/claude-x", "high", undefined, true)
    expect($<HTMLInputElement>("[data-testid=model-custom]")!.disabled).toBe(true)
  })
})
