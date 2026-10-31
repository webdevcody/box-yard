// The Coordinator chat as cards: one per task, in the order the chat first named them, so new activity never moves
// one, and the Coordinator's own card (Cody's messages and the answers to them) pinned under them. A card's header is
// its title (full width), then one row with its status, its PR chip, its news and age, and its actions as buttons
// (44px under a finger): ✓ Mark done, ⤢ the side panel, → its task page and fold. Closed, its latest line. Open, it
// shows where it came from, its newest entries and a box that replies to its task (CardComposer.tsx); nothing in it
// repeats the header. ⤢ opens it in the side panel reply threads use (SideThread.tsx) instead, with its whole
// history. With a project picked in the bar, that project's Captain card (BottomCard.tsx) takes the Coordinator card's place.
// Every task has its own card, one create_tasks call's next to each other. Finished cards fold into "N done today" at the top, and
// resting ones quiet for Settings' cardsIdleHours into "N idle" next to it; a card with news says "N new" until
// opened, and the ↓ pill steps through them. Mark done (a card's ✓, Select, or "Mark all idle as done" in Select's
// bar) closes tasks as close_task does, after an undo window. What goes in which card is lib/chatCards.ts;
// "Tasks only" is the chat header's TasksOnlyToggle (lib/coordinatorView.ts).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  LocateFixed,
  CircleCheck,
  ListChecks,
  CornerDownRight,
  LayoutGrid,
  Link2,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelBottomClose,
  Send,
  Square,
  SquareCheck,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react"
import { useAgentSettings, useBadgeStatuses, useMarkDoneFromInbox, useMarkTasksDone, useStopTask, useTask, useTasksIn } from "../lib/queries"
import { undoClose, usePendingCloses } from "../lib/inbox"
import { useEntityIndex } from "../lib/entities"
import { useTaskTile, useTiles } from "../lib/taskTiles"
import { badgeStatus, type BadgeStatus } from "../lib/prState"
import { CLEARABLE, arrangeCards, chatCards, newSince, stableCards, type CardEntry, type CardsModel, type ChatCard } from "../lib/chatCards"
import { setPicked, startSelecting, stopSelecting, togglePicked, usePicked, usePickedKeys, useSelecting } from "../lib/cardSelection"
import { confirmDialog } from "../lib/confirm"
import { chipView, isSent, itemMessages, noticeText, type CoordinatorRow } from "../lib/chatUpdates"
import { plainText } from "../lib/captainTranscript"
import { publishedLabel } from "../lib/publishedNotices"
import { isOpen, setOpen, useChipOpen, useOpenAmong } from "../lib/chipState"
import { markSeen, seenAt, startSeen, useSeen, useSeenAt } from "../lib/cardsSeen"
import { clearFocusCard, clearShownMessage, setTasksOnly, showCard, showMessage, useFocusCard, useShownMessage, useTasksOnly } from "../lib/coordinatorView"
import { revealChatMessage } from "../lib/reveal"
import { dockTarget, setDockTarget, useDocked, useDockTarget } from "../lib/dockComposer"
import { shortShas } from "../lib/linkify"
import { digestEntries, digestSummary, eventLine, isEvent, type DigestPiece } from "../lib/cardDigest"
import { jumpDirection, nextJump, scrollParent, type JumpDirection } from "../lib/cardJump"
import { setChatProjectFilter, useChatProjectFilter } from "../lib/projectBar"
import { isRunning, runningSince } from "../lib/runningTasks"
import type { Provenance } from "../lib/chatProvenance"
import { COORDINATOR_CHAT, closeThread, toggleCard, toggleExpanded, useCardShown } from "../lib/threads"
import { openInZenPanel } from "../lib/zenPanel"
import { NOTICE_ICON } from "./noticeIcons"
import { ChatLine, FullReplyLink } from "./ChatLine"
import { CardComposer, WorkingLine } from "./CardComposer"
import { BottomCardHead, HiddenCard, bottomCardFolded } from "./BottomCard"
import { MESSAGE_BLOCK, MessageActions, MessageMenu, type MenuItem } from "./MessageActions"
import { COMPOSER_FOOTER } from "./Composer"
import { PANEL_ICON, PANEL_WIDE, PanelHeader, type CardPanelProps } from "./SideThread"
import { StickyScroll } from "./StickyScroll"
import { UpdateChip } from "./UpdateChips"
import { ProjectDot, TaskTile, projectColorStyle } from "./TaskIcon"
import { PlacementCardChip } from "./PlacementChip"
import { usePopover } from "./TaskHeader"
import { BAR_CHIP, CHIP_OFF } from "./ProjectBar"
import { AppLink, Button, Elapsed, InRepo, LineIcon, Markdown, PrChip, PriorityPill, StatusBadge, StatusDot, TimeAgo, cx } from "./ui"
import { CARDS_IDLE_HOURS, type ChatMessage, type Task } from "../../../shared/types"

/** How many entries an open card shows before "N earlier", and how many more each click adds. */
const CARD_SHOW = 4
const COORDINATOR_SHOW = 3
const EARLIER_STEP = 10

const CARD = "@container scroll-mt-3 rounded-[10px] border border-zinc-800/80 border-l-[3px] bg-zinc-900/40"
const CARD_HEAD =
  "block w-full cursor-pointer rounded-[9px] py-2 pr-2 pl-3 text-left hover:bg-zinc-900/50 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
const CARD_BODY = "space-y-2 border-t border-zinc-800/70 py-2 pr-2.5 pl-3"
/** The lines under a card's title, lined up with it past the tile (a narrow card has no tile). */
const UNDER_TITLE = "ml-[30px] @max-[30rem]:ml-0"
const FOOT =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11"
const EARLIER = "flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 pointer-coarse:min-h-11"

export interface CardsLayout {
  /** Every card, unfiltered and unfolded: the side panel finds its card here. */
  all: readonly ChatCard[]
  live: readonly ChatCard[]
  /** Resting and quiet for Settings' cardsIdleHours: "N idle". */
  idle: readonly ChatCard[]
  /** Finished in the last day (or marked done, still in the undo window): "N done today". */
  done: readonly ChatCard[]
  coordinator: readonly CardEntry[]
  /** The Coordinator card's entries whatever the project bar's pick: a link to a message finds it here. */
  allCoordinator: readonly CardEntry[]
  /** The newest Coordinator reply: only it offers its next steps, in whichever card holds it. */
  newest: string | null
}

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])

const cardOpenKey = (key: string) => `card:${key}`

/**
 * The cards for the settled chat's rows (useCoordinatorRows), or null while `on` is false (an empty chat). Every
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
    if (
      p &&
      sameList(p.all, all) &&
      sameList(p.live, live) &&
      sameList(p.idle, idle) &&
      sameList(p.done, done) &&
      sameList(p.coordinator, coordinator) &&
      sameList(p.allCoordinator, cards.coordinator) &&
      p.newest === newest
    )
      return p
    return (last.current = {
      all: p && sameList(p.all, all) ? p.all : all,
      live: p && sameList(p.live, live) ? p.live : live,
      idle: p && sameList(p.idle, idle) ? p.idle : idle,
      done: p && sameList(p.done, done) ? p.done : done,
      coordinator: p && sameList(p.coordinator, coordinator) ? p.coordinator : coordinator,
      allCoordinator: p && sameList(p.allCoordinator, cards.coordinator) ? p.allCoordinator : cards.coordinator,
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

const FLASH_MS = 1800
const flashes = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * Opens a card and scrolls to it, ringing it in its project's colour so the eye finds it (styles.css .card-flash), and
 * moves focus there for the keyboard and screen readers.
 */
function scrollToCard(key: string, open = true) {
  if (open) setOpen([cardOpenKey(key)], true)
  requestAnimationFrame(() => {
    const el = document.getElementById(`card-${key}`)
    if (!el) return
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
    el.focus({ preventScroll: true })
    el.classList.remove("card-flash")
    void el.offsetWidth
    el.classList.add("card-flash")
    // Without motion the ring is still: take it off when the fade would have ended.
    clearTimeout(flashes.get(el))
    flashes.set(el, setTimeout(() => el.classList.remove("card-flash"), FLASH_MS))
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
    // A card's key: its task's id (a message's "Open card").
    const find = (cards: readonly ChatCard[]) => cards.find((c) => c.key === focus)
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
  // Select mode ends with the cards (another chat) and on Esc.
  useEffect(() => stopSelecting, [])
  const tasksOnly = useTasksOnly()
  const holder = (c: ChatCard) => (newest && c.entries.some((e) => e.id === newest) ? newest : null)
  return (
    <div data-testid="chat-cards" className="@container space-y-2">
      <CardsBar live={live} idle={idle} done={done} newest={newest} onFollowUp={onFollowUp} />
      {live.map((c) => (
        <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />
      ))}
      {project ? null : tasksOnly ? (
        <CoordinatorHidden />
      ) : (
        <CoordinatorCard entries={coordinator} next={newest} onFollowUp={onFollowUp} active={active}>
          {children}
        </CoordinatorCard>
      )}
    </div>
  )
})

/** A count pill on the filter bar's right: "✓ 24 done today", "☾ 3 idle"; its icon and number alone when narrow. */
const FOLD_PILL = cx(BAR_CHIP, CHIP_OFF, "pr-2 pointer-coarse:px-3 aria-expanded:border-zinc-600 aria-expanded:bg-zinc-800 aria-expanded:text-zinc-50")
const BAR_BUTTON = cx(BAR_CHIP, CHIP_OFF, "px-2 text-zinc-400 hover:text-zinc-100 pointer-coarse:w-11 pointer-coarse:justify-center pointer-coarse:px-0")

/** "✓ 24 done today" or "☾ 4 idle": opens its cards over the list. */
function Fold({ count, open, toggle, icon: Icon, iconClass, label, title, testId }: { count: number; open: boolean; toggle: () => void; icon: LucideIcon; iconClass: string; label: string; title: string; testId: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={toggle} data-testid={testId} title={title} aria-label={`${count} ${label}`} className={FOLD_PILL}>
      <Icon className={cx("h-3.5 w-3.5 shrink-0", iconClass)} aria-hidden />
      <b className="font-semibold tabular-nums">{count}</b>
      <span className="text-zinc-400 @max-[30rem]/bar:hidden"> {label}</span>
    </button>
  )
}

const hoursLabel = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${Number.isInteger(h) ? h : h.toFixed(1)}h`)

/**
 * On the filter bar's right (ProjectBar's `trailing`): "✓ N done today" and "☾ N idle", each opening its cards at the
 * top of the list, and Select, which picks cards to mark done (Mark all idle as done is in its bar).
 */
export const CardsBarPills = memo(function CardsBarPills({ layout }: { layout: CardsLayout }) {
  const { live, idle, done } = layout
  const [doneOpen, toggleDone] = useChipOpen("cards:done")
  const [idleOpen, toggleIdle] = useChipOpen("cards:idle")
  const selecting = useSelecting()
  const hours = useAgentSettings().data?.settings.cardsIdleHours ?? CARDS_IDLE_HOURS.default
  const resting = useMemo(() => [...idle, ...live], [idle, live])
  const clearable = useClearable(resting)
  return (
    <>
      {done.length > 0 && (
        <Fold count={done.length} open={doneOpen} toggle={toggleDone} icon={CircleCheck} iconClass="text-emerald-400" label="done today" title="Cards whose tasks finished in the last day" testId="cards-done" />
      )}
      {idle.length > 0 && (
        <Fold
          count={idle.length}
          open={idleOpen}
          toggle={toggleIdle}
          icon={Moon}
          iconClass="text-zinc-400"
          label="idle"
          title={`Resting cards with no activity for ${hoursLabel(hours)} or more (Settings › Coordinator › Idle after)`}
          testId="cards-idle"
        />
      )}
      {!selecting && clearable.length > 0 && (
        <button type="button" onClick={() => startSelecting()} data-testid="cards-select" aria-label="Select" title="Select cards to mark done" className={BAR_BUTTON}>
          <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="@max-[36rem]/bar:hidden">Select</span>
        </button>
      )}
    </>
  )
})

/** Over the cards: in Select mode, its bar. Then the cards of whichever fold the filter bar has open. */
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
  const [doneOpen] = useChipOpen("cards:done")
  const [idleOpen] = useChipOpen("cards:idle")
  const selecting = useSelecting()
  const resting = useMemo(() => [...idle, ...live], [idle, live])
  const clearable = useClearable(resting)
  const holder = (c: ChatCard) => (newest && c.entries.some((e) => e.id === newest) ? newest : null)
  return (
    <>
      {selecting && <SelectBar cards={resting} clearable={clearable} />}
      {doneOpen && done.map((c) => <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />)}
      {idleOpen && idle.map((c) => <TaskChatCard key={c.key} card={c} next={holder(c)} onFollowUp={onFollowUp} />)}
    </>
  )
}

/** The tasks of `cards` that Mark done may close in bulk (lib/chatCards.ts CLEARABLE), in card order, none marked yet. */
function useClearable(cards: readonly ChatCard[]): Task[] {
  const ids = useMemo(() => cards.map((c) => c.taskId), [cards])
  const tasks = useTasksIn(ids).data ?? NO_TASKS
  const closing = usePendingCloses()
  return useMemo(() => tasks.filter((t) => CLEARABLE.has(t.status) && !closing.has(t.id)), [tasks, closing])
}

/**
 * "Mark all idle as done": a popover listing the tasks it closes (the project bar's filter applies), each one a
 * checkbox to leave it out. Running and queued tasks and ones waiting on Cody are never in it.
 */
function ClearIdle({ tasks, onDone }: { tasks: readonly Task[]; onDone: () => void }) {
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
        className={FOOT}
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
                onDone()
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

/**
 * Select mode's bar, pinned over the cards: how many are picked, Mark all idle as done, Select all, Mark done, and
 * Cancel (or Esc).
 */
function SelectBar({ cards, clearable }: { cards: readonly ChatCard[]; clearable: readonly Task[] }) {
  const picked = usePickedKeys()
  const mark = useMarkTasksDone()
  const ids = useMemo(() => new Set(clearable.map((t) => t.id)), [clearable])
  // Only cards with a task Mark done may close can be picked.
  const pickable = useMemo(() => cards.filter((c) => ids.has(c.taskId)), [cards, ids])
  const chosen = useMemo(() => {
    const keys = new Set(pickable.filter((c) => picked.has(c.key)).map((c) => c.taskId))
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
        {clearable.length > 0 && <ClearIdle tasks={clearable} onDone={stopSelecting} />}
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
 * What Mark done does for a card: closes its task. Null when there's nothing to mark. A running or queued task is
 * stopped first, so that asks.
 */
function useCardMarkDone(task: Task | undefined): { label: string; title: string; run: () => void } | null {
  const mark = useMarkTasksDone()
  const closing = usePendingCloses()
  if (!task || task.status === "done" || closing.has(task.id)) return null
  const t = task
  const busy = t.status === "working" || t.status === "starting" || t.status === "queued"
  const run = async () => {
    if (busy && !(await confirmDialog({ title: "Stop it and mark it done?", body: `${t.title} is ${t.status === "queued" ? "queued" : "running"}. Mark done stops it and closes it.`, confirmLabel: "Stop and mark done", danger: true })))
      return
    mark([t])
  }
  return { label: "Mark done", title: "Close the task (its workspace is archived). Messaging it picks it back up.", run: () => void run() }
}

const FINISHED: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>(["done", "merged"])
/** At work: its card's stripe pulses (styles.css .stripe-pulse). */
const AT_WORK: ReadonlySet<BadgeStatus> = new Set<BadgeStatus>(["working", "starting", "queued"])

/** What a card's header says: its task's tile (title, project), the task, and its status. */
function useCardHead(card: ChatCard) {
  const tile = useTaskTile(card.taskId)
  const task = useTask(card.taskId).data ?? undefined
  const title = tile?.title ?? card.key
  const status = task ? badgeStatus(task) : undefined
  return { tile, task, title, status }
}

type CardHead = ReturnType<typeof useCardHead>

/** A card's full-width title. */
function CardTitle({ title }: { title: string }) {
  return (
    <span data-testid="chat-card-title" className="min-w-0 flex-1 text-[13.5px] leading-[22px] font-semibold wrap-anywhere text-zinc-100">
      {title}
    </span>
  )
}

/**
 * The line under a card's title: its status (unless its PR chip says "Merged" already), run time, PR, news and age;
 * its project only under "All" in a wide card (the stripe is its colour). `actions` go at its end, so the title keeps
 * the card's whole width.
 */
function CardMeta({ head, last, unread = 0, actions }: { head: CardHead; last: number; unread?: number; actions?: ReactNode }) {
  const { tile, task, status } = head
  const picked = useChatProjectFilter() !== null
  const merged = status === "merged" && Boolean(task?.prUrl)
  return (
    <div data-testid="chat-card-meta" className={cx(UNDER_TITLE, "mt-0.5 flex items-center gap-2 text-[11.5px] text-zinc-500")}>
      {/* What it says wraps in its own space; the buttons keep the line's end, so they never take a line of their own. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {!picked && tile?.projectName && (
          <span data-testid="chat-card-project" className="flex min-w-0 items-center gap-1.5 @max-[30rem]:hidden">
            <ProjectDot projectId={tile.projectId} />
            <span className="truncate text-zinc-400">{tile.projectName}</span>
          </span>
        )}
        {task && status && (
          <>
            {!merged && <StatusDot status={status} className="text-[11.5px]" />}
            <PriorityPill task={task} />
            <Running task={task} />
            <PrChip task={task} className="text-[11.5px]" />
          </>
        )}
        {unread > 0 && (
          <span data-testid="chat-card-unread" title={`${unread} new since you last opened it`} className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-yard-400">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yard-400" />
            {unread} new
          </span>
        )}
        <TimeAgo ts={last} />
      </div>
      {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  )
}

/** A card header's buttons: 28px with a mouse, 44px under a finger. */
const HEAD_BUTTON =
  "grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:w-11"

/** One task's card. */
const TaskChatCard = memo(function TaskChatCard({ card, next, onFollowUp }: { card: ChatCard; next: string | null; onFollowUp: (text: string) => void }) {
  const [open, toggle] = useChipOpen(cardOpenKey(card.key))
  const inPanel = useCardShown(COORDINATOR_CHAT, card.key)
  const head = useCardHead(card)
  const { tile, task, title, status } = head
  const asks = status === "needs_input"
  const finished = status !== undefined && FINISHED.has(status)
  const atWork = status !== undefined && AT_WORK.has(status)
  const markDone = useCardMarkDone(task)
  const selecting = useSelecting()
  // The ✓ on a closed card: only a resting one (as Mark all idle), so a glance never stops a turn or skips a question.
  // Open, any task's (a running one asks first).
  const check = open ? markDone : task && CLEARABLE.has(task.status) ? markDone : null
  const picked = usePicked(card.key)
  const closing = usePendingCloses()
  const pickable = selecting && Boolean(task && CLEARABLE.has(task.status) && !closing.has(task.id))
  const unread = newSince(card.entries, useSeenAt(card.key))
  // Open, its news is in front of Cody.
  useEffect(() => {
    if (open && unread) markSeen(card.key, card.last)
  }, [open, unread, card.key, card.last])
  // The docked box (DockComposer.tsx) follows the card Cody opens, and goes back to the chat's own when it closes.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open === wasOpen.current) return
    wasOpen.current = open
    if (open) setDockTarget(card.key)
    else if (dockTarget() === card.key) setDockTarget(null)
  }, [open, card.key])
  const onHead = (e: MouseEvent | KeyboardEvent) => {
    // Its PR link and its buttons keep their click.
    if ((e.target as HTMLElement).closest("a, button")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    // In Select mode a click picks it.
    if (selecting) {
      if (pickable) togglePicked(card.key)
    } else toggle()
  }
  const actions = !selecting && (
    <>
      {check && (
        <button type="button" data-testid="chat-card-check" onClick={check.run} aria-label={check.label} title={open ? check.title : check.label} className={cx(HEAD_BUTTON, "hover:bg-emerald-500/10 hover:text-emerald-300")}>
          <CircleCheck className="h-[15px] w-[15px]" aria-hidden />
        </button>
      )}
      <button
        type="button"
        data-testid="chat-card-panel"
        onClick={() => toggleCard(COORDINATOR_CHAT, card.key)}
        aria-pressed={inPanel}
        aria-label="Open in the side panel"
        title={inPanel ? "Close the side panel" : "Open in the side panel"}
        className={cx(HEAD_BUTTON, "aria-pressed:text-yard-300")}
      >
        <Maximize2 className="h-[13px] w-[13px]" aria-hidden />
      </button>
      <AppLink href={`/tasks/${card.taskId}`} title="Open the task page" className={cx(HEAD_BUTTON, "text-yard-400 hover:text-yard-300")}>
        <ArrowRight className="h-[15px] w-[15px]" aria-hidden />
        <span className="sr-only">Task page</span>
      </AppLink>
      <button type="button" data-testid="chat-card-fold" onClick={toggle} aria-expanded={open} aria-label={open ? "Fold the card" : "Open the card"} title={open ? "Fold" : "Open"} className={HEAD_BUTTON}>
        <ChevronDown className={cx("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </button>
    </>
  )
  return (
    <section
      id={`card-${card.key}`}
      data-testid="chat-card"
      data-card={card.key}
      data-open={open || undefined}
      data-in-panel={inPanel || undefined}
      data-at-work={atWork || undefined}
      aria-label={title}
      tabIndex={-1}
      style={projectColorStyle(tile?.color)}
      className={cx(
        CARD,
        "border-l-(--pc)",
        "group/card outline-none focus-visible:ring-2 focus-visible:ring-(--pc)/60",
        atWork && "stripe-pulse",
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
          <TaskTile id={card.taskId} size="lg" className="@max-[30rem]:hidden" />
          <CardTitle title={title} />
        </div>
        <CardMeta head={head} last={card.last} unread={unread} actions={actions} />
        {!open && <LatestLine card={card} />}
      </div>
      {open && <CardBody card={card} task={task} next={next} onFollowUp={onFollowUp} />}
    </section>
  )
})

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

type Line = { icon: LucideIcon; className: string; who: string; text: string }

/** One line of what a card's newest entry says: its icon, then who, then the text. */
function entryLine(e: CardEntry): Line {
  if (e.type === "update" && e.item.type === "files") {
    const g = e.item.group
    const { icon, className } = NOTICE_ICON.artifact
    return { icon, className, who: capitalise(publishedLabel(g.files.length)), text: g.files.map((f) => f.title).join(", ") }
  }
  const m = e.type === "message" ? e.message : itemMessages(e.item)[0]!
  if (isSent(m)) return { icon: Send, className: "text-yard-400", who: "You", text: shortShas(plainText(noticeText(m).text)) }
  if (m.role === "assistant") return { icon: Bot, className: "text-yard-400", who: "Coordinator", text: shortShas(plainText(m.content.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/gm, ""))) }
  if (m.role === "error") return { icon: AlertTriangle, className: "text-red-400", who: "Error", text: shortShas(plainText(m.content)) }
  const v = chipView(m)
  if (v.captain) return { icon: Bot, className: "text-sky-400", who: v.source?.label ?? "Captain", text: v.preview }
  const { icon, className } = NOTICE_ICON[v.kind]
  return { icon, className, who: capitalise(v.verb), text: v.preview }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** A closed card's newest entry, two lines at most. */
function LatestLine({ card }: { card: ChatCard }) {
  const e = card.entries[card.entries.length - 1]
  const line = useMemo(() => (e ? entryLine(e) : null), [e])
  const who = line?.who
  return (
    <div data-testid="chat-card-latest" className={cx(UNDER_TITLE, "mt-1 flex items-start gap-1.5 text-[12.5px] leading-normal text-zinc-400")}>
      {line ? (
        <>
          <LineIcon icon={line.icon} className={cx("h-3.5 w-3.5", line.className)} />
          <span className="line-clamp-2 min-w-0 wrap-anywhere">
            {who && <b className="font-medium text-zinc-300">{line.text ? `${who}: ` : who}</b>}
            {line.text}
          </span>
        </>
      ) : (
        <span className="text-zinc-500">{card.origin ? "Just started" : card.startedBy ? `Started by ${card.startedBy}` : "No updates yet"}</span>
      )}
    </div>
  )
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** How many entries the side panel shows before "N earlier": its whole history, nearly always. */
const PANEL_SHOW = 50

/**
 * A card's session, in the card or in the side panel: where it came from, its newest entries, and who's answering. In
 * the panel, its history goes under a divider.
 */
function CardSession({
  card,
  task,
  next,
  onFollowUp,
  inPanel = false,
}: {
  card: ChatCard
  /** Undefined once it's deleted. */
  task: Task | undefined
  next: string | null
  onFollowUp: (text: string) => void
  inPanel?: boolean
}) {
  const entries = card.entries
  const updates = entries.filter((e) => e.type === "update").length
  const label = entries.length ? countLabel(updates, entries.length - updates) : "No updates yet"
  return (
    <>
      {card.origin && (
        <button
          type="button"
          onClick={() => revealChatMessage(card.origin!.id)}
          title="Show it in the Coordinator card"
          data-testid="chat-card-origin"
          className="flex w-full min-w-0 items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          <LineIcon icon={CornerDownRight} className="h-3 w-3" />
          <span className="shrink-0">From your message {clock(card.origin.createdAt)}:</span>
          <q className="min-w-0 truncate text-zinc-400 italic">{plainText(card.origin.content)}</q>
        </button>
      )}
      {!card.origin && !entries.length && card.startedBy && (
        <div data-testid="chat-card-started" className="flex min-w-0 items-start gap-1.5 px-1 py-0.5 text-xs text-zinc-500">
          <LineIcon icon={CornerDownRight} className="h-3 w-3" />
          <span>Started by {card.startedBy}</span>
        </div>
      )}
      {inPanel && (
        <div data-testid="card-panel-divider" className="flex items-center gap-2 pt-1 text-[11px] text-zinc-500">
          <span className="shrink-0">{label}</span>
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
      )}
      <CardEntries entries={entries} show={inPanel ? PANEL_SHOW : CARD_SHOW} own next={next} onFollowUp={onFollowUp} />
      {task && isWorking(task) && <WorkingLine who={task.title} />}
    </>
  )
}

/**
 * An open card: its session and the box to reply in, which a narrow chat docks at its bottom instead
 * (DockComposer.tsx). Its header has the way to the side panel, its page and Mark done.
 */
function CardBody({ card, task, next, onFollowUp }: { card: ChatCard; task: Task | undefined; next: string | null; onFollowUp: (text: string) => void }) {
  const docked = useDocked()
  return (
    <div data-testid="chat-card-body" className={CARD_BODY}>
      <CardSession card={card} task={task} next={next} onFollowUp={onFollowUp} />
      {task && !docked && <CardComposer task={task} />}
    </div>
  )
}

/**
 * The card the docked box sends to: the one Cody opened last (lib/dockComposer.ts), while it's open and shown (not
 * folded away or behind another project). Null: the chat's own box.
 */
export function useDockCard(layout: CardsLayout | null): ChatCard | null {
  const key = useDockTarget()
  const [open] = useChipOpen(cardOpenKey(key ?? ""))
  if (!key || !open || !layout) return null
  return layout.live.find((c) => c.key === key) ?? layout.idle.find((c) => c.key === key) ?? layout.done.find((c) => c.key === key) ?? null
}

/** The open cards the docked box can send to, in the list's order: its "To" menu. */
export function useOpenCards(layout: CardsLayout | null): ChatCard[] {
  const cards = useMemo(() => (layout ? [...layout.live, ...layout.idle, ...layout.done] : []), [layout])
  const keys = useMemo(() => cards.map((c) => cardOpenKey(c.key)), [cards])
  const open = useOpenAmong(keys)
  return useMemo(() => {
    const on = new Set(open.split("\n"))
    return cards.filter((c) => on.has(cardOpenKey(c.key)))
  }, [cards, open])
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
  const { tile, task, title } = head
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
          <span style={projectColorStyle(tile?.color)} title={title} className="flex min-w-0 items-center gap-1.5">
            <TaskTile id={card.taskId} />
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
        <div data-testid="card-panel-head" style={projectColorStyle(tile?.color)} className="rounded-[10px] border border-l-[3px] border-zinc-800/80 border-l-(--pc) bg-zinc-900/40 py-2 pr-2.5 pl-3">
          <div className="flex items-start gap-2">
            <TaskTile id={card.taskId} size="lg" />
            <CardTitle title={title} />
          </div>
          <CardMeta head={head} last={card.last} />
        </div>
        <CardSession card={card} task={task} next={next} onFollowUp={onFollowUp} inPanel />
      </StickyScroll>
      {task && <CardComposer task={task} className={cx(PANEL_BOX, wide)} />}
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
  paging,
}: {
  entries: readonly CardEntry[]
  show: number
  own: boolean
  next: string | null
  onFollowUp: (text: string) => void
  /** Held by the caller (the Coordinator card folds its history back from its header); else its own. */
  paging?: [number, (n: number) => void]
}) {
  const local = useState(show)
  const [limit, setLimit] = paging ?? local
  const answers = useMemo(() => answersOf(entries), [entries])
  // A task's card folds its runs of events into digests (lib/cardDigest.ts); the Coordinator card has none.
  const pieces = useMemo(() => (own ? digestEntries(entries, answers) : entries.map((entry): DigestPiece => ({ type: "entry", entry }))), [own, entries, answers])
  const shown = pieces.length > limit ? pieces.slice(-limit) : pieces
  const hidden = pieces.slice(0, pieces.length - shown.length).reduce((n, p) => n + (p.type === "digest" ? p.entries.length : 1), 0)
  // A link to one of its entries (lib/coordinatorView.ts showMessage): page back to it, open the digest it's in, then
  // scroll to it in the cards.
  const wanted = useShownMessage()
  const at = wanted ? pieces.findIndex((p) => (p.type === "digest" ? p.entries.some((e) => e.id === wanted) : p.entry.id === wanted)) : -1
  const need = at < 0 ? 0 : pieces.length - at
  const folded = at >= 0 && pieces[at]!.type === "digest" ? pieces[at]!.id : null
  const [unfolded] = useChipOpen(digestKey(folded ?? ""))
  useEffect(() => {
    if (!wanted || !need) return
    if (need > limit) return setLimit(need)
    if (folded && !unfolded) return setOpen([digestKey(folded)], true)
    requestAnimationFrame(() => {
      const el = findInCards(wanted)
      if (!el) return
      clearShownMessage(wanted)
      el.scrollIntoView?.({ block: "center", behavior: "smooth" })
    })
  }, [wanted, need, limit, setLimit, folded, unfolded])
  const entry = (e: CardEntry) =>
    e.type === "message" ? (
      <ChatLine key={e.id} m={e.message} sources={own ? null : e.sources} next={e.id === next} inCard onFollowUp={onFollowUp} />
    ) : answers.has(e.id) && e.item.type === "notice" ? (
      <AgentReply key={e.id} m={e.item.message} own={own} />
    ) : (
      <UpdateChip key={e.id} item={e.item} own={own} />
    )
  return (
    <>
      {hidden > 0 && (
        <button type="button" onClick={() => setLimit(limit + EARLIER_STEP)} className={EARLIER} data-testid="card-earlier" title="Show more">
          <ChevronUp className="h-3 w-3" aria-hidden />
          {hidden} earlier
        </button>
      )}
      {shown.map((p) =>
        p.type === "digest" ? (
          <EventDigest key={p.id} id={p.id} entries={p.entries} />
        ) : own && p.entry.type === "message" && isEvent(p.entry, answers) ? (
          // A lone event that's a message (a merge request): a quiet chip, like the rest.
          <UpdateChip key={p.entry.id} item={{ type: "notice", id: p.entry.id, message: p.entry.message }} own />
        ) : (
          entry(p.entry)
        ),
      )}
    </>
  )
}

const digestKey = (id: string) => `digest:${id}`

/**
 * A task card's run of events as one quiet line: "Auto-merged as ff8fc23 · 3 events". A tap opens one chip per event
 * under it (each opens to its whole text).
 */
const EventDigest = memo(function EventDigest({ id, entries }: { id: string; entries: readonly CardEntry[] }) {
  const [open, toggle] = useChipOpen(digestKey(id))
  const summary = useMemo(() => digestSummary(entries), [entries])
  const newest = entries[entries.length - 1]!
  return (
    <div data-testid="event-digest" data-open={open || undefined}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? "Hide these events" : entries.map(eventLine).join("\n")}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
        <span data-testid="event-digest-summary" className="min-w-0 truncate text-zinc-300">
          {summary}
        </span>
        <span className="shrink-0">· {entries.length} events</span>
        <span className="shrink-0 @max-[24rem]:hidden">
          <TimeAgo ts={newest.at} />
        </span>
        <ChevronDown className={cx("ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div data-testid="event-digest-events" className="mt-0.5 ml-2.5 border-l border-zinc-800 pl-2">
          {entries.map((e) => (
            <UpdateChip key={e.id} item={e.type === "update" ? e.item : { type: "notice", id: e.id, message: e.message }} own />
          ))}
        </div>
      )}
    </div>
  )
})

/** A message in the cards list (not the side panel): its root, or an update chip's. */
export function findInCards(id: string): Element | null {
  const q = CSS.escape(id)
  return document.querySelector(`[data-testid="chat-cards"] [data-chat-id="${q}"], [data-testid="chat-cards"] [id="chat-${q}"]`)
}

/** How long a link waits for its card to show the message before giving up. */
const SHOW_MESSAGE_MS = 3000

/**
 * A link to a chat message (a schedule run's "View in chat", a card's "From your message", a reply's "from:" line): go
 * to it in the cards. One on screen scrolls into view. Else the card that holds it opens (unfolding "done today" or
 * "idle", or dropping the project filter it's behind), pages back to it and scrolls there. False when no card holds it
 * (a tool call, an update about a deleted task).
 */
export function revealInCards(layout: CardsLayout | null, id: string): boolean {
  const there = findInCards(id)
  if (there) {
    requestAnimationFrame(() => there.scrollIntoView?.({ block: "center", behavior: "smooth" }))
    return true
  }
  if (!layout) return false
  const card = layout.all.find((c) => c.entries.some((e) => e.id === id))
  if (card) {
    showMessage(id)
    showCard(card.key)
  } else if (layout.allCoordinator.some((e) => e.id === id)) {
    showMessage(id)
    // The Coordinator card shows only under "All", unfolded, and without "Tasks only".
    setChatProjectFilter(null)
    setTasksOnly(false)
    bottomCardFolded.set(false)
  } else return false
  setTimeout(() => clearShownMessage(id), SHOW_MESSAGE_MS)
  return true
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

/**
 * A task's agent answering Cody: its tile and name (not in its own card, whose header says them), then its words from
 * the turn's notice.
 */
const AgentReply = memo(function AgentReply({ m, own }: { m: ChatMessage; own: boolean }) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  const tile = useTaskTile(taskId)
  const { text, truncated } = useMemo(() => noticeText(m), [m])
  const v = chipView(m)
  const { icon: Icon, className, label } = NOTICE_ICON[v.kind]
  return (
    <div id={`chat-${m.id}`} data-chat-id={m.id} data-testid="agent-reply" className={cx(MESSAGE_BLOCK, "text-sm text-zinc-200")}>
      <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-zinc-500">
        {!own && (
          <>
            <TaskTile id={taskId} />
            <span className="min-w-0 truncate font-medium text-zinc-300">{tile?.title ?? v.source?.label}</span>
          </>
        )}
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
  // Its newest few; "N earlier" pages back, and "Show less" in its header (pinned while its history scrolls by) folds it again.
  const paging = useState(COORDINATOR_SHOW)
  const [limit, setLimit] = paging
  const unfolded = limit > COORDINATOR_SHOW && entries.length > COORDINATOR_SHOW
  const card = useRef<HTMLElement>(null)
  const fold = () => {
    setLimit(COORDINATOR_SHOW)
    requestAnimationFrame(() => card.current?.scrollIntoView?.({ block: "nearest" }))
  }
  return (
    <section ref={card} id="card-coordinator" data-testid="coordinator-card" aria-label="Coordinator" className={cx(CARD, "border-l-yard-500 bg-zinc-900/25")}>
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
      >
        {unfolded && !folded && (
          <button type="button" onClick={fold} data-testid="coordinator-fold" title={`Fold its history back to the newest ${COORDINATOR_SHOW}`} className={cx(FOOT, "-my-0.5 shrink-0")}>
            <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden />
            <span className="@max-[24rem]:hidden">Show less</span>
          </button>
        )}
      </BottomCardHead>
      {!folded && (entries.length > 0 || active) && (
        <div className="space-y-3 border-t border-zinc-800/70 px-3 py-2.5">
          <CardEntries entries={entries} show={COORDINATOR_SHOW} own={false} next={next} onFollowUp={onFollowUp} paging={paging} />
          {children}
        </div>
      )}
    </section>
  )
}

/** In place of the Coordinator card while "Tasks only" hides it: what's hidden, and the way back. */
function CoordinatorHidden() {
  return <HiddenCard label="Coordinator card" onShow={() => setTasksOnly(false)} testId="coordinator-hidden" />
}

/** What covers the bottom of the chat: nothing, the pill sits in the line over the box. */
const PILL_INSET = 0

/**
 * Which way the card `key` is from what's on screen in its scroller (lib/cardJump.ts), kept up to date as the chat
 * scrolls, resizes or the cards move.
 */
function useJumpDirection(key: string | null, cards: readonly ChatCard[]): JumpDirection {
  const [dir, setDir] = useState<JumpDirection>("down")
  useLayoutEffect(() => {
    if (!key) return
    let frame = 0
    const measure = () => {
      frame = 0
      const el = document.getElementById(`card-${key}`)
      if (!el) return
      const box = scrollParent(el)
      const view = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
      setDir(jumpDirection(el.getBoundingClientRect(), view, PILL_INSET))
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    // Capture: the chat's scroller doesn't bubble its scroll.
    document.addEventListener("scroll", later, { capture: true, passive: true })
    window.addEventListener("resize", later)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", later, { capture: true })
      window.removeEventListener("resize", later)
    }
  }, [key, cards])
  return dir
}

const ARROW: Record<JumpDirection, { icon: LucideIcon; where: string }> = {
  up: { icon: ArrowUp, where: "above" },
  down: { icon: ArrowDown, where: "below" },
  here: { icon: LocateFixed, where: "on screen" },
}

/**
 * "↑ 6 new · [tile] Fix login +2": the cards with news. It names the card a click goes to, and its arrow says which way
 * that is from what's on screen; each click goes on to the next one down, round to the top again.
 */
export const NewCardsPill = memo(function NewCardsPill({ cards }: { cards: readonly ChatCard[] }) {
  const seen = useSeen()
  const fresh = useMemo(() => cards.flatMap((c) => {
    const n = newSince(c.entries, seenAt(c.key, seen))
    return n ? [{ card: c, n }] : []
  }), [cards, seen])
  const [last, setLast] = useState<string | null>(null)
  const order = useMemo(() => cards.map((c) => c.key), [cards])
  const key = nextJump(order, fresh.map((f) => f.card.key), last)
  const dir = useJumpDirection(key, cards)
  const target = key ? fresh.find((f) => f.card.key === key)!.card : null
  if (!target) return null
  const total = fresh.reduce((sum, f) => sum + f.n, 0)
  const { icon: Arrow, where } = ARROW[dir]
  const more = fresh.length - 1
  const go = () => {
    scrollToCard(target.key, false)
    setLast(target.key)
  }
  return (
    <button
      type="button"
      onClick={go}
      data-testid="new-cards-pill"
      data-direction={dir}
      data-target={target.key}
      title={more ? `Go to this card (${where}); click again for the next of ${fresh.length} cards with news` : `Go to this card (${where})`}
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-yard-400/50 bg-[#1c1708] px-2.5 text-xs font-medium whitespace-nowrap text-yard-300 hover:bg-[#2a220b] focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-3.5"
    >
      <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{total} new</span>
      <span aria-hidden className="text-yard-400/60">
        ·
      </span>
      <PillTarget card={target} where={where} />
      {more > 0 && (
        <span data-testid="new-cards-more" className="shrink-0 rounded-full bg-yard-400/15 px-1.5 text-[11px] text-yard-300">
          +{more}
        </span>
      )}
    </button>
  )
})

/** The card the pill goes to: its icon and title, cut short. A narrow line has room for the icon only; the title is still read out. */
function PillTarget({ card, where }: { card: ChatCard; where: string }) {
  const tile = useTaskTile(card.taskId)
  return (
    <span className="flex min-w-0 items-center gap-1" style={projectColorStyle(tile?.color)}>
      <TaskTile id={card.taskId} />
      <span data-testid="new-cards-target" className="max-w-[16rem] min-w-0 truncate text-zinc-100 @max-[34rem]/dock:sr-only">
        {tile?.title ?? card.key}
      </span>
      <span className="sr-only">, {where}</span>
    </span>
  )
}

const TOGGLE_BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-2.5"

/**
 * "Tasks only", in the chat's header: hides the card under the task cards, the Coordinator's under "All" or the picked
 * project's Captain's (lib/coordinatorView.ts; this browser remembers each). Its icon only in a narrow header.
 */
export const TasksOnlyToggle = memo(function TasksOnlyToggle() {
  const picked = useChatProjectFilter() !== null
  const tasksOnly = useTasksOnly(picked)
  const card = picked ? "the Captain card" : "the Coordinator card"
  return (
    <div data-testid="tasks-only-toggle" className="flex shrink-0 items-center rounded-lg border border-zinc-800 p-0.5 pointer-coarse:border-0 pointer-coarse:p-0">
      <button
        type="button"
        aria-pressed={tasksOnly}
        aria-label={`Tasks only: hide ${card}`}
        title={tasksOnly ? `Tasks only: ${card} is hidden. Click to show it` : `Tasks only: hide ${card} under the task cards`}
        onClick={() => setTasksOnly(!tasksOnly, picked)}
        data-testid="tasks-only"
        className={cx(TOGGLE_BUTTON, tasksOnly ? "bg-zinc-800 text-yard-300" : "text-zinc-500 hover:text-zinc-200")}
      >
        <PanelBottomClose className="h-3 w-3 shrink-0" aria-hidden />
        <span className="@max-[34rem]:hidden">Tasks only</span>
      </button>
    </div>
  )
})
