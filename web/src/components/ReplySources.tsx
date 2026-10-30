// The muted "from: box-yard Captain · Fix login" line under a Coordinator reply: the updates it read
// (lib/chatUpdates.ts coordinatorRows). A click opens their chips and scrolls to the first; again folds them.
import { memo, useMemo } from "react"
import { CornerLeftUp } from "lucide-react"
import { groupKey, setOpen, useAllOpen } from "../lib/chipState"
import { revealChatMessage } from "../lib/reveal"
import { sourceNames, type UpdateSource } from "../lib/chatUpdates"
import { NOTICE_ICON } from "./noticeIcons"
import { TaskTile } from "./TaskIcon"

/** The chip keys a reply's sources open: each update, and the group it sits in. */
export function sourceKeys(sources: readonly UpdateSource[]): string[] {
  return [...new Set(sources.flatMap((s) => (s.rowId === s.id ? [s.id] : [groupKey(s.rowId), s.id])))]
}

export const ReplySources = memo(function ReplySources({ sources }: { sources: UpdateSource[] }) {
  const names = useMemo(() => sourceNames(sources, (kind) => NOTICE_ICON[kind].label), [sources])
  const keys = useMemo(() => sourceKeys(sources), [sources])
  const open = useAllOpen(keys)
  const toggle = () => {
    setOpen(keys, !open)
    if (!open) revealChatMessage(sources[0]!.rowId)
  }
  const count = sources.length
  return (
    <button
      type="button"
      data-testid="reply-sources"
      aria-expanded={open}
      onClick={toggle}
      title={open ? "Fold the updates this reply is about" : `Show the ${count === 1 ? "update" : `${count} updates`} this reply is about`}
      className="mt-1 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-[11px] text-zinc-500 hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none [@media(pointer:coarse)]:min-h-8"
    >
      <CornerLeftUp className="h-3 w-3 shrink-0" aria-hidden />
      <span className="shrink-0">from:</span>
      <span className="min-w-0 truncate text-yard-400/80">
        {names.map((n, i) => (
          <span key={n.label}>
            {i > 0 && " · "}
            {n.taskId && <TaskTile id={n.taskId} bare className="mr-0.5 align-[-2px]" />}
            {n.label}
          </span>
        ))}
      </span>
    </button>
  )
})
