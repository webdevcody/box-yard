import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { loadRouting, resolveDefaultRoute, routingInstructions, type RoutingConfig } from "../server/routing.js"
import { DEFAULT_EFFORT, DEFAULT_MODEL, type Project } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// server/routing.ts (#50): the routing YAML from the data dir and Settings, the default route a new
// task gets, and the routing section of the Coordinator and Captain prompts.

const dataDir = (files: Record<string, string> = {}) => {
  const dir = tmpDir()
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}
const settings = (agentRoutingConfig = "") => ({ agentRoutingConfig })
const project = (over: Partial<Project> = {}) => ({ id: "prj_demo01", name: "demo", repo: "acme/demo", ...over }) as Project

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
    expect(resolveDefaultRoute(loaded.config, project())).toEqual({ model: "claude-haiku-5-5", effort: null, rule: "fallback", reason: "Global routing fallback." })
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

describe("resolveDefaultRoute", () => {
  const route = (config: RoutingConfig | null, p = project()) => resolveDefaultRoute(config, p)

  it("chooses nothing without a config, or with only rules (the model picks those)", () => {
    const none = { model: null, effort: null, rule: null, reason: null }
    expect(route(null)).toEqual(none)
    expect(route({ rules: [{ name: "big work", model: "claude-opus-5-5" }] })).toEqual(none)
  })

  it("uses the fallback, then the defaults over it, key by key", () => {
    expect(route({ fallback: { model: "claude-haiku-5-5", effort: "low" } })).toEqual({
      model: "claude-haiku-5-5",
      effort: "low",
      rule: "fallback",
      reason: "Global routing fallback.",
    })
    expect(route({ fallback: { model: "claude-haiku-5-5", effort: "low" }, defaults: { effort: "high" } })).toEqual({
      model: "claude-haiku-5-5",
      effort: "high",
      rule: "defaults",
      reason: "Global routing default.",
    })
  })

  it("lets a project route override the defaults and names it", () => {
    const config: RoutingConfig = { defaults: { model: "claude-sonnet-5-5", effort: "medium" }, projects: { demo: { model: "claude-opus-5-5" } } }
    expect(route(config)).toEqual({ model: "claude-opus-5-5", effort: "medium", rule: "project:demo", reason: "Default route for demo." })
    expect(route({ projects: { demo: { effort: "max", reason: "hard repo" } } })).toEqual({ model: null, effort: "max", rule: "project:demo", reason: "hard repo" })
    // Other projects keep the defaults.
    expect(route(config, project({ id: "prj_other01", name: "other", repo: "acme/other" }))).toMatchObject({ model: "claude-sonnet-5-5", rule: "defaults" })
  })

  it("finds the project by id, then name, then repo", () => {
    const projects = { "acme/demo": { model: "by-repo" }, demo: { model: "by-name" }, prj_demo01: { model: "by-id" } }
    expect(route({ projects })).toMatchObject({ model: "by-id", rule: "project:prj_demo01" })
    const { prj_demo01: _id, ...nameOrRepo } = projects
    expect(route({ projects: nameOrRepo })).toMatchObject({ model: "by-name", rule: "project:demo" })
    expect(route({ projects: { "acme/demo": projects["acme/demo"] } })).toMatchObject({ model: "by-repo", rule: "project:acme/demo" })
    expect(route({ projects: { "acme/demo": projects["acme/demo"] } }, project({ repo: null }))).toMatchObject({ model: null, rule: null })
  })

  it("keeps a reason given in the YAML", () => {
    expect(route({ fallback: { model: "claude-haiku-5-5", reason: "cheapest" } }).reason).toBe("cheapest")
    expect(route({ defaults: { effort: "low", reason: "most work is small" } }).reason).toBe("most work is small")
  })
})

describe("routingInstructions", () => {
  it("gives the built-in fallback when nothing is configured", () => {
    const text = routingInstructions(dataDir(), settings())
    expect(text).toMatch(/^Agent model\/effort routing:/)
    expect(text).toContain(`No routing.yaml or Settings routing YAML is configured. Built-in fallback if you must choose: model ${DEFAULT_MODEL}, effort ${DEFAULT_EFFORT}.`)
    expect(text).not.toContain("Routing sources:")
    expect(text).not.toContain("warnings")
  })

  it("lists the sources and the merged config as YAML", () => {
    const dir = dataDir({ "routing.yaml": "fallback:\n  model: claude-haiku-5-5\n" })
    const text = routingInstructions(dir, settings("defaults:\n  effort: high\n"))
    expect(text).toContain(`Routing sources: ${path.join(dir, "routing.yaml")}, Settings`)
    expect(text).toContain("Current routing config:\n```yaml\nfallback:\n  model: claude-haiku-5-5\ndefaults:\n  effort: high\n```")
    expect(text).not.toContain("Built-in fallback")
  })

  it("passes on config errors as warnings, addressed to the owner", () => {
    const text = routingInstructions(dataDir({ "routing.yaml": "fallback: [unclosed" }), { agentRoutingConfig: "", ownerName: "Ana" })
    expect(text).toContain("Routing config warnings (ignore invalid sources and tell Ana if relevant):\n- ")
    expect(text).toContain("routing.yaml: ")
    expect(text).toContain("Built-in fallback")
  })
})
