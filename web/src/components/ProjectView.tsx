import { useEffect, useState } from "react"
import { Link, useLocation, useSearchParams } from "wouter"
import { AlarmClock, Bot, Box, FileText, FolderGit2, GitBranch, ListTodo, NotebookPen, Plus, Search, Settings, Trash2, X } from "lucide-react"
import {
  newClientId,
  useAddNote,
  useArtifacts,
  useBoxes,
  useCaptainState,
  useCreateTask,
  useDeleteProject,
  useProjects,
  useSchedules,
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
import { Modal } from "./Modal"
import { Button, Empty, Field, NewTabLink, STATUS, TimeAgo, cx, inputClass, parseEnv } from "./ui"
import { ArtifactLink, PREVIEW_GROUP } from "./FileLink"
import { TaskGrid, useStableTasks } from "./TaskGrid"
import { QuietToggle, SearchBox, SortSelect, TabBar, useSetParam, useShowQuiet, useUrlQuery, withParam } from "./TaskFilters"
import { ProjectSchedules } from "./Schedules"
import { CaptainTab } from "./CaptainTab"
import type { Artifact, BoxInfo, Project, Task, TaskStatus } from "../../../shared/types"
import { confirmDialog } from "../lib/confirm"
import { PAGE_BLEED_BOTTOM } from "../lib/layout"
import { rememberProjectTab } from "../lib/breadcrumb"
import { isQuietRun } from "../../../shared/quiet"

const TABS = [
  { key: "tasks", label: "Tasks", icon: ListTodo },
  { key: "captain", label: "Captain", icon: Bot },
  { key: "schedules", label: "Schedules", icon: AlarmClock },
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
  const [params, setParams] = useSearchParams()
  const [showNew, setShowNew] = useState(false)
  const project = projects.data?.find((p) => p.id === id)
  const tab: Tab = TABS.find((t) => t.key === params.get("tab"))?.key ?? "tasks"

  // The task page breadcrumb returns to this tab.
  useEffect(() => rememberProjectTab(id, tab), [id, tab])

  // A new task dialog left open shouldn't follow you to another project.
  useEffect(() => setShowNew(false), [id])

  // `?new=task` (from the command palette) opens the new task dialog once.
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
  const counts: Partial<Record<Tab, number>> = { tasks: openCount, schedules: scheduleCount, notes: project.notes.length, files: files.length }

  return (
    // The Captain chat fills the rest of the page down to the window bottom (its Composer lines up with the
    // Coordinator's); other tabs flow and scroll with it.
    <div className={cx("space-y-5", tab === "captain" && cx("flex flex-col", PAGE_BLEED_BOTTOM))}>
      <ProjectHeader
        project={project}
        tasks={list}
        onNewTask={() => setShowNew(true)}
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

      {tab === "tasks" && <TasksTab tasks={list} />}
      {tab === "captain" && <CaptainTab project={project} />}
      {tab === "schedules" && <ProjectSchedules projectId={id} />}
      {tab === "notes" && <Notes project={project} />}
      {tab === "files" && <Files files={files} tasks={list} />}
      {tab === "settings" && <ProjectSettings key={project.id} project={project} onDone={() => setParams((p) => withParam(p, "tab", null))} />}
      {showNew && <NewTaskDialog projectId={id} onDone={() => setShowNew(false)} />}
    </div>
  )
}

function repoUrl(repo: string) {
  return repo.includes("://") ? repo : `https://github.com/${repo}`
}

/** The boxes this project's tasks live on right now. */
function projectBoxes(boxes: BoxInfo[], project: Project, tasks: Task[]) {
  const ids = new Set(tasks.map((t) => t.id))
  return boxes.filter((b) => b.residentTasks.some((t) => ids.has(t)) || b.projects.includes(project.name))
}

function ProjectHeader({ project, tasks, onNewTask }: { project: Project; tasks: Task[]; onNewTask: () => void }) {
  const boxes = useBoxes()
  const onBoxes = projectBoxes(boxes.data ?? [], project, tasks)
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
            <>
              <NewTabLink href={repoUrl(project.repo)} className="inline-flex min-w-0 items-center gap-1.5 hover:text-zinc-300">
                <FolderGit2 className="h-4 w-4 shrink-0" /> <span className="truncate">{project.repo}</span>
              </NewTabLink>
              <span className="inline-flex items-center gap-1.5" title="Base branch">
                <GitBranch className="h-4 w-4" /> {project.baseBranch}
              </span>
            </>
          ) : (
            <span>No repo (non-coding project)</span>
          )}
          <span className="inline-flex min-w-0 items-center gap-1.5" title={onBoxes.length ? `Lives on ${onBoxes.map((b) => b.id).join(", ")}` : "No box right now"}>
            <Box className="h-4 w-4 shrink-0" />
            {onBoxes.length ? (
              <span className="truncate font-mono text-xs">
                {onBoxes[0]!.id}
                {onBoxes.length > 1 && <span className="font-sans text-zinc-600"> +{onBoxes.length - 1} more</span>}
              </span>
            ) : (
              "no box yet"
            )}
          </span>
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
      <Button variant="primary" onClick={onNewTask} className="w-full sm:w-auto">
        <Plus className="h-4 w-4" /> New task
      </Button>
    </header>
  )
}

function TasksTab({ tasks }: { tasks: Task[] }) {
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
          Add one with New task, or ask the Coordinator to split up some work.
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

function Notes({ project }: { project: Project }) {
  const add = useAddNote()
  const [text, setText] = useState("")
  const [filter, setFilter] = useState("")
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const notes = [...project.notes]
    .reverse()
    .filter((n) => words.every((w) => `${n.author} ${n.content}`.toLowerCase().includes(w)))
  const submit = () => {
    if (!text.trim()) return
    add.mutate({ projectId: project.id, content: text.trim() })
    setText("")
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-zinc-500">Shared memory: every agent in this project reads these notes, and agents add their own.</p>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          className={cx(inputClass, "min-h-[2.5rem] resize-y")}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="e.g. Use pnpm, not npm"
        />
        <Button type="submit" variant="primary" disabled={!text.trim()} className="shrink-0">
          <Plus className="h-4 w-4" /> Add note
        </Button>
      </form>

      {project.notes.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input className={cx(inputClass, "pl-9")} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter notes" aria-label="Filter notes" />
        </div>
      )}

      {project.notes.length === 0 ? (
        <Empty icon={<NotebookPen className="h-8 w-8" />} title="No notes yet">
          Save decisions, gotchas and how-to-run facts here so every agent starts with them.
        </Empty>
      ) : notes.length === 0 ? (
        <p className="text-sm text-zinc-500">No notes match "{filter.trim()}".</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                <span className="truncate font-medium text-zinc-400">{n.author}</span>
                <span className="ml-auto shrink-0">
                  <TimeAgo ts={n.createdAt} />
                </span>
              </div>
              <p className="text-sm break-words whitespace-pre-wrap text-zinc-300">{n.content}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
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

function NewTaskDialog({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [env, setEnv] = useState("")
  const [showEnv, setShowEnv] = useState(false)
  return (
    <Modal
      size="lg"
      title="New task"
      dirty={Boolean(title || prompt || env)}
      onClose={onDone}
      onSubmit={(e) => {
        e.preventDefault()
        if (!title.trim() || !prompt.trim()) return
        const id = newClientId("task")
        create.mutate({ id, projectId, title: title.trim(), prompt: prompt.trim(), env: parseEnv(env) })
        onDone()
        navigate(`/tasks/${id}`)
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || !prompt.trim()}>
            Start agent
          </Button>
        </>
      }
    >
      <Field label="Title">
        <input autoFocus className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a dark mode toggle" />
      </Field>
      <Field label="What should the agent do?">
        <textarea className={inputClass} rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Goal, constraints, and what done looks like." />
      </Field>
      {showEnv ? (
        <Field label="Extra env vars for this task" hint="KEY=value per line; added to the project's env.">
          <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
        </Field>
      ) : (
        <button type="button" className="min-h-11 text-left text-xs whitespace-nowrap text-zinc-500 hover:text-zinc-300 sm:min-h-0" onClick={() => setShowEnv(true)}>
          + env vars
        </button>
      )}
    </Modal>
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

  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        update.mutate({ id: project.id, name, description, repo: repo.trim() || null, baseBranch, env: parseEnv(env), removeEnv: removeKeys })
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
