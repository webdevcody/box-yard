// The Coordinator chat as cards: one per task, in the order the chat first named them, so new activity never moves
// one, and the Coordinator's own card (Cody's messages and the answers to them) pinned under them. A card's header is
// its title (full width), then its project, status, PR, how much it holds and when it last changed; closed, its
// latest line. Open, it shows where it came from, its newest entries, a box that replies to its task (CardComposer.tsx),
// and the way to its timeline and its task page. ⤢ opens it in the side panel reply threads use (SideThread.tsx)
// instead, with its whole history. With a project picked in the bar, that project's Captain card (BottomCard.tsx)
// takes the Coordinator card's place.
// A create_tasks batch is one card whose tasks open in place. Finished cards fold into "N done today" at the top, and
// resting ones quiet for Settings' cardsIdleHours into "N idle" next to it; a card with news says "N new" until
// opened, and the ↓ pill steps through them. Mark done (a card's ⋯, an open card, Select, or "Mark all idle as done"
// over the cards) closes tasks as close_task does, after an undo window. What goes in which card is lib/chatCards.ts;
// Cards ⇄ Timeline is the chat header's ViewToggle (lib/coordinatorView.ts).
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  ListChecks,
  CornerDownRight,
  LayoutGrid,
  Layers,
  Link2,
  List,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Send,
  Square,
  SquareCheck,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react"
import { useAgentSettings, useBadgeStatuses, useMarkDoneFromInbox, useMarkTasksDone, useStopTask, useTasksIn } from "../lib/queries"
import { undoClose, usePendingCloses } from "../lib/inbox"
import { useEntityIndex } from "../lib/entities"
import { useTaskTile, useTiles } from "../lib/taskTiles"
import { badgeStatus, type BadgeStatus } from "../lib/prState"
import { CLEARABLE, arrangeCards, batchTaskName, batchTitle, chatCards, newSince, stableCards, type CardEntry, type CardsModel, type ChatCard } from "../lib/chatCards"
import { setPicked, startSelecting, stopSelecting, togglePicked, usePicked, usePickedKeys, useSelecting } from "../lib/cardSelection"
import { confirmDialog } from "../lib/confirm"
import { chipView, isSent, itemMessages, noticeText, type CoordinatorRow } from "../lib/chatUpdates"
import { plainText } from "../lib/captainTranscript"
import { publishedLabel } from "../lib/publishedNotices"
import { isOpen, setOpen, useChipOpen } from "../lib/chipState"
import { markSeen, seenAt, startSeen, useSeen, useSeenAt } from "../lib/cardsSeen"
import { clearFocusCard, revealInTimeline, setCoordinatorView, showCard, showInTimeline, useCoordinatorView, useFocusCard, type TimelineCard } from "../lib/coordinatorView"
import { setChatProjectFilter, useChatProjectFilter } from "../lib/projectBar"
import { isRunning, runningSince } from "../lib/runningTasks"
import type { Provenance } from "../lib/chatProvenance"
import { COORDINATOR_CHAT, closeThread, openCard, toggleCard, toggleExpanded, useCardShown } from "../lib/threads"
import { openInZenPanel } from "../lib/zenPanel"
import { NOTICE_ICON } from "./noticeIcons"
import { ChatLine, FullReplyLink } from "./ChatLine"
import { CardComposer, WorkingLine } from "./CardComposer"
import { BottomCardHead, bottomCardFolded } from "./BottomCard"
import { MESSAGE_BLOCK, MessageActions, MessageMenu, type MenuItem } from "./MessageActions"
import { COMPOSER_FOOTER } from "./Composer"
import { PANEL_ICON, PANEL_WIDE, PanelHeader, type CardPanelProps } from "./SideThread"
import { StickyScroll } from "./StickyScroll"
import { UpdateChip } from "./UpdateChips"
import { ProjectDot, TaskTile, projectColorStyle } from "./TaskIcon"
import { PlacementCardChip } from "./PlacementChip"
import { usePopover } from "./TaskHeader"
import { AppLink, Button, Elapsed, InRepo, LineIcon, MERGED_BADGE, Markdown, PrChip, PriorityPill, STATUS, StatusBadge, TimeAgo, cx } from "./ui"
import { CARDS_IDLE_HOURS, type ChatMessage, type Task } from "../../../shared/types"

/** How many entries an open card shows before "N earlier", and how many more each click adds. */
const CARD_SHOW = 4
const COORDINATOR_SHOW = 3
const EARLIER_STEP = 10

const CARD = "scroll-mt-3 rounded-[10px] border border-zinc-800/80 border-l-[3px] bg-zinc-900/40"
const CARD_HEAD =
  "block w-full cursor-pointer rounded-[9px] py-2 pr-2 pl-3 text-left hover:bg-zinc-900/50 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
const CARD_BODY = "space-y-2 border-t border-zinc-800/70 py-2 pr-2.5 pl-3"
/** The line under a card's title, lined up with it past the tile. */
const UNDER_TITLE = "ml-[30px]"
const FOOT =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-9"
const EARLIER = "flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 pointer-coarse:min-h-9"

export interface CardsLayout {
  /** Every card, unfiltered and unfolded: the side panel finds its card here. */
  all: readonly ChatCard[]
  live: readonly ChatCard[]
  /** Resting and quiet for Settings' cardsIdleHours: "N idle". */
  idle: readonly ChatCard[]
  /** Finished in the last day (or marked done, still in the undo window): "N done today". */
  done: readonly ChatCard[]
  coordinator: readonly CardEntry[]
  /** The newest Coordinator reply: only it offers its next steps, in whichever card holds it. */
  newest: string | null
}

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])

const cardOpenKey = (key: string) => `card:${key}`

/**
 * The cards for the settled chat's rows (useCoordinatorRows), or null while `on` is false (the Timeline shows). Every
 * list that didn't change keeps its object, so the cards view re-renders only for a card with news or a status change.
 */
export function useCards(rows: readonly CoordinatorRow[], prov: Provenance, on: boolean, project: string | null): CardsLayout | null {
  const index = useEntityIndex()
  const tiles = useTiles().tasks
  const statuses = useBadgeStatuses().data
  // Marked done and in its undo window: finished already, as far as the list goes.
  const closing = usePendingCloses()
  const idleHours = useAgentSettings().data?.settings.cardsIdleHours ?? CARDS_IDLE_HOURS.default
  // Cards go idle as time passes, with nothing else changing.
  const minute = useMinute(on)
  const model = useRef<CardsModel | null>(null)
  const cards = useMemo(() => (on ? (model.current = stableCards(model.current, chatCards(rows, index, tiles))) : null), [on, rows, index, tiles])
  const newest = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.type === "message" && r.message.role === "assistant") return r.id
    }
    return null
  }, [rows])
  const last = useRef<CardsLayout | null>(null)
  return useMemo(() => {
    if (!cards) return null
    // A card open in the list when its task finishes (Cody replied in it and is reading the answer) stays put: it
    // folds into "done today" at a later update once Cody has closed it, not while it's being read.
    const shown = last.current?.live
    const stay = (c: ChatCard) => Boolean(shown?.some((s) => s.key === c.key)) && isOpen(cardOpenKey(c.key))
    const statusOf = (id: string) => (closing.has(id) ? "done" : statuses?.[id])
    const { live, idle, done } = arrangeCards(cards.cards, statusOf, (id) => tiles.get(id)?.projectId, minute, project, stay, idleHours * 3_600_000)
    // A project's Coordinator card: what's about no project, or about that one.
    const coordinator = project
      ? cards.coordinator.filter((e) => {
          const projects = prov.projects.get(e.id)
          return !projects?.size || projects.has(project)
        })
      : cards.coordinator
    const p = last.current
    const all = cards.cards
    if (p && sameList(p.all, all) && sameList(p.live, live) && sameList(p.idle, idle) && sameList(p.done, done) && sameList(p.coordinator, coordinator) && p.newest === newest)
      return p
    return (last.current = {
      all: p && sameList(p.all, all) ? p.all : all,
      live: p && sameList(p.live, live) ? p.live : live,
      idle: p && sameList(p.idle, idle) ? p.idle : idle,
      done: p && sameList(p.done, done) ? p.done : done,
      coordinator: p && sameList(p.coordinator, coordinator) ? p.coordinator : coordinator,
      newest,
    })
  }, [cards, statuses, closing, idleHours, minute, tiles, project, prov, newest])
}

/** Now, to the minute, while `on`. */
function useMinute(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/** The newest card or Coordinator entry: the cards first show with everything up to it seen. */
const newestAt = (layout: CardsLayout) => Math.max(0, ...[...layout.live, ...layout.idle, ...layout.done].map((c) => c.last), ...layout.coordinator.map((e) => e.at))

/** Opens a card and scrolls to it, flashing it so the eye finds it. */
function scrollToCard(key: string, open = true) {
  if (open) setOpen([cardOpenKey(key)], true)
  requestAnimationFrame(() => {
    const el = document.getElementById(`card-${key}`)
    if (!el) return
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
    el.classList.remove("card-flash")
    void el.offsetWidth
    el.classList.add("card-flash")
  })
}

/**
 * The cards, then the Coordinator card, but only with "All" in the project bar: a project's Captain card takes its
 * place (ChatPanel). `children` go at the end of the Coordinator card: the reply streaming in and the messages queued
 * behind it.
 */
export const CardsView = memo(function CardsView({
  layout,
  onFollowUp,
  active,
  children,
}: {
  layout: CardsLayout
  onFollowUp: (text: string) => void
  /** A reply is streaming or messages wait: the Coordinator card shows `children`. */
  active: boolean
  children?: ReactNode
}) {
  const { live, idle, done, coordinator, newest } = layout
  // A browser's first look at the cards: what's here is the starting point, not news.
  useEffect(() => startSeen(newestAt(layout)), [layout])
  // "Back to its card": open it (unfolding "done today" or "idle", or dropping the project filter it's behind) and go to it.
  const focus = useFocusCard()
  const project = useChatProjectFilter()
  useEffect(() => {
    if (!focus) return
    // A card's key, or a task's id (a message's "Open card"): a batch's task opens its row too.
    const find = (cards: readonly ChatCard[]) => cards.find((c) => c.key === focus) ?? cards.find((c) => c.taskIds.includes(focus))
    const finished = find(done)
    const quiet = finished ? undefined : find(idle)
    const card = finished ?? quiet ?? find(live)
    if (!card) {
      if (project) setChatProjectFilter(null)
      // Not a card any more (quiet for a day): nothing to go to.
      else clearFocusCard()
      return
    }
    if (finished) setOpen(["cards:done"], true)
    if (quiet) setOpen(["cards:idle"], true)
    if (card.batchId && card.key !== focus) setOpen([`kid:${focus}`], true)
    clearFocusCard()
    scrollToCard(card.key)
  }, [focus, live, idle, done, project])
  // An open card leaving "done today" or "idle" for the list (Cody replied in it, so its task is back at work): go with it.
  const folded = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const was = folded.current
    folded.current = new Set([...done, ...idle].map((c) => c.key))
    const back = live.find((c) => was.has(c.key) && isOpen(cardOpenKey(c.key)))
    if (back) scrollToCard(back.key, false)
  }, [live, idle, done])
  // Select mode ends with the cards (the Timeline, another chat) and on Esc.
  useEffect(() => stopSelecting, [])
  const holder = (c: ChatCard) => (newest && c.entries.some((e) => e.id === newest) ? newest : null)
  return (
    <div data-testid="chat-cards" className="@container space-y-2">
      <CardsBar live={live} idle={idle} done={done} newest={newest} onFollowUp={onFollowUp} />
      {live.map((c) => (
        <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />
      ))}
      {!project && (
        <CoordinatorCard entries={coordinator} next={newest} onFollowUp={onFollowUp} active={active}>
          {children}
        </CoordinatorCard>
      )}
    </div>
  )
})

const FOLD =
  "flex min-w-0 flex-1 basis-[13rem] items-center gap-2 rounded-[10px] border border-dashed border-zinc-800 px-2 py-1.5 text-left text-xs text-zinc-500 hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-10"
const BAR_BUTTON =
  "inline-flex h-full min-h-7 items-center gap-1 rounded-lg border border-zinc-800 px-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none aria-expanded:bg-zinc-900 aria-expanded:text-zinc-100 pointer-coarse:min-h-10"

/** "3 done today" or "4 idle" with their tiles: opens into the cards. */
function Fold({ cards, open, toggle, label, title, testId }: { cards: readonly ChatCard[]; open: boolean; toggle: () => void; label: string; title: string; testId: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={toggle} data-testid={testId} title={title} className={FOLD}>
      <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
      <span className="shrink-0">{label}</span>
      <span className="flex min-w-0 gap-0.5 overflow-hidden">
        {cards.map((c) => (
          <TaskTile key={c.key} id={c.taskIds[0]} />
        ))}
      </span>
      <span className="ml-auto shrink-0 @max-[20rem]:hidden">{open ? "hide" : "show"}</span>
    </button>
  )
}

const hoursLabel = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${Number.isInteger(h) ? h : h.toFixed(1)}h`)

/**
 * Over the cards: "N done today" and "N idle" side by side (stacked when narrow), Select and "Mark all idle as done" on
 * the right; in Select mode, its bar. Then the cards of whichever fold is open.
 */
function CardsBar({
  live,
  idle,
  done,
  newest,
  onFollowUp,
}: {
  live: readonly ChatCard[]
  idle: readonly ChatCard[]
  done: readonly ChatCard[]
  newest: string | null
  onFollowUp: (text: string) => void
}) {
  const [doneOpen, toggleDone] = useChipOpen("cards:done")
  const [idleOpen, toggleIdle] = useChipOpen("cards:idle")
  const selecting = useSelecting()
  const hours = useAgentSettings().data?.settings.cardsIdleHours ?? CARDS_IDLE_HOURS.default
  const resting = useMemo(() => [...idle, ...live], [idle, live])
  const clearable = useClearable(resting)
  const holder = (c: ChatCard) => (newest && c.entries.some((e) => e.id === newest) ? newest : null)
  return (
    <>
      {selecting && <SelectBar cards={resting} clearable={clearable} />}
      {(done.length > 0 || idle.length > 0 || (!selecting && clearable.length > 0)) && (
        <div data-testid="cards-bar" className="flex flex-wrap items-stretch gap-2">
          {done.length > 0 && <Fold cards={done} open={doneOpen} toggle={toggleDone} label={`${done.length} done today`} title="Cards whose tasks finished in the last day" testId="cards-done" />}
          {idle.length > 0 && (
            <Fold
              cards={idle}
              open={idleOpen}
              toggle={toggleIdle}
              label={`${idle.length} idle`}
              title={`Resting cards with no activity for ${hoursLabel(hours)} or more (Settings › Coordinator › Idle after)`}
              testId="cards-idle"
            />
          )}
          {!selecting && clearable.length > 0 && (
            <span className="ml-auto flex shrink-0 items-stretch gap-1">
              <button type="button" onClick={() => startSelecting()} data-testid="cards-select" aria-label="Select" title="Select cards to mark done" className={BAR_BUTTON}>
                <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="@max-[30rem]:hidden">Select</span>
              </button>
              <ClearIdle tasks={clearable} />
            </span>
          )}
        </div>
      )}
      {doneOpen && done.map((c) => <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />)}
      {idleOpen && idle.map((c) => <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />)}
    </>
  )
}

/** The tasks of `cards` that Mark done may close in bulk (lib/chatCards.ts CLEARABLE), in card order, none marked yet. */
function useClearable(cards: readonly ChatCard[]): Task[] {
  const ids = useMemo(() => cards.flatMap((c) => c.taskIds), [cards])
  const tasks = useTasksIn(ids).data ?? NO_TASKS
  const closing = usePendingCloses()
  return useMemo(() => tasks.filter((t) => CLEARABLE.has(t.status) && !closing.has(t.id)), [tasks, closing])
}

/**
 * "Mark all idle as done": a popover listing the tasks it closes (the project bar's filter applies), each one a
 * checkbox to leave it out. Running and queued tasks and ones waiting on Cody are never in it.
 */
function ClearIdle({ tasks }: { tasks: readonly Task[] }) {
  const { open, setOpen, root, trigger } = usePopover()
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set())
  const mark = useMarkTasksDone()
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    setLeft(new Set())
    confirm.current?.focus({ preventScroll: true })
  }, [open])
  const chosen = tasks.filter((t) => !left.has(t.id))
  const toggle = (id: string) =>
    setLeft((l) => {
      const next = new Set(l)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <div ref={root} className="relative flex">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Mark all idle as done"
        title="Mark every resting task in these cards done"
        data-testid="cards-clear-idle"
        className={BAR_BUTTON}
      >
        <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="@max-[30rem]:hidden">Mark all idle as done</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Mark all idle as done"
          data-testid="cards-clear-idle-popover"
          className="absolute top-full right-0 z-30 mt-1 w-80 max-w-[calc(100cqw-0.5rem)] rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm shadow-2xl shadow-black/50"
        >
          <p className="font-medium text-zinc-100">
            Mark {tasks.length} task{tasks.length === 1 ? "" : "s"} done?
          </p>
          <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
            {tasks.map((t) => (
              <li key={t.id}>
                <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs text-zinc-300 hover:bg-zinc-900 pointer-coarse:min-h-10">
                  <input type="checkbox" checked={!left.has(t.id)} onChange={() => toggle(t.id)} className="shrink-0" />
                  <TaskTile id={t.id} />
                  <span className="min-w-0 flex-1 truncate" title={t.title}>
                    {t.title}
                  </span>
                  <StatusBadge status={badgeStatus(t)} />
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-zinc-500">Running and queued tasks and ones waiting on you stay. Messaging a done task picks it back up.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              ref={confirm}
              size="sm"
              variant="primary"
              disabled={!chosen.length}
              data-testid="cards-clear-idle-confirm"
              onClick={() => {
                setOpen(false)
                mark(chosen)
              }}
            >
              <CircleCheck className="h-3.5 w-3.5" /> Mark {chosen.length} done
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Select mode's bar, pinned over the cards: how many are picked, Select all, Mark done, and Cancel (or Esc). */
function SelectBar({ cards, clearable }: { cards: readonly ChatCard[]; clearable: readonly Task[] }) {
  const picked = usePickedKeys()
  const mark = useMarkTasksDone()
  const ids = useMemo(() => new Set(clearable.map((t) => t.id)), [clearable])
  // Only cards with a task Mark done may close can be picked.
  const pickable = useMemo(() => cards.filter((c) => c.taskIds.some((id) => ids.has(id))), [cards, ids])
  const chosen = useMemo(() => {
    const keys = new Set(pickable.filter((c) => picked.has(c.key)).flatMap((c) => c.taskIds))
    return clearable.filter((t) => keys.has(t.id))
  }, [pickable, picked, clearable])
  const all = pickable.length > 0 && pickable.every((c) => picked.has(c.key))
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      stopSelecting()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
  return (
    <div
      role="toolbar"
      aria-label="Selected cards"
      data-testid="cards-select-bar"
      className="sticky top-0 z-20 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-yard-500/40 bg-zinc-950/95 px-2 py-1.5 text-xs text-zinc-300 shadow-lg shadow-black/40 backdrop-blur"
    >
      <span className="whitespace-nowrap" data-testid="cards-select-count">
        {chosen.length ? `${chosen.length} task${chosen.length === 1 ? "" : "s"} selected` : "Pick cards to mark done"}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => setPicked(all ? [] : pickable.map((c) => c.key))} className={FOOT}>
          {all ? "Select none" : "Select all"}
        </button>
        <Button
          size="sm"
          variant="primary"
          disabled={!chosen.length}
          data-testid="cards-select-done"
          onClick={() => {
            mark(chosen)
            stopSelecting()
          }}
        >
          <CircleCheck className="h-3.5 w-3.5" /> Mark done
        </Button>
        <button type="button" onClick={stopSelecting} aria-label="Cancel" title="Cancel (Esc)" className={FOOT}>
          <X className="h-3.5 w-3.5" aria-hidden />
          <span className="@max-[24rem]:hidden">Cancel</span>
        </button>
      </span>
    </div>
  )
}

/**
 * What Mark done does for a card: its task, or a batch's tasks Mark done may close (the running ones and ones asking
 * go on). Null when there's nothing to mark. A running or queued single task is stopped first, so that asks.
 */
function useCardMarkDone(card: ChatCard, tasks: readonly Task[]): { label: string; title: string; run: () => void } | null {
  const mark = useMarkTasksDone()
  const closing = usePendingCloses()
  const open = tasks.filter((t) => t.status !== "done" && !closing.has(t.id))
  if (!card.batchId) {
    const t = open[0]
    if (!t) return null
    const busy = t.status === "working" || t.status === "starting" || t.status === "queued"
    const run = async () => {
      if (busy && !(await confirmDialog({ title: "Stop it and mark it done?", body: `${t.title} is ${t.status === "queued" ? "queued" : "running"}. Mark done stops it and closes it.`, confirmLabel: "Stop and mark done", danger: true })))
        return
      mark([t])
    }
    return { label: "Mark done", title: "Close the task (its workspace is archived). Messaging it picks it back up.", run: () => void run() }
  }
  const these = open.filter((t) => CLEARABLE.has(t.status))
  if (!these.length) return null
  const label = these.length === open.length ? "Mark done" : `Mark ${these.length} task${these.length === 1 ? "" : "s"} done`
  return { label, title: "Close its resting tasks; running ones and ones waiting on you go on", run: () => mark(these) }
}

const FINISHED: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>(["done", "merged"])

/** What a card's header says: its title (a batch's is what its tasks' titles share), its tasks and their statuses. */
function useCardHead(card: ChatCard) {
  const tiles = useTiles().tasks
  const tasks = useTasksIn(card.taskIds).data ?? NO_TASKS
  const first = tiles.get(card.taskIds[0]!)
  const batch = card.batchId ? batchTitle(card.taskIds.map((id) => tiles.get(id)?.title ?? "")) : null
  const title = card.batchId ? (batch ?? `${first?.projectName ?? "A"} batch`) : (first?.title ?? card.key)
  const statuses = useMemo(() => tasks.map(badgeStatus), [tasks])
  return { first, tasks, batch, title, statuses }
}

type CardHead = ReturnType<typeof useCardHead>

/** A card's icon: its task's tile, or a batch's stack. */
function CardIcon({ card, size }: { card: ChatCard; size?: "lg" }) {
  if (!card.batchId) return <TaskTile id={card.taskIds[0]} size={size} />
  return (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-md bg-(--pc)/15 text-(--pc)", size === "lg" ? "h-[22px] w-[22px]" : "h-4 w-4")}>
      <Layers className={size === "lg" ? "h-[13px] w-[13px]" : "h-3 w-3"} />
    </span>
  )
}

/** A card's full-width title: a batch's says how many tasks it holds. */
function CardTitle({ card, title }: { card: ChatCard; title: string }) {
  return (
    <span data-testid="chat-card-title" className="min-w-0 flex-1 text-[13.5px] leading-[22px] font-semibold wrap-anywhere text-zinc-100">
      {title}
      {card.batchId && <span className="text-xs font-normal text-zinc-500"> · {card.taskIds.length} tasks</span>}
    </span>
  )
}

/**
 * The line under a card's title: its project, status, run time and PR (a batch's counts), what it holds, and when.
 * `children` go at its end (a card's ⋯), so the title keeps the card's width.
 */
function CardMeta({ card, head, children }: { card: ChatCard; head: CardHead; children?: ReactNode }) {
  const { first, tasks, statuses } = head
  const updates = card.entries.filter((e) => e.type === "update").length
  const replies = card.entries.length - updates
  return (
    <div className={cx(UNDER_TITLE, "mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-zinc-500")}>
      <span className="flex min-w-0 items-center gap-1.5">
        <ProjectDot projectId={first?.projectId} />
        <span className="truncate text-zinc-400">{first?.projectName}</span>
      </span>
      {card.batchId ? (
        <BatchCounts statuses={statuses} />
      ) : (
        tasks[0] && (
          <>
            <StatusBadge status={statuses[0]!} />
            <PriorityPill task={tasks[0]} />
            <Running task={tasks[0]} />
            <PrChip task={tasks[0]} variant="link" className="text-[11.5px]" />
          </>
        )
      )}
      {card.entries.length > 0 && <span>{countLabel(updates, replies)}</span>}
      <TimeAgo ts={card.last} />
      {children && <span className="ml-auto flex shrink-0 items-center">{children}</span>}
    </div>
  )
}

/** One task's card, or a batch's. */
const TaskChatCard = memo(function TaskChatCard({ card, next, onFollowUp }: { card: ChatCard; next: string | null; onFollowUp: (text: string) => void }) {
  const [open, toggle] = useChipOpen(cardOpenKey(card.key))
  const inPanel = useCardShown(COORDINATOR_CHAT, card.key)
  const head = useCardHead(card)
  const { first, tasks, batch, title, statuses } = head
  const asks = statuses.includes("needs_input")
  const finished = statuses.length > 0 && statuses.every((s) => FINISHED.has(s))
  const markDone = useCardMarkDone(card, tasks)
  const selecting = useSelecting()
  const picked = usePicked(card.key)
  const closing = usePendingCloses()
  const pickable = selecting && tasks.some((t) => CLEARABLE.has(t.status) && !closing.has(t.id))
  const unread = newSince(card.entries, useSeenAt(card.key))
  // Open, its news is in front of Cody.
  useEffect(() => {
    if (open && unread) markSeen(card.key, card.last)
  }, [open, unread, card.key, card.last])
  const onHead = (e: MouseEvent | KeyboardEvent) => {
    // Its PR link, its ⋯ and its ⤢ keep their click.
    if ((e.target as HTMLElement).closest("a, button")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    // In Select mode a click picks it.
    if (selecting) {
      if (pickable) togglePicked(card.key)
    } else toggle()
  }
  return (
    <section
      id={`card-${card.key}`}
      data-testid="chat-card"
      data-card={card.key}
      data-open={open || undefined}
      data-in-panel={inPanel || undefined}
      aria-label={title}
      style={projectColorStyle(first?.color)}
      className={cx(
        CARD,
        "border-l-(--pc)",
        "group/card",
        asks && "border-amber-500/40 border-l-(--pc) bg-amber-500/[0.04]",
        finished && "opacity-75",
        // The card the side panel shows.
        inPanel && "ring-1 ring-yard-400/45",
        selecting && picked && pickable && "border-yard-500/50 bg-yard-500/[0.05]",
        selecting && !pickable && "opacity-50",
      )}
    >
      <div
        role={selecting ? "checkbox" : "button"}
        tabIndex={0}
        aria-expanded={selecting ? undefined : open}
        aria-checked={selecting ? picked && pickable : undefined}
        aria-disabled={selecting && !pickable ? true : undefined}
        title={selecting && !pickable ? "Running, queued, waiting on you or done: Mark done leaves it" : undefined}
        onClick={onHead}
        onKeyDown={onHead}
        className={CARD_HEAD}
      >
        <div className="flex items-start gap-2">
          {selecting && (
            <span aria-hidden data-testid="chat-card-pick" className={cx("mt-[3px] shrink-0", picked && pickable ? "text-yard-400" : "text-zinc-600")}>
              {picked && pickable ? <SquareCheck className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            </span>
          )}
          <CardIcon card={card} size="lg" />
          <CardTitle card={card} title={title} />
          {unread > 0 && (
            <span data-testid="chat-card-unread" title={`${unread} new since you last opened it`} className="mt-[3px] inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-yard-400">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yard-400" />
              {unread} new
            </span>
          )}
          <button
            type="button"
            data-testid="chat-card-panel"
            onClick={() => toggleCard(COORDINATOR_CHAT, card.key)}
            aria-pressed={inPanel}
            aria-label="Open in the side panel"
            title={inPanel ? "Close the side panel" : "Open in the side panel"}
            className="-my-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none aria-pressed:text-yard-300 pointer-coarse:-my-2 pointer-coarse:h-9 pointer-coarse:w-9"
          >
            <Maximize2 className="h-[13px] w-[13px]" aria-hidden />
          </button>
          <ChevronRight className={cx("mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
        </div>
        <CardMeta card={card} head={head}>
          {!selecting && <CardMenu card={card} markDone={markDone} pickable={tasks.some((t) => CLEARABLE.has(t.status) && !closing.has(t.id))} />}
        </CardMeta>
        {!open && <LatestLine card={card} batch={batch} />}
        {!open && card.batchId && <BatchBar ids={card.taskIds} statuses={statuses} />}
      </div>
      {open && <CardBody card={card} batch={batch} title={title} tasks={tasks} next={next} onFollowUp={onFollowUp} markDone={markDone} />}
    </section>
  )
})

/** A card's ⋯ at the end of its meta line (on hover or focus, always on touch): Mark done, Select, Show in timeline. */
function CardMenu({ card, markDone, pickable }: { card: ChatCard; markDone: ReturnType<typeof useCardMarkDone>; pickable: boolean }) {
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const items: MenuItem[] = [
    ...(markDone ? [{ icon: CircleCheck, label: markDone.label, run: markDone.run }] : []),
    ...(pickable ? [{ icon: ListChecks, label: "Select", run: () => startSelecting(card.key) }] : []),
    { icon: List, label: "Show in timeline", run: () => showInTimeline({ key: card.key, taskIds: card.taskIds }) },
  ]
  return (
    <>
      <button
        ref={more}
        type="button"
        data-testid="chat-card-more"
        onClick={() => setMenu(!menu)}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="Card actions"
        title="Mark done, select…"
        className={cx(
          "-my-1 grid h-5 w-6 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:-my-2 pointer-coarse:h-9 pointer-coarse:w-9",
          "opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 aria-expanded:bg-zinc-800 aria-expanded:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <MoreHorizontal className="h-[14px] w-[14px]" aria-hidden />
      </button>
      {menu && <MessageMenu trigger={more} items={items} onClose={() => setMenu(false)} />}
    </>
  )
}

const NO_TASKS: Task[] = []

/** Its agent is on a turn now (not just queued for one). */
const isWorking = (t: Task) => t.status === "working" || t.status === "starting"

/** A running task's place and time ("💻 12m"), which Zen's running-tasks badge showed before the cards replaced it. */
function Running({ task }: { task: Task }) {
  if (!isRunning(task)) return null
  return (
    <span className="inline-flex items-center gap-1">
      <PlacementCardChip task={task} />
      <Elapsed since={runningSince(task)} title={task.turnStartedAt ? "This turn started" : "In this state since"} className="tabular-nums" />
    </span>
  )
}

const countLabel = (updates: number, replies: number) =>
  [updates && `${updates} update${updates === 1 ? "" : "s"}`, replies && `${replies} repl${replies === 1 ? "y" : "ies"}`].filter(Boolean).join(" · ")

const statusStyle = (s: BadgeStatus) => (s === "merged" ? MERGED_BADGE : STATUS[s])

/** A batch's statuses in a line: "1 needs you · 2 working · 3 merged". */
function BatchCounts({ statuses }: { statuses: readonly BadgeStatus[] }) {
  const counts = new Map<BadgeStatus, number>()
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      {[...counts].map(([s, n], i) => (
        <span key={s} className={cx("inline-flex items-center gap-1", s === "needs_input" && "text-amber-300")}>
          {i > 0 && <span className="text-zinc-700">·</span>}
          <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", statusStyle(s).dot)} />
          {n} {statusStyle(s).label.toLowerCase()}
        </span>
      ))}
    </span>
  )
}

/** A closed batch card's tasks as a strip of status colours. */
function BatchBar({ ids, statuses }: { ids: readonly string[]; statuses: readonly BadgeStatus[] }) {
  const tiles = useTiles().tasks
  return (
    <div aria-hidden className={cx(UNDER_TITLE, "mt-1.5 flex flex-wrap gap-[3px]")}>
      {ids.map((id, i) => (
        <i key={id} title={`${tiles.get(id)?.title ?? id}: ${statuses[i] ? statusStyle(statuses[i]).label : ""}`} className={cx("h-1.5 w-3.5 rounded-[3px]", statuses[i] ? statusStyle(statuses[i]).dot.replace("animate-pulse", "") : "bg-zinc-700")} />
      ))}
    </div>
  )
}

type Line = { icon: LucideIcon; className: string; who: string; text: string }

/** One line of what a card's newest entry says: its icon, then who, then the text. */
function entryLine(e: CardEntry): Line {
  if (e.type === "update" && e.item.type === "files") {
    const g = e.item.group
    const { icon, className } = NOTICE_ICON.artifact
    return { icon, className, who: capitalise(publishedLabel(g.files.length)), text: g.files.map((f) => f.title).join(", ") }
  }
  const m = e.type === "message" ? e.message : itemMessages(e.item)[0]!
  if (isSent(m)) return { icon: Send, className: "text-yard-400", who: "You", text: plainText(noticeText(m).text) }
  if (m.role === "assistant") return { icon: Bot, className: "text-yard-400", who: "Coordinator", text: plainText(m.content.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/gm, "")) }
  if (m.role === "error") return { icon: AlertTriangle, className: "text-red-400", who: "Error", text: plainText(m.content) }
  const v = chipView(m)
  if (v.captain) return { icon: Bot, className: "text-sky-400", who: v.source?.label ?? "Captain", text: v.preview }
  const { icon, className } = NOTICE_ICON[v.kind]
  return { icon, className, who: capitalise(v.verb), text: v.preview }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** A closed card's newest entry, two lines at most. In a batch, the task it's about leads. */
function LatestLine({ card, batch }: { card: ChatCard; batch: string | null }) {
  const e = card.entries[card.entries.length - 1]
  const line = useMemo(() => (e ? entryLine(e) : null), [e])
  const kid = card.batchId && e?.tasks.length === 1 ? e.tasks[0]! : null
  const kidTile = useTaskTile(kid)
  const who = line && kid && kidTile ? `${batchTaskName(kidTile.title, batch)}${line.who ? ` ${line.who.toLowerCase()}` : ""}` : line?.who
  return (
    <div data-testid="chat-card-latest" className={cx(UNDER_TITLE, "mt-1 flex items-start gap-1.5 text-[12.5px] leading-normal text-zinc-400")}>
      {line ? (
        <>
          <LineIcon icon={line.icon} className={cx("h-3.5 w-3.5", line.className)} />
          <span className="line-clamp-2 min-w-0 wrap-anywhere">
            {who && <b className="font-medium text-zinc-300">{who}: </b>}
            {line.text}
          </span>
        </>
      ) : (
        <span className="text-zinc-500">{card.origin ? "Just started" : "No updates yet"}</span>
      )}
    </div>
  )
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** How many entries the side panel shows before "N earlier": its whole history, nearly always. */
const PANEL_SHOW = 50

/**
 * A card's session, in the card or in the side panel: where it came from, a batch's tasks, its newest entries, and
 * who's answering. In the panel, its history goes under a divider.
 */
function CardSession({
  card,
  batch,
  title,
  tasks,
  next,
  onFollowUp,
  inPanel = false,
}: {
  card: ChatCard
  batch: string | null
  title: string
  tasks: readonly Task[]
  next: string | null
  onFollowUp: (text: string) => void
  inPanel?: boolean
}) {
  // A batch's tasks keep their own entries under their rows; the card has what's about several, and replies.
  const own = useMemo(() => (card.batchId ? card.entries.filter((e) => e.type === "message" || e.tasks.length !== 1) : card.entries), [card])
  const updates = own.filter((e) => e.type === "update").length
  const label = own.length ? countLabel(updates, own.length - updates) : "No updates yet"
  return (
    <>
      {card.origin && (
        <button
          type="button"
          onClick={() => revealInTimeline(card.origin!.id)}
          title="Show it in the timeline"
          data-testid="chat-card-origin"
          className="flex w-full min-w-0 items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 pointer-coarse:min-h-9"
        >
          <LineIcon icon={CornerDownRight} className="h-3 w-3" />
          <span className="shrink-0">From your message {clock(card.origin.createdAt)}:</span>
          <q className="min-w-0 truncate text-zinc-400 italic">{plainText(card.origin.content)}</q>
        </button>
      )}
      {card.batchId && (
        <div data-testid="batch-tasks" className="flex flex-col gap-0.5">
          {card.taskIds.map((id) => (
            <BatchTask key={id} id={id} task={tasks.find((t) => t.id === id)} entries={card.entries} batch={batch} next={next} onFollowUp={onFollowUp} />
          ))}
        </div>
      )}
      {/* A batch's history is under its rows: its own divider only when it has some of its own. */}
      {inPanel && (own.length > 0 || !card.batchId) && (
        <div data-testid="card-panel-divider" className="flex items-center gap-2 pt-1 text-[11px] text-zinc-500">
          <span className="shrink-0">{label}</span>
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
      )}
      <CardEntries entries={own} show={inPanel ? PANEL_SHOW : CARD_SHOW} own={!card.batchId} next={next} onFollowUp={onFollowUp} />
      {!card.batchId && tasks[0] && isWorking(tasks[0]) && <WorkingLine who={tasks[0].title} />}
    </>
  )
}

/** An open card: its session, the box to reply in (a batch's are in its tasks' rows), and the way to its timeline, the side panel and its page. */
function CardBody({
  card,
  batch,
  title,
  tasks,
  next,
  onFollowUp,
  markDone,
}: {
  card: ChatCard
  batch: string | null
  title: string
  tasks: readonly Task[]
  next: string | null
  onFollowUp: (text: string) => void
  markDone: ReturnType<typeof useCardMarkDone>
}) {
  const showInTimelineCard = useCallback(() => showInTimeline({ key: card.key, taskIds: card.taskIds }), [card.key, card.taskIds])
  return (
    <div data-testid="chat-card-body" className={CARD_BODY}>
      <CardSession card={card} batch={batch} title={title} tasks={tasks} next={next} onFollowUp={onFollowUp} />
      {!card.batchId && tasks[0] && <CardComposer task={tasks[0]} />}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <button type="button" onClick={showInTimelineCard} className={FOOT} data-testid="chat-card-timeline">
          <List className="h-3 w-3" aria-hidden />
          Show in timeline
        </button>
        <button type="button" onClick={() => openCard(COORDINATOR_CHAT, card.key)} className={FOOT} data-testid="chat-card-open-panel">
          <Maximize2 className="h-3 w-3" aria-hidden />
          Open in panel
        </button>
        {!card.batchId && (
          <AppLink href={`/tasks/${card.taskIds[0]}`} className={cx(FOOT, "text-yard-400 hover:text-yard-300")}>
            Task page
          </AppLink>
        )}
        {markDone && (
          <button type="button" onClick={markDone.run} title={markDone.title} className={cx(FOOT, "ml-auto")} data-testid="chat-card-mark-done">
            <CircleCheck className="h-3 w-3" aria-hidden />
            {markDone.label}
          </button>
        )}
      </div>
    </div>
  )
}

/** The panel's box: the chat's sticky footer. */
const PANEL_BOX = cx(COMPOSER_FOOTER, "px-3")

type CardPanelOwn = { layout: CardsLayout | null; onFollowUp: (text: string) => void }

/**
 * A card in the side panel (⤢), the panel reply threads open in, with their header: "Tasks › [tile] title", ✓ (Mark
 * done, or Reopen once done), ⋯, Maximize ↔ Minimize and ×. Then its header, its whole history under a divider, and its
 * box at the bottom.
 */
export const CardPanel = memo(function CardPanel({ chat, open, headerClassName, layout, onFollowUp }: CardPanelProps & CardPanelOwn) {
  const card = layout?.all.find((c) => c.key === open.card) ?? null
  if (!card)
    return (
      <div data-testid="card-panel" className="relative flex h-full min-h-0 flex-col">
        <PanelHeader chat={chat} open={open} className={headerClassName} crumb="Tasks" closeLabel="Close" closeTitle="Close (Esc)" title={null} />
        <p className="px-4 py-6 text-sm text-zinc-500">This card isn't in the chat any more.</p>
      </div>
    )
  const next = layout?.newest && card.entries.some((e) => e.id === layout.newest) ? layout.newest : null
  return <CardPanelView chat={chat} open={open} headerClassName={headerClassName} card={card} next={next} onFollowUp={onFollowUp} />
})

function CardPanelView({
  chat,
  open,
  headerClassName,
  card,
  next,
  onFollowUp,
}: CardPanelProps & { card: ChatCard; next: string | null; onFollowUp: (text: string) => void }) {
  const head = useCardHead(card)
  const { first, tasks, batch, title } = head
  const task = card.batchId ? null : (tasks[0] ?? null)
  const pane = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const markDone = useMarkDoneFromInbox()
  const stop = useStopTask()
  const closing = usePendingCloses()
  const [, navigate] = useLocation()
  const unread = newSince(card.entries, useSeenAt(card.key))
  // In the panel, its news is in front of Cody.
  useEffect(() => {
    if (unread && !open.closing) markSeen(card.key, card.last)
  }, [unread, open.closing, card.key, card.last])
  // Focus moves in with it, so Esc closes it.
  useEffect(() => pane.current?.focus({ preventScroll: true }), [])
  const page = task ? `/tasks/${task.id}` : null
  // Done, or marked done and still in its undo window.
  const done = task ? task.status === "done" || closing.has(task.id) : false
  // A closed task reopens with a message (closing archived its workspace), so Reopen goes to the box.
  const reopen = () => {
    if (task && !undoClose(task.id)) pane.current?.querySelector("textarea")?.focus()
  }
  const showItsCard = () => {
    showCard(card.key)
    // A sheet covers the chat: get out of the way of the card.
    if (open.expanded) return toggleExpanded(chat)
    const aside = pane.current?.closest("aside")
    if (aside && getComputedStyle(aside).position === "absolute") closeThread(chat)
  }
  const items: MenuItem[] = [
    { icon: List, label: "Show in timeline", run: () => showInTimeline({ key: card.key, taskIds: card.taskIds }) },
    ...(page ? [{ icon: Link2, label: "Open the task page", run: () => void (openInZenPanel(page) || navigate(page)) }] : []),
    // Its agent's turn.
    ...(task && isRunning(task) ? [{ icon: Square, label: "Stop answering", run: () => stop.mutate(task.id) }] : []),
    { icon: LayoutGrid, label: "Show its card", run: showItsCard },
  ]
  // Over the whole chat, it reads in a column.
  const wide = open.expanded && "mx-auto w-full max-w-3xl"
  return (
    <div ref={pane} tabIndex={-1} data-testid="card-panel" className="relative flex h-full min-h-0 flex-col focus:outline-none">
      <PanelHeader
        chat={chat}
        open={open}
        className={headerClassName}
        crumb="Tasks"
        closeLabel="Close"
        closeTitle="Close (Esc). The card stays in the chat."
        title={
          <span style={projectColorStyle(first?.color)} title={title} className="flex min-w-0 items-center gap-1.5">
            <CardIcon card={card} />
            <span data-testid="card-panel-title" className="min-w-0 truncate text-zinc-400">
              {title}
            </span>
          </span>
        }
      >
        {task &&
          (done ? (
            <button type="button" data-testid="card-panel-done" onClick={reopen} aria-pressed aria-label="Reopen" title="Done. Reopen it: write to it below" className={PANEL_ICON}>
              <Undo2 className="h-4 w-4" />
            </button>
          ) : (
            <button type="button" data-testid="card-panel-done" onClick={() => markDone(task)} aria-pressed={false} aria-label="Mark done" title="Mark done" className={PANEL_ICON}>
              <CircleCheck className="h-4 w-4" />
            </button>
          ))}
        <button ref={more} type="button" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="More card actions" title="More" className={PANEL_ICON}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menu && <MessageMenu trigger={more} items={items} onClose={() => setMenu(false)} />}
        <button
          type="button"
          data-testid="card-panel-expand"
          onClick={() => toggleExpanded(chat)}
          aria-pressed={Boolean(open.expanded)}
          aria-label={open.expanded ? "Back beside the chat" : "Expand over the chat"}
          title={open.expanded ? "Back beside the chat" : "Expand over the chat"}
          className={cx(PANEL_ICON, PANEL_WIDE)}
        >
          {open.expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </PanelHeader>
      <StickyScroll count={card.entries.length} resetKey={card.key} className={cx("px-3 py-3", wide)} contentClassName="space-y-2.5">
        <div data-testid="card-panel-head" style={projectColorStyle(first?.color)} className="rounded-[10px] border border-l-[3px] border-zinc-800/80 border-l-(--pc) bg-zinc-900/40 py-2 pr-2.5 pl-3">
          <div className="flex items-start gap-2">
            <CardIcon card={card} size="lg" />
            <CardTitle card={card} title={title} />
          </div>
          <CardMeta card={card} head={head} />
        </div>
        <CardSession card={card} batch={batch} title={title} tasks={tasks} next={next} onFollowUp={onFollowUp} inPanel />
      </StickyScroll>
      {task && <CardComposer task={task} className={cx(PANEL_BOX, wide)} />}
    </div>
  )
}

/** One of a batch's tasks: a row that opens into its own entries. */
const BatchTask = memo(function BatchTask({
  id,
  task,
  entries,
  batch,
  next,
  onFollowUp,
}: {
  id: string
  /** Undefined once it's deleted. */
  task: Task | undefined
  entries: readonly CardEntry[]
  batch: string | null
  next: string | null
  onFollowUp: (text: string) => void
}) {
  const [open, toggle] = useChipOpen(`kid:${id}`)
  const tile = useTaskTile(id)
  const status = task && badgeStatus(task)
  const own = useMemo(() => entries.filter((e) => e.tasks.includes(id)), [entries, id])
  return (
    <div data-testid="batch-task" data-task={id} className={cx("rounded-lg", open && "border border-zinc-800 bg-zinc-950/50", status === "needs_input" && "bg-amber-500/[0.07]")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pr-1 pl-1.5 text-left text-[12.5px] text-zinc-300 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-10"
      >
        <TaskTile id={id} />
        <span className="min-w-0 flex-1 truncate">{batchTaskName(tile?.title ?? id, batch)}</span>
        {task && (
          <span className="text-[11px] text-zinc-500 @max-[22rem]:hidden">
            <Running task={task} />
          </span>
        )}
        {task && <PriorityPill task={task} compact />}
        {status && <StatusBadge status={status} />}
        <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && <BatchTaskBody id={id} task={task} entries={own} name={batchTaskName(tile?.title ?? id, batch)} next={next} onFollowUp={onFollowUp} />}
    </div>
  )
})

/** An open batch task: its entries, who's working, and its box. */
function BatchTaskBody({
  id,
  task,
  entries,
  name,
  next,
  onFollowUp,
}: {
  id: string
  task: Task | undefined
  entries: readonly CardEntry[]
  name: string
  next: string | null
  onFollowUp: (text: string) => void
}) {
  return (
    <div className="space-y-1.5 px-2 pt-1 pb-2">
      {entries.length ? <CardEntries entries={entries} show={CARD_SHOW} own next={next} onFollowUp={onFollowUp} /> : <div className="text-xs text-zinc-500">No updates yet.</div>}
      {task && isWorking(task) && <WorkingLine who={name} />}
      {task && <CardComposer task={task} />}
      <AppLink href={`/tasks/${id}`} className={cx(FOOT, "text-yard-400 hover:text-yard-300")}>
        Task page
      </AppLink>
    </div>
  )
}

/**
 * The newest `show` entries, with "N earlier" for more. `own`: a task's
 * card, whose chips needn't name it. The update that ends the turn Cody's message started shows as the agent's reply,
 * not a chip: it answers Cody.
 */
function CardEntries({
  entries,
  show,
  own,
  next,
  onFollowUp,
}: {
  entries: readonly CardEntry[]
  show: number
  own: boolean
  next: string | null
  onFollowUp: (text: string) => void
}) {
  const [limit, setLimit] = useState(show)
  const shown = entries.length > limit ? entries.slice(-limit) : entries
  const hidden = entries.length - shown.length
  const answers = useMemo(() => answersOf(entries), [entries])
  return (
    <>
      {hidden > 0 && (
        <button type="button" onClick={() => setLimit((n) => n + EARLIER_STEP)} className={EARLIER} data-testid="card-earlier">
          <ChevronUp className="h-3 w-3" aria-hidden />
          {hidden} earlier
        </button>
      )}
      {shown.map((e) =>
        e.type === "message" ? (
          <ChatLine key={e.id} m={e.message} sources={e.sources} next={e.id === next} inCard onFollowUp={onFollowUp} />
        ) : answers.has(e.id) && e.item.type === "notice" ? (
          <AgentReply key={e.id} m={e.item.message} />
        ) : (
          <UpdateChip key={e.id} item={e.item} own={own} />
        ),
      )}
    </>
  )
}

/** Turn ends: "finished its turn" and "is done". A question or a failure is a full card anyway. */
const TURN_ENDS: ReadonlySet<string> = new Set(["message", "done"])

/** The updates that end the turn of a task Cody had just sent a message to from its card. */
function answersOf(entries: readonly CardEntry[]): Set<string> {
  const out = new Set<string>()
  const waiting = new Set<string>()
  for (const e of entries) {
    if (e.type === "message") {
      const t = e.message.meta?.taskId
      if (isSent(e.message) && typeof t === "string") waiting.add(t)
      continue
    }
    if (e.item.type !== "notice") continue
    const t = e.item.message.meta?.taskId
    if (typeof t === "string" && waiting.has(t) && TURN_ENDS.has(chipView(e.item.message).kind)) {
      out.add(e.id)
      waiting.delete(t)
    }
  }
  return out
}

/** A task's agent answering Cody in its card: its tile and name, then its words from the turn's notice. */
const AgentReply = memo(function AgentReply({ m }: { m: ChatMessage }) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  const tile = useTaskTile(taskId)
  const { text, truncated } = useMemo(() => noticeText(m), [m])
  const v = chipView(m)
  const { icon: Icon, className, label } = NOTICE_ICON[v.kind]
  return (
    <div id={`chat-${m.id}`} data-chat-id={m.id} data-testid="agent-reply" className={cx(MESSAGE_BLOCK, "text-sm text-zinc-200")}>
      <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-zinc-500">
        <TaskTile id={taskId} />
        <span className="min-w-0 truncate font-medium text-zinc-300">{tile?.title ?? v.source?.label}</span>
        <Icon className={cx("h-3 w-3 shrink-0", className)} aria-label={label} />
        <span className="shrink-0">{v.verb}</span>
        <TimeAgo ts={m.createdAt} />
      </div>
      <InRepo taskId={taskId} projectId={projectId}>
        <Markdown>{text}</Markdown>
        {truncated && taskId && <FullReplyLink taskId={taskId} />}
      </InRepo>
      <MessageActions text={text} anchorId={m.id} />
    </div>
  )
})

/** Cody's own thread, pinned under the cards: Cody's messages and the answers that aren't about one task. Folds to its header (BottomCard.tsx). */
function CoordinatorCard({ entries, next, onFollowUp, active, children }: { entries: readonly CardEntry[]; next: string | null; onFollowUp: (text: string) => void; active: boolean; children?: ReactNode }) {
  const folded = bottomCardFolded.use()
  const last = entries[entries.length - 1]
  const latest = useMemo(() => {
    if (!last) return null
    const line = entryLine(last)
    return `${line.who}: ${line.text}`
  }, [last])
  return (
    <section id="card-coordinator" data-testid="coordinator-card" aria-label="Coordinator" className={cx(CARD, "border-l-yard-500 bg-zinc-900/25")}>
      <BottomCardHead
        icon={
          <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-yard-400/15 text-yard-400">
            <Bot className="h-[13px] w-[13px]" />
          </span>
        }
        title="Coordinator"
        tag="your main chat"
        hint="What you type below lands here. Each task it starts gets a card above."
        latest={latest}
        working={active}
      />
      {!folded && (entries.length > 0 || active) && (
        <div className="space-y-3 border-t border-zinc-800/70 px-3 py-2.5">
          <CardEntries entries={entries} show={COORDINATOR_SHOW} own={false} next={next} onFollowUp={onFollowUp} />
          {children}
        </div>
      )}
    </section>
  )
}

/** "↓ 3 new in [tiles]": the cards with news. Each click goes to the next of them. */
export const NewCardsPill = memo(function NewCardsPill({ cards }: { cards: readonly ChatCard[] }) {
  const seen = useSeen()
  const fresh = useMemo(() => cards.flatMap((c) => {
    const n = newSince(c.entries, seenAt(c.key, seen))
    return n ? [{ card: c, n }] : []
  }), [cards, seen])
  const step = useRef(0)
  if (!fresh.length) return null
  const total = fresh.reduce((sum, f) => sum + f.n, 0)
  const go = () => scrollToCard(fresh[step.current++ % fresh.length]!.card.key, false)
  return (
    <button
      type="button"
      onClick={go}
      data-testid="new-cards-pill"
      title="Go to the next card with news"
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-yard-400/50 bg-[#1c1708] px-3 py-1.5 text-xs font-medium whitespace-nowrap text-yard-300 shadow-lg hover:bg-[#2a220b] pointer-coarse:py-2.5"
    >
      <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {total} new in
      <span className="flex min-w-0 gap-0.5 overflow-hidden">
        {fresh.map((f) => (f.card.batchId ? <Layers key={f.card.key} className="h-4 w-4 shrink-0 text-zinc-300" aria-hidden /> : <TaskTile key={f.card.key} id={f.card.taskIds[0]} />))}
      </span>
    </button>
  )
})

const VIEWS: { id: "cards" | "timeline"; label: string; title: string; icon: LucideIcon }[] = [
  { id: "cards", label: "Cards", title: "Cards: one per task", icon: LayoutGrid },
  { id: "timeline", label: "Timeline", title: "Timeline: everything in order", icon: List },
]

/** Cards ⇄ Timeline, in the chat's header. Icons only in a narrow header. */
export const ViewToggle = memo(function ViewToggle() {
  const view = useCoordinatorView()
  return (
    <div role="group" aria-label="View" data-testid="view-toggle" className="flex shrink-0 items-center rounded-lg border border-zinc-800 p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={view === v.id}
          aria-label={v.label}
          title={v.title}
          onClick={() => setCoordinatorView(v.id)}
          className={cx(
            "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:px-2.5",
            view === v.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200",
          )}
        >
          <v.icon className="h-3 w-3 shrink-0" aria-hidden />
          <span className="@max-[27rem]:hidden">{v.label}</span>
        </button>
      ))}
    </div>
  )
})

/** Above the Timeline of one card's tasks: what it shows, the whole Timeline, and the way back to the card. */
export function TimelineCardBanner({ card, empty }: { card: TimelineCard; empty: boolean }) {
  const tiles = useTiles().tasks
  const titles = card.taskIds.map((id) => tiles.get(id)?.title ?? id)
  const name = titles.length > 1 ? (batchTitle(titles) ?? `${titles.length} tasks`) : titles[0]
  return (
    <div data-testid="timeline-card-banner" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400">
      {titles.length > 1 ? <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <TaskTile id={card.taskIds[0]} />}
      <span className="min-w-0 flex-1 truncate">{empty ? `Nothing about ${name} in the chat yet` : `Only ${name} in the timeline`}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => showInTimeline(null)} className={cx(FOOT, "text-yard-400 hover:text-yard-300")}>
          <X className="h-3 w-3" aria-hidden />
          Full timeline
        </button>
        <button type="button" onClick={() => showCard(card.key)} className={cx(FOOT, "text-yard-400 hover:text-yard-300")}>
          <LayoutGrid className="h-3 w-3" aria-hidden />
          Back to its card
        </button>
      </span>
    </div>
  )
}
