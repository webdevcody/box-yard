// Select text in a chat or transcript and "Start new task" turns it into work: the shared New task popover opens
// with the quote and a box for instructions. Enter sends both to whoever routes the work (the Coordinator, or the
// project's Captain in its chat); "More options" starts the task directly from the full New task dialog.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { MessageSquarePlus } from "lucide-react"
import { buildSelectionTaskBrief, buildSelectionTaskPrompt, selectionTarget, type SelectionTaskSource } from "../lib/selectionTask"
import { saveDraft, selectionScope } from "../lib/newTask"
import { toast } from "../lib/toast"
import { useOwnerName } from "../lib/queries"
import { NewTaskDialog, NewTaskPopover } from "./NewTask"

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
}

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
  /** The popover is open on this selection, hanging from where its action button was. */
  const [draft, setDraft] = useState<(SelectionInfo & { rect: Rect }) | null>(null)
  /** "More options": the full New task dialog for this selection and the instructions typed so far. */
  const [dialog, setDialog] = useState<{ text: string; instructions: string } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const popoverId = useId()
  const ownerName = useOwnerName()

  useEffect(() => {
    const update = () => {
      if (!source) return setSelection(null)
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
  }, [source])

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (!selection) return
    const r = e.currentTarget.getBoundingClientRect()
    setDraft({ ...selection, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    setSelection(null)
  }

  const finish = () => {
    setDraft(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div ref={root} className="contents">
      {children}
      {source && selection && !draft && (
        <>
          <button
            type="button"
            data-selection-task-action
            aria-haspopup="dialog"
            onMouseDown={(e) => e.preventDefault()}
            onClick={open}
            className="fixed z-40 hidden -translate-x-1/2 items-center gap-1.5 rounded-full border border-yard-400/50 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-yard-200 shadow-lg shadow-black/40 backdrop-blur hover:border-yard-300 hover:text-yard-100 focus:ring-2 focus:ring-yard-500 focus:outline-none [@media(pointer:fine)]:inline-flex"
            style={{ left: selection.x, top: selection.y }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" /> Start new task
          </button>
          <div data-selection-task-action className="fixed inset-x-3 bottom-3 z-40 [@media(pointer:fine)]:hidden">
            <button
              type="button"
              aria-haspopup="dialog"
              onMouseDown={(e) => e.preventDefault()}
              onClick={open}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-yard-400/50 bg-zinc-900/95 px-4 py-3 text-sm font-medium text-yard-100 shadow-2xl shadow-black/50 backdrop-blur"
            >
              <MessageSquarePlus className="h-4 w-4" /> Start new task from selection
            </button>
          </div>
        </>
      )}
      {source && draft && (
        <>
          {/* Where the action button was: the popover hangs from it (the button itself goes once the selection does). */}
          <span ref={anchor} aria-hidden className="pointer-events-none fixed" style={draft.rect} />
          <NewTaskPopover
            id={popoverId}
            trigger={anchor}
            heading="New task from selection"
            quote={draft.text}
            placeholder="Additional instructions (optional)"
            scope={selectionScope(draft.text)}
            defaultProjectId={source.project?.id}
            onStart={(instructions) => {
              onPrompt(buildSelectionTaskPrompt({ source, selectedText: draft.text, instructions, ownerName }))
              finish()
              toast.info(`Sent to ${selectionTarget(source)}`, "It will decide where this task belongs.")
            }}
            onClose={() => setDraft(null)}
            onMore={(_, instructions) => {
              setDialog({ text: draft.text, instructions })
              setDraft(null)
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

function readSelection(root: HTMLElement | null): SelectionInfo | null {
  if (!root) return null
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ""
  if (!sel || sel.rangeCount === 0 || text.length < 3) return null
  const range = sel.getRangeAt(0)
  if (!contains(root, range.commonAncestorContainer)) return null
  const rect = usefulRect(range)
  if (!rect) return null
  return {
    text,
    x: clamp(rect.left + rect.width / 2, 88, window.innerWidth - 88),
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
