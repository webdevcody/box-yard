// Side threads in a chat: highlight text in the Coordinator's (or a Captain's) chat, Ask, and the question is answered
// in a panel on the right, like a comment on a doc. The thread sees the chat up to the highlighted message
// (server/sideThreads.ts) but shows only the highlight, the question and the replies.
//
// The panel lives inside the chat's section, which is a `coord` container: from 35.5rem wide (a 125%-zoomed laptop; a 560px phone stays a sheet) it's a column beside the
// chat (the Coordinator's dock widens to make room, App.tsx), below that a full-height sheet over it.
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, ChevronLeft, Loader2, MessageCircle, Search, Square, Trash2, X } from "lucide-react"
import { COMPOSER_FOOTER, Composer } from "./Composer"
import { StickyScroll } from "./StickyScroll"
import { Modal } from "./Modal"
import { Button, LineIcon, Markdown, cx, inputClass } from "./ui"
import { quotePreview, trapKeys, useAnchor, useNarrow, type Align } from "./NewTask"
import { confirmDialog } from "../lib/confirm"
import { revealChatMessage } from "../lib/reveal"
import { newClientId } from "../lib/queries"
import {
  closeThread,
  forgetThread,
  openThread,
  useMessageThreads,
  useOpenThread,
  useSendThreadMessage,
  useThread,
  useThreadControl,
  useThreadMessages,
  useThreadStream,
  type ThreadChat,
} from "../lib/threads"
import { caretAt, findQuoteRange, setOpenHighlight, setThreadRange, threadRange } from "../lib/threadHighlight"
import type { ChatMessage, SideThread, SideThreadMessage } from "../../../shared/types"

const ThreadChatContext = createContext<ThreadChat | null>(null)

/** Turns on side threads for the chat lines inside (ChatLine's markers, the Ask actions). */
export const ThreadChatProvider = ThreadChatContext.Provider
/** The chat whose lines these are, or null where there are no threads (a task's transcript). */
export const useThreadChat = () => useContext(ThreadChatContext)

/** How long the panel takes to slide in or out; it unmounts after this. */
const SLIDE_MS = 300

// ---------------------------------------------------------------- the Ask popover

/**
 * The small prompt box an Ask opens: the highlight and a question. Enter asks. It hangs from `trigger` (the Ask
 * button, or a spot where the selection's button was); on a phone it's a bottom sheet.
 */
export function AskPopover({
  trigger,
  quote,
  align = "center",
  onAsk,
  onClose,
}: {
  trigger: RefObject<HTMLElement | null>
  quote: string
  align?: Align
  onAsk: (question: string) => void
  /** `refocus`: put focus back on the trigger (Esc); not after a click elsewhere. */
  onClose: (refocus: boolean) => void
}) {
  const narrow = useNarrow()
  const [text, setText] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pos = useAnchor(trigger, panel, !narrow, align)

  useEffect(() => {
    if (narrow) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current(false)
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [narrow, trigger])

  useLayoutEffect(() => input.current?.focus(), [narrow])

  const submit = () => {
    const question = text.trim()
    if (!question) return
    onClose(false)
    onAsk(question)
  }

  const form = (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <blockquote data-testid="ask-quote" title={quote} className="rounded-lg border border-zinc-800 border-l-2 border-l-yard-500/60 bg-zinc-900/60 px-3 py-2 text-xs leading-5 wrap-anywhere text-zinc-400">
        <span className="line-clamp-2">{quotePreview(quote)}</span>
      </blockquote>
      <textarea
        ref={input}
        rows={2}
        value={text}
        aria-label="Your question"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Ask about this…"
        className={cx(inputClass, "scroll-thin block max-h-40 resize-none leading-6 sm:leading-5")}
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-zinc-500">Answered in a side thread. The main chat doesn't see it.</span>
        <Button type="submit" variant="primary" size="sm" className="ml-auto shrink-0" disabled={!text.trim()}>
          Ask
        </Button>
      </div>
    </form>
  )

  if (narrow)
    return (
      <Modal placement="sheet" title="Ask about this" onClose={() => onClose(true)} bodyClassName="px-4 pt-3 pb-4">
        {form}
      </Modal>
    )

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Ask about this"
      data-testid="ask-popover"
      tabIndex={-1}
      style={pos}
      onKeyDown={(e) => trapKeys(e, panel.current, () => onClose(true))}
      className="fixed z-40 flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-black/50 focus:outline-none"
    >
      {form}
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- the panel

/**
 * The chat's open thread: a column on the right, or a sheet over the chat in a narrow panel. `headerClassName` sizes
 * its header like the chat's, so the two line up side by side.
 */
export function SideThreadPane({ chat, headerClassName = "min-h-12" }: { chat: ThreadChat; headerClassName?: string }) {
  const cur = useOpenThread(chat)
  const [shown, setShown] = useState(false)
  const id = cur?.id ?? null
  const closing = cur?.closing ?? false

  // Mounted closed, then opened a frame later, so it slides in.
  useEffect(() => {
    if (!id || closing) return setShown(false)
    let f = requestAnimationFrame(() => (f = requestAnimationFrame(() => setShown(true))))
    return () => cancelAnimationFrame(f)
  }, [id, closing])

  // Gone once it slid away.
  useEffect(() => {
    if (!id || !closing) return
    const t = setTimeout(() => forgetThread(chat, id), SLIDE_MS)
    return () => clearTimeout(t)
  }, [chat, id, closing])

  useEffect(() => {
    if (!id || closing) return
    setOpenHighlight(id, true)
    return () => setOpenHighlight(id, false)
  }, [id, closing])

  if (!id) return null
  return (
    <aside
      data-testid="side-thread"
      data-open={shown || undefined}
      aria-label="Side thread"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return
        e.stopPropagation()
        closeThread(chat)
      }}
      style={{ "--thread-w": "clamp(17rem, calc(50cqw - 1rem), 26rem)" } as React.CSSProperties}
      className={cx(
        // A sheet over the chat, sliding in from the right...
        "absolute inset-0 z-30 flex translate-x-full flex-col bg-zinc-950 shadow-2xl shadow-black/60 transition-[translate,width] duration-300 ease-out data-open:translate-x-0 motion-reduce:transition-none",
        // ...or, in a wide panel, a column beside it that grows from nothing (the chat slides left as it does).
        "@min-[35.5rem]/coord:static @min-[35.5rem]/coord:w-0 @min-[35.5rem]/coord:shrink-0 @min-[35.5rem]/coord:translate-x-0 @min-[35.5rem]/coord:overflow-hidden @min-[35.5rem]/coord:border-l @min-[35.5rem]/coord:border-zinc-800 @min-[35.5rem]/coord:shadow-none @min-[35.5rem]/coord:data-open:w-(--thread-w)",
      )}
    >
      {/* At its final width while the column grows, so the text doesn't reflow on every frame. */}
      <div className="flex h-full min-h-0 w-full flex-col @min-[35.5rem]/coord:w-(--thread-w)">
        <ThreadView key={id} chat={chat} id={id} headerClassName={headerClassName} />
      </div>
    </aside>
  )
}

const NO_MESSAGES: SideThreadMessage[] = []

function ThreadView({ chat, id, headerClassName }: { chat: ThreadChat; id: string; headerClassName: string }) {
  const thread = useThread(chat, id)
  const messages = useThreadMessages(id).data ?? NO_MESSAGES
  const send = useSendThreadMessage(chat, id)
  const control = useThreadControl(chat)
  const pane = useRef<HTMLDivElement>(null)
  const busy = Boolean(thread?.busy)
  const close = () => closeThread(chat)

  const submit = (text: string) => {
    const content = text.trim()
    if (!content) return
    return send.mutateAsync({ id: newClientId("thm"), content })
  }
  const remove = async () => {
    const ok = await confirmDialog({ title: "Delete this thread?", body: "Its question and replies are deleted, and the highlight goes. The main chat isn't affected.", confirmLabel: "Delete", danger: true })
    if (ok) await control.remove(id)
  }
  const reveal = () => {
    if (!thread) return
    if (chat === "coordinator") return revealChatMessage(thread.anchorId)
    document.querySelector(`[data-chat-id="${CSS.escape(thread.anchorId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }

  const icon = "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-8 sm:w-8"
  return (
    <div ref={pane} className="relative flex h-full min-h-0 flex-col">
      <header className={cx(headerClassName, "flex shrink-0 items-center gap-1 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-2")}>
        {/* A sheet goes back to the chat; a column closes with the × on the right. */}
        <button type="button" onClick={close} aria-label="Back to the chat" title="Back to the chat" className={cx(icon, "@min-[35.5rem]/coord:hidden")}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-100 @min-[35.5rem]/coord:pl-2">
          <MessageCircle className="h-4 w-4 shrink-0 text-yard-300" />
          <span className="truncate">Side thread</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {busy && (
            <button type="button" onClick={() => control.stop(id)} aria-label="Stop" title="Stop" className={icon}>
              <Square className="h-3.5 w-3.5" />
            </button>
          )}
          <button type="button" onClick={() => void remove()} aria-label="Delete thread" title="Delete thread" className={cx(icon, "hover:text-red-300")}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={close} aria-label="Close thread" title="Close (Esc). It stays on the highlight." className={cx(icon, "hidden @min-[35.5rem]/coord:grid")}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {thread && (
        <div className="shrink-0 border-b border-zinc-900 px-3 py-2.5">
          <button
            type="button"
            onClick={reveal}
            title="Show it in the chat"
            data-testid="side-thread-quote"
            className="block w-full rounded-lg border border-zinc-800 border-l-2 border-l-yard-500/70 bg-zinc-900/60 px-3 py-2 text-left text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-zinc-300 hover:border-zinc-700"
          >
            <span className="line-clamp-4">{thread.quote}</span>
          </button>
          {thread.context === "summary" && (
            <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">The chat was compacted since, so this thread started from the compaction summary and the messages up to the highlight.</p>
          )}
        </div>
      )}
      <StickyScroll count={messages.length} resetKey={id} className="px-3 py-3" contentClassName="space-y-3">
        {messages.map((m) => (
          <ThreadLine key={m.id} m={m} />
        ))}
        <ThreadStreaming id={id} busy={busy} />
      </StickyScroll>
      <Composer onSubmit={submit} files={false} placeholder={busy ? "Queue a follow-up…" : "Reply in this thread…"} panelRef={pane} className={cx(COMPOSER_FOOTER, "px-3")} />
    </div>
  )
}

const ThreadLine = memo(function ThreadLine({ m }: { m: SideThreadMessage }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className={cx("max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100", m.meta?.pending ? "opacity-70" : "")}>{m.content}</div>
      </div>
    )
  if (m.role === "tool")
    return (
      <div className="flex items-start gap-1.5 pl-1 text-xs text-zinc-500">
        <LineIcon icon={Search} className="h-3.5 w-3.5" />
        <span className="min-w-0 wrap-anywhere">
          Used <span className="font-mono text-zinc-400">{m.content}</span>
        </span>
      </div>
    )
  if (m.role === "error")
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
        <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">{m.content}</div>
      </div>
    )
  return (
    <div data-testid="side-thread-reply" className="text-sm text-zinc-200">
      <Markdown>{m.content}</Markdown>
    </div>
  )
})

function ThreadStreaming({ id, busy }: { id: string; busy: boolean }) {
  const stream = useThreadStream(id).data
  if (stream)
    return (
      <div className="text-sm text-zinc-200">
        <Markdown live>{stream}</Markdown>
      </div>
    )
  if (!busy) return null
  return (
    <div className="flex gap-1 px-1 py-2" aria-label="Answering">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- markers on the chat

/**
 * Under a message with threads: a chip per thread that opens it, and the highlighted passages tinted in the text
 * (a click on one opens its thread too). Nothing at all for a message without threads.
 */
export const ThreadMarkers = memo(function ThreadMarkers({ m }: { m: ChatMessage }) {
  const chat = useThreadChat()
  if (!chat) return null
  return <Markers chat={chat} m={m} />
})

function Markers({ chat, m }: { chat: ThreadChat; m: ChatMessage }) {
  const threads = useMessageThreads(chat, m.id)
  const open = useOpenThread(chat)
  const row = useRef<HTMLDivElement>(null)
  const quotes = useMemo(() => threads.map((t) => [t.id, t.quote] as const), [threads])

  // Tint each thread's passage. After the text renders, and again when it changes.
  useLayoutEffect(() => {
    const root = row.current?.closest("[data-chat-id]")
    if (!root) return
    for (const [id, quote] of quotes) setThreadRange(id, findQuoteRange(root, quote))
    return () => {
      for (const [id] of quotes) setThreadRange(id, null)
    }
  }, [quotes, m.content])

  // A click (not a drag that selects) on a tinted passage opens its thread.
  useEffect(() => {
    const root = row.current?.closest("[data-chat-id]")
    if (!root || !quotes.length) return
    const click = (e: Event) => {
      const ev = e as MouseEvent
      if (!window.getSelection()?.isCollapsed || (ev.target as Element | null)?.closest?.("a, button")) return
      const at = caretAt(ev.clientX, ev.clientY)
      if (!at) return
      const hit = quotes.find(([id]) => {
        const r = threadRange(id)
        try {
          return r && r.isPointInRange(at.node, at.offset)
        } catch {
          return false
        }
      })
      if (hit) openThread(chat, hit[0])
    }
    root.addEventListener("click", click)
    return () => root.removeEventListener("click", click)
  }, [chat, quotes])

  if (!threads.length) return null
  const right = m.role === "user"
  return (
    <div ref={row} data-thread-markers className={cx("mt-1.5 flex flex-wrap gap-1.5", right && "justify-end")}>
      {threads.map((t) => (
        <ThreadChip key={t.id} t={t} active={open?.id === t.id && !open.closing} onOpen={() => (open?.id === t.id && !open.closing ? closeThread(chat) : openThread(chat, t.id))} />
      ))}
    </div>
  )
}

function ThreadChip({ t, active, onOpen }: { t: SideThread; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="thread-marker"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      aria-pressed={active}
      title={active ? "Close this side thread" : "Open this side thread"}
      className={cx(
        "inline-flex h-11 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs sm:h-6",
        active ? "border-yard-400/60 bg-yard-500/15 text-yard-100" : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
      )}
    >
      {t.busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <MessageCircle className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 truncate">“{quotePreview(t.quote, 48)}”</span>
    </button>
  )
}
