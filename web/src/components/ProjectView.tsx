import { useState } from "react"
import { useLocation } from "wouter"
import { FileText, FolderGit2, NotebookPen, Plus, Settings, Trash2 } from "lucide-react"
import {
  newClientId,
  useAddNote,
  useArtifacts,
  useCreateTask,
  useDeleteProject,
  useProjects,
  useTasks,
  useUpdateProject,
} from "../lib/queries"
import { Button, Empty, Field, inputClass, parseEnv, TimeAgo } from "./ui"
import { TaskCard } from "./TaskCard"
import type { Project, TaskStatus } from "../../../shared/types"

const ORDER: TaskStatus[] = ["needs_input", "failed", "working", "starting", "waiting", "queued", "pr_ready", "idle", "done"]

export function ProjectView({ id }: { id: string }) {
  const projects = useProjects()
  const tasks = useTasks()
  const artifacts = useArtifacts()
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState(false)
  const project = projects.data?.find((p) => p.id === id)

  if (projects.isLoading) return null
  if (!project) return <Empty title="Project not found">It may have been deleted.</Empty>

  const list = (tasks.data ?? [])
    .filter((t) => t.projectId === id)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt)
  const files = (artifacts.data ?? []).filter((a) => a.projectId === id)

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">{project.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500">
            {project.repo ? (
              <a href={project.repo.includes("://") ? project.repo : `https://github.com/${project.repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-zinc-300">
                <FolderGit2 className="h-4 w-4" /> {project.repo} · {project.baseBranch}
              </a>
            ) : (
              <span>No repo (non-coding project)</span>
            )}
            {project.envKeys.length > 0 && <span className="font-mono text-xs">{project.envKeys.join(" · ")}</span>}
          </div>
          {project.description && <p className="mt-2 max-w-2xl text-sm text-zinc-400">{project.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
            <Settings className="h-4 w-4" /> Settings
          </Button>
          <Button variant="primary" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New task
          </Button>
        </div>
      </header>

      {editing && <ProjectSettings project={project} onDone={() => setEditing(false)} />}
      {showNew && <NewTaskForm projectId={id} onDone={() => setShowNew(false)} />}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Tasks</h2>
        {list.length === 0 ? (
          <Empty title="No tasks yet">Add one here, or ask the orchestrator to split up some work.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Notes project={project} />
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <FileText className="h-4 w-4" /> Artifacts
          </h2>
          {files.length === 0 ? (
            <p className="text-sm text-zinc-500">Files agents publish show up here.</p>
          ) : (
            <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-800/80">
              {files.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-zinc-200 hover:text-yard-400">
                    {a.title}
                  </a>
                  <span className="ml-auto shrink-0 text-xs text-zinc-500">
                    {(a.size / 1024).toFixed(1)} KB · <TimeAgo ts={a.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function Notes({ project }: { project: Project }) {
  const add = useAddNote()
  const [text, setText] = useState("")
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">
        <NotebookPen className="h-4 w-4" /> Shared notes
      </h2>
      <p className="mb-2 text-xs text-zinc-500">Every agent in this project reads these. Agents add their own too.</p>
      <ul className="mb-3 space-y-1.5">
        {project.notes.map((n) => (
          <li key={n.id} className="rounded-lg bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300">
            <span className="mr-2 text-xs text-zinc-500">{n.author}</span>
            {n.content}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          add.mutate({ projectId: project.id, content: text.trim() })
          setText("")
        }}
      >
        <input className={inputClass} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Use pnpm, not npm" />
        <Button type="submit" disabled={!text.trim()}>
          Add
        </Button>
      </form>
    </section>
  )
}

function NewTaskForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [env, setEnv] = useState("")
  const [showEnv, setShowEnv] = useState(false)
  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!title.trim() || !prompt.trim()) return
        const id = newClientId("task")
        create.mutate({ id, projectId, title: title.trim(), prompt: prompt.trim(), env: parseEnv(env) })
        onDone()
        navigate(`/tasks/${id}`)
      }}
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
        <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setShowEnv(true)}>
          + env vars
        </button>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!title.trim() || !prompt.trim()}>
          Start agent
        </Button>
      </div>
    </form>
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
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
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
              className={`rounded-md px-2 py-0.5 font-mono text-xs ${removeKeys.includes(k) ? "bg-red-500/20 text-red-300 line-through" : "bg-zinc-800 text-zinc-300"}`}
              title="Click to remove"
            >
              {k}
            </button>
          ))}
        </div>
        <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="NEW_KEY=value" />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="danger"
          onClick={() => {
            if (confirm(`Delete ${project.name} and all its tasks? This can't be undone.`)) {
              remove.mutate(project.id)
              navigate("/")
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete project
        </Button>
        <div className="ml-auto flex gap-2">
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
