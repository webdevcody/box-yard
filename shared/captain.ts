import type { CaptainMessage, CaptainSource } from "./types.js"

/**
 * Who sent a Captain an inbound (user-role) message. New rows carry meta.source; for rows from before
 * it, the Captain tab sent client ids (chat_…) while the Coordinator's messages got server ids (cap_…).
 */
export function captainSourceOf(m: Pick<CaptainMessage, "id" | "meta">): CaptainSource {
  const s = m.meta?.source
  if (s === "cody" || s === "coordinator" || s === "schedule") return s
  if (typeof m.meta?.scheduleId === "string") return "schedule"
  return m.id.startsWith("chat_") ? "cody" : "coordinator"
}
