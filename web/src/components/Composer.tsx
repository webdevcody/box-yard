import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode, type RefObject, type Ref } from "react"
import { createPortal, flushSync } from "react-dom"
import { AlertTriangle, FileText, Loader2, Maximize2, Minimize2, Paperclip, Send, X } from "lucide-react"
import { uploadFile } from "../lib/api"
import { composerMaxHeight, isTouchDevice } from "../lib/composer"
import { useSettings } from "../lib/queries"
import { Button, cx } from "./ui"
import { formatSize, isImage } from "./Attachments"
import { DictationStatus, MicButton } from "./Dictation"
import { insertTranscript } from "../lib/dictation"
import { useDictation } from "../lib/useDictation"
import { primeSendSound } from "../lib/sendSound"
import { browseStep, readHistory, rememberPrompt, type Browse } from "../lib/promptHistory"
import type { Attachment } from "../../../shared/types"

interface Pending {
  key: number
  name: string
  size: number
  mime: string
  preview: string | null
  status: "uploading" | "done" | "error"
  error?: string
  attachment?: Attachment
}

let nextKey = 0

/** Lets a parent put text in the box (an example prompt) without owning the draft. */
export interface ComposerHandle {
  /** Replace the draft with `text` and focus the box, selecting `select` (e.g. a placeholder) if it's in the text. */
  fill(text: string, select?: string): void
  /** Send the draft as Enter would (a hint's one-tap "send it there" after the parent switched its target). */
  submit(): void
}

/**
 * The bar a Composer sits in at the bottom of a chat: top border, padding and the safe-area inset. Every chat
 * (Coordinator, Captain tab, task page) uses it, so their composers line up when shown side by side; add only
 * horizontal spacing or a top margin to it.
 */
export const COMPOSER_FOOTER =
  "sticky bottom-0 z-10 border-t border-zinc-900 bg-zinc-950/95 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur"

/** The text's box metrics, shared by the textarea and the history ghost drawn over it. */
const TEXT = "px-3 pt-3 pb-1 text-base leading-6 sm:pt-2.5 sm:text-sm sm:leading-5"

/**
 * The message box shared by the orchestrator chat and task threads: Enter
 * sends, Shift+Enter adds a line, files can be picked, dropped or pasted.
 * `onSubmit` gets the text and the uploaded files; the box then clears itself.
 * If it returns the send's promise, a failed send puts the text and files back (focus
 * never left), and a successful one on a touch device blurs the box to close the keyboard.
 * With a `historyKey`, Up in the empty box shows the prompts sent from it (lib/promptHistory.ts).
 * The draft lives here, not in the parent, so typing re-renders only this box
 * and never the (long) message list next to it.
 */
export function Composer({
  onSubmit,
  placeholder,
  className = cx(COMPOSER_FOOTER, "px-3"),
  textareaRef,
  panelRef,
  handleRef,
  historyKey,
  files: allowFiles = true,
  tools,
  hint,
}: {
  onSubmit: (text: string, attachments: Attachment[]) => void | Promise<unknown>
  placeholder: string
  className?: string
  textareaRef?: Ref<HTMLTextAreaElement>
  handleRef?: Ref<ComposerHandle>
  /** The panel that accepts dropped files, message list included. It must be `relative`. */
  panelRef: RefObject<HTMLElement | null>
  /** Whose sent prompts Up/Down walk through ("coordinator", "captain:<projectId>", "task:<taskId>"). */
  historyKey?: string
  /** false: text only (a side thread): no attach button, and pasted or dropped files are left alone. */
  files?: boolean
  /** More controls in the button row, after the mic: who the message goes to (CardComposer, ChatPanel). */
  tools?: ReactNode
  /** A line above the buttons that depends on the draft (a task's "send this to the Captain?"). Called on every keystroke, so keep it cheap. */
  hint?: (draft: string) => ReactNode
}) {
  const [value, setValue] = useState("")
  // An older prompt shown as a gray ghost while browsing with Up/Down; the value stays empty until Enter takes it.
  const [browse, setBrowse] = useState<Browse>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const [files, setFiles] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const overflowingRef = useRef(overflowing)
  overflowingRef.current = overflowing
  const [expanded, setExpanded] = useState(false)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const maxMb = useSettings().data?.maxUploadMb ?? 20
  const filesRef = useRef(files)
  filesRef.current = files

  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), [])

  const patch = (key: number, change: Partial<Pending>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)))

  const add = (picked: File[]) => {
    for (const file of picked) {
      const key = nextKey++
      const item: Pending = {
        key,
        name: file.name || "pasted-file",
        size: file.size,
        mime: file.type || "application/octet-stream",
        preview: isImage(file.type) ? URL.createObjectURL(file) : null,
        status: "uploading",
      }
      if (file.size > maxMb * 1024 * 1024) {
        setFiles((list) => [...list, { ...item, status: "error", error: `"${item.name}" is larger than the ${maxMb} MB upload limit.` }])
        continue
      }
      setFiles((list) => [...list, item])
      uploadFile(file).then(
        (attachment) => patch(key, { status: "done", attachment }),
        (err: Error) => patch(key, { status: "error", error: err.message }),
      )
    }
  }

  const remove = (key: number) =>
    setFiles((list) => {
      const gone = list.find((f) => f.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return list.filter((f) => f.key !== key)
    })

  const uploading = files.some((f) => f.status === "uploading")
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []))
  const canSend = !uploading && Boolean(value.trim() || ready.length)

  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      input.current = el
      if (typeof textareaRef === "function") textareaRef(el)
      else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el
    },
    [textareaRef],
  )

  // Grow the box with its text up to a cap, then scroll inside it. Runs on every value change
  // (typing, paste, draft restore, clearing after send), when attachments change and on resize.
  const resize = useCallback(() => {
    const el = input.current
    const row = el?.parentElement
    if (!el || !row) return
    const max = composerMaxHeight(window.visualViewport?.height ?? window.innerHeight, expanded)
    // Hold the row's height while measuring so the panel (and the message list scroll) doesn't move.
    row.style.minHeight = `${row.offsetHeight}px`
    el.style.height = "auto"
    // A ghost prompt sizes the box like real text would, so a long one shows in full.
    const full = Math.max(el.scrollHeight, ghost.current?.scrollHeight ?? 0)
    el.style.height = `${Math.min(full, max)}px`
    row.style.minHeight = ""
    const over = full > max
    el.style.overflowY = over ? "auto" : "hidden"
    // Only on a change: a same-value setState from a layout effect still costs an extra commit per keystroke.
    if (over !== overflowingRef.current) setOverflowing(over)
    // Typing or pasting at the end of a capped box: keep the caret in view.
    if (over && document.activeElement === el && el.selectionEnd === el.value.length) el.scrollTop = el.scrollHeight
  }, [expanded])

  useLayoutEffect(resize, [resize, value, files.length, browse])

  // Anything that puts text in the box (typing, paste, dictation, an example prompt) ends browsing, and so
  // does another chat's history.
  useEffect(() => {
    if (value) setBrowse(null)
  }, [value])
  useEffect(() => setBrowse(null), [historyKey])

  useEffect(() => {
    const el = input.current
    if (!el) return
    // Width changes (window or panel resize) rewrap the text, so re-measure.
    let width = el.offsetWidth
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width) return
      width = el.offsetWidth
      resize()
    })
    ro.observe(el)
    window.addEventListener("resize", resize)
    window.visualViewport?.addEventListener("resize", resize)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", resize)
      window.visualViewport?.removeEventListener("resize", resize)
    }
  }, [resize])

  // An emptied box (after sending) goes back to its normal size.
  useEffect(() => {
    if (!value) setExpanded(false)
  }, [value])

  const submit = () => {
    // Still listening: stop, let the last words land, then send (dictation calls submit again).
    if (dictation.active) return dictation.stopAndSend()
    if (!canSend) return
    // Inside the tap or key press, so the "sent" cue may play when the server accepts it.
    primeSendSound()
    const text = value.trim()
    const sent = files
    const pending = onSubmit(text, ready)
    setValue("")
    setFiles([])
    const done = () => sent.forEach((f) => f.preview && URL.revokeObjectURL(f.preview))
    if (!pending) {
      rememberPrompt(historyKey, text)
      return done()
    }
    pending.then(
      () => {
        done()
        rememberPrompt(historyKey, text)
        // The on-screen keyboard closes; the list (pinned by the send) follows the viewport as it grows.
        if (isTouchDevice() && input.current && document.activeElement === input.current) input.current.blur()
      },
      // Back in the box, unless something new was typed meanwhile.
      () => {
        setValue((v) => v || text)
        if (filesRef.current.length) done()
        else setFiles(sent)
      },
    )
  }
  const submitRef = useRef(submit)
  submitRef.current = submit

  // Dictation: final words go into the draft at the caret. flushSync makes the new value (and a fresh
  // `submit`) current at once, so "send when I release" right after sees every word.
  const form = useRef<HTMLFormElement>(null)
  const dictation = useDictation({
    root: () => form.current,
    focus: () => input.current?.focus(),
    insert: (text) => {
      const el = input.current
      if (!el) return
      const next = insertTranscript(el.value, el.selectionStart, el.selectionEnd, text)
      if (next.value === el.value) return
      flushSync(() => setValue(next.value))
      el.setSelectionRange(next.caret, next.caret)
    },
    send: () => submitRef.current(),
  })

  useImperativeHandle(
    handleRef,
    () => ({
      fill: (text, select) => {
        flushSync(() => setValue(text))
        const el = input.current
        if (!el) return
        el.focus()
        const at = select ? text.indexOf(select) : -1
        if (at >= 0) el.setSelectionRange(at, at + select!.length)
        else el.setSelectionRange(text.length, text.length)
      },
      submit: () => submitRef.current(),
    }),
    [],
  )

  const onPaste = (e: ClipboardEvent) => {
    if (!allowFiles) return
    const pasted = Array.from(e.clipboardData.files)
    if (!pasted.length) return
    e.preventDefault()
    add(pasted)
  }

  // Drop files anywhere on the panel. Window-level handlers stop a missed drop from opening the file in the tab.
  const addRef = useRef(add)
  addRef.current = add
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || !allowFiles) return
    const hasFiles = (e: globalThis.DragEvent) => Boolean(e.dataTransfer?.types?.includes("Files"))
    let depth = 0
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: globalThis.DragEvent) => {
      depth = 0
      setDragging(false)
      const dropped = Array.from(e.dataTransfer?.files ?? [])
      if (!dropped.length) return
      e.preventDefault()
      addRef.current(dropped)
    }
    const stray = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    panel.addEventListener("dragenter", enter)
    panel.addEventListener("dragleave", leave)
    panel.addEventListener("dragover", over)
    panel.addEventListener("drop", drop)
    window.addEventListener("dragover", stray)
    window.addEventListener("drop", stray)
    return () => {
      panel.removeEventListener("dragenter", enter)
      panel.removeEventListener("dragleave", leave)
      panel.removeEventListener("dragover", over)
      panel.removeEventListener("drop", drop)
      window.removeEventListener("dragover", stray)
      window.removeEventListener("drop", stray)
    }
  }, [panelRef, allowFiles])

  return (
    <form
      ref={form}
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {dragging &&
        panelRef.current &&
        createPortal(
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/85">
            <div className="rounded-2xl border-2 border-dashed border-yard-500 px-8 py-6 text-center text-sm font-medium text-yard-400">
              <Paperclip className="mx-auto mb-2 h-6 w-6" />
              Drop files to attach
            </div>
          </div>,
          panelRef.current,
        )}
      {/* Like the Claude and ChatGPT composers: attachments, then the text at full width, then a row of buttons. */}
      <div
        className="rounded-xl border border-zinc-800 bg-zinc-900 focus-within:border-yard-500/50"
        onMouseDown={(e) => {
          // A press on the box's empty space (around the text, between the buttons) puts the caret in the text.
          const target = e.target as HTMLElement
          if (target.closest("button, a, input, textarea, [data-attachment]")) return
          e.preventDefault()
          input.current?.focus()
        }}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <div
                key={f.key}
                data-attachment
                title={f.error ?? `${f.name} · ${formatSize(f.size)}`}
                className={cx(
                  "relative flex items-center gap-1.5 rounded-lg border bg-zinc-950 text-xs text-zinc-300",
                  f.preview ? "p-0.5" : "py-1 pr-6 pl-2",
                  f.status === "error" ? "border-red-900/60 text-red-300" : "border-zinc-800",
                )}
              >
                {f.preview ? (
                  <img src={f.preview} alt={f.name} className={cx("h-14 w-14 rounded-md object-cover", f.status !== "done" && "opacity-50")} />
                ) : f.status === "error" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
                {!f.preview && (
                  <span className="max-w-[10rem] truncate">
                    {f.name} <span className="text-zinc-600">{formatSize(f.size)}</span>
                  </span>
                )}
                {f.status === "uploading" && <Loader2 className="absolute top-1 left-1 h-3.5 w-3.5 animate-spin text-zinc-200" />}
                {f.preview && f.status === "error" && <AlertTriangle className="absolute top-1 left-1 h-3.5 w-3.5 text-red-400" />}
                <button
                  type="button"
                  onClick={() => remove(f.key)}
                  aria-label={`Remove ${f.name}`}
                  className="absolute top-0.5 right-0.5 rounded-full bg-zinc-800 p-0.5 text-zinc-400 hover:text-zinc-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {files.some((f) => f.status === "error") && (
          <div className="px-3 pt-1.5 text-xs text-red-400">{files.find((f) => f.status === "error")!.error}</div>
        )}
        <div className="px-1 pt-1.5 empty:hidden">
          <DictationStatus machine={dictation} />
        </div>
        <div className="relative">
          <textarea
            ref={setTextarea}
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPaste={onPaste}
            onBlur={() => setBrowse(null)}
            onKeyDown={(e) => {
              // Mid-composition (IME), Enter and the arrows belong to the input method.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              const step = browseStep(browse, e, !value, () => readHistory(historyKey))
              if (step.handled) {
                e.preventDefault()
                // Escape only clears the ghost: it doesn't also leave Zen or close a panel.
                e.stopPropagation()
              }
              if (step.browse !== browse) setBrowse(step.browse)
              if (step.select !== undefined) {
                const text = step.select
                flushSync(() => setValue(text))
                e.currentTarget.setSelectionRange(text.length, text.length)
              }
              if (step.handled) return
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={browse ? "" : placeholder}
            aria-description={browse ? `Earlier prompt: ${browse.text}. Enter to use it, Escape to clear.` : undefined}
            // The text starts at the box's left padding and wraps under nothing. A long placeholder stays on
            // one line (ellipsis) instead of growing an empty box on narrow screens.
            className={cx(TEXT, "scroll-thin block w-full resize-none overflow-y-hidden bg-transparent text-zinc-100 placeholder:text-zinc-600 placeholder-shown:truncate focus:outline-none")}
          />
          {browse && (
            // Same box metrics as the text, so taking it with Enter doesn't move a letter.
            <div
              ref={ghost}
              aria-hidden
              data-testid="history-ghost"
              className={cx(TEXT, "pointer-events-none absolute inset-x-0 top-0 max-h-full overflow-hidden whitespace-pre-wrap wrap-anywhere text-zinc-500")}
            >
              {browse.text}
            </div>
          )}
        </div>
        {hint && !browse && <div className="px-1.5 empty:hidden">{hint(value)}</div>}
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.target.files ?? []))
              e.target.value = ""
            }}
          />
          {allowFiles && (
            <Button type="button" variant="ghost" size="sm" className="h-11 w-11 !p-0 sm:h-8 sm:w-8" title="Attach files" onClick={() => picker.current?.click()}>
              <Paperclip className="h-4 w-4" />
            </Button>
          )}
          <MicButton machine={dictation} />
          {tools}
          <div className="ml-auto flex items-center gap-1">
            {(overflowing || expanded) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-11 w-11 !p-0 sm:h-8 sm:w-8"
                title={expanded ? "Shrink editor" : "Expand editor"}
                aria-label={expanded ? "Shrink editor" : "Expand editor"}
                aria-pressed={expanded}
                onClick={() => {
                  setExpanded((on) => !on)
                  input.current?.focus()
                }}
              >
                {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" className="h-11 w-11 !p-0 sm:h-8 sm:w-8" disabled={!canSend} aria-label="Send">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}
