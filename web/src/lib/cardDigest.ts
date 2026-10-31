// A task card's event digest (components/CoordinatorCards.tsx): its hook, merge, "done", PR and Captain "reports"
// lines, two or more in a row, fold into one quiet line ("Auto-merged as ff8fc23 · 3 events") that opens to them, so
// what the agent or Captain said reads first. Replies, questions, failures and Cody's own messages stay whole. Pure,
// so it is unit tested.
import type { ChatMessage } from "../../../shared/types"
import type { CardEntry } from "./chatCards"
import { chipView, isSent, itemMessages } from "./chatUpdates"
import { publishedLabel } from "./publishedNotices"
import { shortSha } from "./linkify"

/** One thing a task card shows: an entry as it is, or a run of events folded into a digest (its id is the first's). */
export type DigestPiece = { type: "entry"; entry: CardEntry } | { type: "digest"; id: string; entries: CardEntry[] }

/** Notice kinds that stay whole even as a message: a question or a failure is for Cody to act on. */
const WHOLE = new Set(["needs_input", "failed"])

/**
 * An event: an update that doesn't answer Cody (`answers`, the turn ends a card shows as the agent's reply), or a
 * notice shown whole today that's only news (a merge request, a hook's). Not a reply, an agent's own words ("says",
 * "finished its turn"), a question, a failure or Cody's own message. A Captain's report is an event.
 */
export function isEvent(e: CardEntry, answers: ReadonlySet<string>): boolean {
  if (e.type === "update") {
    if (answers.has(e.id)) return false
    if (e.item.type === "files") return true
    const v = chipView(e.item.message)
    return v.captain || v.kind !== "message"
  }
  const m = e.message
  return m.role === "notice" && !isSent(m) && !WHOLE.has(chipView(m).kind)
}

/** `entries` with every run of two or more events folded into a digest. */
export function digestEntries(entries: readonly CardEntry[], answers: ReadonlySet<string>): DigestPiece[] {
  const out: DigestPiece[] = []
  let run: CardEntry[] = []
  const flush = () => {
    if (run.length === 1) out.push({ type: "entry", entry: run[0]! })
    else if (run.length > 1) out.push({ type: "digest", id: run[0]!.id, entries: run })
    run = []
  }
  for (const e of entries) {
    if (isEvent(e, answers)) {
      run.push(e)
      continue
    }
    flush()
    out.push({ type: "entry", entry: e })
  }
  flush()
  return out
}

/** The messages behind an entry. */
const messagesOf = (e: CardEntry): ChatMessage[] => (e.type === "message" ? [e.message] : itemMessages(e.item))

// "merged … as squash commit ff8fc23…", "Merged into main as ff8fc23": the commit a merge made. A SHA has a digit and a letter.
const MERGED_AS = /\bmerged\b[^\n]*?(?<![\w-])((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64})(?![\w-])/i
const AUTO = /auto-?merge/i

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** One event's line: "Done: PR #221 is merged", "box-yard Captain reports: …", "Published 2 files: …". */
export function eventLine(e: CardEntry): string {
  if (e.type === "update" && e.item.type === "files") {
    const files = e.item.group.files
    return `${capitalise(publishedLabel(files.length))}: ${files.map((f) => f.title).join(", ")}`
  }
  const v = chipView(messagesOf(e)[0]!)
  const who = v.captain ? `${v.source?.label ?? "Captain"} ${v.verb}` : capitalise(v.verb)
  return [who, v.preview].filter(Boolean).join(": ")
}

/**
 * What a digest says in its one line: the commit a merge made ("Merged as ff8fc23", "Auto-merged as …" when a hook
 * or auto-merge asked for it), else its newest event's line.
 */
export function digestSummary(entries: readonly CardEntry[]): string {
  const texts = entries.flatMap(messagesOf).map((m) => m.content)
  for (let i = texts.length - 1; i >= 0; i--) {
    const sha = MERGED_AS.exec(texts[i]!)?.[1]
    if (!sha) continue
    const auto = texts.some((t) => AUTO.test(t)) || entries.some((e) => e.type === "update" && e.item.type === "notice" && chipView(e.item.message).kind === "hook")
    return `${auto ? "Auto-merged" : "Merged"} as ${shortSha(sha)}`
  }
  const last = entries[entries.length - 1]
  return last ? eventLine(last) : ""
}

/** The digest piece holding entry `id`, if it's folded into one. */
export const digestOf = (pieces: readonly DigestPiece[], id: string) =>
  pieces.find((p): p is Extract<DigestPiece, { type: "digest" }> => p.type === "digest" && p.entries.some((e) => e.id === id)) ?? null
