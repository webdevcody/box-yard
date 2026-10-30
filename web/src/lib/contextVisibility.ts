// Where a chat's context reading (the bar and "58%") and its Compact button show: the Coordinator, Captains and tasks.

import { useAgentSettings } from "./queries"

/** Which auto-compact setting covers a chat: the Coordinator's (it covers every Captain too) or the agents'. */
export type CompactScope = "coordinator" | "agent"

/** Each scope's auto-compact until settings load: the built-in defaults in server/settings.ts. */
const DEFAULT_AUTO_COMPACT: Record<CompactScope, boolean> = { coordinator: true, agent: false }

/** Whether Settings has this chat compact itself (Settings › Coordinator / Agents › auto-compact). */
export function useAutoCompact(scope: CompactScope): boolean {
  const s = useAgentSettings().data?.settings
  const ac = scope === "coordinator" ? s?.orchestratorAutoCompact : s?.agentAutoCompact
  return ac?.enabled ?? DEFAULT_AUTO_COMPACT[scope]
}

/**
 * Where the context reading and Compact go. With auto-compact on the chat compacts itself, so there is nothing to
 * watch: "none", not even in a menu. Off, a wide header shows them; a narrow one (a phone, a slim docked panel)
 * leaves them to its ⋯ menu, so they don't crowd the header.
 */
export function contextSpot(autoCompact: boolean, narrow: boolean): "none" | "header" | "menu" {
  if (autoCompact) return "none"
  return narrow ? "menu" : "header"
}

/**
 * The wide/narrow switch, as container queries on the header's `@container/head` (never the viewport: the
 * Coordinator panel is resizable). Below 30rem it's narrow: phones, and the docked panel near its narrowest.
 */
export const HEAD_CONTAINER = "@container/head"
export const WIDE_HEAD_ONLY = "@max-[30rem]/head:hidden"
export const NARROW_HEAD_ONLY = "@min-[30rem]/head:hidden"

/** How to render a spot: with these classes (they hide it at the widths it isn't for), or not at all (null). */
export function spotClass(autoCompact: boolean, spot: "header" | "menu"): string | null {
  const wide = contextSpot(autoCompact, false) === spot
  const narrow = contextSpot(autoCompact, true) === spot
  return wide && narrow ? "" : wide ? WIDE_HEAD_ONLY : narrow ? NARROW_HEAD_ONLY : null
}
