// The task page's Queued rows: messages waiting for the agent's next turn, below the live transcript, in send
// order. Each can be edited in place or deleted (with Undo) until a turn takes it; the server refuses changes
// after that ("already delivered"), so an edit or delete never races the delivery.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Clock, Loader2, Pencil, Trash2 } from "lucide-react"
import type { QueuedMessage } from "../../../shared/types"
import { useOwnerName, useQueuedMessageActions, useTaskQueue } from "../lib/queries"
import { UNDO_MS } from "../lib/inbox"
import { navigate } from "wouter/use-browser-location"
import { QUEUE_HASH, REVEAL_QUEUE_EVENT, revealTaskQueue } from "../lib/reveal"
import { toast } from "../lib/toast"
import { AttachmentList } from "./Attachments"
import { Button, LineIcon, TimeAgo, cx } from "./ui"

/** Square icon buttons: 44px touch targets on phones, 24px from sm. */
const ICON_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none sm:h-6 sm:w-6"

export const TaskQueue = memo(function TaskQueue({ taskId }: { taskId: string }) {
  const queue = useTaskQueue(taskId)
  const { edit, remove, restore } = useQueuedMessageActions(taskId)
  const [editing, setEditing] = useState<string | null>(null)
  // Deleted rows stay in place as an Undo line for a few seconds (the server keeps them longer).
  const [deleted, setDeleted] = useState<QueuedMessage[]>([])
  const list = queue.data ?? []
  const root = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const live = new Set(list.map((m) => m.id))
    return [...list.map((m) => ({ m, deleted: false })), ...deleted.filter((m) => !live.has(m.id)).map((m) => ({ m, deleted: true }))].sort(
      (a, b) => a.m.createdAt - b.m.createdAt,
    )
  }, [list, deleted])

  // The row being edited went out (or someone else deleted it) before the edit was saved: say so.
  const editingGone = editing !== null && queue.isFetched && !list.some((m) => m.id === editing)
  useEffect(() => {
    if (!editingGone) return
    setEditing(null)
    toast.error("Already delivered", "The agent got the message as it was, so your edit wasn't saved. Send it as a new message if it still matters.")
  }, [editingGone])

  // /tasks/:id#queue (the "N queued" badge) scrolls here.
  const reveal = useCallback(() => {
    if (window.location.hash === QUEUE_HASH) root.current?.scrollIntoView({ block: "nearest" })
  }, [])
  useEffect(() => {
    reveal()
    const onReveal = (e: Event) => (e as CustomEvent<string>).detail === taskId && requestAnimationFrame(reveal)
    window.addEventListener(REVEAL_QUEUE_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_QUEUE_EVENT, onReveal)
  }, [taskId, reveal, rows.length > 0])

  const onDelete = useCallback(
    (m: QueuedMessage) => {
      if (editing === m.id) setEditing(null)
      remove.mutate(m.id, { onSuccess: () => setDeleted((d) => [...d.filter((x) => x.id !== m.id), m]) })
    },
    [editing, remove.mutate],
  )
  const onUndo = useCallback(
    (m: QueuedMessage) => {
      setDeleted((d) => d.filter((x) => x.id !== m.id))
      restore.mutate(m)
    },
    [restore.mutate],
  )
  const onSave = useCallback(
    (m: QueuedMessage, text: string) => {
      setEditing(null)
      if (text.trim() !== m.text) edit.mutate({ id: m.id, text, version: m.version })
    },
    [edit.mutate],
  )
  const dropUndo = useCallback((id: string) => setDeleted((d) => d.filter((x) => x.id !== id)), [])

  if (!rows.length) return null
  return (
    <div ref={root} id="task-queue" role="list" aria-label="Queued messages" className="scroll-mt-4 space-y-1.5 pt-1">
      {rows.map(({ m, deleted }) =>
        deleted ? (
          <DeletedRow key={m.id} m={m} onUndo={onUndo} onExpire={dropUndo} />
        ) : (
          <QueuedRow key={m.id} m={m} editing={editing === m.id} onEdit={setEditing} onSave={onSave} onDelete={onDelete} />
        ),
      )}
    </div>
  )
})

const QueuedRow = memo(function QueuedRow({
  m,
  editing,
  onEdit,
  onSave,
  onDelete,
}: {
  m: QueuedMessage
  editing: boolean
  onEdit: (id: string | null) => void
  onSave: (m: QueuedMessage, text: string) => void
  onDelete: (m: QueuedMessage) => void
}) {
  const ownerName = useOwnerName()
  const delivering = m.status === "delivering"
  // An optimistic row (just sent) has no server id yet.
  const settled = !m.id.startsWith("tmp-")
  return (
    <div
      role="listitem"
      data-testid="queued-message"
      className={cx("rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-3 py-2", delivering && "opacity-70")}
    >
      <div className="flex min-h-6 items-center gap-1.5 text-[11px] text-zinc-500">
        <LineIcon icon={delivering ? Loader2 : Clock} className={cx("h-3 w-3", delivering && "animate-spin")} />
        <span className="font-semibold text-zinc-400">{delivering ? "Delivering" : "Queued"}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{m.sender || ownerName}</span>
        <span className="shrink-0 text-[10px] text-zinc-600">
          <TimeAgo ts={m.createdAt} />
        </span>
        {!delivering && settled && !editing && (
          <span className="-my-2.5 ml-auto flex shrink-0 sm:-my-0.5">
            <button type="button" className={ICON_BUTTON} title="Edit" aria-label="Edit queued message" onClick={() => onEdit(m.id)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cx(ICON_BUTTON, "hover:text-red-300")}
              title="Delete"
              aria-label="Delete queued message"
              onClick={() => onDelete(m)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <QueuedEditor m={m} locked={delivering} onSave={onSave} onCancel={() => onEdit(null)} />
      ) : (
        m.text && <div className="mt-0.5 line-clamp-6 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-300">{m.text}</div>
      )}
      <AttachmentList files={m.attachments.length ? m.attachments : undefined} />
    </div>
  )
})

/** `locked`: a turn is taking the message right now, so the edit can't be saved any more. */
function QueuedEditor({ m, locked, onSave, onCancel }: { m: QueuedMessage; locked: boolean; onSave: (m: QueuedMessage, text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(m.text)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  const empty = !text.trim() && !m.attachments.length
  const canSave = !empty && !locked
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
      e.preventDefault()
      onSave(m, text)
    }
  }
  return (
    <form
      className="mt-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) onSave(m, text)
      }}
    >
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        readOnly={locked}
        rows={2}
        aria-label="Queued message"
        className="block w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-base text-zinc-100 focus:border-yard-500 focus:outline-none sm:text-sm"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {locked && (
          <span role="status" className="mr-auto text-xs text-amber-300/90">
            Being delivered: it can't be changed now.
          </span>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  )
}

function DeletedRow({ m, onUndo, onExpire }: { m: QueuedMessage; onUndo: (m: QueuedMessage) => void; onExpire: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onExpire(m.id), UNDO_MS)
    return () => clearTimeout(t)
  }, [m.id, onExpire])
  return (
    <div role="listitem" data-testid="queued-deleted" className="flex min-h-6 items-center gap-1.5 rounded-lg px-3 text-[11px] text-zinc-500">
      <LineIcon icon={Trash2} className="h-3 w-3" />
      <span className="min-w-0 truncate">Queued message deleted</span>
      <button type="button" onClick={() => onUndo(m)} className="-my-2.5 ml-auto min-h-11 shrink-0 rounded-md px-2 font-semibold text-yard-400 hover:bg-zinc-800 sm:my-0 sm:min-h-6">
        Undo
      </button>
    </div>
  )
}

/**
 * "N queued" on task cards and the task header: opens the task's Queued rows. A button, not a link, because it
 * sits inside the card's link; it doesn't open the card's own target.
 */
export function QueuedLink({ taskId, count, className }: { taskId: string; count: number; className?: string }) {
  return (
    <button
      type="button"
      title={`${count} message${count === 1 ? "" : "s"} wait for the next turn. Open the queue to edit or delete them.`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        revealTaskQueue(taskId, navigate)
      }}
      className={cx("rounded hover:text-zinc-200 hover:underline focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none", className)}
    >
      {count} queued
    </button>
  )
}
