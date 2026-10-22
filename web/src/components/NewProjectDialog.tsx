import { useState } from "react"
import { useLocation } from "wouter"
import { newClientId, useCreateProject } from "../lib/queries"
import { Modal } from "./Modal"
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

  const dirty = Boolean(name || description || repo || env || baseBranch !== "main")

  return (
    <Modal
      size="md"
      title="New project"
      dirty={dirty}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="marketing-site" />
      </Field>
      <Field label="Description" hint="Agents in this project see this.">
        <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-3">
        <div className="min-w-0 flex-1">
          <Field label="GitHub repo (optional)" hint="owner/name. Leave empty for non-coding work.">
            <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="webdevcody/box-yard" />
          </Field>
        </div>
        <div className="sm:w-36 sm:shrink-0">
          <Field label="Base branch">
            <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Env vars (optional)" hint="KEY=value, one per line. Every task in the project gets them.">
        <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
      </Field>
    </Modal>
  )
}
