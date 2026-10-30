import fs from "node:fs"
import path from "node:path"
import type { CompactionInfo, CompactionRecord, CompactionTaskSnapshot } from "../shared/types.js"
import { mentionedTaskIds } from "./compactionTasks.js"
import { withOwner } from "../shared/owner.js"

/**
 * `2026-10-22T18-40-05.123Z`: ISO time without colons, so it is a valid file name on every filesystem.
 * Files written before milliseconds were added are `2026-10-22T18-40-05Z`; listCompactions orders both by time.
 */
export function compactionStamp(at: number): string {
  return new Date(at).toISOString().replace(/:/g, "-")
}

export function compactionsDir(dataDir: string) {
  return path.join(dataDir, "orchestrator", "compactions")
}

export function captainCompactionsDir(dataDir: string, projectId: string) {
  return path.join(dataDir, "captains", projectId, "compactions")
}

/** What the orchestrator is asked to write before its context is compacted. */
export const SUMMARY_PROMPT = `[Box Yard] Your context is about to be compacted. Before that, write a durable record of what matters, as plain markdown.
It goes into a folder of files that is kept for months or years and may be read by other tools, so make it self-contained and don't rely on this conversation or on Claude-specific wording.
Reply with the markdown only (no preamble, no tool calls), with exactly these sections, leaving a section's body as "- none" when it is empty:

## Decisions and preferences
Decisions Cody made, their preferences and their standing instructions, each still in force.

## Projects and repos
Each project with its repo (owner/name) and what it is for.

## Ongoing work
Tasks and PRs, their state, and what is waiting on whom (with ids and links).

## Open threads and next steps
What is still open and someone will act on: unresolved, promised or planned. At most 10 bullets, one line each. Leave out threads that are done, stale or were never decided: search_history still finds them.

Only the most important things: no chit-chat, no transcript dumps, no step-by-step history.`

/** Each carried-forward section of the previous summary is cut to this many characters (open threads to fewer). */
const CARRY_MAX_CHARS = 6000
const CARRY_THREADS_MAX_CHARS = 2000

const isoSeconds = (at: number) => new Date(at).toISOString().replace(/\.\d+Z$/, "Z")

/** A section's body (without its heading) from a summary, or "" when it has none. */
export function summarySection(markdown: string, heading: string): string {
  const lines = markdown.split("\n")
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (start < 0) return ""
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim()
}

/** A log file's summary without its frontmatter and title. */
export function summaryBody(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^\s*# .*\n/, "")
    .trim()
}

const capped = (text: string, max = CARRY_MAX_CHARS) => (text.length > max ? `${text.slice(0, max).trimEnd()}\n- …(cut)` : text)

export interface SummaryInput {
  /** The last summary: its decisions and open threads are carried forward. */
  previous?: { at: number; markdown: string } | null
  /** Box Yard's view of the tasks in play right now, one line each (see liveTaskLines). */
  liveTasks?: string[]
}

/**
 * The summary prompt with what the summarizer can't see in its context: the previous summary's decisions
 * and open threads (compacted away with the rest), and the live state of the tasks it should mention, so a
 * decision isn't dropped because it is old and a finished task isn't recorded as still running.
 */
export function summaryPrompt(base: string, input: SummaryInput = {}): string {
  const parts = [base]
  const prev = input.previous
  const decisions = prev ? summarySection(prev.markdown, "Decisions and preferences") : ""
  const threads = prev ? summarySection(prev.markdown, "Open threads and next steps") : ""
  if (prev && (decisions || threads)) {
    parts.push(
      [
        `Your previous summary (${isoSeconds(prev.at)}) recorded these. Carry each decision forward into the same section unless it was replaced or withdrawn since. Carry a thread forward only while it is still open and someone will act on it: drop resolved, stale or undecided ones (search_history still finds them). Then add what's new.`,
        ``,
        `Decisions and preferences, previous summary:`,
        capped(decisions || "- none"),
        ``,
        `Open threads and next steps, previous summary:`,
        capped(threads || "- none", CARRY_THREADS_MAX_CHARS),
      ].join("\n"),
    )
  }
  if (input.liveTasks?.length) {
    parts.push(
      [
        `Live task state from Box Yard, right now. Write "Ongoing work" from it, and close threads whose task is done: a state here beats what you remember.`,
        ...input.liveTasks,
      ].join("\n"),
    )
  }
  return parts.join("\n\n")
}

/**
 * What /compact is told. Box Yard doesn't give its saved summary back after a /compact (afterCompactBlock adds only
 * live task states), so the CLI's own summary carries it: one copy of the summary in the new context, not two.
 */
const COMPACT_INSTRUCTIONS =
  `Your last reply is the summary Box Yard saved (from "## Decisions and preferences" on). It isn't shown again after this compaction, so carry it into your summary, condensed: ` +
  `the decisions and preferences in force, projects, ongoing work with ids and links, and open threads. Add what it leaves out: the latest exchanges and the work in progress right now, ` +
  `Cody's recent requests in their own words, and the exact ids, paths, commands and errors needed to carry on. Keep it short: Box Yard adds live task states after it.`

export const compactCommand = (ownerName?: string) => `/compact ${withOwner(COMPACT_INSTRUCTIONS, ownerName)}`

const savedAt = (markdown: string) => /^timestamp: (.*)$/m.exec(markdown.slice(0, 600))?.[1]?.trim()
const liveNow = (live: string[]) => (live.length ? [``, `Live now, tasks it names:`, ...live] : [])

/**
 * Box Yard's saved summary in full, for the first prompt of a new session (a lost session, or Codex's compaction,
 * which starts a new one). `live` lists the current state of the tasks it names.
 */
export function recapBlock(file: string, markdown: string, live: string[], lead = "Your context was just compacted. This is the summary you wrote right before it"): string {
  const at = savedAt(markdown)
  return [
    `[Box Yard: ${lead} (${at ? `${at}, ` : ""}saved as ${file}). Task states under "Live now" are current and beat the summary. For anything older, use search_history.]`,
    summaryBody(markdown),
    ...liveNow(live),
  ].join("\n")
}

/**
 * The first prompt after a /compact: the CLI's summary already carries the saved one (COMPACT_INSTRUCTIONS), so only
 * where it's saved and the current state of the tasks it names.
 */
export function afterCompactBlock(file: string, markdown: string, live: string[]): string {
  const at = savedAt(markdown)
  return [
    `[Box Yard: Your context was just compacted. The summary above carries the one you saved right before it (${at ? `${at}, ` : ""}${file}).${live.length ? ` Task states under "Live now" are current and beat both.` : ""} For anything older, use search_history.]`,
    ...liveNow(live),
  ].join("\n")
}

export interface CompactionMeta {
  at: number
  sessionId: string
  model: string
  trigger: "button" | "auto"
  tokensBefore: number | null
  /** Markdown heading for the summary; defaults to the orchestrator's. */
  heading?: string
}

export interface CompactionFiles {
  id: string
  markdownFile: string
  jsonFile: string
  markdown: string
}

const frontmatter = (m: CompactionMeta, after: number | null | "pending", tasks: CompactionTaskSnapshot[] = []) =>
  [
    "---",
    `timestamp: ${new Date(m.at).toISOString()}`,
    `session_id: ${m.sessionId}`,
    `model: ${m.model}`,
    `trigger: ${m.trigger}`,
    `tokens_before: ${m.tokensBefore ?? "unknown"}`,
    `tokens_after: ${after ?? "unknown"}`,
    `task_ids: ${tasks.map((t) => t.taskId).join(", ") || "none"}`,
    "---",
    "",
  ].join("\n")

/** Strip a code fence or preamble the model may have wrapped around the markdown. */
export function cleanSummary(text: string): string {
  let t = text.trim()
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(t)
  if (fenced) t = fenced[1]!.trim()
  const first = t.indexOf("## ")
  if (first > 0) t = t.slice(first)
  return t
}

/** A summary is usable when it has at least the decisions section and some body. */
export function summaryLooksValid(text: string): boolean {
  return text.length >= 60 && /^## Decisions and preferences/m.test(text)
}

const compactionIdFromMarkdown = (file: string) => path.basename(file, ".md")
const sidecar = (file: string) => file.replace(/\.md$/, ".json")

function sidecarPayload(meta: CompactionMeta, after: number | null | "pending", markdownFile: string, summary: string, tasks: CompactionTaskSnapshot[]) {
  return {
    id: compactionIdFromMarkdown(markdownFile),
    timestamp: new Date(meta.at).toISOString(),
    sessionId: meta.sessionId,
    model: meta.model,
    trigger: meta.trigger,
    tokensBefore: meta.tokensBefore,
    tokensAfter: after === "pending" ? null : after,
    markdownFile,
    tasks,
    summary,
  }
}

/** Write the log files (temp file + rename, so a crash never leaves half a file). */
export function writeCompaction(dir: string, meta: CompactionMeta, summary: string, tasks: CompactionTaskSnapshot[] = []): CompactionFiles {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = compactionStamp(meta.at)
  let file = path.join(dir, `${stamp}.md`)
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stamp}-${n}.md`)
  const jsonFile = sidecar(file)
  const markdown = `${frontmatter(meta, "pending", tasks)}# ${meta.heading ?? "Orchestrator compaction summary"}\n\n${summary.trim()}\n`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, markdown)
  fs.renameSync(tmp, file)
  const jsonTmp = `${jsonFile}.tmp`
  fs.writeFileSync(jsonTmp, JSON.stringify(sidecarPayload(meta, "pending", file, summary.trim(), tasks), null, 2) + "\n")
  fs.renameSync(jsonTmp, jsonFile)
  return { id: compactionIdFromMarkdown(file), markdownFile: file, jsonFile, markdown }
}

/** Fill in tokens_after once the compaction has run. */
export function finishCompaction(file: string, tokensAfter: number | null) {
  const text = fs.readFileSync(file, "utf8")
  const next = text.replace(/^tokens_after: .*$/m, `tokens_after: ${tokensAfter ?? "unknown"}`)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
  const jsonFile = sidecar(file)
  try {
    const data = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as Record<string, unknown>
    data.tokensAfter = tokensAfter
    fs.writeFileSync(`${jsonFile}.tmp`, JSON.stringify(data, null, 2) + "\n")
    fs.renameSync(`${jsonFile}.tmp`, jsonFile)
  } catch {
    // Old compactions may not have sidecars; the markdown frontmatter is still updated.
  }
}

/**
 * `<stamp>.md`, then `<stamp>-2.md`, `-3`… for the same stamp, ordered by time: plain string order puts `-2` before
 * the first one, `-10` before `-2`, and an old second-precision stamp after a new one from the same second.
 */
function compactionOrder(name: string): [number, number, string] {
  const m = /^(.*Z)(?:-(\d+))?\.md$/.exec(name)
  return m ? [compactionTime(m[1]!) ?? 0, Number(m[2] ?? 1), name] : [0, 0, name]
}

/** Log files, oldest first. */
export function listCompactions(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort((a, b) => {
        const [x, i, m] = compactionOrder(a)
        const [y, j, n] = compactionOrder(b)
        return x - y || i - j || (m < n ? -1 : m > n ? 1 : 0)
      })
  } catch {
    return []
  }
}

/** The last compaction, read back from its file's frontmatter. */
export function lastCompaction(dir: string): CompactionInfo | null {
  const name = listCompactions(dir).at(-1)
  if (!name) return null
  return readCompactionInfo(path.join(dir, name))
}

export function readCompactionInfo(file: string): CompactionInfo | null {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 600)
    const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(head)?.[1]?.trim()
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : null)
    return {
      at: Date.parse(get("timestamp") ?? "") || 0,
      trigger: get("trigger") === "auto" ? "auto" : "button",
      tokensBefore: num(get("tokens_before")),
      tokensAfter: num(get("tokens_after")),
      file,
    }
  } catch {
    return null
  }
}

/**
 * A compaction log file read back as a record: the sidecar's task snapshots when there
 * is one, and `taskIds` for every task it links (snapshotted, listed in the frontmatter
 * or named in the summary), so older files without snapshots are still found by task.
 */
export function readCompactionRecord(file: string): CompactionRecord | null {
  const info = readCompactionInfo(file)
  if (!info) return null
  let markdown: string
  try {
    markdown = readCompactionFile(file)
  } catch {
    return null
  }
  const jsonFile = sidecar(file)
  let side: { sessionId?: string; model?: string; tasks?: CompactionTaskSnapshot[] } = {}
  try {
    side = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as typeof side
  } catch {
    // Older compactions have no sidecar; the frontmatter has the rest.
  }
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1] ?? ""
  const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(fm)?.[1]?.trim()
  const tasks = Array.isArray(side.tasks) ? side.tasks : []
  const taskIds = new Set([...tasks.map((t) => t.taskId), ...mentionedTaskIds([markdown])])
  return {
    ...info,
    id: compactionIdFromMarkdown(file),
    sessionId: side.sessionId ?? get("session_id") ?? "",
    model: side.model ?? get("model") ?? "",
    jsonFile,
    taskCount: tasks.length,
    tasks,
    taskIds: [...taskIds],
    markdown,
  }
}

/** Every compaction in `dir`, newest first, optionally only those linked to `taskId` or older than `before` (ms). */
export function readCompactionRecords(dir: string, filter: { taskId?: string; limit?: number; before?: number } = {}): CompactionRecord[] {
  const out: CompactionRecord[] = []
  for (const name of listCompactions(dir).reverse()) {
    if (filter.limit !== undefined && out.length >= filter.limit) break
    const r = readCompactionRecord(path.join(dir, name))
    if (r && (!filter.taskId || r.taskIds.includes(filter.taskId)) && (filter.before === undefined || r.at < filter.before)) out.push(r)
  }
  return out
}

/**
 * A compaction id (2026-10-22T18-40-05.123Z, or 2026-10-22T18-40-05Z from before milliseconds, maybe with a -2
 * suffix) or an ISO time, as ms; null when it is neither.
 */
export function compactionTime(ref: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?Z/.exec(ref.trim())
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ?? ""}Z`) : Date.parse(ref.trim())
  return Number.isFinite(t) ? t : null
}

/** One compaction by id; only names actually in `dir` are read, so an id can't point outside it. */
export function findCompactionRecord(dir: string, id: string): CompactionRecord | null {
  const name = listCompactions(dir).find((n) => n === `${id}.md`)
  return name ? readCompactionRecord(path.join(dir, name)) : null
}

export function readCompactionFile(file: string): string {
  return fs.readFileSync(file, "utf8")
}

/** The section of the orchestrator's system prompt that points at the log. */
export function compactionsPrompt(dir: string): string {
  const files = listCompactions(dir)
  const recent = files.slice(-5).reverse()
  return [
    ``,
    `Compaction history: whenever your context is compacted, Box Yard first saves a markdown summary of what mattered (Cody's decisions and preferences, projects and repos, ongoing work, open threads) as one file in ${dir}/, and the summary the compaction leaves you carries it.`,
    `File names are UTC timestamps, so they are in chronological order (oldest first). When you need history you no longer have in context (earlier decisions, who asked for what, how a project started), call search_history with a few keywords first: it searches these summaries and the chat transcripts. Then open a hit with read_compaction, or Read the files, newest first, by their full path. Don't read them otherwise.`,
    files.length
      ? `There ${files.length === 1 ? "is 1 file" : `are ${files.length} files`}. The newest: ${recent.map((f) => `${dir}/${f}`).join(", ")}.`
      : `There are none yet.`,
  ].join("\n")
}
