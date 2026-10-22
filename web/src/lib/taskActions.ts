// Which action the task header shows as its one button. Pure, so it is unit tested.
import type { TaskStatus } from "../../../shared/types"

export type PrimaryAction = "stop" | "done" | "retry" | null

/** Stop while it runs, Retry when it broke, Mark done otherwise; the rest live in the ⋯ menu. */
export function primaryAction(status: TaskStatus): PrimaryAction {
  if (status === "working" || status === "starting" || status === "queued") return "stop"
  if (status === "failed") return "retry"
  if (status === "done") return null
  return "done"
}
