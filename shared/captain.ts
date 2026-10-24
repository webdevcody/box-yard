import type { CaptainMessage, CaptainSource } from "./types.js"

/**
 * Who sent a Captain an inbound (user-role) message. New rows carry meta.source; for rows from before
 * it, the Captain tab sent client ids (chat_…) while the Coordinator's messages got server ids (cap_…).
 */
export function captainSourceOf(m: Pick<CaptainMessage, "id" | "meta">): CaptainSource {
  const s = m.meta?.source
  if (s === "cody" || s === "coordinator" || s === "schedule" || s === "hook" || s === "agent") return s
  if (typeof m.meta?.scheduleId === "string") return "schedule"
  return m.id.startsWith("chat_") ? "cody" : "coordinator"
}

/**
 * message_captain limits. runner/box-runner.mjs keeps its own copy (it runs alone on the box), and
 * test/message-captain.e2e.test.ts checks the two agree.
 */
export const AGENT_CAPTAIN_LIMIT = 5
export const AGENT_CAPTAIN_WINDOW_MS = 10 * 60_000
/** The longest an agent's message_captain may wait for the reply, like ask_captain/wait_for_captain. */
export const AGENT_CAPTAIN_WAIT_MAX_SECONDS = 60

/** "From task "Fix login" (task_abc123)", the label a Captain and its tab give an agent's message. */
export function agentCaptainLabel(meta: Record<string, unknown> | null | undefined): string {
  const id = typeof meta?.taskId === "string" ? meta.taskId : "an unknown task"
  const title = typeof meta?.taskTitle === "string" && meta.taskTitle.trim() ? meta.taskTitle : null
  return title ? `From task "${title}" (${id})` : `From task ${id}`
}
