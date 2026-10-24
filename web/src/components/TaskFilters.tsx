// List controls shared by the project Tasks tab and the Yard view: tab bar, search box, sort select, quiet-runs toggle.
import { useEffect, useRef, useState, type ComponentType } from "react"
import { Link, useSearchParams } from "wouter"
import { Moon, Search, X } from "lucide-react"
import { DEFAULT_SORT, TASK_SORTS, type TaskSort } from "../lib/projectTasks"
import { Select, cx, inputClass } from "./ui"

/** A copy of `params` with `key` set, or removed when `value` is empty. */
export function withParam(params: URLSearchParams, key: string, value: string | null) {
  const next = new URLSearchParams(params)
  if (value) next.set(key, value)
  else next.delete(key)
  return next
}

/** True when a key press should go to a text field, not a page shortcut. */
export function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return Boolean(e.metaKey || e.ctrlKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable=true]"))
}

/** Sets one URL query param in place (replace), so filter tweaks don't flood history. */
export function useSetParam() {
  const [, setParams] = useSearchParams()
  return (key: string, value: string | null) => setParams((p) => withParam(p, key, value), { replace: true })
}

/** The `?q=` search: typing stays local and snappy, and the URL follows. */
export function useUrlQuery(): [string, (q: string) => void] {
  const [params] = useSearchParams()
  const setParam = useSetParam()
  const urlQuery = params.get("q") ?? ""
  const [query, setQuery] = useState(urlQuery)
  useEffect(() => setQuery(urlQuery), [urlQuery])
  return [
    query,
    (q: string) => {
      setQuery(q)
      setParam("q", q.trim() ? q : null)
    },
  ]
}

export interface TabItem<K extends string> {
  key: K
  label: string
  href: string
  icon?: ComponentType<{ className?: string }>
  count?: number
  /** A small dot after the label, e.g. amber when something needs you. */
  dot?: string | false
  title?: string
}

/** The sticky underline tab bar used at the top of the project and yard pages. */
export function TabBar<K extends string>({ tabs, selected, label }: { tabs: TabItem<K>[]; selected: K; label?: string }) {
  const strip = useRef<HTMLDivElement>(null)
  // On a phone the later tabs are off to the right: bring the selected one into view (sideways only).
  useEffect(() => {
    const s = strip.current
    const tab = s?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!s || !tab) return
    if (tab.offsetLeft < s.scrollLeft || tab.offsetLeft + tab.offsetWidth > s.scrollLeft + s.clientWidth) s.scrollLeft = Math.max(0, tab.offsetLeft - 16)
  }, [selected])
  return (
    <nav aria-label={label} className="sticky top-0 z-10 -mx-4 -mt-1 border-b border-zinc-900 bg-zinc-950/90 px-4 backdrop-blur sm:-mx-6 sm:px-6">
      <div ref={strip} className="scroll-thin relative -mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const Icon = t.icon
          const on = t.key === selected
          return (
            <Link
              key={t.key}
              href={t.href}
              title={t.title}
              aria-current={on ? "page" : undefined}
              className={cx(
                "inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition",
                on ? "border-yard-500 text-zinc-50" : "border-transparent text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {t.label}
              {t.count !== undefined && (
                <span className={cx("rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400")}>
                  {t.count}
                </span>
              )}
              {t.dot && <span className={cx("h-1.5 w-1.5 rounded-full", t.dot)} />}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

/** Search input with a clear button; "/" focuses it from anywhere on the page and Escape clears it. */
export function SearchBox({ value, onChange, placeholder = "Search tasks", label = "Search tasks" }: { value: string; onChange: (q: string) => void; placeholder?: string; label?: string }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || isTyping(e)) return
      e.preventDefault()
      input.current?.focus()
    }
    // On document so it runs before the command palette's "/" (on window), which then backs off.
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
      <input
        ref={input}
        className={cx(inputClass, "pr-11 pl-9")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("")
            e.currentTarget.blur()
          }
        }}
        placeholder={`${placeholder}  ( / )`}
        aria-label={label}
      />
      {value && (
        <button onClick={() => onChange("")} className="absolute top-1/2 right-0 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-zinc-500 hover:text-zinc-200 sm:right-2 sm:h-8 sm:w-8" title="Clear search" aria-label="Clear search">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/** The task sort dropdown, bound to `?sort=` (the default is left out of the URL). */
export function SortSelect({ sort }: { sort: TaskSort }) {
  const setParam = useSetParam()
  return (
    <Select className="w-36 shrink-0 text-zinc-300 sm:w-auto" value={sort} onChange={(e) => setParam("sort", e.target.value === DEFAULT_SORT ? null : e.target.value)} aria-label="Sort tasks">
      {TASK_SORTS.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
    </Select>
  )
}

/** `?quiet=1`: show quiet schedule runs (shared/quiet.ts) in task lists. Off by default. */
export function useShowQuiet(): [boolean, (show: boolean) => void] {
  const [params] = useSearchParams()
  const setParam = useSetParam()
  return [params.get("quiet") === "1", (show) => setParam("quiet", show ? "1" : null)]
}

/** The "Show quiet runs" switch. `count` is how many quiet runs it would show (or is showing). */
export function QuietSwitch({ checked, onChange, count, className }: { checked: boolean; onChange: (show: boolean) => void; count?: number; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title="Quiet runs are schedule runs that found nothing to do and changed nothing."
      className={cx(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap transition sm:min-h-9",
        checked ? "border-yard-500/40 bg-yard-500/10 text-yard-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
        className,
      )}
    >
      <Moon className="h-3.5 w-3.5" />
      Show quiet runs
      {count !== undefined && <span className={cx("tabular-nums", checked ? "text-yard-300/70" : "text-zinc-500")}>{count}</span>}
    </button>
  )
}

/** The "Show quiet runs" switch bound to `?quiet=1`, for the Yard and the project Tasks tab. */
export function QuietToggle({ count, className }: { count?: number; className?: string }) {
  const [show, setShow] = useShowQuiet()
  return <QuietSwitch checked={show} onChange={setShow} count={count} className={className} />
}
