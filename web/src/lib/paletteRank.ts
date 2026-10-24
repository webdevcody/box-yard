// Ranking for the command palette (Cmd+K): prefixes, match tiers, field weights, boosts, groups and caps. Pure, so it is unit tested.
import type { TaskStatus } from "../../../shared/types"
import type { PaletteItem, PaletteKind } from "./palette"

// ------------------------------------------------------------------ prefixes

/** What a prefix narrows the search to. */
export type PaletteScope = "command" | "pr" | "file" | "project" | "box"

export const PREFIXES: { prefix: string; scope: PaletteScope; label: string }[] = [
  { prefix: ">", scope: "command", label: "Commands" },
  { prefix: "#", scope: "pr", label: "PRs" },
  { prefix: "f:", scope: "file", label: "Files" },
  { prefix: "p:", scope: "project", label: "Projects" },
  { prefix: "@", scope: "box", label: "Boxes" },
]

const SCOPE_KINDS: Record<PaletteScope, PaletteKind[]> = {
  command: ["action", "page"],
  pr: ["pr"],
  file: ["artifact"],
  project: ["project"],
  box: ["box"],
}

export interface ParsedQuery {
  scope: PaletteScope | null
  /** Lowercase, trimmed, single-spaced. */
  query: string
}

export const normalizeQuery = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")

/** Splits a leading prefix (`>`, `#`, `f:`, `p:`, `@`) off the raw input. */
export function parseQuery(raw: string): ParsedQuery & { rest: string } {
  const trimmed = raw.trimStart()
  for (const p of PREFIXES) {
    if (trimmed.slice(0, p.prefix.length).toLowerCase() === p.prefix) {
      const rest = trimmed.slice(p.prefix.length).trimStart()
      return { scope: p.scope, query: normalizeQuery(rest), rest }
    }
  }
  return { scope: null, query: normalizeQuery(raw), rest: raw }
}

// ------------------------------------------------------------------ matching

export type MatchTier = "exact" | "prefix" | "word" | "substring" | "fuzzy"

/** Each tier has its own band, so no length or position penalty can drop a match into the tier below. */
const TIER_BASE: Record<MatchTier, number> = { exact: 1000, prefix: 800, word: 600, substring: 400, fuzzy: 200 }
const BAND = 40

const BOUNDARY = /[\s\-_/.:#()[\]]/

/** Which tier `q` (lowercase, non-empty) hits in `text`, with a 0..1 penalty inside the tier. */
export function matchText(text: string, q: string, allowFuzzy = true): { tier: MatchTier; penalty: number } | null {
  const t = text.toLowerCase()
  if (!t || !q) return null
  if (t === q) return { tier: "exact", penalty: 0 }
  if (t.startsWith(q)) return { tier: "prefix", penalty: Math.min(1, (t.length - q.length) / 40) }
  const idx = t.indexOf(q)
  if (idx >= 0) {
    // Any occurrence at a word start beats a mid-word one.
    for (let i = idx; i > 0; i = t.indexOf(q, i + 1)) if (BOUNDARY.test(t[i - 1]!)) return { tier: "word", penalty: Math.min(1, i / 80) }
    return { tier: "substring", penalty: Math.min(1, idx / 80) }
  }
  if (!allowFuzzy) return null
  const f = fuzzy(t, q)
  return f === null ? null : { tier: "fuzzy", penalty: f }
}

/** Subsequence match ("cmdpal" → "command palette") starting at a word; rewards runs and word starts, rejects scattered hits. */
function fuzzy(t: string, q: string): number | null {
  if (q.length < 2) return null
  let from = 0
  while (from < t.length && (t[from] !== q[0] || (from > 0 && !BOUNDARY.test(t[from - 1]!)))) from++
  if (from >= t.length) return null
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
  const quality = bonus / (q.length * 5) - (span - q.length) / (q.length * 3) - Math.min(1, first / 40) / 2
  return Math.min(1, Math.max(0, 1 - quality))
}

/** Score of `q` in `text`, or null: exact > prefix > word start > substring > fuzzy subsequence. */
export function scoreText(text: string, q: string, allowFuzzy = true): number | null {
  const m = matchText(text, q, allowFuzzy)
  return m && TIER_BASE[m.tier] + BAND * (1 - m.penalty)
}

/** A title (or a file name, or a PR number) counts in full; ids and repos less; project names and summaries least. */
export const FIELD_WEIGHT = { title: 1, alias: 0.75, detail: 0.5 } as const

/** How well an item's own text matches a lowercase, normalized query, before boosts. */
export function matchItem(item: PaletteItem, q: string): number | null {
  const fields: [string, number, boolean][] = [
    [item.title, FIELD_WEIGHT.title, true],
    ...(item.names ?? []).map((t): [string, number, boolean] => [t, FIELD_WEIGHT.title, true]),
    ...(item.aliases ?? []).map((t): [string, number, boolean] => [t, FIELD_WEIGHT.alias, true]),
    // Summaries are long: a scattered subsequence in one means nothing.
    ...(item.details ?? []).map((t): [string, number, boolean] => [t, FIELD_WEIGHT.detail, false]),
  ]
  let best: number | null = null
  for (const [text, weight, allowFuzzy] of fields) {
    const s = scoreText(text, q, allowFuzzy)
    if (s !== null && (best === null || s * weight > best)) best = s * weight
  }
  if (best !== null) return best
  // "box-yard failed": every word has to hit some field, keywords included.
  const words = q.split(" ")
  if (words.length < 2) return null
  const wordFields = [...fields, ...(item.keywords ?? []).map((t): [string, number, boolean] => [t, FIELD_WEIGHT.detail, false])]
  let total = 0
  for (const w of words) {
    let wordBest: number | null = null
    for (const [text, weight, allowFuzzy] of wordFields) {
      const s = scoreText(text, w, allowFuzzy)
      if (s !== null && (wordBest === null || s * weight > wordBest)) wordBest = s * weight
    }
    if (wordBest === null) return null
    total += wordBest
  }
  return (total / words.length) * 0.7
}

// ------------------------------------------------------------------ files

/** Extensions that make a query clearly about a file. */
export const FILE_EXTENSIONS = new Set(
  "png jpg jpeg gif svg webp avif ico bmp html htm md markdown csv tsv json jsonl yaml yml xml webm mp4 mov m4v mp3 wav ogg txt log pdf zip tar gz ts tsx js jsx css py sh sql".split(" "),
)

const SAME_EXT: Record<string, string> = { jpeg: "jpg", htm: "html", markdown: "md", yml: "yaml" }
const canonicalExt = (ext: string) => SAME_EXT[ext] ?? ext
const extOf = (name: string) => /\.([a-z0-9]+)$/.exec(name.toLowerCase())?.[1] ?? null

/** The known file extension a query names, e.g. ".png" or "logo.png" → "png". */
export function queryExtension(q: string): string | null {
  const m = /(?:^|\S)\.([a-z0-9]{1,8})$/.exec(q.trim().toLowerCase())
  return m && FILE_EXTENSIONS.has(m[1]!) ? m[1]! : null
}

const fileNames = (item: PaletteItem) => item.names ?? []
const stem = (name: string) => name.toLowerCase().replace(/\.[a-z0-9]+$/, "")

/** True when the query names a file extension or (nearly) a file's whole name, so files should go first. */
export function targetsFile(q: string, items: PaletteItem[]): boolean {
  if (!q) return false
  if (queryExtension(q)) return true
  if (q.length < 3) return false
  return items.some(
    (i) =>
      i.kind === "artifact" &&
      fileNames(i).some((n) => {
        const name = n.toLowerCase()
        const s = stem(name)
        return name === q || s === q || (name.startsWith(q) && q.length >= Math.max(4, s.length * 0.8))
      }),
  )
}

/** A bare ".png" lists every PNG; the extension is part of the name, but not at a word start. */
function extensionOnlyScore(item: PaletteItem, q: string): number | null {
  if (item.kind !== "artifact" || !/^\.[a-z0-9]+$/.test(q)) return null
  const want = canonicalExt(q.slice(1))
  return fileNames(item).some((n) => canonicalExt(extOf(n) ?? "") === want) ? TIER_BASE.word + BAND : null
}

// ------------------------------------------------------------------ boosts

/** Tasks win ties against everything else, files included. */
export const KIND_BOOST: Record<PaletteKind, number> = { task: 60, pr: 60, project: 30, page: 20, schedule: 10, action: 0, box: 0, artifact: 0 }
/** Enough to lift any file match over any task match. */
export const FILE_INTENT_BOOST = 600
const ACTIVE_BOOST: Partial<Record<TaskStatus, number>> = { needs_input: 20, pr_ready: 20, working: 12, starting: 12, queued: 8, waiting: 8, failed: 6 }
const RECENCY_BOOST = 20
const DAY = 86_400_000

/** Up to +20, halving every day since the task last changed. */
export const recencyBoost = (at: number | undefined, now: number) => (at ? RECENCY_BOOST * 0.5 ** (Math.max(0, now - at) / DAY) : 0)

export interface RankContext {
  now: number
  /** Command key → times it was run from the palette. */
  usage?: Record<string, number>
  fileIntent?: boolean
}

/** An item's full score for a query: match quality × field weight, plus kind, recency, status and usage boosts. */
export function scoreItem(item: PaletteItem, q: string, ctx: RankContext): number | null {
  const match = extensionOnlyScore(item, q) ?? matchItem(item, q)
  if (match === null) return null
  let score = match + KIND_BOOST[item.kind]
  if (item.kind === "task" || item.kind === "pr") {
    score += recencyBoost(item.at, ctx.now) + (item.taskStatus ? (ACTIVE_BOOST[item.taskStatus] ?? 0) : 0)
  }
  if (isCommand(item)) score += Math.min(20, 2 * (ctx.usage?.[item.key] ?? 0))
  if (item.kind === "artifact" && ctx.fileIntent) score += FILE_INTENT_BOOST
  return score
}

// ------------------------------------------------------------------ groups

export type GroupKey = "waiting" | "working" | "recent" | "command" | "task" | "pr" | "project" | "schedule" | "artifact" | "box"

export interface PaletteGroup {
  key: GroupKey
  label: string
  /** The rows to show: capped, unless the group is expanded. */
  items: PaletteItem[]
  /** Every match, so the "Show all N" row can say how many. */
  total: number
}

export const GROUP_LABEL: Record<GroupKey, string> = {
  // Box Yard's own label: the palette passes it through withOwner.
  waiting: "Waiting on Cody",
  working: "Working",
  recent: "Recently viewed",
  command: "Commands",
  task: "Tasks",
  pr: "Pull requests",
  project: "Projects",
  schedule: "Schedules",
  artifact: "Files",
  box: "Boxes",
}

/** Rows a group shows before "Show all N". */
export const GROUP_CAP: Record<GroupKey, number> = { waiting: 5, working: 5, recent: 5, command: 4, task: 5, pr: 5, project: 3, schedule: 3, artifact: 3, box: 3 }
/** With a prefix there is one group, so it gets more room. */
export const SCOPED_CAP = 20

/** Where groups go when their best scores tie. */
const GROUP_ORDER: GroupKey[] = ["task", "pr", "project", "command", "schedule", "artifact", "box"]

const isCommand = (i: PaletteItem) => i.kind === "action" || i.kind === "page"
const groupOf = (i: PaletteItem): GroupKey => (isCommand(i) ? "command" : (i.kind as GroupKey))

/** Deterministic order for equal scores: newest first, then by key, so lists don't shuffle as you type. */
export const tieBreak = (a: PaletteItem, b: PaletteItem) => (b.at ?? 0) - (a.at ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export interface RankOptions {
  now?: number
  /** Item keys, most recent first (recently viewed in this browser). */
  recent?: string[]
  /** Command key → times run. */
  usage?: Record<string, number>
  /** Groups showing all their rows. */
  expanded?: ReadonlySet<GroupKey>
}

function group(key: GroupKey, all: PaletteItem[], opts: RankOptions, cap = GROUP_CAP[key]): PaletteGroup {
  return { key, label: GROUP_LABEL[key], items: opts.expanded?.has(key) ? all : all.slice(0, cap), total: all.length }
}

/** The palette's groups for a parsed query, best first. */
export function rankPalette(items: PaletteItem[], { scope, query }: ParsedQuery, opts: RankOptions = {}): PaletteGroup[] {
  const now = opts.now ?? Date.now()
  const pool = scope ? items.filter((i) => SCOPE_KINDS[scope].includes(i.kind)) : items.filter((i) => i.kind !== "pr")
  // "#78" inside the PR scope means PR 78.
  const q = scope === "pr" ? query.replace(/^#/, "") : query

  if (!q) return scope ? [group(scopeGroup(scope), browseOrder(pool, scope, opts), opts, SCOPED_CAP)] : emptyQueryGroups(items, opts)

  const ctx: RankContext = { now, usage: opts.usage, fileIntent: !scope && targetsFile(q, pool) }
  const scored: { item: PaletteItem; score: number }[] = []
  for (const item of pool) {
    const score = scoreItem(item, q, ctx)
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || tieBreak(a.item, b.item))

  const groups = new Map<GroupKey, { items: PaletteItem[]; best: number }>()
  for (const { item, score } of scored) {
    const key = groupOf(item)
    const g = groups.get(key)
    if (g) g.items.push(item)
    else groups.set(key, { items: [item], best: score })
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.best - a.best || GROUP_ORDER.indexOf(ka) - GROUP_ORDER.indexOf(kb))
    .map(([key, g]) => group(key, g.items, opts, scope ? SCOPED_CAP : undefined))
}

const scopeGroup = (scope: PaletteScope): GroupKey => (scope === "file" ? "artifact" : scope)

/** A prefix with nothing after it: the most-used commands, open PRs first, newest files and boxes, projects in the owner's order. */
function browseOrder(pool: PaletteItem[], scope: PaletteScope, opts: RankOptions): PaletteItem[] {
  if (scope === "command") return commandsByUse(pool, opts.usage)
  // Projects arrive in the saved sidebar order (buildItems keeps the list's order).
  if (scope === "project") return pool
  const open = (i: PaletteItem) => (scope === "pr" && (i.status === "merged" || i.status === "done") ? 1 : 0)
  return [...pool].sort((a, b) => open(a) - open(b) || tieBreak(a, b))
}

/** Most-used first; unused ones keep their built-in order. */
function commandsByUse(items: PaletteItem[], usage: Record<string, number> = {}): PaletteItem[] {
  const order = new Map(items.map((i, n) => [i.key, n]))
  return items.filter(isCommand).sort((a, b) => (usage[b.key] ?? 0) - (usage[a.key] ?? 0) || order.get(a.key)! - order.get(b.key)!)
}

const WAITING: TaskStatus[] = ["needs_input", "pr_ready"]
const WORKING: TaskStatus[] = ["working", "starting"]

/** No query: tasks waiting on the owner, working tasks, recently viewed tasks and projects, then the most-used commands. No files. */
function emptyQueryGroups(items: PaletteItem[], opts: RankOptions): PaletteGroup[] {
  const tasks = items.filter((i) => i.kind === "task")
  const byStatus = (statuses: TaskStatus[]) => tasks.filter((i) => i.taskStatus && statuses.includes(i.taskStatus)).sort(tieBreak)
  const waiting = byStatus(WAITING)
  const working = byStatus(WORKING)
  const shown = new Set([...waiting, ...working].map((i) => i.key))
  const byKey = new Map(items.map((i) => [i.key, i]))
  const recent = (opts.recent ?? [])
    .map((k) => byKey.get(k))
    .filter((i): i is PaletteItem => Boolean(i) && (i!.kind === "task" || i!.kind === "project") && !shown.has(i!.key))

  const groups: PaletteGroup[] = []
  if (waiting.length) groups.push(group("waiting", waiting, opts))
  if (working.length) groups.push(group("working", working, opts))
  if (recent.length) groups.push(group("recent", recent, opts))
  groups.push(group("command", commandsByUse(items, opts.usage), opts, 5))
  return groups
}

// ------------------------------------------------------------------ rows

/** One keyboard stop in the list: an item, or a group's "Show all N →". */
export type PaletteRow = { type: "item"; item: PaletteItem; group: GroupKey } | { type: "more"; group: GroupKey; total: number }

/** The flat, keyboard-ordered rows for the groups: each capped group ends in its "Show all" row. */
export function paletteRows(groups: PaletteGroup[]): PaletteRow[] {
  const rows: PaletteRow[] = []
  for (const g of groups) {
    for (const item of g.items) rows.push({ type: "item", item, group: g.key })
    if (g.items.length < g.total) rows.push({ type: "more", group: g.key, total: g.total })
  }
  return rows
}

/** Command key → count, with one more use of `key`. */
export function bumpUsage(usage: Record<string, number>, key: string): Record<string, number> {
  return { ...usage, [key]: (usage[key] ?? 0) + 1 }
}
