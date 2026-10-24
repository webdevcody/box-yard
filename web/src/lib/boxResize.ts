// Resize display for the Boxes page: the size table rows, the modal's "what will happen" lines, and the toasts.
import { BOX_SIZE_ORDER, BOX_SIZE_SPECS, compareSizes, initiatorLabel, resizeFailure, resizeSummary, resizeTitle, type BoxResize, type ResizeMode } from "../../../shared/boxSizes"
import { formatBytes } from "../../../shared/disk"
import { SIZE_DEFAULTS, type BoxInfo, type BoxSize, type ResizePlan } from "../../../shared/types"
import { toast } from "./toast"

export interface SizeRow {
  size: BoxSize
  label: string
  cpu: string
  ram: string
  disk: string
  price: string
  /** Agents at once with the size's defaults (Settings may override). */
  slots: number
  current: boolean
  target: boolean
}

/** One row per size for the Resize modal's table. */
export function sizeRows(current: BoxSize, target: BoxSize): SizeRow[] {
  return BOX_SIZE_ORDER.map((size) => {
    const s = BOX_SIZE_SPECS[size]
    return {
      size,
      label: s.label,
      cpu: `${s.cpu} vCPU`,
      ram: `${s.ramGb} GB`,
      disk: `${s.storageGb} GB`,
      price: `$${s.activeCpuHourlyUsd.toFixed(2)}/h`,
      slots: SIZE_DEFAULTS[size].slotsPerBox,
      current: size === current,
      target: size === target,
    }
  })
}

/** The size picked when the modal opens: one up, or one down from large. */
export function defaultTarget(current: BoxSize): BoxSize {
  const i = BOX_SIZE_ORDER.indexOf(current)
  return BOX_SIZE_ORDER[i + 1] ?? BOX_SIZE_ORDER[i - 1] ?? current
}

/** What a resize will do, step by step, for the modal. */
export function resizeSteps(mode: ResizeMode, box: Pick<BoxInfo, "id">, to: BoxSize, tasks: number): string[] {
  if (mode === "in-place") return [`Changes ${box.id} to ${to} in place. Its workspaces stay where they are.`, "Nothing is placed on the box until it's done."]
  const work = tasks === 1 ? "1 task" : `${tasks} tasks`
  return [
    `Creates a new ${to} box. Upstash sets a box's size only when it's created, so the work moves.`,
    "Archives every workspace that doesn't have an up-to-date archive yet, uncommitted files included. If one can't be archived, nothing moves and the new box is removed.",
    `Moves ${tasks ? work : "the box's project"} to the new box, then deletes ${box.id}. Each workspace comes back from its archive on the task's next message.`,
  ]
}

/** "Scaling down: 1.2 GB in use of about 5 GB, keeping 1 GB free." */
export function fitLine(plan: Pick<ResizePlan, "fit" | "to">): string | null {
  const f = plan.fit
  if (!f) return null
  if (f.usedBytes === null) return f.reason
  const room = `${formatBytes(f.usedBytes)} in use; a ${plan.to} box has about ${formatBytes(f.capacityBytes)}, and ${formatBytes(f.headroomBytes)} stays free for new workspaces`
  return f.ok ? `Fits: ${room}.` : f.reason
}

export const direction = (from: BoxSize, to: BoxSize) => (compareSizes(to, from) > 0 ? "up" : compareSizes(to, from) < 0 ? "down" : "same")

/** The toast for a resize at any stage. */
export function resizeToast(r: BoxResize, projectName?: (id: string) => string): { kind: "progress" | "info" | "error"; title: string; body: string } {
  const who = r.by.kind === "cody" ? "" : `${initiatorLabel(r.by, r.by.kind === "captain" ? projectName?.(r.by.projectId) : undefined)}${r.reason ? `: ${r.reason}` : ""}. `
  if (r.status === "running") {
    const done = r.steps.filter((s) => s.status === "done").length
    return { kind: "progress", title: resizeTitle(r), body: `${who}${resizeSummary(r)} (${done + 1} of ${r.steps.length})` }
  }
  const summary = resizeSummary(r)
  return { kind: r.status === "failed" ? "error" : "info", title: resizeTitle(r), body: `${who}${summary[0]!.toUpperCase()}${summary.slice(1)}${/[.!?]$/.test(summary) ? "" : "."}` }
}

/** Show or update a resize's toast (SSE box.resize). */
export function announceResize(r: BoxResize) {
  const t = resizeToast(r)
  const key = `resize:${r.id}`
  if (t.kind === "progress") toast.progress(key, t.title, t.body)
  else toast.settle(key, t.kind, t.title, t.body)
}

/** The boxes list with a resize's report on its boxes. */
export function withResize(list: BoxInfo[] | undefined, r: BoxResize): BoxInfo[] | undefined {
  if (!list?.some((b) => b.id === r.boxId || b.id === r.newBoxId)) return list
  return list.map((b) =>
    b.id === r.boxId || b.id === r.newBoxId ? { ...b, resize: r, operation: r.status === "running" ? "resize" : b.operation === "resize" ? null : b.operation } : b,
  )
}

/** One line about the box's last resize for the details modal. */
export function resizeLine(r: BoxResize, boxId: string): string {
  if (r.status === "running") return `${resizeTitle(r)}: ${resizeSummary(r)}`
  if (r.status === "failed") return `${resizeTitle(r)}: ${resizeFailure(r)}`
  if (r.newBoxId === boxId && r.boxId !== boxId) return `Took over from ${r.boxId} (${r.from} → ${r.to})`
  return `${resizeTitle(r)}${r.mode === "in-place" ? " in place" : ""}`
}
