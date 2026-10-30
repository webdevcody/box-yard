// Sending a task-chat message to the project's Captain instead of the task's agent (POST /api/tasks/:id/captain).
// A busy agent reads a queued message only when its turn ends, and can't split, reprioritise or start tasks anyway;
// the Captain can, now. The composer offers it while the task is busy or has queued messages, and suggests it when a
// draft reads like task management. It never reroutes on its own: Cody taps to send there.
import type { Task } from "../../../shared/types"

/**
 * Phrases that are about managing tasks rather than the work itself. Kept narrow on purpose: a false "send to the
 * Captain?" is a nag on every keystroke, and a missed one costs nothing (the chip is always there). Plain regexes,
 * not a model call: instant on each keystroke, free, offline, and the same answer every time (test/captain-forward).
 */
const TASK_MANAGEMENT: RegExp[] = [
  // "split this out", "split off the docs part", "spin that off into its own task"
  /\b(split|spin|carve)\s+(\w+\s+){0,4}?(out|off)\b/,
  /\b(split|break)\s+(\w+\s+){0,3}?into\s+(\w+\s+){0,2}?(tasks?|prs?)\b/,
  // "a new task", "a separate task", "its own task", "another task for"
  /\b(new|separate|another|its own|their own)\s+tasks?\b/,
  /\b(start|create|open|make|kick off)\s+(a|an|one more)\s+(\w+\s+)?tasks?\b/,
  // "move this to task_abc", "move the dark mode item to the other task"
  /\b(move|hand|give|pass|reassign)\s+(\w+\s+){0,5}?(to|over to|into)\s+(\w+\s+){0,2}?(task|task_\w+|agent)\b/,
  // "reprioritise", "make it high priority", "deprioritize the docs"
  /\b(re|de)?prioriti[sz](e|ed|ing|ation)\b/,
  /\b(high|higher|low|lower|top|bump)\s+(the\s+)?priority\b/,
  /\bpriority\s+(up|down|to)\b/,
  // "what's queued here", "cancel the queued message", "clear the queue"
  /\bwhat('?s| is| are)\s+(\w+\s+){0,2}?queued\b/,
  /\b(cancel|delete|drop|remove|clear|edit|reorder)\s+(\w+\s+){0,3}?(queued|queue)\b/,
  /\bqueued messages?\b/,
]

/** True when a draft clearly reads like task management (split, move, reprioritise, new task, the queue). */
export function looksLikeTaskManagement(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'")
  if (t.trim().length < 8) return false
  return TASK_MANAGEMENT.some((re) => re.test(t))
}

/** Whether the task chat offers "→ Captain": its agent is (about to be) busy, or messages are waiting for it. */
export function offersCaptain(task: Pick<Task, "status">, queued: number): boolean {
  return task.status === "working" || task.status === "starting" || task.status === "queued" || queued > 0
}
