// The Coordinator chat's project bar (components/ProjectBar.tsx): which projects it shows, what each chip counts,
// and the project the chat is filtered to. The counts are pure, so they are unit tested.
import { useSyncExternalStore } from "react"
import type { Project, Task } from "../../../shared/types"

export interface BarRow {
  id: string
  name: string
  /** Tasks asking Cody something. */
  needs: number
  /** Turns running or being set up. */
  running: number
  queued: number
  /** Tasks with a pull request open. */
  prReady: number
}

/**
 * The bar's projects: those with tasks asking, running, queued or with a PR open, the ones the chat talked about
 * lately (`recent`), and the one it's filtered to. In the sidebar's order, so a chip never moves as counts change.
 * `active` is the "All" chip's count: tasks asking, running or queued.
 */
export function projectBarRows(projects: readonly Project[], tasks: readonly Task[], recent: ReadonlySet<string>, filter: string | null): { rows: BarRow[]; active: number } {
  const counts = new Map<string, BarRow>()
  for (const p of projects) counts.set(p.id, { id: p.id, name: p.name, needs: 0, running: 0, queued: 0, prReady: 0 })
  for (const t of tasks) {
    const row = counts.get(t.projectId)
    if (!row) continue
    if (t.status === "needs_input") row.needs++
    else if (t.status === "working" || t.status === "starting") row.running++
    else if (t.status === "queued") row.queued++
    else if (t.status === "pr_ready") row.prReady++
  }
  let active = 0
  const rows: BarRow[] = []
  for (const row of counts.values()) {
    const busy = row.needs + row.running + row.queued
    active += busy
    if (busy || row.prReady || recent.has(row.id) || row.id === filter) rows.push(row)
  }
  return { rows, active }
}

/** "2 needs you · 3 running · 1 queued · 1 PR ready", leaving out the zeros. */
export function barCounts(row: BarRow): { key: string; n: number; label: string }[] {
  return [
    { key: "needs", n: row.needs, label: "needs you" },
    { key: "running", n: row.running, label: "running" },
    { key: "queued", n: row.queued, label: "queued" },
    { key: "pr", n: row.prReady, label: "PR ready" },
  ].filter((c) => c.n > 0)
}

// The project the Coordinator chat shows only, for this page's life: the drawer, the dock and Zen share it.
let filter: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setChatProjectFilter(projectId: string | null) {
  if (filter === projectId) return
  filter = projectId
  for (const l of listeners) l()
}

export const useChatProjectFilter = () => useSyncExternalStore(subscribe, () => filter, () => filter)
