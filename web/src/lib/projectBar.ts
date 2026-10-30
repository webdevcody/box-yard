// The Coordinator chat's project bar (components/ProjectBar.tsx): which projects it shows, what each chip counts,
// the project the chat is filtered to, and the projects Cody pinned to it or took off it (this browser remembers).
// The counts are pure, so they are unit tested.
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
 * Cody's own say over a project's chip: "pinned" stays on the bar even with nothing going on (picking a project in the
 * chat switcher pins it); "unpinned" stays off however busy it gets, until it's pinned again. A project with neither
 * shows while it's busy or talked about.
 */
export type PinState = "pinned" | "unpinned"
export type BarPins = Readonly<Record<string, PinState>>

/**
 * The bar's projects: the pinned ones, those with tasks asking, running, queued or with a PR open, the ones the chat
 * talked about lately (`recent`), and the one it's filtered to; never an unpinned one, unless it's the filter. In the
 * sidebar's order, so a chip never moves as counts change. `active` is the "All" chip's count: tasks asking, running
 * or queued, every project's. `hidden`: unpinned projects with a task asking Cody, which the bar sums up as
 * "+1 needs you" so a question is never out of sight.
 */
export function projectBarRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  recent: ReadonlySet<string>,
  filter: string | null,
  pins: BarPins = {},
): { rows: BarRow[]; active: number; hidden: BarRow[] } {
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
  const hidden: BarRow[] = []
  for (const row of counts.values()) {
    const busy = row.needs + row.running + row.queued
    active += busy
    const pin = pins[row.id]
    if (row.id === filter || pin === "pinned") rows.push(row)
    else if (pin === "unpinned") {
      if (row.needs) hidden.push(row)
    } else if (busy || row.prReady || recent.has(row.id)) rows.push(row)
  }
  return { rows, active, hidden }
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

export const chatProjectFilter = () => filter

export const useChatProjectFilter = () => useSyncExternalStore(subscribe, () => filter, () => filter)

// The pins, in this browser's localStorage and in sync across its tabs.
export const PINS_KEY = "box-yard:project-bar-pins"
const NO_PINS: BarPins = {}
const pinListeners = new Set<() => void>()
let pinsCache: { raw: string | null; pins: BarPins } = { raw: null, pins: NO_PINS }

export function readPins(): BarPins {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PINS_KEY)
  } catch {}
  if (raw === pinsCache.raw) return pinsCache.pins
  let pins: BarPins = NO_PINS
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      pins = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === "pinned" || v === "unpinned")) as BarPins
  } catch {}
  pinsCache = { raw, pins }
  return pins
}

function setPin(projectId: string, state: PinState) {
  const pins = readPins()
  if (pins[projectId] === state) return
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify({ ...pins, [projectId]: state }))
  } catch {}
  for (const l of pinListeners) l()
}

/** On the bar for good: the chat switcher's pick. */
export const pinProject = (projectId: string) => setPin(projectId, "pinned")

/** Off the bar, however busy it gets; the chat shows everything again if it was showing only this project. */
export function unpinProject(projectId: string) {
  if (filter === projectId) setChatProjectFilter(null)
  setPin(projectId, "unpinned")
}

/** Picked in the chat switcher: on the bar, and the chat shows only it. */
export function pickProject(projectId: string) {
  pinProject(projectId)
  setChatProjectFilter(projectId)
}

const subscribePins = (cb: () => void) => {
  pinListeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === PINS_KEY || e.key === null) cb()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    pinListeners.delete(cb)
    window.removeEventListener("storage", onStorage)
  }
}

export const useBarPins = () => useSyncExternalStore(subscribePins, readPins, () => NO_PINS)
