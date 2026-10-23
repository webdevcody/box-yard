// Clear box / Delete box confirmations: what's on the box, what will happen, and a second confirm to stop running agents.
import { useState, type FormEvent } from "react"
import { AlertTriangle, Archive, Eraser, HardDrive, Loader2, Trash2 } from "lucide-react"
import { useBoxContents, useClearBox, useDeleteBox } from "../lib/queries"
import { boxBusyReason, statusCounts } from "../lib/boxOverview"
import { formatBytes } from "../../../shared/disk"
import type { BoxContents, BoxInfo } from "../../../shared/types"
import { Modal } from "./Modal"
import { Button, STATUS, cx, inputClass } from "./ui"

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
      "Archives every workspace that doesn't have an up-to-date archive yet, uncommitted files included. If one can't be archived, nothing is deleted.",
      "Destroys the box at the provider.",
      "Its projects' next tasks go to another box or a new one, restoring from the archive.",
    ],
    confirm: "Delete box",
  },
} as const

export function BoxActionDialog({ box, action, onClose, onDone }: { box: BoxInfo; action: BoxAction; onClose: () => void; onDone?: () => void }) {
  const copy = COPY[action]
  const contents = useBoxContents(box.id)
  const clear = useClearBox()
  const del = useDeleteBox()
  const mutation = action === "clear" ? clear : del
  const [typed, setTyped] = useState("")
  /** Second confirm: the agents running on the box get stopped first. */
  const [stopStep, setStopStep] = useState(false)
  const running = contents.data?.running ?? box.runningTurns
  const busy = boxBusyReason(box)
  const reachable = box.status === "ready"
  const nameOk = action === "clear" || typed.trim() === box.id
  const canGo = !busy && !contents.isLoading && nameOk && !mutation.isPending

  const run = (stopAgents: boolean) => {
    mutation.mutate(
      { boxId: box.id, stopAgents },
      {
        onSuccess: () => {
          onClose()
          onDone?.()
        },
      },
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canGo) return
    if (running > 0) {
      if (stopStep) run(true)
      else setStopStep(true)
      return
    }
    run(false)
  }

  const Icon = action === "clear" ? Eraser : Trash2
  const label = stopStep ? `Stop ${running} ${running === 1 ? "agent" : "agents"} and ${copy.verb}` : copy.confirm
  return (
    <Modal
      onClose={onClose}
      size="md"
      dirty={mutation.isPending || typed.length > 0}
      onSubmit={submit}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Icon className={cx("h-4 w-4 shrink-0", action === "delete" ? "text-red-400" : "text-amber-300")} />
          {copy.title} <span className="truncate font-mono">{box.id}</span>?
        </span>
      }
      description={`${box.provider} · ${box.size}`}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={stopStep ? () => setStopStep(false) : onClose} disabled={mutation.isPending}>
            {stopStep ? "Back" : "Cancel"}
          </Button>
          <Button
            type="submit"
            variant={action === "delete" || stopStep ? "danger" : "primary"}
            disabled={!canGo}
            loading={mutation.isPending}
            title={busy ?? (!nameOk ? "Type the box name to confirm" : undefined)}
            data-testid="box-action-confirm"
          >
            {mutation.isPending ? (action === "clear" ? "Archiving and clearing…" : "Archiving and deleting…") : running > 0 && !stopStep ? `Stop agents and ${copy.verb}…` : label}
          </Button>
        </>
      }
    >
      {stopStep ? (
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
      ) : (
        <>
          <ul className="space-y-1.5 text-sm text-zinc-300">
            {(reachable ? copy.steps : ["This box isn't reachable, so its workspaces can't be archived now. Tasks restore from their last archive.", copy.steps[1]!, copy.steps[2]!]).map((s) => (
              <li key={s} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
          <OnTheBox box={box} contents={contents.data} loading={contents.isLoading} error={contents.error?.message} />
          {running > 0 && (
            <div role="status" className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="agents-running">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" />
              <span>
                {running} {running === 1 ? "agent is" : "agents are"} running: stop {running === 1 ? "it" : "them"} first, or choose “Stop agents and {copy.verb}” to stop{" "}
                {running === 1 ? "it" : "them"} as part of this.
              </span>
            </div>
          )}
          {action === "delete" && (
            <label className="block space-y-1.5 text-xs text-zinc-400">
              <span>
                Type <span className="font-mono text-zinc-200 select-all">{box.id}</span> to confirm
              </span>
              <input className={cx(inputClass, "font-mono")} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Box name" />
            </label>
          )}
        </>
      )}
      {busy && <p className="text-xs text-amber-300">{busy}; try again when it's done.</p>}
      {mutation.error && (
        <p role="alert" className="text-xs text-red-300">
          {mutation.error.message}
        </p>
      )}
    </Modal>
  )
}

/** Tasks by status, uncommitted work and disk in use. */
function OnTheBox({ box, contents, loading, error }: { box: BoxInfo; contents?: BoxContents; loading: boolean; error?: string }) {
  if (loading)
    return (
      <p className="flex items-center gap-2 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking what's on the box…
      </p>
    )
  if (!contents) return <p className="text-xs text-red-300">{error ?? "Couldn't read what's on the box."}</p>
  const dirty = contents.tasks.filter((t) => t.uncommitted)
  const toArchive = contents.tasks.filter((t) => !t.archived).length
  const used = contents.diskUsedBytes
  return (
    <div className="space-y-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5 text-xs" data-testid="box-contents">
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">On this box</div>
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
      {contents.tasks.length > 0 && (
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
      <div className="flex items-center gap-2 text-zinc-300">
        <HardDrive className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        {used !== null ? (
          <span>
            {formatBytes(used)} of disk in use
            {contents.diskBytes !== null && <span className="text-zinc-500"> · Box Yard's folders {formatBytes(contents.diskBytes)}</span>}
          </span>
        ) : (
          <span className="text-zinc-500">{box.status === "ready" ? "Disk use not measured yet" : "Disk use unknown"}</span>
        )}
      </div>
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
