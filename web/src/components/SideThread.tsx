// Side threads in a chat: highlight text in the Coordinator's (or a Captain's) chat, Ask, and the question is answered
// in a panel on the right, like a comment on a doc. Or Reply to a whole message: the replies stay out of the chat,
// which shows "↰ N replies" under the message, and open in the same panel (Slack's and Claude's threads). The thread
// sees the chat up to that message (server/sideThreads.ts) but shows only the message or highlight and the replies.
//
// The panel lives inside the chat's section, which is a `coord` container: from 35.5rem wide (a 125%-zoomed laptop; a 560px phone stays a sheet) it's a column beside the
// chat (the Coordinator's dock widens to make room, App.tsx), below that a full-height sheet over it.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MoreHorizontal,
  Reply,
  Search,
  Square,
  TextSearch,
  Trash2,
  Undo2,
  X,
} from "lucide-react"
import { COMPOSER_FOOTER, Composer } from "./Composer"
import { StickyScroll } from "./StickyScroll"
import { Modal } from "./Modal"
import { MessageMenu, type MenuItem } from "./MessageActions"
import { Button, LineIcon, Markdown, cx, inputClass } from "./ui"
import { quotePreview, trapKeys, useAnchor, useNarrow, type Align } from "./NewTask"
import { confirmDialog } from "../lib/confirm"
import { revealChatMessage } from "../lib/reveal"
import { newClientId } from "../lib/queries"
import {
  closeThread,
  forgetThread,
  openReply,
  openThread,
  toggleExpanded,
  useAskThread,
  useMessageThreads,
  useOpenThread,
  useSendThreadMessage,
  useThread,
  useThreadControl,
  useThreadMessages,
  useThreadStream,
  type OpenThread,
  type ThreadChat,
} from "../lib/threads"
import { caretAt, findQuoteRange, setOpenHighlight, setThreadRange, threadRange } from "../lib/threadHighlight"
import type { ChatMessage, SideThread, SideThreadMessage } from "../../../shared/types"

const ThreadChatContext = createContext<ThreadChat | null>(null)

/** Turns on side threads for the chat lines inside (ChatLine's markers, the Ask actions). */
export const ThreadChatProvider = ThreadChatContext.Provider
/** The chat whose lines these are, or null where there are no threads (a task's transcript). */
export const useThreadChat = () => useContext(ThreadChatContext)

/** Reply to a whole message in its reply thread (MessageActions' Reply); null where the chat has no threads. */
export function useReplyTo(): ((anchorId: string, text: string) => void) | null {
  const chat = useThreadChat()
  const qc = useQueryClient()
  const reply = useCallback((anchorId: string, text: string) => chat && openReply(qc, chat, anchorId, text), [qc, chat])
  return chat ? reply : null
}

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
 * The chat's open thread: a column on the right, or a sheet over the chat in a narrow panel (or when expanded).
 * `headerClassName` sizes its header like the chat's, so the two line up side by side.
 */
export function SideThreadPane({ chat, headerClassName = "min-h-12" }: { chat: ThreadChat; headerClassName?: string }) {
  const cur = useOpenThread(chat)
  const [shown, setShown] = useState(false)
  const id = cur?.id ?? null
  const closing = cur?.closing ?? false
  const expanded = Boolean(cur?.expanded)

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

  if (!id || !cur) return null
  return (
    <aside
      data-testid="side-thread"
      data-open={shown || undefined}
      data-expanded={expanded || undefined}
      aria-label="Thread"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return
        e.stopPropagation()
        closeThread(chat)
      }}
      style={{ "--thread-w": "clamp(17rem, calc(50cqw - 1rem), 26rem)" } as React.CSSProperties}
      className={cx(
        // A sheet over the chat, sliding in from the right...
        "absolute inset-0 z-30 flex translate-x-full flex-col bg-zinc-950 shadow-2xl shadow-black/60 transition-[translate,width] duration-300 ease-out data-open:translate-x-0 motion-reduce:transition-none",
        // ...or, in a wide panel, a column beside it that grows from nothing (the chat slides left as it does). Expanded, it stays a sheet over the whole chat.
        !expanded &&
          "@min-[35.5rem]/coord:static @min-[35.5rem]/coord:w-0 @min-[35.5rem]/coord:shrink-0 @min-[35.5rem]/coord:translate-x-0 @min-[35.5rem]/coord:overflow-hidden @min-[35.5rem]/coord:border-l @min-[35.5rem]/coord:border-zinc-800 @min-[35.5rem]/coord:shadow-none @min-[35.5rem]/coord:data-open:w-(--thread-w)",
      )}
    >
      {/* At its final width while the column grows, so the text doesn't reflow on every frame. */}
      <div className={cx("flex h-full min-h-0 w-full flex-col", !expanded && "@min-[35.5rem]/coord:w-(--thread-w)")}>
        <ThreadView key={id} chat={chat} open={cur} headerClassName={headerClassName} />
      </div>
    </aside>
  )
}

const NO_MESSAGES: SideThreadMessage[] = []

/** A message's first line as a title: no Markdown marks, at most a line. */
export function threadTitle(text: string) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ""
  return quotePreview(line.replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/, "").replace(/[*_`~]+/g, ""), 140)
}

export const repliesLabel = (n: number) => `${n} ${n === 1 ? "reply" : "replies"}`

function ThreadView({ chat, open, headerClassName }: { chat: ThreadChat; open: OpenThread; headerClassName: string }) {
  const id = open.id
  const draft = open.draft ?? null
  const saved = useThread(chat, id)
  const thread = saved ?? null
  const messages = useThreadMessages(id).data ?? NO_MESSAGES
  const send = useSendThreadMessage(chat, id)
  const start = useAskThread(chat)
  const control = useThreadControl(chat)
  const pane = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const busy = Boolean(thread?.busy)
  const reply = draft !== null || thread?.kind === "reply"
  const anchorId = thread?.anchorId ?? draft?.anchorId ?? null
  const original = thread?.quote ?? draft?.text ?? ""
  const resolved = thread?.resolvedAt != null
  const close = () => closeThread(chat)

  // Opened from Reply: straight to the composer.
  useEffect(() => {
    if (draft) input.current?.focus({ preventScroll: true })
  }, [draft])

  // Open: what it says is read (now, and as answers arrive).
  const unread = Boolean(thread?.unread)
  useEffect(() => {
    if (unread && !open.closing) control.seen(id)
  }, [unread, open.closing, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (text: string) => {
    const content = text.trim()
    if (!content) return
    if (!thread && draft) return start.mutateAsync({ id, messageId: newClientId("thm"), anchorId: draft.anchorId, quote: draft.text, question: content, kind: "reply" })
    return send.mutateAsync({ id: newClientId("thm"), content })
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: "Delete this thread?",
      body: reply ? "Its replies are deleted. The main chat isn't affected." : "Its question and replies are deleted, and the highlight goes. The main chat isn't affected.",
      confirmLabel: "Delete",
      danger: true,
    })
    if (ok) await control.remove(id)
  }
  const reveal = () => {
    if (!anchorId) return
    if (chat === "coordinator") return revealChatMessage(anchorId)
    document.querySelector(`[data-chat-id="${CSS.escape(anchorId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }
  const items: MenuItem[] = [
    { icon: TextSearch, label: "Show in the chat", run: reveal },
    ...(thread && busy ? [{ icon: Square, label: "Stop answering", run: () => control.stop(id) }] : []),
    ...(thread ? [{ icon: Trash2, label: "Delete thread", run: () => void remove() }] : []),
  ]

  const icon = "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 aria-expanded:bg-zinc-800 aria-pressed:text-yard-300 [@media(pointer:fine)]:h-8 [@media(pointer:fine)]:w-8"
  const wide = "hidden @min-[35.5rem]/coord:grid"
  return (
    <div ref={pane} className="relative flex h-full min-h-0 flex-col">
      <header className={cx(headerClassName, "flex shrink-0 items-center gap-1 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-2")}>
        {/* A sheet goes back to the chat; a column closes with the × on the right. */}
        <button type="button" onClick={close} aria-label="Back to the chat" title="Back to the chat" className={cx(icon, open.expanded ? "hidden" : "@min-[35.5rem]/coord:hidden")}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm @min-[35.5rem]/coord:pl-2">
          <span className="shrink-0 font-semibold text-zinc-100">Threads</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <span data-testid="side-thread-title" title={quotePreview(original, 400)} className="min-w-0 truncate text-zinc-400">
            {reply ? threadTitle(original) : `“${quotePreview(original, 140)}”`}
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-0.5">
          {thread && (
            <button
              type="button"
              data-testid="side-thread-resolve"
              onClick={() => void control.resolve(id, !resolved)}
              aria-pressed={resolved}
              aria-label={resolved ? "Reopen thread" : "Resolve thread"}
              title={resolved ? "Resolved. Reopen it" : "Resolve: fold it away under the message"}
              className={icon}
            >
              {resolved ? <Undo2 className="h-4 w-4" /> : <CircleCheck className="h-4 w-4" />}
            </button>
          )}
          <button ref={more} type="button" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="More thread actions" title="More" className={icon}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && <MessageMenu trigger={more} items={items} onClose={() => setMenu(false)} />}
          <button
            type="button"
            data-testid="side-thread-expand"
            onClick={() => toggleExpanded(chat)}
            aria-pressed={Boolean(open.expanded)}
            aria-label={open.expanded ? "Back beside the chat" : "Expand over the chat"}
            title={open.expanded ? "Back beside the chat" : "Expand over the chat"}
            className={cx(icon, wide)}
          >
            {open.expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={close} aria-label="Close thread" title="Close (Esc). It stays under the message." className={cx(icon, open.expanded ? "grid" : wide)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {!reply && thread && (
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
      <StickyScroll count={messages.length} resetKey={id} className={cx("px-3 py-3", open.expanded && "mx-auto w-full max-w-3xl")} contentClassName="space-y-3">
        {reply && (
          <div data-testid="side-thread-original" className="space-y-2.5">
            <div className="text-sm text-zinc-200">
              <Markdown>{original}</Markdown>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span className="shrink-0">{thread?.replies ? repliesLabel(thread.replies) : "No replies yet"}</span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
            {thread?.context === "summary" && <p className="text-[11px] leading-4 text-zinc-500">The chat was compacted since, so this thread started from the compaction summary and the messages up to this one.</p>}
          </div>
        )}
        {messages.map((m) => (
          <ThreadLine key={m.id} m={m} />
        ))}
        <ThreadStreaming id={id} busy={busy} />
      </StickyScroll>
      <Composer
        onSubmit={submit}
        files={false}
        textareaRef={input}
        placeholder={reply ? (busy ? "Queue another reply…" : "Reply…") : busy ? "Queue a follow-up…" : "Reply in this thread…"}
        panelRef={pane}
        className={cx(COMPOSER_FOOTER, "px-3", open.expanded && "mx-auto w-full max-w-3xl")}
      />
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
    <div data-testid="side-thread-working" role="status" className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-yard-400/80" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      Claude is working
    </div>
  )
}

// ---------------------------------------------------------------- markers on the chat

/**
 * Under a message with threads: "↰ N replies" for its reply thread, a chip per question about a highlight, and the
 * highlighted passages tinted in the text (a click on one opens its thread too). Nothing for a message without threads.
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
  const asks = useMemo(() => threads.filter((t) => t.kind !== "reply"), [threads])
  const replies = threads.find((t) => t.kind === "reply") ?? null
  const quotes = useMemo(() => asks.map((t) => [t.id, t.quote] as const), [asks])

  // Tint each question's passage. After the text renders, and again when it changes.
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
  const isOpen = (t: SideThread) => open?.id === t.id && !open.closing
  const toggle = (t: SideThread) => (isOpen(t) ? closeThread(chat) : openThread(chat, t.id))
  return (
    <div ref={row} data-thread-markers className={cx("mt-1.5 flex flex-wrap items-center gap-1.5", right && "justify-end")}>
      {replies && <RepliesButton t={replies} active={isOpen(replies)} onOpen={() => toggle(replies)} />}
      {asks.map((t) => (
        <ThreadChip key={t.id} t={t} active={isOpen(t)} onOpen={() => toggle(t)} />
      ))}
    </div>
  )
}

/** "↰ 2 replies" under a message: opens its reply thread. It says when an answer is coming, unread or resolved. */
function RepliesButton({ t, active, onOpen }: { t: SideThread; active: boolean; onOpen: () => void }) {
  const resolved = t.resolvedAt != null
  const state = t.busy ? "answering" : t.unread ? "new reply" : resolved ? "resolved" : null
  return (
    <button
      type="button"
      data-testid="thread-replies"
      data-unread={(t.unread && !t.busy) || undefined}
      data-resolved={resolved || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      aria-pressed={active}
      aria-label={`${repliesLabel(t.replies)}${state ? `, ${state}` : ""}`}
      title={active ? "Close the replies" : "Open the replies"}
      className={cx(
        "-ml-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs [@media(pointer:coarse)]:h-9",
        active ? "bg-yard-500/15 text-yard-100" : resolved && !t.unread && !t.busy ? "text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
      )}
    >
      <Reply className="h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-nowrap">{repliesLabel(t.replies)}</span>
      {t.busy ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-yard-300" aria-hidden />
      ) : t.unread ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yard-400" aria-hidden />
      ) : resolved ? (
        <CircleCheck className="h-3 w-3 shrink-0" aria-hidden />
      ) : null}
    </button>
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
