// Back-to-back "published" file notices as one compact card per task: the task, "published 6 files", a strip of
// small thumbnails (type chips for other files) and the first titles; "Show all" lists every file as a link row.
// Every file opens the preview modal, and ←/→ step through the whole group. Grouping is lib/publishedNotices.ts.
import { memo, useMemo, useState } from "react"
import { ChevronDown, Paperclip } from "lucide-react"
import { AppLink, LineIcon, META_CHIP, TimeAgo, cx } from "./ui"
import { FileLink } from "./FileLink"
import { KindIcon } from "./TaskFiles"
import { NOTICE_CLASS, NoticeCard } from "./ChatLine"
import { previewKind } from "../lib/filePreview"
import { previewGallery, publishedLabel, sameGroup, type PublishedFileRef, type PublishedGroup } from "../lib/publishedNotices"

/** Thumbnails shown before "+N" (fewer on phones, where they're bigger tap targets), so the strip stays one line. */
export const STRIP_MAX = 6
const STRIP_MAX_PHONE = 4

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

function GroupBody({ group, time }: { group: PublishedGroup; time?: number }) {
  const [open, setOpen] = useState(false)
  const files = group.files
  const gallery = useMemo(() => previewGallery(files), [files])
  const getGallery = () => gallery
  const more = files.length - STRIP_MAX
  const morePhone = files.length - STRIP_MAX_PHONE
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
      onClick={() => setOpen((o) => !o)}
      className={cx(META_CHIP, "ml-auto border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")}
    >
      {open ? "Hide" : "Show all"}
      <ChevronDown className={cx("h-3 w-3 transition-transform", open && "rotate-180")} />
    </button>
  )
  return (
    <div data-testid="published-group" data-count={files.length} className="flex min-w-0 items-start gap-2">
      <LineIcon icon={Paperclip} className="h-3.5 w-3.5 text-zinc-400" label="Files published" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-x-2">
          <div className="min-w-0 flex-1 wrap-anywhere">
            {group.taskId ? (
              <AppLink href={`/tasks/${group.taskId}`} className="font-semibold text-yard-400 underline decoration-yard-400/40 underline-offset-2 hover:decoration-yard-400">
                {group.taskTitle}
              </AppLink>
            ) : (
              <span className="font-semibold text-zinc-200">{group.taskTitle}</span>
            )}{" "}
            <span className="text-zinc-400">{publishedLabel(files.length)}</span>
            {time !== undefined && (
              <span className="ml-1.5 text-[11px] text-zinc-600">
                <TimeAgo ts={time} />
              </span>
            )}
          </div>
          {toggle}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {files.slice(0, STRIP_MAX).map((f, i) => (
            <Thumb key={f.id} f={f} gallery={getGallery} className={i >= STRIP_MAX_PHONE ? "max-sm:hidden" : undefined} />
          ))}
          {moreChip(morePhone, "sm:hidden")}
          {moreChip(more, "max-sm:hidden")}
        </div>
        {open ? (
          <ul className="mt-1.5 space-y-0.5">
            {files.map((f) => (
              <li key={f.id}>
                <FileLink
                  href={f.url}
                  name={f.filename}
                  fileTitle={f.title}
                  gallery={getGallery}
                  className="-mx-1 flex min-h-11 items-center gap-1.5 rounded px-1 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 sm:min-h-0 sm:py-0.5"
                >
                  <KindIcon kind={kindOf(f)} className="h-3.5 w-3.5" />
                  <span className="min-w-0 wrap-anywhere">{f.title}</span>
                  <span className="ml-auto shrink-0 pl-2 text-[10px] text-zinc-600 max-sm:hidden">{f.filename.length > 28 ? extOf(f) : f.filename}</span>
                </FileLink>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-1 truncate text-zinc-500" title={files.map((f) => f.title).join("\n")}>
            {files
              .slice(0, 3)
              .map((f) => f.title)
              .join(" · ")}
            {files.length > 3 && ` · +${files.length - 3} more`}
          </div>
        )}
      </div>
    </div>
  )
}

/** The Coordinator chat's card (also Zen mode): a notice card that opens the task when clicked outside its links. */
export const PublishedCard = memo(
  function PublishedCard({ group }: { group: PublishedGroup }) {
    const body = <GroupBody group={group} />
    return (
      <div id={`chat-${group.id}`}>
        {group.taskId ? <NoticeCard taskId={group.taskId}>{body}</NoticeCard> : <div className={NOTICE_CLASS}>{body}</div>}
      </div>
    )
  },
  (a, b) => sameGroup(a.group, b.group),
)

/** The Captain tab's slim form, with the newest file's time. */
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
