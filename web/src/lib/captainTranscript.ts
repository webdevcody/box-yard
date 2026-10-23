// The project Captain's transcript as chat rows: task notices become slim one-line rows,
// and runs of consecutive notices collapse into one expandable "N task updates" group.
import type { CaptainMessage } from "../../../shared/types"

export type NoticeKind = "done" | "failed" | "needs_input" | "pr" | "artifact" | "message" | "warning" | "compaction" | "info"

/** A piece of a notice's one-line summary: plain text, or a link (artifact, PR, page). */
export type NoticeSegment = { text: string } | { href: string; label: string }

export interface ParsedNotice {
  kind: NoticeKind
  /** The task's title as the notice wrote it (the bold part), if any. */
  title: string | null
  summary: NoticeSegment[]
}

// The leading emoji server/tasks.ts puts on each notice.
const EMOJI_KIND: Record<string, NoticeKind> = {
  "✅": "done",
  "❌": "failed",
  "🙋": "needs_input",
  "🔀": "pr",
  "📎": "artifact",
  "💬": "message",
  "⚠": "warning",
}

const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic})️?\s*/u
const URL_RE = /(https?:\/\/[^\s<>()]+|\/artifacts\/[^\s<>()]+)/g

/** Markdown to one line of plain text: no emphasis markers, link text instead of link syntax. */
export function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** "PR #16" for a GitHub pull request URL, the file name for a file, else the URL without its scheme. */
export function linkLabel(href: string): string {
  const pr = href.match(/\/pull\/(\d+)/)
  if (pr) return `PR #${pr[1]}`
  const path = href.replace(/^https?:\/\/[^/]+/, "")
  if (path.startsWith("/artifacts/") || path.startsWith("/api/uploads/")) return decodeURIComponent(path.split("/").pop() || path)
  return href.replace(/^https?:\/\//, "")
}

/** Split plain text into text and link segments, dropping punctuation stuck to the end of a URL. */
export function segments(text: string): NoticeSegment[] {
  const out: NoticeSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let href = m[0]
    const trail = href.match(/[.,;:!?'"]+$/)?.[0] ?? ""
    href = href.slice(0, href.length - trail.length)
    const at = m.index!
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ href, label: linkLabel(href) })
    last = at + href.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.filter((s) => !("text" in s) || s.text.trim())
}

/**
 * Read a task notice like `✅ **Fix login** is done: Fixed the redirect.` into its kind, the task's
 * title and a short plain-text summary ("Fixed the redirect."). Status words the icon already says
 * ("is done:", "failed:") are dropped; a notice that is only a link (a PR, a file) keeps its verb.
 */
export function parseNotice(content: string, meta: Record<string, unknown> | null = null): ParsedNotice {
  let rest = content
  let kind: NoticeKind = "info"
  const emoji = rest.match(LEADING_EMOJI)
  if (emoji) {
    kind = EMOJI_KIND[emoji[1]!] ?? "info"
    rest = rest.slice(emoji[0].length)
  }
  if (meta?.kind === "compaction") {
    kind = "compaction"
    // The saved file path is server-local and not openable from the browser.
    rest = rest.replace(/\s*Summary saved to \S+\s*$/, "")
  }
  let title: string | null = null
  const bold = rest.match(/^\*\*(.+?)\*\*\s*/)
  if (bold) {
    title = plainText(bold[1]!)
    rest = rest.slice(bold[0].length)
  }
  let text = plainText(rest).replace(/:$/, "")
  if (title) {
    // An artifact's title may itself contain ": "; its URL comes after the last one.
    const colon = kind === "artifact" ? text.lastIndexOf(": ") : text.indexOf(": ")
    if (colon >= 0) {
      const verb = text.slice(0, colon)
      const detail = text.slice(colon + 2)
      // "published Briefing: /artifacts/…" → "published Briefing" + the file link.
      if (kind === "artifact") text = `${verb.replace(/^published\s+/, "")} ${detail}`
      // "opened a pull request: https://…/pull/16" → "opened PR #16".
      else if (kind === "pr") text = `opened ${detail}`
      else if (kind === "message" && /^says$/.test(verb)) text = detail
      else text = detail || verb
    }
  }
  return { kind, title, summary: segments(text) }
}

export type CaptainRow =
  | { type: "message"; id: string; message: CaptainMessage }
  | { type: "notice"; id: string; message: CaptainMessage }
  | { type: "notices"; id: string; messages: CaptainMessage[] }

/** Notices from task events (and compactions) render as slim rows; everything else as chat. */
export function isNoticeRow(m: CaptainMessage) {
  return m.role === "notice"
}

/**
 * Chat rows for the transcript, oldest first. Two or more notices in a row form one group whose id is
 * its first notice's id, so it stays the same row (and keeps its open/closed state) as notices append.
 */
export function captainRows(messages: CaptainMessage[]): CaptainRow[] {
  const rows: CaptainRow[] = []
  let run: CaptainMessage[] = []
  const flush = () => {
    if (run.length === 1) rows.push({ type: "notice", id: run[0]!.id, message: run[0]! })
    else if (run.length > 1) rows.push({ type: "notices", id: run[0]!.id, messages: run })
    run = []
  }
  for (const m of messages) {
    if (isNoticeRow(m)) {
      run.push(m)
      continue
    }
    flush()
    rows.push({ type: "message", id: m.id, message: m })
  }
  flush()
  return rows
}

/** "4 task updates", or "3 updates" when some aren't about a task (compactions, warnings). */
export function groupLabel(messages: CaptainMessage[]): string {
  const allTasks = messages.every((m) => typeof m.meta?.taskId === "string")
  return `${messages.length} ${allTasks ? "task " : ""}updates`
}
