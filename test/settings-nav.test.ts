import { describe, expect, it } from "vitest"
import { changedKeys, changedSections, parseSection, savePatch, stepSection } from "../web/src/lib/settingsNav"
import type { Settings } from "../shared/types"

const base: Settings = {
  orchestratorModel: "claude-opus-5-5",
  orchestratorEffort: "high",
  orchestratorAutoCompact: { enabled: true, unit: "percent", value: 80 },
  agentModel: "claude-opus-5-5",
  agentEffort: "orchestrator",
  agentRoutingConfig: "",
  agentAutoCompact: { enabled: false, unit: "tokens", value: 800_000 },
  maxBoxes: 5,
  slotsPerBox: 2,
  maxAgents: 0,
}

describe("settings nav", () => {
  it("parses the ?settings= section, with aliases and a fallback", () => {
    expect(parseSection("limits")).toBe("limits")
    expect(parseSection("Boxes")).toBe("limits")
    expect(parseSection("about")).toBe("about")
    expect(parseSection("nope")).toBe("orchestrator")
    expect(parseSection(null)).toBe("orchestrator")
  })

  it("steps through sections with wrap-around", () => {
    expect(stepSection("orchestrator", 1)).toBe("agents")
    expect(stepSection("orchestrator", -1)).toBe("about")
    expect(stepSection("about", 1)).toBe("orchestrator")
  })

  it("finds changed settings, including nested auto-compact values", () => {
    expect(changedKeys(base, base)).toEqual([])
    expect(changedKeys(null, base)).toEqual([])
    const draft = { ...base, maxBoxes: 8, agentAutoCompact: { ...base.agentAutoCompact, enabled: true } }
    expect(changedKeys(draft, base)).toEqual(["agentAutoCompact", "maxBoxes"])
    expect([...changedSections(changedKeys(draft, base))].sort()).toEqual(["agents", "limits"])
  })

  it("sends pool limits only when they were edited", () => {
    const untouched = savePatch(base, base)
    expect(untouched).not.toHaveProperty("maxBoxes")
    expect(untouched).toHaveProperty("orchestratorModel", "claude-opus-5-5")
    expect(savePatch({ ...base, slotsPerBox: 3 }, base)).toMatchObject({ slotsPerBox: 3 })
  })
})
