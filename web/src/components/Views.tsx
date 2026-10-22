import { useState } from "react"
import { Inbox as InboxIcon, Lock } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useHealth, useProjects, useTasks, keys } from "../lib/queries"
import { api } from "../lib/api"
import { Button, Empty, inputClass } from "./ui"
import { TaskCard } from "./TaskCard"
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

function Grouped({ tasks, groups }: { tasks: Task[]; groups: typeof GROUPS }) {
  const name = useProjectNames()
  return (
    <div className="space-y-8">
      {groups.map((g) => {
        const list = tasks.filter((t) => g.statuses.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt)
        if (!list.length) return null
        return (
          <section key={g.title}>
            <h2 className="mb-3 text-sm font-semibold text-zinc-300">
              {g.title} <span className="text-zinc-600">{list.length}</span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {list.map((t) => (
                <TaskCard key={t.id} task={t} projectName={name(t.projectId)} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export function InboxView() {
  const tasks = useTasks()
  if (tasks.isLoading) return null
  const list = (tasks.data ?? []).filter((t) => ["needs_input", "pr_ready", "failed"].includes(t.status))
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
        <Grouped tasks={list} groups={GROUPS.filter((g) => ["Needs you", "Ready for review", "Failed"].includes(g.title))} />
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
