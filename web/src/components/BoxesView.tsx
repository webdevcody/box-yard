import { useEffect } from "react"
import { Link } from "wouter"
import { Boxes, ExternalLink, Globe } from "lucide-react"
import { useBoxes, useHealth, useProjects, useTasks } from "../lib/queries"
import { Empty, StatusBadge, TimeAgo, cx } from "./ui"
import type { BoxInfo, Task } from "../../../shared/types"

const RUNNING: Task["status"][] = ["working", "starting"]

const BOX_STATUS: Record<BoxInfo["status"], { label: string; chip: string }> = {
  creating: { label: "Starting", chip: "bg-sky-500/10 text-sky-300" },
  ready: { label: "Running", chip: "bg-emerald-500/10 text-emerald-300" },
  lost: { label: "Error", chip: "bg-red-500/10 text-red-300" },
  deleting: { label: "Deleting", chip: "bg-zinc-800 text-zinc-300" },
}

/** Scroll to the box named in the URL hash (set by the sidebar bars). */
function useScrollToHash(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1))
      if (id) document.getElementById(`box-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
    go()
    window.addEventListener("hashchange", go)
    return () => window.removeEventListener("hashchange", go)
  }, [ready])
}

function Stat({ label, value, max }: { label: string; value: number; max: number }) {
  const over = value > max
  return (
    <div className={cx("rounded-xl border bg-zinc-900/40 p-4", over ? "border-amber-500/40" : "border-zinc-800/80")}>
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-50">
        {value}
        <span className="text-zinc-500"> / {max}</span>
      </div>
      {over && <div className="mt-1 text-xs font-medium text-amber-300">Over limit</div>}
    </div>
  )
}

export function BoxesView() {
  const boxes = useBoxes()
  const tasks = useTasks()
  const projects = useProjects()
  const health = useHealth()
  useScrollToHash(Boolean(boxes.data))

  const pool = health.data?.pool
  const list = boxes.data ?? []
  const all = tasks.data ?? []
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id
  const running = all.filter((t) => t.boxId && RUNNING.includes(t.status)).length
  const queued = all.filter((t) => t.status === "queued").sort((a, b) => a.updatedAt - b.updatedAt)

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Boxes</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Worker boxes on {health.data?.provider ?? "…"} and the agents running on them.
        </p>
      </header>

      {pool && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Boxes" value={list.length} max={pool.maxBoxes} />
          <Stat label="Agents running" value={running} max={pool.maxBoxes * pool.slotsPerBox} />
        </div>
      )}

      {boxes.isLoading ? null : list.length === 0 ? (
        <Empty icon={<Boxes className="h-8 w-8" />} title="No boxes yet">
          Boxes are created when a task needs one.
        </Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((box) => (
            <BoxCard key={box.id} box={box} tasks={all.filter((t) => t.boxId === box.id)} projectName={projectName} />
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Waiting for a slot <span className="text-zinc-600">{queued.length}</span>
        </h2>
        {queued.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing is waiting. Every task has a slot.</p>
        ) : (
          <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/80 bg-zinc-900/40">
            {queued.map((t) => (
              <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function TaskRow({ task, projectName }: { task: Task; projectName: string }) {
  return (
    <Link href={`/tasks/${task.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
      <div className="min-w-0">
        <div className="truncate text-zinc-100">{task.title}</div>
        <div className="truncate text-xs text-zinc-500">{projectName}</div>
      </div>
      <StatusBadge status={task.status} />
    </Link>
  )
}

function BoxCard({ box, tasks, projectName }: { box: BoxInfo; tasks: Task[]; projectName: (id: string) => string }) {
  const st = BOX_STATUS[box.status]
  const previews = tasks.flatMap((t) => t.previews.map((p) => ({ ...p, taskTitle: t.title })))
  return (
    <div id={`box-${box.id}`} className="scroll-mt-6 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-medium text-zinc-100" title={box.id}>
            {box.id}
          </div>
          <div className="text-xs text-zinc-500">{box.provider}</div>
        </div>
        <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", st.chip)}>{st.label}</span>
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
        <span className="text-zinc-300">
          {box.runningTurns}/{box.slots} agents busy
        </span>
        <div className="flex flex-1 gap-1">
          {Array.from({ length: Math.max(box.slots, box.runningTurns) }, (_, i) => (
            <div key={i} className={cx("h-1.5 flex-1 rounded-sm", i < box.runningTurns ? "bg-yard-500" : "bg-zinc-700")} />
          ))}
        </div>
        {box.runningTurns > box.slots && <span className="font-medium text-amber-300">Over limit</span>}
      </div>

      <dl className="mt-3 space-y-1 text-xs text-zinc-500">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0">Projects</dt>
          <dd className="text-zinc-300">{box.projects.length ? box.projects.join(", ") : "none yet"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0">Up since</dt>
          <dd className="text-zinc-300"><TimeAgo ts={box.createdAt} /></dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0">Last active</dt>
          <dd className="text-zinc-300"><TimeAgo ts={box.lastUsedAt} /></dd>
        </div>
      </dl>

      <div className="mt-3 divide-y divide-zinc-800/80 rounded-lg border border-zinc-800/80">
        {tasks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-zinc-500">No agents on this box.</div>
        ) : (
          tasks.map((t) => <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} />)
        )}
      </div>

      {previews.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {previews.map((p) => (
            <a key={`${p.port}-${p.url}`} href={p.url} target="_blank" rel="noreferrer" title={p.taskTitle} className="inline-flex items-center gap-1 text-sky-400 hover:underline">
              <Globe className="h-3.5 w-3.5" /> {p.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
