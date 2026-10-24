import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "wouter"
import { Activity, Boxes, CheckCircle2, History, Inbox as InboxIcon, Layers, Search } from "lucide-react"
import { useHealth, useProjects, useTasks } from "../lib/queries"
import { parseSort } from "../lib/projectTasks"
import {
  DEFAULT_YARD_TAB,
  YARD_TABS,
  inYardTab,
  inYardView,
  olderFinishedCount,
  parseYardTab,
  quietCount,
  shownInYard,
  yardCompare,
  yardCounts,
  type YardTab,
} from "../lib/yardTasks"
import { Empty, STATUS, Select, cx } from "./ui"
import { TaskGrid, useStableTasks } from "./TaskGrid"
import { NewTaskButton } from "./NewTask"
import { QuietToggle, SearchBox, SortSelect, TabBar, isTyping, useShowQuiet, useUrlQuery, withParam } from "./TaskFilters"

const TAB_ICONS: Record<YardTab, typeof Activity> = { active: Activity, needs_you: InboxIcon, recent: History, all: Layers }

/** `/` with the current query params, switched to `tab` (the default tab stays out of the URL). */
function tabHref(params: URLSearchParams, tab: YardTab) {
  const qs = withParam(params, "tab", tab === DEFAULT_YARD_TAB ? null : tab).toString()
  return qs ? `/?${qs}` : "/"
}

/** The current time, ticking every `ms`, so the 24h window slides without a reload. */
function useNow(ms = 60_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function YardView() {
  const tasks = useTasks()
  const projects = useProjects()
  const health = useHealth()
  const [params, setParams] = useSearchParams()
  const [query, onQuery] = useUrlQuery()
  const [showQuiet] = useShowQuiet()
  const now = useNow()
  const [newOpen, setNewOpen] = useState(false)

  // `?new=task` (the command palette's "New task…") opens the new task popover once.
  const wantsNew = params.get("new") === "task"
  useEffect(() => {
    if (!wantsNew) return
    setNewOpen(true)
    setParams((p) => withParam(p, "new", null), { replace: true })
  }, [wantsNew, setParams])

  const tab = parseYardTab(params.get("tab"))
  const sort = parseSort(params.get("sort"))
  const older = params.get("older") === "1"
  const names = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])
  const projectNameOf = (id: string) => names.get(id)
  const projectId = names.has(params.get("project") ?? "") ? params.get("project") : null

  const all = tasks.data
  const scoped = useMemo(() => (all ?? []).filter((t) => !projectId || t.projectId === projectId), [all, projectId])
  const counts = useMemo(() => yardCounts(scoped, now, showQuiet), [scoped, now, showQuiet])
  const quiet = useMemo(() => quietCount(scoped, tab, now, older), [scoped, tab, now, older])
  // Sorted once per tab, filter and search, then held still while agents update.
  const stable = useStableTasks(scoped, {
    compare: yardCompare({ tab, sort }),
    include: (t) => inYardView(t, { tab, now, older, query, projectName: projectNameOf, showQuiet }),
    resetKey: `${tab}|${projectId}|${older}|${showQuiet}|${tab === "all" ? `${sort}|${query}` : ""}`,
  })
  const shown = stable.entries
  const olderCount = useMemo(() => (tab === "recent" ? olderFinishedCount(scoped, now, showQuiet) : 0), [scoped, tab, now, showQuiet])
  /** Tasks per project in the current tab, for the project picker. */
  const perProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of all ?? []) if (shownInYard(t, showQuiet) && inYardTab(t, tab, now, older)) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1)
    return m
  }, [all, tab, now, older, showQuiet])

  // 1-4 switch tabs, unless you're typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = Number(e.key) - 1
      if (!(i >= 0 && i < YARD_TABS.length) || isTyping(e)) return
      e.preventDefault()
      const key = YARD_TABS[i]!.key
      setParams((p) => withParam(p, "tab", key === DEFAULT_YARD_TAB ? null : key))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setParams])

  if (tasks.isLoading || projects.isLoading) return null
  const list = all ?? []
  const working = list.filter((t) => t.status === "working" || t.status === "starting").length
  const setParam = (key: string, value: string | null, replace = false) => setParams((p) => withParam(p, key, value), { replace })
  const projectName = projectId ? names.get(projectId) : undefined
  const hasProjects = (projects.data ?? []).length > 0

  return (
    // pb-6: the page container's own padding is lost once the list overflows it (it is h-full for the task view).
    <div className="space-y-5 pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">The yard</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {working} agent{working === 1 ? "" : "s"} working · {list.length} task{list.length === 1 ? "" : "s"} ·{" "}
            {health.data ? `${health.data.provider} boxes, ${health.data.bus === "redis" ? "Redis bus" : "file bus"}` : ""}
          </p>
        </div>
        {list.length > 0 && (quiet > 0 || showQuiet) && <QuietToggle count={quiet} className="w-full sm:w-auto" />}
        {list.length > 0 && (
          <Select
            className={cx("w-full shrink-0 text-zinc-300 sm:w-56", projectId && "border-yard-500/40 text-zinc-100")}
            value={projectId ?? ""}
            onChange={(e) => setParam("project", e.target.value || null)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {(projects.data ?? [])
              .filter((p) => perProject.has(p.id) || p.id === projectId)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({perProject.get(p.id) ?? 0})
                </option>
              ))}
          </Select>
        )}
        {hasProjects && <NewTaskButton defaultProjectId={projectId} open={newOpen} onOpenChange={setNewOpen} className="w-full shrink-0 sm:w-auto" />}
      </header>

      {list.length === 0 ? (
        <Empty icon={<Boxes className="h-8 w-8" />} title="Nothing in the yard yet">
          <p>Tell the Coordinator what you want built, researched or written. It creates projects and routes work to project Captains for you.</p>
          {hasProjects && <NewTaskButton variant="subtle" size="sm" className="mt-3" />}
        </Empty>
      ) : (
        <>
          <TabBar
            label="Yard tabs"
            selected={tab}
            tabs={YARD_TABS.map((t, i) => ({
              ...t,
              icon: TAB_ICONS[t.key],
              href: tabHref(params, t.key),
              count: counts[t.key],
              title: `${t.label} (press ${i + 1})`,
              ...(t.key === "needs_you" && scoped.some((x) => x.status === "needs_input") && { dot: STATUS.needs_input.dot }),
            }))}
          />

          {projectName && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              Showing <span className="font-medium text-zinc-300">{projectName}</span> only.
              <Link href={`/projects/${projectId}`} className="text-yard-400 hover:text-yard-300">
                Open project
              </Link>
              <button className="text-zinc-400 hover:text-zinc-200" onClick={() => setParam("project", null)}>
                Show all projects
              </button>
            </div>
          )}

          {tab === "active" &&
            (shown.length ? (
              <TaskGrid key={tab} stable={stable} projectName={projectNameOf} />
            ) : (
              <ActiveEmpty needsYou={counts.needs_you} needsYouHref={tabHref(params, "needs_you")} recentHref={tabHref(params, "recent")} />
            ))}

          {tab === "needs_you" &&
            (shown.length ? (
              <TaskGrid key={tab} stable={stable} projectName={projectNameOf} />
            ) : (
              <Empty icon={<InboxIcon className="h-8 w-8" />} title="Nothing needs you">
                No questions, pull requests or failures waiting.
              </Empty>
            ))}

          {tab === "recent" && (
            <>
              <p className="text-xs text-zinc-500">{older ? "Every finished task, newest first." : "Finished in the last 24 hours, newest first."}</p>
              {shown.length ? (
                <TaskGrid key={tab} stable={stable} projectName={projectNameOf} />
              ) : (
                <Empty icon={<History className="h-8 w-8" />} title="Nothing finished in the last 24 hours" />
              )}
              {(olderCount > 0 || older) && (
                <button
                  onClick={() => setParam("older", older ? null : "1", true)}
                  className="min-h-11 w-full rounded-xl border border-dashed border-zinc-800 py-2.5 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                >
                  {older ? "Hide tasks older than 24 hours" : `${olderCount} older finished ${olderCount === 1 ? "task" : "tasks"} · Show older`}
                </button>
              )}
            </>
          )}

          {tab === "all" && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <SearchBox value={query} onChange={onQuery} placeholder="Search every task" />
                <SortSelect sort={sort} />
              </div>
              {shown.length ? (
                <TaskGrid key={tab} stable={stable} projectName={projectNameOf} />
              ) : (
                <Empty icon={<Search className="h-8 w-8" />} title={`No tasks match "${query.trim()}"`}>
                  <button className="text-yard-400 hover:text-yard-300" onClick={() => onQuery("")}>
                    Clear the search
                  </button>
                </Empty>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** The Active tab with no agents working: point at what's waiting and what just finished. */
export function ActiveEmpty({ needsYou, needsYouHref, recentHref }: { needsYou: number; needsYouHref: string; recentHref: string }) {
  return (
    <Empty icon={<CheckCircle2 className="h-8 w-8" />} title="All quiet in the yard">
      No agents are working right now. Ask the Coordinator for something new
      {needsYou > 0 && (
        <>
          , or{" "}
          <Link href={needsYouHref} className="text-yard-400 hover:text-yard-300">
            see the {needsYou} {needsYou === 1 ? "task" : "tasks"} waiting on you
          </Link>
        </>
      )}
      .
      <div className="mt-3">
        <Link href={recentHref} className="text-yard-400 hover:text-yard-300">
          See recently finished →
        </Link>
      </div>
    </Empty>
  )
}
