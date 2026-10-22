import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { MessageSquarePlus } from "lucide-react"
import { buildSelectionTaskPrompt, type SelectionTaskSource } from "../lib/selectionTask"
import { toast } from "../lib/toast"
import { Button, cx } from "./ui"
import { Modal } from "./Modal"

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
  const [draft, setDraft] = useState<SelectionInfo | null>(null)

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

  const open = () => {
    if (!selection) return
    setDraft(selection)
  }

  return (
    <div ref={root} className="contents">
      {children}
      {source && selection && (
        <>
          <button
            type="button"
            data-selection-task-action
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
        <SelectionPrompt
          source={source}
          selection={draft}
          onClose={() => setDraft(null)}
          onSubmit={(prompt) => {
            onPrompt(prompt)
            setDraft(null)
            setSelection(null)
            window.getSelection()?.removeAllRanges()
            toast.info("Sent to orchestrator", "Cody will decide where this task belongs.")
          }}
        />
      )}
    </div>
  )
}

function SelectionPrompt({
  source,
  selection,
  onClose,
  onSubmit,
}: {
  source: SelectionTaskSource
  selection: SelectionInfo
  onClose: () => void
  onSubmit: (prompt: string) => void
}) {
  const [instructions, setInstructions] = useState("")
  const preview = useMemo(() => selection.text.replace(/\s+/g, " ").trim().slice(0, 260), [selection.text])
  return (
    <Modal
      title="Start new task from selection"
      description="Add optional instructions; the orchestrator will choose the task placement."
      size="sm"
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(buildSelectionTaskPrompt({ source, selectedText: selection.text, instructions }))
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Send to orchestrator
          </Button>
        </>
      }
    >
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-400">
        <div className="mb-1 font-medium text-zinc-300">Selected context</div>
        <div className="line-clamp-4">{preview}</div>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Instructions</span>
        <textarea
          autoFocus
          value={instructions}
          onChange={(e) => setInstructions(e.currentTarget.value)}
          rows={4}
          placeholder="What should the new task do with this context?"
          className={cx(
            "w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600",
            "focus:border-yard-500/60 focus:ring-2 focus:ring-yard-500/20 focus:outline-none",
          )}
        />
      </label>
    </Modal>
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
  return root.contains(node.nodeType === Node.TEXT_NODE ? node.parentElement : node)
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
