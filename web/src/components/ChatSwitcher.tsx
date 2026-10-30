// The chat switcher: the "Coordinator" title in its header, and "Captain" in a Captain's (the project's Captain tab,
// Zen's side panel), opens a menu of every chat: the Coordinator first, then each project's Captain in sidebar order.
// Picking one opens it with its composer focused (lib/chatSwitch.ts). A menu with radio items: the current chat is
// checked, ↑/↓/Home/End move, Enter or Space picks, Esc closes (back to the title), and so does Tab or a click outside.
import { useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { useQueries } from "@tanstack/react-query"
import { Bot, Check, ChevronDown, FolderGit2, FolderOpen } from "lucide-react"
import { api } from "../lib/api"
import { keys, useChatBusy, useProjects } from "../lib/queries"
import { COORDINATOR_CHAT } from "../lib/threads"
import { focusComposer, openCoordinator } from "../lib/chatSwitch"
import { closeZenPanel, zenPanelState } from "../lib/zenPanel"
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
 * when another chat is picked (the Coordinator's drawer closes, so the Captain it opened is in view).
 */
export function ChatSwitcher({ current, onLeave, children }: { current: string; onLeave?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const { open, setOpen, root, trigger } = usePopover(panel)
  const menuId = useId()
  return (
    <div ref={root} className="flex min-w-0">
      <button
        ref={trigger}
        type="button"
        data-testid="chat-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Switch to the Coordinator or a project's Captain"
        onClick={() => setOpen(!open)}
        className={cx(
          "-mx-1 inline-flex min-w-0 items-center gap-0.5 rounded-md px-1 text-sm font-semibold text-zinc-100 hover:bg-zinc-800/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none aria-expanded:bg-zinc-800/70",
          // A 44px target on touch screens without making the header any taller.
          "[@media(pointer:coarse)]:-my-[11px] [@media(pointer:coarse)]:min-h-11",
        )}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
      </button>
      {open && <SwitcherMenu id={menuId} panel={panel} trigger={trigger} current={current} onLeave={onLeave} onClose={() => setOpen(false)} />}
    </div>
  )
}

interface Item {
  chat: string
  label: string
  project: Project | null
  color: ProjectColor | null
  busy: boolean | null
}

function SwitcherMenu({
  id,
  panel,
  trigger,
  current,
  onLeave,
  onClose,
}: {
  id: string
  panel: RefObject<HTMLDivElement | null>
  trigger: RefObject<HTMLButtonElement | null>
  current: string
  onLeave?: () => void
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
      { chat: COORDINATOR_CHAT, label: "Coordinator", project: null, color: null, busy: coordinatorBusy ?? null },
      ...(projects ?? []).map((p, i) => ({ chat: p.id, label: p.name, project: p, color: colors.get(p.id) ?? null, busy: captains[i]?.data?.busy ?? null })),
    ],
    [projects, colors, captains, coordinatorBusy],
  )
  const style = usePlacement(trigger, panel, true, items.length, MENU_WIDTH)

  // Open on the current chat, so ↑/↓ start from where Cody is: once placed, as a hidden menu can't take focus.
  const placed = style.visibility !== "hidden"
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    const el = panel.current
    const at = el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>("[role=menuitemradio]")
    at?.focus({ preventScroll: true })
  }, [placed, panel])

  const pick = (chat: string) => {
    onClose()
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      <SwitcherItem item={items[0]!} current={items[0]!.chat === current} onPick={pick} />
      <div role="group" aria-label="Captains" className="mt-1 border-t border-zinc-800/80 pt-1">
        <div aria-hidden className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-zinc-500">
          Captains
        </div>
        {items.slice(1).map((item) => (
          <SwitcherItem key={item.chat} item={item} current={item.chat === current} onPick={pick} />
        ))}
        {projects?.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-500">No projects yet.</p>}
      </div>
    </div>,
    document.body,
  )
}

function SwitcherItem({ item, current, onPick }: { item: Item; current: boolean; onPick: (chat: string) => void }) {
  const who = item.project ? "Captain" : "Coordinator"
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      tabIndex={-1}
      data-chat={item.chat}
      onClick={() => onPick(item.chat)}
      className={cx(menuItemBase, "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus:bg-zinc-800 focus:text-zinc-50 focus:outline-none", current && "text-zinc-50")}
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
