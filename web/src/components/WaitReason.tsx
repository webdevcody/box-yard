import { Link } from "wouter"
import { navigate } from "wouter/use-browser-location"
import type { Task, WaitFor } from "../../../shared/types"
import { cx } from "./ui"

/** A queued task's wait reason cut around the tasks it names (Task.waitFor, in the order the text names them). */
export function waitReasonParts(reason: string, waitFor: WaitFor[]): (string | WaitFor)[] {
  const parts: (string | WaitFor)[] = []
  let at = 0
  for (const w of waitFor) {
    const i = w.title ? reason.indexOf(w.title, at) : -1
    if (i < 0) continue
    if (i > at) parts.push(reason.slice(at, i))
    parts.push(w)
    at = i + w.title.length
  }
  if (at < reason.length) parts.push(reason.slice(at))
  return parts
}

const LINK = "rounded text-amber-100 underline decoration-amber-300/50 underline-offset-2 hover:decoration-amber-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"

/**
 * A queued task's wait reason with the tasks holding it back linked: "survive-the-night allows 1 of its agents at a
 * time on this computer; waiting for [Merge PR #78]". `inLink`: it sits inside a card or row that is a link itself,
 * so each blocker is a button (no nested anchors) that opens the task, like QueuedLink.
 */
export function WaitReason({ task, inLink, className }: { task: Pick<Task, "waitReason" | "waitFor">; inLink?: boolean; className?: string }) {
  if (!task.waitReason) return null
  return (
    <span className={className}>
      {waitReasonParts(task.waitReason, task.waitFor ?? []).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : inLink ? (
          <button
            key={i}
            type="button"
            className={cx(LINK, "text-left")}
            title={`Open ${part.title}`}
            data-testid="wait-for-link"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(`/tasks/${part.taskId}`, "_blank", "noopener")
              else navigate(`/tasks/${part.taskId}`)
            }}
          >
            {part.title}
          </button>
        ) : (
          <Link key={i} href={`/tasks/${part.taskId}`} className={LINK} title={`Open ${part.title}`} data-testid="wait-for-link">
            {part.title}
          </Link>
        ),
      )}
    </span>
  )
}
