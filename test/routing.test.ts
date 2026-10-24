import { describe, expect, it } from "vitest"
import YAML from "yaml"
import { isCopiedDefaultRoute, resolveAgentRoute, routingConfigSchema, routingInstructions, type RoutingConfig } from "../server/routing.js"
import type { Effort, Project, SettingSource, Settings } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const project = { id: "prj_routed", name: "routed", repo: "acme/routed" } as Project
const other = { id: "prj_other1", name: "other", repo: null } as unknown as Project
const yaml = (text: string): RoutingConfig => routingConfigSchema.parse(YAML.parse(text))

const FULL = yaml(`
fallback: { model: fallback-model, effort: max, reason: Safest route. }
defaults: { model: defaults-model, effort: medium }
projects:
  routed: { model: project-model, reason: Routed repo. }
`)

const noTask = { model: null, effort: null }
const atDefault = {
  settings: { agentModel: "claude-opus-5-5", agentEffort: "high" } as Pick<Settings, "agentModel" | "agentEffort">,
  sources: { agentModel: "default", agentEffort: "default" } as Record<"agentModel" | "agentEffort", SettingSource>,
}
const saved = (agentModel: string, agentEffort: Settings["agentEffort"], source: SettingSource = "ui") => ({
  settings: { agentModel, agentEffort },
  sources: { agentModel: source, agentEffort: source },
})
const route = (
  config: RoutingConfig | null,
  s: typeof atDefault,
  task: { model: string | null; effort: Effort | null; routingRule?: string | null; routingReason?: string | null } = noTask,
  p: Project = other,
) => resolveAgentRoute({ task, config, project: p, ...s })

describe("agent model/effort precedence (#44)", () => {
  it("falls back to the built-in claude-opus-5-5 at high with no config and Settings at their defaults", () => {
    expect(route(null, atDefault)).toEqual({ model: "claude-opus-5-5", effort: "high", rule: null, reason: null, modelFrom: "builtin", effortFrom: "builtin" })
  })

  it("routing YAML defaults beat the built-in default, and fallback fills what defaults leave out", () => {
    expect(route(FULL, atDefault)).toMatchObject({ model: "defaults-model", effort: "medium", modelFrom: "defaults", effortFrom: "defaults", rule: "defaults" })
    const partial = yaml("fallback: { model: fallback-model, effort: max }\ndefaults: { model: defaults-model }")
    expect(route(partial, atDefault)).toMatchObject({ model: "defaults-model", effort: "max", modelFrom: "defaults", effortFrom: "fallback" })
    expect(route(yaml("fallback: { effort: low }"), atDefault)).toMatchObject({ model: "claude-opus-5-5", effort: "low", modelFrom: "builtin", effortFrom: "fallback", rule: "fallback" })
  })

  it("Settings saved in the UI or set by env beat the YAML defaults and fallback", () => {
    expect(route(FULL, saved("ui-model", "low"))).toMatchObject({ model: "ui-model", effort: "low", modelFrom: "settings", effortFrom: "settings", rule: null, reason: null })
    expect(route(FULL, saved("env-model", "high", "env"))).toMatchObject({ model: "env-model", modelFrom: "settings" })
    // Only the model saved: the effort still comes from the YAML.
    const modelOnly = { settings: { agentModel: "ui-model", agentEffort: "high" as const }, sources: { agentModel: "ui" as const, agentEffort: "default" as const } }
    expect(route(FULL, modelOnly)).toMatchObject({ model: "ui-model", effort: "medium", modelFrom: "settings", effortFrom: "defaults" })
  })

  it('effort "Let the Coordinator decide" sets no effort of its own', () => {
    expect(route(FULL, saved("ui-model", "orchestrator"))).toMatchObject({ model: "ui-model", effort: "medium", effortFrom: "defaults" })
    expect(route(null, saved("ui-model", "orchestrator"))).toMatchObject({ effort: "high", effortFrom: "builtin" })
  })

  it("the project's routing entry beats Settings, by id, name or repo", () => {
    expect(route(FULL, saved("ui-model", "low"), noTask, project)).toMatchObject({
      model: "project-model",
      effort: "low",
      modelFrom: "project",
      effortFrom: "settings",
      rule: "project:routed",
      reason: "Routed repo.",
    })
    for (const key of ["prj_routed", "acme/routed"]) {
      expect(route(yaml(`projects:\n  ${key}: { effort: xhigh }`), saved("ui-model", "low"), noTask, project)).toMatchObject({ effort: "xhigh", rule: `project:${key}`, reason: "Default route for routed." })
    }
  })

  it("the task's own choice beats everything, model and effort separately", () => {
    const task = { model: "task-model", effort: null, routingRule: "docs-small-fixes", routingReason: "Small chore." }
    expect(route(FULL, saved("ui-model", "low"), task, project)).toMatchObject({
      model: "task-model",
      effort: "low",
      modelFrom: "task",
      effortFrom: "settings",
      rule: "docs-small-fixes",
      reason: "Small chore.",
    })
    expect(route(null, atDefault, { model: null, effort: "max" })).toMatchObject({ model: "claude-opus-5-5", effort: "max", modelFrom: "builtin", effortFrom: "task" })
  })

  it("recognizes rows that older versions filled with a copy of the YAML route, and nothing else", () => {
    const row = (model: string | null, effort: Effort | null, routing_rule: string | null) => ({ model, effort, routing_rule })
    expect(isCopiedDefaultRoute(FULL, other, row("defaults-model", "medium", "defaults"))).toBe(true)
    // The old merge: the project entry over defaults over fallback.
    expect(isCopiedDefaultRoute(FULL, project, row("project-model", "medium", "project:routed"))).toBe(true)
    expect(isCopiedDefaultRoute(yaml("fallback: { model: f, effort: low }"), other, row("f", "low", "fallback"))).toBe(true)
    // A deliberate choice: escalated, a different rule, a changed config, or no config at all.
    expect(isCopiedDefaultRoute(FULL, other, row("claude-opus-5-5", "medium", "defaults"))).toBe(false)
    expect(isCopiedDefaultRoute(FULL, other, row("defaults-model", "medium", "docs-small-fixes"))).toBe(false)
    expect(isCopiedDefaultRoute(FULL, project, row("defaults-model", "medium", "defaults"))).toBe(false)
    expect(isCopiedDefaultRoute(null, other, row("defaults-model", "medium", "defaults"))).toBe(false)
    expect(isCopiedDefaultRoute(FULL, other, row(null, null, "defaults"))).toBe(false)
  })
})

describe("routing instructions", () => {
  const base = { agentRoutingConfig: "", agentModel: "claude-opus-5-5", agentEffort: "high" as const }

  it("state the precedence and stop asking for model/effort on every create_task", () => {
    const text = routingInstructions(tmpDir(), { ...base, agentRoutingConfig: "defaults:\n  model: claude-sonnet-5-5\n" })
    expect(text).not.toMatch(/choose a model and effort from the routing rules below and pass/)
    expect(text).toMatch(/project.*> Settings › Box agents.*> the routing config's `defaults`, then `fallback` > the built-in claude-opus-5-5 at high/)
    expect(text).toMatch(/Never copy `projects`, `defaults` or `fallback` into create_task/)
    expect(text).toContain("Settings › Box agents now: model claude-opus-5-5, effort high.")
    expect(text).toContain("model: claude-sonnet-5-5")
    expect(routingInstructions(tmpDir(), base)).toMatch(/there are no rules: omit model and effort/)
  })

  it('ask for an effort when Settings leaves it to the Coordinator, and name the owner', () => {
    const text = routingInstructions(tmpDir(), { ...base, agentEffort: "orchestrator", ownerName: "Ana" })
    expect(text).toMatch(/"Let the Coordinator decide": pass an effort on create_task/)
    expect(text).toContain("effort chosen by you")
    expect(text).not.toMatch(/\bCody\b/)
  })
})
