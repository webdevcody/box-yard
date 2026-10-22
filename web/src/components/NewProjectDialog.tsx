import { useState } from "react"
import { useLocation } from "wouter"
import { X } from "lucide-react"
import { newClientId, useCreateProject } from "../lib/queries"
import { Button, Field, inputClass, parseEnv } from "./ui"

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation()
  const create = useCreateProject()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [repo, setRepo] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [env, setEnv] = useState("")

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const id = newClientId("prj")
    create.mutate({ id, name: name.trim(), description, repo: repo.trim() || null, baseBranch, env: parseEnv(env) })
    onClose()
    navigate(`/projects/${id}`)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-50">New project</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-5 w-5" />
          </button>
        </div>
        <Field label="Name">
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="marketing-site" />
        </Field>
        <Field label="Description" hint="Agents in this project see this.">
          <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="GitHub repo (optional)" hint="owner/name. Leave empty for non-coding work.">
              <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="webdevcody/box-yard" />
            </Field>
          </div>
          <Field label="Base branch">
            <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </Field>
        </div>
        <Field label="Env vars (optional)" hint="KEY=value, one per line. Every task in the project gets them.">
          <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create project
          </Button>
        </div>
      </form>
    </div>
  )
}
