// The small toolbar on a chat message's top-right edge (as on claude.ai): respond, copy and a ··· menu. Respond opens
// the same New task popover a text selection does (SelectionToTask), with the whole message as the quote. With a mouse
// it shows on hover and keyboard focus; on touch a tap on the message shows it and a tap anywhere else hides it. It's
// absolutely placed inside the message (no overlay, no portal), so it never moves the layout or catches other taps.
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react"
import { createPortal } from "react-dom"
import { Check, Copy, MessageSquarePlus, MoreHorizontal, SlidersHorizontal, TextQuote, type LucideIcon } from "lucide-react"
import { useQuoteToTask } from "./SelectionToTask"
import { toast } from "../lib/toast"
import { cx } from "./ui"

/** The classes for the element a MessageActions sits in (a bubble, a reply, a notice card): the hover group and the toolbar's positioning box. */
export const MESSAGE_BLOCK = "group/msg relative"

/** What a tap on a message means by itself; tapping one of these inside it doesn't show the toolbar. */
const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role=button], [role=link], [role=menuitem]"

const BUTTON =
  "grid h-6 w-7 place-items-center [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-9 rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none aria-expanded:bg-zinc-800 aria-expanded:text-zinc-100"

/** Keeps the toolbar's clicks and keys from the row under it (a notice card opens its task, a notice row folds). */
const stop = (e: SyntheticEvent) => e.stopPropagation()

export const MessageActions = memo(function MessageActions({ text, className }: { text: string; className?: string }) {
  const quote = useQuoteToTask()
  const respond = useRef<HTMLButtonElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const [responding, setResponding] = useState(false)
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  /** Touch: shown by a tap on the message, until a tap anywhere else. */
  const [tapped, setTapped] = useState(false)

  useEffect(() => {
    const block = bar.current?.parentElement
    if (!block || !window.matchMedia?.("(hover: none)").matches) return
    const tap = (e: Event) => {
      const hit = (e.target as Element | null)?.closest?.(INTERACTIVE)
      if ((hit && hit !== block && block.contains(hit)) || !window.getSelection()?.isCollapsed) return
      setTapped(true)
    }
    block.addEventListener("click", tap)
    return () => block.removeEventListener("click", tap)
  }, [])

  useEffect(() => {
    if (!tapped) return
    const away = (e: Event) => {
      if (!bar.current?.parentElement?.contains(e.target as Node)) setTapped(false)
    }
    document.addEventListener("pointerdown", away, true)
    return () => document.removeEventListener("pointerdown", away, true)
  }, [tapped])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  if (!text.trim()) return null

  const copy = (value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => toast.error("Couldn't copy", "The browser blocked clipboard access."),
    )

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Message actions"
      data-message-actions
      data-open={responding || menu || tapped || undefined}
      onClick={stop}
      onAuxClick={stop}
      onKeyDown={stop}
      className={cx(
        // On the message's top edge, mostly in the gap above it, like claude.ai's.
        "absolute -top-3.5 right-2 z-10 flex items-center gap-px rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 shadow-lg shadow-black/40 transition-opacity",
        // Hidden (and not catching clicks) until the message is hovered, focused or tapped, or its popover is open.
        "pointer-events-none opacity-0",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 data-open:pointer-events-auto data-open:opacity-100",
        className,
      )}
    >
      {quote && (
        <button
          ref={respond}
          type="button"
          data-testid="message-respond"
          aria-haspopup="dialog"
          aria-expanded={responding}
          aria-label="Respond: new task from this message"
          title="Respond: new task from this message"
          onClick={() => {
            setMenu(false)
            setResponding(!responding)
            quote.open(text, respond.current!, () => setResponding(false))
          }}
          className={BUTTON}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" data-testid="message-copy" aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"} onClick={() => copy(text)} className={BUTTON}>
        {copied ? <Check className="h-3.5 w-3.5 text-yard-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        ref={more}
        type="button"
        data-testid="message-more"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="More message actions"
        title="More"
        onClick={() => setMenu(!menu)}
        className={BUTTON}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {menu && (
        <MessageMenu
          trigger={more}
          onClose={() => setMenu(false)}
          items={[
            ...(quote ? [{ icon: SlidersHorizontal, label: "New task with all options…", run: () => quote.dialog(text) }] : []),
            { icon: TextQuote, label: "Copy as quote", run: () => copy(quoteLines(text)) },
          ]}
        />
      )}
    </div>
  )
})

interface MenuItem {
  icon: LucideIcon
  label: string
  run: () => void
}

/** The ··· menu: in a portal (a transcript's scroller would clip it), under the button or above it when there's no room. */
function MessageMenu({ trigger, items, onClose }: { trigger: RefObject<HTMLButtonElement | null>; items: MenuItem[]; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const place = () => {
      const t = trigger.current?.getBoundingClientRect()
      const el = panel.current
      if (!t || !el) return
      const vw = document.documentElement.clientWidth || window.innerWidth
      const left = Math.max(8, Math.min(t.right - el.offsetWidth, vw - 8 - el.offsetWidth))
      const below = window.innerHeight - t.bottom - 12
      setStyle(el.offsetHeight > below && t.top > below ? { left, bottom: window.innerHeight - t.top + 4 } : { left, top: t.bottom + 4 })
    }
    place()
    panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true })
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [trigger])

  // A press anywhere else closes it; the ··· button toggles it itself.
  useEffect(() => {
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current()
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [trigger])

  const move = (e: KeyboardEvent) => {
    e.stopPropagation()
    const all = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault()
      onClose()
      trigger.current?.focus({ preventScroll: true })
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label="Message actions"
      style={style}
      onKeyDown={move}
      className="fixed z-40 w-max max-w-[calc(100vw-1rem)] min-w-48 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl shadow-black/50"
    >
      {items.map(({ icon: Icon, label, run }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            run()
          }}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm whitespace-nowrap text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:bg-zinc-800 focus-visible:outline-none sm:min-h-0 sm:py-1.5"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          {label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

/** The message as a Markdown quote, to paste into another chat. */
export function quoteLines(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}
