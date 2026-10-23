// Quiet runs: schedule runs whose agent reported that it found nothing to do and changed nothing
// (mark_done with outcome "noop"). They're hidden from Recent, notifications and notices, but
// they still show in the schedule's history, the Boxes page and the command palette.
// The server and the web app share these rules, so they always agree on what counts as quiet.
import type { Task } from "./types.js"

/** What the agent reported about a run. `noop`: nothing to do and nothing changed. */
export const TASK_OUTCOMES = ["noop"] as const
export type TaskOutcome = (typeof TASK_OUTCOMES)[number]

export const parseOutcome = (value: unknown): TaskOutcome | null =>
  (TASK_OUTCOMES as readonly unknown[]).includes(value) ? (value as TaskOutcome) : null

/** What the run actually did, so a noop mark can be checked against it. */
export interface RunEvidence {
  scheduleId: string | null
  status: Task["status"]
  prUrl: string | null
  /** The agent opened or pushed to a PR this turn. */
  sawPr?: boolean
  previews: number
  artifacts: number
  /** The agent called ask_user (this turn or an earlier one). */
  asked: boolean
  /** Commits on the box's branches that aren't on origin's base branch; null when unknown (no repo). */
  commits: number | null
}

/**
 * Why a noop mark doesn't count, or [] when it does. Only finished schedule runs that left
 * nothing behind can be quiet: never failures, questions, PRs, previews, artifacts or commits.
 */
export function noopBlockers(e: RunEvidence): string[] {
  const out: string[] = []
  if (!e.scheduleId) out.push("it isn't a schedule run")
  if (e.status !== "done") out.push(`it ended as ${e.status}`)
  if (e.prUrl || e.sawPr) out.push("it opened or updated a pull request")
  if (e.commits) out.push(`it made ${e.commits} commit${e.commits === 1 ? "" : "s"}`)
  if (e.artifacts) out.push("it published an artifact")
  if (e.previews) out.push("it reported a preview")
  if (e.asked) out.push("it asked Cody a question")
  return out
}

export type QuietFields = Pick<Task, "outcome" | "scheduleId" | "status" | "prUrl" | "previews" | "error" | "question">

/**
 * Is this a quiet run: a done schedule run the server accepted as a no-op? The server only stores the
 * outcome after noopBlockers() came back empty; this re-checks what the task itself shows, so a run
 * that later failed, asked something or got a PR is never hidden.
 */
export function isQuietRun(task: QuietFields): boolean {
  return (
    task.outcome === "noop" &&
    Boolean(task.scheduleId) &&
    task.status === "done" &&
    !task.prUrl &&
    !task.previews.length &&
    !task.error &&
    !task.question
  )
}

/** Drop quiet runs unless `show` is on (the "Show quiet runs" toggle). */
export const withoutQuiet = <T extends QuietFields>(tasks: T[], show = false): T[] => (show ? tasks : tasks.filter((t) => !isQuietRun(t)))
