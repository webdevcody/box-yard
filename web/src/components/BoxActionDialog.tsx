// Clear box / Delete box / Terminate pod confirmations: what's on the box, the delete safety check for each task, and
// second confirms to stop running agents and to delete past the check ("Delete anyway").
import { useState, type FormEvent } from "react"
import { AlertTriangle, Archive, CheckCircle2, Eraser, HardDrive, Loader2, Play, Power, Trash2 } from "lucide-react"
import { useBoxContents, useClearBox, useDeleteBox } from "../lib/queries"
import { boxBusyReason, statusCounts } from "../lib/boxOverview"
import { formatBytes } from "../../../shared/disk"
import { deleteAtRisk, type BoxContents, type BoxDeleteVerdict, type BoxInfo } from "../../../shared/types"
import type { RunPodPodInfo } from "../../../shared/runpod"
import { Modal } from "./Modal"
import { Button, LineIcon, STATUS, cx, inputClass } from "./ui"

export type BoxAction = "clear" | "delete"

const COPY = {
  clear: {
    title: "Clear box",
    verb: "clear",
    steps: [
      "Archives every workspace that doesn't have an up-to-date archive yet, uncommitted files included.",
      "Removes the task folders, then the repo mirrors and package caches.",
      "Keeps the box. Its tasks come back from their archive on their next message.",
    ],
    confirm: "Clear box",
  },
  delete: {
    title: "Delete box",
    verb: "delete",
    steps: [
      "Archives every workspace that doesn't have an up-to-date archive yet, uncommitted files included (a merged PR with nothing unpushed needs none). If one can't be archived, nothing is deleted.",
      "Destroys the box at the provider.",
      "Its projects' next tasks go to another box or a new one, restoring from the archive.",
    ],
    confirm: "Delete box",
  },
  terminate: {
    title: "Terminate",
    verb: "terminate",
    steps: [
      "Archives every workspace that doesn't have an up-to-date archive yet, uncommitted files included. If one can't be archived, nothing is terminated.",
      "Terminates the pod at RunPod (never just stops it): its container disk goes, its network volume stays.",
      "Its tasks start a new pod on their next message, restoring from the archive.",
    ],
    confirm: "Terminate pod",
  },
} as const

/** What the dialog acts on: a worker box from the Boxes page, or a RunPod GPU pod from Settings › RunPod GPU. */
interface Target {
  id: string
  kind: "box" | "pod"
  name: string
  description: string
  reachable: boolean
  running: number
  busy: string | null
}

const boxTarget = (box: BoxInfo): Target => ({
  id: box.id,
  kind: "box",
  name: box.id,
  description: `${box.provider} · ${box.size}`,
  reachable: box.status === "ready",
  running: box.runningTurns,
  busy: boxBusyReason(box),
})

const podTarget = (p: RunPodPodInfo): Target => ({
  id: p.boxId,
  kind: "pod",
  name: `${p.projectName ?? p.projectId}'s GPU pod #${p.index}`,
  description: `RunPod · ${p.gpu ?? "GPU"}${p.dataCenter ? ` · ${p.dataCenter}` : ""}${p.costPerHr !== null ? ` · $${p.costPerHr.toFixed(2)}/hr` : ""}`,
  reachable: p.status === "RUNNING",
  running: p.running,
  busy: p.status === "RUNNING" ? null : `The pod is ${p.status.toLowerCase()}`,
})

type Step = "confirm" | "stop" | "risk"

export function BoxActionDialog({ box, pod, action, onClose, onDone }: { box?: BoxInfo; pod?: RunPodPodInfo; action: BoxAction; onClose: () => void; onDone?: () => void }) {
  const target = box ? boxTarget(box) : podTarget(pod!)
  const removing = action === "delete"
  const copy = removing ? (target.kind === "pod" ? COPY.terminate : COPY.delete) : COPY.clear
  const contents = useBoxContents(target.id)
  const clear = useClearBox()
  const del = useDeleteBox()
  const mutation = removing ? del : clear
  const [typed, setTyped] = useState("")
  const [step, setStep] = useState<Step>("confirm")
  const running = contents.data?.running ?? target.running
  // Delete past the safety check: queued tasks and work GitHub doesn't have (running agents are stopped instead).
  const risky = removing && contents.data ? deleteAtRisk(contents.data.tasks) : []
  const busy = target.busy
  const nameOk = !removing || target.kind === "pod" || typed.trim() === target.id
  const blocked = busy ?? (contents.isLoading ? "Checking what's on the box" : !nameOk ? "Type the box name to confirm" : null)
  const canGo = !blocked && !mutation.isPending
  const steps: Step[] = ["confirm", ...(running > 0 ? (["stop"] as const) : []), ...(risky.length ? (["risk"] as const) : [])]
  const next = steps[steps.indexOf(step) + 1]
  const back = steps[steps.indexOf(step) - 1]

  const run = () => {
    const done = {
      onSuccess: () => {
        onClose()
        onDone?.()
      },
    }
    if (removing) del.mutate({ boxId: target.id, stopAgents: running > 0, override: risky.length > 0 }, done)
    else clear.mutate({ boxId: target.id, stopAgents: running > 0 }, done)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canGo) return
    if (next) setStep(next)
    else run()
  }

  const Icon = action === "clear" ? Eraser : target.kind === "pod" ? Power : Trash2
  const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`
  const Verb = copy.verb[0]!.toUpperCase() + copy.verb.slice(1)
  const label = mutation.isPending
    ? `Archiving and ${copy.verb === "terminate" ? "terminating" : `${copy.verb}ing`}…`
    : step === "confirm"
      ? running > 0
        ? `Stop agents and ${copy.verb}…`
        : risky.length
          ? `${Verb} anyway…`
          : copy.confirm
      : step === "stop"
        ? `Stop ${agents(running)} and ${copy.verb}${next ? "…" : ""}`
        : `${Verb} anyway`
  return (
    <Modal
      onClose={onClose}
      size="md"
      dirty={mutation.isPending || typed.length > 0}
      onSubmit={submit}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Icon className={cx("h-4 w-4 shrink-0", removing ? "text-red-400" : "text-amber-300")} />
          <span className="shrink-0">{copy.title}</span>
          <span className={cx("truncate", target.kind === "box" && "font-mono")}>{target.name}?</span>
        </span>
      }
      description={target.description}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={back ? () => setStep(back) : onClose} disabled={mutation.isPending}>
            {back ? "Back" : "Cancel"}
          </Button>
          <Button
            type="submit"
            variant={removing || step !== "confirm" ? "danger" : running > 0 ? "subtle" : "primary"}
            disabled={!canGo}
            loading={mutation.isPending}
            title={blocked ?? undefined}
            data-testid="box-action-confirm"
          >
            {label}
          </Button>
        </>
      }
    >
      {step === "stop" ? (
        <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-100" data-testid="stop-confirm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            Stop {running} running {running === 1 ? "agent" : "agents"} first?
          </div>
          <p className="text-xs text-red-200/80">
            {running === 1 ? "Its turn ends" : "Their turns end"} mid-way. What {running === 1 ? "it has" : "they have"} done so far is archived with the rest, and {running === 1 ? "it picks" : "they pick"} up
            from there on the next message.
          </p>
          <TaskLines contents={contents.data} onlyRunning />
        </div>
      ) : step === "risk" ? (
        <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-100" data-testid="risk-confirm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            {Verb} anyway? {risky.length === 1 ? "This task doesn't" : `These ${risky.length} tasks don't`} pass the safety check:
          </div>
          <ul className="space-y-1 text-xs">
            {risky.map((t) => (
              <li key={t.id} className="flex min-w-0 items-start gap-1.5">
                <LineIcon icon={VERDICT[t.verdict].icon} className={cx("h-3.5 w-3.5", VERDICT[t.verdict].tone)} />
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium text-red-50">{t.title}</span> <span className="text-red-200/80">· {t.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-red-200/80">
            Every workspace is still archived first, uncommitted files included, so that work lives on only in Box Yard's archive, not on GitHub.
            {risky.some((t) => t.verdict === "queued") && ` Queued tasks go to another ${target.kind === "pod" ? "pod" : "box"}.`} If a workspace can't be archived, nothing is{" "}
            {target.kind === "pod" ? "terminated" : "deleted"}. Agents can't do this; only you can.
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-1.5 text-sm text-zinc-300">
            {(target.reachable ? copy.steps : [`This ${target.kind} isn't reachable, so its workspaces can't be archived now. Tasks restore from their last archive.`, copy.steps[1]!, copy.steps[2]!]).map((s) => (
              <li key={s} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
          <OnTheBox target={target} contents={contents.data} loading={contents.isLoading} error={contents.error?.message} checks={removing} />
          {running > 0 && (
            <div role="status" className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="agents-running">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" />
              <span>
                {running} {running === 1 ? "agent is" : "agents are"} running: stop {running === 1 ? "it" : "them"} first, or choose “Stop agents and {copy.verb}” to stop{" "}
                {running === 1 ? "it" : "them"} as part of this.
              </span>
            </div>
          )}
          {risky.length > 0 && (
            <div role="status" className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="safety-failed">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" />
              <span>
                The safety check flags {risky.length} {risky.length === 1 ? "task" : "tasks"}, so the Coordinator and Captains can't {copy.verb} this {target.kind}. You can still{" "}
                {copy.verb} it anyway: the next step lists what's at risk.
              </span>
            </div>
          )}
          {removing && target.kind === "box" && (
            <label className="block space-y-1.5 text-xs text-zinc-400">
              <span>
                Type <span className="font-mono text-zinc-200 select-all">{target.id}</span> to confirm
              </span>
              <input className={cx(inputClass, "font-mono")} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Box name" />
            </label>
          )}
        </>
      )}
      {busy && (
        <p className="text-xs text-amber-300" data-testid="box-action-blocked">
          {busy}; {target.kind === "pod" && !target.reachable ? `there's nothing to ${copy.verb}.` : "try again when it's done."}
        </p>
      )}
      {mutation.error && (
        <p role="alert" className="text-xs whitespace-pre-line text-red-300">
          {mutation.error.message}
        </p>
      )}
    </Modal>
  )
}

/** How each safety check verdict reads in the dialog. */
const VERDICT: Record<BoxDeleteVerdict, { icon: typeof CheckCircle2; tone: string }> = {
  ok: { icon: CheckCircle2, tone: "text-emerald-400" },
  running: { icon: Play, tone: "text-amber-300" },
  queued: { icon: AlertTriangle, tone: "text-amber-300" },
  unpushed: { icon: AlertTriangle, tone: "text-red-400" },
  dirty: { icon: AlertTriangle, tone: "text-red-400" },
  unchecked: { icon: AlertTriangle, tone: "text-amber-300" },
}

/** Tasks by status, the safety check of each (Delete and Terminate), uncommitted work and disk in use. */
function OnTheBox({ target, contents, loading, error, checks }: { target: Target; contents?: BoxContents; loading: boolean; error?: string; checks: boolean }) {
  if (loading)
    return (
      <p className="flex items-center gap-2 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking what's on the {target.kind}…
      </p>
    )
  if (!contents) return <p className="text-xs text-red-300">{error ?? `Couldn't read what's on the ${target.kind}.`}</p>
  const dirty = contents.tasks.filter((t) => t.uncommitted)
  const toArchive = contents.tasks.filter((t) => !t.archived).length
  const used = contents.diskUsedBytes
  return (
    <div className="space-y-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5 text-xs" data-testid="box-contents">
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">On this {target.kind}</div>
        {contents.tasks.length === 0 ? (
          <span className="text-zinc-500">No task workspaces.</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {statusCounts(contents.tasks).map(({ status, count }) => (
              <span key={status} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", STATUS[status].chip)}>
                <span className={cx("h-1.5 w-1.5 rounded-full", STATUS[status].dot)} />
                {count} {STATUS[status].label.toLowerCase()}
              </span>
            ))}
          </div>
        )}
      </div>
      {checks && contents.tasks.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Safety check</div>
          <ul className="space-y-1" data-testid="safety-check">
            {contents.tasks.map((t) => (
              <li key={t.id} className="flex min-w-0 items-start gap-1.5" data-verdict={t.verdict}>
                <LineIcon icon={VERDICT[t.verdict].icon} className={cx("h-3.5 w-3.5", VERDICT[t.verdict].tone)} label={t.verdict} />
                <span className="min-w-0 wrap-anywhere">
                  <span className="text-zinc-200">{t.title}</span>{" "}
                  <span className="text-zinc-500">
                    · {STATUS[t.status].label.toLowerCase()} · {t.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Delete and Terminate say per task what happens to its archive (a merged, pushed one needs none). */}
      {!checks && contents.tasks.length > 0 && (
        <div className="flex gap-2 text-zinc-300">
          <Archive className="mt-px h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <div className="min-w-0">
            {toArchive ? `${toArchive} of ${contents.tasks.length} ${contents.tasks.length === 1 ? "workspace needs" : "workspaces need"} a fresh archive first.` : "Every workspace already has an up-to-date archive."}
            {dirty.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-amber-200">
                {dirty.map((t) => (
                  <li key={t.id} className="flex min-w-0 gap-1.5">
                    <span className="truncate" title={t.title}>
                      {t.title}
                    </span>
                    <span className="shrink-0 text-amber-300/80">
                      · {t.uncommitted} uncommitted {t.uncommitted === 1 ? "file" : "files"}, archived first
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {target.kind === "box" && (
        <div className="flex items-center gap-2 text-zinc-300">
          <HardDrive className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          {used !== null ? (
            <span>
              {formatBytes(used)} of disk in use
              {contents.diskBytes !== null && <span className="text-zinc-500"> · Box Yard's folders {formatBytes(contents.diskBytes)}</span>}
            </span>
          ) : (
            <span className="text-zinc-500">{target.reachable ? "Disk use not measured yet" : "Disk use unknown"}</span>
          )}
        </div>
      )}
    </div>
  )
}

function TaskLines({ contents, onlyRunning }: { contents?: BoxContents; onlyRunning?: boolean }) {
  const tasks = (contents?.tasks ?? []).filter((t) => !onlyRunning || t.running)
  if (!tasks.length) return null
  return (
    <ul className="space-y-0.5 text-xs">
      {tasks.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center gap-1.5">
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[t.status].dot)} />
          <span className="truncate">{t.title}</span>
        </li>
      ))}
    </ul>
  )
}
