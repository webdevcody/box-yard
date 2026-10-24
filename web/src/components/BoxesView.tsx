import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Link, useSearchParams } from "wouter"
import { AlertTriangle, Boxes, ChevronRight, Eraser, ExternalLink, Globe, Info, Loader2, Maximize2, MoreHorizontal, PanelTopOpen, Settings, Sparkles, Trash2, X } from "lucide-react"
import { useAgentSettings, useBoxes, useCleanBox, useHealth, useProjects, useTasks } from "../lib/queries"
import { CAPACITY_NOTICE_KEY, capacityNotice, capacityNoticeText, showCapacityNotice } from "../lib/capacity"
import { useHash, useScrollToHash } from "../lib/hash"
import { shortDuration, splitBoxTasks } from "../lib/boxTasks"
import { BOX_FILTERS, boxAttention, boxBusyReason, boxFilterCounts, diskTone, filterBoxes, nowRunning, parseBoxFilter, poolSummary, rootTone, type AttentionReason, type BoxFilter } from "../lib/boxOverview"
import { hours, money } from "../lib/usage"
import { cleanupLine, diskMeter, rootMeter } from "../lib/diskCleanup"
import { formatBytes, measuredAgo } from "../../../shared/disk"
import { Button, Empty, NewTabLink, PrChip, STATUS, StatusBadge, cx, timeAgo, LineIcon, waitIconOf } from "./ui"
import { Modal } from "./Modal"
import { menuItem, menuItemBase, usePopover } from "./TaskHeader"
import { BoxActionDialog, type BoxAction as ConfirmAction } from "./BoxActionDialog"
import { BoxResizeDialog } from "./BoxResizeDialog"
import { resizeLine } from "../lib/boxResize"
import { badgeStatus } from "../lib/prState"
import { useOpenSettings } from "./SettingsDialog"
import { agentCapacity, type BoxCleanup, type BoxInfo, type Task } from "../../../shared/types"

const RUNNING: Task["status"][] = ["working", "starting"]

type BoxAction = ConfirmAction | "resize"

const BOX_STATUS: Record<BoxInfo["status"], { label: string; chip: string; dot: string }> = {
  creating: { label: "Starting", chip: "bg-sky-500/10 text-sky-300", dot: "bg-sky-400 animate-pulse" },
  ready: { label: "Running", chip: "bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
  lost: { label: "Error", chip: "bg-red-500/10 text-red-300", dot: "bg-red-500" },
  deleting: { label: "Deleting", chip: "bg-zinc-800 text-zinc-300", dot: "bg-zinc-500" },
}

const TONE_BAR = { ok: "bg-yard-500", warn: "bg-amber-400", error: "bg-red-500", unknown: "bg-zinc-600" } as const
const TONE_TEXT = { ok: "text-zinc-300", warn: "font-medium text-amber-300", error: "font-medium text-red-300", unknown: "text-zinc-500" } as const

/** A box's details live at /boxes#<id>, so links from tasks, the palette and Usage open them directly. */
const boxHref = (id: string) => `/boxes#${encodeURIComponent(id)}`

export function BoxesView() {
  const boxes = useBoxes()
  const tasks = useTasks()
  const projects = useProjects()
  const health = useHealth()
  useScrollToHash(Boolean(boxes.data), "box-")
  const hash = useHash()
  const openSettings = useOpenSettings()
  const [params] = useSearchParams()
  const filter = parseBoxFilter(params.get("filter"))

  const pool = health.data?.pool
  const list = boxes.data ?? []
  const all = tasks.data ?? []
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id
  const tasksOn = (boxId: string) => all.filter((t) => t.boxId === boxId)
  const running = all.filter((t) => t.boxId && RUNNING.includes(t.status)).length
  const queued = all.filter((t) => t.status === "queued").sort((a, b) => a.updatedAt - b.updatedAt)
  const shown = filterBoxes(list, filter)
  const selected = list.find((b) => b.id === hash) ?? null
  const [action, setAction] = useState<{ boxId: string; kind: BoxAction } | null>(null)
  const actionBox = action ? list.find((b) => b.id === action.boxId) ?? null : null
  const onAction = (boxId: string, kind: BoxAction) => setAction({ boxId, kind })

  // Opening a row pushes #<id> so Back closes the details; closing pops it again (or drops a hash we arrived with).
  const openedHere = useRef(false)
  useEffect(() => {
    if (!hash) openedHere.current = false
  }, [hash])
  const openBox = (id: string) => {
    openedHere.current = true
    window.location.hash = encodeURIComponent(id)
  }
  const closeBox = () => {
    if (openedHere.current) {
      openedHere.current = false
      history.back()
      return
    }
    history.replaceState(history.state, "", window.location.pathname + window.location.search)
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Boxes</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Worker boxes on {health.data?.provider ?? "…"} and the agents running on them.
          </p>
        </div>
        <button onClick={() => openSettings("limits")} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg text-sm text-sky-400 hover:underline sm:min-h-0">
          <Settings className="h-3.5 w-3.5" /> Edit limits
        </button>
      </header>

      <CapacityNotice onEdit={() => openSettings("limits")} />

      {pool && <SummaryStrip boxes={list} maxBoxes={pool.maxBoxes} running={running} maxAgents={agentCapacity(pool)} />}

      {boxes.isLoading ? null : list.length === 0 ? (
        <Empty icon={<Boxes className="h-8 w-8" />} title="No boxes yet">
          Boxes are created when a task needs one.
        </Empty>
      ) : (
        <section className="space-y-2">
          <FilterTabs boxes={list} selected={filter} />
          <BoxTable boxes={shown} filter={filter} highlighted={hash} tasksOn={tasksOn} onOpen={openBox} onAction={onAction} />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">
          Waiting for a slot <span className="text-zinc-600">{queued.length}</span>
        </h2>
        {queued.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing is waiting. Every task has a slot.</p>
        ) : (
          <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/80 bg-zinc-900/40">
            {queued.map((t) => (
              <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} note={t.waitReason} />
            ))}
          </div>
        )}
      </section>

      {selected && <BoxDetails key={selected.id} box={selected} tasks={tasksOn(selected.id)} projectName={projectName} onClose={closeBox} onAction={onAction} />}
      {action?.kind === "resize" && actionBox && <BoxResizeDialog key={`${action.boxId}-resize`} box={actionBox} onClose={() => setAction(null)} />}
      {action && action.kind !== "resize" && actionBox && (
        <BoxActionDialog
          key={`${action.boxId}-${action.kind}`}
          box={actionBox}
          action={action.kind}
          onClose={() => setAction(null)}
          onDone={() => {
            if (action.kind === "delete" && hash === action.boxId) closeBox()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- summary strip and filters

function SummaryStrip({ boxes, maxBoxes, running, maxAgents }: { boxes: BoxInfo[]; maxBoxes: number; running: number; maxAgents: number }) {
  const { costUsd, attention } = poolSummary(boxes)
  const over = boxes.length > maxBoxes || running > maxAgents
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="box-summary">
        <Tile label="Boxes" over={boxes.length > maxBoxes}>
          <Ratio value={boxes.length} max={maxBoxes} />
          <Meter used={boxes.length} total={maxBoxes} className="mt-1.5" />
        </Tile>
        <Tile label="Agents running" over={running > maxAgents}>
          <Ratio value={running} max={maxAgents} />
          <Meter used={running} total={maxAgents} className="mt-1.5" />
        </Tile>
        <Tile label="Est. cost" title="Estimated box cost since each live box started (active time, uptime and disk). See Usage for periods.">
          <div className="text-base font-semibold text-zinc-50 tabular-nums">{money(costUsd)}</div>
        </Tile>
        <Link
          href="/boxes?filter=attention"
          replace
          className={cx(
            "rounded-xl border px-3 py-2 transition hover:border-zinc-700",
            attention ? "border-amber-500/30 bg-amber-500/5" : "border-zinc-800/80 bg-zinc-900/40",
          )}
          title="Boxes that are low on disk, not responding, over their agent limit or whose last cleanup failed"
        >
          <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Needs attention</div>
          <div className={cx("flex items-center gap-1.5 text-base font-semibold tabular-nums", attention ? "text-amber-300" : "text-zinc-50")}>
            {attention > 0 && <AlertTriangle className="h-4 w-4" />}
            {attention}
          </div>
        </Link>
      </div>
      {over && <div className="mt-1.5 text-xs font-medium text-amber-300">Over limit: running work continues, nothing new is placed until usage drops.</div>}
    </div>
  )
}

function Tile({ label, over, title, children }: { label: string; over?: boolean; title?: string; children: ReactNode }) {
  return (
    <div title={title} className={cx("rounded-xl border bg-zinc-900/40 px-3 py-2", over ? "border-amber-500/40" : "border-zinc-800/80")}>
      <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      {children}
    </div>
  )
}

function Ratio({ value, max }: { value: number; max: number }) {
  return (
    <div className={cx("text-base font-semibold tabular-nums", value > max ? "text-amber-300" : "text-zinc-50")}>
      {value}
      <span className="font-normal text-zinc-500"> / {max}</span>
    </div>
  )
}

/** All / Busy / Idle / Needs attention, bound to `?filter=`. Filtering never reorders rows. */
function FilterTabs({ boxes, selected }: { boxes: BoxInfo[]; selected: BoxFilter }) {
  const counts = boxFilterCounts(boxes)
  return (
    <nav aria-label="Filter boxes" className="scroll-thin flex gap-1 overflow-x-auto">
      {BOX_FILTERS.map((f) => {
        const on = f.key === selected
        const warn = f.key === "attention" && counts.attention > 0
        return (
          <Link
            key={f.key}
            href={f.key === "all" ? "/boxes" : `/boxes?filter=${f.key}`}
            replace
            aria-current={on ? "page" : undefined}
            className={cx(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition sm:min-h-8",
              on ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            {f.label}
            <span className={cx("rounded-full px-1.5 text-[11px] tabular-nums", warn ? "bg-amber-500/15 text-amber-300" : on ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500")}>
              {counts[f.key]}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

/** A thin bar; segmented when there are few enough slots to count at a glance. */
function Meter({ used, total, className, tone, label }: { used: number; total: number; className?: string; tone?: keyof typeof TONE_BAR; label?: string }) {
  const cells = Math.max(total, used)
  if (tone === undefined && cells > 0 && cells <= 6)
    return (
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} className={cx("flex gap-0.5", className)}>
        {Array.from({ length: cells }, (_, i) => (
          <div key={i} className={cx("h-1.5 flex-1 rounded-sm", i < used ? (i < total ? "bg-yard-500" : "bg-amber-400") : "bg-zinc-700")} />
        ))}
      </div>
    )
  const bar = tone ? TONE_BAR[tone] : used > total ? "bg-amber-400" : "bg-yard-500"
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} className={cx("h-1.5 overflow-hidden rounded-sm bg-zinc-700", className)}>
      <div className={cx("h-full", bar)} style={{ width: `${total ? Math.min(100, (used / total) * 100) : 0}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------- the table

// One grid for the header and every row once the list is wide enough; below that a row is two lines.
const COLS = "@2xl:grid-cols-[minmax(12rem,1.5fr)_3.75rem_6.5rem_minmax(4.5rem,0.7fr)_minmax(7rem,1.6fr)_2rem]"

function BoxTable({
  boxes,
  filter,
  highlighted,
  tasksOn,
  onOpen,
  onAction,
}: {
  boxes: BoxInfo[]
  filter: BoxFilter
  highlighted: string
  tasksOn: (boxId: string) => Task[]
  onOpen: (id: string) => void
  onAction: (boxId: string, kind: BoxAction) => void
}) {
  return (
    <div className="@container rounded-xl border border-zinc-800/80 bg-zinc-900/40" data-testid="box-table">
      <div className={cx("hidden gap-x-3 border-b border-zinc-800/80 px-3 py-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase @2xl:grid", COLS)}>
        <span>Box</span>
        <span>Agents</span>
        <span>Disk</span>
        <span>Projects</span>
        <span>Running now</span>
        <span className="sr-only">Actions</span>
      </div>
      {boxes.length === 0 ? (
        <div className="px-3 py-4 text-sm text-zinc-500">{filter === "attention" ? "No box needs attention." : filter === "busy" ? "No box is running an agent." : "Every box is busy."}</div>
      ) : (
        <div className="divide-y divide-zinc-800/80">
          {boxes.map((box) => (
            <BoxRow key={box.id} box={box} tasks={tasksOn(box.id)} highlighted={highlighted === box.id} onOpen={onOpen} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  )
}

function BoxRow({
  box,
  tasks,
  highlighted,
  onOpen,
  onAction,
}: {
  box: BoxInfo
  tasks: Task[]
  highlighted: boolean
  onOpen: (id: string) => void
  onAction: (boxId: string, kind: BoxAction) => void
}) {
  const st = BOX_STATUS[box.status]
  const attention = boxAttention(box)
  const disk = diskMeter(box)
  const tone = diskTone(box)
  const now = nowRunning(tasks)
  const over = box.runningTurns > box.slots
  const busy = boxBusyReason(box)
  // A plain click opens the details here; Cmd/Ctrl or middle click opens them in a new tab. Not an <a>: the row holds links and a menu.
  const open = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a, button, [role=menu]")) return
    if ("key" in e) {
      if (e.key !== "Enter") return
    } else if (e.button > 1) return
    e.preventDefault()
    if ("button" in e && (e.button === 1 || e.metaKey || e.ctrlKey)) window.open(boxHref(box.id), "_blank", "noopener")
    else onOpen(box.id)
  }
  return (
    <div
      id={`box-${box.id}`}
      role="link"
      tabIndex={0}
      data-href={boxHref(box.id)}
      aria-label={`${box.id} details`}
      onClick={open}
      onAuxClick={open}
      onKeyDown={open}
      data-testid="box-row"
      className={cx(
        "grid scroll-mt-6 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs transition first:rounded-t-xl last:rounded-b-xl hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none",
        "cursor-pointer @2xl:py-2.5",
        COLS,
        highlighted && "bg-yard-500/5 ring-1 ring-yard-500/30 ring-inset",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx("h-2 w-2 shrink-0 rounded-full", st.dot)} title={st.label} aria-label={st.label} role="img" />
          <span className="truncate font-mono text-xs font-medium text-zinc-100 @2xl:text-[12.5px]" title={box.id}>
            {box.id}
          </span>
          <AttentionIcon reasons={attention} />
          {busy && (
            <span role="img" aria-label={busy} title={busy} className="shrink-0">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" />
            </span>
          )}
          <span className="shrink-0 text-zinc-500 @2xl:hidden">{box.size}</span>
        </div>
        <div className="mt-0.5 hidden truncate pl-4 text-[11px] text-zinc-500 @2xl:block">
          {box.size} · {box.status === "ready" ? `up ${shortDuration(box.uptimeMs)}` : st.label.toLowerCase()}
          {box.keepAlive && <span className="text-yard-300"> · keep-alive</span>}
        </div>
      </div>

      <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-3 @2xl:contents">
        <div className="flex shrink-0 items-center gap-1.5 @2xl:flex-col @2xl:items-stretch @2xl:gap-1" title={`${box.runningTurns} of ${box.slots} agent slots busy`}>
          <span className={cx("tabular-nums", over ? "font-medium text-amber-300" : box.runningTurns ? "text-zinc-200" : "text-zinc-500")}>
            {box.runningTurns}/{box.slots}
            <span className="@2xl:hidden"> agents</span>
          </span>
          <Meter used={box.runningTurns} total={box.slots} label="Agents busy" className="w-8 @2xl:w-full" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 @2xl:flex-col @2xl:items-stretch @2xl:gap-1" title={rowDiskTitle(box)}>
          <span className={cx("whitespace-nowrap tabular-nums", TONE_TEXT[tone])}>{disk ? `${formatBytes(disk.free)} free` : "disk —"}</span>
          {disk && <Meter used={disk.used} total={disk.total} tone={tone} label="Disk used" className="w-8 @2xl:w-full" />}
        </div>
        <div className="hidden min-w-0 items-center gap-1 @2xl:flex">
          {box.projects.length === 0 ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <>
              <span className="truncate rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-zinc-300" title={box.projects.join(", ")}>
                {box.projects[0]}
              </span>
              {box.projects.length > 1 && (
                <span className="shrink-0 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-zinc-400" title={box.projects.join(", ")}>
                  +{box.projects.length - 1}
                </span>
              )}
            </>
          )}
        </div>
        <RunningNow now={now} />
      </div>

      <div className="col-start-2 row-start-1 flex justify-end @2xl:col-start-6">
        <BoxMenu box={box} tasks={tasks} onOpen={() => onOpen(box.id)} onAction={(kind) => onAction(box.id, kind)} />
      </div>
    </div>
  )
}

/** One icon for everything wrong with a box; the reasons are in its tooltip and in the details. */
function AttentionIcon({ reasons }: { reasons: AttentionReason[] }) {
  if (!reasons.length) return null
  const error = reasons.some((r) => r.level === "error")
  const text = reasons.map((r) => r.short).join("\n")
  return (
    <span role="img" aria-label={`Needs attention: ${reasons.map((r) => r.short).join("; ")}`} title={text} data-testid="box-attention" className="shrink-0">
      <AlertTriangle className={cx("h-3.5 w-3.5", error ? "text-red-400" : "text-amber-300")} />
    </span>
  )
}

function RunningNow({ now }: { now: ReturnType<typeof nowRunning> }) {
  if (!now) return <span className="min-w-0 truncate text-zinc-600">idle</span>
  const s = STATUS[now.task.status]
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
        <Link href={`/tasks/${now.task.id}`} className="truncate text-zinc-200 hover:underline" title={`${now.task.title} · ${s.label}`}>
          {now.task.title}
        </Link>
        {now.more > 0 && <span className="shrink-0 text-zinc-500">+{now.more}</span>}
      </div>
      <div className="mt-0.5 hidden truncate pl-3 text-[11px] text-zinc-500 @2xl:block">{s.label}</div>
    </div>
  )
}

/** ⋯ on a row: details, Clean up now, and a shortcut to each active task and preview. */
function BoxMenu({ box, tasks, onOpen, onAction }: { box: BoxInfo; tasks: Task[]; onOpen: () => void; onAction: (kind: BoxAction) => void }) {
  const { open, setOpen, root, trigger } = usePopover()
  const clean = useCleanBox()
  const panel = useRef<HTMLDivElement>(null)
  const { active } = splitBoxTasks(tasks)
  const previews = tasks.flatMap((t) => t.previews.map((p) => ({ ...p, taskTitle: t.title })))
  const cleaning = box.cleanup?.status === "running" || clean.isPending
  const busy = boxBusyReason(box)
  const act = (kind: BoxAction) => {
    setOpen(false)
    onAction(kind)
  }
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("button, a")?.focus()
  }, [open])
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Actions for ${box.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        className="grid h-11 w-11 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 @2xl:h-7 @2xl:w-7"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div ref={panel} role="menu" className="absolute top-full right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 text-sm shadow-2xl">
          <button
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setOpen(false)
              onOpen()
            }}
          >
            <PanelTopOpen className="h-4 w-4 text-zinc-500" /> Details
          </button>
          {box.status === "ready" && (
            <>
              <button role="menuitem" className={cx(menuItem, "disabled:opacity-50")} disabled={cleaning || Boolean(busy)} title={busy ?? undefined} onClick={() => clean.mutate(box.id, { onSettled: () => setOpen(false) })}>
                <Sparkles className="h-4 w-4 text-zinc-500" /> {cleaning ? "Cleaning up…" : "Clean up now"}
              </button>
              <button role="menuitem" className={cx(menuItem, "disabled:opacity-50")} disabled={Boolean(busy)} title={busy ?? "Archive every workspace and remove it; keep the box"} onClick={() => act("clear")}>
                <Eraser className="h-4 w-4 text-zinc-500" /> Clear box…
              </button>
              <button role="menuitem" className={cx(menuItem, "disabled:opacity-50")} disabled={Boolean(busy)} title={busy ?? `Move this ${box.size} box to another size, up or down`} onClick={() => act("resize")}>
                <Maximize2 className="h-4 w-4 text-zinc-500" /> Resize…
              </button>
            </>
          )}
          <button
            role="menuitem"
            className={cx(menuItemBase, "text-red-300 hover:bg-red-500/10 hover:text-red-200 focus-visible:bg-red-500/10 disabled:opacity-50")}
            disabled={Boolean(busy)}
            title={busy ?? "Archive every workspace, then destroy the box"}
            onClick={() => act("delete")}
          >
            <Trash2 className="h-4 w-4" /> Delete box…
          </button>
          {active.length > 0 && <div className="mx-2 mt-1.5 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Open task</div>}
          {active.map((t) => (
            <Link key={t.id} role="menuitem" href={`/tasks/${t.id}`} className={menuItem} onClick={() => setOpen(false)}>
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[t.status].dot)} />
              <span className="truncate">{t.title}</span>
            </Link>
          ))}
          {previews.length > 0 && <div className="mx-2 mt-1.5 mb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Previews</div>}
          {previews.map((p) => (
            <NewTabLink key={`${p.port}-${p.url}`} role="menuitem" href={p.url} title={p.taskTitle} className={menuItem} onClick={() => setOpen(false)}>
              <Globe className="h-4 w-4 shrink-0 text-sky-400" />
              <span className="truncate">{p.label}</span>
              <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-zinc-500" />
            </NewTabLink>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- details modal

type DetailTab = "running" | "finished" | "disk" | "previews"

function BoxDetails({
  box,
  tasks,
  projectName,
  onClose,
  onAction,
}: {
  box: BoxInfo
  tasks: Task[]
  projectName: (id: string) => string
  onClose: () => void
  onAction: (boxId: string, kind: BoxAction) => void
}) {
  const busy = boxBusyReason(box)
  const st = BOX_STATUS[box.status]
  const attention = boxAttention(box)
  const { active, finished } = splitBoxTasks(tasks)
  const previews = tasks.flatMap((t) => t.previews.map((p) => ({ ...p, taskTitle: t.title })))
  const [tab, setTab] = useState<DetailTab>(() => (attention.some((r) => r.key === "disk" || r.key === "root" || r.key === "cleanup") ? "disk" : active.length || !finished.length ? "running" : "finished"))
  const tabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "running", label: "Running", count: active.length },
    { key: "finished", label: "Finished", count: finished.length },
    { key: "disk", label: "Disk & cleanup" },
    ...(previews.length ? [{ key: "previews" as const, label: "Previews", count: previews.length }] : []),
  ]
  return (
    <Modal
      onClose={onClose}
      size="xl"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{box.id}</span>
          <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", st.chip)}>{st.label}</span>
        </span>
      }
      description={
        <>
          {box.provider} · {box.size}
          {box.keepAlive && " · keep-alive"}
        </>
      }
      className="sm:h-[min(40rem,calc(100dvh-2rem))]"
      footer={
        <>
          {busy && <span className="mr-auto text-xs text-amber-300">{busy}…</span>}
          {box.status === "ready" && (
            <>
              <Button type="button" variant="ghost" disabled={Boolean(busy)} title={busy ?? `Move this ${box.size} box to another size, up or down`} onClick={() => onAction(box.id, "resize")}>
                <Maximize2 className="h-4 w-4" /> Resize…
              </Button>
              <Button type="button" variant="ghost" disabled={Boolean(busy)} title={busy ?? "Archive every workspace and remove it from the box; the box stays"} onClick={() => onAction(box.id, "clear")}>
                <Eraser className="h-4 w-4" /> Clear box…
              </Button>
            </>
          )}
          <Button type="button" variant="danger" disabled={Boolean(busy)} title={busy ?? "Archive every workspace, then destroy the box"} onClick={() => onAction(box.id, "delete")}>
            <Trash2 className="h-4 w-4" /> Delete box…
          </Button>
        </>
      }
    >
      {attention.length > 0 && (
        <ul className="space-y-1.5" data-testid="box-attention-list">
          {attention.map((r) => (
            <li key={r.key} className={cx("flex gap-2 rounded-lg px-3 py-2 text-xs", r.level === "error" ? "bg-red-500/10 text-red-200" : "bg-amber-500/10 text-amber-200")}>
              <AlertTriangle className={cx("mt-px h-3.5 w-3.5 shrink-0", r.level === "error" ? "text-red-400" : "text-amber-300")} />
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {box.resize && <ResizeStatus box={box} />}

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <Fact label="Agents busy">
          <span className={box.runningTurns > box.slots ? "text-amber-300" : undefined}>
            {box.runningTurns} of {box.slots}
          </span>
          <Meter used={box.runningTurns} total={box.slots} label="Agents busy" className="mt-1.5" />
        </Fact>
        <Fact label="Disk">
          <DiskSummary box={box} />
        </Fact>
        <Fact label="Projects">
          {box.projects.length ? (
            <div className="flex flex-wrap gap-1">
              {box.projects.map((p) => (
                <span key={p} className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-zinc-300">
                  {p}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-zinc-500">none</span>
          )}
        </Fact>
        <Fact label="Uptime">
          <BoxTimes createdAt={box.createdAt} lastUsedAt={box.lastUsedAt} />
        </Fact>
        <Fact label="Active hours">
          <span title="Estimated active CPU time tracked by Box Yard">{hours(box.activeMs)}</span>
        </Fact>
        <Fact label="Cost">
          <span title={box.usageSource === "actual" ? "Provider usage data was available." : "Estimated from Box Yard runtime and disk probes."}>
            {money(box.estimatedCostUsd)} <span className="text-zinc-500">{box.usageSource}</span>
          </span>
        </Fact>
      </dl>

      <div>
        <div role="tablist" aria-label="Box details" className="scroll-thin -mb-px flex gap-1 overflow-x-auto border-b border-zinc-800">
          {tabs.map((t) => {
            const on = t.key === tab
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.key)}
                className={cx(
                  "inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium whitespace-nowrap transition sm:min-h-9",
                  on ? "border-yard-500 text-zinc-50" : "border-transparent text-zinc-400 hover:text-zinc-200",
                )}
              >
                {t.label}
                {t.count !== undefined && <span className={cx("rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400")}>{t.count}</span>}
              </button>
            )
          })}
        </div>
        <div role="tabpanel" className="pt-3">
          {tab === "running" && <TaskList tasks={active} projectName={projectName} empty="No agents running on this box." />}
          {tab === "finished" && <TaskList tasks={finished} projectName={projectName} muted empty="No finished tasks on this box." />}
          {tab === "disk" && <DiskPanel box={box} />}
          {tab === "previews" && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {previews.map((p) => (
                <NewTabLink
                  key={`${p.port}-${p.url}`}
                  href={p.url}
                  title={p.taskTitle}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-sky-400 hover:border-sky-500/40 hover:text-sky-300 sm:min-h-0"
                >
                  <Globe className="h-3.5 w-3.5" /> {p.label}
                  <ExternalLink className="h-3 w-3" />
                </NewTabLink>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** The running resize (with its steps) or the last one, at the top of the details. */
function ResizeStatus({ box }: { box: BoxInfo }) {
  const r = box.resize!
  const tone = r.status === "failed" ? "border-red-500/30 bg-red-500/10 text-red-200" : r.status === "running" ? "border-sky-500/30 bg-sky-500/10 text-sky-100" : "border-zinc-800/70 bg-zinc-900/40 text-zinc-300"
  return (
    <div className={cx("rounded-lg border px-3 py-2 text-xs", tone)} data-testid="resize-status">
      <div className="flex items-center gap-2">
        {r.status === "running" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Maximize2 className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1">
          {resizeLine(r, box.id)}
          <span className="opacity-60"> · {timeAgo(r.finishedAt ?? r.startedAt)}</span>
        </span>
      </div>
      {r.reason && <div className="mt-0.5 pl-5.5 opacity-80">Reason: {r.reason}</div>}
      {r.status === "running" && (
        <ol className="mt-1.5 space-y-0.5 pl-5.5">
          {r.steps.map((s) => (
            <li key={s.key} className={cx(s.status === "done" ? "text-emerald-300" : s.status === "running" ? "text-sky-200" : "opacity-60")}>
              {s.status === "done" ? "✓" : s.status === "running" ? "…" : "·"} {s.label}
              {s.detail && <span className="opacity-70"> · {s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2">
      <dt className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-zinc-200">{children}</dd>
    </div>
  )
}

function TaskList({ tasks, projectName, muted, empty }: { tasks: Task[]; projectName: (id: string) => string; muted?: boolean; empty: string }) {
  if (!tasks.length) return <p className="text-xs text-zinc-500">{empty}</p>
  return (
    <div className="divide-y divide-zinc-800/80 overflow-hidden rounded-lg border border-zinc-800/80">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} projectName={projectName(t.projectId)} muted={muted} />
      ))}
    </div>
  )
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(CAPACITY_NOTICE_KEY)
  } catch {
    return null
  }
}

/** One-time notice when per-box capacity is below the old defaults (2 agents, 12 resident folders). */
function CapacityNotice({ onEdit }: { onEdit: () => void }) {
  const settings = useAgentSettings()
  const [dismissed, setDismissed] = useState(readDismissed)
  const notice = settings.data ? capacityNotice(settings.data.settings) : null
  if (!showCapacityNotice(notice, dismissed)) return null
  const dismiss = () => {
    try {
      localStorage.setItem(CAPACITY_NOTICE_KEY, notice.key)
    } catch {}
    setDismissed(notice.key)
  }
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-100" data-testid="capacity-notice">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Each {notice.workerSize} box now {capacityNoticeText(notice)}.
        </div>
        <div className="mt-1 text-sky-200/70">
          Pool limits now default by worker size, so fewer agents share a box and older workspaces are parked sooner. Add boxes, pick a larger size or raise the limits if you
          want the old capacity back.{" "}
          <button onClick={onEdit} className="text-sky-300 underline-offset-2 hover:underline">
            Edit limits
          </button>
        </div>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" title="Dismiss" className="-m-1 h-7 w-7 shrink-0 rounded-md p-1 text-sky-300 hover:bg-sky-500/20">
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}

function TaskRow({ task, projectName, muted, note }: { task: Task; projectName: string; muted?: boolean; note?: string | null }) {
  return (
    <Link href={`/tasks/${task.id}`} className="group flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
      <div className="min-w-0 flex-1">
        <div className="sm:flex sm:items-baseline sm:gap-3">
          <div className={cx("truncate", muted ? "text-zinc-400" : "text-zinc-100")} title={task.title}>
            {task.title}
          </div>
          <div className="shrink-0 truncate text-xs text-zinc-500">{projectName}</div>
        </div>
        {note && (
          <div className="mt-0.5 flex items-start gap-1 text-xs text-amber-300/90" data-testid="wait-reason">
            <LineIcon icon={waitIconOf(task)} className="h-3 w-3" />
            <span className="line-clamp-2 min-w-0 wrap-anywhere sm:truncate" title={note}>
              {note}
            </span>
          </div>
        )}
      </div>
      <PrChip task={task} variant="link" className="hidden text-xs sm:inline-flex" />
      <StatusBadge status={badgeStatus(task)} />
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
    </Link>
  )
}

function BoxTimes({ createdAt, lastUsedAt }: { createdAt: number; lastUsedAt: number }) {
  const now = useNow(30_000)
  return (
    <span className="text-zinc-200">
      <span title={`Up since ${new Date(createdAt).toLocaleString()}`}>up {shortDuration(now - createdAt)}</span>
      <span className="block text-zinc-500" title={`Last active ${new Date(lastUsedAt).toLocaleString()}`}>
        active {timeAgo(lastUsedAt, now)}
      </span>
    </span>
  )
}

/** The current time, re-read every `ms` so relative labels stay true. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * Free and total space on the box's work disk (df), the same numbers pool_status and the low-disk
 * notice give, with when it was measured.
 */
function DiskSummary({ box }: { box: BoxInfo }) {
  const now = useNow(5_000)
  const disk = diskMeter(box)
  const root = rootMeter(box)
  const tone = diskTone(box)
  if (!disk)
    return (
      <span className="text-zinc-500" title="Free space is measured with df when Box Yard next places a task or checks the box." data-testid="disk-use">
        not measured yet
      </span>
    )
  return (
    <div data-testid="disk-use">
      <span className={TONE_TEXT[tone]}>{disk.label}</span>
      <Meter used={disk.used} total={disk.total} tone={tone} label="Disk used" className="mt-1.5" />
      {box.diskCheckedAt && (
        <div className="mt-1 text-[11px] text-zinc-500" title={new Date(box.diskCheckedAt).toLocaleString()}>
          {measuredAgo(box.diskCheckedAt, now)}
        </div>
      )}
      {root && (
        <div className={cx("mt-1 text-[11px]", root.low ? TONE_TEXT[rootTone(box)] : "text-zinc-500")} title={`Root disk (/tmp, home): ${root.label}`} data-testid="root-disk-use">
          root disk {formatBytes(root.free)} free
        </div>
      )}
    </div>
  )
}

/** The row's disk cell tooltip: the work disk, and the root disk when it's another one. */
function rowDiskTitle(box: BoxInfo): string {
  const disk = diskMeter(box)
  const root = rootMeter(box)
  const work = disk ? `${disk.label}${box.diskCheckedAt ? ` · ${measuredAgo(box.diskCheckedAt)}` : ""}` : "Free space not measured yet"
  return root ? `${work}\nRoot disk (/tmp, home): ${root.label}${root.low ? " · low" : ""}` : work
}

/**
 * Where the disk goes (df, with Box Yard's own folders from du split out) and the last cleanup step by step.
 * The folder total leaves out files the provider keeps on that disk, so it never matches df's "used".
 */
function DiskPanel({ box }: { box: BoxInfo }) {
  const now = useNow(5_000)
  const disk = diskMeter(box)
  const root = rootMeter(box)
  const tone = diskTone(box)
  const ours = disk && box.diskBytes !== null ? Math.min(box.diskBytes, disk.used) : null
  const parts = disk
    ? ours !== null
      ? [
          { label: "Box Yard's folders", bytes: ours, bar: "bg-yard-500", title: "Task workspaces and repo mirrors (du)" },
          { label: "Provider's own files", bytes: disk.used - ours, bar: "bg-zinc-500", title: "df's used minus Box Yard's folders" },
        ]
      : [{ label: "Used", bytes: disk.used, bar: "bg-zinc-500", title: "df on the box's work disk" }]
    : []
  return (
    <div className="space-y-4 text-xs">
      {disk ? (
        <div data-testid="disk-breakdown">
          <div className="flex items-baseline justify-between gap-3">
            <span>
              {root && <span className="text-zinc-500">Work disk · </span>}
              <span className={TONE_TEXT[tone]}>{disk.label}</span>
            </span>
            {box.diskCheckedAt && <span className="text-zinc-500">{measuredAgo(box.diskCheckedAt, now)}</span>}
          </div>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-sm bg-zinc-800" role="img" aria-label={`Disk: ${parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(", ")}, ${formatBytes(disk.free)} free`}>
            {parts.map((p) => (
              <div key={p.label} className={p.bar} style={{ width: `${(p.bytes / disk.total) * 100}%` }} title={`${p.label}: ${formatBytes(p.bytes)}`} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-zinc-400">
            {parts.map((p) => (
              <li key={p.label} className="flex items-center gap-1.5" title={p.title}>
                <span className={cx("h-2 w-2 rounded-sm", p.bar)} />
                {p.label} <span className="text-zinc-200 tabular-nums">{formatBytes(p.bytes)}</span>
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-zinc-800 ring-1 ring-zinc-700" />
              Free <span className={cx("tabular-nums", tone === "ok" ? "text-zinc-200" : TONE_TEXT[tone])}>{formatBytes(disk.free)}</span>
            </li>
          </ul>
        </div>
      ) : (
        <p className="text-zinc-500">Free space is measured with df when Box Yard next places a task or checks the box.</p>
      )}
      {root && <RootDisk box={box} root={root} />}
      <CleanupReport box={box} />
    </div>
  )
}

/** The root disk (/tmp, HOME) when it isn't the work disk: temp files land there. Why it's low is in the attention list above. */
function RootDisk({ box, root }: { box: BoxInfo; root: NonNullable<ReturnType<typeof rootMeter>> }) {
  const tone = rootTone(box)
  return (
    <div data-testid="root-disk">
      <span className="text-zinc-500">Root disk (/tmp, home) · </span>
      <span className={TONE_TEXT[tone]}>{root.label}</span>
      <Meter used={root.used} total={root.total} tone={tone} label="Root disk used" className="mt-2" />
    </div>
  )
}

function CleanUpButton({ box }: { box: BoxInfo }) {
  const clean = useCleanBox()
  const running = box.cleanup?.status === "running"
  const busy = running ? null : boxBusyReason(box)
  return (
    <Button
      size="sm"
      variant="subtle"
      loading={running || clean.isPending}
      disabled={Boolean(busy)}
      onClick={() => clean.mutate(box.id)}
      className="shrink-0"
      title={busy ?? "Free disk in safe steps: partial clones, caches, ignored build output of resting tasks, git gc. Done workspaces are parked only if the box is still low. Uncommitted work is never touched."}
    >
      {!running && !clean.isPending && <Sparkles className="h-3.5 w-3.5" />}
      {running ? (box.cleanup?.reason === "clear" ? "Clearing…" : "Cleaning up…") : "Clean up now"}
    </Button>
  )
}

/** The running cleanup, or the last one, with each step's result, and the Clean up now button. */
function CleanupReport({ box }: { box: BoxInfo }) {
  const cleanup: BoxCleanup | null = box.cleanup
  const when = !cleanup ? null : cleanup.status === "running" ? `started ${timeAgo(cleanup.startedAt)}` : timeAgo(cleanup.finishedAt ?? cleanup.startedAt)
  const tone = !cleanup
    ? "text-zinc-500"
    : cleanup.status === "failed" || (cleanup.status === "done" && cleanup.targetFreeBytes !== null && !cleanup.enough)
      ? "text-amber-300"
      : cleanup.status === "running"
        ? "text-sky-300"
        : "text-zinc-300"
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/30" data-testid="cleanup-report">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Last cleanup</div>
          <div className={cx("mt-0.5", tone)}>
            {cleanup ? cleanupLine(cleanup) : "No disk cleanup has run here yet."}
            {when && <span className="text-zinc-500"> · {when}</span>}
          </div>
          {cleanup && cleanup.freeBefore !== null && cleanup.freeAfter !== null && (
            <div className="mt-0.5 text-zinc-500">
              {formatBytes(cleanup.freeBefore)} → {formatBytes(cleanup.freeAfter)} free
            </div>
          )}
          {cleanup && typeof cleanup.rootFreeBefore === "number" && typeof cleanup.rootFreeAfter === "number" && (
            <div className="text-zinc-500" data-testid="cleanup-root">
              Root disk: {formatBytes(cleanup.rootFreeBefore)} → {formatBytes(cleanup.rootFreeAfter)} free
            </div>
          )}
        </div>
        {box.status === "ready" && <CleanUpButton box={box} />}
      </div>
      {cleanup && cleanup.steps.length > 0 && (
        <ol className="space-y-1 border-t border-zinc-800/70 px-3 py-2">
          {cleanup.steps.map((s, i) => (
            <li key={s.key} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
              <span className="text-right text-zinc-600 tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 text-zinc-400">
                {s.label}
                {s.removed.length > 0 && (
                  <span className="block truncate text-zinc-600" title={s.removed.join("\n")}>
                    {s.removed.join(", ")}
                  </span>
                )}
              </span>
              <span className={cx("col-start-2 tabular-nums sm:col-start-3 sm:text-right", s.freedBytes > 0 ? "text-emerald-300" : "text-zinc-500")}>
                {s.freedBytes > 0 ? `freed ${formatBytes(s.freedBytes)}` : (s.skipped ?? "freed nothing")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
