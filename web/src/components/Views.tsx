import { useState } from "react"
import { Inbox as InboxIcon, Lock } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useHealth, useMarkDoneFromInbox, useProjects, useTasks, keys } from "../lib/queries"
import { inInbox, usePendingCloses } from "../lib/inbox"
import { api } from "../lib/api"
import { Button, Empty, inputClass } from "./ui"
import { TaskCard } from "./TaskCard"
import { ResortPill } from "./ResortPill"
import { useStableOrder } from "../lib/useStableOrder"
import type { Task, TaskStatus } from "../../../shared/types"

const GROUPS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "Needs you", statuses: ["needs_input"] },
  { title: "Working", statuses: ["working", "starting", "waiting"] },
  { title: "Queued", statuses: ["queued"] },
  { title: "Ready for review", statuses: ["pr_ready"] },
  { title: "Failed", statuses: ["failed"] },
  { title: "Idle", statuses: ["idle"] },
  { title: "Done", statuses: ["done"] },
]

function useProjectNames() {
  const projects = useProjects()
  return (id: string) => projects.data?.find((p) => p.id === id)?.name
}

/**
 * Tasks in status sections, held still by useStableOrder: a card stays in the section it was in when the list was
 * last sorted (showing its new status, dimmed if it no longer belongs) until the Re-sort pill or an idle re-sort.
 */
function Grouped({
  tasks,
  groups,
  include,
  onMarkDone,
}: {
  tasks: Task[]
  groups: typeof GROUPS
  include?: (task: Task) => boolean
  onMarkDone?: (task: Task) => void
}) {
  const name = useProjectNames()
  const groupOf = (t: Task) => groups.findIndex((g) => g.statuses.includes(t.status))
  const stable = useStableOrder(tasks, {
    key: (t) => t.id,
    compare: (a, b) => groupOf(a) - groupOf(b) || b.updatedAt - a.updatedAt,
    include: (t) => groupOf(t) >= 0 && (include?.(t) ?? true),
  })
  return (
    <div ref={stable.listRef}>
      <ResortPill newCount={stable.newCount} changedCount={stable.changedCount} onResort={stable.resort} />
      <div className="space-y-8">
        {groups.map((g, i) => {
          const list = stable.entries.filter((e) => groupOf(e.was) === i)
          if (!list.length) return null
          return (
            <section key={g.title}>
              <h2 className="mb-3 text-sm font-semibold text-zinc-300">
                {g.title} <span className="text-zinc-600">{list.length}</span>
              </h2>
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {list.map(({ item: t, stale }) => (
                  <div key={t.id} data-stable-key={t.id}>
                    <TaskCard task={t} projectName={name(t.projectId)} stale={stale} onMarkDone={onMarkDone && !stale ? () => onMarkDone(t) : undefined} />
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

export function InboxView() {
  const tasks = useTasks()
  const closing = usePendingCloses()
  const markDone = useMarkDoneFromInbox()
  if (tasks.isLoading) return null
  const all = tasks.data ?? []
  const list = all.filter((t) => inInbox(t, closing))
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Inbox</h1>
        <p className="mt-1 text-sm text-zinc-500">Questions from agents, pull requests to review, and anything that broke.</p>
      </header>
      {list.length === 0 ? (
        <Empty icon={<InboxIcon className="h-8 w-8" />} title="Inbox zero">
          Nothing needs you right now.
        </Empty>
      ) : (
        <Grouped
          // Marked done (here or elsewhere) is a dismissal: those cards leave at once. Anything else that leaves
          // the inbox (an answered question goes back to working) stays in place, dimmed, until a re-sort.
          tasks={all.filter((t) => t.status !== "done" && !closing.has(t.id))}
          include={(t) => inInbox(t, closing)}
          groups={GROUPS.filter((g) => ["Needs you", "Ready for review", "Failed"].includes(g.title))}
          onMarkDone={markDone}
        />
      )}
    </div>
  )
}

export function HealthBanner() {
  const health = useHealth()
  const [hidden, setHidden] = useState(false)
  if (hidden || !health.data || health.data.problems.length === 0) return null
  return (
    <div className="flex items-start gap-3 border-b border-amber-900/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
      <div className="flex-1 space-y-0.5">
        {health.data.problems.map((p) => (
          <div key={p}>⚠ {p}</div>
        ))}
      </div>
      <button className="text-amber-400/70 hover:text-amber-200" onClick={() => setHidden(true)}>
        dismiss
      </button>
    </div>
  )
}

export function Login() {
  const qc = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <div className="grid h-full place-items-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError("")
          try {
            await api("/api/login", { body: { password } })
            await qc.invalidateQueries({ queryKey: keys.me })
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="flex items-center gap-2 text-zinc-100">
          <Lock className="h-4 w-4 text-yard-400" /> <span className="font-semibold">Box Yard</span>
        </div>
        <input type="password" autoFocus className={inputClass} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="text-sm text-red-400">{error}</div>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Log in
        </Button>
      </form>
    </div>
  )
}
