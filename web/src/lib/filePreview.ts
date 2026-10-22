// What the in-app file preview can show, and when a click should open it. Pure, so it is unit tested;
// the modal itself is components/FilePreview.tsx and its open/close state lib/preview.ts.
import type { ClickLike } from "./linkify"

export type PreviewKind = "image" | "markdown" | "html" | "pdf" | "json" | "csv" | "text" | "video" | "audio"

/** A file the preview can open. Only `url` is required; the rest fills the header. */
export interface PreviewItem {
  url: string
  name?: string
  /** Bytes, when known. */
  size?: number
  mime?: string
  /** An artifact's title, when it differs from the file name. */
  title?: string
}

const BY_EXT: Record<string, PreviewKind> = {
  ...Object.fromEntries(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].map((e) => [e, "image" as const])),
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  pdf: "pdf",
  json: "json",
  csv: "csv",
  ...Object.fromEntries(["mp4", "webm", "mov", "m4v"].map((e) => [e, "video" as const])),
  ...Object.fromEntries(["mp3", "wav", "ogg", "m4a", "flac"].map((e) => [e, "audio" as const])),
  ...Object.fromEntries(
    [
      "txt", "log", "tsv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cs", "swift",
      "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "css", "scss", "sql", "diff", "patch", "mmd", "graphql",
    ].map((e) => [e, "text" as const]),
  ),
}

/** The last path segment of a URL, decoded ("/artifacts/art_x/before%20shot.png" -> "before shot.png"). */
export function fileNameOf(url: string): string {
  const path = url.split(/[?#]/)[0] ?? ""
  const last = path.slice(path.lastIndexOf("/") + 1)
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function kindForMime(mime: string): PreviewKind | null {
  const m = mime.split(";")[0]!.trim().toLowerCase()
  if (m.startsWith("image/")) return "image"
  if (m === "text/markdown") return "markdown"
  if (m === "text/html") return "html"
  if (m === "application/pdf") return "pdf"
  if (m === "application/json") return "json"
  if (m === "text/csv") return "csv"
  if (m.startsWith("text/") || m === "application/javascript" || m === "application/xml" || m === "application/yaml") return "text"
  if (m.startsWith("video/")) return "video"
  if (m.startsWith("audio/")) return "audio"
  return null
}

/** How to show a file, by its extension first and then its MIME type. Null: not previewable (open it as before). */
export function previewKind(item: PreviewItem): PreviewKind | null {
  const ext = extensionOf(item.name || fileNameOf(item.url))
  return BY_EXT[ext] ?? (item.mime ? kindForMime(item.mime) : null)
}

/** Same-origin file paths the preview may load (never an external page in an iframe). */
export function isFilePath(url: string): boolean {
  return /^\/(?:artifacts|api\/uploads)\/[^/]/.test(url)
}

/** A plain left click, the only kind that opens the preview. Modified and middle clicks keep the browser's behavior. */
export function isPlainClick(e: ClickLike): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

/** Click on a file link: opens the preview (and cancels the navigation) for plain clicks on previewable files. */
export function interceptPreviewClick(e: ClickLike, item: PreviewItem, open: (item: PreviewItem) => void): boolean {
  if (!isPlainClick(e) || !isFilePath(item.url) || !previewKind(item)) return false
  e.preventDefault()
  open(item)
  return true
}

const ARTIFACT_URL = /^\/artifacts\/(art_[A-Za-z0-9-]+)\//

/** The `?preview=` value for a file: the artifact id when it is one, else its path. */
export function previewKey(url: string): string {
  return ARTIFACT_URL.exec(url)?.[1] ?? url
}

/** Reads a `?preview=` value back: an artifact id to look up, a file path, or null for anything else. */
export function parsePreviewKey(key: string | null): { artifactId: string } | { url: string } | null {
  if (!key) return null
  if (/^art_[A-Za-z0-9-]{6,40}$/.test(key)) return { artifactId: key }
  return isFilePath(key) ? { url: key } : null
}

/** Text previews stop here; bigger files get "Open in new tab". */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024
/** CSV tables show this many rows; Raw shows them all. */
export const CSV_ROW_LIMIT = 1000

export const isTextKind = (kind: PreviewKind | null) => kind === "markdown" || kind === "json" || kind === "csv" || kind === "text"

/** JSON indented two spaces, or null when it doesn't parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

/** Rows of a CSV (RFC 4180: quoted fields, "" escapes, newlines inside quotes). Tab-separated when `tsv`. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === "") quoted = true
    else if (c === delimiter) {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** "1\n2\n3" for a text's line-number gutter. */
export function lineNumbers(text: string): string {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  if (text.endsWith("\n")) n--
  return Array.from({ length: Math.max(1, n) }, (_, i) => i + 1).join("\n")
}

/** The next item when stepping through a gallery with ←/→, wrapping around. */
export function stepIndex(index: number, delta: number, length: number): number {
  return length ? (((index + delta) % length) + length) % length : 0
}
