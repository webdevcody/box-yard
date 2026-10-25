// Settings › RunPod GPU: the RunPod key, the pod image (built with this computer's Docker and pushed to the owner's
// own registry, or RunPod's stock image), which GPUs to try, idle stop and spending caps, and the pods and network
// volumes this Box Yard has at RunPod right now. docs/runpod.md explains the runner.
import { useEffect, useState } from "react"
import { ArrowUp, Flame, Hammer, Power, Trash2, X } from "lucide-react"
import { api } from "../lib/api"
import { confirmDialog } from "../lib/confirm"
import { useRunPod, useRunPodAction, useRunPodGpus, useSetup } from "../lib/queries"
import { CREDENTIAL_INFO } from "../../../shared/setup"
import { RUNPOD_STOCK_IMAGE, type RunPodImageBuild, type RunPodSettings, type RunPodStatus } from "../../../shared/runpod"
import { CredentialField } from "./Setup"
import { Panel, Row } from "./SettingsDialog"
import { Button, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"

const linkClass = "text-yard-300 underline-offset-2 hover:underline"
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`)

type Numeric = "idleMinutes" | "agentsPerPod" | "containerDiskGb" | "volumeGb" | "maxHourlyUsd" | "totalMaxHourlyUsd" | "watchdogMinutes"
const NUMBERS: { key: Numeric; label: string; help: string; step?: number; unit: string }[] = [
  { key: "idleMinutes", label: "Stop when idle", unit: "min", help: "A pod with no agent running or waiting is stopped after this long. Its network volume stays; the next task starts a new pod." },
  { key: "agentsPerPod", label: "Agents per pod", unit: "agents", help: "Agents of one project that may run on its pod at once, unless the project sets its own Agents per box." },
  { key: "maxHourlyUsd", label: "Max per pod", unit: "$/hr", step: 0.05, help: "GPU types listed above this are skipped, and a pod that comes back pricier is terminated at once." },
  { key: "totalMaxHourlyUsd", label: "Max for all pods", unit: "$/hr", step: 0.05, help: "No new pod starts when it would take the GPU spend of every running pod over this." },
  { key: "volumeGb", label: "Network volume", unit: "GB", help: "Each GPU project gets a volume this size at /workspace for caches, datasets and model weights, kept across pods (about $0.07/GB/month). 0: none, and pods start in any datacenter." },
  { key: "containerDiskGb", label: "Pod disk", unit: "GB", help: "The pod's own disk, where task folders live while it runs. It goes with the pod." },
  { key: "watchdogMinutes", label: "Watchdog", unit: "min", help: "Each pod terminates itself when this Box Yard hasn't been in touch for this long (this computer slept or went offline), so a pod never runs up a bill on its own." },
]

export function RunPodPanel({ fid }: { fid: (k: string) => string }) {
  const setup = useSetup()
  const key = setup.data?.credentials.runpodApiKey
  const status = useRunPod({ poll: true })
  const s = status.data
  return (
    <Panel section="runpod">
      <Row
        id={fid("runpod-key")}
        label={CREDENTIAL_INFO.runpodApiKey.label}
        help={
          <>
            Lets projects set Runs on to RunPod GPU: each gets a GPU pod of its own that starts when a task needs it and stops when idle.{" "}
            <NewTabLink href={CREDENTIAL_INFO.runpodApiKey.link.href} className={linkClass}>
              {CREDENTIAL_INFO.runpodApiKey.link.label}
            </NewTabLink>{" "}
            (read and write). Kept on this server, never sent back. Env var: <code className="font-mono">RUNPOD_API_KEY</code>.
          </>
        }
      >
        {key ? <CredentialField k="runpodApiKey" status={key} id={fid("runpod-key")} /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Row>
      {!s ? (
        <p className="text-sm text-zinc-500">{status.error ? `Couldn't load: ${status.error.message}` : "Loading…"}</p>
      ) : (
        <>
          {s.error && <p className="mb-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">RunPod: {s.error}</p>}
          <ImageRow fid={fid} status={s} />
          <GpuRow fid={fid} status={s} />
          <NumbersRows fid={fid} settings={s.settings} />
          <PodsRow status={s} />
          <VolumesRow status={s} />
        </>
      )}
    </Panel>
  )
}

/** The image pods start from: the stock one (no Docker needed) or one built here and pushed to the owner's registry. */
function ImageRow({ fid, status }: { fid: (k: string) => string; status: RunPodStatus }) {
  const { settings, docker, build, currentTag } = status
  const [repo, setRepo] = useState(settings.imageRepo ?? "")
  useEffect(() => setRepo(settings.imageRepo ?? ""), [settings.imageRepo])
  const start = useRunPodAction<string>("Couldn't start the image build", (r) => api<RunPodImageBuild>("/api/runpod/image/build", { body: { repo: r } }))
  const save = useSaveRunPod()
  const stale = Boolean(settings.image && settings.imageRepo && settings.image.startsWith(`${settings.imageRepo}:`) && !settings.image.endsWith(`:${currentTag}`))
  const running = build.state === "running"
  return (
    <Row
      id={fid("runpod-image")}
      label="Pod image"
      help={
        <>
          Pods start from RunPod's stock PyTorch image and install the agent tools (Node, Claude Code, gh, Chrome) in about a minute each time. Build Box Yard's own image once and pods are ready
          in seconds: it's built from this repo's <code className="font-mono">runpod/</code> folder with Docker on this computer and pushed to a registry repository of yours, which must be
          public so RunPod can pull it. It holds only public tools, never a key. Log in first with <code className="font-mono">docker login</code>.
        </>
      }
    >
      <p className="text-xs text-zinc-400">
        Using: <span className="break-all font-mono text-zinc-200">{settings.image ?? `${RUNPOD_STOCK_IMAGE} (stock)`}</span>
      </p>
      {stale && <p className="text-xs text-amber-300">Box Yard's pod scripts changed since this build. Pods still get the new scripts, but build again to bake them in.</p>}
      <input
        id={fid("runpod-image")}
        className={cx(inputClass, "font-mono text-xs")}
        placeholder="docker.io/<your-docker-user>/boxyard-gpu"
        value={repo}
        spellCheck={false}
        onChange={(e) => setRepo(e.target.value)}
      />
      {docker.error && <p className="text-xs text-amber-300">{docker.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!repo.trim() || !docker.running || running} loading={running || start.isPending} onClick={() => start.mutate(repo.trim())}>
          <Hammer className="h-3.5 w-3.5" /> {running ? "Building…" : "Build & push"}
        </Button>
        {settings.image && (
          <Button size="sm" variant="ghost" onClick={() => save.mutate({ image: null })}>
            Use the stock image
          </Button>
        )}
      </div>
      {build.state !== "idle" && (
        <div className="space-y-1">
          <p className={cx("text-xs", build.state === "failed" ? "text-red-300" : build.state === "succeeded" ? "text-emerald-300" : "text-zinc-400")}>
            {build.state === "running" ? `Building ${build.image} (the first build takes 10–20 minutes)…` : build.state === "succeeded" ? `Built and pushed ${build.image}; new pods use it.` : build.error}
          </p>
          {build.warning && <p className="text-xs text-amber-300">{build.warning}</p>}
          <pre className="scroll-thin max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 text-[10px] leading-snug text-zinc-400">{build.log.split("\n").slice(-60).join("\n")}</pre>
        </div>
      )}
    </Row>
  )
}

function useSaveRunPod() {
  return useRunPodAction<Partial<RunPodSettings>>("Couldn't save the RunPod settings", (patch) => api<RunPodStatus>("/api/runpod/settings", { method: "PUT", body: patch }))
}

/** GPU types to try, in order: the first one in stock (and under the caps) wins. */
function GpuRow({ fid, status }: { fid: (k: string) => string; status: RunPodStatus }) {
  const { settings } = status
  const gpus = useRunPodGpus({ enabled: status.apiKey })
  const save = useSaveRunPod()
  const [dc, setDc] = useState(settings.dataCenter ?? "")
  useEffect(() => setDc(settings.dataCenter ?? ""), [settings.dataCenter])
  const options = (gpus.data ?? []).filter((g) => !settings.gpuTypes.includes(g.id))
  const info = (id: string) => gpus.data?.find((g) => g.id === id)
  const setTypes = (gpuTypes: string[]) => save.mutate({ gpuTypes })
  return (
    <Row
      id={fid("runpod-gpus")}
      label="GPU types"
      help="Tried in this order when a pod starts; the first one in stock within the caps wins. Pods run on Secure Cloud. The datacenter is picked for the best stock of these, unless you name one (a project's volume pins its pods to the volume's datacenter)."
    >
      <ol className="space-y-1">
        {settings.gpuTypes.map((id, i) => {
          const g = info(id)
          return (
            <li key={id} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1 text-xs">
              <span className="flex-1 text-zinc-200">
                {id.replace(/^NVIDIA (GeForce )?/, "")}
                {g && (
                  <span className="ml-1 text-zinc-500">
                    {g.memoryGb} GB · {usd(g.securePrice)}/hr · {g.availability.toLowerCase()} stock
                  </span>
                )}
              </span>
              {i > 0 && (
                <button type="button" title="Try it earlier" className="text-zinc-500 hover:text-zinc-200" onClick={() => setTypes([id, ...settings.gpuTypes.filter((x) => x !== id)])}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
              {settings.gpuTypes.length > 1 && (
                <button type="button" title="Remove" className="text-zinc-500 hover:text-red-300" onClick={() => setTypes(settings.gpuTypes.filter((x) => x !== id))}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {status.apiKey && (
        <Select
          id={fid("runpod-gpus")}
          size="sm"
          className="w-full"
          value=""
          onChange={(e) => e.target.value && setTypes([...settings.gpuTypes, e.target.value])}
        >
          <option value="">{gpus.isLoading ? "Loading GPU types…" : "Add a GPU type…"}</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} · {g.memoryGb} GB · {usd(g.securePrice)}/hr · {g.availability.toLowerCase()}
            </option>
          ))}
        </Select>
      )}
      <input
        className={cx(inputClass, "font-mono text-xs")}
        placeholder="Datacenter: best stock (e.g. CA-MTL-1)"
        value={dc}
        onChange={(e) => setDc(e.target.value)}
        onBlur={() => dc.trim() !== (settings.dataCenter ?? "") && save.mutate({ dataCenter: dc.trim() || null })}
      />
    </Row>
  )
}

function NumbersRows({ fid, settings }: { fid: (k: string) => string; settings: RunPodSettings }) {
  const save = useSaveRunPod()
  const [draft, setDraft] = useState<Record<Numeric, string>>(() => numbersOf(settings))
  useEffect(() => setDraft(numbersOf(settings)), [settings])
  const commit = (k: Numeric) => {
    const v = Number(draft[k])
    if (draft[k].trim() === "" || !Number.isFinite(v) || v === settings[k]) return setDraft(numbersOf(settings))
    save.mutate({ [k]: v })
  }
  return (
    <>
      {NUMBERS.map((n) => (
        <Row key={n.key} id={fid(`runpod-${n.key}`)} label={n.label} help={n.help}>
          <div className="flex items-center gap-2">
            <input
              id={fid(`runpod-${n.key}`)}
              type="number"
              min={0}
              step={n.step ?? 1}
              className={cx(inputClass, "w-28")}
              value={draft[n.key]}
              onChange={(e) => setDraft({ ...draft, [n.key]: e.target.value })}
              onBlur={() => commit(n.key)}
              onKeyDown={(e) => e.key === "Enter" && commit(n.key)}
            />
            <span className="text-xs text-zinc-500">{n.unit}</span>
          </div>
        </Row>
      ))}
    </>
  )
}

const numbersOf = (s: RunPodSettings) => Object.fromEntries(NUMBERS.map((n) => [n.key, String(s[n.key])])) as Record<Numeric, string>

/** This Box Yard's pods at RunPod now, with Stop and Keep warm. */
function PodsRow({ status }: { status: RunPodStatus }) {
  const stop = useRunPodAction<string>("Couldn't stop the pod", (boxId) => api<RunPodStatus>(`/api/runpod/pods/${encodeURIComponent(boxId)}/stop`, { body: {} }))
  const warm = useRunPodAction<{ boxId: string; minutes: number | null }>("Couldn't keep the pod warm", ({ boxId, minutes }) =>
    api<RunPodStatus>(`/api/runpod/pods/${encodeURIComponent(boxId)}/keep-warm`, { body: { minutes } }),
  )
  const total = status.pods.reduce((sum, p) => sum + (p.costPerHr ?? 0), 0)
  return (
    <Row
      label="Pods"
      help={`Running now, at ${usd(total)}/hr together. A pod stops after ${status.settings.idleMinutes} idle minutes; Keep warm holds it up between follow-ups. Stopping archives every workspace first and never stops a running agent.`}
    >
      {!status.pods.length ? (
        <p className="text-xs text-zinc-500">No pods running.</p>
      ) : (
        <ul className="space-y-2">
          {status.pods.map((p) => (
            <li key={p.boxId} className="space-y-1 rounded-lg bg-zinc-900 px-2.5 py-2 text-xs" data-pod={p.podId}>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium text-zinc-200">{p.projectName ?? p.projectId}</span>
                <span className="text-zinc-400">{p.status.toLowerCase()}</span>
              </div>
              <p className="text-zinc-500">
                {p.gpu ?? "GPU"} · {p.dataCenter ?? "?"} · {usd(p.costPerHr)}/hr · {p.running} running
                {p.startedAt ? (
                  <>
                    {" "}
                    · up <TimeAgo ts={p.startedAt} />
                  </>
                ) : null}
              </p>
              {p.keepWarmUntil && (
                <p className="text-amber-300">
                  <Flame className="mr-1 inline h-3 w-3" />
                  Kept warm until {new Date(p.keepWarmUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {[60, 240].map((m) => (
                  <Button key={m} size="sm" variant="ghost" onClick={() => warm.mutate({ boxId: p.boxId, minutes: m })}>
                    <Flame className="h-3 w-3" /> {m / 60}h
                  </Button>
                ))}
                {p.keepWarmUntil && (
                  <Button size="sm" variant="ghost" onClick={() => warm.mutate({ boxId: p.boxId, minutes: null })}>
                    Don't keep warm
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={p.running > 0}
                  loading={stop.isPending && stop.variables === p.boxId}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: `Stop ${p.projectName ?? p.projectId}'s GPU pod?`,
                      body: "Its workspaces are archived first, and its network volume stays. The next task starts a new pod.",
                      confirmLabel: "Stop pod",
                      danger: true,
                    })
                    if (ok) stop.mutate(p.boxId)
                  }}
                >
                  <Power className="h-3 w-3" /> Stop
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Row>
  )
}

function VolumesRow({ status }: { status: RunPodStatus }) {
  const del = useRunPodAction<string>("Couldn't delete the volume", (id) => api<RunPodStatus>(`/api/runpod/volumes/${encodeURIComponent(id)}`, { method: "DELETE" }))
  return (
    <Row label="Network volumes" help="One per GPU project, kept when its pod stops (caches, /workspace/data). RunPod bills them by the month even with no pod running.">
      {!status.volumes.length ? (
        <p className="text-xs text-zinc-500">None yet.</p>
      ) : (
        <ul className="space-y-1">
          {status.volumes.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
              <span className="flex-1 text-zinc-300">
                {v.projectName ?? v.projectId ?? v.name}
                <span className="ml-1 text-zinc-500">
                  {v.sizeGb} GB · {v.dataCenter} · {usd(v.monthlyUsd)}/mo
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                title="Delete volume"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete the volume of ${v.projectName ?? v.name}?`,
                    body: "Its caches and /workspace/data go for good. Task workspaces are in Box Yard's archives, not here, so no work is lost.",
                    confirmLabel: "Delete volume",
                    danger: true,
                  })
                  if (ok) del.mutate(v.id)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Row>
  )
}
