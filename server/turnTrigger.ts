import type { PrState } from "../shared/types.js"

/**
 * What started a task's turn, recorded on the turn (task_turns.trigger) and in its turn flags.
 *
 * A turn can carry several queued messages. Mixed queues: the turn's trigger is the highest-ranked source among
 * them, in TURN_TRIGGERS order. So a turn is an agent wake only when every message in it came from other agents
 * (message_agent): an agent message plus one from Cody counts as Cody's, and so does one plus a Captain's, the
 * Coordinator's, a hook's, or Box Yard's own ("system") message. Mixed turns notify as usual.
 *
 * A retried turn (interrupted, or cut off by sleep) keeps the trigger of the turn it retries, and Box Yard's own
 * "continue" message doesn't count against it.
 */
export const TURN_TRIGGERS = ["cody", "coordinator", "captain", "hook", "schedule", "system", "agent"] as const
export type TurnTrigger = (typeof TURN_TRIGGERS)[number]

/** The trigger a queued message's source (InputSource) stands for. */
export function inputTrigger(source: string): TurnTrigger {
  if (source === "cody" || source.startsWith("cody:")) return "cody"
  if (source === "orchestrator") return "coordinator"
  if (source.startsWith("captain:")) return "captain"
  if (source.startsWith("hook:")) return "hook"
  if (source === "schedule") return "schedule"
  if (source.startsWith("agent:")) return "agent"
  return "system"
}

/** The trigger of a task's first turn: whoever started the task (tasks.source). */
export function taskTrigger(row: { source: string | null; schedule_id: string | null }): TurnTrigger {
  if (row.schedule_id || row.source === "schedule") return "schedule"
  return row.source ? inputTrigger(row.source) : "cody"
}

/**
 * A turn's trigger from the sources of the messages it carries. `carried` is the trigger of the turn a retry
 * retries; `fallback` is used when the turn carries nothing else (a first turn, or a bare "Continue.").
 */
export function turnTrigger(sources: string[], opts: { carried?: TurnTrigger | null; fallback: TurnTrigger }): TurnTrigger {
  const found = (opts.carried ? sources.filter((s) => s !== "system") : sources).map(inputTrigger)
  if (opts.carried) found.push(opts.carried)
  if (!found.length) return opts.fallback
  return TURN_TRIGGERS.find((t) => found.includes(t))!
}

/** The PR as a turn starts or ends, to tell whether it changed during the turn. */
export const prMark = (row: { pr_url: string | null; pr_state: PrState | null }) => (row.pr_url ? `${row.pr_url}#${row.pr_state ?? "?"}` : "")

/**
 * Whether a finished turn is a quiet agent wake: another agent's message started it, and it ended resting with no
 * real state change. A new or pushed PR, a PR that merged or closed, a failure or a question all notify as usual.
 * A quiet wake's update goes to the project's Captain and the transcript, not the Coordinator chat (or Zen), and
 * task.finished hooks skip it unless they include agent wakes.
 */
export function quietAgentWake(t: { trigger: TurnTrigger | undefined; status: string; sawPr: boolean; prBefore: string | undefined; prAfter: string }): boolean {
  if (t.trigger !== "agent") return false
  if (!["idle", "pr_ready", "done"].includes(t.status)) return false
  if (t.sawPr) return false
  return (t.prBefore ?? "") === t.prAfter
}
