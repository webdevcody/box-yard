// Settings › RunPod GPU: the RunPod key, the pod image (built with this computer's Docker and pushed to the owner's
// own registry, or RunPod's stock image), which GPUs to try, idle stop and spending caps, and the pods and network
// volumes this Box Yard has at RunPod right now. docs/runpod.md explains the runner.
import { useEffect, useState } from "react"
import { Flame, Hammer, Power, Trash2 } from "lucide-react"
import { api } from "../lib/api"
import { confirmDialog } from "../lib/confirm"
import { useRunPod, useRunPodAction, useSetup } from "../lib/queries"
import { CREDENTIAL_INFO } from "../../../shared/setup"
import { RUNPOD_CLOUDS, RUNPOD_STOCK_IMAGE, type RunPodCloud, type RunPodImageBuild, type RunPodSettings, type RunPodStatus } from "../../../shared/runpod"
import { GpuTypePicker } from "./GpuTypePicker"
import { CredentialField } from "./Setup"
import { Panel, Row } from "./SettingsDialog"
import { Button, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"

const linkClass = "text-yard-300 underline-offset-2 hover:underline"
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`)

/** The cloud picker's options and help, here and in Project › Settings › Boxes. */
export const CLOUD_OPTION: Record<RunPodCloud, string> = {
  SECURE: "Secure Cloud: RunPod's datacenters, network volume",
  COMMUNITY: "Community Cloud: cheaper, more GPU types, no volume",
}
export const CLOUD_HELP =
  "Where new pods run. Secure Cloud is RunPod's own datacenters, the only place a project's network volume works. Community Cloud is hosts other people run: cheaper, with GPUs Secure lacks (an RTX 3070), but no network volume, so every pod's caches start cold. The caps use each GPU's price on this cloud. Running pods keep theirs."

type Numeric = "minRamGb" | "minVcpus" | "idleMinutes" | "agentsPerPod" | "containerDiskGb" | "volumeGb" | "maxHourlyUsd" | "totalMaxHourlyUsd" | "watchdogMinutes"
const NUMBERS: { key: Numeric; label: string; help: string; step?: number; unit: string }[] = [
  {
    key: "minRamGb",
    label: "Min RAM",
    unit: "GB",
    help: "RunPod only places a new pod on a host with at least this much RAM. Cheap Community hosts can come with little; a game's browser needs about 12 GB. A project can set its own.",
  },
  { key: "minVcpus", label: "Min vCPUs", unit: "vCPUs", help: "…and at least this many vCPUs. Fewer hosts qualify the higher these are, so a pod may wait longer for one." },
  { key: "idleMinutes", label: "Stop when idle", unit: "min", help: "A pod with no agent running or waiting is stopped after this long. Its network volume stays; the next task starts a new pod." },
  { key: "agentsPerPod", label: "Agents per pod", unit: "agents", help: "Agents of one project that may run on its pod at once, unless the project sets its own Agents per box." },
  {
    key: "maxHourlyUsd",
    label: "Max per project",
    unit: "$/hr",
    step: 0.05,
    help: "The most one project's pods may cost together; a project can set its own (Project › Settings › Boxes). Its next pod waits when it would go over, and GPU types priced above this are skipped.",
  },
  { key: "totalMaxHourlyUsd", label: "Max for all pods", unit: "$/hr", step: 0.05, help: "No new pod starts when it would take the GPU spend of every running pod over this; its task waits and says so." },
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

/** GPU types to try, in order (the first one in stock and under the caps wins), and the cloud they run on. */
function GpuRow({ fid, status }: { fid: (k: string) => string; status: RunPodStatus }) {
  const { settings } = status
  const save = useSaveRunPod()
  const [dc, setDc] = useState(settings.dataCenter ?? "")
  useEffect(() => setDc(settings.dataCenter ?? ""), [settings.dataCenter])
  return (
    <>
      <Row
        id={fid("runpod-gpus")}
        label="GPU types"
        help="Tried in this order when a pod starts; the first one in stock within the caps wins. A project can pick its own (Project › Settings › Boxes). For browser and WebGL game testing an RTX A4000, RTX 4000 Ada or (Community) RTX 3070 is plenty. The datacenter is picked for the best stock of these, unless you name one (a project's volume pins its pod #1 to the volume's datacenter)."
      >
        <GpuTypePicker id={fid("runpod-gpus")} value={settings.gpuTypes} onChange={(gpuTypes) => save.mutate({ gpuTypes })} cloud={settings.cloud} enabled={status.apiKey} />
        <input
          className={cx(inputClass, "font-mono text-xs")}
          placeholder="Datacenter: best stock (e.g. CA-MTL-1)"
          value={dc}
          onChange={(e) => setDc(e.target.value)}
          onBlur={() => dc.trim() !== (settings.dataCenter ?? "") && save.mutate({ dataCenter: dc.trim() || null })}
        />
      </Row>
      <Row id={fid("runpod-cloud")} label="Cloud" help={CLOUD_HELP}>
        <Select id={fid("runpod-cloud")} className="w-full sm:w-80" value={settings.cloud} onChange={(e) => save.mutate({ cloud: e.target.value as RunPodCloud })}>
          {RUNPOD_CLOUDS.map((c) => (
            <option key={c} value={c}>
              {CLOUD_OPTION[c]}
            </option>
          ))}
        </Select>
      </Row>
    </>
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
      help={`Running now, at ${usd(total)}/hr together. A project gets up to its Max boxes pods, within the caps; only its pod #1 mounts its network volume. Each pod stops after ${status.settings.idleMinutes} idle minutes; Keep warm holds it up between follow-ups. Stopping archives every workspace first and never stops a running agent.`}
    >
      {!status.pods.length ? (
        <p className="text-xs text-zinc-500">No pods running.</p>
      ) : (
        <ul className="space-y-2">
          {status.pods.map((p) => (
            <li key={p.boxId} className="space-y-1 rounded-lg bg-zinc-900 px-2.5 py-2 text-xs" data-pod={p.podId}>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium text-zinc-200">
                  {p.projectName ?? p.projectId} <span className="font-normal text-zinc-500">· pod #{p.index}</span>
                </span>
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
                      title: `Stop ${p.projectName ?? p.projectId}'s GPU pod #${p.index}?`,
                      body: `Its workspaces are archived first${p.index === 1 ? ", and the project's network volume stays" : ""}. The next task that needs it starts a new pod.`,
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
