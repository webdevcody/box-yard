import { useMemo, useState, type ReactNode } from "react"
import { Link, useSearchParams } from "wouter"
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Info, Settings } from "lucide-react"
import { useUsage } from "../lib/queries"
import {
  CATEGORY_META,
  PERIODS,
  avgPerTurn,
  bytes,
  compactTokens,
  dateInput,
  hours,
  money,
  pct,
  periodRange,
  rangeLabel,
  sortBreakdown,
  type BreakdownSort,
  type PeriodKey,
} from "../lib/usage"
import { useOpenSettings } from "./SettingsDialog"
import { withParam } from "./TaskFilters"
import { UsageChart } from "./UsageChart"
import { Button, Empty, cx, inputClass } from "./ui"
import { USAGE_CATEGORIES, type BudgetStatus, type UsageBreakdownRow, type UsagePeriodReport, type UsageWindow } from "../../../shared/types"

type BreakdownKey = "project" | "task" | "model" | "source"
const BREAKDOWNS: { key: BreakdownKey; label: string; field: keyof Pick<UsagePeriodReport, "byProject" | "byTask" | "byModel" | "bySource">; name: string }[] = [
  { key: "project", label: "By project", field: "byProject", name: "Project" },
  { key: "task", label: "By task", field: "byTask", name: "Task" },
  { key: "model", label: "By model", field: "byModel", name: "Model" },
  { key: "source", label: "By source", field: "bySource", name: "Source" },
]
const TOP_N = 10

export function UsageView() {
  const [params, setParams] = useSearchParams()
  const openSettings = useOpenSettings()
  const periodKey = (PERIODS.some((p) => p.key === params.get("period")) ? params.get("period") : "7d") as PeriodKey
  const customFrom = params.get("from")
  const customTo = params.get("to")
  // Recomputed per minute so "now" moves without a new cache entry on every render.
  const minute = Math.floor(Date.now() / 60_000)
  const range = useMemo(() => periodRange(periodKey, Date.now(), { from: customFrom, to: customTo }), [periodKey, customFrom, customTo, minute])
  const live = range.to >= minute * 60_000
  const usage = useUsage({ from: range.from, to: range.to, live })
  const data = usage.data
  const period = data?.period

  const setParam = (patch: Record<string, string | null>) =>
    setParams((p) => Object.entries(patch).reduce((acc, [k, v]) => withParam(acc, k, v), p), { replace: true })
  const choosePeriod = (key: PeriodKey) => {
    if (key !== "custom") return setParam({ period: key === "7d" ? null : key, from: null, to: null })
    // Start a custom range from what's on screen.
    setParam({ period: "custom", from: customFrom ?? dateInput(range.from), to: customTo ?? dateInput(range.to - 1) })
  }

  return (
    <div className="space-y-5 pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Usage</h1>
          <p className="mt-1 text-sm text-zinc-500">What Claude and your boxes cost, and where it went.</p>
        </div>
        <Button size="sm" onClick={() => openSettings("costs")}>
          <Settings className="h-3.5 w-3.5" /> Rates & budgets
        </Button>
      </header>

      <PeriodBar
        value={periodKey}
        onChange={choosePeriod}
        from={periodKey === "custom" ? (customFrom ?? dateInput(range.from)) : null}
        to={periodKey === "custom" ? (customTo ?? dateInput(range.to - 1)) : null}
        onRange={(from, to) => setParam({ from, to })}
        label={rangeLabel(range.from, range.to)}
      />

      {usage.isLoading && !data ? null : !data ? (
        <Empty title="Usage unavailable">The server did not return a usage report.</Empty>
      ) : !period ? (
        // A server from before the period report ignores ?from= and sends only all-time totals.
        <Empty title="Restart the server to see this page">This Box Yard server is older than the web app and doesn't send per-period usage yet.</Empty>
      ) : (
        <div className={cx("space-y-5 transition-opacity", usage.isPlaceholderData && "opacity-60")}>
          {data.budget.blocked && (
            <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
              <div>
                <div className="font-semibold">Budget exceeded. New agent turns are paused.</div>
                <div className="mt-1 text-amber-200/80">Raise the daily or monthly budget in Settings to resume queued work.</div>
              </div>
            </div>
          )}

          <section className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Summary period={period} label={PERIODS.find((p) => p.key === periodKey)!.label} />
            <Budgets budget={data.budget} today={data.windows.find((w) => w.key === "today")} onEdit={() => openSettings("costs")} />
          </section>

          <Card title="Spend over time" aside={period.bucketMs < 86_400_000 ? "per hour" : "per day"}>
            <Legend />
            {period.totalCostUsd > 0 ? (
              <div className="mt-3">
                <UsageChart buckets={period.buckets} bucketMs={period.bucketMs} categories={USAGE_CATEGORIES} />
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-zinc-500">No spend in this period.</p>
            )}
          </Card>

          <Breakdowns period={period} />

          <BoxesTable period={period} />
        </div>
      )}
    </div>
  )
}

function PeriodBar({
  value,
  onChange,
  from,
  to,
  onRange,
  label,
}: {
  value: PeriodKey
  onChange: (k: PeriodKey) => void
  from: string | null
  to: string | null
  onRange: (from: string, to: string) => void
  label: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div role="radiogroup" aria-label="Period" className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            role="radio"
            aria-checked={value === p.key}
            onClick={() => onChange(p.key)}
            className={cx(
              "min-h-11 rounded-md px-3 text-sm font-medium whitespace-nowrap transition sm:min-h-0 sm:py-1.5",
              value === p.key ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100",
            )}
          >
            {p.short}
          </button>
        ))}
      </div>
      {from !== null && to !== null && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <input type="date" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && onRange(e.target.value, to)} className={cx(inputClass, "w-auto [color-scheme:dark] sm:py-1")} />
          <span>to</span>
          <input type="date" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && onRange(from, e.target.value)} className={cx(inputClass, "w-auto [color-scheme:dark] sm:py-1")} />
        </div>
      )}
      <span className="text-sm text-zinc-500 tabular-nums">{label}</span>
    </div>
  )
}

function Card({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        {aside && <span className="text-xs text-zinc-500">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Swatch({ color }: { color: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
      {USAGE_CATEGORIES.map((c) => (
        <li key={c} className="flex items-center gap-1.5" title={CATEGORY_META[c].hint}>
          <Swatch color={CATEGORY_META[c].color} /> {CATEGORY_META[c].label}
        </li>
      ))}
    </ul>
  )
}

function Summary({ period, label }: { period: UsagePeriodReport; label: string }) {
  const total = period.totalCostUsd
  return (
    <Card title={label} aside={`${compactTokens(period.claude.totalTokens)} Claude tokens · ${period.claude.turns} turns`}>
      <div className="text-4xl font-semibold tracking-tight text-zinc-50">{money(total)}</div>
      {/* Stacked bar: 2px surface gaps between categories. */}
      <div className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded" aria-hidden>
        {total > 0 ? (
          USAGE_CATEGORIES.filter((c) => period.categories[c].costUsd > 0).map((c) => (
            <div key={c} style={{ width: `${(period.categories[c].costUsd / total) * 100}%`, background: CATEGORY_META[c].color }} className="min-w-[2px]" />
          ))
        ) : (
          <div className="flex-1 bg-zinc-800" />
        )}
      </div>
      <ul className="mt-4 divide-y divide-zinc-800/60 text-sm">
        {USAGE_CATEGORIES.map((c) => (
          <li key={c} className="flex items-center gap-2 py-1.5" title={CATEGORY_META[c].hint}>
            <Swatch color={CATEGORY_META[c].color} />
            <span className="min-w-0 flex-1 truncate text-zinc-300">{CATEGORY_META[c].label}</span>
            <span className="hidden text-xs text-zinc-500 tabular-nums sm:inline">
              {c === "boxes" ? `${hours(period.boxes.activeMs)} CPU` : `${period.categories[c].turns} turns`}
            </span>
            <span className="w-24 text-right font-medium text-zinc-100 tabular-nums">{money(period.categories[c].costUsd)}</span>
            <span className="w-12 text-right text-xs text-zinc-500 tabular-nums">{pct(period.categories[c].costUsd, total)}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Budgets({ budget, today, onEdit }: { budget: BudgetStatus; today: UsageWindow | undefined; onEdit: () => void }) {
  // The daily budget follows the server's day, which may not be the browser's.
  const resets = today ? new Date(today.since).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null
  const crossesDay = today ? new Date(today.since).getHours() !== 0 || new Date(today.since).getMinutes() !== 0 : false
  return (
    <Card title="Budgets" aside={<button onClick={onEdit} className="text-sky-400 hover:underline">Edit</button>}>
      <div className="space-y-4">
        <Meter label="Daily" hint={crossesDay && resets ? `since ${resets} (server day)` : "today"} state={budget.daily} onEdit={onEdit} />
        <Meter label="Monthly" hint="in the last 30 days" state={budget.monthly} onEdit={onEdit} />
      </div>
    </Card>
  )
}

function Meter({ label, hint, state, onEdit }: { label: string; hint: string; state: BudgetStatus["daily"]; onEdit: () => void }) {
  const on = state.limitUsd > 0
  const ratio = on ? Math.min(1, state.usedUsd / state.limitUsd) : 0
  const tone = state.exceeded ? "bg-red-500" : state.warning ? "bg-amber-400" : "bg-sky-500"
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-zinc-300">{label}</span>
        <span className="shrink-0 whitespace-nowrap text-zinc-400 tabular-nums">
          <span className="font-semibold text-zinc-100">{money(state.usedUsd)}</span>
          {on ? ` of ${money(state.limitUsd, 0)}` : ""}
        </span>
      </div>
      {on ? (
        <>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sky-950/60" role="meter" aria-label={`${label} budget`} aria-valuemin={0} aria-valuemax={state.limitUsd} aria-valuenow={state.usedUsd}>
            <div className={cx("h-full rounded-full", tone)} style={{ width: `${ratio * 100}%` }} />
          </div>
          <div className={cx("mt-1 text-xs", state.exceeded ? "text-red-300" : state.warning ? "text-amber-300" : "text-zinc-500")}>
            {state.exceeded ? `Over budget (${hint}). New agent turns are paused.` : `${pct(state.usedUsd, state.limitUsd)} used ${hint} · ${money(Math.max(0, state.limitUsd - state.usedUsd))} left`}
          </div>
        </>
      ) : (
        <button onClick={onEdit} className="mt-1 text-xs text-zinc-500 hover:text-zinc-300">
          Used {hint}. No limit set
        </button>
      )}
    </div>
  )
}

function Breakdowns({ period }: { period: UsagePeriodReport }) {
  const [params, setParams] = useSearchParams()
  const by = (BREAKDOWNS.some((b) => b.key === params.get("by")) ? params.get("by") : "project") as BreakdownKey
  const tab = BREAKDOWNS.find((b) => b.key === by)!
  const [sort, setSort] = useState<{ key: BreakdownSort; dir: "asc" | "desc" }>({ key: "cost", dir: "desc" })
  const [all, setAll] = useState(false)
  const rows = useMemo(() => sortBreakdown(period[tab.field], sort.key, sort.dir), [period, tab.field, sort])
  const real = rows.filter((r) => !r.other)
  const shown = all ? rows : [...real.slice(0, TOP_N), ...rows.filter((r) => r.other)]
  const hidden = real.length - Math.min(real.length, TOP_N)
  const expandable = rows.some((r) => r.children?.length)

  const header = (key: BreakdownSort, label: string, className?: string) => {
    const on = sort.key === key
    return (
      <th scope="col" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cx("px-3 py-2 font-medium", key === "name" ? "text-left" : "w-px text-right", className)}>
        <button
          onClick={() => setSort(on ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" })}
          className={cx("inline-flex items-center gap-1 whitespace-nowrap hover:text-zinc-200", on && "text-zinc-200")}
        >
          {label}
          {on && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
        </button>
      </th>
    )
  }

  return (
    <section className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 px-4 pt-2">
        <h2 className="sr-only">Breakdown</h2>
        <nav aria-label="Breakdown" className="scroll-thin -mb-px flex gap-1 overflow-x-auto">
          {BREAKDOWNS.map((b) => (
            <button
              key={b.key}
              aria-current={b.key === by ? "page" : undefined}
              onClick={() => {
                setAll(false)
                setParams((p) => withParam(p, "by", b.key === "project" ? null : b.key), { replace: true })
              }}
              className={cx(
                "min-h-11 shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition sm:min-h-0",
                b.key === by ? "border-yard-500 text-zinc-50" : "border-transparent text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
              )}
            >
              {b.label}
            </button>
          ))}
        </nav>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-500">No spend in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b border-zinc-800/80">
                {header("name", tab.name)}
                {header("turns", "Turns", "hidden sm:table-cell")}
                {header("tokens", "Tokens", "hidden md:table-cell")}
                {header("avg", "Avg / turn", "hidden md:table-cell")}
                {header("cost", "Cost")}
                {header("share", "% of total")}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <BreakdownRows key={r.key} row={r} total={period.totalCostUsd} expandable={expandable} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-2 font-medium">Total</td>
                <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{period.claude.turns}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{compactTokens(period.claude.totalTokens)}</td>
                <td className="hidden px-3 py-2 md:table-cell" />
                <td className="px-3 py-2 text-right font-semibold text-zinc-100 tabular-nums">{money(period.totalCostUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {hidden > 0 && (
        <div className="border-t border-zinc-800/80 px-4 py-2">
          <button onClick={() => setAll(!all)} className="text-sm text-sky-400 hover:underline">
            {all ? `Show top ${TOP_N}` : `Show all ${real.length}`}
          </button>
        </div>
      )}
    </section>
  )
}

function BreakdownRows({ row, total, expandable }: { row: UsageBreakdownRow; total: number; expandable: boolean }) {
  const [open, setOpen] = useState(false)
  const kids = row.children ?? []
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      {kids.length > 0 ? (
        <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${row.label} details`} className="-m-1 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <ChevronRight className={cx("h-3.5 w-3.5 transition", open && "rotate-90")} />
        </button>
      ) : expandable ? (
        <span className="w-3.5 shrink-0" />
      ) : null}
      {row.category && <Swatch color={CATEGORY_META[row.category].color} />}
      <span className="min-w-0">
        {row.href ? (
          <Link href={row.href} className={cx("block truncate hover:underline", row.other ? "text-zinc-400" : "text-zinc-100")}>
            {row.label}
          </Link>
        ) : (
          <span className={cx("block truncate", row.other ? "text-zinc-400" : "text-zinc-100")}>{row.label}</span>
        )}
        {row.detail && <span className="block truncate text-xs text-zinc-500">{row.detail}</span>}
      </span>
    </span>
  )
  return (
    <>
      <Row name={name} row={row} total={total} muted={row.other} />
      {open && kids.map((k) => <Row key={k.key} row={k} total={total} nested name={<ChildName row={k} />} />)}
    </>
  )
}

function ChildName({ row }: { row: UsageBreakdownRow }) {
  const label = row.href ? (
    <Link href={row.href} className="truncate text-zinc-300 hover:underline">
      {row.label}
    </Link>
  ) : (
    <span className="truncate text-zinc-300">{row.label}</span>
  )
  return (
    <span className="flex min-w-0 items-baseline gap-2 pl-12">
      {label}
      {row.runs !== undefined && <span className="shrink-0 text-xs text-zinc-500">{row.runs} runs</span>}
    </span>
  )
}

function Row({ name, row, total, muted, nested }: { name: ReactNode; row: UsageBreakdownRow; total: number; muted?: boolean; nested?: boolean }) {
  const avg = avgPerTurn(row)
  return (
    <tr className={cx("border-b border-zinc-800/50 last:border-0", nested ? "bg-zinc-950/40 text-xs" : "hover:bg-zinc-900/60", muted && "text-zinc-400")}>
      <td className="max-w-0 px-3 py-2">{name}</td>
      <td className="hidden px-3 py-2 text-right text-zinc-400 tabular-nums sm:table-cell">{row.turns || "–"}</td>
      <td className="hidden px-3 py-2 text-right text-zinc-400 tabular-nums md:table-cell">{row.tokens ? compactTokens(row.tokens) : "–"}</td>
      <td className="hidden px-3 py-2 text-right text-zinc-400 tabular-nums md:table-cell">{avg === null ? "–" : money(avg)}</td>
      <td className={cx("px-3 py-2 text-right whitespace-nowrap tabular-nums", nested ? "text-zinc-300" : "font-medium text-zinc-100")}>{money(row.costUsd)}</td>
      <td className="px-3 py-2 text-right text-zinc-400 tabular-nums">{pct(row.costUsd, total)}</td>
    </tr>
  )
}

function BoxesTable({ period }: { period: UsagePeriodReport }) {
  const boxes = period.boxList.filter((b) => b.live || b.costUsd > 0)
  const estimated = boxes.some((b) => b.source === "estimated")
  const measured = !estimated && boxes.some((b) => b.source === "measured")
  return (
    <section className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/30">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
        <h2 className="text-sm font-semibold text-zinc-200">Boxes</h2>
        <span className="text-xs text-zinc-500 tabular-nums">
          {money(period.boxes.costUsd)} · {hours(period.boxes.activeMs)} CPU
        </span>
      </div>
      {boxes.length === 0 ? (
        <p className="px-4 pb-6 text-sm text-zinc-500">No box time in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-y border-zinc-800/80">
                <th scope="col" className="px-3 py-2 text-left font-medium">Box</th>
                <th scope="col" className="hidden w-px px-3 py-2 text-left font-medium sm:table-cell">Size</th>
                <th scope="col" className="hidden w-px px-3 py-2 text-left font-medium whitespace-nowrap sm:table-cell">Keep-alive</th>
                <th scope="col" className="w-px px-3 py-2 text-right font-medium whitespace-nowrap">CPU h</th>
                <th scope="col" className="hidden w-px px-3 py-2 text-right font-medium md:table-cell">Disk</th>
                <th scope="col" className="w-px px-3 py-2 text-right font-medium">
                  <span
                    className="inline-flex cursor-help items-center gap-1 whitespace-nowrap"
                    title={
                      estimated
                        ? "Partly estimated: some boxes' CPU use wasn't measured, so the time turns ran on them counts, at your rates in Settings → Usage."
                        : measured
                          ? "The CPU time each box used (Upstash bills active CPU), at your rates in Settings → Usage, plus keep-alive and disk."
                          : "Reported by the box provider."
                    }
                  >
                    {estimated ? "Est. cost" : "Cost"} {estimated && <Info className="h-3 w-3" />}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.boxId} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-900/60">
                  <td className="max-w-0 px-3 py-2">
                    {b.live ? (
                      <Link href={`/boxes#${b.boxId}`} className="block truncate font-mono text-zinc-100 hover:underline">
                        {b.boxId}
                      </Link>
                    ) : (
                      <span className="block truncate font-mono text-zinc-500">
                        {b.boxId} <span className="font-sans text-xs">(deleted)</span>
                      </span>
                    )}
                    <span className="text-xs text-zinc-500 sm:hidden">
                      {b.size}
                      {b.keepAlive ? " · keep-alive" : ""}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-zinc-400 sm:table-cell">{b.size}</td>
                  <td className="hidden px-3 py-2 text-zinc-400 sm:table-cell">{b.keepAlive ? "Yes" : "No"}</td>
                  <td className="px-3 py-2 text-right text-zinc-400 tabular-nums">{hours(b.activeMs).replace(/h$/, "")}</td>
                  <td className="hidden px-3 py-2 text-right whitespace-nowrap text-zinc-400 tabular-nums md:table-cell">{b.diskBytes ? bytes(b.diskBytes) : "–"}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-zinc-100 tabular-nums">{money(b.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
