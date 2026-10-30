// Settings › Vast.ai GPU: the Vast.ai key, whether GPU projects run there by default, the image, which GPUs to rent
// and the host filters, idle stop and spending caps, and the instances this Box Yard has at Vast.ai right now.
// docs/vast.md explains the runner. The settings here are a draft until the dialog's Save; Keep warm and Terminate
// are actions and run at once.
import { useState } from "react"
import { ArrowUp, Flame, Power, X } from "lucide-react"
import { api } from "../lib/api"
import { useSetup, useVast, useVastAction, useVastGpus } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { CREDENTIAL_INFO } from "../../../shared/setup"
import { RUNPOD_STOCK_IMAGE, type RunPodPodInfo } from "../../../shared/runpod"
import { vastGpuHint, type VastGpuOption, type VastInstanceInfo, type VastSettings, type VastStatus } from "../../../shared/vast"
import { BoxActionDialog } from "./BoxActionDialog"
import { CredentialField } from "./Setup"
import { Panel, Row } from "./SettingsDialog"
import { Button, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"

const linkClass = "text-yard-300 underline-offset-2 hover:underline"
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`)

type Numeric = "minRamGb" | "minVcpus" | "minReliability" | "minInetDownMbps" | "idleMinutes" | "agentsPerPod" | "maxHourlyUsd" | "totalMaxHourlyUsd" | "containerDiskGb" | "watchdogMinutes"
const NUMBERS: { key: Numeric; label: string; help: string; step?: number; unit: string }[] = [
  { key: "minRamGb", label: "Min RAM", unit: "GB", help: "Only rent hosts with at least this much RAM. A game's browser needs about 12 GB. A project can set its own." },
  { key: "minVcpus", label: "Min vCPUs", unit: "vCPUs", help: "…and at least this many vCPUs (Vast's effective cores for one GPU). Fewer offers qualify the higher these are." },
  {
    key: "minReliability",
    label: "Min reliability",
    unit: "0–1",
    step: 0.01,
    help: "Vast's score for how often a host stays up. Hosts are other people's machines: below about 0.95 an instance is more likely to vanish mid-task (its workspace comes back from the archive).",
  },
  { key: "minInetDownMbps", label: "Min download", unit: "Mb/s", help: "Only hosts that download at least this fast: the image, the agent tools and the repo come down when an instance starts." },
  { key: "idleMinutes", label: "Stop when idle", unit: "min", help: "An instance with no task running or waiting is destroyed after this long (a stopped Vast instance still bills its disk and may never get its GPU back). The next task rents a new one." },
  { key: "agentsPerPod", label: "Tasks running at once per instance", unit: "tasks", help: "Tasks of one project that may run on its instance at once, unless the project sets its own Tasks running at once." },
  {
    key: "maxHourlyUsd",
    label: "Max per project",
    unit: "$/hr",
    step: 0.05,
    help: "The most one project's instances may cost together; a project can set its own (Project › Settings › Boxes). Offers priced over what's left are skipped, and its next instance waits when none fits.",
  },
  {
    key: "totalMaxHourlyUsd",
    label: "Max for all instances",
    unit: "$/hr",
    step: 0.05,
    help: "No new instance starts when it would take the spend of every Vast.ai instance of this Box Yard over this; its task waits and says so. Vast.ai has no spending cap of its own: this and your prepaid credit are the limits.",
  },
  { key: "containerDiskGb", label: "Instance disk", unit: "GB", help: "Fixed when the instance is rented, where task folders live while it runs. It bills while the instance exists and goes with it." },
  { key: "watchdogMinutes", label: "Watchdog", unit: "min", help: "Each instance destroys itself when this Box Yard hasn't been in touch for this long (this computer slept or went offline), so it never runs up a bill on its own." },
]

/** The settings as the form edits them: numbers as typed, "" for no image of its own. */
type VastForm = Pick<VastSettings, "defaultForGpu" | "gpuTypes" | "verifiedOnly"> & { image: string } & Record<Numeric, string>

const numbersOf = (s: VastSettings) => Object.fromEntries(NUMBERS.map((n) => [n.key, String(s[n.key])])) as Record<Numeric, string>
const formOf = (s: VastSettings): VastForm => ({ defaultForGpu: s.defaultForGpu, gpuTypes: s.gpuTypes, verifiedOnly: s.verifiedOnly, image: s.image ?? "", ...numbersOf(s) })

/** What Save sends: the fields that changed. A number that isn't one stops the save with a message. */
export function vastPatch(form: VastForm, saved: VastSettings): Partial<VastSettings> {
  const patch: Partial<VastSettings> = {}
  if (form.defaultForGpu !== saved.defaultForGpu) patch.defaultForGpu = form.defaultForGpu
  if (form.verifiedOnly !== saved.verifiedOnly) patch.verifiedOnly = form.verifiedOnly
  if (form.image.trim() !== (saved.image ?? "")) patch.image = form.image.trim() || null
  if (JSON.stringify(form.gpuTypes) !== JSON.stringify(saved.gpuTypes)) patch.gpuTypes = form.gpuTypes
  for (const n of NUMBERS) {
    const v = Number(form[n.key])
    if (form[n.key].trim() === "" || !Number.isFinite(v)) throw new Error(`Vast.ai GPU › ${n.label} needs a number.`)
    if (v !== saved[n.key]) patch[n.key] = v
  }
  return patch
}

export function VastPanel({ fid, active = true }: { fid: (k: string) => string; active?: boolean }) {
  const setup = useSetup()
  const key = setup.data?.credentials.vastApiKey
  const status = useVast({ poll: active })
  const s = status.data
  const save = useVastAction<Partial<VastSettings>>("Couldn't save the Vast.ai settings", (patch) => api<VastStatus>("/api/vast/settings", { method: "PUT", body: patch }))
  const [form, setForm] = useDraft("vast", "vast", s ? formOf(s.settings) : null, async (f) => {
    if (f && s) await save.mutateAsync(vastPatch(f, s.settings))
  })
  const set = (patch: Partial<VastForm>) => setForm((f) => f && { ...f, ...patch })
  return (
    <Panel section="vast">
      <Row
        id={fid("vast-key")}
        label={CREDENTIAL_INFO.vastApiKey.label}
        help={
          <>
            Lets GPU projects run on Vast.ai: each rents an instance of its own from Vast's marketplace when a task needs it and destroys it when idle.{" "}
            <NewTabLink href={CREDENTIAL_INFO.vastApiKey.link.href} className={linkClass}>
              {CREDENTIAL_INFO.vastApiKey.link.label}
            </NewTabLink>{" "}
            (a key that can rent and destroy instances). Kept on this server, never sent back. Env var: <code className="font-mono">VAST_API_KEY</code>.
          </>
        }
      >
        {key ? <CredentialField k="vastApiKey" status={key} id={fid("vast-key")} section="vast" /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Row>
      {!s || !form ? (
        <p className="text-sm text-zinc-500">{status.error ? `Couldn't load: ${status.error.message}` : "Loading…"}</p>
      ) : (
        <>
          {s.error && <p className="mb-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">Vast.ai: {s.error}</p>}
          <Row
            id={fid("vast-default")}
            label="Use for GPU projects"
            help="GPU projects that don't pick a cloud of their own (Project › Settings › Boxes › GPU cloud) rent Vast.ai instances instead of RunPod pods. Their tasks move once their workspace is archived; running ones finish first."
          >
            <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
              <input id={fid("vast-default")} type="checkbox" checked={form.defaultForGpu} onChange={(e) => set({ defaultForGpu: e.target.checked })} data-testid="vast-default" />
              {form.defaultForGpu ? "On: GPU projects run on Vast.ai unless they pick RunPod" : "Off: GPU projects run on RunPod unless they pick Vast.ai"}
            </label>
          </Row>
          <Row
            id={fid("vast-image")}
            label="Instance image"
            help="The Docker image instances start from. Empty: the one Settings › RunPod GPU built (it has the agent tools baked in), else RunPod's stock PyTorch image, which installs them in about a minute each start. It must be public so Vast's hosts can pull it."
          >
            <input
              id={fid("vast-image")}
              className={cx(inputClass, "font-mono text-xs")}
              placeholder={s.settings.image ? "" : s.image || RUNPOD_STOCK_IMAGE}
              value={form.image}
              spellCheck={false}
              onChange={(e) => set({ image: e.target.value })}
            />
          </Row>
          <Row
            id={fid("vast-gpus")}
            label="GPU types"
            help="Rented in this order: the cheapest matching offer of the first type that has one within the caps wins. A project can pick its own (Project › Settings › Boxes). For browser and WebGL game testing an RTX 3070 or A4000 is plenty."
          >
            <VastGpuPicker id={fid("vast-gpus")} value={form.gpuTypes} onChange={(gpuTypes) => set({ gpuTypes })} enabled={s.apiKey} />
          </Row>
          <Row id={fid("vast-verified")} label="Verified hosts only" help="Only rent from hosts Vast.ai has verified. Unverified ones are cheaper and more plentiful but less tested.">
            <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
              <input id={fid("vast-verified")} type="checkbox" checked={form.verifiedOnly} onChange={(e) => set({ verifiedOnly: e.target.checked })} />
              {form.verifiedOnly ? "On: verified hosts only" : "Off: any host"}
            </label>
          </Row>
          {NUMBERS.map((n) => (
            <Row key={n.key} id={fid(`vast-${n.key}`)} label={n.label} help={n.help}>
              <div className="flex items-center gap-2">
                <input
                  id={fid(`vast-${n.key}`)}
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
          <InstancesRow status={s} />
        </>
      )}
    </Panel>
  )
}

/** "24 GB · from $0.18/hr · 12 offers · games and mid-size models". */
export function vastOptionLine(g: VastGpuOption) {
  const where = g.offers ? `from ${usd(g.cheapestUsd)}/hr · ${g.offers === 1 ? "1 offer" : `${g.offers} offers`}` : "no offers right now"
  return [g.memoryGb ? `${g.memoryGb} GB` : null, where, g.use].filter(Boolean).join(" · ")
}

/** The ordered list of Vast.ai GPU types to rent, with each one's live offers. Settings › Vast.ai GPU edits the global list; Project › Settings › Boxes a project's own. */
export function VastGpuPicker({ id, value, onChange, enabled }: { id: string; value: string[]; onChange: (v: string[]) => void; enabled: boolean }) {
  const gpus = useVastGpus({ enabled })
  const info = (name: string) => gpus.data?.find((g) => g.name === name)
  const options = (gpus.data ?? []).filter((g) => !value.includes(g.name))
  return (
    <div className="w-full min-w-0 space-y-1.5">
      <ol className="space-y-1" data-testid={`${id}-list`}>
        {value.map((name, i) => {
          const g = info(name)
          return (
            <li key={name} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1 text-xs">
              <span className="flex-1 text-zinc-200">
                {name}
                <span className={g && !g.offers ? "ml-1 text-amber-300" : "ml-1 text-zinc-500"}>{g ? vastOptionLine(g) : (vastGpuHint(name) ?? "")}</span>
              </span>
              {i > 0 && (
                <button type="button" title="Try it earlier" className="text-zinc-500 hover:text-zinc-200" onClick={() => onChange([name, ...value.filter((x) => x !== name)])}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
              {value.length > 1 && (
                <button type="button" title="Remove" className="text-zinc-500 hover:text-red-300" onClick={() => onChange(value.filter((x) => x !== name))}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {enabled && (
        <Select id={id} size="sm" className="w-full" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} data-testid={id}>
          <option value="">{gpus.isLoading ? "Loading Vast.ai's offers…" : gpus.error ? "Couldn't load Vast.ai's offers" : "Add a GPU type…"}</option>
          {options.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} · {vastOptionLine(g)}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}

/** A Vast instance in the shape the Terminate dialog reads. */
const asPod = (i: VastInstanceInfo): RunPodPodInfo => ({
  boxId: i.boxId,
  index: i.index,
  projectId: i.projectId,
  projectName: i.projectName,
  podId: i.instanceId,
  status: i.status,
  gpu: i.gpu,
  dataCenter: i.location,
  costPerHr: i.costPerHr,
  startedAt: i.startedAt,
  keepWarmUntil: i.keepWarmUntil,
  running: i.running,
})

/** This Box Yard's instances at Vast.ai now, with Terminate and Keep warm, and the account's credit. */
function InstancesRow({ status }: { status: VastStatus }) {
  const [terminating, setTerminating] = useState<VastInstanceInfo | null>(null)
  const warm = useVastAction<{ boxId: string; minutes: number | null }>("Couldn't keep the instance warm", ({ boxId, minutes }) =>
    api<VastStatus>(`/api/vast/instances/${encodeURIComponent(boxId)}/keep-warm`, { body: { minutes } }),
  )
  const total = status.instances.reduce((sum, p) => sum + (p.costPerHr ?? 0), 0)
  return (
    <Row
      label="Instances"
      help={`Running now, at ${usd(total)}/hr together${status.balanceUsd !== null ? `, with ${usd(status.balanceUsd)} of credit left at Vast.ai` : ""}. A project gets up to its Max boxes instances, within the caps. Each is destroyed after ${status.settings.idleMinutes} idle minutes; Keep warm holds it up between follow-ups. Terminate runs the delete safety check and archives every workspace first; it asks before stopping a running agent.`}
    >
      {!status.instances.length ? (
        <p className="text-xs text-zinc-500">No instances running.</p>
      ) : (
        <ul className="space-y-2">
          {status.instances.map((p) => (
            <li key={p.boxId} className="space-y-1 rounded-lg bg-zinc-900 px-2.5 py-2 text-xs" data-instance={p.instanceId}>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium text-zinc-200">
                  {p.projectName ?? p.projectId} <span className="font-normal text-zinc-500">· instance #{p.index}</span>
                </span>
                <span className="text-zinc-400">{p.status.toLowerCase()}</span>
              </div>
              <p className="text-zinc-500">
                {p.gpu ?? "GPU"} · {p.location ?? "?"} · {usd(p.costPerHr)}/hr · {p.running} running
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
