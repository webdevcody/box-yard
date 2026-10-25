// Back-to-back "published" file notices as one compact card per task: the task, "published 6 files", a strip of
// small thumbnails (type chips for other files) and the first titles; "Show all" lists every file as a link row.
// Every file opens the preview modal, and ←/→ step through the whole group. Grouping is lib/publishedNotices.ts.
import { memo, useId, useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { META_CHIP, TimeAgo, cx } from "./ui"
import { FileLink } from "./FileLink"
import { KindIcon } from "./TaskFiles"
import { NOTICE_CLASS, NoticeCard, NoticeLayout, NoticeProject } from "./ChatLine"
import { previewKind } from "../lib/filePreview"
import { previewGallery, publishedLabel, sameGroup, type PublishedFileRef, type PublishedGroup } from "../lib/publishedNotices"

/** Thumbnails shown before "+N" (fewer in a narrow card), so the strip stays one line. */
export const STRIP_MAX = 6
const STRIP_MAX_NARROW = 4

export const SLIM_TITLE_LINK = "font-medium text-zinc-200 hover:underline"

const kindOf = (f: PublishedFileRef) => previewKind({ url: f.url, name: f.filename })
const extOf = (f: PublishedFileRef) => {
  const dot = f.filename.lastIndexOf(".")
  return dot > 0 ? f.filename.slice(dot + 1).toUpperCase().slice(0, 5) : "FILE"
}

/** A small thumbnail for an image, else a file-type chip; same height either way so the strip never shifts. */
function Thumb({ f, gallery, className }: { f: PublishedFileRef; gallery: () => ReturnType<typeof previewGallery>; className?: string }) {
  const kind = kindOf(f)
  return (
    <FileLink
      href={f.url}
      name={f.filename}
      fileTitle={f.title}
      gallery={gallery}
      title={f.title}
      aria-label={f.title}
      className={cx(
        "inline-flex h-11 shrink-0 items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-[10px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none sm:h-7",
        className,
      )}
    >
      {kind === "image" ? (
        <img src={f.url} alt="" loading="lazy" decoding="async" className="h-full w-14 object-cover object-top sm:w-10" />
      ) : (
        <span className="inline-flex items-center gap-1 px-1.5">
          <KindIcon kind={kind} className="h-3 w-3" />
          {extOf(f)}
        </span>
      )}
    </FileLink>
  )
}

/**
 * A NoticeLayout: the task on its own row, "box-yard · Captain · published 2 files" under it, the thumbnail strip,
 * then the file list. The list's header line (the first titles, or "2 files" when open) carries the Show all / Hide
 * toggle, so the toggle sits on the list it opens and closes, never by the title.
 * `project` adds the task's project and Captain links (the Coordinator's card; the Captain tab is that project already).
 * `time` is the Captain tab's row: the time on the right of the meta line, and that tab's quieter title.
 */
function GroupBody({ group, time, project }: { group: PublishedGroup; time?: number; project?: boolean }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const files = group.files
  const gallery = useMemo(() => previewGallery(files), [files])
  const getGallery = () => gallery
  const more = files.length - STRIP_MAX
  const moreNarrow = files.length - STRIP_MAX_NARROW
  const moreChip = (n: number, className: string) =>
    n > 0 &&
    !open && (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Show all ${files.length} files`}
        className={cx(META_CHIP, "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200", className)}
      >
        +{n}
      </button>
    )
  const toggle = files.length > 1 && (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => setOpen((o) => !o)}
      className={cx(META_CHIP, "ml-auto border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")}
    >
      {open ? "Hide" : "Show all"}
      <ChevronDown className={cx("h-3 w-3 transition-transform", open && "rotate-180")} />
    </button>
  )
  return (
    <div data-testid="published-group" data-count={files.length}>
      <NoticeLayout
        kind="artifact"
        title={group.taskTitle}
        taskId={group.taskId}
        project={project && group.taskId && <NoticeProject taskId={group.taskId} />}
        titleClassName={time !== undefined ? SLIM_TITLE_LINK : undefined}
        meta={
          <>
            {publishedLabel(files.length)}
            {time !== undefined && (
              <span className="float-right ml-2 text-[11px] text-zinc-600">
                <TimeAgo ts={time} />
              </span>
            )}
          </>
        }
      >
        {/* A narrow card shows fewer thumbnails before "+N", so the strip stays one line. */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {files.slice(0, STRIP_MAX).map((f, i) => (
            <Thumb key={f.id} f={f} gallery={getGallery} className={i >= STRIP_MAX_NARROW ? "@max-md:hidden" : undefined} />
          ))}
          {moreChip(moreNarrow, "@md:hidden")}
          {moreChip(more, "@max-md:hidden")}
        </div>
        <div data-testid="published-files" className="mt-1">
          <div data-testid="published-files-header" className="flex min-w-0 items-center gap-2">
            {open ? (
              <span className="min-w-0 flex-1 truncate text-zinc-500">{files.length} files</span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-zinc-500" title={files.map((f) => f.title).join("\n")}>
                {files
                  .slice(0, 3)
                  .map((f) => f.title)
                  .join(" · ")}
                {files.length > 3 && ` · +${files.length - 3} more`}
              </span>
            )}
            {toggle}
          </div>
          {open && (
            <ul id={listId} className="mt-0.5 space-y-0.5">
              {files.map((f) => (
                <li key={f.id}>
                  <FileLink
                    href={f.url}
                    name={f.filename}
                    fileTitle={f.title}
                    gallery={getGallery}
                    className="-mx-1 flex min-h-11 items-center gap-1.5 rounded px-1 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 sm:min-h-0 sm:py-0.5"
                  >
                    {/* The icon stays on the first line of a title that wraps. */}
                    <span className="flex min-w-0 items-start gap-1.5">
                      <span className="flex h-lh shrink-0 items-center">
                        <KindIcon kind={kindOf(f)} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 wrap-anywhere">{f.title}</span>
                    </span>
                    {/* The file name only where the title still gets most of the row. */}
                    <span className="ml-auto shrink-0 pl-2 text-[10px] text-zinc-600 @max-md:hidden">{f.filename.length > 28 ? extOf(f) : f.filename}</span>
                  </FileLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </NoticeLayout>
    </div>
  )
}

/** The Coordinator chat's card (also Zen mode): a notice card that opens the task when clicked outside its links. */
export const PublishedCard = memo(
  function PublishedCard({ group }: { group: PublishedGroup }) {
    const body = <GroupBody group={group} project />
    return (
      <div id={`chat-${group.id}`}>
        {group.taskId ? (
          <NoticeCard taskId={group.taskId}>
            {body}
          </NoticeCard>
        ) : (
          <div className={NOTICE_CLASS}>{body}</div>
        )}
      </div>
    )
  },
  (a, b) => sameGroup(a.group, b.group),
)

/** The Captain tab's slim form, with the newest file's time and its other rows' title (CaptainTab's NoticeRow). */
export const PublishedRow = memo(
  function PublishedRow({ group }: { group: PublishedGroup }) {
    return (
      <div id={`captain-${group.id}`} className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900/60">
        <GroupBody group={group} time={group.files.at(-1)!.createdAt} />
      </div>
    )
  },
  (a, b) => sameGroup(a.group, b.group),
)
