import { useState } from "react"
import { useLocation } from "wouter"
import { ShieldAlert } from "lucide-react"
import { newClientId, useAgentSettings, useCreateProject, useSetup } from "../lib/queries"
import { Modal } from "./Modal"
import { Button, Field, LineIcon, Select, inputClass, parseEnv } from "./ui"
import { LOCAL_UNSANDBOXED, RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"
import { AGENT_CLIS, AGENT_CLI_LABEL, DEFAULT_AGENT_CLI, type AgentCli } from "../../../shared/agentCli"

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
  // A GPU project runs on RunPod or Vast.ai: either key lets it be picked (Project › Settings › Boxes picks the cloud).
  const noRunPod = setup.data?.credentials.runpodApiKey?.state === "unset" && setup.data?.credentials.vastApiKey?.state !== "set"
  // "" follows Settings › Box agents › Agent.
  const [agentCli, setAgentCli] = useState<AgentCli | "">("")
  const defaultAgentCli = useAgentSettings().data?.settings.agentCli ?? DEFAULT_AGENT_CLI

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const id = newClientId("prj")
    create.mutate({ id, name: name.trim(), description, repo: repo.trim() || null, baseBranch, env: parseEnv(env), ...(runner && { runner }), ...(agentCli && { agentCli }) })
    onClose()
    navigate(`/projects/${id}`)
  }

  const dirty = Boolean(name || description || repo || env || baseBranch !== "main" || picked || agentCli)

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
                <option key={r} value={r} disabled={(r === "box" && noUpstash) || (r === "gpu" && noRunPod)}>
                  {RUNNER_LABEL[r]}
                  {r === "local" ? " (not sandboxed)" : r === "gpu" ? (noRunPod ? " (add a RunPod or Vast.ai key in Settings first)" : "") : r === "docker" ? " (isolated, on this computer)" : noUpstash ? " (add an Upstash key in Settings first)" : ""}
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
        </div>
      )}
      <Field label="Agent" hint="Claude Code or Codex for its tasks. Change it any time in the project's Settings.">
        <Select className="w-full sm:w-80" value={agentCli} onChange={(e) => setAgentCli(e.target.value as AgentCli | "")} data-testid="new-project-agent-cli">
          <option value="">Settings default ({AGENT_CLI_LABEL[defaultAgentCli]})</option>
          {AGENT_CLIS.map((c) => (
            <option key={c} value={c}>
              {AGENT_CLI_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Env vars (optional)" hint="KEY=value, one per line. Every task in the project gets them.">
        <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
      </Field>
    </Modal>
  )
}
