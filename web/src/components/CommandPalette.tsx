import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useLocation } from "wouter"
import { Activity, AlarmClock, Box, CornerDownLeft, ExternalLink, FileText, FolderGit2, GitPullRequest, Hand, History, LayoutGrid, ListTodo, Search, X, Zap } from "lucide-react"
import { QUIET, useArtifacts, useBoxes, useOwnerName, useProjects, useSchedules, useTasks } from "../lib/queries"
import { buildItems, pushRecent, recentKeyFor, type PaletteCommand, type PaletteItem } from "../lib/palette"
import { PREFIXES, bumpUsage, normalizeQuery, paletteRows, parseQuery, rankPalette, type GroupKey, type PaletteGroup, type PaletteRow, type PaletteScope } from "../lib/paletteRank"
import { withOwner } from "../../../shared/owner"
import { isFilePath, previewKind } from "../lib/filePreview"
import { openPreview } from "../lib/preview"
import { NewTabLink, StatusBadge, TimeAgo, cx } from "./ui"
import { useOpenSettings } from "./SettingsDialog"
import { NewProjectDialog } from "./NewProjectDialog"
import { Modal } from "./Modal"
import { toggleZen } from "../lib/zen"

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

// ------------------------------------------------------------------ recently viewed and command usage

const RECENT_KEY = "box-yard:recent"
const USAGE_KEY = "box-yard:command-usage"

function read<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or full storage: recents and usage are a nicety.
  }
}

const isKeyList = (v: unknown): v is string[] => Array.isArray(v)
const isCounts = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && !Array.isArray(v)

const loadRecent = () => read(RECENT_KEY, isKeyList, []).filter((k): k is string => typeof k === "string")
const remember = (key: string) => write(RECENT_KEY, pushRecent(loadRecent(), key))
const loadUsage = () => read(USAGE_KEY, isCounts, {})
const countUse = (key: string) => write(USAGE_KEY, bumpUsage(loadUsage(), key))

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
      {isOpen && <Palette onClose={() => setOpen(false)} onCommand={(c) => (c === "settings" ? openSettings() : c === "zen" ? toggleZen() : setDialog(c))} />}
      {dialog === "new-project" && <NewProjectDialog onClose={() => setDialog(null)} />}
    </>
  )
}

// ------------------------------------------------------------------ palette

const KIND_ICON: Record<PaletteItem["kind"], typeof Search> = {
  action: Zap,
  page: LayoutGrid,
  task: ListTodo,
  pr: GitPullRequest,
  project: FolderGit2,
  schedule: AlarmClock,
  artifact: FileText,
  box: Box,
}

const GROUP_ICON: Partial<Record<GroupKey, typeof Search>> = { waiting: Hand, working: Activity, recent: History }

const SCOPE_PLACEHOLDER: Record<PaletteScope, string> = {
  command: "Commands and pages…",
  pr: "PR number or title…",
  file: "Search files…",
  project: "Search projects…",
  box: "Search boxes…",
}

const prefixOf = (scope: PaletteScope) => PREFIXES.find((p) => p.scope === scope)!

function Palette({ onClose, onCommand }: { onClose: () => void; onCommand: (c: PaletteCommand) => void }) {
  const [, navigate] = useLocation()
  // QUIET: live updates don't re-render the open palette; the next keystroke picks them up.
  const tasks = useTasks(QUIET)
  const projects = useProjects(QUIET)
  const schedules = useSchedules(QUIET)
  const artifacts = useArtifacts(QUIET)
  const boxes = useBoxes(QUIET)
  const ownerName = useOwnerName()
  const [text, setText] = useState("")
  const [scope, setScope] = useState<PaletteScope | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<GroupKey>>(() => new Set())
  const [active, setActive] = useState(0)
  const [recent] = useState(loadRecent)
  const [usage] = useState(loadUsage)
  // One clock per open palette, so recency boosts can't reorder rows between keystrokes.
  const [now] = useState(Date.now)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()

  const items = useMemo(
    () => buildItems({ tasks: tasks.data, projects: projects.data, schedules: schedules.data, artifacts: artifacts.data, boxes: boxes.data }),
    [tasks.data, projects.data, schedules.data, artifacts.data, boxes.data],
  )
  const query = normalizeQuery(text)
  const groups = useMemo(() => rankPalette(items, { scope, query }, { now, recent, usage, expanded }), [items, scope, query, now, recent, usage, expanded])
  const rows = useMemo(() => paletteRows(groups), [groups])
  const at = Math.min(active, rows.length - 1)
  const current = rows[at]
  const optionId = (i: number) => `${id}-opt-${i}`

  // The Modal gives focus back to whatever had it when the palette closes.
  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    setActive(0)
    setExpanded(new Set())
  }, [query, scope])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" })
  }, [at])

  const choose = (item: PaletteItem, newTab = false) => {
    if (item.kind === "page" || item.kind === "action") countUse(item.key)
    else if (item.kind === "task" || item.kind === "project") remember(item.key)
    if (newTab && item.href) return void window.open(item.href, "_blank", "noopener")
    onClose()
    if (item.command) return onCommand(item.command)
    if (item.file && !newTab && isFilePath(item.file.url) && previewKind(item.file)) return openPreview(item.file)
    if (item.url) return void window.open(item.url, "_blank", "noopener")
    if (!item.href) return
    navigate(item.href)
    // pushState doesn't fire hashchange; pages that scroll to #id listen for it.
    if (item.href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"))
  }

  // The rows that were hidden take the "Show all" row's place, so the selection lands on the first of them.
  const expand = (key: GroupKey) => setExpanded((s) => new Set(s).add(key))

  const activate = (row: PaletteRow, newTab = false) => (row.type === "more" ? expand(row.group) : choose(row.item, newTab))

  const pickScope = (next: PaletteScope | null) => {
    setScope(next)
    input.current?.focus()
  }

  const onInput = (value: string) => {
    if (!scope) {
      const parsed = parseQuery(value)
      if (parsed.scope) {
        setScope(parsed.scope)
        return setText(parsed.rest)
      }
    }
    setText(value)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = rows.length
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      if (n) setActive((at + 1) % n)
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      if (n) setActive((at - 1 + n) % n)
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault()
      setActive(Math.max(0, n - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (current) activate(current, e.metaKey || e.ctrlKey)
    } else if (e.key === "Backspace" && scope && input.current?.selectionStart === 0 && input.current.selectionEnd === 0) {
      // Backspace in front of the text drops the prefix chip.
      e.preventDefault()
      setScope(null)
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only stop; options are reached with the arrows.
      e.preventDefault()
      input.current?.focus()
    }
  }

  const highlight = scope === "pr" ? query.replace(/^#/, "") : query
  let index = 0

  return (
    <Modal
      size="lg"
      placement="top"
      label="Command palette"
      onClose={onClose}
      onKeyDown={onKeyDown}
      // Important: the Modal's own sm:max-h would win otherwise, and long lists ran off the screen.
      className="sm:max-h-[70vh]!"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-zinc-900 px-4">
        {scope === "command" ? <Zap className="h-4 w-4 shrink-0 text-yard-400" /> : <Search className="h-4 w-4 shrink-0 text-zinc-500" />}
        {scope && (
          <button
            type="button"
            data-testid="palette-scope"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickScope(null)}
            aria-label={`${prefixOf(scope).label} only: remove the ${prefixOf(scope).prefix} filter`}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-yard-500/40 bg-yard-500/10 px-2 text-xs font-medium text-yard-300 sm:min-h-0 sm:py-0.5"
          >
            <span className="font-mono">{prefixOf(scope).prefix}</span>
            {prefixOf(scope).label}
            <X className="h-3 w-3" />
          </button>
        )}
        <input
          ref={input}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={current ? optionId(at) : undefined}
          aria-autocomplete="list"
          aria-label="Search Box Yard"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => onInput(e.target.value)}
          placeholder={scope ? SCOPE_PLACEHOLDER[scope] : "Search tasks, projects, files, commands…"}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-base text-zinc-100 placeholder:text-zinc-600 focus:outline-none sm:text-sm"
        />
        <kbd className="rounded border border-zinc-800 px-1.5 py-0.5 font-sans text-[10px] text-zinc-500 max-sm:hidden">esc</kbd>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:text-zinc-200 sm:hidden">
          <X className="h-5 w-5" />
        </button>
      </div>

      {!scope && !text && (
        <div data-testid="palette-prefixes" className="scroll-thin flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-zinc-900 px-4 py-2 text-[11px] text-zinc-500">
          <span className="shrink-0">Narrow to</span>
          {PREFIXES.map((p) => (
            <button
              key={p.scope}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickScope(p.scope)}
              className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 sm:min-h-0 sm:py-0.5"
            >
              <span className="font-mono text-zinc-300">{p.prefix}</span>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 && <div className="px-3 py-8 text-center text-sm text-zinc-500">{tasks.isLoading ? "Loading…" : "No matches"}</div>}
        {groups.map((g) => (
          <Group key={g.key} group={g} label={withOwner(g.label, ownerName)} id={`${id}-${g.key}`}>
            {g.items.map((item) => {
              const i = index++
              return (
                <Option
                  key={item.key}
                  id={optionId(i)}
                  index={i}
                  item={item}
                  query={highlight}
                  selected={i === at}
                  onHover={() => setActive(i)}
                  onChoose={(newTab) => choose(item, newTab)}
                />
              )
            })}
            {g.items.length < g.total &&
              (() => {
                const i = index++
                return <ShowAll key="more" id={optionId(i)} index={i} total={g.total} selected={i === at} onHover={() => setActive(i)} onChoose={() => expand(g.key)} />
              })()}
          </Group>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-900 px-4 py-2 text-[11px] text-zinc-500 max-sm:hidden">
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
        {scope && (
          <span className="ml-auto">
            <Kbd>⌫</Kbd> clear filter
          </span>
        )}
      </div>
    </Modal>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-0.5 inline-block min-w-4 rounded border border-zinc-800 bg-zinc-900 px-1 text-center font-sans text-[10px] text-zinc-400">{children}</kbd>
}

function Group({ group, label, id, children }: { group: PaletteGroup; label: string; id: string; children: ReactNode }) {
  const Icon = GROUP_ICON[group.key]
  return (
    <div role="group" aria-labelledby={id} data-group={group.key} className="mb-1 last:mb-0">
      <div id={id} className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
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
      data-key={item.key}
      // Keep focus in the input so the keyboard keeps working after a click.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={(e) => onChoose(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && onChoose(true)}
      className={cx("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm", selected ? "bg-zinc-800/80 text-zinc-50" : "text-zinc-300")}
    >
      <Icon className={cx("h-4 w-4 shrink-0", selected ? "text-yard-400" : "text-zinc-500")} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <Highlight text={item.title} query={query} />
        </div>
        {item.subtitle && <div className="truncate text-xs text-zinc-500">{item.subtitle}</div>}
      </div>
      {item.status && <StatusBadge status={item.status} />}
      {(item.kind === "task" || item.kind === "pr") && item.at && (
        <span className="w-14 shrink-0 text-right text-xs text-zinc-500 max-sm:hidden">
          <TimeAgo ts={item.at} />
        </span>
      )}
      {item.externalUrl && (
        <NewTabLink
          href={item.externalUrl}
          aria-label="Open on GitHub"
          title="Open on GitHub"
          mark={false}
          onMouseDown={(e) => e.preventDefault()}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200 sm:h-7 sm:w-7"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </NewTabLink>
      )}
      {selected && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-500 max-sm:hidden" />}
    </div>
  )
}

/** The last row of a capped group: expands it in place. */
function ShowAll({ id, index, total, selected, onHover, onChoose }: { id: string; index: number; total: number; selected: boolean; onHover: () => void; onChoose: () => void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-testid="palette-show-all"
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={onChoose}
      className={cx("flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 py-1.5 pl-9.5 text-xs sm:min-h-8", selected ? "bg-zinc-800/80 text-zinc-100" : "text-zinc-500")}
    >
      Show all {total} →
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
