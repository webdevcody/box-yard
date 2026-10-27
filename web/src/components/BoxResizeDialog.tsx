// Resize box: pick a size (CPU, RAM, disk and price for each), see what will happen, and a second confirm to stop running agents.
import { useState, type FormEvent } from "react"
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Check, HardDrive, Loader2, Maximize2 } from "lucide-react"
import { useResizeBox, useResizePlan } from "../lib/queries"
import { boxBusyReason } from "../lib/boxOverview"
import { defaultTarget, direction, fitLine, resizeSteps, sizeRows } from "../lib/boxResize"
import { BOX_SIZE_DOCS, BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import type { BoxInfo, BoxSize } from "../../../shared/types"
import { Modal } from "./Modal"
import { Button, NewTabLink, cx } from "./ui"

export function BoxResizeDialog({ box, onClose }: { box: BoxInfo; onClose: () => void }) {
  const [target, setTarget] = useState<BoxSize>(() => defaultTarget(box.size))
  const plan = useResizePlan(box.id, target)
  const resize = useResizeBox()
  /** Second confirm: the agents running on the box get stopped first. */
  const [stopStep, setStopStep] = useState(false)
  const running = plan.data?.running ?? []
  const busy = boxBusyReason(box)
  const refusal = plan.data?.refusal ?? null
  const dir = direction(box.size, target)
  const canGo = !busy && dir !== "same" && Boolean(plan.data) && !refusal && !resize.isPending
  const mode = plan.data?.mode ?? "migration"

  const run = (stopAgents: boolean) => resize.mutate({ boxId: box.id, size: target, stopAgents }, { onSuccess: onClose })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canGo) return
    if (running.length > 0) {
      if (stopStep) run(true)
      else setStopStep(true)
      return
    }
    run(false)
  }
  const pick = (size: BoxSize) => {
    setTarget(size)
    setStopStep(false)
    resize.reset()
  }

  const Dir = dir === "down" ? ArrowDown : ArrowUp
  const n = running.length
  const label = stopStep ? `Stop ${n} running ${n === 1 ? "task" : "tasks"} and resize` : n > 0 ? "Stop tasks and resize…" : `Resize to ${BOX_SIZE_SPECS[target].label.toLowerCase()}`
  return (
    <Modal
      onClose={onClose}
      size="lg"
      dirty={resize.isPending}
      onSubmit={submit}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Maximize2 className="h-4 w-4 shrink-0 text-sky-300" />
          <span className="shrink-0">Resize box</span>
          <span className="truncate font-mono">{box.id}</span>
        </span>
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span>{BOX_SIZE_SPECS[box.size].label}</span>
          <ArrowRight className="h-3.5 w-3.5 text-zinc-500" />
          <span className={cx("font-medium", dir === "same" ? "text-zinc-400" : "text-zinc-100")}>{BOX_SIZE_SPECS[target].label}</span>
          {dir !== "same" && (
            <span className={cx("inline-flex items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium", dir === "up" ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300")}>
              <Dir className="h-3 w-3" /> {dir === "up" ? "scale up" : "scale down"}
            </span>
          )}
        </span>
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={stopStep ? () => setStopStep(false) : onClose} disabled={resize.isPending}>
            {stopStep ? "Back" : "Cancel"}
          </Button>
          <Button
            type="submit"
            variant={stopStep ? "danger" : n > 0 ? "subtle" : "primary"}
            disabled={!canGo}
            loading={resize.isPending}
            title={busy ?? refusal ?? undefined}
            data-testid="resize-confirm"
          >
            {resize.isPending ? "Starting…" : label}
          </Button>
        </>
      }
    >
      {stopStep ? (
        <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-100" data-testid="stop-confirm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            Stop {n} running {n === 1 ? "task" : "tasks"} first?
          </div>
          <p className="text-xs text-red-200/80">
            {n === 1 ? "Its turn ends" : "Their turns end"} mid-way. What {n === 1 ? "it has" : "they have"} done so far is archived, and {n === 1 ? "it picks" : "they pick"} up from there on the
            next message.
          </p>
          <RunningList running={running} />
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="sr-only">Target size</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Box size">
              {sizeRows(box.size, target).map((row) => (
                <button
                  key={row.size}
                  type="button"
                  role="radio"
                  aria-checked={row.target}
                  disabled={row.current}
                  onClick={() => pick(row.size)}
                  data-testid={`size-${row.size}`}
                  className={cx(
                    "relative rounded-lg border px-3 py-2.5 text-left text-xs transition focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
                    row.target && !row.current ? "border-yard-500/70 bg-yard-500/10" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700",
                    row.current && "cursor-default opacity-80 hover:border-zinc-800",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-zinc-100">{row.label}</span>
                    {row.current ? (
                      <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">Current</span>
                    ) : row.target ? (
                      <Check className="h-4 w-4 text-yard-400" />
                    ) : null}
                  </div>
                  <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-zinc-400">
                    <dt>CPU</dt>
                    <dd className="text-right text-zinc-200 tabular-nums">{row.cpu}</dd>
                    <dt>RAM</dt>
                    <dd className="text-right text-zinc-200 tabular-nums">{row.ram}</dd>
                    <dt>Disk</dt>
                    <dd className="text-right text-zinc-200 tabular-nums">{row.disk}</dd>
                    <dt>Price</dt>
                    <dd className="text-right text-zinc-200 tabular-nums" title="Per active CPU hour">
                      {row.price}
                    </dd>
                    <dt>Tasks at once</dt>
                    <dd className="text-right text-zinc-200 tabular-nums" title="Tasks running at once by default (Settings → Tasks running at once per box overrides)">
                      {row.slots}
                    </dd>
                  </dl>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-500">
              Upstash's numbers per size; the price is per active CPU hour.{" "}
              <NewTabLink href={BOX_SIZE_DOCS} className="text-sky-400 hover:underline">
                Box sizes
              </NewTabLink>
            </p>
          </fieldset>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              What happens
              <span className={cx("rounded-full px-1.5 py-0.5 text-[10px] normal-case", mode === "in-place" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300")} data-testid="resize-mode">
                {mode === "in-place" ? "in place" : "migration to a new box"}
              </span>
            </div>
            <ul className="space-y-1.5 text-sm text-zinc-300" data-testid="resize-steps">
              {resizeSteps(mode, box, target, plan.data?.tasks ?? box.residentTasks.length).map((s) => (
                <li key={s} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>

          {plan.isLoading && (
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the box…
            </p>
          )}
          {plan.data?.fit && (
            <div
              className={cx("flex gap-2 rounded-lg border px-3 py-2 text-xs", plan.data.fit.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200")}
              data-testid="resize-fit"
            >
              <HardDrive className={cx("mt-px h-3.5 w-3.5 shrink-0", plan.data.fit.ok ? "text-emerald-300" : "text-red-300")} />
              <span>{fitLine(plan.data)}</span>
            </div>
          )}
          {n > 0 && (
            <div role="status" className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="agents-running">
              <div className="flex gap-2">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span>
                  {n} {n === 1 ? "task is" : "tasks are"} running. Box Yard never interrupts {n === 1 ? "it" : "them"} for a resize: wait until the box is idle, or choose “Stop tasks and
                  resize” to stop {n === 1 ? "it" : "them"} first.
                </span>
              </div>
              <RunningList running={running} />
            </div>
          )}
          {refusal && !plan.data?.fit?.reason && <p className="text-xs text-amber-300">{refusal}</p>}
        </>
      )}
      {busy && <p className="text-xs text-amber-300">{busy}; try again when it's done.</p>}
      {(resize.error || plan.error) && (
        <p role="alert" className="text-xs text-red-300">
          {(resize.error ?? plan.error)!.message}
        </p>
      )}
    </Modal>
  )
}

function RunningList({ running }: { running: { id: string; title: string }[] }) {
  if (!running.length) return null
  return (
    <ul className="space-y-0.5 pl-5 text-xs">
      {running.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
          <span className="truncate">{t.title}</span>
        </li>
      ))}
    </ul>
  )
}
