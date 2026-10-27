// The Boxes page History section: filters, labels and tones for box history rows (shared/boxHistory.ts).
import { boxActorLabel, boxEventLabel, type BoxActorKind, type BoxEvent, type BoxEventType } from "../../../shared/boxHistory"
import { formatBytes } from "../../../shared/disk"
import { withOwner } from "../../../shared/owner"

export interface HistoryFilter {
  boxId?: string
  type?: BoxEventType
  actor?: BoxActorKind
}

/** GET /api/box-history's answer. */
export interface BoxHistoryPage {
  events: BoxEvent[]
  more: boolean
  /** Every box the log mentions, newest first (deleted ones too). */
  boxIds: string[]
}

export const HISTORY_PAGE = 30

export function boxHistoryQuery(f: HistoryFilter, limit: number): string {
  const q = new URLSearchParams()
  if (f.boxId) q.set("boxId", f.boxId)
  if (f.type) q.set("type", f.type)
  if (f.actor) q.set("actor", f.actor)
  q.set("limit", String(limit))
  return `?${q}`
}

export type EventTone = "good" | "info" | "warn" | "bad" | "muted"

export const EVENT_TONE: Record<BoxEventType, EventTone> = {
  created: "good",
  resized: "info",
  resize_failed: "bad",
  deleted: "muted",
  lost: "bad",
  cleanup: "warn",
  cleared: "warn",
  size_changed: "info",
  orphan_deleted: "muted",
  snapshot: "good",
  snapshot_failed: "bad",
  snapshot_fallback: "warn",
  started: "info",
  stopped: "muted",
}

export const eventLabel = (e: Pick<BoxEvent, "type">) => boxEventLabel(e.type)

/** "Cody", "The alpha Captain", "Failed-resize cleanup"… with the owner's own name. */
export const actorLabel = (e: Pick<BoxEvent, "actor" | "actorProjectId">, projectName: (id: string) => string | undefined, ownerName: string) =>
  withOwner(boxActorLabel(e, projectName), ownerName)

/** "small → large", or the box's size, or null. */
export function sizeLine(e: Pick<BoxEvent, "size" | "fromSize" | "toSize">): string | null {
  if (e.fromSize && e.toSize) return `${e.fromSize} → ${e.toSize}`
  return e.size
}

/** The one-line "why" a collapsed row shows: the reason, else what happened, plus the bytes a cleanup freed. */
export function eventSummary(e: Pick<BoxEvent, "reason" | "detail" | "freedBytes" | "type">): string {
  const freed = e.freedBytes !== null && (e.type === "cleanup" || e.type === "cleared") ? `freed ${formatBytes(e.freedBytes)}` : null
  const text = e.reason ?? e.detail ?? ""
  return [freed && !text.startsWith("freed") ? freed : null, text].filter(Boolean).join(" · ")
}
