// The text line under a task card's title: the agent's summary, else what it is doing right now, else the gist of the prompt.
import { activityLine } from "../../../shared/activity"
import type { Task, TaskMessage } from "../../../shared/types"

/** Flattens markdown to plain text for card previews; drops the task's own PR URL (shown in the footer) and shortens other URLs. */
export function plainPreview(text: string, prUrl?: string | null): string {
  let t = text
  if (prUrl) t = t.split(prUrl).join("")
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/([^\s/)]+)(\/[^\s)]*)?/g, (_, host: string, path?: string) => {
      const short = host.replace(/^www\./, "") + (path && path !== "/" ? path : "")
      return short.length > 40 ? short.slice(0, 39) + "…" : short
    })
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/\s*:\s*(?=[.,;]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Setup sentences the orchestrator puts at the top of most prompts; they say nothing about the task itself. */
const BOILERPLATE = [
  /^Repo:? \S+( \([^)]*\))?\.?$/i,
  /^Branch (off|from) (the )?(latest )?origin\/main\.?$/i,
  /^(The )?UI (is |lives )?(under|in) \S+\.?$/i,
  /^.{0,40}\(cloned in your folder\)\.?$/i,
]

/** The prompt without its title heading and setup boilerplate: the first real sentence (two if the first is short). */
export function promptGist(prompt: string): string {
  // A leading "# Task: …" heading repeats the card title.
  const body = prompt.replace(/^(\s*#{1,6} [^\n]*\n)+/, "")
  const sentences = plainPreview(body)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !BOILERPLATE.some((re) => re.test(s)))
  const [first = "", second] = sentences
  return first.length < 40 && second ? `${first} ${second}` : first
}

export type CardSummary = { text: string; kind: "summary" | "activity" | "prompt" }

export function cardSummary(task: Pick<Task, "summary" | "activity" | "prompt" | "prUrl">): CardSummary {
  if (task.summary) return { text: plainPreview(task.summary, task.prUrl), kind: "summary" }
  if (task.activity) return { text: task.activity, kind: "activity" }
  return { text: promptGist(task.prompt), kind: "prompt" }
}

/**
 * The task list with a task's `activity` moved on by one transcript message (live, between task events).
 * Returns the same list when nothing changes, so unrelated renders are skipped.
 */
export function withActivity(list: Task[] | undefined, message: TaskMessage): Task[] | undefined {
  if (!list || (message.role !== "assistant" && message.role !== "tool")) return list
  const i = list.findIndex((t) => t.id === message.taskId)
  const task = list[i]
  if (!task || task.summary !== null) return list
  const line = activityLine(message.role, message.content, message.meta)
  if (!line || line === task.activity) return list
  const next = list.slice()
  next[i] = { ...task, activity: line }
  return next
}
