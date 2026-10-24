// A task's published files: one "📎 N files" chip in the header that opens a drawer (a bottom sheet on phones)
// with image thumbnails and a compact list, and the small "published" row in the transcript. Ordering, grouping
// and filtering are in lib/taskFiles.ts. The drawer's open state lives here, so opening it never re-renders the
// transcript.
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { ArrowRight, File, FileCode, FileImage, FileText, Film, Music, Paperclip, Search, X } from "lucide-react"
import { Modal } from "./Modal"
import { ArtifactLink } from "./FileLink"
import { formatSize } from "./Attachments"
import { META_CHIP, TimeAgo, cx } from "./ui"
import { useArtifacts } from "../lib/queries"
import { FILTER_MIN, fileKind, fileType, galleryOf, isImageFile, latestAt, listFiles, seenKey, shortTitle, unseenCount, type TaskFile } from "../lib/taskFiles"
import type { PreviewKind } from "../lib/filePreview"
import type { Artifact } from "../../../shared/types"

/** The newest file time seen when the list was last opened, per task, in localStorage. */
function useFilesSeen(taskId: string): [number | null, (at: number) => void] {
  const read = () => {
    const v = Number(localStorage.getItem(seenKey(taskId)))
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const [seen, setSeen] = useState(read)
  useEffect(() => setSeen(read()), [taskId])
  const mark = useCallback(
    (at: number) => {
      if (!at) return
      localStorage.setItem(seenKey(taskId), String(at))
      setSeen(at)
    },
    [taskId],
  )
  return [seen, mark]
}

export function FilesChip({ taskId, projectId, files }: { taskId: string; projectId: string | null; files: Artifact[] }) {
  const [open, setOpen] = useState(false)
  const [seen, markSeen] = useFilesSeen(taskId)
  // What was new when the drawer opened stays marked while it is open.
  const [seenAtOpen, setSeenAtOpen] = useState<number | null>(null)
  const fresh = unseenCount(files, seen)
  const latest = latestAt(files)

  useEffect(() => {
    if (open) markSeen(latest)
  }, [open, latest, markSeen])
  useEffect(() => setOpen(false), [taskId])

  if (!files.length) return null
  const label = `${files.length} file${files.length === 1 ? "" : "s"}`
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSeenAtOpen(seen)
          setOpen(true)
        }}
        aria-haspopup="dialog"
        aria-label={fresh ? `${label}, ${fresh} new` : label}
        title={fresh ? `${label}, ${fresh} new since you last looked` : "Files this task published"}
        className={cx(META_CHIP, "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none")}
      >
        <Paperclip className="h-3 w-3 text-zinc-400" /> {label}
        {/* New files since the drawer was last opened: a dot, with the count in the tooltip and the label. */}
        {fresh > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" aria-hidden data-testid="files-new-dot" />}
      </button>
      {open && <FilesDrawer taskId={taskId} projectId={projectId} files={files} seenAt={seenAtOpen} onClose={() => setOpen(false)} />}
    </>
  )
}

function FilesDrawer({ taskId, projectId, files, seenAt, onClose }: { taskId: string; projectId: string | null; files: Artifact[]; seenAt: number | null; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const listing = useMemo(() => listFiles(files, query), [files, query])
  const gallery = useMemo(() => galleryOf(listing.ordered), [listing])
  const getGallery = useCallback(() => gallery, [gallery])
  const isNew = (f: TaskFile) => seenAt === null || f.createdAt > seenAt

  return (
    <Modal
      size="lg"
      placement="sheet"
      title="Files"
      description={`${files.length} file${files.length === 1 ? "" : "s"} published by this task`}
      onClose={onClose}
      bodyClassName="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5"
      footer={
        projectId && (
          <Link
            href={`/projects/${projectId}?tab=files&task=${encodeURIComponent(taskId)}`}
            className="inline-flex min-h-11 items-center justify-center gap-1 rounded-lg px-2 text-sm text-yard-400 hover:underline sm:min-h-0 sm:justify-end"
          >
            Open in Files tab <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )
      }
    >
      {files.length >= FILTER_MIN && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The first Esc clears the filter; the next one closes the drawer.
              if (e.key === "Escape" && query) {
                e.preventDefault()
                setQuery("")
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            className="min-h-11 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pr-9 pl-8 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none sm:min-h-0 sm:text-sm"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear filter" className="absolute top-1/2 right-1 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-md text-zinc-500 hover:text-zinc-200 sm:h-7 sm:w-7">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {!listing.ordered.length && <p className="py-6 text-center text-sm text-zinc-500">No files match “{query}”.</p>}
      {listing.sections.map((s) => (
        <section key={s.key} className="space-y-2">
          {s.label && (
            <h3 className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
              {s.label} <span className="font-normal text-zinc-600">· {s.images.length + s.others.length}</span>
            </h3>
          )}
          {s.images.length > 0 && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {s.images.map((f) => (
                <li key={f.id}>
                  <ArtifactLink
                    artifact={f}
                    gallery={getGallery}
                    title={`${f.title} · ${formatSize(f.size)}`}
                    className="group block overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-600 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
                  >
                    <img src={f.url} alt="" loading="lazy" className="aspect-video w-full bg-zinc-950 object-cover object-top" />
                    <span className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
                      {isNew(f) && <NewDot />}
                      <span className="min-w-0 flex-1 truncate text-zinc-300 group-hover:text-zinc-100">{shortTitle(f.title, s.label)}</span>
                      <span className="shrink-0 text-[10px] text-zinc-600">
                        <TimeAgo ts={f.createdAt} />
                      </span>
                    </span>
                  </ArtifactLink>
                </li>
              ))}
            </ul>
          )}
          {s.others.length > 0 && (
            <ul className="divide-y divide-zinc-900 overflow-hidden rounded-lg border border-zinc-800/80">
              {s.others.map((f) => (
                <li key={f.id}>
                  <ArtifactLink
                    artifact={f}
                    gallery={getGallery}
                    className="flex min-h-11 items-center gap-2.5 px-3 py-2 text-sm hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none sm:min-h-0"
                  >
                    <KindIcon kind={fileKind(f)} />
                    {isNew(f) && <NewDot />}
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{shortTitle(f.title, s.label)}</span>
                    <span className="shrink-0 text-xs whitespace-nowrap text-zinc-500">
                      {fileType(f)} · {formatSize(f.size)} · <TimeAgo ts={f.createdAt} />
                    </span>
                  </ArtifactLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </Modal>
  )
}

const NewDot = () => <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" title="New since you last looked" aria-label="new" />

const KIND_ICON: Partial<Record<PreviewKind, typeof File>> = {
  image: FileImage,
  markdown: FileText,
  text: FileText,
  csv: FileText,
  pdf: FileText,
  html: FileCode,
  json: FileCode,
  video: Film,
  audio: Music,
}

export function KindIcon({ kind, className = "h-4 w-4" }: { kind: PreviewKind | null; className?: string }) {
  const Icon = (kind && KIND_ICON[kind]) || File
  return <Icon className={cx("shrink-0 text-zinc-500", className)} />
}

/** The transcript's "published X" event: a small file row, with a thumbnail for images. */
export const PublishedFile = memo(function PublishedFile({ artifactId, url, text }: { artifactId: string | undefined; url: string; text: string }) {
  const artifacts = useArtifacts()
  const a = artifactId ? artifacts.data?.find((x) => x.id === artifactId) : undefined
  const f: TaskFile = a ?? { id: artifactId ?? url, title: text.replace(/^Published artifact:\s*/, ""), filename: url.slice(url.lastIndexOf("/") + 1), mime: "", size: 0, url, createdAt: 0 }
  const image = isImageFile(f)
  return (
    <ArtifactLink
      artifact={{ projectId: null, taskId: null, ...f }}
      title={`Published ${f.title}`}
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/60 py-0.5 pr-2 pl-0.5 align-middle text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
    >
      {image ? (
        <img src={f.url} alt="" loading="lazy" className="h-6 w-9 shrink-0 rounded-sm border border-zinc-800 bg-zinc-950 object-cover object-top" />
      ) : (
        <span className="grid h-6 w-6 shrink-0 place-items-center">
          <KindIcon kind={fileKind(f)} className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="shrink-0 text-zinc-600">Published</span>
      <span className="min-w-0 truncate text-zinc-300">{f.title}</span>
      {f.size > 0 && (
        <span className="shrink-0 text-[10px] text-zinc-600 max-sm:hidden">
          {fileType(f)} · {formatSize(f.size)}
        </span>
      )}
    </ArtifactLink>
  )
})
