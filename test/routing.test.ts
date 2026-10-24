import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { isCopiedDefaultRoute, loadRouting, resolveAgentRoute, routingConfigSchema, routingInstructions, type RoutingConfig } from "../server/routing.js"
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

// loadRouting and the prompt's sources and warnings (#50).

const dataDir = (files: Record<string, string> = {}) => {
  const dir = tmpDir()
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}
const settings = (agentRoutingConfig = "") => ({ agentRoutingConfig })
const routedHere = () => ({ id: "prj_demo01", name: "demo", repo: "acme/demo" }) as Project

describe("loadRouting", () => {
  it("returns nothing when no routing is configured", () => {
    expect(loadRouting(dataDir(), settings())).toEqual({ config: null, yaml: "", sources: [], errors: [] })
    expect(loadRouting(dataDir(), settings("  \n"))).toEqual({ config: null, yaml: "", sources: [], errors: [] })
  })

  it("reads routing.yaml from the data dir, else routing.yml, but never both", () => {
    const yml = dataDir({ "routing.yml": "fallback:\n  model: claude-haiku-5-5\n" })
    expect(loadRouting(yml, settings())).toMatchObject({ config: { fallback: { model: "claude-haiku-5-5" } }, sources: [path.join(yml, "routing.yml")], errors: [] })

    const both = dataDir({ "routing.yaml": "fallback:\n  model: claude-sonnet-5-5\n", "routing.yml": "defaults:\n  effort: low\n" })
    const loaded = loadRouting(both, settings())
    expect(loaded.sources).toEqual([path.join(both, "routing.yaml")])
    expect(loaded.config).toEqual({ fallback: { model: "claude-sonnet-5-5" } })
  })

  it("doesn't fall back to routing.yml when routing.yaml is invalid", () => {
    const dir = dataDir({ "routing.yaml": "fallback: [unclosed", "routing.yml": "fallback:\n  model: claude-haiku-5-5\n" })
    const loaded = loadRouting(dir, settings())
    expect(loaded.config).toBeNull()
    expect(loaded.sources).toEqual([])
    expect(loaded.errors).toHaveLength(1)
    expect(loaded.errors[0]!.startsWith(`${path.join(dir, "routing.yaml")}: `)).toBe(true)
  })

  it("merges the Settings YAML over the file: targets key by key, projects by name, rules appended", () => {
    const dir = dataDir({
      "routing.yaml": [
        "fallback: { model: claude-haiku-5-5, effort: low }",
        "defaults: { model: claude-sonnet-5-5, reason: cheap first }",
        "projects:",
        "  demo: { effort: medium }",
        "  docs: { model: claude-haiku-5-5 }",
        "rules:",
        "  - { name: file rule, when: bug fixes, model: claude-opus-5-5 }",
      ].join("\n"),
    })
    const loaded = loadRouting(
      dir,
      settings(["fallback: { effort: medium }", "defaults: { effort: high }", "projects:", "  demo: { model: claude-opus-5-5 }", "rules:", "  - { name: settings rule, effort: max }"].join("\n")),
    )
    expect(loaded.errors).toEqual([])
    expect(loaded.sources).toEqual([path.join(dir, "routing.yaml"), "Settings"])
    expect(loaded.config).toEqual({
      fallback: { model: "claude-haiku-5-5", effort: "medium" },
      defaults: { model: "claude-sonnet-5-5", effort: "high", reason: "cheap first" },
      // A project entry from Settings replaces the file's entry for that project as a whole.
      projects: { demo: { model: "claude-opus-5-5" }, docs: { model: "claude-haiku-5-5" } },
      rules: [
        { name: "file rule", when: "bug fixes", model: "claude-opus-5-5" },
        { name: "settings rule", effort: "max" },
      ],
    })
    // The merged config is what the prompt shows.
    expect(loaded.yaml).toContain("settings rule")
    expect(loaded.yaml).toContain("file rule")
  })

  it("adds no empty sections when merging, so a file's fallback stays the fallback", () => {
    const dir = dataDir({ "routing.yaml": "fallback:\n  model: claude-haiku-5-5\n" })
    const loaded = loadRouting(dir, settings("projects:\n  docs:\n    effort: low\n"))
    expect(loaded.config).toEqual({ fallback: { model: "claude-haiku-5-5" }, projects: { docs: { effort: "low" } } })
    expect(loaded.yaml).toBe("fallback:\n  model: claude-haiku-5-5\nprojects:\n  docs:\n    effort: low")
    // A pre-#44 row holding a copy of the fallback route is still recognized as one.
    expect(isCopiedDefaultRoute(loaded.config, routedHere(), { model: "claude-haiku-5-5", effort: null, routing_rule: "fallback" })).toBe(true)
  })

  it("keeps a valid source when the other is broken, and names the broken one", () => {
    const dir = dataDir({ "routing.yaml": "defaults:\n  model: claude-sonnet-5-5\n" })
    const loaded = loadRouting(dir, settings("defaults:\n  effort: extreme\n"))
    expect(loaded.config).toEqual({ defaults: { model: "claude-sonnet-5-5" } })
    expect(loaded.sources).toEqual([path.join(dir, "routing.yaml")])
    expect(loaded.errors).toHaveLength(1)
    expect(loaded.errors[0]).toMatch(/^Settings routing YAML: defaults\.effort /)
  })

  it("validates targets strictly and says where the problem is", () => {
    const err = (yaml: string) => loadRouting(dataDir(), settings(yaml)).errors
    expect(err("fallback:\n  model: claude opus\n")[0]).toMatch(/fallback\.model Model names have no spaces/)
    expect(err("projects:\n  demo:\n    effort: turbo\n")[0]).toMatch(/projects\.demo\.effort /)
    expect(err("defaults:\n  modle: claude-opus-5-5\n")[0]).toMatch(/defaults .*modle/)
    expect(err("rules: nope\n")[0]).toMatch(/^Settings routing YAML: rules /)
    expect(err("- just\n- a list\n")[0]).toMatch(/^Settings routing YAML: root /)
  })

  it("lets rules and the top level carry extra keys, and accepts provider model ids", () => {
    const loaded = loadRouting(
      dataDir(),
      settings("version: 2\nfallback:\n  model: us.anthropic.claude-opus-5-5[1m]\nrules:\n  - name: tagged\n    tags: [infra]\n    when: [deploys, outages]\n"),
    )
    expect(loaded.errors).toEqual([])
    expect(loaded.config).toEqual({
      version: 2,
      fallback: { model: "us.anthropic.claude-opus-5-5[1m]" },
      rules: [{ name: "tagged", tags: ["infra"], when: ["deploys", "outages"] }],
    })
  })
})

describe("routing instructions: sources and warnings", () => {
  it("lists the sources and the merged config as YAML", () => {
    const dir = dataDir({ "routing.yaml": "fallback:\n  model: claude-haiku-5-5\n" })
    const text = routingInstructions(dir, settings("defaults:\n  effort: high\n"))
    expect(text).toContain(`Routing sources: ${path.join(dir, "routing.yaml")}, Settings`)
    expect(text).toContain("Current routing config:\n```yaml\nfallback:\n  model: claude-haiku-5-5\ndefaults:\n  effort: high\n```")
    expect(text).not.toContain("there are no rules")
  })

  it("passes on config errors as warnings, addressed to the owner", () => {
    const text = routingInstructions(dataDir({ "routing.yaml": "fallback: [unclosed" }), { agentRoutingConfig: "", ownerName: "Ana" })
    expect(text).toContain("Routing config warnings (ignore invalid sources and tell Ana if relevant):\n- ")
    expect(text).toContain("routing.yaml: ")
    expect(text).toContain("there are no rules")
  })
})
