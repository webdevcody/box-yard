// The file preview modal: images in a lightbox, markdown rendered, HTML and PDF in iframes, text and code with line
// numbers (JSON pretty-printed, CSV as a table), video and audio in native players. Mounted once as <FilePreviewHost>;
// links open it through <FileLink> and lib/preview.ts.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { useSearchParams } from "wouter"
import { Check, ChevronLeft, ChevronRight, Code, Download, ExternalLink, Eye, FileWarning, Link as LinkIcon, Loader2, X, ZoomIn, ZoomOut } from "lucide-react"
import { useArtifacts } from "../lib/queries"
import {
  CSV_ROW_LIMIT,
  TEXT_PREVIEW_MAX,
  fileNameOf,
  isTextKind,
  lineNumbers,
  parseCsv,
  parsePreviewKey,
  prettyJson,
  previewKey,
  previewKind,
  type PreviewItem,
  type PreviewKind,
} from "../lib/filePreview"
import { PREVIEW_PARAM, closePreview, stepPreview, usePreviewState } from "../lib/preview"
import { Modal, type ModalSize } from "./Modal"
import { formatSize } from "./Attachments"
import { isTyping } from "./TaskFilters"
import { Markdown, NewTabLink, cx } from "./ui"
import type { Artifact } from "../../../shared/types"

/** Mounted once in the app: shows the file named by `?preview=`. */
export function FilePreviewHost() {
  const [params] = useSearchParams()
  const key = params.get(PREVIEW_PARAM)
  const state = usePreviewState()
  const artifacts = useArtifacts()
  const parsed = parsePreviewKey(key)
  if (!key || !parsed) return null

  // Opened by a click: the store has the item and its gallery. Opened from a URL (reload, back/forward): look it up.
  const fromStore = state && previewKey(state.items[state.index]!.url) === key ? state : null
  let item: PreviewItem | null = fromStore ? fromStore.items[fromStore.index]! : "url" in parsed ? { url: parsed.url } : null
  const artifactId = "artifactId" in parsed ? parsed.artifactId : /^\/artifacts\/(art_[^/]+)\//.exec(item?.url ?? "")?.[1]
  const artifact = artifactId ? artifacts.data?.find((a) => a.id === artifactId) : undefined
  if (artifact) item = withArtifact(item, artifact)

  if (!item) {
    return (
      <Modal size="sm" title="Preview" onClose={closePreview}>
        {artifacts.isLoading ? <Loading /> : <Problem message="This file doesn't exist anymore." />}
      </Modal>
    )
  }
  return <FilePreview item={item} position={fromStore && fromStore.items.length > 1 ? [fromStore.index + 1, fromStore.items.length] : null} />
}

function withArtifact(item: PreviewItem | null, a: Artifact): PreviewItem {
  return {
    url: item?.url ?? a.url,
    name: item?.name ?? a.filename,
    size: item?.size ?? a.size,
    mime: item?.mime ?? a.mime,
    title: a.title && a.title !== a.filename ? a.title : undefined,
  }
}

const SIZE: Record<PreviewKind, ModalSize> = {
  image: "full",
  html: "full",
  pdf: "full",
  markdown: "xl",
  json: "xl",
  csv: "xl",
  text: "xl",
  video: "xl",
  audio: "md",
}

/** Kinds that fill a fixed-height panel; the rest grow with their content up to the viewport. */
const TALL: PreviewKind[] = ["image", "html", "pdf"]

function FilePreview({ item, position }: { item: PreviewItem; position: [number, number] | null }) {
  const kind = previewKind(item)
  const name = item.name || fileNameOf(item.url)
  const [raw, setRaw] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => {
    setRaw(false)
    setZoomed(false)
  }, [item.url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.shiftKey) return
      if (position && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault()
        stepPreview(e.key === "ArrowLeft" ? -1 : 1)
      } else if (kind === "image" && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        setZoomed((z) => !z)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [kind, position])

  return (
    <Modal
      size={kind ? SIZE[kind] : "md"}
      label={name}
      onClose={closePreview}
      className={cx(kind && TALL.includes(kind) && "sm:h-[85vh]", kind && isTextKind(kind) && "sm:max-h-[85vh]")}
      bodyClassName="relative flex min-h-0 flex-1 flex-col"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-zinc-900 py-2 pr-2 pl-4 sm:gap-2 sm:py-2.5 sm:pr-3 sm:pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-zinc-50" title={name}>
            {name}
          </h2>
          <p className="truncate text-xs text-zinc-500">
            {[item.title, item.size ? formatSize(item.size) : null, position ? `${position[0]} of ${position[1]}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        {(kind === "markdown" || kind === "json" || kind === "csv") && (
          <ToolButton label={raw ? (kind === "csv" ? "Show table" : kind === "json" ? "Show formatted" : "Show rendered") : "Show raw"} active={raw} onClick={() => setRaw((r) => !r)}>
            {raw ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
            <span className="hidden sm:inline">Raw</span>
          </ToolButton>
        )}
        {kind === "image" && (
          <ToolButton label={zoomed ? "Fit to screen (Z)" : "Zoom to 100% (Z)"} active={zoomed} onClick={() => setZoomed((z) => !z)}>
            {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </ToolButton>
        )}
        <FileActions url={item.url} name={name} />
        <ToolButton label="Close (Esc)" onClick={closePreview}>
          <X className="h-5 w-5" />
        </ToolButton>
      </header>
      <PreviewBody key={item.url} item={item} kind={kind} name={name} raw={raw} zoomed={zoomed} onZoom={setZoomed} />
      {position && (
        <>
          <StepButton side="left" onClick={() => stepPreview(-1)} />
          <StepButton side="right" onClick={() => stepPreview(1)} />
        </>
      )}
    </Modal>
  )
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md p-1.5 text-xs font-medium hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0 sm:min-w-0",
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400",
      )}
    >
      {children}
    </button>
  )
}

const actionClass = "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0 sm:min-w-0"

function FileActions({ url, name }: { url: string; name: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => {
    void navigator.clipboard?.writeText(new URL(url, window.location.origin).href).then(() => setCopied(true))
  }
  return (
    <>
      <NewTabLink href={url} mark={false} className={actionClass} title="Open in new tab" aria-label="Open in new tab">
        <ExternalLink className="h-4 w-4" />
      </NewTabLink>
      <a href={url} download={name} className={actionClass} title="Download" aria-label="Download">
        <Download className="h-4 w-4" />
      </a>
      <ToolButton label={copied ? "Copied" : "Copy link"} onClick={copy}>
        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <LinkIcon className="h-4 w-4" />}
      </ToolButton>
    </>
  )
}

function StepButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous image (←)" : "Next image (→)"}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      className={cx(
        "absolute top-1/2 z-10 grid h-11 w-11 place-items-center rounded-full bg-zinc-950/70 text-zinc-300 shadow-lg ring-1 ring-zinc-800 backdrop-blur hover:bg-zinc-900 hover:text-white sm:h-10 sm:w-10",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      <Icon className="h-5 w-5" />
    </button>
  )
}

function Loading() {
  return (
    <div className="grid flex-1 place-items-center py-16 text-sm text-zinc-500">
      <span className="inline-flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </span>
    </div>
  )
}

function Problem({ message, url }: { message: string; url?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-zinc-400">
      <FileWarning className="h-8 w-8 text-zinc-600" />
      <p>{message}</p>
      {url && (
        <NewTabLink href={url} mark={false} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700">
          <ExternalLink className="h-3.5 w-3.5" /> Open in new tab
        </NewTabLink>
      )}
    </div>
  )
}

function PreviewBody({
  item,
  kind,
  name,
  raw,
  zoomed,
  onZoom,
}: {
  item: PreviewItem
  kind: PreviewKind | null
  name: string
  raw: boolean
  zoomed: boolean
  onZoom: (z: boolean) => void
}) {
  switch (kind) {
    case "image":
      return <ImageView url={item.url} name={name} zoomed={zoomed} onZoom={onZoom} />
    case "html":
      // No allow-same-origin: the page runs its scripts but can't reach Box Yard's cookies or API.
      return <FrameView url={item.url} name={name} sandbox="allow-scripts" />
    case "pdf":
      // Browsers won't run their PDF viewer in a sandboxed frame.
      return <FrameView url={item.url} name={name} />
    case "video":
      return <MediaView url={item.url} kind="video" />
    case "audio":
      return <MediaView url={item.url} kind="audio" />
    case "markdown":
    case "json":
    case "csv":
    case "text":
      return <TextPreview item={item} kind={kind} raw={raw} />
    default:
      return <Problem message="This file type can't be previewed." url={item.url} />
  }
}

// ------------------------------------------------------------------ images

function ImageView({ url, name, zoomed, onZoom }: { url: string; name: string; zoomed: boolean; onZoom: (z: boolean) => void }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const box = useRef<HTMLDivElement>(null)
  // Where to keep under the pointer after zooming in: the click's spot as a fraction of the fitted image.
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    const img = el?.querySelector("img")
    if (!el || !img || !zoomed) return
    const a = anchor.current ?? { fx: 0.5, fy: 0.5, x: el.clientWidth / 2, y: el.clientHeight / 2 }
    el.scrollLeft = img.offsetLeft + a.fx * img.offsetWidth - a.x
    el.scrollTop = img.offsetTop + a.fy * img.offsetHeight - a.y
    anchor.current = null
  }, [zoomed])

  const onClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (drag.current?.moved) return
    if (!zoomed) {
      const r = e.currentTarget.getBoundingClientRect()
      const b = box.current!.getBoundingClientRect()
      anchor.current = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, x: e.clientX - b.left, y: e.clientY - b.top }
    }
    onZoom(!zoomed)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!zoomed || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop, moved: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !(e.buttons & 1)) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    e.currentTarget.scrollLeft = d.left - dx
    e.currentTarget.scrollTop = d.top - dy
  }

  return (
    <div
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setTimeout(() => (drag.current = null))}
      className={cx(
        "scroll-thin relative flex min-h-0 flex-1 bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:24px_24px]",
        zoomed ? "cursor-grab overflow-auto active:cursor-grabbing" : "items-center justify-center overflow-hidden p-4",
      )}
    >
      {status === "loading" && (
        <div className="absolute inset-0 flex">
          <Loading />
        </div>
      )}
      {status === "error" ? (
        <Problem message="Couldn't load this image." url={url} />
      ) : (
        <img
          src={url}
          alt={name}
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          onClick={onClick}
          className={cx(
            "select-none",
            zoomed ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
            status !== "ready" && "invisible",
          )}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ frames and media

function FrameView({ url, name, sandbox }: { url: string; name: string; sandbox?: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative min-h-0 flex-1 bg-white">
      {!loaded && (
        <div className="absolute inset-0 flex bg-zinc-950">
          <Loading />
        </div>
      )}
      <iframe src={url} title={name} sandbox={sandbox} onLoad={() => setLoaded(true)} className="h-full w-full border-0" />
    </div>
  )
}

function MediaView({ url, kind }: { url: string; kind: "video" | "audio" }) {
  const [error, setError] = useState(false)
  if (error) return <Problem message={`Couldn't play this ${kind === "video" ? "video" : "audio file"}.`} url={url} />
  return kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video src={url} controls autoPlay className="max-h-[75vh] max-w-full" onError={() => setError(true)} />
    </div>
  ) : (
    <div className="px-5 py-8">
      <audio src={url} controls autoPlay className="w-full" onError={() => setError(true)} />
    </div>
  )
}

// ------------------------------------------------------------------ text

type TextState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string } | { status: "too-large"; size: number }

/** The file as text, unless it's over TEXT_PREVIEW_MAX. */
function useFileText(url: string, size?: number): TextState {
  const [state, setState] = useState<TextState>(() => (size && size > TEXT_PREVIEW_MAX ? { status: "too-large", size } : { status: "loading" }))
  useEffect(() => {
    if (size && size > TEXT_PREVIEW_MAX) return
    const ctl = new AbortController()
    setState({ status: "loading" })
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) return setState({ status: "error", message: res.status === 404 ? "This file doesn't exist anymore." : `Couldn't load this file (${res.status}).` })
        const length = Number(res.headers.get("content-length"))
        if (length > TEXT_PREVIEW_MAX) {
          ctl.abort()
          return setState({ status: "too-large", size: length })
        }
        const text = await res.text()
        setState(text.length > TEXT_PREVIEW_MAX ? { status: "too-large", size: text.length } : { status: "ready", text })
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setState({ status: "error", message: `Couldn't load this file${err instanceof Error ? ` (${err.message})` : ""}.` })
      })
    return () => ctl.abort()
  }, [url, size])
  return state
}

function TextPreview({ item, kind, raw }: { item: PreviewItem; kind: "markdown" | "json" | "csv" | "text"; raw: boolean }) {
  const file = useFileText(item.url, item.size)
  if (file.status === "loading") return <Loading />
  if (file.status === "error") return <Problem message={file.message} url={item.url} />
  if (file.status === "too-large")
    return <Problem message={`This file is ${formatSize(file.size)}, too big to preview here (the limit is ${formatSize(TEXT_PREVIEW_MAX)}).`} url={item.url} />
  const { text } = file
  if (!raw && kind === "markdown")
    return (
      <div className="prose-doc scroll-thin min-h-0 flex-1 overflow-auto px-4 py-5 text-sm text-zinc-200 sm:px-6">
        <Markdown>{text}</Markdown>
      </div>
    )
  if (!raw && kind === "csv") return <CsvTable text={text} tsv={/\.tsv$/i.test(item.name || item.url)} />
  if (!raw && kind === "json") {
    const pretty = prettyJson(text)
    if (pretty !== null) return <CodeView text={pretty} />
    return <CodeView text={text} note="This isn't valid JSON, so it's shown as is." />
  }
  return <CodeView text={text} />
}

/** Monospace text with a line-number gutter. Two text nodes, so even a 2 MB log renders quickly. */
function CodeView({ text, note }: { text: string; note?: string }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-zinc-950">
      {note && <div className="border-b border-zinc-900 px-4 py-2 text-xs text-amber-300/80">{note}</div>}
      <div className="flex w-max min-w-full font-mono text-xs leading-5">
        <pre aria-hidden className="sticky left-0 shrink-0 border-r border-zinc-900 bg-zinc-950 py-3 pr-3 pl-4 text-right text-zinc-600 select-none">
          {lineNumbers(text)}
        </pre>
        <pre className="py-3 pr-6 pl-4 text-zinc-200">{text}</pre>
      </div>
    </div>
  )
}

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = parseCsv(text, tsv ? "\t" : ",")
  if (!rows.length) return <Problem message="This file is empty." />
  const [head, ...body] = rows
  const shown = body.slice(0, CSV_ROW_LIMIT)
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <table className="min-w-full border-collapse text-left font-mono text-xs">
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            {head!.map((h, i) => (
              <th key={i} className="border-b border-zinc-800 px-3 py-2 font-semibold whitespace-nowrap text-zinc-200">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="odd:bg-zinc-900/30">
              {r.map((c, j) => (
                <td key={j} className="border-b border-zinc-900 px-3 py-1.5 whitespace-nowrap text-zinc-300">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <p className="px-3 py-2 text-xs text-zinc-500">
          Showing the first {CSV_ROW_LIMIT.toLocaleString()} of {body.length.toLocaleString()} rows. Use Raw for the rest.
        </p>
      )}
    </div>
  )
}
