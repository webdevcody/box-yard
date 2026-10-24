// The "Merge PR" button. One click (and one confirm) sends the task's agent the standard merge message
// (server/prompts.ts MERGE_REQUEST_PROMPT); the button then reads "Merge queued" or "Merge requested…" until
// that turn ends or the PR is merged or closed. Shown only for an open PR (lib/mergePr.ts).
// In the task header the button sits with the actions and only shows while it can send; the pending states
// fold into the PR chip (MergePrChip: "PR #76 · merging…").
import { useEffect, useRef, type MouseEvent } from "react"
import { Clock, GitMerge, Loader2 } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useRequestMerge } from "../lib/queries"
import { MERGE_CHIP_LABEL, MERGE_LABEL, mergeBody, mergeButtonState, mergeTitle, sendMergeOnce, useMergesInFlight, type MergeButtonState, type MergeTask } from "../lib/mergePr"
import { confirmDialog } from "../lib/confirm"
import { prNumber } from "../lib/prState"
import { Button, PrChip, cx } from "./ui"
import { menuItem, usePopover } from "./TaskHeader"

type MergeableTask = MergeTask & Pick<Task, "title">

function useMergeButton(task: MergeableTask) {
  const inFlight = useMergesInFlight()
  const { mutateAsync } = useRequestMerge()
  const state = mergeButtonState(task, inFlight)
  const send = () => sendMergeOnce(task, () => mutateAsync(task.id)).catch(() => false)
  return { state, send }
}

const PENDING_TITLE: Partial<Record<MergeButtonState, string>> = {
  sending: "Sending the merge request…",
  queued: "Merge request sent; it goes out when the agent's current turn ends.",
  requested: "The agent is merging. This clears when its turn ends or the PR is merged or closed.",
}

function StateIcon({ state, className }: { state: MergeButtonState; className?: string }) {
  if (state === "queued") return <Clock className={className} />
  if (state === "sending" || state === "requested") return <Loader2 className={cx(className, "animate-spin")} />
  return <GitMerge className={className} />
}

/**
 * A small button that opens a one-step confirm popover (the confirm sheet on phones). `placement="actions"` is the
 * task header's action group on the right: button-sized, the popover opens leftwards, the label hides on phones,
 * and it only renders while a merge can be sent (MergePrChip shows the pending states).
 */
export function MergePrButton({ task, placement = "inline" }: { task: MergeableTask; placement?: "inline" | "actions" }) {
  const { state, send } = useMergeButton(task)
  const { open, setOpen, root, trigger } = usePopover()
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) confirm.current?.focus()
  }, [open])
  useEffect(() => {
    if (state !== "ready") setOpen(false)
  }, [state, setOpen])
  if (state === "hidden" || (placement === "actions" && state !== "ready")) return null
  const idle = state === "ready"
  const actions = placement === "actions"
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        aria-label={actions ? MERGE_LABEL[state] : undefined}
        type="button"
        data-merge-state={state}
        disabled={!idle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={PENDING_TITLE[state] ?? "Ask the agent to merge this pull request"}
        onClick={() => {
          // Phones get the shared confirm sheet; an anchored popover can't be placed reliably in a wrapping row.
          if (!open && window.matchMedia?.("(max-width: 639px)").matches) void confirmAndSend(task, send)
          else setOpen(!open)
        }}
        className={cx(
          "inline-flex min-h-11 shrink-0 items-center gap-1 border font-medium whitespace-nowrap transition sm:min-h-0",
          actions ? "min-w-11 justify-center gap-1.5 rounded-lg px-3 py-2 text-xs sm:min-w-0 sm:px-2.5 sm:py-1" : "rounded-md px-2 py-1 sm:px-1.5 sm:py-0.5",
          "focus-visible:ring-2 focus-visible:ring-merged focus-visible:outline-none",
          idle ? "border-merged/50 bg-merged/15 text-merged-fg hover:bg-merged/25" : "cursor-default border-zinc-800 bg-zinc-900/60 text-zinc-400",
        )}
      >
        <StateIcon state={state} className={actions ? "h-3.5 w-3.5" : "h-3 w-3"} /> <span className={cx(actions && "max-sm:sr-only")}>{MERGE_LABEL[state]}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={mergeTitle(task)}
          className={cx("absolute top-full z-30 mt-1 w-80 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm shadow-2xl", actions ? "right-0" : "left-0")}
        >
          <p className="font-medium text-zinc-100 wrap-anywhere">{mergeTitle(task)}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{mergeBody(task)}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              ref={confirm}
              size="sm"
              variant="primary"
              onClick={() => {
                setOpen(false)
                void send()
              }}
            >
              <GitMerge className="h-3.5 w-3.5" /> Send merge request
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The task header's PR chip, carrying a pending merge as its state: "PR #76 · merging…" with a spinner. */
export function MergePrChip({ task, className }: { task: MergeableTask & Pick<Task, "prMergedAt" | "prMergedBy">; className?: string }) {
  const { state } = useMergeButton(task)
  const label = state === "hidden" || state === "ready" ? null : MERGE_CHIP_LABEL[state]
  return (
    <PrChip
      task={task}
      className={className}
      activity={label ? { icon: <StateIcon state={state} className="h-3 w-3" />, label, title: PENDING_TITLE[state] ?? label } : null}
    />
  )
}

/** Ask with the shared confirm dialog (cards and menus, where an anchored popover doesn't fit). */
async function confirmAndSend(task: MergeableTask, send: () => Promise<boolean>) {
  // The dialog's title is one truncated line, so the task's (often long) name goes in the body.
  const n = prNumber(task.prUrl)
  if (await confirmDialog({ title: `Merge PR #${n ?? "?"}?`, body: `${mergeTitle(task)} ${mergeBody(task)}`, confirmLabel: "Send merge request" })) await send()
}

/** The ⋯ menu item. `onPicked` closes the menu before the confirm dialog opens. */
export function MergePrMenuItem({ task, onPicked }: { task: MergeableTask; onPicked: () => void }) {
  const { state, send } = useMergeButton(task)
  if (state === "hidden") return null
  return (
    <button
      type="button"
      data-merge-state={state}
      disabled={state !== "ready"}
      title={PENDING_TITLE[state]}
      className={cx(menuItem, "disabled:cursor-default disabled:text-zinc-500 disabled:hover:bg-transparent")}
      onClick={() => {
        onPicked()
        void confirmAndSend(task, send)
      }}
    >
      <StateIcon state={state} className="h-3.5 w-3.5 text-zinc-500" /> {state === "ready" ? "Merge PR…" : MERGE_LABEL[state]}
    </button>
  )
}

/** Card footers (Inbox, Yard, Recent): a compact button inside the card's link that doesn't open the task. */
export function MergePrCardButton({ task }: { task: MergeableTask }) {
  const { state, send } = useMergeButton(task)
  if (state === "hidden") return null
  const idle = state === "ready"
  const onClick = (e: MouseEvent) => {
    // The card is a link: don't open the task.
    e.preventDefault()
    e.stopPropagation()
    if (idle) void confirmAndSend(task, send)
  }
  return (
    <button
      type="button"
      data-merge-state={state}
      aria-disabled={!idle}
      aria-label={idle ? `Merge the PR of "${task.title}"` : MERGE_LABEL[state]}
      title={PENDING_TITLE[state] ?? "Ask the agent to merge this pull request"}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-2 font-medium whitespace-nowrap transition sm:-my-1 sm:min-h-6 sm:px-1.5",
        "focus-visible:ring-2 focus-visible:ring-merged focus-visible:outline-none",
        idle ? "border-merged/50 bg-merged/10 text-merged-fg hover:bg-merged/25" : "cursor-default border-zinc-800 text-zinc-500",
      )}
    >
      <StateIcon state={state} className="h-3 w-3" /> {idle ? "Merge" : MERGE_LABEL[state]}
    </button>
  )
}
