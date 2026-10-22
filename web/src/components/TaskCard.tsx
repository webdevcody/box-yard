import { Link } from "wouter"
import { AlarmClock, Check, ExternalLink, GitPullRequest, Globe, MessageCircleQuestion } from "lucide-react"
import type { Task } from "../../../shared/types"
import { StatusBadge, TimeAgo, cx } from "./ui"

/** Flattens markdown to plain text for card previews; drops the task's own PR URL (shown in the footer) and shortens other URLs. */
export function plainPreview(text: string, prUrl?: string | null): string {
  let t = text
  if (prUrl) t = t.split(prUrl).join("")
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/([^\s/)]+)(\/[^\s)]*)?/g, (_, host: string, path?: string) => {
      const short = host.replace(/^www\./, "") + (path && path !== "/" ? path : "")
      return short.length > 40 ? short.slice(0, 39) + "…" : short
    })
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/\s*:\s*(?=[.,;]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** `onReviewed` adds a "Mark reviewed" check button (inbox cards). */
export function TaskCard({ task, projectName, onReviewed }: { task: Task; projectName?: string; onReviewed?: () => void }) {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cx(
        "group block rounded-xl border bg-zinc-900/40 p-4 transition hover:bg-zinc-900",
        task.status === "needs_input" ? "border-amber-500/40" : task.status === "failed" ? "border-red-900/60" : "border-zinc-800/80 hover:border-zinc-700",
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

      {task.status === "needs_input" && task.question ? (
        <div className="mt-3 flex gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-sm text-amber-200">
          <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="line-clamp-3">{task.question}</span>
        </div>
      ) : task.status === "failed" && task.error ? (
        <p className="mt-2 line-clamp-2 text-sm text-red-300/80">{task.error}</p>
      ) : (
        <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{plainPreview(task.summary ?? task.prompt, task.prUrl)}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-emerald-400 hover:underline">
            <GitPullRequest className="h-3.5 w-3.5" /> PR #{task.prUrl.split("/").pop()}
          </a>
        )}
        {task.previews.map((p) => (
          <a key={p.port} href={p.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-sky-400 hover:underline">
            <Globe className="h-3.5 w-3.5" /> {p.label}
            <ExternalLink className="h-3 w-3" />
          </a>
        ))}
        {task.scheduleId && (
          <span className="inline-flex items-center gap-1" title="Started by a schedule">
            <AlarmClock className="h-3.5 w-3.5" /> scheduled
          </span>
        )}
        {task.pendingCount > 0 && <span>{task.pendingCount} queued msg</span>}
        <span className="ml-auto">
          <TimeAgo ts={task.updatedAt} />
        </span>
        {onReviewed && (
          <button
            type="button"
            title="Mark reviewed (marks the task done)"
            aria-label={`Mark "${task.title}" reviewed`}
            onClick={(e) => {
              // The card is a link: don't open the task.
              e.preventDefault()
              e.stopPropagation()
              onReviewed()
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
