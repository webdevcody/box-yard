// Select text in a chat or transcript and "Start new task" turns it into work: the shared New task popover opens
// with the quote and a box for instructions. Enter sends both to whoever routes the work (the Coordinator, or the
// project's Captain in its chat); "More options" starts the task directly from the full New task dialog.
// A message's own toolbar (MessageActions) opens the same popover on the whole message through useQuoteToTask.
// In a chat with side threads (useThreadChat), "Ask" sits beside it: a question about the selection, answered in a
// side thread (SideThread.tsx); the toolbar's Ask does the same for the whole message through useAskAbout.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react"
import { MessageCircleQuestion, MessageSquarePlus } from "lucide-react"
import { buildSelectionTaskBrief, buildSelectionTaskPrompt, selectionTarget, type SelectionTaskSource } from "../lib/selectionTask"
import { saveDraft, selectionScope } from "../lib/newTask"
import { toast } from "../lib/toast"
import { useOwnerName } from "../lib/queries"
import { NewTaskDialog, NewTaskPopover } from "./NewTask"
import { AskPopover, useThreadChat } from "./SideThread"
import { COORDINATOR_CHAT, newThreadIds, useAskThread } from "../lib/threads"

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface SelectionInfo {
  text: string
  x: number
  y: number
  /** The chat message the selection ends in (`data-chat-id`), which a side thread on it hangs off. */
  anchorId: string | null
}

/** A popover opened from a selection hangs from where its action button was; a message's hangs from its own button. */
type Draft = { text: string; whole: false; rect: Rect } | { text: string; whole: true; trigger: RefObject<HTMLElement | null>; onClose?: () => void }

export interface QuoteToTask {
  /** The New task popover on the whole message `text`, hanging from `trigger`; pressing the same trigger again closes it. */
  open: (text: string, trigger: HTMLElement, onClose?: () => void) => void
  /** Straight to the full New task dialog with the message (the toolbar's "More options"). */
  dialog: (text: string) => void
}

const QuoteContext = createContext<QuoteToTask | null>(null)

/** What a message's toolbar calls; null outside a SelectionToTask or where there's nowhere to send (no source yet). */
export const useQuoteToTask = () => useContext(QuoteContext)

/** A question about a whole message in a side thread: the Ask popover hangs from `trigger`. */
export interface AskAbout {
  open: (text: string, anchorId: string, trigger: HTMLElement, onClose?: () => void) => void
}

const AskContext = createContext<AskAbout | null>(null)

/** What a message's toolbar calls to Ask; null where the chat has no side threads. */
export const useAskAbout = () => useContext(AskContext)

/** The Ask popover is open on a selection (hanging from where its button was) or on a whole message. */
type AskDraft = { text: string; anchorId: string; rect: Rect; trigger?: undefined; onClose?: undefined } | { text: string; anchorId: string; rect?: undefined; trigger: HTMLElement; onClose?: () => void }

export function SelectionToTask({
  source,
  onPrompt,
  children,
}: {
  source: SelectionTaskSource | null
  onPrompt: (prompt: string) => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** The popover is open on this selection or message. */
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** "More options": the full New task dialog for this selection and the instructions typed so far. */
  const [dialog, setDialog] = useState<{ text: string; instructions: string } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const popoverId = useId()
  const ownerName = useOwnerName()
  const threadChat = useThreadChat()
  const askThread = useAskThread(threadChat ?? COORDINATOR_CHAT)
  const [ask, setAsk] = useState<AskDraft | null>(null)
  const askRef = useRef(ask)
  askRef.current = ask
  /** Where the selection's Ask button was; a message's Ask hangs from the toolbar button itself. */
  const askSpot = useRef<HTMLSpanElement>(null)
  const askTrigger = useMemo(() => ({ current: ask?.trigger ?? null }), [ask?.trigger])
  const canAsk = Boolean(threadChat && selection?.anchorId)

  useEffect(() => {
    const update = () => {
      if (!source && !threadChat) return setSelection(null)
      const info = readSelection(root.current)
      setSelection(info)
    }
    const clearIfOutside = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || root.current?.contains(target) || document.querySelector("[data-selection-task-action]")?.contains(target)) return
      setSelection(null)
    }
    document.addEventListener("selectionchange", update)
    window.addEventListener("keyup", update)
    window.addEventListener("pointerup", update)
    window.addEventListener("touchend", update)
    window.addEventListener("pointerdown", clearIfOutside)
    window.addEventListener("scroll", update, true)
    return () => {
      document.removeEventListener("selectionchange", update)
      window.removeEventListener("keyup", update)
      window.removeEventListener("pointerup", update)
      window.removeEventListener("touchend", update)
      window.removeEventListener("pointerdown", clearIfOutside)
      window.removeEventListener("scroll", update, true)
    }
  }, [source, threadChat])

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (!selection) return
    const r = e.currentTarget.getBoundingClientRect()
    setAsk(null)
    setDraft({ text: selection.text, whole: false, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    setSelection(null)
  }

  const openAsk = (e: MouseEvent<HTMLButtonElement>) => {
    if (!selection?.anchorId) return
    const r = e.currentTarget.getBoundingClientRect()
    setDraft(null)
    setAsk({ text: selection.text, anchorId: selection.anchorId, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    setSelection(null)
  }

  const closeAsk = useCallback((refocus = false) => {
    const a = askRef.current
    a?.onClose?.()
    if (refocus) a?.trigger?.focus({ preventScroll: true })
    setAsk(null)
  }, [])

  const askAbout = useMemo<AskAbout>(
    () => ({
      open: (text, anchorId, el, onClose) => {
        const a = askRef.current
        closeAsk()
        if (a?.trigger === el) return
        setDraft(null)
        setSelection(null)
        setAsk({ text, anchorId, trigger: el, onClose })
      },
    }),
    [closeAsk],
  )

  const sendAsk = (question: string) => {
    const a = askRef.current
    if (!a) return
    askThread.mutate({ ...newThreadIds(), anchorId: a.anchorId, quote: a.text, question })
    window.getSelection()?.removeAllRanges()
  }

  /** Closes the popover; a message's toolbar hears it, and Esc puts focus back on its button (never the composer). */
  const close = useCallback((refocus = false) => {
    const d = draftRef.current
    if (d?.whole) {
      d.onClose?.()
      if (refocus) d.trigger.current?.focus({ preventScroll: true })
    }
    setDraft(null)
  }, [])

  const finish = () => {
    close()
    window.getSelection()?.removeAllRanges()
  }

  // Stable, so the memo'd message rows that read it never re-render for it.
  const quote = useMemo<QuoteToTask>(
    () => ({
      open: (text, el, onClose) => {
        const d = draftRef.current
        close()
        if (d?.whole && d.trigger.current === el) return
        setAsk(null)
        setSelection(null)
        setDraft({ text, whole: true, trigger: { current: el }, onClose })
      },
      dialog: (text) => {
        close()
        setDialog({ text, instructions: "" })
      },
    }),
    [close],
  )

  return (
    <div ref={root} className="contents">
      <QuoteContext.Provider value={source ? quote : null}>
        <AskContext.Provider value={threadChat ? askAbout : null}>{children}</AskContext.Provider>
      </QuoteContext.Provider>
      {selection && !draft && !ask && (source || canAsk) && (
        <>
          {/* Pressing these keeps the selection and the focus where they are (never the composer's). */}
          <div
            data-selection-task-action
            className="fixed z-40 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-yard-400/50 bg-zinc-900/95 p-0.5 shadow-lg shadow-black/40 backdrop-blur [@media(pointer:fine)]:flex"
            style={{ left: selection.x, top: selection.y }}
          >
            {canAsk && (
              <button type="button" data-testid="selection-ask" aria-haspopup="dialog" onMouseDown={(e) => e.preventDefault()} onClick={openAsk} className={PILL}>
                <MessageCircleQuestion className="h-3.5 w-3.5" /> Ask
              </button>
            )}
            {source && (
              <button type="button" aria-haspopup="dialog" onMouseDown={(e) => e.preventDefault()} onClick={open} className={PILL}>
                <MessageSquarePlus className="h-3.5 w-3.5" /> Start new task
              </button>
            )}
          </div>
          <div data-selection-task-action className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex gap-2 [@media(pointer:fine)]:hidden">
            {canAsk && (
              <button type="button" aria-haspopup="dialog" onMouseDown={(e) => e.preventDefault()} onClick={openAsk} className={BAR}>
                <MessageCircleQuestion className="h-4 w-4 shrink-0" /> Ask
              </button>
            )}
            {source && (
              <button type="button" aria-haspopup="dialog" onMouseDown={(e) => e.preventDefault()} onClick={open} className={BAR}>
                <MessageSquarePlus className="h-4 w-4 shrink-0" /> {canAsk ? "New task" : "Start new task from selection"}
              </button>
            )}
          </div>
        </>
      )}
      {ask && (
        <>
          {ask.rect && <span ref={askSpot} aria-hidden className="pointer-events-none fixed" style={ask.rect} />}
          <AskPopover key={ask.trigger ? ask.anchorId : "selection"} trigger={ask.trigger ? askTrigger : askSpot} quote={ask.text} align={ask.trigger ? "end" : "center"} onAsk={sendAsk} onClose={closeAsk} />
        </>
      )}
      {source && draft && (
        <>
          {/* Where the action button was: the popover hangs from it (the button itself goes once the selection does). */}
          {!draft.whole && <span ref={anchor} aria-hidden className="pointer-events-none fixed" style={draft.rect} />}
          <NewTaskPopover
            key={draft.whole ? draft.text : "selection"}
            id={popoverId}
            trigger={draft.whole ? draft.trigger : anchor}
            heading={draft.whole ? "New task from message" : "New task from selection"}
            quote={draft.text}
            placeholder="Additional instructions (optional)"
            scope={selectionScope(draft.text)}
            align={draft.whole ? "end" : "center"}
            defaultProjectId={source.project?.id}
            onStart={(instructions) => {
              onPrompt(buildSelectionTaskPrompt({ source, selectedText: draft.text, instructions, ownerName }))
              finish()
              toast.info(`Sent to ${selectionTarget(source)}`, "It will decide where this task belongs.")
            }}
            onClose={close}
            onMore={(_, instructions) => {
              setDialog({ text: draft.text, instructions })
              close()
            }}
          />
        </>
      )}
      {source && dialog && (
        <NewTaskDialog
          projectId={source.project?.id}
          initialPrompt={buildSelectionTaskBrief({ source, selectedText: dialog.text, instructions: dialog.instructions })}
          onCancel={() => setDialog(null)}
          onDone={() => {
            saveDraft(selectionScope(dialog.text), "")
            setDialog(null)
            finish()
          }}
        />
      )}
    </div>
  )
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-yard-200 hover:bg-zinc-800 hover:text-yard-100 focus:ring-2 focus:ring-yard-500 focus:outline-none"
const BAR =
  "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl border border-yard-400/50 bg-zinc-900/95 px-4 py-3 text-sm font-medium text-yard-100 shadow-2xl shadow-black/50 backdrop-blur"

function readSelection(root: HTMLElement | null): SelectionInfo | null {
  if (!root) return null
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ""
  if (!sel || sel.rangeCount === 0 || text.length < 3) return null
  const range = sel.getRangeAt(0)
  if (!contains(root, range.commonAncestorContainer)) return null
  const rect = usefulRect(range)
  if (!rect) return null
  const message = (node: Node) => (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest?.("[data-chat-id]")
  return {
    text,
    anchorId: (message(range.endContainer) ?? message(range.startContainer))?.getAttribute("data-chat-id") ?? null,
    x: clamp(rect.left + rect.width / 2, 120, window.innerWidth - 120),
    y: clamp(rect.top - 42, 12, window.innerHeight - 52),
  }
}

function usefulRect(range: Range): DOMRect | null {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
  return rects[0] ?? (range.getBoundingClientRect().width ? range.getBoundingClientRect() : null)
}

function contains(root: HTMLElement, node: Node): boolean {
  const target = node.nodeType === Node.TEXT_NODE ? node.parentNode : node
  return target ? root.contains(target) : false
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
