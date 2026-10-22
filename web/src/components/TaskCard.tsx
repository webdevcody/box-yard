import { Link } from "wouter"
import { ExternalLink, GitPullRequest, Globe, MessageCircleQuestion } from "lucide-react"
import type { Task } from "../../../shared/types"
import { StatusBadge, TimeAgo, cx } from "./ui"

export function TaskCard({ task, projectName }: { task: Task; projectName?: string }) {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cx(
        "group block rounded-xl border bg-zinc-900/40 p-4 transition hover:bg-zinc-900",
        task.status === "needs_input" ? "border-amber-500/40" : task.status === "failed" ? "border-red-900/60" : "border-zinc-800/80 hover:border-zinc-700",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {projectName && <div className="mb-0.5 truncate text-xs text-zinc-500">{projectName}</div>}
          <div className="truncate font-medium text-zinc-100">{task.title}</div>
        </div>
        <StatusBadge status={task.status} />
      </div>

      {task.status === "needs_input" && task.question ? (
        <div className="mt-3 flex gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-sm text-amber-200">
          <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="line-clamp-3">{task.question}</span>
        </div>
      ) : task.status === "failed" && task.error ? (
        <p className="mt-2 line-clamp-2 text-sm text-red-300/80">{task.error}</p>
      ) : (
        <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{task.summary ?? task.prompt}</p>
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
        {task.pendingCount > 0 && <span>{task.pendingCount} queued msg</span>}
        <span className="ml-auto">
          <TimeAgo ts={task.updatedAt} />
        </span>
      </div>
    </Link>
  )
}
