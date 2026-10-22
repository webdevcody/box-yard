// The card grid shared by the project Tasks tab and the Yard view: sorted once and held still while agents
// update (useStableOrder), with the Re-sort pill on top and cards rendered a page at a time.
import { memo, useState } from "react"
import { useStableOrder, type StableOrder } from "../lib/useStableOrder"
import type { StableOptions } from "../lib/stableOrder"
import type { Task } from "../../../shared/types"
import { TaskCard } from "./TaskCard"
import { ResortPill } from "./ResortPill"

/** useStableOrder for tasks, keyed by id. Pass every candidate task and filter with `include`, so cards that leave dim in place. */
export function useStableTasks(tasks: readonly Task[], opts: Omit<StableOptions<Task, string>, "key"> & { resetKey: unknown }): StableOrder<Task> {
  return useStableOrder(tasks, { ...opts, key: (t) => t.id })
}

/** Cards only re-render when their task changes; react-query keeps unchanged task objects identical. */
const MemoTaskCard = memo(TaskCard)

/** Cards rendered up front; more on request, so a list with hundreds of tasks opens fast. */
const PAGE = 60

/**
 * `projectName` labels each card (Yard view). `pillClassName` is the pill's sticky offset (below a sticky tab bar).
 * Give it a `key` that changes with the tab so paging starts over.
 */
export function TaskGrid({ stable, projectName, pillClassName }: { stable: StableOrder<Task>; projectName?: (projectId: string) => string | undefined; pillClassName?: string }) {
  const [limit, setLimit] = useState(PAGE)
  const rest = stable.entries.length - limit
  return (
    <>
      <div ref={stable.listRef} className="scroll-mt-14">
        <ResortPill newCount={stable.newCount} changedCount={stable.changedCount} onResort={stable.resort} className={pillClassName} />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {stable.entries.slice(0, limit).map(({ item: t, stale }) => (
            // Off-screen cards skip layout and paint, which keeps hundreds of them cheap without a virtual list.
            <div key={t.id} data-stable-key={t.id} className="[contain-intrinsic-size:auto_9rem] [content-visibility:auto]">
              <MemoTaskCard task={t} projectName={projectName?.(t.projectId)} stale={stale} />
            </div>
          ))}
        </div>
      </div>
      {rest > 0 && (
        <button
          onClick={() => setLimit((n) => n + PAGE * 2)}
          className="w-full rounded-xl border border-dashed border-zinc-800 py-2.5 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
        >
          Show {Math.min(rest, PAGE * 2)} more of {rest}
        </button>
      )}
    </>
  )
}
