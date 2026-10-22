// List controls shared by the project Tasks tab and the Yard view: tab bar, search box, sort select.
import { useEffect, useRef, useState, type ComponentType } from "react"
import { Link, useSearchParams } from "wouter"
import { Search, X } from "lucide-react"
import { DEFAULT_SORT, TASK_SORTS, type TaskSort } from "../lib/projectTasks"
import { cx, inputClass } from "./ui"

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
  return (
    <nav aria-label={label} className="sticky top-0 z-10 -mx-6 -mt-1 border-b border-zinc-900 bg-zinc-950/90 px-6 backdrop-blur">
      <div className="scroll-thin -mb-px flex gap-1 overflow-x-auto">
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
                "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition",
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
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
      <input
        ref={input}
        className={cx(inputClass, "pr-8 pl-9")}
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
        <button onClick={() => onChange("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-200" title="Clear search">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

export const selectClass =
  "shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm text-zinc-300 focus:border-yard-500/60 focus:outline-none sm:px-3"

/** The task sort dropdown, bound to `?sort=` (the default is left out of the URL). */
export function SortSelect({ sort }: { sort: TaskSort }) {
  const setParam = useSetParam()
  return (
    <select className={cx(selectClass, "w-32 sm:w-auto")} value={sort} onChange={(e) => setParam("sort", e.target.value === DEFAULT_SORT ? null : e.target.value)} aria-label="Sort tasks">
      {TASK_SORTS.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
    </select>
  )
}
