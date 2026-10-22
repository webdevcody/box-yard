// Items, matching and ranking for the command palette (Cmd+K). Pure, so it is unit tested.
import { describeCron } from "../../../shared/cron"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"

export type PaletteKind = "action" | "page" | "task" | "project" | "schedule" | "artifact" | "box"

/** Dialogs the palette opens itself instead of navigating. */
export type PaletteCommand = "settings" | "new-project"

export interface PaletteItem {
  /** Unique across kinds: `<kind>:<id>`. */
  key: string
  kind: PaletteKind
  title: string
  subtitle?: string
  /** Matched like the title, ranked a little lower (ids, repos). */
  aliases?: string[]
  /** Matched only by multi-word queries, e.g. "box-yard failed" (project name, status). */
  keywords?: string[]
  /** In-app route to open. */
  href?: string
  /** Absolute URL to open in a new tab (artifact files). */
  url?: string
  command?: PaletteCommand
  status?: TaskStatus
  /** Last activity, for recency tie-breaks and the empty-query list. */
  at?: number
}

export interface PaletteGroup {
  kind: PaletteKind | "recent"
  label: string
  items: PaletteItem[]
}

export const GROUP_LABEL: Record<PaletteKind | "recent", string> = {
  recent: "Recent",
  action: "Actions",
  page: "Pages",
  task: "Tasks",
  project: "Projects",
  schedule: "Schedules",
  artifact: "Files",
  box: "Boxes",
}

/** Default group order; with a query, groups are ordered by their best match instead. */
const KIND_ORDER: PaletteKind[] = ["task", "project", "page", "schedule", "artifact", "box", "action"]

const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: "queued",
  starting: "starting",
  working: "working",
  needs_input: "needs you input question",
  waiting: "waiting",
  idle: "idle",
  pr_ready: "pr ready review",
  done: "done",
  failed: "failed error",
}

export interface PaletteData {
  tasks?: Task[]
  projects?: Project[]
  schedules?: Schedule[]
  artifacts?: Artifact[]
  boxes?: BoxInfo[]
}

export const PAGES: PaletteItem[] = [
  { key: "page:yard", kind: "page", title: "Yard", subtitle: "Every task, grouped by status", href: "/", aliases: ["home"] },
  { key: "page:inbox", kind: "page", title: "Inbox", subtitle: "Questions, PRs to review, failures", href: "/inbox" },
  { key: "page:boxes", kind: "page", title: "Boxes", subtitle: "The box pool and what runs where", href: "/boxes" },
  { key: "page:schedules", kind: "page", title: "Schedules", subtitle: "Recurring jobs", href: "/schedules", aliases: ["cron"] },
  { key: "page:settings", kind: "page", title: "Settings", subtitle: "Models, effort, compaction, pool limits", command: "settings", aliases: ["preferences"] },
]

/** Everything the palette can find, built from data the app already has in its query cache. */
export function buildItems(data: PaletteData): PaletteItem[] {
  const projects = data.projects ?? []
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const items: PaletteItem[] = [...PAGES]

  for (const t of data.tasks ?? []) {
    const project = projectName.get(t.projectId)
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      title: t.title,
      subtitle: project,
      aliases: [t.id],
      keywords: [project ?? "", STATUS_WORDS[t.status]],
      href: `/tasks/${t.id}`,
      status: t.status,
      at: t.updatedAt,
    })
  }

  for (const p of projects) {
    items.push({
      key: `project:${p.id}`,
      kind: "project",
      title: p.name,
      subtitle: p.repo ?? p.description,
      aliases: [p.id, ...(p.repo ? [p.repo, p.repo.split("/").pop()!] : [])],
      keywords: [p.description],
      href: `/projects/${p.id}`,
      at: p.updatedAt,
    })
  }

  for (const s of data.schedules ?? []) {
    const target = s.target === "orchestrator" ? "Orchestrator" : (projectName.get(s.projectId ?? "") ?? "Project")
    items.push({
      key: `schedule:${s.id}`,
      kind: "schedule",
      title: s.name,
      subtitle: `${target} · ${describeCron(s.cron)}${s.enabled ? "" : " · paused"}`,
      aliases: [s.id],
      keywords: [target],
      href: s.target === "project" && s.projectId ? `/projects/${s.projectId}?tab=schedules#${s.id}` : `/schedules#${s.id}`,
      at: s.lastRunAt ?? s.updatedAt,
    })
  }

  for (const a of data.artifacts ?? []) {
    items.push({
      key: `artifact:${a.id}`,
      kind: "artifact",
      title: a.title,
      subtitle: [a.projectId ? projectName.get(a.projectId) : null, a.filename].filter(Boolean).join(" · "),
      aliases: [a.filename],
      url: a.url,
      at: a.createdAt,
    })
  }

  for (const b of data.boxes ?? []) {
    items.push({
      key: `box:${b.id}`,
      kind: "box",
      title: b.id,
      subtitle: `${b.status} · ${b.runningTurns}/${b.slots} running${b.projects.length ? ` · ${b.projects.join(", ")}` : ""}`,
      keywords: b.projects,
      href: `/boxes#${b.id}`,
      at: b.lastUsedAt,
    })
  }

  items.push(...buildActions(projects))
  return items
}

export function buildActions(projects: Project[]): PaletteItem[] {
  return [
    ...projects.map<PaletteItem>((p) => ({
      key: `action:new-task:${p.id}`,
      kind: "action",
      title: `New task in ${p.name}…`,
      href: `/projects/${p.id}?new=task`,
    })),
    { key: "action:new-schedule", kind: "action", title: "New schedule…", href: "/schedules?new=schedule" },
    { key: "action:new-project", kind: "action", title: "New project…", command: "new-project" },
    { key: "action:settings", kind: "action", title: "Open settings", command: "settings" },
  ]
}

// ------------------------------------------------------------------ matching

const BOUNDARY = /[\s\-_/.:#()[\]]/

/**
 * How well `q` (lowercase, non-empty) matches `text`, or null for no match.
 * Exact > prefix > word prefix > substring > fuzzy subsequence.
 */
export function scoreText(text: string, q: string): number | null {
  const t = text.toLowerCase()
  if (!t) return null
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - Math.min(50, t.length - q.length) / 10
  const idx = t.indexOf(q)
  if (idx < 0) return fuzzy(t, q)
  // Any occurrence at a word start beats a mid-word one.
  for (let i = idx; i > 0; i = t.indexOf(q, i + 1)) if (BOUNDARY.test(t[i - 1]!)) return 800 - Math.min(100, i) / 10
  return 600 - Math.min(100, idx) / 10
}

/** Subsequence match ("cmdpal" → "command palette"); rewards runs and word starts, rejects scattered hits. */
function fuzzy(t: string, q: string): number | null {
  if (q.length < 2) return null
  let from = 0
  let prev = -2
  let first = -1
  let bonus = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return null
    if (first < 0) first = i
    if (i === prev + 1) bonus += 2
    if (i === 0 || BOUNDARY.test(t[i - 1]!)) bonus += 3
    prev = i
    from = i + 1
  }
  const span = prev - first + 1
  if (span > q.length * 3 + 3) return null
  return 200 + Math.min(250, bonus * 10) - (span - q.length) * 3 - Math.min(50, first)
}

/** Best score of an item for a lowercase, trimmed query. */
export function scoreItem(item: PaletteItem, q: string): number | null {
  let best = scoreText(item.title, q)
  for (const alias of item.aliases ?? []) {
    const s = scoreText(alias, q)
    if (s !== null && (best === null || s - 50 > best)) best = s - 50
  }
  if (best !== null) return best
  // "box-yard failed": every word has to hit the title, an alias or a keyword.
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const fields = [item.title, ...(item.aliases ?? []), ...(item.keywords ?? []), item.subtitle ?? ""]
  let total = 0
  for (const w of words) {
    let wordBest: number | null = null
    for (const f of fields) {
      const s = scoreText(f, w)
      if (s !== null && (wordBest === null || s > wordBest)) wordBest = s
    }
    if (wordBest === null) return null
    total += wordBest
  }
  return Math.min(500, (total / words.length) * 0.5)
}

// ------------------------------------------------------------------ search

export interface SearchOptions {
  /** Item keys, most recent first (recently viewed in this browser). */
  recent?: string[]
  /** Max items per group. */
  limit?: number
}

/** `>` prefix restricts results to actions, VS Code style. */
export function parseQuery(raw: string): { query: string; actionsOnly: boolean } {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith(">")) return { query: trimmed.slice(1).trim().toLowerCase(), actionsOnly: true }
  return { query: raw.trim().toLowerCase(), actionsOnly: false }
}

const ACTIVE_STATUSES: TaskStatus[] = ["needs_input", "working", "starting", "waiting", "queued", "failed", "pr_ready", "idle"]

export function searchPalette(items: PaletteItem[], raw: string, opts: SearchOptions = {}): PaletteGroup[] {
  const limit = opts.limit ?? 6
  const { query, actionsOnly } = parseQuery(raw)
  const pool = actionsOnly ? items.filter((i) => i.kind === "action") : items

  if (!query) {
    if (actionsOnly) return [{ kind: "action", label: GROUP_LABEL.action, items: pool }]
    return emptyQueryGroups(items, opts.recent ?? [], limit)
  }

  const scored: { item: PaletteItem; score: number }[] = []
  for (const item of pool) {
    const score = scoreItem(item, query)
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.item.at ?? 0) - (a.item.at ?? 0) || a.item.title.length - b.item.title.length)

  const groups = new Map<PaletteKind, { items: PaletteItem[]; best: number }>()
  for (const { item, score } of scored) {
    const g = groups.get(item.kind) ?? { items: [], best: score }
    if (!groups.has(item.kind)) groups.set(item.kind, g)
    if (g.items.length < (actionsOnly ? 50 : limit)) g.items.push(item)
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.best - a.best || KIND_ORDER.indexOf(ka) - KIND_ORDER.indexOf(kb))
    .map(([kind, g]) => ({ kind, label: GROUP_LABEL[kind], items: g.items }))
}

/** No query: recently viewed, then recently active open tasks, then the pages. */
function emptyQueryGroups(items: PaletteItem[], recent: string[], limit: number): PaletteGroup[] {
  const byKey = new Map(items.map((i) => [i.key, i]))
  const recentItems = recent
    .map((k) => byKey.get(k))
    .filter((i): i is PaletteItem => Boolean(i) && i!.kind !== "page" && i!.kind !== "action")
    .slice(0, limit)
  const seen = new Set(recentItems.map((i) => i.key))
  const active = items
    .filter((i) => i.kind === "task" && !seen.has(i.key) && i.status && ACTIVE_STATUSES.includes(i.status))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, limit)
  const groups: PaletteGroup[] = []
  if (recentItems.length) groups.push({ kind: "recent", label: "Recently viewed", items: recentItems })
  if (active.length) groups.push({ kind: "task", label: "Recently active", items: active })
  groups.push({ kind: "page", label: GROUP_LABEL.page, items: items.filter((i) => i.kind === "page") })
  return groups
}

/** Item key for a route the user viewed, if it is one the palette remembers. */
export function recentKeyFor(path: string): string | null {
  const m = /^\/(tasks|projects)\/([^/?#]+)/.exec(path)
  if (!m) return null
  return `${m[1] === "tasks" ? "task" : "project"}:${decodeURIComponent(m[2]!)}`
}

/** Moves `key` to the front of the recent list, keeping it short. */
export function pushRecent(list: string[], key: string, max = 20): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max)
}
