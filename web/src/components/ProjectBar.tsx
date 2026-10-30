// The Coordinator chat's project bar, under its header: "All · 6 active", then a chip per project in its colour with
// what its tasks are doing ("1 needs you · 3 running"). A chip shows only that project's part of the chat; "All" (or
// the pressed chip again) shows everything. One row that scrolls sideways at any width (lib/projectBar.ts).
import { memo, useEffect, useMemo, useRef } from "react"
import { X } from "lucide-react"
import { useProjects, useTasks } from "../lib/queries"
import { useTiles } from "../lib/taskTiles"
import { barCounts, projectBarRows, setChatProjectFilter, useChatProjectFilter, type BarRow } from "../lib/projectBar"
import { projectColorStyle } from "./TaskIcon"
import { cx } from "./ui"
import type { ProjectColor } from "../../../shared/projectColors"

const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-xs whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:h-9"
const CHIP_OFF = "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700"
const CHIP_ON = "border-(--pc)/70 bg-(--pc)/15 text-zinc-50"

/** `recent`: the projects the chat talked about lately (lib/chatProvenance.ts), shown even with nothing running. */
export const ProjectBar = memo(function ProjectBar({ recent, className }: { recent: ReadonlySet<string>; className?: string }) {
  const projects = useProjects()
  const tasks = useTasks()
  const filter = useChatProjectFilter()
  const { colors } = useTiles()
  const { rows, active } = useMemo(() => projectBarRows(projects.data ?? [], tasks.data ?? [], recent, filter), [projects.data, tasks.data, recent, filter])
  const bar = useRef<HTMLDivElement>(null)
  // A project that's gone (deleted) can't stay the filter.
  useEffect(() => {
    if (filter && projects.data && !projects.data.some((p) => p.id === filter)) setChatProjectFilter(null)
  }, [filter, projects.data])
  // The pressed chip stays in view on a narrow bar.
  useEffect(() => {
    bar.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [filter])
  if (!rows.length) return null
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Projects"
      data-testid="project-bar"
      className={cx("flex items-center gap-1.5 overflow-x-auto border-b border-zinc-900 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    >
      <button
        type="button"
        aria-pressed={!filter}
        onClick={() => setChatProjectFilter(null)}
        title="The whole chat"
        className={cx(CHIP, !filter ? "border-zinc-600 bg-zinc-800 text-zinc-50" : CHIP_OFF)}
      >
        All
        <span className="text-zinc-400">
          · <b className="font-semibold text-zinc-200 tabular-nums">{active}</b> active
        </span>
      </button>
      {rows.map((row) => (
        <ProjectChip key={row.id} row={row} color={colors.get(row.id)} on={filter === row.id} />
      ))}
    </div>
  )
})

function ProjectChip({ row, color, on }: { row: BarRow; color: ProjectColor | undefined; on: boolean }) {
  const counts = barCounts(row)
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid="project-chip"
      data-project={row.id}
      onClick={() => setChatProjectFilter(on ? null : row.id)}
      title={on ? "Show the whole chat" : `Only ${row.name}`}
      style={projectColorStyle(color)}
      className={cx(CHIP, on ? CHIP_ON : CHIP_OFF)}
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" />
      {row.name}
      {counts.length > 0 && (
        <span className="text-zinc-400">
          {counts.map((c) => (
            <span key={c.key} className={c.key === "needs" ? "text-amber-300" : undefined}>
              {" · "}
              <b className={cx("font-semibold tabular-nums", c.key === "needs" ? "text-amber-300" : "text-zinc-200")}>{c.n}</b> {c.label}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

/** Above a filtered chat: what it shows, and the way back to all of it. */
export function ProjectFilterBanner({ projectId, empty, className }: { projectId: string; empty: boolean; className?: string }) {
  const projects = useProjects()
  const { colors } = useTiles()
  const name = projects.data?.find((p) => p.id === projectId)?.name ?? projectId
  return (
    <div
      data-testid="project-filter-banner"
      style={projectColorStyle(colors.get(projectId))}
      className={cx("flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400", className)}
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" />
      <span className="min-w-0 truncate">{empty ? `Nothing about ${name} in the chat yet` : `Only ${name}`}</span>
      <button
        type="button"
        onClick={() => setChatProjectFilter(null)}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-yard-400 hover:text-yard-300 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:min-h-9"
      >
        <X className="h-3 w-3" aria-hidden />
        Show all
      </button>
    </div>
  )
}
