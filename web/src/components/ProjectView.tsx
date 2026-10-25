import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useSearchParams } from "wouter"
import { AlarmClock, Bot, FileText, FolderGit2, ListTodo, NotebookPen, Settings, ShieldAlert, Trash2, Webhook, X } from "lucide-react"
import {
  useAgentSettings,
  useArtifacts,
  useCaptainState,
  useDeleteProject,
  useHooks,
  useProjects,
  useRunPod,
  useSchedules,
  useSettings,
  useSetup,
  useTasks,
  useUpdateProject,
} from "../lib/queries"
import {
  DEFAULT_FILTER,
  TASK_FILTERS,
  compareTasks,
  filterCounts,
  isVisible,
  parseFilter,
  parseSort,
  type TaskFilter,
} from "../lib/projectTasks"
import { Button, Empty, Field, LineIcon, NewTabLink, STATUS, Select, TimeAgo, cx, inputClass, parseEnv } from "./ui"
import { ArtifactLink, PREVIEW_GROUP } from "./FileLink"
import { TaskGrid, useStableTasks } from "./TaskGrid"
import { QuietToggle, SearchBox, SortSelect, TabBar, useSetParam, useShowQuiet, useUrlQuery, withParam } from "./TaskFilters"
import { ProjectSchedules } from "./Schedules"
import { NewTaskButton } from "./NewTask"
import { CaptainTab } from "./CaptainTab"
import { HooksPanel } from "./Hooks"
import { NotesTab } from "./NotesTab"
import { ProjectSnapshotPanel } from "./ProjectSnapshot"
import { useOpenSettings } from "./SettingsDialog"
import { BOX_SIZES, PROJECT_BOX_LIMITS, SIZE_DEFAULTS, WORKER_SIZES, type Artifact, type BoxSize, type Project, type SettingsInfo, type Task, type TaskStatus } from "../../../shared/types"
import { BOX_SIZE_SPECS, sizeSpecLine } from "../../../shared/boxSizes"
import { DEFAULT_NOTE_BUDGET, NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { LOCAL_UNSANDBOXED, RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"
import { confirmDialog } from "../lib/confirm"
import { PAGE_BLEED_BOTTOM } from "../lib/layout"
import { rememberProjectTab } from "../lib/breadcrumb"
import { isQuietRun } from "../../../shared/quiet"

const TABS = [
  { key: "tasks", label: "Tasks", icon: ListTodo },
  { key: "captain", label: "Captain", icon: Bot },
  { key: "schedules", label: "Schedules", icon: AlarmClock },
  { key: "hooks", label: "Hooks", icon: Webhook },
  { key: "notes", label: "Notes", icon: NotebookPen },
  { key: "files", label: "Files", icon: FileText },
  { key: "settings", label: "Settings", icon: Settings },
] as const
type Tab = (typeof TABS)[number]["key"]

/** Dot colour for each status filter chip. */
const FILTER_DOT: Partial<Record<TaskFilter, string>> = {
  needs_you: STATUS.needs_input.dot,
  active: STATUS.working.dot,
  pr_ready: STATUS.pr_ready.dot,
  failed: STATUS.failed.dot,
  done: STATUS.done.dot,
}

/** `/projects/<id>` plus the given query params, dropping empty ones and defaults. */
function projectHref(id: string, params: Record<string, string | null | undefined> = {}) {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v)
  const qs = search.toString()
  return `/projects/${id}${qs ? `?${qs}` : ""}`
}

export function ProjectView({ id }: { id: string }) {
  const projects = useProjects()
  const tasks = useTasks()
  const artifacts = useArtifacts()
  const schedules = useSchedules()
  const captain = useCaptainState(id)
  const hooks = useHooks(id)
  const [params, setParams] = useSearchParams()
  const [showNew, setShowNew] = useState(false)
  const project = projects.data?.find((p) => p.id === id)
  const tab: Tab = TABS.find((t) => t.key === params.get("tab"))?.key ?? "tasks"

  // The task page breadcrumb returns to this tab.
  useEffect(() => rememberProjectTab(id, tab), [id, tab])

  // A new task popover left open shouldn't follow you to another project.
  useEffect(() => setShowNew(false), [id])

  // `?new=task` (from the command palette) opens the new task popover once.
  const wantsNew = params.get("new") === "task"
  useEffect(() => {
    if (!wantsNew) return
    setShowNew(true)
    setParams((p) => withParam(p, "new", null), { replace: true })
  }, [wantsNew, setParams])

  if (projects.isLoading) return null
  if (!project) return <Empty title="Project not found">It may have been deleted.</Empty>

  const list = (tasks.data ?? []).filter((t) => t.projectId === id)
  const files = (artifacts.data ?? []).filter((a) => a.projectId === id)
  const scheduleCount = (schedules.data ?? []).filter((s) => s.target === "project" && s.projectId === id).length
  const openCount = list.filter((t) => t.status !== "done").length
  const needsYou = list.some((t) => t.status === "needs_input")

  /** The current URL with a different tab; tasks filters stay so coming back to Tasks keeps them. */
  const tabHref = (key: Tab) =>
    projectHref(id, { tab: key === "tasks" ? null : key, status: params.get("status"), q: params.get("q"), sort: params.get("sort") })
  const counts: Partial<Record<Tab, number>> = { tasks: openCount, schedules: scheduleCount, hooks: hooks.data?.length, notes: project.notes.length, files: files.length }

  return (
    // The Captain chat fills the rest of the page down to the window bottom (its Composer lines up with the
    // Coordinator's); other tabs flow and scroll with it.
    <div className={cx("space-y-5", tab === "captain" && cx("flex flex-col", PAGE_BLEED_BOTTOM))}>
      <ProjectHeader
        project={project}
        tasks={list}
        newTaskOpen={showNew}
        onNewTaskOpen={setShowNew}
      />

      <TabBar
        label="Project sections"
        selected={tab}
        tabs={TABS.map((t) => ({
          ...t,
          href: tabHref(t.key),
          count: counts[t.key],
          ...(t.key === "tasks" && needsYou && { dot: "bg-amber-400", title: "A task needs you" }),
          ...(t.key === "captain" && captain.data?.busy && { dot: "bg-sky-400 animate-pulse", title: "Captain is working" }),
        }))}
      />

      {tab === "tasks" && <TasksTab tasks={list} projectId={id} />}
      {tab === "captain" && <CaptainTab project={project} />}
      {tab === "schedules" && <ProjectSchedules projectId={id} />}
      {tab === "hooks" && <HooksPanel projectId={id} />}
      {tab === "notes" && <NotesTab project={project} />}
      {tab === "files" && <Files files={files} tasks={list} />}
      {tab === "settings" && (
        <div className="space-y-4">
          <ProjectSettings key={project.id} project={project} onDone={() => setParams((p) => withParam(p, "tab", null))} />
          <ProjectSnapshotPanel project={project} />
        </div>
      )}
    </div>
  )
}

/** A number field's value, or null when it's blank (use the default). */
function optionalInt(text: string): number | null {
  const n = optionalNumber(text)
  return n === null ? null : Math.round(n)
}

function optionalNumber(text: string): number | null {
  const n = Number(text.trim())
  return text.trim() && Number.isFinite(n) ? n : null
}

function repoUrl(repo: string) {
  return repo.includes("://") ? repo : `https://github.com/${repo}`
}

function ProjectHeader({
  project,
  tasks,
  newTaskOpen,
  onNewTaskOpen,
}: {
  project: Project
  tasks: Task[]
  newTaskOpen: boolean
  onNewTaskOpen: (open: boolean) => void
}) {
  const count = (statuses: TaskStatus[]) => tasks.filter((t) => statuses.includes(t.status)).length
  const stats: { label: string; n: number; dot: string; filter: TaskFilter }[] = [
    { label: "working", n: count(["working", "starting", "waiting", "queued"]), dot: STATUS.working.dot, filter: "active" },
    { label: "needs you", n: count(["needs_input"]), dot: STATUS.needs_input.dot, filter: "needs_you" },
    { label: "PR ready", n: count(["pr_ready"]), dot: STATUS.pr_ready.dot, filter: "pr_ready" },
  ]
  const failed = count(["failed"])
  if (failed) stats.push({ label: "failed", n: failed, dot: STATUS.failed.dot, filter: "failed" })

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-50">{project.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500">
          {project.repo ? (
            <NewTabLink href={repoUrl(project.repo)} className="inline-flex min-w-0 items-center gap-1.5 hover:text-zinc-300">
              <FolderGit2 className="h-4 w-4 shrink-0" /> <span className="truncate">{project.repo}</span>
            </NewTabLink>
          ) : (
            <span>No repo (non-coding project)</span>
          )}
        </div>
        {project.description && <p className="mt-2 line-clamp-2 max-w-2xl text-sm text-zinc-400">{project.description}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {stats.map((s) => (
            <Link
              key={s.label}
              href={projectHref(project.id, { status: s.filter })}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition",
                s.n ? "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100" : "border-zinc-900 text-zinc-600 hover:text-zinc-400",
              )}
            >
              <span className={cx("h-1.5 w-1.5 rounded-full", s.n ? s.dot.replace("animate-pulse", "") : "bg-zinc-700")} />
              <span className="font-semibold tabular-nums">{s.n}</span> {s.label}
            </Link>
          ))}
        </div>
      </div>
      <NewTaskButton projectId={project.id} open={newTaskOpen} onOpenChange={onNewTaskOpen} className="w-full sm:w-auto" />
    </header>
  )
}

function TasksTab({ tasks, projectId }: { tasks: Task[]; projectId: string }) {
  const [params] = useSearchParams()
  const filter = parseFilter(params.get("status"))
  const sort = parseSort(params.get("sort"))
  const [query, onQuery] = useUrlQuery()
  const setParam = useSetParam()
  const [showQuiet] = useShowQuiet()

  const counts = filterCounts(tasks, query, showQuiet)
  const quiet = tasks.filter((t) => isQuietRun(t) && isVisible(t, { filter, query, showQuiet: true })).length
  // Sorted once, then held still: live updates change cards in place; the pill re-sorts.
  const stable = useStableTasks(tasks, {
    compare: compareTasks(sort),
    include: (t) => isVisible(t, { filter, query, showQuiet }),
    resetKey: `${filter}|${sort}|${query}|${showQuiet}`,
  })
  const shown = stable.entries
  const filterLabel = TASK_FILTERS.find((f) => f.key === filter)!.label

  return (
    // pb-6: the page container's own padding is lost once the list overflows it (it is h-full for the task view).
    <div className="space-y-4 pb-6">
      {tasks.length === 0 ? (
        <Empty icon={<ListTodo className="h-8 w-8" />} title="No tasks yet">
          <p>Start one here, or ask the Coordinator to split up some work.</p>
          <NewTaskButton projectId={projectId} variant="subtle" size="sm" className="mt-3" />
        </Empty>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchBox value={query} onChange={onQuery} />
            <SortSelect sort={sort} />
            {(quiet > 0 || showQuiet) && <QuietToggle count={quiet} />}
          </div>

          <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter by status">
            {TASK_FILTERS.map((f) => {
              const selected = f.key === filter
              const n = counts[f.key]
              const dot = FILTER_DOT[f.key]
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setParam("status", f.key === DEFAULT_FILTER ? null : f.key)}
                  className={cx(
                    "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium whitespace-nowrap transition sm:min-h-0 sm:py-1",
                    selected ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800/80 text-zinc-400 hover:text-zinc-200",
                    !selected && n === 0 && "opacity-50",
                  )}
                >
                  {dot && <span className={cx("h-1.5 w-1.5 rounded-full", dot.replace("animate-pulse", ""))} />}
                  {f.label}
                  <span className={cx("tabular-nums", selected ? "text-yard-300/70" : "text-zinc-500")}>{n}</span>
                </button>
              )
            })}
          </div>

          {shown.length === 0 ? (
            <Empty title={query ? `No ${filter === "all" ? "" : `${filterLabel.toLowerCase()} `}tasks match "${query.trim()}"` : `No ${filterLabel.toLowerCase()} tasks`}>
              {query && counts.all > 0 ? (
                <button className="text-yard-400 hover:text-yard-300" onClick={() => setParam("status", "all")}>
                  {counts.all} {counts.all === 1 ? "match" : "matches"} in other statuses. Show all
                </button>
              ) : query ? (
                <button className="text-yard-400 hover:text-yard-300" onClick={() => onQuery("")}>
                  Clear the search
                </button>
              ) : filter !== DEFAULT_FILTER ? (
                <button className="text-yard-400 hover:text-yard-300" onClick={() => setParam("status", null)}>
                  Back to open tasks
                </button>
              ) : (
                "Everything here is done. New work shows up here."
              )}
            </Empty>
          ) : (
            <TaskGrid stable={stable} pillClassName="top-14" />
          )}

          {filter === "open" && counts.done > 0 && shown.length > 0 && (
            <button onClick={() => setParam("status", "done")} className="min-h-11 w-full rounded-xl border border-dashed border-zinc-800 py-2.5 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300">
              {counts.done} done {counts.done === 1 ? "task" : "tasks"} hidden · Show done
            </button>
          )}
        </>
      )}
    </div>
  )
}

function Files({ files: all, tasks }: { files: Artifact[]; tasks: Task[] }) {
  // `?task=<id>` (the task header's "Open in Files tab") shows only that task's files.
  const [params, setParams] = useSearchParams()
  const taskId = params.get("task")
  const files = taskId ? all.filter((a) => a.taskId === taskId) : all
  const filter = taskId && (
    <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 py-0.5 pr-0.5 pl-2 text-zinc-300">
        <span className="truncate">From {tasks.find((t) => t.id === taskId)?.title ?? taskId}</span>
        <button
          type="button"
          aria-label="Show all files"
          className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 sm:h-5 sm:w-5"
          onClick={() => setParams((p) => withParam(p, "task", null), { replace: true })}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
      <Link href={`/tasks/${taskId}`} className="shrink-0 hover:text-zinc-300 hover:underline">
        Open task
      </Link>
    </div>
  )
  if (files.length === 0)
    return (
      <>
        {filter}
        <Empty icon={<FileText className="h-8 w-8" />} title="No files yet">
          Reports, pages and exports that agents publish show up here.
        </Empty>
      </>
    )
  return (
    <div>
      {filter}
      <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-800/80" {...PREVIEW_GROUP}>
        {[...files]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((a) => (
            <li key={a.id} className="flex min-h-11 flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
              <ArtifactLink artifact={a} className="min-w-0 truncate text-zinc-200 hover:text-yard-400">
                {a.title}
              </ArtifactLink>
              <span className="ml-auto shrink-0 text-xs text-zinc-500 max-sm:w-full max-sm:pl-7">
                {(a.size / 1024).toFixed(1)} KB · <TimeAgo ts={a.createdAt} />
              </span>
            </li>
          ))}
      </ul>
    </div>
  )
}

/** "small 1 · medium 2 · large 4": a box limit that follows each box's size. */
const bySize = (k: "slotsPerBox" | "maxResidentPerBox") => WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(" · ")

/**
 * Project › Settings › Boxes: the project's own box size, agents per box, tasks per box and max boxes. Each one left
 * blank uses the global setting (Settings › Boxes & limits), which the field names ("Using global: …"); one that's
 * set has a Use global button that clears it.
 */
function ProjectBoxSettings(p: {
  info: SettingsInfo | undefined
  local: boolean
  gpu: boolean
  boxSize: BoxSize | ""
  setBoxSize: (v: BoxSize | "") => void
  agentsPerBox: string
  setAgentsPerBox: (v: string) => void
  tasksPerBox: string
  setTasksPerBox: (v: string) => void
  maxBoxes: string
  setMaxBoxes: (v: string) => void
  gpuMaxHourlyUsd: string
  setGpuMaxHourlyUsd: (v: string) => void
}) {
  const openSettings = useOpenSettings()
  const runpod = useRunPod({ enabled: p.gpu })
  const gpuCap = runpod.data ? `$${runpod.data.settings.maxHourlyUsd}/hr (Settings › RunPod GPU › Max per project)` : "Settings › RunPod GPU › Max per project"
  const s = p.info?.settings
  const followsSize = (k: "slotsPerBox" | "maxResidentPerBox") => !p.info || p.info.sources[k] === "default"
  const perBox = (k: "slotsPerBox" | "maxResidentPerBox") => (followsSize(k) || !s ? { long: `each box's size default (${bySize(k)})`, short: "by box size" } : { long: String(s[k]), short: String(s[k]) })
  const agents = perBox("slotsPerBox")
  const folders = perBox("maxResidentPerBox")
  const pool = s ? String(s.maxBoxes) : "the pool's"
  return (
    <section className="@container space-y-3 rounded-lg border border-zinc-800/80 p-3" aria-labelledby="project-boxes" data-testid="project-boxes">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="project-boxes" className="text-sm font-medium text-zinc-200">
          Boxes
        </h3>
        <button type="button" onClick={() => openSettings("limits")} className="inline-flex min-h-11 items-center text-xs text-sky-400 hover:underline sm:min-h-0">
          Global: Settings › Boxes & limits
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Leave one blank to use the global setting. Where projects share a box, the strictest limit wins.
        {p.local && " This project runs on this computer: Agents per box also limits its agents here, and the rest apply when it runs on boxes."}
        {p.gpu &&
          " This project runs on RunPod GPU pods: Agents per box sets its agents per pod (blank: Settings › RunPod GPU), Max boxes its most pods at once, and GPU cap what they may cost together. Tasks per box and Box size apply when it runs on boxes."}
      </p>
      <OverrideField
        id="project-box-size"
        label="Box size"
        global={`${s?.workerSize ?? "Settings"} (Worker size)`}
        set={Boolean(p.boxSize)}
        onClear={() => p.setBoxSize("")}
        hint="New boxes made for this project are this size, and its tasks only run on boxes at least this big. Boxes it already has keep their size; resize them from the Boxes page."
      >
        <Select id="project-box-size" className="w-full min-w-0 sm:w-80" value={p.boxSize} onChange={(e) => p.setBoxSize(e.target.value as BoxSize | "")} data-testid="project-box-size">
          <option value="">Global: {s?.workerSize ?? "Settings › Worker size"}</option>
          {BOX_SIZES.map((size) => (
            <option key={size} value={size}>
              {BOX_SIZE_SPECS[size].label}: {sizeSpecLine(size)}
            </option>
          ))}
        </Select>
      </OverrideField>
      <div className="grid gap-3 @4xl:grid-cols-3">
        <OverrideField
          id="project-agents-per-box"
          label="Agents per box"
          global={agents.long}
          set={p.agentsPerBox.trim() !== ""}
          onClear={() => p.setAgentsPerBox("")}
          hint="Most agents running at once on a box while one of this project's runs there, other projects' included. 1: each agent has a box to itself (game engines, big builds, headless browsers)."
        >
          <LimitInput id="project-agents-per-box" range={PROJECT_BOX_LIMITS.agentsPerBox} value={p.agentsPerBox} onChange={p.setAgentsPerBox} placeholder={`Global: ${agents.short}`} />
        </OverrideField>
        <OverrideField
          id="project-tasks-per-box"
          label="Tasks per box"
          global={folders.long}
          set={p.tasksPerBox.trim() !== ""}
          onClear={() => p.setTasksPerBox("")}
          hint="Most task folders on a box that holds one of this project's; older archived ones are parked to make room. Fewer suits a big repo."
        >
          <LimitInput id="project-tasks-per-box" range={PROJECT_BOX_LIMITS.tasksPerBox} value={p.tasksPerBox} onChange={p.setTasksPerBox} placeholder={`Global: ${folders.short}`} />
        </OverrideField>
        <OverrideField
          id="project-max-boxes"
          label="Max boxes"
          global={s ? `${s.maxBoxes} (the whole pool's Max boxes)` : "the pool's Max boxes"}
          set={p.maxBoxes.trim() !== ""}
          onClear={() => p.setMaxBoxes("")}
          hint="Most boxes this project's tasks use at once (made for it, or holding its task folders), within the pool's Max boxes. The rest wait for a free slot."
        >
          <LimitInput id="project-max-boxes" range={PROJECT_BOX_LIMITS.maxBoxes} value={p.maxBoxes} onChange={p.setMaxBoxes} placeholder={`Global: ${pool}`} />
        </OverrideField>
      </div>
      {p.gpu && (
        <OverrideField
          id="project-gpu-cap"
          label="GPU cap ($/hr)"
          global={gpuCap}
          set={p.gpuMaxHourlyUsd.trim() !== ""}
          onClear={() => p.setGpuMaxHourlyUsd("")}
          hint="Most this project's RunPod pods may cost together. A task that needs another pod over it waits and says so. 0: no cap of its own; Settings › RunPod GPU › Max for all pods still applies."
        >
          <LimitInput
            id="project-gpu-cap"
            range={PROJECT_BOX_LIMITS.gpuMaxHourlyUsd}
            step={0.05}
            value={p.gpuMaxHourlyUsd}
            onChange={p.setGpuMaxHourlyUsd}
            placeholder={runpod.data ? `Global: $${runpod.data.settings.maxHourlyUsd}` : "Global"}
          />
        </OverrideField>
      )}
    </section>
  )
}

/** A project setting with a global fallback: its label, the control, "Using global: …" (or the global it overrides) and Use global. */
function OverrideField({ id, label, global, set, onClear, hint, children }: { id: string; label: string; global: string; set: boolean; onClear: () => void; hint: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {set && (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={onClear} title={`Clear this project's ${label.toLowerCase()}: the global one applies`} data-testid={`${id}-clear`}>
            <X className="h-3.5 w-3.5" /> Use global
          </Button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        <span className={set ? undefined : "text-zinc-300"} data-testid={`${id}-source`}>
          {set ? `Overrides global: ${global}.` : `Using global: ${global}.`}
        </span>{" "}
        {hint}
      </p>
    </div>
  )
}

function LimitInput({
  id,
  range,
  step,
  value,
  onChange,
  placeholder,
}: {
  id: string
  range: { min: number; max: number }
  /** Below 1 for a price; whole numbers otherwise. */
  step?: number
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode={step && step < 1 ? "decimal" : "numeric"}
      min={range.min}
      max={range.max}
      step={step}
      className={cx(inputClass, "max-w-40 min-w-0")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={id}
    />
  )
}

function ProjectSettings({ project, onDone }: { project: Project; onDone: () => void }) {
  const update = useUpdateProject()
  const remove = useDeleteProject()
  const [, navigate] = useLocation()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [repo, setRepo] = useState(project.repo ?? "")
  const [baseBranch, setBaseBranch] = useState(project.baseBranch)
  const [env, setEnv] = useState("")
  const [removeKeys, setRemoveKeys] = useState<string[]>([])
  const [runner, setRunner] = useState<Runner>(project.runner ?? "box")
  const [boxSize, setBoxSize] = useState<BoxSize | "">(project.boxSize ?? "")
  const [partialClone, setPartialClone] = useState<"" | "on" | "off">(project.partialClone === null ? "" : project.partialClone ? "on" : "off")
  const [pushAtTurnEnd, setPushAtTurnEnd] = useState<"" | "on" | "off">(project.pushAtTurnEnd === null ? "" : project.pushAtTurnEnd ? "on" : "off")
  const [depCache, setDepCache] = useState<"" | "on" | "off">(project.depCache === null || project.depCache === undefined ? "" : project.depCache ? "on" : "off")
  const [agentsPerBox, setAgentsPerBox] = useState(project.agentsPerBox?.toString() ?? "")
  const [tasksPerBox, setTasksPerBox] = useState(project.tasksPerBox?.toString() ?? "")
  const [maxBoxes, setMaxBoxes] = useState(project.maxBoxes?.toString() ?? "")
  const [gpuMaxHourlyUsd, setGpuMaxHourlyUsd] = useState(project.gpuMaxHourlyUsd?.toString() ?? "")
  const [notesMax, setNotesMax] = useState(project.notesMaxCount?.toString() ?? "")
  const [notesTokens, setNotesTokens] = useState(project.notesMaxTokens?.toString() ?? "")
  const settings = useAgentSettings()
  const server = useSettings()
  const setup = useSetup()
  // Without an Upstash key there's nowhere to make a box: "Upstash box" waits until one is added (unless it's already set).
  const noUpstash = setup.data?.upstash.available === false
  // RunPod GPU waits for a RunPod key (Settings › RunPod GPU).
  const noRunPod = setup.data?.credentials.runpodApiKey?.state === "unset"
  const openSettings = useOpenSettings()
  const defaults = settings.data?.settings

  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
      onSubmit={async (e) => {
        e.preventDefault()
        if (runner === "local" && project.runner !== "local") {
          const ok = await confirmDialog({
            title: "Run agents on this computer?",
            body: `${project.name}'s agents will run here, not in Upstash boxes. ${LOCAL_UNSANDBOXED} Its tasks move off their boxes when nothing would be lost.`,
            confirmLabel: "Run on this computer",
            danger: true,
          })
          if (!ok) return
        }
        update.mutate({
          id: project.id,
          name,
          description,
          repo: repo.trim() || null,
          baseBranch,
          env: parseEnv(env),
          removeEnv: removeKeys,
          runner,
          boxSize: boxSize || null,
          partialClone: partialClone ? partialClone === "on" : null,
          pushAtTurnEnd: pushAtTurnEnd ? pushAtTurnEnd === "on" : null,
          depCache: depCache ? depCache === "on" : null,
          agentsPerBox: optionalInt(agentsPerBox),
          tasksPerBox: optionalInt(tasksPerBox),
          maxBoxes: optionalInt(maxBoxes),
          ...(runner === "gpu" || project.gpuMaxHourlyUsd !== null ? { gpuMaxHourlyUsd: optionalNumber(gpuMaxHourlyUsd) } : {}),
          notesMaxCount: optionalInt(notesMax),
          notesMaxTokens: optionalInt(notesTokens),
        })
        onDone()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Repo">
              <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
            </Field>
          </div>
          <Field label="Branch">
            <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Description">
        <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="space-y-2">
        <Field
          label="Runs on"
          hint={`Upstash box: each agent runs in an isolated Upstash box. This computer: agents run straight on the computer running Box Yard (its GPU, its logged-in claude and gh), each task in its own folder in ${server.data?.localDir ?? "~/boxyard-workspaces"}, ${settings.data?.settings.localAgents ?? 2} at a time (Settings → Local agents). RunPod GPU: the project gets GPU pods of its own at RunPod (up to its Max boxes, within its GPU cap), started when a task needs one and stopped when idle (Settings → RunPod GPU). Tasks move over when nothing would be lost.`}
        >
          <Select className="w-full sm:w-80" value={runner} onChange={(e) => setRunner(e.target.value as Runner)} data-testid="project-runner">
            {RUNNERS.map((r) => (
              <option key={r} value={r} disabled={(r === "box" && noUpstash && project.runner === "local") || (r === "gpu" && noRunPod && project.runner !== "gpu")}>
                {RUNNER_LABEL[r]}
                {r === "local"
                  ? " (not sandboxed)"
                  : r === "box" && noUpstash && project.runner === "local"
                    ? " (add an Upstash key in Settings first)"
                    : r === "gpu" && noRunPod && project.runner !== "gpu"
                      ? " (add a RunPod key in Settings first)"
                      : ""}
              </option>
            ))}
          </Select>
        </Field>
        {noUpstash && project.runner === "local" && (
          <p className="text-xs text-zinc-500" data-testid="runner-upstash-later">
            To run this project in isolated Upstash boxes, add an Upstash Box API key in Settings › Credentials.
          </p>
        )}
        {(runner === "gpu" || noRunPod) && (
          <p className="text-xs text-zinc-500" data-testid="runner-gpu-note">
            {runner === "gpu"
              ? "Billed by RunPod per hour while the pod runs, within the caps in Settings › RunPod GPU. Pods stop when idle; the project's network volume keeps caches between them."
              : "Need a GPU (a WebGL game, ML work)? Add a RunPod key to run this project on a RunPod GPU pod."}{" "}
            <button type="button" className="text-yard-300 underline-offset-2 hover:underline" onClick={() => openSettings("runpod")}>
              Settings › RunPod GPU
            </button>
          </p>
        )}
        {runner === "local" && (
          <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:max-w-xl" data-testid="runner-warning">
            <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
            <span>{LOCAL_UNSANDBOXED}</span>
          </div>
        )}
      </div>
      <ProjectBoxSettings
        info={settings.data}
        local={runner === "local"}
        gpu={runner === "gpu"}
        boxSize={boxSize}
        setBoxSize={setBoxSize}
        agentsPerBox={agentsPerBox}
        setAgentsPerBox={setAgentsPerBox}
        tasksPerBox={tasksPerBox}
        setTasksPerBox={setTasksPerBox}
        maxBoxes={maxBoxes}
        setMaxBoxes={setMaxBoxes}
        gpuMaxHourlyUsd={gpuMaxHourlyUsd}
        setGpuMaxHourlyUsd={setGpuMaxHourlyUsd}
      />
      <Field
        label="Partial clone mirror"
        hint="On: each box's mirror of the repo skips old file versions (blob:none) and fetches them from GitHub when git log -p, blame or a checkout needs them. Off: full mirror, for repos where agents dig through history a lot. Applies to mirrors made from now on; a mirror no task uses is re-made to match."
      >
        <Select className="w-full sm:w-80" value={partialClone} onChange={(e) => setPartialClone(e.target.value as "" | "on" | "off")} data-testid="project-partial-clone">
          <option value="">Default ({settings.data?.settings.gitPartialClone === false ? "off" : "on"}: Settings → Partial clone mirrors)</option>
          <option value="on">On: blob:none mirror</option>
          <option value="off">Off: full mirror</option>
        </Select>
      </Field>
      <Field
        label="Push at turn end"
        hint="On: after every turn Box Yard pushes the task's branch and keeps uncommitted work on a hidden ref (refs/boxyard/wip/<task>), so archives stay small and any box can go without losing code. Off: Box Yard pushes nothing itself, and archives hold the whole workspace. Needs write access to the repo; without it Box Yard falls back to full archives by itself."
      >
        <Select className="w-full sm:w-80" value={pushAtTurnEnd} onChange={(e) => setPushAtTurnEnd(e.target.value as "" | "on" | "off")} data-testid="project-push-at-turn-end">
          <option value="">Default ({settings.data?.settings.gitPushAtTurnEnd === false ? "off" : "on"}: Settings → Push at turn end)</option>
          <option value="on">On: push branch and WIP, small archives</option>
          <option value="off">Off: full archives</option>
        </Select>
      </Field>
      <Field
        label="Dependency cache"
        hint="On: a task with a package-lock.json and no node_modules (a fresh clone, or one the idle cleanup emptied) gets the box's installed copy for that lockfile, hard-linked in under a second, so it needs no npm ci. Off: agents install as usual."
      >
        <Select className="w-full sm:w-80" value={depCache} onChange={(e) => setDepCache(e.target.value as "" | "on" | "off")} data-testid="project-dep-cache">
          <option value="">Default ({settings.data?.settings.depCacheEnabled ? "on" : "off"}: Settings → Dependency cache)</option>
          <option value="on">On: restore node_modules from the box cache</option>
          <option value="off">Off: agents install dependencies</option>
        </Select>
      </Field>
      <div className="grid gap-3 sm:max-w-xl sm:grid-cols-2">
        <Field label="Max notes" hint={`This project's own notes budget for agents' prompts. Blank: ${defaults?.notesMaxCount ?? DEFAULT_NOTE_BUDGET.maxNotes} (Settings → Max notes).`}>
          <input
            type="number"
            inputMode="numeric"
            min={NOTE_BUDGET_LIMITS.maxNotes.min}
            max={NOTE_BUDGET_LIMITS.maxNotes.max}
            className={inputClass}
            value={notesMax}
            onChange={(e) => setNotesMax(e.target.value)}
            placeholder={String(defaults?.notesMaxCount ?? DEFAULT_NOTE_BUDGET.maxNotes)}
            data-testid="project-notes-max"
          />
        </Field>
        <Field label="Max note tokens" hint={`About how many tokens they may take. Blank: ${(defaults?.notesMaxTokens ?? DEFAULT_NOTE_BUDGET.maxTokens).toLocaleString()} (Settings).`}>
          <input
            type="number"
            inputMode="numeric"
            min={NOTE_BUDGET_LIMITS.maxTokens.min}
            max={NOTE_BUDGET_LIMITS.maxTokens.max}
            step={100}
            className={inputClass}
            value={notesTokens}
            onChange={(e) => setNotesTokens(e.target.value)}
            placeholder={String(defaults?.notesMaxTokens ?? DEFAULT_NOTE_BUDGET.maxTokens)}
            data-testid="project-notes-max-tokens"
          />
        </Field>
      </div>
      <Field label="Env vars" hint="Values are write-only. Add KEY=value lines to set or replace.">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {project.envKeys.map((k) => (
            <button
              type="button"
              key={k}
              onClick={() => setRemoveKeys((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]))}
              className={`min-h-11 rounded-md px-2 py-1 font-mono text-xs sm:min-h-0 sm:py-0.5 ${removeKeys.includes(k) ? "bg-red-500/20 text-red-300 line-through" : "bg-zinc-800 text-zinc-300"}`}
              title="Click to remove"
            >
              {k}
            </button>
          ))}
        </div>
        <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="NEW_KEY=value" />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="danger"
          className="sm:mr-auto"
          onClick={async () => {
            if (await confirmDialog({ title: "Delete project?", body: `Delete ${project.name} and all its tasks? This can't be undone.`, confirmLabel: "Delete project", danger: true })) {
              remove.mutate(project.id)
              navigate("/")
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete project
        </Button>
        <div className="flex gap-2 max-sm:flex-col-reverse sm:ml-auto">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </div>
    </form>
  )
}
