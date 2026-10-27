// Where a task actually runs, on its card (compact) and in the task header (full, with a details popover).
// The wording is shared/placement.ts's; the icons are the Boxes page's and Settings' for each provider.
import { memo } from "react"
import { Link } from "wouter"
import { Boxes, Container, Cpu, Laptop, Pin, ShieldAlert, type LucideIcon } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import { LOCAL_UNSANDBOXED } from "../../../shared/runner"
import { placementView, type PlaceKind, type PlacementView } from "../../../shared/placement"
import { usePopover } from "./TaskHeader"
import { LineIcon, META_CHIP, cx, timeAgo } from "./ui"

/** Laptop for this computer (the Boxes page's), Boxes for worker boxes, Cpu for RunPod (Settings' RunPod GPU), Container for Docker. */
export const PLACE_ICON: Record<PlaceKind, LucideIcon> = { local: Laptop, box: Boxes, gpu: Cpu, docker: Container }

/** Local is amber like the unsandboxed warning; the rest are calm. Muted while it's only where it will go or went. */
const tone = (v: PlacementView) => (v.state !== "here" ? "text-zinc-500" : v.kind === "local" ? "text-amber-200" : "text-zinc-300")

/** The full tooltip: every line the header's popover shows. */
export const placementTitle = (v: PlacementView) => [v.label, v.setting, v.pinned ? "Pinned: this task overrides its project" : "", v.reason ?? "", v.kind === "local" ? LOCAL_UNSANDBOXED : ""].filter(Boolean).join("\n")

/** The card's compact chip: icon, "Upstash · small" / "→ This computer", and a pin when the task overrides its project. */
export const PlacementCardChip = memo(function PlacementCardChip({ task }: { task: Task }) {
  const v = placementView(task)
  const Icon = PLACE_ICON[v.kind]
  return (
    <span data-testid="card-placement" data-state={v.state} className={cx("inline-flex min-w-0 items-center gap-1", tone(v))} title={placementTitle(v)}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{v.short}</span>
      {v.pinned && <Pin className="h-3 w-3 shrink-0 text-zinc-500" aria-label="pinned" />}
    </span>
  )
})

/** The header's chip: the full label, and a tap or click opens where it runs, the box and size, the setting that chose it and why. */
export function PlacementHeaderChip({ task, project }: { task: Task; project: Project | undefined }) {
  const v = placementView(task, project?.runner)
  const Icon = PLACE_ICON[v.kind]
  const { open, setOpen, root, trigger } = usePopover()
  return (
    <span ref={root} className="relative inline-flex min-w-0">
      <button
        ref={trigger}
        type="button"
        data-testid="task-placement"
        data-state={v.state}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={placementTitle(v)}
        onClick={() => setOpen(!open)}
        className={cx(
          META_CHIP,
          "max-w-full min-w-0 shrink",
          v.state !== "here"
            ? "border-dashed border-zinc-800 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
            : v.kind === "local"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
              : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{v.label}</span>
        {v.pinned && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-zinc-500">
            · <Pin className="h-3 w-3" aria-hidden /> pinned
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Where this task runs"
          className="absolute top-full right-0 z-30 mt-1 w-[calc(100vw-2rem)] max-w-80 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400 shadow-2xl"
        >
          <p className={cx("flex items-start gap-2 text-sm font-medium wrap-anywhere", v.kind === "local" && v.state === "here" ? "text-amber-200" : "text-zinc-100")}>
            <LineIcon icon={Icon} className="h-4 w-4" />
            <span>{v.state === "next" ? `Goes to ${v.label.slice(2)}` : v.label}</span>
          </p>
          <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
            {v.place && (
              <>
                <dt className="text-zinc-500">{v.place.kind === "gpu" ? "Pod" : v.place.kind === "docker" ? "Container" : "Box"}</dt>
                <dd className="min-w-0 font-mono text-[11px] wrap-anywhere text-zinc-300">
                  {v.place.kind === "box" && v.state === "here" ? (
                    <Link href={`/boxes#${encodeURIComponent(v.place.boxId)}`} className="hover:underline" onClick={() => setOpen(false)}>
                      {v.place.boxId}
                    </Link>
                  ) : (
                    (v.place.podId ?? v.place.container ?? v.place.boxId)
                  )}
                </dd>
                {v.place.size && (
                  <>
                    <dt className="text-zinc-500">Size</dt>
                    <dd className="text-zinc-300">
                      {BOX_SIZE_SPECS[v.place.size].label} · {BOX_SIZE_SPECS[v.place.size].cpu} CPU, {BOX_SIZE_SPECS[v.place.size].ramGb} GB
                    </dd>
                  </>
                )}
                {v.place.gpu && (
                  <>
                    <dt className="text-zinc-500">GPU</dt>
                    <dd className="text-zinc-300">{v.place.gpu}</dd>
                  </>
                )}
              </>
            )}
            {v.state === "last" && task.placement?.last && (
              <>
                <dt className="text-zinc-500">Left</dt>
                <dd className="text-zinc-300">{timeAgo(task.placement.last.leftAt)}</dd>
              </>
            )}
            <dt className="text-zinc-500">Chosen by</dt>
            <dd className="text-zinc-300">
              {v.setting}
              {v.pinned && <span className="text-zinc-500"> (pinned: overrides the project)</span>}
            </dd>
          </dl>
          {v.reason && <p className="mt-2 leading-snug">{v.reason}</p>}
          {v.kind === "local" && (
            <p id="local-warning-note" role="note" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-200">
              <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
              <span>{LOCAL_UNSANDBOXED}</span>
            </p>
          )}
        </div>
      )}
    </span>
  )
}
