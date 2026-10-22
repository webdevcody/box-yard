import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import { AlarmClock, Box, CornerDownLeft, FileText, FolderGit2, History, LayoutGrid, ListTodo, Search, Zap } from "lucide-react"
import { useArtifacts, useBoxes, useProjects, useSchedules, useTasks } from "../lib/queries"
import { buildItems, pushRecent, recentKeyFor, searchPalette, parseQuery, type PaletteCommand, type PaletteGroup, type PaletteItem } from "../lib/palette"
import { isFilePath, previewKind } from "../lib/filePreview"
import { openPreview } from "../lib/preview"
import { StatusBadge, TimeAgo, cx } from "./ui"
import { useOpenSettings } from "./SettingsDialog"
import { NewProjectDialog } from "./NewProjectDialog"
import { Modal } from "./Modal"

// ------------------------------------------------------------------ open state

let open = false
const listeners = new Set<() => void>()
const setOpen = (value: boolean) => {
  open = value
  listeners.forEach((l) => l())
}
export const openPalette = () => setOpen(true)
const usePaletteOpen = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
  )

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl "

// ------------------------------------------------------------------ recently viewed

const RECENT_KEY = "box-yard:recent"

function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

function remember(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), key)))
  } catch {
    // Private mode or full storage: recents are a nicety.
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]"))

// ------------------------------------------------------------------ host

/** Mounted once in the app: hotkeys, recent tracking, the palette and the dialogs it opens. */
export function CommandPalette() {
  const isOpen = usePaletteOpen()
  const [location] = useLocation()
  const [dialog, setDialog] = useState<PaletteCommand | null>(null)
  const openSettings = useOpenSettings()

  useEffect(() => {
    const key = recentKeyFor(location)
    if (key) remember(key)
  }, [location])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen(!open)
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && !open && !isTyping(e.target)) {
        // Pages with their own "/" search (the project Tasks tab) handle it first and call preventDefault.
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <>
      {isOpen && <Palette onClose={() => setOpen(false)} onCommand={(c) => (c === "settings" ? openSettings() : setDialog(c))} />}
      {dialog === "new-project" && <NewProjectDialog onClose={() => setDialog(null)} />}
    </>
  )
}

// ------------------------------------------------------------------ palette

const KIND_ICON: Record<PaletteItem["kind"], typeof Search> = {
  action: Zap,
  page: LayoutGrid,
  task: ListTodo,
  project: FolderGit2,
  schedule: AlarmClock,
  artifact: FileText,
  box: Box,
}

function Palette({ onClose, onCommand }: { onClose: () => void; onCommand: (c: PaletteCommand) => void }) {
  const [, navigate] = useLocation()
  const tasks = useTasks()
  const projects = useProjects()
  const schedules = useSchedules()
  const artifacts = useArtifacts()
  const boxes = useBoxes()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [recent] = useState(loadRecent)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()

  const items = useMemo(
    () => buildItems({ tasks: tasks.data, projects: projects.data, schedules: schedules.data, artifacts: artifacts.data, boxes: boxes.data }),
    [tasks.data, projects.data, schedules.data, artifacts.data, boxes.data],
  )
  const groups = useMemo(() => searchPalette(items, query, { recent }), [items, query, recent])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const current = flat[Math.min(active, flat.length - 1)]
  const optionId = (i: number) => `${id}-opt-${i}`

  // The Modal gives focus back to whatever had it when the palette closes.
  useEffect(() => input.current?.focus(), [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const choose = (item: PaletteItem, newTab = false) => {
    if (item.kind !== "page" && item.kind !== "action") remember(item.key)
    onClose()
    if (item.command) return onCommand(item.command)
    if (item.file && !newTab && isFilePath(item.file.url) && previewKind(item.file)) return openPreview(item.file)
    if (item.url) return void window.open(item.url, "_blank", "noopener")
    if (!item.href) return
    if (newTab) return void window.open(item.href, "_blank", "noopener")
    navigate(item.href)
    // pushState doesn't fire hashchange; pages that scroll to #id listen for it.
    if (item.href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"))
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = flat.length
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      if (n) setActive((a) => (a + 1) % n)
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      if (n) setActive((a) => (a - 1 + n) % n)
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault()
      setActive(Math.max(0, n - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (current) choose(current, e.metaKey || e.ctrlKey)
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only stop; options are reached with the arrows.
      e.preventDefault()
      input.current?.focus()
    }
  }

  const { query: q, actionsOnly } = parseQuery(query)
  let index = 0

  return (
    <Modal
      size="lg"
      placement="top"
      label="Command palette"
      onClose={onClose}
      onKeyDown={onKeyDown}
      className="sm:max-h-[70vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-2.5 border-b border-zinc-900 px-4">
        {actionsOnly ? <Zap className="h-4 w-4 shrink-0 text-yard-400" /> : <Search className="h-4 w-4 shrink-0 text-zinc-500" />}
        <input
          ref={input}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={current ? optionId(flat.indexOf(current)) : undefined}
          aria-autocomplete="list"
          aria-label="Search Box Yard"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks, projects, schedules, files… (> for actions)"
          className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        <kbd className="rounded border border-zinc-800 px-1.5 py-0.5 font-sans text-[10px] text-zinc-500">esc</kbd>
      </div>

      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {flat.length === 0 && <div className="px-3 py-8 text-center text-sm text-zinc-500">{tasks.isLoading ? "Loading…" : "No matches"}</div>}
        {groups.map((g) => (
          <Group key={`${g.kind}:${g.label}`} group={g} id={`${id}-${g.kind}`}>
            {g.items.map((item) => {
              const i = index++
              return (
                <Option
                  key={item.key}
                  id={optionId(i)}
                  index={i}
                  item={item}
                  query={q}
                  selected={item === current}
                  onHover={() => setActive(i)}
                  onChoose={(newTab) => choose(item, newTab)}
                />
              )
            })}
          </Group>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-900 px-4 py-2 text-[11px] text-zinc-500">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>{MOD_KEY.trim()}</Kbd>
          <Kbd>↵</Kbd> new tab
        </span>
        <span className="ml-auto">
          <Kbd>&gt;</Kbd> actions
        </span>
      </div>
    </Modal>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-0.5 inline-block min-w-4 rounded border border-zinc-800 bg-zinc-900 px-1 text-center font-sans text-[10px] text-zinc-400">{children}</kbd>
}

function Group({ group, id, children }: { group: PaletteGroup; id: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="mb-1 last:mb-0">
      <div id={id} className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {group.kind === "recent" && <History className="h-3 w-3" />}
        {group.label}
      </div>
      {children}
    </div>
  )
}

function Option({
  id,
  index,
  item,
  query,
  selected,
  onHover,
  onChoose,
}: {
  id: string
  index: number
  item: PaletteItem
  query: string
  selected: boolean
  onHover: () => void
  onChoose: (newTab: boolean) => void
}) {
  const Icon = KIND_ICON[item.kind]
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      // Keep focus in the input so the keyboard keeps working after a click.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={(e) => onChoose(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && onChoose(true)}
      className={cx("flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm", selected ? "bg-zinc-800/80 text-zinc-50" : "text-zinc-300")}
    >
      <Icon className={cx("h-4 w-4 shrink-0", selected ? "text-yard-400" : "text-zinc-500")} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <Highlight text={item.title} query={query} />
        </div>
        {item.subtitle && <div className="truncate text-xs text-zinc-500">{item.subtitle}</div>}
      </div>
      {item.status && <StatusBadge status={item.status} />}
      {item.kind === "task" && item.at && (
        <span className="w-14 shrink-0 text-right text-xs text-zinc-500">
          <TimeAgo ts={item.at} />
        </span>
      )}
      {selected && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
    </div>
  )
}

/** Marks the first occurrence of the query in the title. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-yard-400">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}
