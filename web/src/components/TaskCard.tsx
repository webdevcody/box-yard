import { Link } from "wouter"
import { Activity, AlarmClock, Check, GitPullRequest, Globe, MessageCircleQuestion } from "lucide-react"
import type { PreviewLink, Task } from "../../../shared/types"
import { cardSummary } from "../lib/taskSummary"
import { StatusBadge, TimeAgo, cx } from "./ui"

/**
 * One task in a card grid. Fixed structure so cards in a row line up: project, title (2 lines max), summary (2 lines,
 * space reserved), an optional chips row, then a one-line footer pinned to the bottom (the card fills its grid cell).
 *
 * `onMarkDone` adds a "Mark done" check button (inbox cards). `stale` dims a card that no longer belongs in its
 * list (e.g. it finished under the Active filter) but stays put until the list is re-sorted (useStableOrder).
 */
export function TaskCard({ task, projectName, onMarkDone, stale }: { task: Task; projectName?: string; onMarkDone?: () => void; stale?: boolean }) {
  const summary = cardSummary(task)
  return (
    <Link
      href={`/tasks/${task.id}`}
      title={stale ? "No longer matches this list. It leaves on the next re-sort." : undefined}
      className={cx(
        "group flex h-full flex-col rounded-xl border bg-zinc-900/40 p-4 transition hover:bg-zinc-900",
        task.status === "needs_input" ? "border-amber-500/40" : task.status === "failed" ? "border-red-900/60" : "border-zinc-800/80 hover:border-zinc-700",
        stale && "border-dashed opacity-50 hover:opacity-80",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {projectName && <div className="mb-0.5 truncate text-xs text-zinc-500">{projectName}</div>}
          <div className="line-clamp-2 break-words font-medium text-zinc-100">{task.title}</div>
        </div>
        <span className="mt-0.5 shrink-0">
          <StatusBadge status={task.status} />
        </span>
      </div>

      <div className="mt-2 min-h-10 text-sm leading-5">
        {task.status === "needs_input" && task.question ? (
          <div className="flex gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-amber-200">
            <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="line-clamp-2 break-words">{task.question}</span>
          </div>
        ) : task.status === "failed" && task.error ? (
          <p className="line-clamp-2 break-words text-red-300/80">{task.error}</p>
        ) : summary.kind === "activity" ? (
          <p className="line-clamp-2 break-words text-zinc-400" title="Latest agent activity">
            <Activity className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px text-zinc-500" />
            {summary.text}
          </p>
        ) : (
          <p className="line-clamp-2 break-words text-zinc-400">{summary.text}</p>
        )}
      </div>

      {task.previews.length > 0 && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
          {task.previews.map((p) => (
            <PreviewChip key={p.port} preview={p} />
          ))}
        </div>
      )}

      <div className="mt-auto flex min-w-0 items-center gap-2 whitespace-nowrap pt-3 text-xs text-zinc-500">
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex shrink-0 items-center gap-1 text-emerald-400 hover:underline">
            <GitPullRequest className="h-3.5 w-3.5" /> PR #{task.prUrl.split("/").pop()}
          </a>
        )}
        {task.scheduleId && (
          <span className="inline-flex shrink-0 items-center gap-1" title="Started by a schedule">
            <AlarmClock className="h-3.5 w-3.5" /> scheduled
          </span>
        )}
        <span className="ml-auto min-w-0 truncate" title={task.pendingCount > 0 ? `${task.pendingCount} messages wait for the next turn` : undefined}>
          {task.pendingCount > 0 && `${task.pendingCount} queued · `}
          <TimeAgo ts={task.updatedAt} />
        </span>
        {onMarkDone && (
          <button
            type="button"
            title="Mark done"
            aria-label={`Mark "${task.title}" done`}
            onClick={(e) => {
              // The card is a link: don't open the task.
              e.preventDefault()
              e.stopPropagation()
              onMarkDone()
            }}
            className="-my-1 -mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-zinc-700 text-zinc-400 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-300 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none [@media(hover:none)]:opacity-100"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Link>
  )
}

/** A compact one-line preview chip ("Preview :4030"); the agent's full label and the URL are in the tooltip. */
function PreviewChip({ preview }: { preview: PreviewLink }) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={preview.label && preview.label !== preview.url ? `${preview.label}\n${preview.url}` : preview.url}
      className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-md border border-sky-900/60 bg-sky-500/10 px-1.5 py-0.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/20"
    >
      <Globe className="h-3 w-3 shrink-0" /> Preview :{preview.port}
    </a>
  )
}
