// Settings › Daytona: the Daytona key, whether GPU projects run there by default, the images, the GPU types (or CPU
// only) and size of a sandbox, idle delete and spending caps, and the sandboxes this Box Yard has at Daytona right
// now. docs/daytona.md explains the runner. The settings here are a draft until the dialog's Save; Keep warm and
// Terminate are actions and run at once.
import { useState } from "react"
import { ArrowUp, Flame, Power, X } from "lucide-react"
import { api } from "../lib/api"
import { useDaytona, useDaytonaAction, useSetup } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { CREDENTIAL_INFO } from "../../../shared/setup"
import { RUNPOD_STOCK_IMAGE, type RunPodPodInfo } from "../../../shared/runpod"
import {
  DAYTONA_CPU,
  DAYTONA_GPU_GUIDE,
  daytonaGpuHint,
  daytonaGpuLabel,
  daytonaHourlyUsd,
  type DaytonaSandboxInfo,
  type DaytonaSettings,
  type DaytonaStatus,
} from "../../../shared/daytona"
import { BoxActionDialog } from "./BoxActionDialog"
import { CredentialField } from "./Setup"
import { Panel, Row } from "./SettingsDialog"
import { Button, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"

const linkClass = "text-yard-300 underline-offset-2 hover:underline"
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`)

type Numeric =
  | "gpus"
  | "vcpus"
  | "memoryGb"
  | "diskGb"
  | "cpuVcpus"
  | "cpuMemoryGb"
  | "cpuDiskGb"
  | "idleMinutes"
  | "agentsPerPod"
  | "maxHourlyUsd"
  | "totalMaxHourlyUsd"
  | "watchdogMinutes"
  | "startMinutes"
const NUMBERS: { key: Numeric; label: string; help: string; step?: number; unit: string }[] = [
  { key: "gpus", label: "GPUs per sandbox", unit: "GPUs", help: "How many GPUs each GPU sandbox gets. Each one is billed: two H100s cost twice one." },
  { key: "vcpus", label: "GPU sandbox vCPUs", unit: "vCPUs", help: "A GPU sandbox's vCPUs, billed on top of its GPUs. A project's own Min vCPUs replaces it." },
  { key: "memoryGb", label: "GPU sandbox memory", unit: "GB", help: "A GPU sandbox's memory, billed on top of its GPUs. A game's browser needs about 12 GB. A project's own Min RAM replaces it." },
  { key: "diskGb", label: "GPU sandbox disk", unit: "GB", help: "Where task folders live while it runs. CUDA images are big: leave room for the image and the repo. It goes with the sandbox." },
  { key: "cpuVcpus", label: "CPU sandbox vCPUs", unit: "vCPUs", help: "A CPU-only sandbox's vCPUs. Daytona's default per-sandbox limit is 4 until your organization raises it." },
  { key: "cpuMemoryGb", label: "CPU sandbox memory", unit: "GB", help: "A CPU-only sandbox's memory. Daytona's default per-sandbox limit is 8 GB." },
  { key: "cpuDiskGb", label: "CPU sandbox disk", unit: "GB", help: "A CPU-only sandbox's disk. Daytona's default per-sandbox limit is 10 GB." },
  { key: "idleMinutes", label: "Delete when idle", unit: "min", help: "A sandbox with no task running or waiting is deleted after this long (Daytona's GPU sandboxes can't be stopped and kept). The next task makes a new one." },
  { key: "agentsPerPod", label: "Tasks running at once per sandbox", unit: "tasks", help: "Tasks of one project that may run in its sandbox at once, unless the project sets its own Tasks running at once." },
  {
    key: "maxHourlyUsd",
    label: "Max per project",
    unit: "$/hr",
    step: 0.05,
    help: "The most one project's sandboxes may cost together, by Box Yard's estimate; a project can set its own (Project › Settings › Boxes). GPU types priced over what's left are skipped, and its next sandbox waits when none fits.",
  },
  {
    key: "totalMaxHourlyUsd",
    label: "Max for all sandboxes",
    unit: "$/hr",
    step: 0.05,
    help: "No new sandbox starts when it would take the spend of every Daytona sandbox of this Box Yard over this; its task waits and says so. Daytona sandboxes also count toward Settings › Usage › Daily cloud limit.",
  },
  {
    key: "watchdogMinutes",
    label: "Auto-stop",
    unit: "min",
    help: "Daytona stops (and so deletes) a sandbox this long after Box Yard was last in touch: if this computer sleeps or goes offline, sandboxes don't run up a bill on their own. Box Yard keeps idle ones in touch until Delete when idle.",
  },
  { key: "startMinutes", label: "Wait for a GPU", unit: "min", help: "How long a new sandbox may take to start: Daytona builds its image first, and queues it when no GPU of its types is free. Box Yard gives up after this long, deletes it, and the task says so." },
]

/** The settings as the form edits them: numbers as typed, "" for no image of its own. */
type DaytonaForm = Pick<DaytonaSettings, "defaultForGpu" | "gpuTypes" | "spot" | "cpuImage"> & { image: string } & Record<Numeric, string>

const numbersOf = (s: DaytonaSettings) => Object.fromEntries(NUMBERS.map((n) => [n.key, String(s[n.key])])) as Record<Numeric, string>
const formOf = (s: DaytonaSettings): DaytonaForm => ({ defaultForGpu: s.defaultForGpu, gpuTypes: s.gpuTypes, spot: s.spot, cpuImage: s.cpuImage, image: s.image ?? "", ...numbersOf(s) })

/** What Save sends: the fields that changed. A number that isn't one stops the save with a message. */
export function daytonaPatch(form: DaytonaForm, saved: DaytonaSettings): Partial<DaytonaSettings> {
  const patch: Partial<DaytonaSettings> = {}
  if (form.defaultForGpu !== saved.defaultForGpu) patch.defaultForGpu = form.defaultForGpu
  if (form.spot !== saved.spot) patch.spot = form.spot
  if (form.image.trim() !== (saved.image ?? "")) patch.image = form.image.trim() || null
  if (form.cpuImage.trim() !== saved.cpuImage) patch.cpuImage = form.cpuImage.trim()
  if (JSON.stringify(form.gpuTypes) !== JSON.stringify(saved.gpuTypes)) patch.gpuTypes = form.gpuTypes
  for (const n of NUMBERS) {
    const v = Number(form[n.key])
    if (form[n.key].trim() === "" || !Number.isFinite(v)) throw new Error(`Daytona › ${n.label} needs a number.`)
    if (v !== saved[n.key]) patch[n.key] = v
  }
  return patch
}

/** "About $1.68/hr per sandbox at most" for the shape the form describes, or null while a number is half typed. */
function estimate(form: DaytonaForm): string | null {
  const n = (k: Numeric) => Number(form[k])
  const cpu = form.gpuTypes.includes(DAYTONA_CPU)
  const shape = cpu
    ? { gpuTypes: [], gpus: 0, vcpus: n("cpuVcpus"), memoryGb: n("cpuMemoryGb"), diskGb: n("cpuDiskGb"), spot: false }
    : { gpuTypes: form.gpuTypes, gpus: n("gpus"), vcpus: n("vcpus"), memoryGb: n("memoryGb"), diskGb: n("diskGb"), spot: form.spot }
  if (![shape.gpus, shape.vcpus, shape.memoryGb, shape.diskGb].every(Number.isFinite)) return null
  return `About ${usd(daytonaHourlyUsd(shape))}/hr per sandbox at most${cpu || form.gpuTypes.length < 2 ? "" : " (its dearest GPU type)"}, by Daytona's list prices.`
}

export function DaytonaPanel({ fid, active = true }: { fid: (k: string) => string; active?: boolean }) {
  const setup = useSetup()
  const key = setup.data?.credentials.daytonaApiKey
  const status = useDaytona({ poll: active })
  const s = status.data
  const save = useDaytonaAction<Partial<DaytonaSettings>>("Couldn't save the Daytona settings", (patch) => api<DaytonaStatus>("/api/daytona/settings", { method: "PUT", body: patch }))
  const [form, setForm] = useDraft("daytona", "daytona", s ? formOf(s.settings) : null, async (f) => {
    if (f && s) await save.mutateAsync(daytonaPatch(f, s.settings))
  })
  const set = (patch: Partial<DaytonaForm>) => setForm((f) => f && { ...f, ...patch })
  const cpuOnly = Boolean(form?.gpuTypes.includes(DAYTONA_CPU))
  const price = form && estimate(form)
  return (
    <Panel section="daytona">
      <Row
        id={fid("daytona-key")}
        label={CREDENTIAL_INFO.daytonaApiKey.label}
        help={
          <>
            Lets GPU projects run on Daytona: each gets a sandbox of its own, with a GPU or CPU only, when a task needs it and loses it when idle.{" "}
            <NewTabLink href={CREDENTIAL_INFO.daytonaApiKey.link.href} className={linkClass}>
              {CREDENTIAL_INFO.daytonaApiKey.link.label}
            </NewTabLink>{" "}
            (a key with sandbox permissions only is enough). Kept on this server, never sent back. Env var: <code className="font-mono">DAYTONA_API_KEY</code>.
          </>
        }
      >
        {key ? <CredentialField k="daytonaApiKey" status={key} id={fid("daytona-key")} section="daytona" /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Row>
      {!s || !form ? (
        <p className="text-sm text-zinc-500">{status.error ? `Couldn't load: ${status.error.message}` : "Loading…"}</p>
      ) : (
        <>
          {s.error && <p className="mb-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">Daytona: {s.error}</p>}
          <Row
            id={fid("daytona-default")}
            label="Use for GPU projects"
            help="GPU projects that don't pick a cloud of their own (Project › Settings › Boxes › GPU cloud) run in Daytona sandboxes instead of RunPod pods or Vast.ai instances (this wins over Vast.ai's). Their tasks move once their workspace is archived; running ones finish first."
          >
            <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
              <input id={fid("daytona-default")} type="checkbox" checked={form.defaultForGpu} onChange={(e) => set({ defaultForGpu: e.target.checked })} data-testid="daytona-default" />
              {form.defaultForGpu ? "On: GPU projects run on Daytona unless they pick another cloud" : "Off: GPU projects run on Daytona only when they pick it"}
            </label>
          </Row>
          <Row
            id={fid("daytona-gpus")}
            label="GPU types"
            help="Daytona gives a sandbox any free GPU of these types, so its price is counted at the dearest. CPU only makes plain Linux sandboxes with no GPU, at Daytona's CPU and memory rates. A project can pick its own (Project › Settings › Boxes)."
          >
            <DaytonaGpuPicker id={fid("daytona-gpus")} value={form.gpuTypes} onChange={(gpuTypes) => set({ gpuTypes })} />
            {price && <p className="mt-1.5 text-xs text-zinc-500">{price}</p>}
          </Row>
          {!cpuOnly && (
            <Row
              id={fid("daytona-spot")}
              label="Spot GPUs"
              help="Cheaper GPUs (Daytona's Tier 2 and up) that Daytona may take back at any moment, with the sandbox and its work. The workspace comes back from Box Yard's last archive."
            >
              <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                <input id={fid("daytona-spot")} type="checkbox" checked={form.spot} onChange={(e) => set({ spot: e.target.checked })} />
                {form.spot ? "On: spot GPUs" : "Off: on-demand GPUs"}
              </label>
            </Row>
          )}
          <Row
            id={fid("daytona-image")}
            label="GPU sandbox image"
            help="The image GPU sandboxes are built from. Empty: the one Settings › RunPod GPU built, else RunPod's stock CUDA image. Box Yard adds its agent tools on top when Daytona builds the sandbox (or installs them on start when that build fails)."
          >
            <input
              id={fid("daytona-image")}
              className={cx(inputClass, "font-mono text-xs")}
              placeholder={s.settings.image ? "" : s.image || RUNPOD_STOCK_IMAGE}
              value={form.image}
              spellCheck={false}
              onChange={(e) => set({ image: e.target.value })}
            />
          </Row>
          <Row id={fid("daytona-cpu-image")} label="CPU sandbox image" help="The image CPU-only sandboxes are built from. Keep it small: the default CPU sandbox disk is 10 GB.">
            <input id={fid("daytona-cpu-image")} className={cx(inputClass, "font-mono text-xs")} value={form.cpuImage} spellCheck={false} onChange={(e) => set({ cpuImage: e.target.value })} />
          </Row>
          {NUMBERS.filter((n) => !(cpuOnly && ["gpus", "vcpus", "memoryGb", "diskGb"].includes(n.key))).map((n) => (
            <Row key={n.key} id={fid(`daytona-${n.key}`)} label={n.label} help={n.help}>
              <div className="flex items-center gap-2">
                <input
                  id={fid(`daytona-${n.key}`)}
                  type="number"
                  min={0}
                  step={n.step ?? 1}
                  className={cx(inputClass, "w-28")}
                  value={form[n.key]}
                  onChange={(e) => set({ [n.key]: e.target.value })}
                />
                <span className="text-xs text-zinc-500">{n.unit}</span>
              </div>
            </Row>
          ))}
          <SandboxesRow status={s} />
        </>
      )}
    </Panel>
  )
}

/**
 * The ordered list of Daytona GPU types, or CPU only, with each one's list price. Settings › Daytona edits the global
 * list; Project › Settings › Boxes a project's own. CPU only stands alone: picking it replaces the GPU types, and
 * picking a GPU type replaces it.
 */
export function DaytonaGpuPicker({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const cpu = value.includes(DAYTONA_CPU)
  const options = [DAYTONA_CPU, ...Object.keys(DAYTONA_GPU_GUIDE)].filter((t) => !value.includes(t))
  const add = (t: string) => onChange(t === DAYTONA_CPU || cpu ? [t] : [...value, t])
  return (
    <div className="w-full min-w-0 space-y-1.5">
      <ol className="space-y-1" data-testid={`${id}-list`}>
        {value.map((t, i) => (
          <li key={t} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1 text-xs">
            <span className="flex-1 text-zinc-200">
              {daytonaGpuLabel(t)}
              <span className="ml-1 text-zinc-500">{daytonaGpuHint(t) ?? ""}</span>
            </span>
            {i > 0 && (
              <button type="button" title="Prefer it" className="text-zinc-500 hover:text-zinc-200" onClick={() => onChange([t, ...value.filter((x) => x !== t)])}>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
            {value.length > 1 && (
              <button type="button" title="Remove" className="text-zinc-500 hover:text-red-300" onClick={() => onChange(value.filter((x) => x !== t))}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ol>
      <Select id={id} size="sm" className="w-full" value="" onChange={(e) => e.target.value && add(e.target.value)} data-testid={id}>
        <option value="">{cpu ? "Use a GPU instead…" : "Add a GPU type…"}</option>
        {options.map((t) => (
          <option key={t} value={t}>
            {t === DAYTONA_CPU ? "CPU only (no GPU)" : `${daytonaGpuLabel(t)} · ${daytonaGpuHint(t)}`}
          </option>
        ))}
      </Select>
    </div>
  )
}

/** A Daytona sandbox in the shape the Terminate dialog reads. */
const asPod = (x: DaytonaSandboxInfo): RunPodPodInfo => ({
  boxId: x.boxId,
  index: x.index,
  projectId: x.projectId,
  projectName: x.projectName,
  podId: x.sandboxId,
  status: x.status,
  gpu: x.gpu,
  dataCenter: null,
  costPerHr: x.costPerHr,
  startedAt: x.startedAt,
  keepWarmUntil: x.keepWarmUntil,
  running: x.running,
})

/** This Box Yard's sandboxes at Daytona now, with Terminate and Keep warm. */
function SandboxesRow({ status }: { status: DaytonaStatus }) {
  const [terminating, setTerminating] = useState<DaytonaSandboxInfo | null>(null)
  const warm = useDaytonaAction<{ boxId: string; minutes: number | null }>("Couldn't keep the sandbox warm", ({ boxId, minutes }) =>
    api<DaytonaStatus>(`/api/daytona/sandboxes/${encodeURIComponent(boxId)}/keep-warm`, { body: { minutes } }),
  )
  const total = status.sandboxes.reduce((sum, p) => sum + (p.costPerHr ?? 0), 0)
  return (
    <Row
      label="Sandboxes"
      help={`Running now, at about ${usd(total)}/hr together (Box Yard's estimate; Daytona's billing page has the real figure). A project gets up to its Max boxes sandboxes, within the caps. Each is deleted after ${status.settings.idleMinutes} idle minutes; Keep warm holds it up between follow-ups. Terminate runs the delete safety check and archives every workspace first; it asks before stopping a running agent.`}
    >
      {!status.sandboxes.length ? (
        <p className="text-xs text-zinc-500">No sandboxes running.</p>
      ) : (
        <ul className="space-y-2">
          {status.sandboxes.map((p) => (
            <li key={p.boxId} className="space-y-1 rounded-lg bg-zinc-900 px-2.5 py-2 text-xs" data-sandbox={p.sandboxId}>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium text-zinc-200">
                  {p.projectName ?? p.projectId} <span className="font-normal text-zinc-500">· sandbox #{p.index}</span>
                </span>
                <span className="text-zinc-400">{p.state}</span>
              </div>
              <p className="text-zinc-500">
                {p.gpu ?? "GPU"}
                {p.vcpus ? ` · ${p.vcpus} vCPUs` : ""}
                {p.memoryGb ? ` · ${p.memoryGb} GB` : ""} · {usd(p.costPerHr)}/hr · {p.running} running
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
                <Button size="sm" variant="danger" onClick={() => setTerminating(p)}>
                  <Power className="h-3 w-3" /> Terminate…
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {terminating && <BoxActionDialog pod={asPod(terminating)} action="delete" onClose={() => setTerminating(null)} />}
    </Row>
  )
}
