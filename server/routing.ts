import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { z } from "zod"
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort, type Project } from "../shared/types.js"
import type { SettingSource, Settings } from "../shared/types.js"
import { withOwner } from "../shared/owner.js"

export const ROUTING_FILENAMES = ["routing.yaml", "routing.yml"] as const

const model = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\[\]/-]+$/, "Model names have no spaces")
const target = z
  .object({
    model: model.optional(),
    effort: z.enum(EFFORTS).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()

const rule = target
  .extend({
    name: z.string().min(1).max(120).optional(),
    id: z.string().min(1).max(120).optional(),
    when: z.union([z.string(), z.array(z.string())]).optional(),
    description: z.string().max(2000).optional(),
    project: z.string().max(200).optional(),
    projects: z.array(z.string().max(200)).optional(),
  })
  .passthrough()

export const routingConfigSchema = z
  .object({
    fallback: target.optional(),
    defaults: target.optional(),
    projects: z.record(z.string(), target).optional(),
    rules: z.array(rule).optional(),
  })
  .passthrough()

export type RoutingConfig = z.infer<typeof routingConfigSchema>

export interface RouteChoice {
  model: string | null
  effort: Effort | null
  rule: string | null
  reason: string | null
}

interface LoadedRouting {
  config: RoutingConfig | null
  yaml: string
  sources: string[]
  errors: string[]
}

const cleanYaml = (value: unknown) => YAML.stringify(value ?? {}).trim()

function parseRouting(text: string, source: string): { config: RoutingConfig | null; error?: string } {
  try {
    const parsed = YAML.parse(text) ?? {}
    const checked = routingConfigSchema.safeParse(parsed)
    if (!checked.success) return { config: null, error: `${source}: ${checked.error.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ")}` }
    return { config: checked.data }
  } catch (err) {
    return { config: null, error: `${source}: ${(err as Error).message}` }
  }
}

/** Only keys either side has: an empty `defaults: {}` would make resolveDefaultRoute name the route "defaults". */
function mergeRouting(base: RoutingConfig | null, next: RoutingConfig): RoutingConfig {
  if (!base) return next
  const either = (key: keyof RoutingConfig) => base[key] !== undefined || next[key] !== undefined
  return {
    ...base,
    ...next,
    ...(either("fallback") ? { fallback: { ...base.fallback, ...next.fallback } } : {}),
    ...(either("defaults") ? { defaults: { ...base.defaults, ...next.defaults } } : {}),
    ...(either("projects") ? { projects: { ...base.projects, ...next.projects } } : {}),
    ...(either("rules") ? { rules: [...(base.rules ?? []), ...(next.rules ?? [])] } : {}),
  }
}

export function loadRouting(dataDir: string, settings: Pick<Settings, "agentRoutingConfig">): LoadedRouting {
  const errors: string[] = []
  const sources: string[] = []
  let config: RoutingConfig | null = null

  for (const name of ROUTING_FILENAMES) {
    const file = path.join(dataDir, name)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8")
    const parsed = parseRouting(text, file)
    if (parsed.config) {
      config = mergeRouting(config, parsed.config)
      sources.push(file)
    }
    if (parsed.error) errors.push(parsed.error)
    break
  }

  const settingsText = settings.agentRoutingConfig.trim()
  if (settingsText) {
    const parsed = parseRouting(settingsText, "Settings routing YAML")
    if (parsed.config) {
      config = mergeRouting(config, parsed.config)
      sources.push("Settings")
    }
    if (parsed.error) errors.push(parsed.error)
  }

  return { config, yaml: config ? cleanYaml(config) : "", sources, errors }
}

function projectTarget(config: RoutingConfig, project: Project): { name: string; target: z.infer<typeof target> } | null {
  const projects = config.projects ?? {}
  for (const key of [project.id, project.name, project.repo].filter(Boolean) as string[]) {
    const found = projects[key]
    if (found) return { name: `project:${key}`, target: found }
  }
  return null
}

/** Where a turn's model or effort came from, highest precedence first (see resolveAgentRoute). */
export const ROUTE_LAYERS = ["task", "project", "settings", "defaults", "fallback", "builtin"] as const
export type RouteLayer = (typeof ROUTE_LAYERS)[number]

export interface AgentRoute {
  model: string
  effort: Effort
  /** Rule and reason of the highest layer that chose the model or effort (null for Settings and the built-in default). */
  rule: string | null
  reason: string | null
  modelFrom: RouteLayer
  effortFrom: RouteLayer
}

const has = (t: z.infer<typeof target> | undefined): t is z.infer<typeof target> => Boolean(t && (t.model || t.effort))

/**
 * The model and effort a task's next turn runs on. Model and effort are picked separately; the first layer
 * that sets one wins:
 *
 * 1. task: an explicit choice on the task (create_task / send_to_task / set_task_model params, stored on the task row)
 * 2. project: the routing YAML's `projects.<id | name | repo>` entry
 * 3. settings: Settings › Box agents Model/Effort when saved in the UI, or WORKER_MODEL (not when left at the
 *    built-in default; effort "Let the Coordinator decide" sets none)
 * 4. defaults, then 5. fallback: the routing YAML's global entries
 * 6. builtin: DEFAULT_MODEL at DEFAULT_EFFORT (claude-opus-5-5, high)
 *
 * Only layer 1 is stored on the task; the rest are read every turn, so a Settings or YAML change reaches existing
 * tasks from their next turn on.
 */
export function resolveAgentRoute(input: {
  task: { model: string | null; effort: Effort | null; routingRule?: string | null; routingReason?: string | null }
  config: RoutingConfig | null
  project: Project
  settings: Pick<Settings, "agentModel" | "agentEffort">
  sources: Partial<Record<"agentModel" | "agentEffort", SettingSource>>
}): AgentRoute {
  const { task, config, project, settings, sources } = input
  const projectRoute = config ? projectTarget(config, project) : null
  const layers: { layer: RouteLayer; model?: string | null; effort?: Effort | null; rule: string | null; reason: string | null }[] = [
    { layer: "task", model: task.model, effort: task.effort, rule: task.routingRule ?? null, reason: task.routingReason ?? null },
    { layer: "project", ...projectRoute?.target, rule: projectRoute?.name ?? null, reason: projectRoute ? (projectRoute.target.reason ?? `Default route for ${project.name}.`) : null },
    {
      layer: "settings",
      model: sources.agentModel && sources.agentModel !== "default" ? settings.agentModel : null,
      effort: sources.agentEffort && sources.agentEffort !== "default" && settings.agentEffort !== "orchestrator" ? settings.agentEffort : null,
      rule: null,
      reason: null,
    },
    { layer: "defaults", ...(has(config?.defaults) ? config.defaults : {}), rule: "defaults", reason: config?.defaults?.reason ?? "Global routing default." },
    { layer: "fallback", ...(has(config?.fallback) ? config.fallback : {}), rule: "fallback", reason: config?.fallback?.reason ?? "Global routing fallback." },
    { layer: "builtin", model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, rule: null, reason: null },
  ]
  const m = layers.find((l) => l.model)!
  const e = layers.find((l) => l.effort)!
  const top = ROUTE_LAYERS.indexOf(m.layer) <= ROUTE_LAYERS.indexOf(e.layer) ? m : e
  // A rule or reason saved on the task (set_task_model can set just those) labels whichever layer chose the route.
  const explicit = task.routingRule || task.routingReason
  return {
    model: m.model!,
    effort: e.effort!,
    rule: explicit ? (task.routingRule ?? null) : top.rule,
    reason: explicit ? (task.routingReason ?? null) : top.reason,
    modelFrom: m.layer,
    effortFrom: e.layer,
  }
}

/**
 * Before #44, a new task stored the YAML's merged fallback → defaults → project route on its row as if it were
 * an explicit choice, which then beat Settings on every turn. True when a row still holds exactly that copy
 * (same rule name, model and effort as the current config gives), so it can be cleared and resolved per turn.
 */
export function isCopiedDefaultRoute(
  config: RoutingConfig | null,
  project: Project,
  row: { model: string | null; effort: Effort | null; routing_rule: string | null },
): boolean {
  if (!config || !row.routing_rule || !(row.model || row.effort)) return false
  const projectRoute = projectTarget(config, project)
  const chosen = { ...(config.fallback ?? {}), ...(config.defaults ?? {}), ...(projectRoute?.target ?? {}) }
  const rule = projectRoute?.name ?? (config.defaults ? "defaults" : config.fallback ? "fallback" : null)
  return row.routing_rule === rule && row.model === (chosen.model ?? null) && row.effort === (chosen.effort ?? null)
}

export function routingInstructions(
  dataDir: string,
  settings: Pick<Settings, "agentRoutingConfig"> & Partial<Pick<Settings, "ownerName" | "agentModel" | "agentEffort">>,
): string {
  const loaded = loadRouting(dataDir, settings)
  const owner = (text: string) => withOwner(text, settings.ownerName)
  const coordinatorEffort = settings.agentEffort === "orchestrator"
  const parts = [
    owner(`Agent model/effort routing:
- Box Yard picks every task turn's model and effort itself, in this order (first match wins, model and effort separately): the task's own model/effort (what you pass to create_task, send_to_task or set_task_model) > the routing config's \`projects\` entry for the task's project > Settings › Box agents (or WORKER_MODEL) > the routing config's \`defaults\`, then \`fallback\` > the built-in ${DEFAULT_MODEL} at ${DEFAULT_EFFORT} effort. It re-reads all of them every turn.
- So omit model and effort on create_task unless a \`rules\` entry below matches the work or Cody asks for a specific model or effort${coordinatorEffort ? " (and pass an effort, see below)" : ""}. Never copy \`projects\`, \`defaults\` or \`fallback\` into create_task: anything you pass pins the task and overrides Cody's Settings.
- When a rule matches, pass its model and/or effort with routing_rule (the rule's name) and a short, concrete routing_reason so Cody can see why the task is on that route.
- When you call send_to_task for a follow-up, you may pass a new model/effort for the next turn. Use this to escalate a task that failed, is looping, or outgrew its original cheap route; a resumed Claude session may use a different --model.`),
  ]
  if (coordinatorEffort) parts.push(owner("Settings › Box agents › Effort is \"Let the Coordinator decide\": pass an effort on create_task (low for one-command chores, high for real coding). Without one, the routing config or the built-in default applies."))
  if (settings.agentModel || settings.agentEffort) parts.push(`Settings › Box agents now: model ${settings.agentModel ?? DEFAULT_MODEL}, effort ${coordinatorEffort ? "chosen by you" : (settings.agentEffort ?? DEFAULT_EFFORT)}.`)
  if (loaded.sources.length) parts.push(`Routing sources: ${loaded.sources.join(", ")}`)
  if (loaded.yaml) parts.push(`Current routing config:\n\`\`\`yaml\n${loaded.yaml}\n\`\`\``)
  else parts.push(owner("No routing.yaml or Settings routing YAML is configured, so there are no rules: omit model and effort unless Cody asks."))
  if (loaded.errors.length) parts.push(`${owner("Routing config warnings (ignore invalid sources and tell Cody if relevant):")}\n${loaded.errors.map((e) => `- ${e}`).join("\n")}`)
  return parts.join("\n\n")
}
