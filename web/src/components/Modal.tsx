// The one modal shell every dialog uses: portaled to <body>, centered over the whole viewport on a dimmed backdrop,
// a full-screen sheet on small screens. Esc closes the topmost modal, Tab stays inside it, and a backdrop click
// closes it unless there are unsaved changes.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cx } from "./ui"

export const MODAL_SIZES = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-[54rem]",
  /** File previews: images, HTML pages and PDFs. */
  full: "sm:max-w-[90vw]",
} as const

export type ModalSize = keyof typeof MODAL_SIZES

/** Open modals, oldest first. Only the last one reacts to Esc and Tab. */
const stack: string[] = []

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.checkVisibility?.() ?? true)
}

type ModalProps = {
  onClose: () => void
  size?: ModalSize
  /** Shown in the header with a close button. Without it, pass `label` and draw your own chrome. */
  title?: ReactNode
  description?: ReactNode
  /** Accessible name when there is no title. */
  label?: string
  /** Unsaved changes: a backdrop click won't close the dialog. Esc and the close button still call onClose. */
  dirty?: boolean
  /** "top" pins the panel near the top (the command palette); the default centers it. */
  placement?: "center" | "top"
  /** Renders the panel as a <form>, so the footer's submit button and Enter submit it. */
  onSubmit?: (e: FormEvent) => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
  /** Footer row, right-aligned (put Cancel before the primary action). */
  footer?: ReactNode
  /** Extra classes for the panel (e.g. a fixed height). */
  className?: string
  /** Extra classes for the body; the default pads it and scrolls it. */
  bodyClassName?: string
  children: ReactNode
}

export function Modal({
  onClose,
  size = "md",
  title,
  description,
  label,
  dirty,
  placement = "center",
  onSubmit,
  onKeyDown,
  footer,
  className,
  bodyClassName,
  children,
}: ModalProps) {
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  // Captured during render, before any autoFocus inside the dialog moves focus.
  const [previous] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)))
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    stack.push(id)
    const root = panel.current
    if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()

    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== id || e.defaultPrevented) return
      if (e.key === "Escape") {
        e.preventDefault()
        closeRef.current()
      } else if (e.key === "Tab" && panel.current) {
        const items = focusables(panel.current)
        if (!items.length) return e.preventDefault()
        const first = items[0]!
        const last = items.at(-1)!
        const inside = panel.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      stack.splice(stack.indexOf(id), 1)
      if (previous?.isConnected) previous.focus()
    }
  }, [id, previous])

  const Panel = onSubmit ? "form" : "div"

  // Portaled to <body>: the chat and sidebar columns use CSS transforms, which would trap a fixed overlay inside them.
  return createPortal(
    <div
      className={cx(
        "fixed inset-0 z-50 flex justify-center bg-black/60 backdrop-blur-sm p-[env(safe-area-inset-top)_env(safe-area-inset-right)_env(safe-area-inset-bottom)_env(safe-area-inset-left)] sm:p-4",
        placement === "top" ? "items-stretch sm:items-start sm:pt-[12vh]" : "items-stretch sm:items-center",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !dirty) onClose()
      }}
    >
      <Panel
        ref={panel as never}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? `${id}-title` : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        className={cx(
          "flex max-h-[100dvh] w-full flex-col overflow-hidden border-zinc-800 bg-zinc-950 shadow-2xl focus:outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:border",
          MODAL_SIZES[size],
          className,
        )}
      >
        {title && (
          <header className="flex shrink-0 items-start gap-3 border-b border-zinc-900 px-4 py-3.5 sm:px-5">
            <div className="min-w-0 flex-1">
              <h2 id={`${id}-title`} className="truncate text-base font-semibold text-zinc-50">
                {title}
              </h2>
              {description && <p className="text-xs text-zinc-500">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-my-2 -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 sm:my-0 sm:mr-0 sm:h-8 sm:w-8" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </header>
        )}
        <div className={bodyClassName ?? "scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5"}>{children}</div>
        {footer && <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-zinc-900 px-4 py-3 max-sm:[&>button]:w-full max-sm:[&>div]:w-full sm:flex-row sm:items-center sm:justify-end sm:px-5">{footer}</footer>}
      </Panel>
    </div>,
    document.body,
  )
}
