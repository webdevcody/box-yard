// The task details' Git row: whether the task's code is on origin after its last turn (server/gitFirst.ts).
import type { PushState } from "../../../shared/types"

/** One line on the last turn-end push, and how much it needs a look. */
export function pushStateLine(p: PushState): { text: string; tone: "ok" | "muted" | "warn" } {
  if (p.status === "pushed") return { text: p.wip ? "Pushed, with uncommitted work on a hidden ref" : "Pushed, nothing uncommitted", tone: "ok" }
  const why = p.reason ? `: ${p.reason}` : ""
  // Skipped is expected (no write access, a merge in progress); either way archives keep the whole workspace.
  return { text: `${p.status === "skipped" ? "Not pushed" : "Push failed"}${why}. Archives keep the whole workspace.`, tone: p.status === "skipped" ? "muted" : "warn" }
}
