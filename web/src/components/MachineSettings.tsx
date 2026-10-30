// Settings › Machines: Cody's SSH machines (docs/machines.md). Add, Edit, Test and Remove act at once; "Local means"
// is a draft until the dialog's Save. The Boxes page shows the same machines with the tasks on them (MachineCard).
import { useState, type ReactNode } from "react"
import { CheckCircle2, CircleDashed, Pencil, Plus, RefreshCw, Trash2, XCircle } from "lucide-react"
import { ApiError } from "../lib/api"
import { confirmDialog } from "../lib/confirm"
import { machineApi, useMachineAction, useMachines } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { toast } from "../lib/toast"
import { EMPTY_MACHINE, MACHINE_STATE, draftOf, hardwareLine, machineAddress, machineInput, machinePatch, toolList, type MachineDraft } from "../lib/machines"
import { KEY_REF_HELP, MACHINE_LIMITS, machineMatches, type MachineStatus, type MachinesStatus } from "../../../shared/machines"
import { Modal } from "./Modal"
import { Panel, Row } from "./SettingsDialog"
import { Button, LineIcon, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"

const GUIDE = "https://github.com/webdevcody/box-yard/blob/main/docs/machines.md"

export function MachinesPanel({ fid }: { fid: (k: string) => string }) {
  const q = useMachines()
  const s = q.data
  const [editing, setEditing] = useState<MachineStatus | "new" | null>(null)
  return (
    <Panel section="machines">
      {!s ? (
        <p className="text-sm text-zinc-500">{q.error ? `Couldn't load: ${q.error.message}` : "Loading…"}</p>
      ) : (
        <>
          <div className="@container pb-4" data-testid="machines-list">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-64">
                <h4 className="text-sm font-medium text-zinc-200">Your machines</h4>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Each needs SSH from this computer with a key, node 18+, git and Claude Code, and a claude login there (or a Claude key Box Yard forwards). The <NewTabLink href={GUIDE}>setup guide</NewTabLink> walks
                  through an old laptop. Box Yard keeps only a reference to the key, never the key.
                </p>
              </div>
              <Button size="sm" variant="primary" onClick={() => setEditing("new")} data-testid="machine-add">
                <Plus className="h-3.5 w-3.5" /> Add machine
              </Button>
            </div>
            {s.machines.length === 0 ? (
              <p className="mt-3 text-xs text-zinc-500">None yet.</p>
            ) : (
              <ul className="mt-3 grid gap-2 @2xl:grid-cols-2">
                {s.machines.map((m) => (
                  <MachineCard key={m.id} machine={m} onEdit={() => setEditing(m)} />
                ))}
              </ul>
            )}
          </div>
          <LocalMeansRow fid={fid} status={s} />
        </>
      )}
      {editing && <MachineDialog key={editing === "new" ? "new" : editing.id} machine={editing === "new" ? null : editing} fid={fid} onClose={() => setEditing(null)} />}
    </Panel>
  )
}

/** What runs_on "local" means for the Coordinator: this computer, or the SSH machines with a label. */
function LocalMeansRow({ fid, status }: { fid: (k: string) => string; status: MachinesStatus }) {
  const save = useMachineAction<string | null>("Couldn't save the Machines settings", (localLabel) => machineApi.saveSettings({ localLabel }))
  const saved = status.settings.localLabel ?? ""
  const [value, setValue] = useDraft("machines-local", "machines", saved, async (v) => {
    await save.mutateAsync(v || null)
  })
  const labels = status.labels.map((l) => l.label)
  return (
    <Row
      id={fid("machines-local")}
      label='When you say "locally"'
      help={
        <>
          Where the Coordinator sends a task when you ask for it to run locally, "on my machine" or "on this computer" (runs_on "local"). This computer is the one running Box Yard; a label sends those tasks to a free SSH
          machine with it instead. The Runs on picker's This computer always means this computer.
        </>
      }
    >
      <Select id={fid("machines-local")} className="w-full" value={value} onChange={(e) => setValue(e.target.value)} data-testid="machines-local">
        <option value="">This computer</option>
        {[...new Set([...labels, ...(saved ? [saved] : [])])].map((l) => (
          <option key={l} value={l}>
            SSH machines labelled {l}
          </option>
        ))}
      </Select>
      {!labels.length && <p className="text-xs text-zinc-500">Label a machine to offer it here.</p>}
    </Row>
  )
}

/** One machine: its state, address, labels, last test and tasks running at once, with Test, Edit and Remove. */
export function MachineCard({ machine: m, onEdit, children }: { machine: MachineStatus; onEdit?: () => void; children?: ReactNode }) {
  const test = useMachineAction<string>(`Couldn't test ${m.name}`, (id) => machineApi.test(id))
  const st = MACHINE_STATE[m.state]
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove ${m.name}?`,
      body: `Box Yard stops running agents on it.${m.tasks ? ` Its ${m.tasks} task folder${m.tasks === 1 ? " is" : "s are"} archived first, and ${m.tasks === 1 ? "that task picks" : "those tasks pick"} up elsewhere on the next turn.` : ""} Nothing on the machine is uninstalled, and Box Yard's folder there (${m.dir}) stays.`,
      confirmLabel: "Remove",
      danger: true,
    })
    if (!ok) return
    try {
      await machineApi.remove(m.id)
    } catch (err) {
      // An offline machine's folders can't be archived first: Cody may remove it anyway.
      if (!(err instanceof ApiError) || err.status !== 409 || !/archived/.test(err.message)) return void toast.error(`Couldn't remove ${m.name}`, (err as Error).message)
      const force = await confirmDialog({ title: `Remove ${m.name} anyway?`, body: `${err.message}`, confirmLabel: "Remove anyway", danger: true })
      if (force) await machineApi.remove(m.id, true).catch((e: Error) => toast.error(`Couldn't remove ${m.name}`, e.message))
    }
  }
  return (
    <li className="@container min-w-0 space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-3 py-2.5 text-xs" data-machine={m.name}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", st.dot)} aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{m.name}</span>
        <span className={cx("rounded-md px-1.5 py-0.5 text-[11px] font-medium", st.chip)} title={st.title} data-testid="machine-state">
          {st.label}
        </span>
        <span className="ml-auto text-zinc-400 tabular-nums" title="Tasks running now / tasks running at once">
          {m.running}/{m.maxTasks} running
        </span>
      </div>
      <p className="wrap-anywhere text-zinc-500">
        <span className="font-mono text-zinc-400">{machineAddress(m)}</span> · <span className="font-mono">{m.keyRef}</span> · <span className="font-mono">{m.dir}</span>
        {m.tasks > 0 && (
          <>
            {" "}
            · {m.tasks} task folder{m.tasks === 1 ? "" : "s"}
          </>
        )}
      </p>
      {m.labels.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Labels">
          {m.labels.map((l) => (
            <li key={l} className="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
              {l}
            </li>
          ))}
        </ul>
      )}
      {m.problem && <p className="wrap-anywhere text-amber-300">{m.problem}</p>}
      <TestResult machine={m} />
      {children}
      {onEdit && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="subtle" loading={test.isPending} onClick={() => test.mutate(m.id)} data-testid="machine-test">
            {!test.isPending && <RefreshCw className="h-3 w-3" />} Test connection
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit…
          </Button>
          <Button size="sm" variant="danger" onClick={() => void remove()}>
            <Trash2 className="h-3 w-3" /> Remove…
          </Button>
        </div>
      )}
    </li>
  )
}

/** The last connection test: what the machine has, what's missing, and when. */
function TestResult({ machine: m }: { machine: MachineStatus }) {
  const t = m.lastTest
  if (!t) return <p className="text-zinc-500">Not tested yet.</p>
  if (!t.ok)
    return (
      <p className="wrap-anywhere text-zinc-500">
        Last test <TimeAgo ts={t.at} /> failed{m.problem === t.error ? "" : `: ${t.error}`}
      </p>
    )
  return (
    <div className="space-y-1" data-testid="machine-test-result">
      <p className="text-zinc-300">{hardwareLine(t)}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {toolList(t).map((x) => (
          <li key={x.name} className="flex items-start gap-1 text-zinc-400">
            <LineIcon
              icon={x.ok === true ? CheckCircle2 : x.ok === false ? XCircle : CircleDashed}
              className={cx("h-3 w-3", x.ok === true ? "text-emerald-400" : x.ok === false ? "text-red-400" : "text-zinc-500")}
            />
            <span>
              {x.name} <span className="text-zinc-500">{x.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {t.notes.map((n) => (
        <p key={n} className="wrap-anywhere text-zinc-500">
          {n}
        </p>
      ))}
      <p className="text-zinc-600">
        Tested <TimeAgo ts={t.at} />
        {t.latencyMs !== null && ` · ${t.latencyMs} ms`}
        {t.hostname && ` · ${t.hostname}`}
      </p>
    </div>
  )
}

/** Add a machine, or edit one. Saving tests it (a new address, key or work folder); the card then shows the result. */
function MachineDialog({ machine, fid, onClose }: { machine: MachineStatus | null; fid: (k: string) => string; onClose: () => void }) {
  const [d, setD] = useState<MachineDraft>(() => (machine ? draftOf(machine) : EMPTY_MACHINE))
  const [error, setError] = useState<string | null>(null)
  const [opened] = useState(() => JSON.stringify(d))
  const dirty = JSON.stringify(d) !== opened
  const save = useMachineAction<MachineDraft>(
    machine ? `Couldn't save ${machine.name}` : "Couldn't add the machine",
    (draft) => (machine ? machineApi.update(machine.id, machinePatch(draft, machine)) : machineApi.add(machineInput(draft))),
    { quiet: true },
  )
  const set = (patch: Partial<MachineDraft>) => setD((x) => ({ ...x, ...patch }))
  const field = (k: keyof MachineDraft) => fid(`machine-${k}`)
  const submit = async () => {
    setError(null)
    try {
      const r = await save.mutateAsync(d)
      const m = "machine" in r ? (r as { machine: MachineStatus }).machine : null
      if (m?.lastTest && !m.lastTest.ok) toast.error(`${m.name} didn't pass its test`, m.lastTest.error ?? undefined)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal
      title={machine ? `Edit ${machine.name}` : "Add an SSH machine"}
      description={machine ? undefined : "Box Yard logs in over SSH, checks what's installed, and runs agents there like on this computer."}
      size="lg"
      dirty={dirty}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={machine ? !dirty : false} data-testid="machine-save">
            {machine ? "Save" : "Add and test"}
          </Button>
        </>
      }
    >
      <div className="@container space-y-4">
        <div className="grid gap-3 @md:grid-cols-2">
          <Text id={field("name")} label="Name" hint="Like old-thinkpad. It works as a label too." value={d.name} onChange={(v) => set({ name: v })} autoFocus={!machine} />
          <Text id={field("labels")} label="Labels" hint="Comma-separated, like laptops, linux. Tasks pick machines by label." value={d.labels} onChange={(v) => set({ labels: v })} />
        </div>
        <div className="grid gap-3 @md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_6rem]">
          <Text id={field("host")} label="Host" hint="Host name or IP, like thinkpad.local" value={d.host} onChange={(v) => set({ host: v })} mono />
          <Text id={field("user")} label="User" hint="Agents run as this user." value={d.user} onChange={(v) => set({ user: v })} mono />
          <Text id={field("port")} label="Port" value={d.port} onChange={(v) => set({ port: v })} type="number" />
        </div>
        <Text id={field("keyRef")} label="SSH key" hint={KEY_REF_HELP} value={d.keyRef} onChange={(v) => set({ keyRef: v })} mono />
        <div className="grid gap-3 @md:grid-cols-2">
          <Text
            id={field("maxTasks")}
            label="Tasks running at once"
            hint={`${MACHINE_LIMITS.maxTasks.min}–${MACHINE_LIMITS.maxTasks.max}. About one per 2 CPUs and 4 GB of memory.`}
            value={d.maxTasks}
            onChange={(v) => set({ maxTasks: v })}
            type="number"
          />
          <Text id={field("dir")} label="Work folder" hint="Box Yard's folder on the machine; task folders go in <folder>/tasks." value={d.dir} onChange={(v) => set({ dir: v })} mono />
        </div>
        {machine && (
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="mt-1" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span>
              On
              <span className="block text-xs text-zinc-500">Off: running turns finish, no new ones start there, and its tasks move elsewhere when they safely can.</span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="wrap-anywhere rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" data-testid="machine-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

function Text({
  id,
  label,
  hint,
  value,
  onChange,
  mono,
  type = "text",
  autoFocus,
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  type?: "text" | "number"
  autoFocus?: boolean
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-xs font-medium tracking-wide text-zinc-400 uppercase">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={cx(inputClass, mono && "font-mono text-xs")}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}

/**
 * A project's (or a task's) SSH machines: any of them, or the ones with a label (or that name). Says which machines
 * that is now and how they are, so a label nobody has yet shows up before Save.
 */
export function MachineLabelPicker({ id, value, onChange }: { id?: string; value: string; onChange: (label: string) => void }) {
  const status = useMachines().data
  const machines = status?.machines ?? []
  const options = [...new Set([...(status?.labels.map((l) => l.label) ?? []), ...machines.map((m) => m.name.toLowerCase()), ...(value ? [value] : [])])]
  const matching = machines.filter((m) => machineMatches(m, value || null))
  return (
    <div className="space-y-1.5" data-testid="machine-label-picker">
      <Select id={id} className="w-full sm:w-80" value={value} onChange={(e) => onChange(e.target.value)} data-testid="project-machine-label">
        <option value="">Any SSH machine</option>
        {options.map((l) => (
          <option key={l} value={l}>
            {status?.labels.some((x) => x.label === l) ? `Labelled ${l}` : machines.some((m) => m.name.toLowerCase() === l) ? `Only ${l}` : l}
          </option>
        ))}
      </Select>
      <p className="text-xs text-zinc-500">
        {!machines.length ? (
          "No SSH machine yet: its tasks wait until you add one."
        ) : !matching.length ? (
          <span className="text-amber-300">No machine has it: its tasks wait until one does.</span>
        ) : (
          <>
            {matching.length === 1 ? "On " : `A free one of ${matching.length}: `}
            {matching.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ", "}
                {m.name} <span className="text-zinc-600">({MACHINE_STATE[m.state].label.toLowerCase()}, {m.running}/{m.maxTasks})</span>
              </span>
            ))}
            . Tasks wait while every one is busy.
          </>
        )}
      </p>
    </div>
  )
}
