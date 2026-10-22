import { FileText } from "lucide-react"
import { FileLink, PREVIEW_GROUP } from "./FileLink"
import type { Attachment } from "../../../shared/types"

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const isImage = (mime: string) => mime.startsWith("image/") && mime !== "image/svg+xml"

export const attachmentUrl = (f: Pick<Attachment, "id" | "name">) => `/api/uploads/${f.id}/${encodeURIComponent(f.name)}`

/** Attachments on a sent message: image thumbnails and chips for other files. A click opens the preview. */
export function AttachmentList({ files }: { files: unknown }) {
  if (!Array.isArray(files) || !files.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-2" {...PREVIEW_GROUP}>
      {(files as Attachment[]).map((f) => {
        const url = attachmentUrl(f)
        return isImage(f.mime) ? (
          <FileLink key={f.id} href={url} name={f.name} size={f.size} mime={f.mime} title={`${f.name} · ${formatSize(f.size)}`}>
            <img src={url} alt={f.name} className="max-h-32 max-w-[12rem] rounded-lg border border-zinc-800 object-cover" />
          </FileLink>
        ) : (
          <FileLink
            key={f.id}
            href={url}
            name={f.name}
            size={f.size}
            mime={f.mime}
            className="flex max-w-[14rem] items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-700"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="truncate">{f.name}</span>
            <span className="shrink-0 text-zinc-600">{formatSize(f.size)}</span>
          </FileLink>
        )
      })}
    </div>
  )
}
