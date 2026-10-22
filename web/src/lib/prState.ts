// How a task's pull request reads in the UI: GitHub's open / draft / merged / closed. Pure, so it is unit tested.
import type { PrState, Task, TaskStatus } from "../../../shared/types"

export type PrTask = Pick<Task, "prUrl" | "prState" | "prMergedAt" | "prMergedBy">

export const prNumber = (url: string | null | undefined) => /\/pull\/(\d+)/.exec(url ?? "")?.[1] ?? null

/** A PR the server hasn't checked yet (or can't, e.g. in mock mode) reads as open. */
export const prStateOf = (task: Pick<Task, "prUrl" | "prState">): PrState | null => (task.prUrl ? (task.prState ?? "open") : null)

const ago = (ts: number, now: number) => {
  const m = Math.round(Math.max(0, now - ts) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function prLabel(task: PrTask): string | null {
  const state = prStateOf(task)
  if (!state) return null
  const n = prNumber(task.prUrl)
  const num = n ? ` #${n}` : ""
  return state === "merged" ? `Merged${num}` : state === "closed" ? `Closed${num}` : state === "draft" ? `Draft${num}` : `PR${num}`
}

/** Tooltip, e.g. "Merged 12m ago by cody". */
export function prTooltip(task: PrTask, now = Date.now()): string | null {
  const state = prStateOf(task)
  if (!state) return null
  const head =
    state === "merged"
      ? ["Merged", task.prMergedAt ? ago(task.prMergedAt, now) : "", task.prMergedBy ? `by ${task.prMergedBy}` : ""].filter(Boolean).join(" ")
      : state === "closed"
        ? "Closed without merging"
        : state === "draft"
          ? "Draft pull request"
          : "Open pull request"
  return `${head}\n${task.prUrl}`
}

/** The status pill to show: "merged" for a task that is done because its PR merged, else the task's status. */
export type BadgeStatus = TaskStatus | "merged"
export const badgeStatus = (task: Pick<Task, "status" | "prUrl" | "prState">): BadgeStatus =>
  task.status === "done" && task.prUrl && task.prState === "merged" ? "merged" : task.status
