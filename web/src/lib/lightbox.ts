// Images in chats and transcripts open in a lightbox. An image Box Yard hosts (an artifact, an upload) opens in the
// file preview, like an attached image, with its ←/→ gallery; any other image (a URL in a reply) opens in the
// plain lightbox (components/Lightbox.tsx). Plain functions, so a click handler opens it without re-rendering the
// message it sits in.
import { useSyncExternalStore } from "react"
import { isFilePath, isPlainClick, previewKind, type PreviewItem } from "./filePreview"
import type { ClickLike } from "./linkify"

export interface LightboxImage {
  src: string
  alt?: string
}

let image: LightboxImage | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function openLightbox(next: LightboxImage) {
  image = next
  emit()
}

export function closeLightbox() {
  if (!image) return
  image = null
  emit()
}

export const lightboxImage = () => image

export function useLightbox(): LightboxImage | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    lightboxImage,
    () => null,
  )
}

/** Where a click on an image goes: the file preview for a hosted file, the lightbox for the rest. */
export function imageTarget(src: string): "preview" | "lightbox" | null {
  if (!src || /^\s*(?:javascript|vbscript):/i.test(src)) return null
  const item: PreviewItem = { url: src }
  return isFilePath(src) && previewKind(item) ? "preview" : "lightbox"
}

/**
 * A click on an image in a chat. A plain click opens it; Cmd/Ctrl, Shift, Alt and middle clicks, and images that are
 * a link's content (the link goes where it points), are left alone. Returns whether it opened.
 */
export function clickImage(
  e: ClickLike & { target: EventTarget | null },
  image: LightboxImage,
  open: { preview: (src: string) => void; lightbox: (image: LightboxImage) => void },
): boolean {
  if (!isPlainClick(e)) return false
  if ((e.target as Element | null)?.closest?.("a[href]")) return false
  const target = imageTarget(image.src)
  if (!target) return false
  e.preventDefault()
  if (target === "preview") open.preview(image.src)
  else open.lightbox(image)
  return true
}
