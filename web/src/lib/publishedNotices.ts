// Back-to-back "📎 **Task** published X: /artifacts/…" notices, folded into one card per task. Pure, so it
// is unit tested; the cards themselves are components/PublishedNotices.tsx. Used by the Coordinator chat
// (and Zen mode, which is the same panel) and the project Captain tab.
import { fileNameOf, previewKind, type PreviewItem } from "./filePreview"

/** The bits of a chat, Captain or task message the grouping reads. */
export interface NoticeLike {
  id: string
  role: string
  content: string
  meta: Record<string, unknown> | null
  createdAt: number
}

/** One published file, read from its notice. */
export interface PublishedFileRef {
  /** The notice's message id. */
  id: string
  /** Same-origin path, e.g. "/artifacts/art_1/shot.png" (the notice may carry an absolute URL). */
  url: string
  /** The artifact's title ("Before: Coordinator panel (desktop 1440)"). */
  title: string
  filename: string
  artifactId: string | null
  createdAt: number
}

export interface PublishedNotice {
  taskId: string | null
  /** The task's title as the notice wrote it. */
  taskTitle: string
  file: PublishedFileRef
}

// "📎 **Task title** published File title: https://host/artifacts/art_x/file.png". The file title may itself
// contain ": ", so the URL is whatever follows the last ": ".
const PUBLISHED_RE = /^\s*📎️?\s*\*\*(.+?)\*\*\s+published\s+([\s\S]*):\s+(\S+)\s*$/u

/** The path of an artifact URL on this server, dropping the public origin the server may have put in front. */
export function artifactPath(url: string): string {
  return url.replace(/^https?:\/\/[^/]+(?=\/artifacts\/)/, "")
}

/** A published-file notice read into its task and file, or null for any other message. */
export function parsePublished(m: NoticeLike): PublishedNotice | null {
  if (m.role !== "notice") return null
  const match = m.content.match(PUBLISHED_RE)
  if (!match) return null
  const url = artifactPath(match[3]!)
  if (!url.startsWith("/artifacts/")) return null
  const artifactId = typeof m.meta?.artifactId === "string" ? m.meta.artifactId : (url.match(/^\/artifacts\/(art_[^/]+)\//)?.[1] ?? null)
  return {
    taskId: typeof m.meta?.taskId === "string" ? m.meta.taskId : null,
    taskTitle: match[1]!.trim(),
    file: { id: m.id, url, title: match[2]!.replace(/\s+/g, " ").trim(), filename: fileNameOf(url), artifactId, createdAt: m.createdAt },
  }
}

/** One task's files from a run of back-to-back published notices. */
export interface PublishedGroup<M extends NoticeLike = NoticeLike> {
  /** Its first notice's id: stays the same as more files join, so the row keeps its key and open state. */
  id: string
  taskId: string | null
  taskTitle: string
  files: PublishedFileRef[]
  messages: M[]
}

export type PublishedRow<M extends NoticeLike = NoticeLike> =
  | { type: "message"; id: string; message: M }
  | { type: "files"; id: string; group: PublishedGroup<M> }

/**
 * Chat rows, oldest first, with back-to-back published notices folded into one "files" row per task.
 * A run ends at any other message. Within a run each task keeps one card, placed where its first file
 * was, so files that arrive later (even after another task's) join their card instead of adding rows.
 */
export function groupPublished<M extends NoticeLike>(messages: readonly M[]): PublishedRow<M>[] {
  const rows: PublishedRow<M>[] = []
  let run = new Map<string, PublishedGroup<M>>()
  for (const m of messages) {
    const p = parsePublished(m)
    if (!p) {
      run = new Map()
      rows.push({ type: "message", id: m.id, message: m })
      continue
    }
    const key = p.taskId ?? `title:${p.taskTitle}`
    const group = run.get(key)
    if (group) {
      group.files.push(p.file)
      group.messages.push(m)
      continue
    }
    const fresh: PublishedGroup<M> = { id: m.id, taskId: p.taskId, taskTitle: p.taskTitle, files: [p.file], messages: [m] }
    run.set(key, fresh)
    rows.push({ type: "files", id: m.id, group: fresh })
  }
  return rows
}

/** "published 6 files", or "published a file". */
export function publishedLabel(count: number): string {
  return count === 1 ? "published a file" : `published ${count} files`
}

export const previewItemOf = (f: PublishedFileRef): PreviewItem => ({ url: f.url, name: f.filename, title: f.title })

/** The ←/→ gallery over a whole group: every file the preview can open, in order (like the task's Files drawer). */
export function previewGallery(files: readonly PublishedFileRef[]): PreviewItem[] {
  return files.map(previewItemOf).filter((item) => previewKind(item) !== null)
}

/** Same id and the very same messages: a memo'd card can skip re-rendering when nothing joined it. */
export function sameGroup(a: PublishedGroup, b: PublishedGroup): boolean {
  return a === b || (a.id === b.id && a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]))
}

/** Runs of consecutive items that pass `member`, as arrays; other items stay single. For the task transcript's file chips. */
export function runsOf<T>(items: readonly T[], member: (item: T) => boolean): (T | T[])[] {
  const out: (T | T[])[] = []
  let run: T[] | null = null
  for (const item of items) {
    if (!member(item)) {
      run = null
      out.push(item)
    } else if (run) run.push(item)
    else {
      run = [item]
      out.push(run)
    }
  }
  return out
}
