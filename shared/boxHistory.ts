// The box history log: every box lifecycle event and who did it (server/boxHistory.ts writes it, the Boxes page
// History section and the box_history MCP tool read it).

import type { BoxSize as Size } from "./types.js"

export const BOX_EVENT_TYPES = [
  { key: "created", label: "Created" },
  { key: "resized", label: "Resized" },
  { key: "resize_failed", label: "Resize failed" },
  { key: "deleted", label: "Deleted" },
  { key: "lost", label: "Lost" },
  { key: "cleanup", label: "Cleanup" },
  { key: "cleared", label: "Cleared" },
  { key: "size_changed", label: "Size changed" },
  { key: "orphan_deleted", label: "Orphan deleted" },
  // Per-project snapshots (shared/snapshots.ts): one taken from this box, one that failed, and a new box that
  // started cold because the project's snapshot couldn't be used or restored.
  { key: "snapshot", label: "Snapshot" },
  { key: "snapshot_failed", label: "Snapshot failed" },
  { key: "snapshot_fallback", label: "Snapshot not used" },
  // A Docker project's container (shared/docker.ts) stopping when idle and starting again: its volume keeps the
  // workspaces, so it isn't deleted and made again.
  { key: "started", label: "Started" },
  { key: "stopped", label: "Stopped" },
] as const
export type BoxEventType = (typeof BOX_EVENT_TYPES)[number]["key"]

/** Who or what did it. "owner" is Cody from the UI (or the API); its label goes through withOwner. */
export const BOX_ACTORS = [
  { key: "owner", label: "Cody" },
  { key: "coordinator", label: "The Coordinator" },
  { key: "captain", label: "A Captain" },
  { key: "scheduler", label: "Box Yard (placement)" },
  { key: "resize", label: "Resize migration" },
  { key: "resize-cleanup", label: "Failed-resize cleanup" },
  { key: "janitor", label: "Janitor" },
  { key: "orphan-sweep", label: "Orphan sweep" },
  { key: "provider", label: "Provider" },
  { key: "snapshot", label: "Project snapshot" },
] as const
export type BoxActorKind = (typeof BOX_ACTORS)[number]["key"]

export type BoxActor = { kind: Exclude<BoxActorKind, "captain"> } | { kind: "captain"; projectId: string }

export interface BoxEvent {
  id: number
  at: number
  boxId: string
  boxName: string | null
  type: BoxEventType
  actor: BoxActorKind
  /** The Captain's project when actor is "captain". */
  actorProjectId: string | null
  /** Why: the reason a Coordinator or Captain gave, or what made Box Yard do it. */
  reason: string | null
  /** The box's size at the time. */
  size: Size | null
  fromSize: Size | null
  toSize: Size | null
  /** The other box of a resize migration (its target on the old box's events, its source on the new box's). */
  relatedBoxId: string | null
  resizeId: string | null
  /** Projects on the box then (names kept, so a deleted project still reads). */
  projects: { id: string; name: string }[]
  taskIds: string[]
  freedBytes: number | null
  /** One line on what happened. */
  detail: string | null
}

export interface BoxEventFilter {
  boxId?: string
  type?: BoxEventType
  actor?: BoxActorKind
  /** Only events about this project's boxes (a Captain's scope): it was on the box, or its Captain did it. */
  projectId?: string
  /** Events before this id (paging, newest first). */
  before?: number
  limit?: number
}

/** Rows kept: newer than this many days, and at most this many. */
export const BOX_HISTORY_MAX_DAYS = 90
export const BOX_HISTORY_MAX_ROWS = 5000

export const boxEventLabel = (type: string): string => BOX_EVENT_TYPES.find((t) => t.key === type)?.label ?? type

/** "Cody", "The Coordinator", "The api Captain", "Failed-resize cleanup"… (pass the result through withOwner). */
export function boxActorLabel(e: Pick<BoxEvent, "actor" | "actorProjectId">, projectName?: (id: string) => string | undefined): string {
  if (e.actor === "captain") return `The ${(e.actorProjectId && projectName?.(e.actorProjectId)) || e.actorProjectId || "project"} Captain`
  return BOX_ACTORS.find((a) => a.key === e.actor)?.label ?? e.actor
}
