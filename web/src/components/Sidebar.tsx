import { memo, useCallback, useMemo, useState } from "react"
import { Link, useLocation } from "wouter"
import { AlarmClock, Archive, DollarSign, Inbox, LayoutGrid, Plus, Search } from "lucide-react"
import { agentCapacity } from "../../../shared/types"
import { useBoxes, useHealth, useProjects, useSchedules, useTasks } from "../lib/queries"
import { inInbox, usePendingCloses } from "../lib/inbox"
import { cx } from "./ui"
import { NewProjectDialog } from "./NewProjectDialog"
import { RecentActivity } from "./RecentActivity"
import { MOD_KEY, openPalette } from "./CommandPalette"
import type { Connection } from "../lib/stream"
import { BrandLogo } from "./BrandLogo"
import { navItem, ProjectList } from "./ProjectList"

export const Sidebar = memo(function Sidebar({ connection, onNavigate }: { connection: Connection; onNavigate?: () => void }) {
  const [location, navigate] = useLocation()
  const projects = useProjects()
  const tasks = useTasks()
  const boxes = useBoxes()
  const health = useHealth()
  const schedules = useSchedules()
  const activeSchedules = schedules.data?.filter((s) => s.enabled).length ?? 0
  const [creating, setCreating] = useState(false)
  const openCreate = useCallback(() => setCreating(true), [])

  const closing = usePendingCloses()
  // Badge counts in one pass over the tasks, recomputed only when they change.
  const counts = useMemo(() => {
    let inbox = 0
    let needsYou = 0
    const active = new Map<string, number>()
    const attention = new Set<string>()
    for (const t of tasks.data ?? []) {
      if (inInbox(t, closing)) inbox++
      if (t.status === "needs_input") {
        needsYou++
        attention.add(t.projectId)
      }
      if (t.status === "working" || t.status === "starting" || t.status === "queued") active.set(t.projectId, (active.get(t.projectId) ?? 0) + 1)
    }
    return { inbox, needsYou, active, attention }
  }, [tasks.data, closing])
  const inboxCount = counts.inbox
  const needsYou = counts.needsYou

  const pool = health.data?.pool
  const running = boxes.data?.reduce((n, b) => n + b.runningTurns, 0) ?? 0
  const capacity = pool ? agentCapacity(pool) : 0
  const overLimit = Boolean(pool && ((boxes.data?.length ?? 0) > pool.maxBoxes || (capacity > 0 && running > capacity)))

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-3 lg:pt-4">
        <BrandLogo className="min-w-0" />
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

      <div className="px-2 pb-2">
        <button
          onClick={() => {
            onNavigate?.()
            openPalette()
          }}
          title={`Search everything (${MOD_KEY.trim()}+K or /)`}
          className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300 lg:min-h-0 lg:px-2.5 lg:py-1.5"
        >
          <Search className="h-4 w-4" /> Search…
          <kbd className="ml-auto rounded border border-zinc-800 bg-zinc-900 px-1.5 font-sans text-[10px] text-zinc-500">{MOD_KEY}K</kbd>
        </button>
      </div>

      <nav className="space-y-0.5 px-2" onClick={onNavigate}>
        <Link href="/" className={navItem(location === "/")}>
          <LayoutGrid className="h-4 w-4" /> Yard
        </Link>
        <Link href="/inbox" className={navItem(location === "/inbox")}>
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
        <Link href="/schedules" className={navItem(location === "/schedules")}>
          <AlarmClock className="h-4 w-4" /> Schedules
          {activeSchedules > 0 && <span className="ml-auto text-xs text-zinc-500">{activeSchedules}</span>}
        </Link>
        <Link href="/usage" className={navItem(location === "/usage")}>
          <DollarSign className="h-4 w-4" /> $ Usage
        </Link>
        <Link href="/compactions" className={navItem(location === "/compactions")}>
          <Archive className="h-4 w-4" /> Compactions
        </Link>
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 pb-1.5">
        <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Projects</span>
        <button onClick={() => setCreating(true)} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 lg:h-6 lg:w-6" title="New project" aria-label="New project">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <ProjectList
        projects={projects.data}
        location={location}
        active={counts.active}
        attention={counts.attention}
        onNavigate={onNavigate}
        onCreate={openCreate}
      />

      <RecentActivity onNavigate={onNavigate} />

      <div
        role="link"
        tabIndex={0}
        title="Open the Boxes page"
        onClick={() => { navigate("/boxes"); onNavigate?.() }}
        onKeyDown={(e) => { if (e.key === "Enter") { navigate("/boxes"); onNavigate?.() } }}
        className={cx("cursor-pointer border-t border-zinc-900 p-3 transition hover:bg-zinc-900/60", location === "/boxes" && "bg-zinc-900/60")}
      >
        <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-500">
          <span>
            {boxes.data?.length ?? 0}/{pool?.maxBoxes ?? "?"} boxes · {health.data?.provider ?? "…"}
          </span>
          <span className={cx(overLimit && "text-amber-300")}>
            {running}/{capacity || "?"} agents{overLimit && " · over limit"}
          </span>
        </div>
        <div className="flex gap-1">
          {Array.from({ length: Math.max(pool?.maxBoxes ?? 0, boxes.data?.length ?? 0) }, (_, i) => {
            const box = boxes.data?.[i]
            return (
              <div
                key={i}
                onClick={box ? (e) => { e.stopPropagation(); navigate("/boxes"); window.location.hash = box.id; onNavigate?.() } : undefined}
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
})
