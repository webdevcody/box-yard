// Pure helpers for the Hooks UI (components/Hooks.tsx): the editor's draft and its checks, the live preview's
// variables, and the list and run filters. The matching rules themselves are in shared/hooks.ts.
import {
  HOOK_VARIABLES,
  PR_TRIGGERS,
  SAMPLE_HOOK_VARS,
  hookProblems,
  sourceLabel,
  normalizeFilters,
  unknownVariables,
  type Hook,
  type HookAction,
  type HookFilters,
  type HookRun,
  type HookRunStatus,
  type HookSource,
  type HookTemplate,
  type HookTemplateView,
  type HookTrigger,
  type HookVars,
} from "../../../shared/hooks"
import type { Task } from "../../../shared/types"

/** What POST /api/hooks takes. */
export interface HookInput {
  projectId: string | null
  name: string
  trigger: HookTrigger
  filters: HookFilters
  action: HookAction
  taskTitle: string | null
  prompt: string
  enabled: boolean
  allowSelfTrigger: boolean
  maxFiresPerTask: number
}

/** The editor's state. Labels are comma-separated text; fires per task is the input's text. */
export interface HookDraft {
  name: string
  trigger: HookTrigger
  action: HookAction
  taskTitle: string
  prompt: string
  enabled: boolean
  allowSelfTrigger: boolean
  maxFiresPerTask: string
  /** Global hooks only: "" for every project. */
  projectFilter: string
  titleRegex: string
  promptRegex: string
  sources: HookSource[]
  labels: string
  excludeLabels: string
  includeDrafts: boolean
  includeQuiet: boolean
  template: HookTemplate | null
}

export const emptyDraft = (): HookDraft => ({
  name: "",
  trigger: "task.finished",
  action: "send_to_task",
  taskTitle: "",
  prompt: "",
  enabled: true,
  allowSelfTrigger: false,
  maxFiresPerTask: "3",
  projectFilter: "",
  titleRegex: "",
  promptRegex: "",
  sources: [],
  labels: "",
  excludeLabels: "",
  includeDrafts: false,
  includeQuiet: false,
  template: null,
})

const fromFilters = (f: HookFilters) => ({
  projectFilter: f.projectId ?? "",
  titleRegex: f.titleRegex ?? "",
  promptRegex: f.promptRegex ?? "",
  sources: f.sources ?? [],
  labels: (f.labels ?? []).join(", "),
  excludeLabels: (f.excludeLabels ?? []).join(", "),
  includeDrafts: Boolean(f.includeDrafts),
  includeQuiet: Boolean(f.includeQuiet),
})

export const draftFromHook = (h: Hook): HookDraft => ({
  name: h.name,
  trigger: h.trigger,
  action: h.action,
  taskTitle: h.taskTitle ?? "",
  prompt: h.prompt,
  enabled: h.enabled,
  allowSelfTrigger: h.allowSelfTrigger,
  maxFiresPerTask: String(h.maxFiresPerTask),
  ...fromFilters(h.filters),
  template: h.template,
})

/** A template as a new hook's starting point. Like the server's one-click version, it starts off. */
export const draftFromTemplate = (t: HookTemplateView): HookDraft => ({
  ...emptyDraft(),
  name: t.name,
  trigger: t.trigger,
  action: t.action,
  prompt: t.prompt,
  enabled: false,
  maxFiresPerTask: String(t.maxFiresPerTask),
  ...fromFilters(t.filters),
  template: t.key,
})

/** "a, b,, a" → ["a", "b"]. */
export const splitLabels = (text: string) => [...new Set(text.split(",").map((l) => l.trim()).filter(Boolean))]

export function draftFilters(d: HookDraft, projectScoped: boolean): HookFilters {
  return normalizeFilters({
    projectId: projectScoped ? null : d.projectFilter || null,
    titleRegex: d.titleRegex,
    promptRegex: d.promptRegex,
    sources: d.sources,
    labels: splitLabels(d.labels),
    excludeLabels: splitLabels(d.excludeLabels),
    includeDrafts: d.includeDrafts,
    includeQuiet: d.includeQuiet,
  })
}

export function draftToInput(d: HookDraft, projectId: string | null): HookInput {
  return {
    projectId,
    name: d.name.trim(),
    trigger: d.trigger,
    filters: draftFilters(d, Boolean(projectId)),
    action: d.action,
    taskTitle: d.action === "create_task" ? d.taskTitle.trim() || null : null,
    prompt: d.prompt.trim(),
    enabled: d.enabled,
    allowSelfTrigger: d.allowSelfTrigger,
    maxFiresPerTask: Number(d.maxFiresPerTask),
  }
}

/** What stops the draft from saving, as sentences. */
export function draftProblems(d: HookDraft): string[] {
  const max = Number(d.maxFiresPerTask)
  return hookProblems({
    name: d.name,
    prompt: d.prompt,
    action: d.action,
    taskTitle: d.taskTitle,
    filters: { titleRegex: d.titleRegex, promptRegex: d.promptRegex },
    maxFiresPerTask: d.maxFiresPerTask.trim() === "" ? NaN : max,
  })
}

const PR_VARS = ["pr_number", "pr_url", "head_sha"]

/** Things that probably aren't what was meant, but don't stop a save. */
export function draftWarnings(d: HookDraft): string[] {
  const out: string[] = []
  const text = `${d.prompt}\n${d.action === "create_task" ? d.taskTitle : ""}`
  for (const name of unknownVariables(text)) out.push(`{${name}} isn't a variable, so it's sent as written.`)
  if (!PR_TRIGGERS.includes(d.trigger) && PR_VARS.some((v) => text.includes(`{${v}}`))) out.push("This trigger can fire for tasks without a PR; PR variables are empty then.")
  if (d.allowSelfTrigger) out.push("It can fire on turns its own prompt started. Keep fires per task low so it can't loop for long.")
  return out
}

/** The live preview's values: a real task's (its head commit isn't known here, so it's a sample), or the samples. */
export function previewVars(task: Task | null | undefined, projectName?: string): HookVars {
  if (!task) return SAMPLE_HOOK_VARS
  const pr = /\/pull\/(\d+)/.exec(task.prUrl ?? "")?.[1] ?? ""
  return {
    task_id: task.id,
    task_title: task.title,
    project: projectName ?? task.projectId,
    pr_number: pr,
    pr_url: task.prUrl ?? "",
    branch: task.branch ?? "",
    head_sha: task.prUrl ? SAMPLE_HOOK_VARS.head_sha : "",
    status: task.status,
    summary: task.summary ?? "",
  }
}

/** Insert `{name}` at the cursor (or the end), returning the new text and where the cursor goes. */
export function insertVariable(text: string, name: string, start = text.length, end = start): { text: string; cursor: number } {
  const token = `{${name}}`
  return { text: text.slice(0, start) + token + text.slice(end), cursor: start + token.length }
}

export const isVariable = (name: string) => (HOOK_VARIABLES as readonly string[]).includes(name)

/** Short chips that say what a hook's filters do, in a list row. */
export function filterChips(f: HookFilters, projectName: (id: string) => string | undefined = () => undefined, ownerName?: string): string[] {
  const out: string[] = []
  if (f.projectId) out.push(`Only ${projectName(f.projectId) ?? f.projectId}`)
  if (f.titleRegex) out.push(`Title ~ /${f.titleRegex}/`)
  if (f.promptRegex) out.push(`Prompt ~ /${f.promptRegex}/`)
  if (f.sources?.length) out.push(`Started by ${f.sources.map((s) => sourceLabel(s, ownerName)).join(" or ")}`)
  if (f.labels?.length) out.push(`Label ${f.labels.join(" or ")}`)
  if (f.excludeLabels?.length) out.push(`Not ${f.excludeLabels.join(", ")}`)
  if (f.includeDrafts) out.push("Drafts too")
  if (f.includeQuiet) out.push("Quiet runs too")
  return out
}

export const HOOK_LIST_FILTERS = [
  { key: "all", label: "All" },
  { key: "on", label: "On" },
  { key: "off", label: "Off" },
] as const
export type HookListFilter = (typeof HOOK_LIST_FILTERS)[number]["key"]

export const filterHooks = <T extends Pick<Hook, "enabled">>(hooks: T[], f: HookListFilter) => (f === "all" ? hooks : hooks.filter((h) => h.enabled === (f === "on")))

export const RUN_FILTERS = [
  { key: "all", label: "All" },
  { key: "fired", label: "Fired" },
  { key: "skipped", label: "Skipped" },
  { key: "failed", label: "Failed" },
] as const
export type RunFilter = (typeof RUN_FILTERS)[number]["key"]

export const parseRunFilter = (v: string | null): RunFilter => (RUN_FILTERS.some((f) => f.key === v) ? (v as RunFilter) : "all")

/** Runs for the Recent runs view, newest first as the server sends them. */
export function filterRuns(runs: HookRun[], status: RunFilter, hookId?: string | null): HookRun[] {
  return runs.filter((r) => (status === "all" || r.status === status) && (!hookId || r.hookId === hookId))
}

export function runCounts(runs: HookRun[], hookId?: string | null): Record<RunFilter, number> {
  const mine = hookId ? runs.filter((r) => r.hookId === hookId) : runs
  const count = (s: HookRunStatus) => mine.filter((r) => r.status === s).length
  return { all: mine.length, fired: count("fired"), skipped: count("skipped"), failed: count("failed") }
}
