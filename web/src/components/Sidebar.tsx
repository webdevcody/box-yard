import { useState } from "react"
import { Link, useLocation } from "wouter"
import { AlarmClock, Boxes, FolderGit2, FolderOpen, Inbox, LayoutGrid, Plus } from "lucide-react"
import { useBoxes, useHealth, useProjects, useSchedules, useTasks } from "../lib/queries"
import { cx } from "./ui"
import { NewProjectDialog } from "./NewProjectDialog"
import type { Connection } from "../lib/stream"

export function Sidebar({ connection, onNavigate }: { connection: Connection; onNavigate?: () => void }) {
  const [location] = useLocation()
  const projects = useProjects()
  const tasks = useTasks()
  const boxes = useBoxes()
  const health = useHealth()
  const schedules = useSchedules()
  const activeSchedules = schedules.data?.filter((s) => s.enabled).length ?? 0
  const [creating, setCreating] = useState(false)

  const inboxCount = tasks.data?.filter((t) => t.status === "needs_input" || t.status === "pr_ready" || t.status === "failed").length ?? 0
  const needsYou = tasks.data?.filter((t) => t.status === "needs_input").length ?? 0
  const active = (projectId: string) =>
    tasks.data?.filter((t) => t.projectId === projectId && (t.status === "working" || t.status === "starting" || t.status === "queued")).length ?? 0
  const attention = (projectId: string) => tasks.data?.some((t) => t.projectId === projectId && t.status === "needs_input")

  const pool = health.data?.pool
  const running = boxes.data?.reduce((n, b) => n + b.runningTurns, 0) ?? 0
  const capacity = pool ? pool.maxBoxes * pool.slotsPerBox : 0

  const navItem = (href: string, active: boolean) =>
    cx(
      "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition",
      active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
    )

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-yard-500 text-zinc-950">
          <Boxes className="h-4 w-4" />
        </div>
        <div className="font-semibold tracking-tight text-zinc-50">Box Yard</div>
        {health.data?.mock && (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300" title="A fake claude is answering. Set real keys and drop BOXYARD_MOCK to go live.">
            MOCK
          </span>
        )}
        <span
          title={connection === "live" ? "Live updates on" : "Reconnecting…"}
          className={cx("ml-auto h-2 w-2 rounded-full", connection === "live" ? "bg-emerald-500" : "animate-pulse bg-amber-500")}
        />
      </div>

      <nav className="space-y-0.5 px-2" onClick={onNavigate}>
        <Link href="/" className={navItem("/", location === "/")}>
          <LayoutGrid className="h-4 w-4" /> Yard
        </Link>
        <Link href="/inbox" className={navItem("/inbox", location === "/inbox")}>
          <Inbox className="h-4 w-4" /> Inbox
          {inboxCount > 0 && (
            <span
              className={cx(
                "ml-auto rounded-full px-1.5 text-xs font-semibold",
                needsYou ? "bg-amber-500 text-zinc-950" : "bg-zinc-700 text-zinc-200",
              )}
            >
              {inboxCount}
            </span>
          )}
        </Link>
        <Link href="/schedules" className={navItem("/schedules", location === "/schedules")}>
          <AlarmClock className="h-4 w-4" /> Schedules
          {activeSchedules > 0 && <span className="ml-auto text-xs text-zinc-500">{activeSchedules}</span>}
        </Link>
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 pb-1.5">
        <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Projects</span>
        <button onClick={() => setCreating(true)} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="New project">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2" onClick={onNavigate}>
        {projects.data?.length === 0 && (
          <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-left text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300">
            No projects yet. Create one, or just ask the orchestrator.
          </button>
        )}
        {projects.data?.map((p) => {
          const href = `/projects/${p.id}`
          const n = active(p.id)
          return (
            <Link key={p.id} href={href} className={navItem(href, location.startsWith(href))}>
              {p.repo ? <FolderGit2 className="h-4 w-4 shrink-0" /> : <FolderOpen className="h-4 w-4 shrink-0" />}
              <span className="truncate">{p.name}</span>
              {attention(p.id) && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-400" title="A task needs you" />}
              {!attention(p.id) && n > 0 && <span className="ml-auto text-xs text-sky-400">{n}</span>}
            </Link>
          )
        })}
      </div>

      <div className="border-t border-zinc-900 p-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-500">
          <span>
            {boxes.data?.length ?? 0}/{pool?.maxBoxes ?? "?"} boxes · {health.data?.provider ?? "…"}
          </span>
          <span>
            {running}/{capacity || "?"} agents
          </span>
        </div>
        <div className="flex gap-1">
          {Array.from({ length: pool?.maxBoxes ?? 0 }, (_, i) => {
            const box = boxes.data?.[i]
            return (
              <div
                key={i}
                title={box ? `${box.id}: ${box.runningTurns}/${box.slots} running, ${box.residentTasks.length} tasks${box.projects.length ? ` (${box.projects.join(", ")})` : ""}` : "free"}
                className={cx(
                  "h-2 flex-1 rounded-sm",
                  !box && "bg-zinc-800",
                  box?.status === "creating" && "animate-pulse bg-sky-700",
                  box?.status === "ready" && (box.runningTurns === 0 ? "bg-zinc-600" : box.runningTurns >= box.slots ? "bg-yard-500" : "bg-yard-600/70"),
                )}
              />
            )
          })}
        </div>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </aside>
  )
}
