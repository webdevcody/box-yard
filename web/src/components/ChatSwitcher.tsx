// The chat switcher: the "Coordinator" title in its header, and "Captain" in a Captain's (the project's Captain tab,
// Zen's side panel), opens a menu of every chat: the Coordinator first, then each project's Captain in sidebar order.
// Picking one opens it with its composer focused (lib/chatSwitch.ts). The Coordinator's header keeps a pick in its own
// chat instead: the project goes on its project bar and the chat shows only that project, its Captain in the box.
// A menu with radio items: the current chat is checked, ↑/↓/Home/End move, Enter or Space picks, Esc closes (back to
// the title), and so does Tab or a click outside.
//
// A filter field heads the menu: typing (there, or on an item) narrows it to the matching chats, best first, with the
// best one highlighted; ↑/↓ move the highlight and Enter picks it. In the Coordinator's header, P opens the menu with
// the field focused, so P, a few letters and Enter switches projects.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { useQueries } from "@tanstack/react-query"
import { Bot, Check, ChevronDown, FolderGit2, FolderOpen, Search } from "lucide-react"
import { api } from "../lib/api"
import { keys, useChatBusy, useProjects } from "../lib/queries"
import { COORDINATOR_CHAT } from "../lib/threads"
import { PROJECT_PICKER_KEY_LABEL, focusComposer, isProjectPickerKey, openCoordinator, rankChats } from "../lib/chatSwitch"
import { closeZenPanel, zenPanelState } from "../lib/zenPanel"
import { isModalOpen } from "./Modal"
import { menuItemBase, usePopover } from "./TaskHeader"
import { usePlacement } from "./TurnTimingChip"
import { projectColorStyle } from "./TaskIcon"
import { projectColors, type ProjectColor } from "../../../shared/projectColors"
import { cx } from "./ui"
import type { CaptainState, Project } from "../../../shared/types"

const MENU_WIDTH = 256

/** A Captain's chat: its project's Captain tab (in Zen, that opens the side panel). */
export const captainHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}?tab=captain`

/**
 * The title button and its menu. `current` is the chat it sits in: COORDINATOR_CHAT or a project id. `onLeave` runs
 * when another chat is picked (the Coordinator's drawer closes, so the Captain it opened is in view). `onPick` can
 * take a pick itself (and focus a composer) and return true: the Coordinator's header shows a picked project in its
 * own chat. `hotkey`: P opens this one, filter first (the Coordinator's; there's one on every page).
 */
export function ChatSwitcher({
  current,
  onLeave,
  onPick,
  hotkey = false,
  children,
}: {
  current: string
  onLeave?: () => void
  onPick?: (chat: string) => boolean
  hotkey?: boolean
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const { open, setOpen, root, trigger } = usePopover(panel)
  const menuId = useId()
  // Opened by the hotkey: the filter takes focus instead of the current chat.
  const [byKey, setByKey] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!hotkey) return
    let frame = 0
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isProjectPickerKey(e) || isModalOpen()) return
      e.preventDefault()
      if (openRef.current) {
        panel.current?.querySelector<HTMLInputElement>("[data-testid=chat-switcher-filter]")?.focus()
        return
      }
      // The Coordinator drawer may be shut: it slides in first, and the menu opens once its title is in view (or
      // after half a second, whatever happens).
      const inView = () => {
        const r = trigger.current?.getBoundingClientRect()
        return !r || (r.left >= 0 && r.right <= (document.documentElement.clientWidth || window.innerWidth))
      }
      const show = () => {
        setByKey(true)
        setOpen(true)
      }
      if (inView()) return show()
      openCoordinator()
      const until = performance.now() + 500
      const wait = () => (inView() || performance.now() > until ? show() : (frame = requestAnimationFrame(wait)))
      frame = requestAnimationFrame(wait)
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      cancelAnimationFrame(frame)
    }
  }, [hotkey, setOpen, trigger])
  const close = () => {
    setOpen(false)
    setByKey(false)
  }
  return (
    <div ref={root} className="flex min-w-0">
      <button
        ref={trigger}
        type="button"
        data-testid="chat-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={hotkey ? `Switch to the Coordinator or a project (${PROJECT_PICKER_KEY_LABEL})` : "Switch to the Coordinator or a project's Captain"}
        aria-keyshortcuts={hotkey ? PROJECT_PICKER_KEY_LABEL.toLowerCase() : undefined}
        onClick={() => {
          setByKey(false)
          setOpen(!open)
        }}
        className={cx(
          "-mx-1 inline-flex min-w-0 items-center gap-0.5 rounded-md px-1 text-sm font-semibold text-zinc-100 hover:bg-zinc-800/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none aria-expanded:bg-zinc-800/70",
          // A 44px target on touch screens without making the header any taller.
          "[@media(pointer:coarse)]:-my-[11px] [@media(pointer:coarse)]:min-h-11",
        )}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
      </button>
      {open && (
        <SwitcherMenu id={menuId} panel={panel} trigger={trigger} current={current} filterFirst={byKey} onLeave={onLeave} onPick={onPick} onClose={close} />
      )}
    </div>
  )
}

interface Item {
  chat: string
  label: string
  aliases?: string[]
  project: Project | null
  color: ProjectColor | null
  busy: boolean | null
}

function SwitcherMenu({
  id,
  panel,
  trigger,
  current,
  filterFirst,
  onLeave,
  onPick,
  onClose,
}: {
  id: string
  panel: RefObject<HTMLDivElement | null>
  trigger: RefObject<HTMLButtonElement | null>
  current: string
  filterFirst: boolean
  onLeave?: () => void
  onPick?: (chat: string) => boolean
  onClose: () => void
}) {
  const [, navigate] = useLocation()
  const projects = useProjects().data
  const coordinatorBusy = useChatBusy().data
  // Captains' busy flags as the live stream left them in the cache: never fetched here, so a Captain nobody has
  // opened since the page loaded just has no dot.
  const captains = useQueries({
    queries: (projects ?? []).map((p) => ({
      queryKey: keys.captain(p.id),
      queryFn: () => api<CaptainState>(`/api/projects/${p.id}/captain`),
      enabled: false,
      staleTime: Infinity,
    })),
  })
  // Each project's colour, as its sidebar row and its tasks' tiles show it.
  const colors = useMemo(() => projectColors(projects ?? []), [projects])
  const items: Item[] = useMemo(
    () => [
      // Always first, from every header.
      { chat: COORDINATOR_CHAT, label: "Coordinator", aliases: ["All"], project: null, color: null, busy: coordinatorBusy ?? null },
      ...(projects ?? []).map((p, i) => ({ chat: p.id, label: p.name, project: p, color: colors.get(p.id) ?? null, busy: captains[i]?.data?.busy ?? null })),
    ],
    [projects, colors, captains, coordinatorBusy],
  )
  // Placed for the whole list, so the menu doesn't move as the filter narrows it (it shrinks from the bottom).
  const style = usePlacement(trigger, panel, true, items.length, MENU_WIDTH)
  const filterBox = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const shown = useMemo(() => rankChats(items, query), [items, query])
  // The highlighted chat while the filter has focus: the best match, or the current chat before anything's typed.
  const [highlight, setHighlight] = useState<string | null>(null)
  const active = shown.find((i) => i.chat === highlight)?.chat ?? (query.trim() ? shown[0]?.chat : (shown.find((i) => i.chat === current) ?? shown[0])?.chat) ?? null
  const [inFilter, setInFilter] = useState(false)

  // Open on the current chat, so ↑/↓ start from where Cody is (or on the filter, from the hotkey): once placed, as a
  // hidden menu can't take focus.
  const placed = style.visibility !== "hidden"
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    const el = panel.current
    const at = filterFirst ? filterBox.current : (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>("[role=menuitemradio]"))
    at?.focus({ preventScroll: true })
  }, [placed, panel, filterFirst])

  const pick = (chat: string) => {
    onClose()
    if (onPick?.(chat)) return
    if (chat !== current) {
      onLeave?.()
      if (chat === COORDINATOR_CHAT) {
        // From Zen's side panel, back to the chat beside (or under) it; elsewhere the drawer opens if it isn't docked.
        if (zenPanelState()) closeZenPanel()
        else openCoordinator()
      } else navigate(captainHref(chat))
    }
    focusComposer(chat)
  }

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const at = shown.findIndex((i) => i.chat === active)
    const move = (i: number) => {
      e.preventDefault()
      if (shown.length) setHighlight(shown[(i + shown.length) % shown.length]!.chat)
    }
    if (e.key === "ArrowDown") move(at + 1)
    else if (e.key === "ArrowUp") move(at < 0 ? -1 : at - 1)
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (active) pick(active)
    } else if (e.key === "Tab") onClose()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === filterBox.current) return
    // Typing on an item goes to the filter.
    if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      setQuery((q) => q + e.key)
      setHighlight(null)
      filterBox.current?.focus()
      return
    }
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const move = (i: number) => {
      e.preventDefault()
      rows[(i + rows.length) % rows.length]?.focus()
    }
    if (e.key === "ArrowDown") move(at + 1)
    else if (e.key === "ArrowUp") move(at < 0 ? -1 : at - 1)
    else if (e.key === "Home") move(0)
    else if (e.key === "End") move(-1)
    else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
      e.preventDefault()
      pick(rows[at]!.dataset.chat!)
    } else if (e.key === "Tab") onClose()
  }

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="menu"
      aria-label="Switch chat"
      data-testid="chat-switcher-menu"
      style={style}
      onKeyDown={onKeyDown}
      className="scroll-thin fixed z-40 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 text-sm shadow-2xl shadow-black/50"
    >
      <div role="none" className="relative mb-1">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
        <input
          ref={filterBox}
          type="text"
          data-testid="chat-switcher-filter"
          aria-label="Filter chats"
          aria-controls={`${id}-list`}
          aria-activedescendant={inFilter && active ? itemId(id, active) : undefined}
          placeholder="Find a project…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(null)
          }}
          onFocus={() => setInFilter(true)}
          onBlur={() => setInFilter(false)}
          onKeyDown={onFilterKeyDown}
          // 16px on phones, so iOS doesn't zoom in.
          className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900/60 pr-2 pl-7 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-700 focus:outline-none sm:text-sm pointer-coarse:h-10"
        />
      </div>
      <div id={`${id}-list`} role="none">
        {query.trim() ? (
          shown.map((item) => <SwitcherItem key={item.chat} menuId={id} item={item} current={item.chat === current} active={inFilter && item.chat === active} onPick={pick} />)
        ) : (
          <>
            <SwitcherItem menuId={id} item={items[0]!} current={items[0]!.chat === current} active={inFilter && items[0]!.chat === active} onPick={pick} />
            <div role="group" aria-label="Captains" className="mt-1 border-t border-zinc-800/80 pt-1">
              <div aria-hidden className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-zinc-500">
                Captains
              </div>
              {items.slice(1).map((item) => (
                <SwitcherItem key={item.chat} menuId={id} item={item} current={item.chat === current} active={inFilter && item.chat === active} onPick={pick} />
              ))}
              {projects?.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-500">No projects yet.</p>}
            </div>
          </>
        )}
        {query.trim() && !shown.length && <p className="px-2 py-1.5 text-xs text-zinc-500">No match.</p>}
      </div>
    </div>,
    document.body,
  )
}

const itemId = (menuId: string, chat: string) => `${menuId}-${chat}`

function SwitcherItem({ menuId, item, current, active, onPick }: { menuId: string; item: Item; current: boolean; active: boolean; onPick: (chat: string) => void }) {
  const who = item.project ? "Captain" : "Coordinator"
  return (
    <button
      type="button"
      role="menuitemradio"
      id={itemId(menuId, item.chat)}
      aria-checked={current}
      tabIndex={-1}
      data-chat={item.chat}
      data-active={active || undefined}
      onClick={() => onPick(item.chat)}
      className={cx(
        menuItemBase,
        "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus:bg-zinc-800 focus:text-zinc-50 focus:outline-none data-active:bg-zinc-800 data-active:text-zinc-50",
        current && "text-zinc-50",
      )}
    >
      {item.project ? <ProjectMark project={item.project} color={item.color} /> : <Bot className="h-4 w-4 shrink-0 text-yard-400" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.busy !== null && (
        <span
          data-testid="chat-switcher-busy"
          data-busy={item.busy || undefined}
          title={item.busy ? `${who} is working` : `${who} is idle`}
          className={cx("h-2 w-2 shrink-0 rounded-full", item.busy ? "animate-pulse bg-sky-400" : "bg-zinc-600")}
        >
          <span className="sr-only">{item.busy ? "working" : "idle"}</span>
        </span>
      )}
      <Check className={cx("h-3.5 w-3.5 shrink-0 text-yard-400", !current && "invisible")} aria-hidden />
    </button>
  )
}

/** The project's mark: the sidebar row's folder, in the project's colour. */
function ProjectMark({ project, color }: { project: Project; color: ProjectColor | null }) {
  const Icon = project.repo ? FolderGit2 : FolderOpen
  return <Icon style={projectColorStyle(color)} data-color={color ?? undefined} className="h-4 w-4 shrink-0 text-(--pc)" aria-hidden />
}
