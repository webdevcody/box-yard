// The Coordinator chat's one filter bar, under its header: "All · 6 active" ("All · 2 running elsewhere" while a project is
// picked, so a running task never seems to vanish), then a chip per project in its colour with
// what its tasks are doing ("1 needs you · 3 running"). A chip shows only that project's part of the chat; "All", the
// pressed chip again or its × shows everything. The chips scroll sideways at any width (lib/projectBar.ts); `trailing`
// (the cards' "✓ 24 done today", "N idle" and Select, CoordinatorCards.tsx) stays put on the right.
//
// An unpicked chip's × takes its project off the bar (it shows on hover or focus in the chip's right padding, so nothing
// moves, and always on touch screens). It stays off until it's picked in the chat switcher again;
// meanwhile a task of its asking Cody something shows in the "+1 needs you" chip at the end, which puts it back.
// The picked chip's × is "Show all" instead. In a narrow bar with a project picked, the other chips are colour dots, so
// the picked one and its × stay in view.
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react"
import { X } from "lucide-react"
import { useProjects, useTasks } from "../lib/queries"
import { useTiles } from "../lib/taskTiles"
import { barCounts, centredScrollLeft, elsewhereLabel, pickProject, pinProject, projectBarRows, setChatProjectFilter, unpinProject, useBarPins, useChatProjectFilter, type BarRow } from "../lib/projectBar"
import { projectColorStyle } from "./TaskIcon"
import { cx } from "./ui"
import type { ProjectColor } from "../../../shared/projectColors"

/** The bar's chips: 44px tall under a finger. */
export const BAR_CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-xs whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:h-11"
const CHIP = BAR_CHIP
export const CHIP_OFF = "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700"
const CHIP_ON = "border-(--pc)/70 bg-(--pc)/15 text-zinc-50"
/** A project's chip: the pill around its button and its ×, ringed when either has keyboard focus. */
const PILL =
  "group/pill relative inline-flex h-7 shrink-0 items-center rounded-full border text-xs whitespace-nowrap transition has-focus-visible:ring-2 has-focus-visible:ring-yard-500/50 pointer-coarse:h-11"
// A narrow bar (a phone, a slim panel, @max-[30rem]/bar): "All" without its count, and with a project picked, the
// others as dots. Tailwind reads class names from the source, so they're spelled out whole.

/**
 * `recent`: the projects the chat talked about lately (lib/chatProvenance.ts), shown even with nothing running.
 * `trailing`: on the bar's right, outside the chips' scroll. The bar hides while it has no button at all.
 */
export const ProjectBar = memo(function ProjectBar({ recent, className, trailing }: { recent: ReadonlySet<string>; className?: string; trailing?: ReactNode }) {
  const projects = useProjects()
  const tasks = useTasks()
  const filter = useChatProjectFilter()
  const pins = useBarPins()
  const { colors } = useTiles()
  const { rows, active, hidden, elsewhere } = useMemo(
    () => projectBarRows(projects.data ?? [], tasks.data ?? [], recent, filter, pins),
    [projects.data, tasks.data, recent, filter, pins],
  )
  const away = filter ? elsewhereLabel(elsewhere) : null
  const bar = useRef<HTMLDivElement>(null)
  // A project that's gone (deleted) can't stay the filter.
  useEffect(() => {
    if (filter && projects.data && !projects.data.some((p) => p.id === filter)) setChatProjectFilter(null)
  }, [filter, projects.data])
  // The pressed chip scrolls to the bar's middle whenever the pick changes (the switcher, P, a chip, +N needs you), or
  // the bar first shows. Only the bar scrolls: scrollIntoView would move the page and the panel too.
  const shown = rows.length > 0 || hidden.length > 0
  const centred = useRef(false)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    centreSelected(el, centred.current)
    centred.current = true
  }, [filter, shown])
  if (!shown && !trailing) return null
  return (
    <div
      role="toolbar"
      aria-label="Filter the chat"
      data-testid="filter-bar"
      className={cx("@container/bar flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-zinc-900 py-1.5 [&:not(:has(button))]:hidden", className)}
    >
      {shown && (
        <div
          ref={bar}
          role="group"
          aria-label="Projects"
          data-testid="project-bar"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            aria-pressed={!filter}
            onClick={() => setChatProjectFilter(null)}
            title={away ? `The whole chat: ${away}` : "The whole chat"}
            className={cx(CHIP, !filter ? "border-zinc-600 bg-zinc-800 text-zinc-50" : CHIP_OFF, "pointer-coarse:px-3.5")}
          >
            All
            {away ? (
              // A project picked hides the others' cards: say plainly what's still going on there. A narrow bar scrolls
              // "All" away to centre the picked chip, so there it's a line of its own under the chips.
              <span data-testid="bar-elsewhere" className={cx(elsewhere.needs ? "text-amber-300" : "text-zinc-400", "@max-[30rem]/bar:hidden")}>
                {" · "}
                {away}
              </span>
            ) : (
              <span className="text-zinc-400 @max-[30rem]/bar:hidden">
                {" · "}
                <b className="font-semibold text-zinc-200 tabular-nums">{active}</b> active
              </span>
            )}
          </button>
          {rows.map((row) => (
            <ProjectChip key={row.id} row={row} color={colors.get(row.id)} on={filter === row.id} dot={filter !== null && filter !== row.id} />
          ))}
          {hidden.length > 0 && <HiddenNeedsChip rows={hidden} />}
        </div>
      )}
      {trailing && <div className="ml-auto flex shrink-0 items-center gap-1.5 empty:hidden">{trailing}</div>}
      {away && (
        <button
          type="button"
          data-testid="bar-elsewhere-line"
          onClick={() => setChatProjectFilter(null)}
          title="Show the whole chat"
          className="flex basis-full items-center gap-1.5 rounded-md text-left text-xs text-zinc-400 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:min-h-11 @min-[30rem]/bar:hidden"
        >
          <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", elsewhere.needs ? "bg-amber-300" : "bg-yard-400")} />
          <span className={elsewhere.needs ? "text-amber-300" : undefined}>{away}</span>
          <span aria-hidden>·</span>
          <span className="text-yard-400">Show all</span>
        </button>
      )}
    </div>
  )
})

/** Scrolls `bar` sideways so its pressed chip is centred: smoothly once it's on screen, unless motion is reduced. */
export function centreSelected(bar: HTMLElement, smooth: boolean) {
  const pressed = bar.querySelector<HTMLElement>('[aria-pressed="true"]')
  const chip = pressed?.closest<HTMLElement>("[data-project]") ?? pressed
  if (!chip) return
  const left = centredScrollLeft(bar.getBoundingClientRect(), chip.getBoundingClientRect(), bar.scrollLeft, bar.clientWidth, bar.scrollWidth)
  if (Math.abs(left - bar.scrollLeft) < 1) return
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  if (typeof bar.scrollTo === "function") bar.scrollTo({ left, behavior: smooth && !reduced ? "smooth" : "auto" })
  else bar.scrollLeft = left
}

/** `dot`: another project is picked, so in a narrow bar this one is its colour dot alone (its name still read out). */
function ProjectChip({ row, color, on, dot }: { row: BarRow; color: ProjectColor | undefined; on: boolean; dot: boolean }) {
  const counts = barCounts(row)
  const narrow = dot ? "@max-[30rem]/bar:sr-only" : undefined
  return (
    <span data-project={row.id} style={projectColorStyle(color)} className={cx(PILL, on ? CHIP_ON : CHIP_OFF)}>
      <button
        type="button"
        aria-pressed={on}
        data-testid="project-chip"
        onClick={() => setChatProjectFilter(on ? null : row.id)}
        title={on ? "Show the whole chat" : `Only ${row.name}`}
        className={cx(
          "inline-flex h-full items-center gap-1.5 rounded-l-full pl-2 focus-visible:outline-none",
          // Picked: its × sits beside the name. Else room on the right for the unpin × (laid over it with a mouse,
          // beside it on touch).
          on ? "pr-1" : "pr-[18px] pointer-coarse:pr-0.5",
          // A dot alone: a round target, 44px under a finger.
          dot && "@max-[30rem]/bar:w-7 @max-[30rem]/bar:justify-center @max-[30rem]/bar:rounded-full @max-[30rem]/bar:px-0 pointer-coarse:@max-[30rem]/bar:w-11",
        )}
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" />
        <span className={narrow}>{row.name}</span>
        {counts.length > 0 && (
          <span className={cx("text-zinc-400", narrow)}>
            {counts.map((c) => (
              <span key={c.key} className={c.key === "needs" ? "text-amber-300" : undefined}>
                {" · "}
                <b className={cx("font-semibold tabular-nums", c.key === "needs" ? "text-amber-300" : "text-zinc-200")}>{c.n}</b> {c.label}
              </span>
            ))}
          </span>
        )}
      </button>
      {on ? (
        <button
          type="button"
          data-testid="project-clear"
          aria-label="Show all projects"
          title="Show the whole chat"
          onClick={() => setChatProjectFilter(null)}
          className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-(--pc)/20 text-zinc-200 transition hover:bg-(--pc)/35 hover:text-zinc-50 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          data-testid="project-unpin"
          aria-label={`Unpin ${row.name}`}
          title={`Take ${row.name} off the bar (pick it in the chat switcher to bring it back)`}
          onClick={() => unpinProject(row.id)}
          className={cx(
            "grid shrink-0 place-items-center rounded-full text-zinc-500 transition hover:bg-zinc-700/70 hover:text-zinc-100 focus-visible:outline-none",
            // With a mouse: in the chip's right padding, so the bar doesn't shift when it shows on hover or focus.
            "absolute top-1/2 right-[3px] h-4 w-4 -translate-y-1/2 opacity-0 group-hover/pill:opacity-100 group-has-focus-visible/pill:opacity-100",
            // On touch: always there, a bigger target beside the name.
            "pointer-coarse:static pointer-coarse:mr-1 pointer-coarse:h-9 pointer-coarse:w-9 pointer-coarse:translate-y-0 pointer-coarse:opacity-100",
            // A dot alone has no room for it: pick it, or unpin it from All.
            dot && "@max-[30rem]/bar:hidden",
          )}
        >
          <X className="h-2.5 w-2.5 pointer-coarse:h-3 pointer-coarse:w-3" aria-hidden />
        </button>
      )}
    </span>
  )
}

/** Unpinned projects with a task asking Cody: one chip at the end that puts them back on the bar (and shows a lone one). */
function HiddenNeedsChip({ rows }: { rows: BarRow[] }) {
  const n = rows.reduce((sum, r) => sum + r.needs, 0)
  const names = rows.map((r) => r.name).join(", ")
  return (
    <button
      type="button"
      data-testid="project-bar-hidden"
      onClick={() => {
        for (const r of rows) pinProject(r.id)
        if (rows.length === 1) pickProject(rows[0]!.id)
      }}
      title={`Unpinned, with a task asking you: ${names}. Put ${rows.length === 1 ? "it" : "them"} back on the bar`}
      className={cx(CHIP, "border-zinc-800 bg-zinc-900/60 pl-2.5 text-amber-300 hover:border-zinc-700")}
    >
      <span>
        <b className="font-semibold tabular-nums">+{n}</b> needs you
      </span>
    </button>
  )
}

/** In a filtered chat with nothing about the project yet: says so (the bar's picked chip is the way back). */
export function ProjectFilterEmpty({ projectId }: { projectId: string }) {
  const projects = useProjects()
  const name = projects.data?.find((p) => p.id === projectId)?.name ?? projectId
  return (
    <p data-testid="project-filter-empty" className="px-1 py-2 text-center text-xs text-zinc-500">
      Nothing about {name} in the chat yet
    </p>
  )
}
