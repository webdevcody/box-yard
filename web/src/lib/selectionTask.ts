import type { Project, Task } from "../../../shared/types"

/** A safety cap well above any chat message, so a whole message (its toolbar's Respond) is quoted in full. */
const MAX_SELECTED_CHARS = 50_000

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
  | { kind: "captain"; project: SelectionProjectContext }

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

/**
 * The same selection as a prompt for an agent, not a chat to route it: the instructions first, then where the text
 * came from and the full quote. The New task dialog ("More options") starts the task with it directly.
 */
export function buildSelectionTaskBrief(input: { source: SelectionTaskSource; selectedText: string; instructions: string }): string {
  const instructions = input.instructions.trim() || "Follow up on this Box Yard output."
  return [instructions, "", "## Context", ...contextLines(input.source), "", "## Selected output", quote(truncate(input.selectedText.trim(), MAX_SELECTED_CHARS))].join("\n")
}

/** Where the selection's prompt goes, for the toast after sending it. */
export function selectionTarget(source: SelectionTaskSource): string {
  return source.kind === "captain" ? `${source.project.name}'s Captain` : "the Coordinator"
}

function contextLines(source: SelectionTaskSource): string[] {
  const lines: string[] = []
  if (source.project) lines.push(`- Project: ${source.project.name} (${source.project.id})`)
  else lines.push("- Project: unknown; decide from the selected output and existing projects.")
  if (source.kind === "task") {
    lines.push(`- Source task: ${source.task.title} (${source.task.id})`)
    if (source.task.branch) lines.push(`- Source branch: ${source.task.branch}`)
    if (source.task.prUrl) lines.push(`- Source pull request: ${source.task.prUrl}`)
  } else if (source.kind === "captain") {
    lines.push("- Source: the project Captain's chat output")
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
