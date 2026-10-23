import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { Archive, FileJson, FileText, GitBranch } from "lucide-react"
import { useCompaction, useCompactions } from "../lib/queries"
import { Empty, Markdown, NewTabLink, StatusBadge, TimeAgo, cx } from "./ui"

function shortDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function CompactionsView() {
  const list = useCompactions()
  const [selected, setSelected] = useState<string | null>(null)
  const records = list.data ?? []
  useEffect(() => {
    if (!selected && records[0]) setSelected(records[0].id)
  }, [records, selected])
  const detail = useCompaction(selected)
  const current = detail.data ?? records.find((c) => c.id === selected) ?? null
  const taskCount = useMemo(() => records.reduce((n, c) => n + c.taskCount, 0), [records])

  if (list.isLoading) return null
  if (!records.length)
    return (
      <Empty icon={<Archive className="h-8 w-8" />} title="No compactions yet">
        Orchestrator compaction summaries will appear here after the first manual or automatic compaction.
      </Empty>
    )

  return (
    <div className="grid min-h-full gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="space-y-3">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Compactions</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {records.length} orchestrator summary{records.length === 1 ? "" : "ies"} with {taskCount} linked task snapshot{taskCount === 1 ? "" : "s"}.
          </p>
        </header>
        <div className="space-y-2">
          {records.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={cx(
                "w-full rounded-xl border p-3 text-left transition",
                selected === c.id ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-900 bg-zinc-950 hover:border-zinc-800 hover:bg-zinc-900/60",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-zinc-300">{c.id}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{c.trigger}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {shortDate(c.at)} · {c.taskCount} task{c.taskCount === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 space-y-4">
        {!current ? null : (
          <>
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4">
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span className="font-mono text-zinc-300">{current.id}</span>
                <span>
                  <TimeAgo ts={current.at} />
                </span>
                <span>{current.trigger} compaction</span>
                <span>
                  {current.tokensBefore ?? "?"} {"->"} {current.tokensAfter ?? "?"} tokens
                </span>
              </div>
              <div className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono" title={current.file}>
                    {current.file}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <FileJson className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono" title={current.jsonFile}>
                    {current.jsonFile}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-200">Linked tasks</h2>
              <div className="space-y-2">
                {current.tasks.length === 0 && <div className="text-sm text-zinc-500">No tasks were active or referenced for this compaction.</div>}
                {current.tasks.map((t) => (
                  <div key={t.taskId} className="rounded-lg border border-zinc-900 bg-zinc-900/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/tasks/${t.taskId}`} className="font-medium text-yard-300 hover:underline">
                        {t.title}
                      </Link>
                      <StatusBadge status={t.status} />
                      <span className="text-xs text-zinc-500">{t.projectName}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                      <span className="font-mono">{t.taskId}</span>
                      <span className="font-mono">session {t.sessionId.slice(0, 8)}</span>
                      {t.branch && (
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="h-3 w-3" /> {t.branch}
                        </span>
                      )}
                      {t.prUrl && (
                        <NewTabLink href={t.prUrl} className="text-emerald-400 hover:underline">
                          PR
                        </NewTabLink>
                      )}
                    </div>
                    {t.summary && <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{t.summary}</div>}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-200">Markdown summary</h2>
              {detail.isLoading && <div className="text-sm text-zinc-500">Loading summary...</div>}
              {current.markdown && <Markdown>{current.markdown}</Markdown>}
            </section>
          </>
        )}
      </main>
    </div>
  )
}
