import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { AlarmClock, Bot, ChevronDown, ChevronRight, Pause, Play, Plus, Trash2, Zap } from "lucide-react"
import {
  newClientId,
  useCreateSchedule,
  useDeleteSchedule,
  useProjects,
  useRunSchedule,
  useScheduleRuns,
  useSchedules,
  useSettings,
  useTaskMessages,
  useTasks,
  useUpdateSchedule,
} from "../lib/queries"
import { useScrollToHash } from "../lib/hash"
import { describeCron, isValidTimeZone, nextRuns, parseCron } from "../../../shared/cron"
import { Button, Empty, Field, StatusBadge, TimeAgo, cx, inputClass } from "./ui"
import type { CatchUp, Schedule, ScheduleRun, ScheduleTarget, Task } from "../../../shared/types"

const PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
  { label: "Monthly 1st", cron: "0 8 1 * *" },
]

const ACTIVE = new Set(["queued", "starting", "working", "waiting"])

/** The Schedules page: every schedule in every project. */
export function SchedulesView() {
  const schedules = useSchedules()
  const projects = useProjects()
  const settings = useSettings()
  const [creating, setCreating] = useState(false)
  const list = schedules.data ?? []
  useScrollToHash(Boolean(schedules.data))
  const orchestratorList = list.filter((s) => s.target === "orchestrator")
  const groups = (projects.data ?? [])
    .map((project) => ({ project, schedules: list.filter((s) => s.target === "project" && s.projectId === project.id) }))
    .filter((g) => g.schedules.length > 0)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-50">
            <AlarmClock className="h-6 w-6 text-yard-400" /> Schedules
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Recurring jobs. A project schedule starts a fresh task in its project each run, which you can watch live like any task. An orchestrator schedule
            sends its prompt to the orchestrator chat, for cross-project work like digests and reminders.
            {settings.data && (
              <span className="ml-1">
                Triggered by {settings.data.scheduler === "qstash" ? "Upstash QStash and the server's own timer" : "the server's own timer"}.
              </span>
            )}
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New schedule
        </Button>
      </header>

      {creating && <ScheduleForm onDone={() => setCreating(false)} />}

      {schedules.isLoading ? null : list.length === 0 ? (
        <Empty icon={<AlarmClock className="h-8 w-8" />} title="No schedules yet">
          Create one here, or tell the orchestrator something like "every morning, summarize open PRs across all repos".
        </Empty>
      ) : (
        <div className="space-y-6">
          {orchestratorList.length > 0 && (
            <ScheduleGroup title="Orchestrator" icon={<Bot className="h-4 w-4" />} schedules={orchestratorList} />
          )}
          {groups.map((g) => (
            <ScheduleGroup key={g.project.id} title={g.project.name} href={`/projects/${g.project.id}?tab=schedules`} schedules={g.schedules} />
          ))}
        </div>
      )}
    </div>
  )
}

function ScheduleGroup({ title, href, icon, schedules }: { title: string; href?: string; icon?: React.ReactNode; schedules: Schedule[] }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-300">
        {icon}
        {href ? (
          <Link href={href} className="hover:text-zinc-100">
            {title}
          </Link>
        ) : (
          title
        )}
        <span className="text-xs font-normal text-zinc-600">{schedules.length}</span>
      </h2>
      <div className="space-y-3">
        {schedules.map((s) => (
          <ScheduleCard key={s.id} schedule={s} />
        ))}
      </div>
    </section>
  )
}

/** The Schedules tab on a project page. */
export function ProjectSchedules({ projectId }: { projectId: string }) {
  const schedules = useSchedules()
  const [creating, setCreating] = useState(false)
  const list = (schedules.data ?? []).filter((s) => s.target === "project" && s.projectId === projectId)
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">Each run starts a fresh task in this project. Watch it live like any task.</p>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        )}
      </div>
      {creating && <ScheduleForm projectId={projectId} onDone={() => setCreating(false)} />}
      {schedules.isLoading ? null : list.length === 0 && !creating ? (
        <Empty icon={<AlarmClock className="h-8 w-8" />} title="No schedules yet">
          Run a task on a timer: nightly reports, weekly dependency bumps, hourly checks.
        </Empty>
      ) : (
        <div className="space-y-3">
          {list.map((s) => (
            <ScheduleCard key={s.id} schedule={s} />
          ))}
        </div>
      )}
    </section>
  )
}

function ScheduleCard({ schedule: s }: { schedule: Schedule }) {
  const tasks = useTasks()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()
  const [open, setOpen] = useState(false)
  const allRuns = useScheduleRuns()
  const orchestrator = s.target === "orchestrator"
  const runs = (tasks.data ?? []).filter((t) => t.scheduleId === s.id).sort((a, b) => b.createdAt - a.createdAt)
  const chatRuns = (allRuns.data ?? []).filter((r) => r.scheduleId === s.id).sort((a, b) => b.createdAt - a.createdAt)
  const latest = orchestrator ? chatRuns[0] : runs[0]
  const live = !orchestrator && runs[0] && ACTIVE.has(runs[0].status) ? runs[0] : null
  const chatLive = orchestrator && chatRuns[0] && (chatRuns[0].status === "queued" || chatRuns[0].status === "running") ? chatRuns[0] : null

  return (
    <div id={s.id} className={cx("rounded-xl border bg-zinc-900/40 p-4", live || chatLive ? "border-sky-500/40" : "border-zinc-800/80")}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-zinc-100">{s.name}</span>
            {!s.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 uppercase">Paused</span>}
            {chatLive && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {chatLive.status === "queued" ? "Queued in chat" : "Running in chat"}
              </span>
            )}
            {live && (
              <Link href={`/tasks/${live.id}`} className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-500/20">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> Running now
              </Link>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span className="text-zinc-300">{describeCron(s.cron)}</span>
            <code className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">{s.cron}</code>
            <span>{s.timezone}</span>
            {s.enabled && s.nextRunAt && (
              <span title={new Date(s.nextRunAt).toLocaleString()}>
                next <TimeUntil ts={s.nextRunAt} />
              </span>
            )}
            {s.runCount > 0 && <span>{s.runCount} {s.runCount === 1 ? "run" : "runs"}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="subtle" onClick={() => run.mutate(s.id)} title="Start a run now">
            <Zap className="h-3.5 w-3.5" /> Run now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: s.id, enabled: !s.enabled })} title={s.enabled ? "Pause" : "Resume"}>
            {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Delete schedule"
            onClick={() => {
              if (confirm(`Delete the schedule "${s.name}"? Past runs stay.`)) remove.mutate(s.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {s.lastSkipReason && <p className="mt-2 text-xs text-amber-300/80">{s.lastSkipReason}</p>}

      {live && <LiveTail task={live} />}

      <button onClick={() => setOpen((v) => !v)} className="mt-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? "Hide" : "Show"} prompt and runs
        {latest && !open && (
          <span className="ml-2 text-zinc-600">
            · last run <TimeAgo ts={latest.createdAt} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-300">{s.prompt}</div>
          <div className="text-xs text-zinc-500">
            Missed runs: {s.catchUp === "once" ? "catch up once" : "skip"} · Overlap: {s.allowOverlap ? "allowed" : orchestrator ? "skip if the last prompt is still queued or running" : "skip if the last run is still going"}
          </div>
          {orchestrator ? <ChatRunList runs={chatRuns} /> : <RunList runs={runs} />}
        </div>
      )}
    </div>
  )
}

/** Runs of an orchestrator schedule: each links to the chat message it injected. */
function ChatRunList({ runs }: { runs: ScheduleRun[] }) {
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  const tone: Record<ScheduleRun["status"], string> = {
    queued: "bg-zinc-800 text-zinc-300",
    running: "bg-sky-500/15 text-sky-300",
    done: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-red-500/15 text-red-300",
  }
  return (
    <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
      {runs.slice(0, 15).map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-zinc-200">
            {new Date(r.dueAt).toLocaleString()}
            {r.reason !== "scheduled" && <span className="ml-2 text-xs text-zinc-500">({r.reason})</span>}
            {r.error && <span className="ml-2 text-xs text-red-300/80">{r.error}</span>}
          </span>
          <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", tone[r.status])}>{r.status}</span>
          {r.chatMessageId ? (
            <button
              className="text-xs text-sky-400 hover:text-sky-300"
              onClick={() => document.getElementById(`chat-${r.chatMessageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
            >
              View in chat
            </button>
          ) : (
            <span className="text-xs text-zinc-600">waiting</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The last few lines of a run that is going right now, updated live. */
function LiveTail({ task }: { task: Task }) {
  const messages = useTaskMessages(task.id)
  const tail = (messages.data ?? []).filter((m) => m.role === "assistant" || m.role === "tool" || m.role === "event").slice(-4)
  return (
    <Link href={`/tasks/${task.id}`} className="mt-3 block space-y-1 rounded-lg border border-zinc-800/80 bg-zinc-950 px-3 py-2 hover:border-zinc-700">
      {tail.length === 0 && <div className="text-xs text-zinc-500">{task.status === "queued" ? "Waiting for a box slot…" : "Preparing the box…"}</div>}
      {tail.map((m) =>
        m.role === "assistant" ? (
          <div key={m.id} className="flex gap-2 text-xs text-zinc-300">
            <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="line-clamp-2">{m.content}</span>
          </div>
        ) : (
          <div key={m.id} className="truncate pl-5 font-mono text-[11px] text-zinc-600">
            › {m.content}
          </div>
        ),
      )}
      <div className="pt-0.5 text-[11px] text-sky-400">Open the live transcript →</div>
    </Link>
  )
}

function RunList({ runs }: { runs: Task[] }) {
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  return (
    <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
      {runs.slice(0, 15).map((t) => (
        <li key={t.id}>
          <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
            <span className="min-w-0 flex-1 truncate text-zinc-200">{t.summary ?? t.title}</span>
            <StatusBadge status={t.status} />
            <span className="w-16 shrink-0 text-right text-xs text-zinc-500">
              <TimeAgo ts={t.createdAt} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function ScheduleForm({ projectId, onDone }: { projectId?: string; onDone: () => void }) {
  const projects = useProjects()
  const settings = useSettings()
  const create = useCreateSchedule()
  const [target, setTarget] = useState<ScheduleTarget>("project")
  const [project, setProject] = useState(projectId ?? projects.data?.[0]?.id ?? "")
  const [name, setName] = useState("")
  const [cron, setCron] = useState("0 9 * * 1-5")
  const [timezone, setTimezone] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [catchUp, setCatchUp] = useState<CatchUp>("once")
  const [allowOverlap, setAllowOverlap] = useState(false)
  const tz = timezone ?? settings.data?.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone")
    } catch {
      return []
    }
  }, [])

  const preview = useMemo(() => {
    try {
      if (!isValidTimeZone(tz)) return { error: `Unknown time zone "${tz}"` }
      parseCron(cron)
      const next = nextRuns(cron, Date.now(), tz, 3)
      if (!next.length) return { error: "This never runs." }
      return { description: describeCron(cron), next }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }, [cron, tz])

  const fmt = (ts: number) =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts)
  const orchestrator = !projectId && target === "orchestrator"
  const valid = Boolean((orchestrator || project) && name.trim() && prompt.trim() && !preview.error)

  return (
    <form
      className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        create.mutate({ id: newClientId("sch"), target: orchestrator ? "orchestrator" : "project", projectId: orchestrator ? null : project, name: name.trim(), cron: cron.trim(), timezone: tz, prompt: prompt.trim(), catchUp, allowOverlap })
        onDone()
      }}
    >
      {!projectId && (
        <Field label="Target">
          <div className="flex gap-2">
            {(["project", "orchestrator"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTarget(t)}
                className={cx("rounded-md px-3 py-1 text-xs", target === t ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")}
              >
                {t === "project" ? "Project (starts a task)" : "Orchestrator (message in chat)"}
              </button>
            ))}
          </div>
        </Field>
      )}
      <div className={cx("grid gap-3", !projectId && !orchestrator && "sm:grid-cols-2")}>
        <Field label="Name">
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning issue triage" />
        </Field>
        {!projectId && !orchestrator && (
          <Field label="Project">
            <select className={inputClass} value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <Field label="When">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.cron}
              onClick={() => setCron(p.cron)}
              className={cx("rounded-md px-2 py-0.5 text-xs", cron === p.cron ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
          <input className={cx(inputClass, "font-mono")} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="min hour day month weekday" />
          <input className={inputClass} value={tz} onChange={(e) => setTimezone(e.target.value)} list="box-yard-zones" placeholder="Time zone" />
          <datalist id="box-yard-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <span className="mt-1.5 block text-xs">
          {preview.error ? (
            <span className="text-red-300">{preview.error}</span>
          ) : (
            <span className="text-zinc-400">
              {preview.description} · next: {preview.next!.map(fmt).join(", ")}
            </span>
          )}
        </span>
      </Field>

      <Field
        label={orchestrator ? "What should the orchestrator do each run?" : "What should the agent do each run?"}
        hint={
          orchestrator
            ? 'Each run posts "[Scheduled: name] <this prompt>" in the chat; it waits until the orchestrator is free.'
            : "Each run is a new task with this prompt, plus a note on how the previous run ended."
        }
      >
        <textarea className={inputClass} rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Look at issues opened since the last run, label them, and post a summary as an artifact." />
      </Field>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-400">
        <label className="flex items-center gap-2">
          Missed runs
          <select className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs" value={catchUp} onChange={(e) => setCatchUp(e.target.value as CatchUp)}>
            <option value="once">catch up once</option>
            <option value="skip">skip</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
          Start even if the last run is still going
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          Create schedule
        </Button>
      </div>
    </form>
  )
}

function TimeUntil({ ts }: { ts: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const s = Math.round((ts - Date.now()) / 1000)
  if (s < 60) return <>in under a minute</>
  const m = Math.round(s / 60)
  if (m < 60) return <>in {m}m</>
  const h = Math.round(m / 60)
  if (h < 48) return <>in {h}h</>
  return <>in {Math.round(h / 24)}d</>
}
