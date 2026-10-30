// The Coordinator chat's updates as one-line chips (rows from lib/chatUpdates.ts): "box-yard Captain replied · …",
// "✓ Fix login done · …", in the cards (CoordinatorCards.tsx). A click opens the whole notice in place, under the
// chip. Open state is per session (lib/chipState.ts) and per chip, so a toggle re-renders only that chip.
import { memo, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Bot, ChevronRight, type LucideIcon } from "lucide-react"
import { AppLink, InRepo, LinkedText, Markdown, cx } from "./ui"
import { FullReplyLink, NoticeProject } from "./ChatLine"
import { PublishedCard } from "./PublishedNotices"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { ThreadMarkers } from "./SideThread"
import { NOTICE_ICON } from "./noticeIcons"
import { TaskTile } from "./TaskIcon"
import { useTaskTile } from "../lib/taskTiles"
import { chipView, coordinatorRows, itemMessages, stableRows, type CoordinatorRow, type UpdateItem } from "../lib/chatUpdates"
import { splitNotice } from "../lib/captainTranscript"
import { stripTruncation } from "../lib/truncated"
import { publishedLabel } from "../lib/publishedNotices"
import { useChipOpen } from "../lib/chipState"
import type { ChatMessage } from "../../../shared/types"

/** The chip's line: taller under a finger, so a phone can hit it. */
const CHIP_ROW =
  "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none [@media(pointer:coarse)]:min-h-10"
/** What an open chip shows, under its line. */
const CHIP_BODY = "mt-0.5 mb-1 ml-2.5 border-l border-zinc-800 pl-3"
const SOURCE_LINK = "min-w-0 max-w-[55%] shrink truncate font-medium text-yard-400 hover:underline"

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cx("ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
}

/** A role=button line (not a <button>: the source inside is a link). Its links keep their clicks. */
function ChipLine({ open, onToggle, title, children }: { open: boolean; onToggle: () => void; title?: string; children: ReactNode }) {
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    onToggle()
  }
  return (
    <div role="button" tabIndex={0} aria-expanded={open} data-testid="update-chip-line" title={open ? undefined : title} onClick={toggle} onKeyDown={toggle} className={CHIP_ROW}>
      {children}
      <Chevron open={open} />
    </div>
  )
}

/**
 * One update: its chip, and once opened its whole text (or a files card) under it. `own`: inside its task's card
 * (components/CoordinatorCards.tsx), which already names the task, so the chip leads with what happened.
 */
export const UpdateChip = memo(
  function UpdateChip({ item, own = false }: { item: UpdateItem; own?: boolean }) {
    return item.type === "files" ? <FilesChip item={item} own={own} /> : <NoticeChip m={item.message} own={own} />
  },
  // Rows are rebuilt as messages arrive; an update with the very same messages is the same chip.
  (a, b) => a.own === b.own && (a.item === b.item || (a.item.id === b.item.id && sameMessages(itemMessages(a.item), itemMessages(b.item)))),
)

const sameMessages = (a: ChatMessage[], b: ChatMessage[]) => a.length === b.length && a.every((m, i) => m === b[i])

/** What happened, after the task's tile and name: the notice's icon, then "done", "opened a PR"… */
function Verb({ icon: Icon, className, label, verb }: { icon: LucideIcon | null; className?: string; label?: string; verb: string }) {
  if (!Icon && !verb) return null
  return (
    <span className="flex max-w-[45%] min-w-0 shrink-[0.5] items-center gap-1 text-zinc-400">
      {Icon && <Icon className={cx("h-3 w-3 shrink-0", className)} aria-label={label} />}
      {verb && <span className="min-w-0 truncate">{verb}</span>}
    </span>
  )
}

const NoticeChip = memo(function NoticeChip({ m, own }: { m: ChatMessage; own: boolean }) {
  const [open, toggle] = useChipOpen(m.id)
  const v = chipView(m)
  const { icon, className, label } = v.captain ? { icon: Bot, className: "text-sky-400", label: "Captain" } : NOTICE_ICON[v.kind]
  const Icon = icon
  // A task's update leads with its tile, and its kind's icon moves to the verb.
  const taskId = v.captain ? null : typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const tile = useTaskTile(taskId) && !own
  // In its task's card, a task's update needn't name it; a Captain's still says whose report it is.
  const source = own && !v.captain ? null : v.source
  return (
    <div id={`chat-${m.id}`} data-chat-id={m.id} data-testid="update-chip" data-open={open || undefined} className={MESSAGE_BLOCK}>
      <ChipLine open={open} onToggle={toggle} title={[v.source?.label, v.verb, v.preview].filter(Boolean).join(" ")}>
        {tile ? <TaskTile id={taskId} /> : <Icon className={cx("h-3.5 w-3.5 shrink-0", className)} aria-label={label} />}
        {source &&
          (source.href ? (
            <AppLink href={source.href} className={SOURCE_LINK}>
              {source.label}
            </AppLink>
          ) : (
            <span className="min-w-0 max-w-[55%] shrink truncate font-medium text-zinc-300">{source.label}</span>
          ))}
        {tile ? <Verb icon={Icon} className={className} label={label} verb={v.verb} /> : v.verb && <span className="max-w-[45%] min-w-0 shrink-[0.5] truncate text-zinc-400">{v.verb}</span>}
        {/* Open, the text is right below: no preview. */}
        {v.preview && !open && (
          <span data-testid="update-chip-preview" className={cx("min-w-0 flex-1 truncate", source ? "text-zinc-600" : "text-zinc-400")}>
            {source || v.verb ? "· " : ""}
            <InRepo taskId={typeof m.meta?.taskId === "string" ? m.meta.taskId : null} projectId={typeof m.meta?.projectId === "string" ? m.meta.projectId : null}>
              <LinkedText text={v.preview} />
            </InRepo>
          </span>
        )}
      </ChipLine>
      {open && <NoticeBody m={m} />}
      <MessageActions text={m.content} anchorId={m.id} />
      <ThreadMarkers m={m} />
    </div>
  )
})

/** An open chip's text: a Captain's reply as prose; a task notice with its project and Captain links first. */
function NoticeBody({ m }: { m: ChatMessage }) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  const n = useMemo(() => splitNotice(m.content, m.meta), [m.content, m.meta])
  if (m.meta?.captain === true) {
    // The chip already says "box-yard Captain replied".
    const text = stripTruncation(m.content).text.replace(/^Captain(?: for .+?)?(?: replied)?:\s*/, "")
    return (
      <div data-testid="update-chip-body" className={cx(CHIP_BODY, "text-sm text-zinc-300")}>
        <InRepo projectId={projectId}>
          <Markdown>{text}</Markdown>
        </InRepo>
      </div>
    )
  }
  return (
    <div data-testid="update-chip-body" className={cx(CHIP_BODY, "text-xs leading-relaxed wrap-anywhere text-zinc-400")}>
      {taskId && <NoticeProject taskId={taskId} projectId={projectId} />}
      <div className="inline [&>.prose-chat]:inline [&>.prose-chat>p:first-child]:inline">
        <InRepo taskId={taskId} projectId={projectId}>
          <Markdown>{n.event}</Markdown>
        </InRepo>
      </div>
      {n.truncated && taskId && <FullReplyLink taskId={taskId} />}
    </div>
  )
}

const FilesChip = memo(function FilesChip({ item, own }: { item: Extract<UpdateItem, { type: "files" }>; own: boolean }) {
  const [open, toggle] = useChipOpen(item.id)
  const g = item.group
  const { icon: Icon, className, label } = NOTICE_ICON.artifact
  const tile = useTaskTile(g.taskId) && !own
  return (
    <div id={`chat-${item.id}`} data-testid="update-chip" data-open={open || undefined}>
      <ChipLine open={open} onToggle={toggle} title={`${g.taskTitle} ${publishedLabel(g.files.length)}`}>
        {tile ? <TaskTile id={g.taskId} /> : <Icon className={cx("h-3.5 w-3.5 shrink-0", className)} aria-label={label} />}
        {own ? null : g.taskId ? (
          <AppLink href={`/tasks/${g.taskId}`} className={SOURCE_LINK}>
            {g.taskTitle}
          </AppLink>
        ) : (
          <span className="min-w-0 max-w-[55%] shrink truncate font-medium text-zinc-300">{g.taskTitle}</span>
        )}
        <span className="flex shrink-0 items-center gap-1 text-zinc-400">
          {tile && <Icon className={cx("h-3 w-3 shrink-0", className)} aria-label={label} />}
          {publishedLabel(g.files.length)}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-600">· {g.files.map((f) => f.title).join(", ")}</span>
      </ChipLine>
      {open && (
        <div className={CHIP_BODY}>
          <PublishedCard group={g} />
        </div>
      )}
    </div>
  )
})

/** coordinatorRows, with every row that didn't change kept as the same object, so its memo'd component skips. */
export function useCoordinatorRows(messages: ChatMessage[]): CoordinatorRow[] {
  const prev = useRef<CoordinatorRow[]>([])
  return useMemo(() => (prev.current = stableRows(prev.current, coordinatorRows(messages))), [messages])
}
