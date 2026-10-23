// A task's published files as the header's "📎 N files" drawer shows them: newest first, grouped when titles
// share a stem ("Captain tab before (mobile)" / "Captain tab after: menu" → "Captain tab"), filtered by a search
// box, plus the "new since you last looked" count. Pure, so it is unit tested; the UI is components/TaskFiles.tsx.
import { previewKind, type PreviewItem, type PreviewKind } from "./filePreview"
import type { Artifact } from "../../../shared/types"

/** Above this many files the drawer shows a filter box. */
export const FILTER_MIN = 9

export type TaskFile = Pick<Artifact, "id" | "title" | "filename" | "mime" | "size" | "url" | "createdAt">

export interface FileSection<T extends TaskFile = TaskFile> {
  key: string
  /** The shared stem, or null for files that don't group with anything. */
  label: string | null
  images: T[]
  others: T[]
}

export interface FileListing<T extends TaskFile = TaskFile> {
  sections: FileSection<T>[]
  /** Every shown file in display order (each section's images, then its list): the ←/→ order of the preview. */
  ordered: T[]
  total: number
}

/** Newest first; ties keep a stable order by id. */
export function newestFirst<T extends TaskFile>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const BEFORE_AFTER = /\s+(?:before|after|old|new)$/i

/** The part of a title files group by: up to a ":", "(", " — " or " - ", minus a trailing before/after. */
export function titleStem(title: string): string {
  const cut = title.search(/\s*(?::|\(|\s[—–-]\s)/)
  const head = (cut > 0 ? title.slice(0, cut) : title).trim()
  return head.replace(BEFORE_AFTER, "").trim().toLowerCase()
}

export const fileKind = (f: TaskFile): PreviewKind | null => previewKind({ url: f.url, name: f.filename, mime: f.mime })
export const isImageFile = (f: TaskFile) => fileKind(f) === "image"

/** "PNG", "MD", "HTML": the extension, else the MIME subtype. */
export function fileType(f: TaskFile): string {
  const dot = f.filename.lastIndexOf(".")
  if (dot > 0) return f.filename.slice(dot + 1).toUpperCase()
  return (f.mime.split("/")[1] ?? f.mime).split(";")[0]!.toUpperCase()
}

/** Every whitespace-separated word must appear in the title, file name or type. */
export function matchesFile(f: TaskFile, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${f.title} ${f.filename} ${fileType(f)} ${fileKind(f) ?? ""}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * Sections for the drawer. Files whose stems match (two or more) form a labelled group; the rest share one
 * unlabelled section. Sections are ordered by their newest file, files newest first inside each.
 */
export function listFiles<T extends TaskFile>(files: readonly T[], query = ""): FileListing<T> {
  const shown = newestFirst(files.filter((f) => matchesFile(f, query)))
  const byStem = new Map<string, T[]>()
  for (const f of shown) {
    const stem = titleStem(f.title)
    byStem.set(stem, [...(byStem.get(stem) ?? []), f])
  }
  const grouped = [...byStem.values()].filter((g) => g.length > 1)
  // Grouping everything into one section would only add a heading.
  const useGroups = grouped.length > 0 && !(grouped.length === 1 && grouped[0]!.length === shown.length)

  const sections: FileSection<T>[] = []
  const loose: T[] = []
  if (useGroups) {
    for (const g of grouped) sections.push(section(`stem:${titleStem(g[0]!.title)}`, labelFor(g), g))
    for (const f of shown) if (byStem.get(titleStem(f.title))!.length < 2) loose.push(f)
  } else loose.push(...shown)
  if (loose.length) sections.push(section("loose", null, loose))
  sections.sort((a, b) => newestOf(b) - newestOf(a))

  return { sections, ordered: sections.flatMap((s) => [...s.images, ...s.others]), total: files.length }
}

function section<T extends TaskFile>(key: string, label: string | null, files: T[]): FileSection<T> {
  return { key, label, images: files.filter(isImageFile), others: files.filter((f) => !isImageFile(f)) }
}

const newestOf = (s: FileSection) => Math.max(...[...s.images, ...s.others].map((f) => f.createdAt))

/** The stem as the newest file spells it ("Captain tab"), not lowercased. */
function labelFor(files: TaskFile[]): string {
  const title = files[0]!.title
  const cut = title.search(/\s*(?::|\(|\s[—–-]\s)/)
  return (cut > 0 ? title.slice(0, cut) : title).trim().replace(BEFORE_AFTER, "").trim() || title
}

/** What the preview gets for a file. */
export const previewItemOf = (f: TaskFile): PreviewItem => ({ url: f.url, name: f.filename, size: f.size, mime: f.mime, title: f.title })

/** The ←/→ gallery: the shown files the preview can open, in display order. */
export const galleryOf = (ordered: readonly TaskFile[]): PreviewItem[] => ordered.filter((f) => fileKind(f)).map(previewItemOf)

/** Files published after `seenAt` (the newest createdAt when the list was last opened; null: never). */
export function unseenCount(files: readonly TaskFile[], seenAt: number | null): number {
  return files.filter((f) => seenAt === null || f.createdAt > seenAt).length
}

/** The value to remember on open: the newest file's time, so server/client clock skew can't hide a file. */
export const latestAt = (files: readonly TaskFile[]): number => files.reduce((max, f) => Math.max(max, f.createdAt), 0)

export const seenKey = (taskId: string) => `boxyard:files-seen:${taskId}`
