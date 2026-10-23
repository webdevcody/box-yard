import type { Project, Task } from "../../../shared/types"

const MAX_SELECTED_CHARS = 12_000

export interface SelectionProjectContext {
  id: string
  name: string
}

export interface SelectionTaskContext {
  id: string
  title: string
  branch: string | null
  prUrl: string | null
}

export type SelectionTaskSource =
  | { kind: "task"; project: SelectionProjectContext; task: SelectionTaskContext }
  | { kind: "orchestrator"; project?: SelectionProjectContext | null }

export function projectContext(project: Project | null | undefined): SelectionProjectContext | null {
  return project ? { id: project.id, name: project.name } : null
}

export function taskContext(task: Task | null | undefined): SelectionTaskContext | null {
  return task ? { id: task.id, title: task.title, branch: task.branch, prUrl: task.prUrl } : null
}

export function buildSelectionTaskPrompt(input: { source: SelectionTaskSource; selectedText: string; instructions: string; ownerName?: string }): string {
  const selected = truncate(input.selectedText.trim(), MAX_SELECTED_CHARS)
  const lines = [
    "Start a new task from this selected Box Yard output. Route it through your normal Box Yard placement rules: create a new task in the relevant project unless an existing task is clearly the better place to continue.",
    "",
    "## Context",
    ...contextLines(input.source),
    "",
    "## Selected output",
    quote(selected),
  ]
  const instructions = input.instructions.trim()
  if (instructions) lines.push("", `## ${input.ownerName ?? "Cody"}'s additional instructions`, instructions)
  return lines.join("\n")
}

function contextLines(source: SelectionTaskSource): string[] {
  const lines: string[] = []
  if (source.project) lines.push(`- Project: ${source.project.name} (${source.project.id})`)
  else lines.push("- Project: unknown; decide from the selected output and existing projects.")
  if (source.kind === "task") {
    lines.push(`- Source task: ${source.task.title} (${source.task.id})`)
    if (source.task.branch) lines.push(`- Source branch: ${source.task.branch}`)
    if (source.task.prUrl) lines.push(`- Source pull request: ${source.task.prUrl}`)
  } else {
    lines.push("- Source: orchestrator chat output")
  }
  return lines
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[Selection truncated by Box Yard.]` : text
}
