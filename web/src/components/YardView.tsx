import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "wouter"
import { Activity, Boxes, CheckCircle2, ChevronRight, History, Inbox as InboxIcon, Layers, Search } from "lucide-react"
import { useHealth, useProjects, useTasks } from "../lib/queries"
import { parseSort } from "../lib/projectTasks"
import {
  DEFAULT_YARD_TAB,
  YARD_TABS,
  inYardTab,
  inYardView,
  olderFinishedCount,
  parseYardTab,
  recentlyFinished,
  yardCompare,
  yardCounts,
  type YardTab,
} from "../lib/yardTasks"
import { Empty, STATUS, Select, TimeAgo, cx } from "./ui"
import { TaskGrid, useStableTasks } from "./TaskGrid"
import { SearchBox, SortSelect, TabBar, isTyping, useUrlQuery, withParam } from "./TaskFilters"
import type { Task } from "../../../shared/types"

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
  const now = useNow()

  const tab = parseYardTab(params.get("tab"))
  const sort = parseSort(params.get("sort"))
  const older = params.get("older") === "1"
  const names = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])
  const projectNameOf = (id: string) => names.get(id)
  const projectId = names.has(params.get("project") ?? "") ? params.get("project") : null

  const all = tasks.data
  const scoped = useMemo(() => (all ?? []).filter((t) => !projectId || t.projectId === projectId), [all, projectId])
  const counts = useMemo(() => yardCounts(scoped, now), [scoped, now])
  // Sorted once per tab, filter and search, then held still while agents update.
  const stable = useStableTasks(scoped, {
    compare: yardCompare({ tab, sort }),
    include: (t) => inYardView(t, { tab, now, older, query, projectName: projectNameOf }),
    resetKey: `${tab}|${projectId}|${older}|${tab === "all" ? `${sort}|${query}` : ""}`,
  })
  const shown = stable.entries
  const strip = useMemo(() => (tab === "active" ? recentlyFinished(scoped) : []), [scoped, tab])
  const olderCount = useMemo(() => (tab === "recent" ? olderFinishedCount(scoped, now) : 0), [scoped, tab, now])
  /** Tasks per project in the current tab, for the project picker. */
  const perProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of all ?? []) if (inYardTab(t, tab, now, older)) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1)
    return m
  }, [all, tab, now, older])

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

  return (
    // pb-6: the page container's own padding is lost once the list overflows it (it is h-full for the task view).
    <div className="space-y-5 pb-6">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">The yard</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {working} agent{working === 1 ? "" : "s"} working · {list.length} task{list.length === 1 ? "" : "s"} ·{" "}
            {health.data ? `${health.data.provider} boxes, ${health.data.bus === "redis" ? "Redis bus" : "file bus"}` : ""}
          </p>
        </div>
        {list.length > 0 && (
          <Select
            className={cx("w-44 shrink-0 text-zinc-300 sm:w-56", projectId && "border-yard-500/40 text-zinc-100")}
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
      </header>

      {list.length === 0 ? (
        <Empty icon={<Boxes className="h-8 w-8" />} title="Nothing in the yard yet">
          Tell the orchestrator what you want built, researched or written. It creates projects and starts agents in boxes for you.
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
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              Showing <span className="font-medium text-zinc-300">{projectName}</span> only.
              <Link href={`/projects/${projectId}`} className="text-yard-400 hover:text-yard-300">
                Open project
              </Link>
              <button className="text-zinc-400 hover:text-zinc-200" onClick={() => setParam("project", null)}>
                Show all projects
              </button>
            </div>
          )}

          {tab === "active" && (
            <>
              {strip.length > 0 && <RecentStrip tasks={strip} names={names} href={tabHref(params, "recent")} />}
              {shown.length ? (
                <TaskGrid key={tab} stable={stable} projectName={projectNameOf} />
              ) : (
                <Empty icon={<CheckCircle2 className="h-8 w-8" />} title="All quiet in the yard">
                  No agents are working right now. Ask the orchestrator for something new
                  {counts.needs_you > 0 && (
                    <>
                      , or{" "}
                      <Link href={tabHref(params, "needs_you")} className="text-yard-400 hover:text-yard-300">
                        see the {counts.needs_you} {counts.needs_you === 1 ? "task" : "tasks"} waiting on you
                      </Link>
                    </>
                  )}
                  .
                </Empty>
              )}
            </>
          )}

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
                  className="w-full rounded-xl border border-dashed border-zinc-800 py-2.5 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                >
                  {older ? "Hide tasks older than 24 hours" : `${olderCount} older finished ${olderCount === 1 ? "task" : "tasks"} · Show older`}
                </button>
              )}
            </>
          )}

          {tab === "all" && (
            <>
              <div className="flex items-center gap-2">
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

/** A compact row of the last few finished tasks, so the Active tab also answers "what just finished?". */
function RecentStrip({ tasks, names, href }: { tasks: Task[]; names: Map<string, string>; href: string }) {
  return (
    <section aria-label="Recently finished">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Recently finished</h2>
        <Link href={href} className="inline-flex items-center gap-0.5 text-xs text-zinc-500 hover:text-zinc-200">
          See recent <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="scroll-thin -mx-1 grid auto-cols-[minmax(10rem,1fr)] grid-flow-col gap-2 overflow-x-auto px-1 pb-1">
        {tasks.map((t) => (
          <Link
            key={t.id}
            href={`/tasks/${t.id}`}
            title={`${t.title} · ${STATUS[t.status].label}`}
            className="block min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 transition hover:border-zinc-700 hover:bg-zinc-900"
          >
            <div className="flex items-center gap-2">
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[t.status].dot)} />
              <span className="truncate text-sm text-zinc-200">{t.title}</span>
            </div>
            <div className="mt-0.5 flex gap-2 pl-3.5 text-xs text-zinc-500">
              <span className="min-w-0 flex-1 truncate">{names.get(t.projectId)}</span>
              <span className="shrink-0">
                {STATUS[t.status].label} · <TimeAgo ts={t.updatedAt} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
