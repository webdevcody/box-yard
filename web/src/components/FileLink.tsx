// A link to a server-hosted file. A plain click on a file the app can show opens the preview modal; Cmd/Ctrl,
// Shift or middle clicks and "copy link" behave like a normal new-tab link.
import type { ComponentProps, MouseEvent } from "react"
import { interceptPreviewClick, isFilePath, previewKind, type PreviewItem } from "../lib/filePreview"
import { openPreview } from "../lib/preview"
import type { Artifact } from "../../../shared/types"

/** Previewable links inside the same `[data-preview-group]` (a message, a file list) form the ←/→ gallery. */
export const PREVIEW_GROUP = { "data-preview-group": "" }

/** The images next to `anchor` in its group, in page order, for stepping through with ←/→. */
export function galleryFor(anchor: HTMLElement, item: PreviewItem): PreviewItem[] {
  if (previewKind(item) !== "image") return [item]
  const group = anchor.closest("[data-preview-group]")
  if (!group) return [item]
  const seen = new Set<string>()
  const items: PreviewItem[] = []
  for (const a of group.querySelectorAll<HTMLAnchorElement>('a[data-preview="image"]')) {
    const url = a.getAttribute("href") ?? ""
    if (seen.has(url)) continue
    seen.add(url)
    const size = Number(a.dataset.previewSize)
    items.push({ url, name: a.dataset.previewName, mime: a.dataset.previewMime, size: Number.isFinite(size) && size > 0 ? size : undefined })
  }
  return items.some((g) => g.url === item.url) ? items : [item]
}

type FileLinkProps = Omit<ComponentProps<"a">, "href"> & {
  href: string
  /** File name, when the URL's last segment isn't it. */
  name?: string
  size?: number
  mime?: string
  /** An artifact's title, shown in the preview header. */
  fileTitle?: string
  /** What ←/→ step through, when it isn't the images around the link (e.g. every file of a task). */
  gallery?: () => PreviewItem[]
}

export function FileLink({ href, name, size, mime, fileTitle, gallery, onClick, children, ...rest }: FileLinkProps) {
  const item: PreviewItem = { url: href, name, size, mime, title: fileTitle }
  const kind = isFilePath(href) ? previewKind(item) : null
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    const anchor = e.currentTarget
    // Inside a card that is itself a link, open the file and not the card.
    if (interceptPreviewClick(e, item, (it) => openPreview(it, gallery?.() ?? galleryFor(anchor, it)))) e.stopPropagation()
  }
  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
      href={href}
      onClick={click}
      data-preview={kind ?? undefined}
      data-preview-name={kind ? name : undefined}
      data-preview-size={kind && size ? size : undefined}
      data-preview-mime={kind ? mime : undefined}
    >
      {children}
    </a>
  )
}

/** A FileLink for a published artifact, carrying its name, size and type into the preview. */
export function ArtifactLink({ artifact: a, ...rest }: Omit<FileLinkProps, "href" | "name" | "size" | "mime" | "fileTitle"> & { artifact: Artifact }) {
  return <FileLink {...rest} href={a.url} name={a.filename} size={a.size} mime={a.mime} fileTitle={a.title} />
}
