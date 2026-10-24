import fs from "node:fs"
import path from "node:path"
import type { CompactionInfo, CompactionTaskSnapshot } from "../shared/types.js"

/** `2026-10-22T18-40-05Z`: ISO time without colons or millis, so names sort chronologically on every filesystem. */
export function compactionStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")
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
Decisions Cody made, their preferences and their standing instructions.

## Projects and repos
Each project with its repo (owner/name) and what it is for.

## Ongoing work
Tasks and PRs, their state, and what is waiting on whom (with ids and links).

## Open threads and next steps
Anything unresolved, promised or planned.

Only the most important things: no chit-chat, no transcript dumps, no step-by-step history.`

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
    `timestamp: ${new Date(m.at).toISOString().replace(/\.\d+Z$/, "Z")}`,
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
    timestamp: new Date(meta.at).toISOString().replace(/\.\d+Z$/, "Z"),
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

/** Log files, oldest first (the names sort chronologically). */
/** `<stamp>.md`, then `<stamp>-2.md`, `-3`…: plain string order puts `-2` before the first one and `-10` before `-2`. */
function compactionOrder(name: string): [string, number] {
  const m = /^(.*Z)(?:-(\d+))?\.md$/.exec(name)
  return m ? [m[1]!, Number(m[2] ?? 1)] : [name, 0]
}

export function listCompactions(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort((a, b) => {
        const [x, i] = compactionOrder(a)
        const [y, j] = compactionOrder(b)
        return x < y ? -1 : x > y ? 1 : i - j
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

export function readCompactionFile(file: string): string {
  return fs.readFileSync(file, "utf8")
}

/** The section of the orchestrator's system prompt that points at the log. */
export function compactionsPrompt(dir: string): string {
  const files = listCompactions(dir)
  const recent = files.slice(-5).reverse()
  return [
    ``,
    `Compaction history: whenever your context is compacted, Box Yard first saves a markdown summary of what mattered (Cody's decisions and preferences, projects and repos, ongoing work, open threads) as one file in ${dir}/`,
    `File names are UTC timestamps, so they are in chronological order (oldest first). When you need history you no longer have in context (earlier decisions, who asked for what, how a project started), Read these files, newest first, with the Read tool and their full path. Don't read them otherwise.`,
    files.length
      ? `There ${files.length === 1 ? "is 1 file" : `are ${files.length} files`}. The newest: ${recent.map((f) => `${dir}/${f}`).join(", ")}.`
      : `There are none yet.`,
  ].join("\n")
}
