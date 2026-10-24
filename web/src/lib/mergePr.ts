// The "Merge PR" button: when it shows, what it says, and the client half of the duplicate-send guard.
// The server refuses a second request while one is pending too (POST /api/tasks/:id/merge answers 409).
import { useSyncExternalStore } from "react"
import type { Task } from "../../../shared/types"
import { prNumber, prStateOf } from "./prState"

export type MergeTask = Pick<Task, "id" | "status" | "prUrl" | "prState" | "mergeRequest">

/**
 * hidden: no open PR (none, merged, closed or a draft) · ready: can send · sending: the request is in flight ·
 * queued: sent, waiting for the agent's current turn to end · requested: the agent is on it.
 */
export type MergeButtonState = "hidden" | "ready" | "sending" | "queued" | "requested"

/** Only an open GitHub PR can be merged from the button. A PR the server hasn't checked yet reads as open. */
export const canRequestMerge = (task: Pick<Task, "prUrl" | "prState">) => prStateOf(task) === "open" && prNumber(task.prUrl) !== null

export function mergeButtonState(task: MergeTask, sending: ReadonlySet<string> = inFlight): MergeButtonState {
  const state = prStateOf(task)
  if (state === "merged" || state === "closed" || !task.prUrl) return "hidden"
  // A pending request outlives a PR turning draft: the agent is still on it.
  if (task.mergeRequest) return task.mergeRequest.deliveredAt === null ? "queued" : "requested"
  if (!canRequestMerge(task)) return "hidden"
  return sending.has(mergeKey(task)) ? "sending" : "ready"
}

export const MERGE_LABEL: Record<Exclude<MergeButtonState, "hidden">, string> = {
  ready: "Merge PR",
  sending: "Sending…",
  queued: "Merge queued",
  requested: "Merge requested…",
}

/** The same states as a suffix on the task header's PR chip ("PR #76 · merging…"). */
export const MERGE_CHIP_LABEL: Record<Exclude<MergeButtonState, "hidden" | "ready">, string> = {
  sending: "sending…",
  queued: "merge queued",
  requested: "merging…",
}

export const mergeTitle = (task: Pick<Task, "title">) => `Send merge request to "${task.title}"?`

export const mergeBody = (task: Pick<Task, "prUrl">) =>
  `The agent merges the latest base branch into its branch, runs the checks and merges PR #${prNumber(task.prUrl) ?? "?"} with --match-head-commit, or comments the error on the PR and reports it. If it is mid-turn, the request waits for that turn to end. The project Captain and the Coordinator are told.`

// ------------------------------------------------------------- client duplicate guard

const mergeKey = (task: Pick<Task, "id" | "prUrl">) => `${task.id}#${prNumber(task.prUrl) ?? ""}`

let inFlight: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const set = (next: Set<string>) => {
  inFlight = next
  listeners.forEach((l) => l())
}

/**
 * Run `send` unless a request for the same task and PR is already in flight (another button, a double click).
 * Resolves false when it didn't send.
 */
export async function sendMergeOnce(task: MergeTask, send: () => Promise<unknown>): Promise<boolean> {
  const key = mergeKey(task)
  if (inFlight.has(key) || mergeButtonState(task) !== "ready") return false
  set(new Set(inFlight).add(key))
  try {
    await send()
    return true
  } finally {
    const next = new Set(inFlight)
    next.delete(key)
    set(next)
  }
}

export function useMergesInFlight(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => inFlight,
  )
}
