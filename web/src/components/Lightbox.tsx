// The image lightbox (lib/lightbox.ts): one image in the shared Modal, centered and fit to the screen, with a link to
// the original. Esc, the backdrop, a click beside the image or ✕ closes it. Mounted once as <LightboxHost>.
import { useState, type MouseEvent } from "react"
import { ImageOff, X } from "lucide-react"
import { Modal } from "./Modal"
import { NewTabLink, cx } from "./ui"
import { fileNameOf } from "../lib/filePreview"
import { closeLightbox, useLightbox, type LightboxImage } from "../lib/lightbox"

export function LightboxHost() {
  const image = useLightbox()
  if (!image) return null
  return <Lightbox key={image.src} image={image} />
}

function Lightbox({ image }: { image: LightboxImage }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const name = image.alt?.trim() || fileNameOf(image.src) || "Image"
  // A click on the dark space around the image closes it too (on a phone the modal is the whole screen, no backdrop).
  const outside = (e: MouseEvent) => {
    if (e.target === e.currentTarget) closeLightbox()
  }
  return (
    <Modal size="full" label={name} onClose={closeLightbox} className="sm:w-auto sm:min-w-[20rem]" bodyClassName="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-zinc-900 py-2 pr-2 pl-4 sm:pr-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-50" title={name}>
          {name}
        </h2>
        <NewTabLink href={image.src} mark="end" className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-sky-300 hover:bg-zinc-800 sm:min-h-8">
          Open original
        </NewTabLink>
        <button
          type="button"
          onClick={closeLightbox}
          aria-label="Close (Esc)"
          title="Close (Esc)"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-8 sm:w-8"
        >
          <X className="h-5 w-5" />
        </button>
      </header>
      <div data-testid="lightbox-stage" onClick={outside} className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-4">
        {status === "error" ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-zinc-400">
            <ImageOff className="h-6 w-6 text-zinc-600" aria-hidden />
            Couldn't load this image.
          </div>
        ) : (
          <img
            src={image.src}
            alt={image.alt ?? ""}
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
            // The whole screen less the header and padding: never taller or wider than the window.
            className={cx("max-h-[calc(100dvh-7rem)] max-w-full object-contain select-none sm:max-h-[calc(100dvh-9rem)]", status !== "ready" && "opacity-0")}
          />
        )}
      </div>
    </Modal>
  )
}
