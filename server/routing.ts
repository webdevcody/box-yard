import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { z } from "zod"
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort, type Project } from "../shared/types.js"
import type { Settings } from "../shared/types.js"
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

export function resolveDefaultRoute(config: RoutingConfig | null, project: Project): RouteChoice {
  if (!config) return { model: null, effort: null, rule: null, reason: null }
  const projectRoute = projectTarget(config, project)
  const base = { ...(config.fallback ?? {}), ...(config.defaults ?? {}) }
  const chosen = { ...base, ...(projectRoute?.target ?? {}) }
  return {
    model: chosen.model ?? null,
    effort: chosen.effort ?? null,
    rule: projectRoute?.name ?? (config.defaults ? "defaults" : config.fallback ? "fallback" : null),
    reason: chosen.reason ?? (projectRoute ? `Default route for ${project.name}.` : config.defaults ? "Global routing default." : config.fallback ? "Global routing fallback." : null),
  }
}

export function routingInstructions(dataDir: string, settings: Pick<Settings, "agentRoutingConfig"> & Partial<Pick<Settings, "ownerName">>): string {
  const loaded = loadRouting(dataDir, settings)
  const owner = (text: string) => withOwner(text, settings.ownerName)
  const parts = [
    owner(`Agent model/effort routing:
- When you call create_task for coding, research or ops work, choose a model and effort from the routing rules below and pass model, effort, routing_rule and routing_reason.
- When you call send_to_task for a follow-up, you may pass a new model/effort for the next turn. Use this to escalate a task that failed, is looping, or outgrew its original cheap route; a resumed Claude session may use a different --model.
- Prefer the lowest capable route. Use project defaults first when they exist, then matching rules, then fallback. If no routing config is present, omit model and effort unless Cody explicitly requests a change.
- Keep routing_reason short and concrete so Cody can see why the task is on that route.`),
  ]
  if (loaded.sources.length) parts.push(`Routing sources: ${loaded.sources.join(", ")}`)
  if (loaded.yaml) parts.push(`Current routing config:\n\`\`\`yaml\n${loaded.yaml}\n\`\`\``)
  else parts.push(`No routing.yaml or Settings routing YAML is configured. Built-in fallback if you must choose: model ${DEFAULT_MODEL}, effort ${DEFAULT_EFFORT}.`)
  if (loaded.errors.length) parts.push(`${owner("Routing config warnings (ignore invalid sources and tell Cody if relevant):")}\n${loaded.errors.map((e) => `- ${e}`).join("\n")}`)
  return parts.join("\n\n")
}
