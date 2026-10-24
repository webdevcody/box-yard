import { useState, type ReactNode } from "react"
import { Link } from "wouter"
import { ChevronRight } from "lucide-react"
import { useBoxHistory, useOwnerName } from "../lib/queries"
import { EVENT_TONE, HISTORY_PAGE, actorLabel, eventLabel, eventSummary, sizeLine, type EventTone, type HistoryFilter } from "../lib/boxHistory"
import { BOX_ACTORS, BOX_EVENT_TYPES, type BoxActorKind, type BoxEvent, type BoxEventType } from "../../../shared/boxHistory"
import { formatBytes } from "../../../shared/disk"
import { withOwner } from "../../../shared/owner"
import { Button, Select, TimeAgo, cx } from "./ui"

const TONE_CHIP: Record<EventTone, string> = {
  good: "bg-emerald-500/10 text-emerald-300",
  info: "bg-sky-500/10 text-sky-300",
  warn: "bg-amber-500/10 text-amber-300",
  bad: "bg-red-500/10 text-red-300",
  muted: "bg-zinc-800 text-zinc-300",
}

/** The server caps a page at this many rows. */
const MAX_ROWS = 200

/**
 * Every box lifecycle event and who did it, newest first, filterable by box (deleted boxes included), event type and
 * actor. A row opens in place to show the rest: reason, sizes, the other box of a resize, projects and tasks.
 */
export function BoxHistory({
  liveBoxIds,
  onOpenBox,
  projectName,
  taskTitle,
}: {
  liveBoxIds: ReadonlySet<string>
  /** Open a live box's details (the page's #<id> modal). */
  onOpenBox: (id: string) => void
  projectName: (id: string) => string | undefined
  taskTitle: (id: string) => string | undefined
}) {
  const [filter, setFilter] = useState<HistoryFilter>({})
  const [limit, setLimit] = useState(HISTORY_PAGE)
  const [open, setOpen] = useState<number | null>(null)
  const history = useBoxHistory(filter, limit)
  const ownerName = useOwnerName()
  const page = history.data
  const boxIds = page?.boxIds ?? []
  const filtered = Boolean(filter.boxId || filter.type || filter.actor)
  const set = (patch: HistoryFilter) => {
    setFilter((f) => ({ ...f, ...patch }))
    setLimit(HISTORY_PAGE)
  }
  return (
    <section aria-labelledby="box-history-title" data-testid="box-history">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="box-history-title" className="text-sm font-semibold text-zinc-300">
          History
        </h2>
        <div role="group" aria-label="Filter history" className="grid grid-cols-3 gap-1.5 sm:flex sm:gap-2">
          <Select size="sm" aria-label="Box" className="w-full min-w-0 sm:w-44" value={filter.boxId ?? ""} onChange={(e) => set({ boxId: e.target.value || undefined })}>
            <option value="">All boxes</option>
            {(filter.boxId && !boxIds.includes(filter.boxId) ? [filter.boxId, ...boxIds] : boxIds).map((id) => (
              <option key={id} value={id}>
                {id}
                {liveBoxIds.has(id) ? "" : " (gone)"}
              </option>
            ))}
          </Select>
          <Select size="sm" aria-label="Event" className="w-full min-w-0 sm:w-36" value={filter.type ?? ""} onChange={(e) => set({ type: (e.target.value || undefined) as BoxEventType | undefined })}>
            <option value="">All events</option>
            {BOX_EVENT_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
          <Select size="sm" aria-label="Who" className="w-full min-w-0 sm:w-44" value={filter.actor ?? ""} onChange={(e) => set({ actor: (e.target.value || undefined) as BoxActorKind | undefined })}>
            <option value="">Anyone</option>
            {BOX_ACTORS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key === "captain" ? "A Captain" : withOwner(a.label, ownerName)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!page ? (
        <p className="text-sm text-zinc-500">{history.isError ? "Couldn't load the history." : "Loading the history…"}</p>
      ) : page.events.length === 0 ? (
        <p className="text-sm text-zinc-500" data-testid="box-history-empty">
          {filtered ? "No events match these filters." : "Nothing recorded yet. Every box created, resized, deleted, lost or cleaned up shows here, with who did it."}
        </p>
      ) : (
        <>
          <ul className={cx("divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/80 bg-zinc-900/40 transition-opacity", history.isPlaceholderData && "opacity-60")}>
            {page.events.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                open={open === e.id}
                onToggle={() => setOpen((o) => (o === e.id ? null : e.id))}
                actor={actorLabel(e, projectName, ownerName)}
                live={liveBoxIds}
                onOpenBox={onOpenBox}
                projectName={projectName}
                taskTitle={taskTitle}
              />
            ))}
          </ul>
          {page.more && limit < MAX_ROWS && (
            <div className="mt-2 flex justify-center">
              <Button size="sm" variant="ghost" loading={history.isFetching} onClick={() => setLimit((n) => Math.min(MAX_ROWS, n + HISTORY_PAGE))}>
                Show older
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function EventRow({
  event: e,
  open,
  onToggle,
  actor,
  live,
  onOpenBox,
  projectName,
  taskTitle,
}: {
  event: BoxEvent
  open: boolean
  onToggle: () => void
  actor: string
  live: ReadonlySet<string>
  onOpenBox: (id: string) => void
  projectName: (id: string) => string | undefined
  taskTitle: (id: string) => string | undefined
}) {
  const size = sizeLine(e)
  const summary = eventSummary(e)
  return (
    <li data-testid="box-event" data-type={e.type}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-left text-xs transition first:rounded-t-xl hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none sm:min-h-0"
      >
        <span className="w-[5.5rem] sm:w-28">
          <span className={cx("inline-block max-w-full truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium", TONE_CHIP[EVENT_TONE[e.type]])}>{eventLabel(e)}</span>
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cx("truncate font-mono font-medium", live.has(e.boxId) ? "text-zinc-100" : "text-zinc-400")} title={e.boxId}>
              {e.boxId}
            </span>
            {size && <span className="shrink-0 text-zinc-500">{size}</span>}
          </span>
          <span className="block truncate text-[11px] text-zinc-500" title={summary || undefined}>
            <span className="text-zinc-300">{actor}</span>
            {summary && ` · ${summary}`}
          </span>
        </span>
        <span className="flex items-center gap-1 text-[11px] whitespace-nowrap text-zinc-500 tabular-nums">
          <TimeAgo ts={e.at} />
          <ChevronRight className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </span>
      </button>
      {open && <EventDetails event={e} actor={actor} live={live} onOpenBox={onOpenBox} projectName={projectName} taskTitle={taskTitle} />}
    </li>
  )
}

function EventDetails({
  event: e,
  actor,
  live,
  onOpenBox,
  projectName,
  taskTitle,
}: {
  event: BoxEvent
  actor: string
  live: ReadonlySet<string>
  onOpenBox: (id: string) => void
  projectName: (id: string) => string | undefined
  taskTitle: (id: string) => string | undefined
}) {
  const size = sizeLine(e)
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-zinc-800/60 bg-zinc-950/40 px-3 py-2.5 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]" data-testid="box-event-details">
      <Detail label="When">{new Date(e.at).toLocaleString()}</Detail>
      <Detail label="Box">
        <BoxRef id={e.boxId} live={live} onOpen={onOpenBox} />
        {e.boxName && e.boxName !== e.boxId && <span className="text-zinc-500"> ({e.boxName})</span>}
      </Detail>
      <Detail label="Who">{actor}</Detail>
      {e.reason && <Detail label="Why">{e.reason}</Detail>}
      {e.detail && e.detail !== e.reason && <Detail label="What happened">{e.detail}</Detail>}
      {size && <Detail label="Size">{size}</Detail>}
      {e.relatedBoxId && (
        <Detail label={e.type === "created" ? "Resizing" : "Other box"}>
          <BoxRef id={e.relatedBoxId} live={live} onOpen={onOpenBox} />
        </Detail>
      )}
      {e.freedBytes !== null && <Detail label="Freed">{formatBytes(e.freedBytes)}</Detail>}
      {e.projects.length > 0 && (
        <Detail label="Projects">
          <span className="flex flex-wrap gap-1">
            {e.projects.map((p) => (
              <span key={p.id} className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-zinc-300">
                {projectName(p.id) ?? p.name}
              </span>
            ))}
          </span>
        </Detail>
      )}
      {e.taskIds.length > 0 && (
        <Detail label="Tasks">
          <span className="flex flex-col gap-0.5">
            {e.taskIds.map((id) => (
              <Link key={id} href={`/tasks/${id}`} className="min-w-0 truncate text-sky-400 hover:underline">
                {taskTitle(id) ?? id}
              </Link>
            ))}
          </span>
        </Detail>
      )}
    </dl>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 sm:contents">
      <dt className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase sm:pt-px">{label}</dt>
      <dd className="min-w-0 text-zinc-200 wrap-anywhere">{children}</dd>
    </div>
  )
}

/** A box id: a link to its details while it exists, plain (and marked gone) after. */
function BoxRef({ id, live, onOpen }: { id: string; live: ReadonlySet<string>; onOpen: (id: string) => void }) {
  if (live.has(id))
    return (
      <button type="button" onClick={() => onOpen(id)} className="font-mono text-sky-400 hover:underline" title="Open this box's details">
        {id}
      </button>
    )
  return (
    <span className="font-mono text-zinc-300">
      {id} <span className="font-sans text-zinc-500">(gone)</span>
    </span>
  )
}
