import { useState } from "react"
import { useLocation } from "wouter"
import { ShieldAlert } from "lucide-react"
import { newClientId, useCreateProject, useMachines, useSetup } from "../lib/queries"
import { Modal } from "./Modal"
import { MachineLabelPicker } from "./MachineSettings"
import { Button, Field, LineIcon, Select, inputClass, parseEnv } from "./ui"
import { LOCAL_UNSANDBOXED, RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation()
  const create = useCreateProject()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [repo, setRepo] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [env, setEnv] = useState("")
  const setup = useSetup()
  // Where setup chose (This computer or Upstash boxes) until picked here.
  const [picked, setPicked] = useState<Runner | null>(null)
  const runner = picked ?? setup.data?.runner.default ?? null
  const noUpstash = setup.data?.upstash.available === false
  const noRunPod = setup.data?.credentials.runpodApiKey?.state === "unset"
  const noMachines = useMachines().data?.machines.length === 0
  const [machineLabel, setMachineLabel] = useState("")

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const id = newClientId("prj")
    create.mutate({ id, name: name.trim(), description, repo: repo.trim() || null, baseBranch, env: parseEnv(env), ...(runner && { runner }), ...(runner === "ssh" ? { machineLabel: machineLabel || null } : {}) })
    onClose()
    navigate(`/projects/${id}`)
  }

  const dirty = Boolean(name || description || repo || env || baseBranch !== "main" || picked || machineLabel)

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
      {runner && (
        <div className="space-y-2">
          <Field label="Runs on" hint="Change it any time in the project's Settings.">
            <Select className="w-full sm:w-80" value={runner} onChange={(e) => setPicked(e.target.value as Runner)} data-testid="new-project-runner">
              {RUNNERS.map((r) => (
                <option key={r} value={r} disabled={(r === "box" && noUpstash) || (r === "gpu" && noRunPod) || (r === "ssh" && noMachines)}>
                  {RUNNER_LABEL[r]}
                  {r === "local"
                    ? " (not sandboxed)"
                    : r === "gpu"
                      ? noRunPod
                        ? " (add a RunPod key in Settings first)"
                        : ""
                      : r === "docker"
                        ? " (isolated, on this computer)"
                        : r === "ssh"
                          ? noMachines
                            ? " (add one in Settings › Machines first)"
                            : " (your own computers, not sandboxed)"
                          : noUpstash
                            ? " (add an Upstash key in Settings first)"
                            : ""}
                </option>
              ))}
            </Select>
          </Field>
          {runner === "local" && (
            <p role="note" className="flex items-start gap-2 text-xs leading-relaxed text-amber-200/90">
              <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
              <span>{LOCAL_UNSANDBOXED}</span>
            </p>
          )}
          {runner === "ssh" && (
            <Field label="Which machines" hint="Agents run as the user Box Yard logs in as there: they're not sandboxed.">
              <MachineLabelPicker value={machineLabel} onChange={setMachineLabel} />
            </Field>
          )}
        </div>
      )}
      <Field label="Env vars (optional)" hint="KEY=value, one per line. Every task in the project gets them.">
        <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
      </Field>
    </Modal>
  )
}
