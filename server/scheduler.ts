import type { Config } from "./config.js"
import type { Store } from "./store.js"
import type { TaskManager } from "./tasks.js"
import type { Hub } from "./hub.js"
import { BadRequestError, NotFoundError } from "./store.js"
import { QStash } from "./qstash.js"
import { describeCron, expandCron, isValidTimeZone, nextRun, parseCron, CronError } from "../shared/cron.js"
import { errorMessage } from "./util/retry.js"
import type { CatchUp, Schedule, ScheduleRun, ScheduleTarget, Task, TaskStatus } from "../shared/types.js"
import { withOwner } from "../shared/owner.js"

/** A run that is still going blocks the next one unless overlap is allowed. */
const ACTIVE: TaskStatus[] = ["queued", "starting", "working", "waiting"]

/** QStash may deliver a little early; treat a run due this soon as due now. */
const EARLY_MS = 90_000

export interface ScheduleInput {
  id?: string
  /** Defaults to "project" when projectId is given, otherwise "orchestrator". */
  target?: ScheduleTarget
  /** Required for project schedules, must be absent for orchestrator ones. */
  projectId?: string | null
  name: string
  cron: string
  timezone?: string
  prompt: string
  enabled?: boolean
  catchUp?: CatchUp
  allowOverlap?: boolean
}

export type ScheduleUpdate = Partial<Omit<ScheduleInput, "id" | "projectId" | "target">>

/** What the scheduler needs from the orchestrator: take a queued run and deliver it when the chat is free. */
export interface ScheduleSink {
  enqueueScheduled(runId: string, notes?: string): void
}

export interface SchedulerDeps {
  config: Config
  store: Store
  tasks: TaskManager
  hub: Hub
  orchestrator?: ScheduleSink
  qstash?: QStash | null
  now?: () => number
}

/**
 * Runs schedules. Each due run of a project schedule creates an ordinary task
 * in the schedule's project, so it streams in the UI like any other task. A run
 * of an orchestrator schedule is a message injected into the orchestrator chat
 * (queued while the orchestrator is busy).
 *
 * The in-process timer always runs. When QStash is configured it also fires
 * each schedule over HTTP; both paths go through `claimRun`, so a run only
 * starts once. Runs missed while the server was down are caught up at most
 * once (or skipped, per schedule) when the timer next ticks.
 */
export class Scheduler {
  private readonly c: Config
  private readonly store: Store
  private readonly tasks: TaskManager
  private readonly hub: Hub
  private readonly orchestrator: ScheduleSink | null
  readonly qstash: QStash | null
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  /** Box Yard's own run notes, with the configured owner name. */
  private owned(text: string): string {
    return withOwner(text, this.tasks.owner?.())
  }

  constructor(deps: SchedulerDeps) {
    this.c = deps.config
    this.store = deps.store
    this.tasks = deps.tasks
    this.hub = deps.hub
    this.orchestrator = deps.orchestrator ?? null
    this.qstash = deps.qstash ?? null
    this.now = deps.now ?? Date.now
  }

  get mode(): "local" | "qstash" {
    return this.qstash ? "qstash" : "local"
  }

  /** How late a run can be and still count as on time rather than missed. */
  private get graceMs() {
    return Math.max(2 * this.c.schedulerTickMs, 2 * 60_000)
  }

  start() {
    // Fill in next runs that were never computed (e.g. a schedule re-enabled while we were down).
    for (const s of this.store.listSchedules()) {
      if (s.enabled && s.nextRunAt === null) this.store.updateSchedule(s.id, { nextRunAt: this.computeNext(s.cron, s.timezone, this.now()) })
    }
    this.tick()
    this.timer = setInterval(() => this.tick(), this.c.schedulerTickMs)
    this.timer.unref?.()
    if (this.qstash) void this.syncAllQStash()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ------------------------------------------------------------------ CRUD

  list(filter: { projectId?: string; target?: ScheduleTarget } = {}): Schedule[] {
    return this.store.listSchedules(filter)
  }

  async create(input: ScheduleInput): Promise<Schedule> {
    const target: ScheduleTarget = input.target ?? (input.projectId ? "project" : "orchestrator")
    let projectId: string | null = null
    if (target === "project") {
      if (!input.projectId) throw new BadRequestError("projectId is required for a project schedule")
      const project = this.store.getProject(input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      projectId = project.id
    } else if (input.projectId) {
      throw new BadRequestError("An orchestrator schedule has no project; leave projectId out or use a project schedule")
    }
    const name = input.name.trim()
    if (!name) throw new BadRequestError("name is required")
    if (!input.prompt.trim()) throw new BadRequestError("prompt is required")
    const timezone = this.checkTimezone(input.timezone ?? this.c.defaultTimezone)
    const cron = this.checkCron(input.cron)
    const enabled = input.enabled !== false
    const schedule = this.store.createSchedule({
      id: input.id,
      target,
      projectId,
      name,
      cron,
      timezone,
      prompt: input.prompt.trim(),
      enabled,
      catchUp: input.catchUp,
      allowOverlap: input.allowOverlap,
      nextRunAt: enabled ? this.computeNext(cron, timezone, this.now()) : null,
    })
    await this.syncQStash(schedule.id)
    return this.emit(schedule.id)
  }

  async update(ref: string, patch: ScheduleUpdate): Promise<Schedule> {
    const current = this.require(ref)
    const id = current.id
    const cron = patch.cron !== undefined ? this.checkCron(patch.cron) : current.cron
    const timezone = patch.timezone !== undefined ? this.checkTimezone(patch.timezone) : current.timezone
    const enabled = patch.enabled ?? current.enabled
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestError("name can't be empty")
    if (patch.prompt !== undefined && !patch.prompt.trim()) throw new BadRequestError("prompt can't be empty")
    const timingChanged = cron !== current.cron || timezone !== current.timezone || enabled !== current.enabled
    this.store.updateSchedule(id, {
      name: patch.name?.trim(),
      prompt: patch.prompt?.trim(),
      cron,
      timezone,
      enabled,
      catchUp: patch.catchUp,
      allowOverlap: patch.allowOverlap,
      // Re-plan from now, so re-enabling a paused schedule never replays old runs.
      nextRunAt: timingChanged ? (enabled ? this.computeNext(cron, timezone, this.now()) : null) : undefined,
      lastSkipReason: timingChanged ? null : undefined,
    })
    if (timingChanged) await this.syncQStash(id)
    return this.emit(id)
  }

  async remove(ref: string): Promise<void> {
    const s = this.require(ref)
    this.store.deleteSchedule(s.id)
    this.hub.broadcast({ type: "schedule.deleted", scheduleId: s.id })
    if (this.qstash && s.qstashId) {
      await this.qstash.deleteSchedule(s.qstashId).catch((err) => console.warn(`[scheduler] couldn't delete QStash schedule ${s.qstashId}: ${errorMessage(err)}`))
    }
  }

  /** Start a run right away, whatever the cron says. Doesn't move the next planned run. */
  runNow(ref: string): Task | ScheduleRun {
    const s = this.require(ref)
    return this.startRun(s, { reason: "manual" })
  }

  /** The run history of a schedule, newest first: tasks for a project schedule, chat runs for an orchestrator one. */
  runs(ref: string, limit = 50): (Task | ScheduleRun)[] {
    const s = this.require(ref)
    const id = s.id
    if (s.target === "orchestrator") return this.store.listScheduleRuns({ scheduleId: id, limit })
    return this.store
      .listTasks()
      .filter((t) => t.scheduleId === id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  // ------------------------------------------------------------------ firing

  /** Look for due schedules and run them. Safe to call any time. */
  tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const s of this.store.dueSchedules(now)) {
        try {
          this.handleDue(s, now)
        } catch (err) {
          console.error(`[scheduler] schedule ${s.id} failed to run:`, err)
          this.store.updateSchedule(s.id, { lastSkipReason: `Couldn't start a run: ${errorMessage(err)}` })
          this.emit(s.id)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * A QStash delivery for schedule `id`. Starts the due run if the local timer
   * hasn't already; otherwise does nothing. Returns what happened.
   */
  fireFromQStash(id: string): "started" | "skipped" | "not-due" | "gone" {
    const s = this.store.getSchedule(id)
    if (!s || !s.enabled || s.nextRunAt === null) return "gone"
    const now = this.now()
    if (s.nextRunAt > now + EARLY_MS) return "not-due"
    return this.handleDue(s, now) ? "started" : "skipped"
  }

  /** Claim the due run, then start it (or record why not). Returns true if a task started. */
  private handleDue(s: Schedule, now: number): boolean {
    const dueAt = s.nextRunAt!
    const from = Math.max(now, dueAt)
    const next = this.computeNext(s.cron, s.timezone, from)
    if (!this.store.claimRun(s.id, dueAt, next)) return false // someone else got it

    const late = now - dueAt > this.graceMs
    const missed = late ? this.countMissed(s, dueAt, now) : 0

    if (late && s.catchUp === "skip") {
      this.skip(s, `Skipped ${plural(missed, "missed run")} while Box Yard was offline.`)
      return false
    }
    if (!s.allowOverlap && s.target === "orchestrator") {
      if (this.store.listScheduleRuns({ scheduleId: s.id, status: ["queued", "running"], limit: 1 }).length) {
        this.skip(s, `Skipped the ${fmtTime(dueAt, s.timezone)} run: the previous scheduled prompt is still queued or running.`)
        return false
      }
    } else if (!s.allowOverlap && s.lastTaskId) {
      const last = this.store.getTask(s.lastTaskId)
      if (last && ACTIVE.includes(last.status)) {
        this.skip(s, `Skipped the ${fmtTime(dueAt, s.timezone)} run: the previous run is still going.`)
        return false
      }
    }
    this.startRun(s, { reason: late ? "catch-up" : "scheduled", dueAt, missed })
    return true
  }

  private skip(s: Schedule, reason: string) {
    this.store.updateSchedule(s.id, { lastSkipReason: reason })
    this.emit(s.id)
  }

  private startRun(s: Schedule, opts: { reason: "scheduled" | "manual" | "catch-up"; dueAt?: number; missed?: number }): Task | ScheduleRun {
    const at = opts.dueAt ?? this.now()
    const runNumber = s.runCount + 1
    if (s.target === "orchestrator") return this.startOrchestratorRun(s, opts.reason, at, runNumber, opts.missed)
    const projectId = s.projectId!
    const previous = s.lastTaskId ? this.store.getTask(s.lastTaskId) : null
    const lines = [
      s.prompt,
      "",
      "---",
      `This task is run #${runNumber} of the Box Yard schedule "${s.name}" (${describeCron(s.cron).toLowerCase()}, ${s.timezone}), ` +
        `for ${fmtTime(at, s.timezone)}.`,
    ]
    if (opts.reason === "manual") lines.push(this.owned("Cody started this run by hand."))
    if (opts.reason === "catch-up") {
      lines.push(
        `Box Yard was offline at the planned time${opts.missed && opts.missed > 1 ? ` and missed ${opts.missed} runs` : ""}; this one run catches up.`,
      )
    }
    if (previous) {
      lines.push(
        `The previous run was task ${previous.id} ("${previous.title}"), which ended as ${previous.status}.` +
          (previous.summary ? ` Its summary: ${previous.summary}` : ""),
      )
    }
    lines.push(
      "Do this run's work, then call mark_done. Save anything later runs should know with save_note.",
      this.owned(
        'If this run found nothing to do and changed nothing (no commits, pull request, artifact, preview or question for Cody), call mark_done with outcome "noop" and a one-line summary, e.g. "No open PRs, nothing to merge". ' +
        "Box Yard then files it as a quiet run and doesn't notify anyone. Don't use noop if anything failed or needs Cody.",
      ),
    )

    const task = this.tasks.createTask({
      projectId,
      title: `${s.name} · ${fmtTime(at, s.timezone, true)}`,
      prompt: lines.join("\n"),
      scheduleId: s.id,
    })
    this.store.updateSchedule(s.id, {
      lastRunAt: this.now(),
      lastTaskId: task.id,
      runCount: runNumber,
      lastSkipReason: null,
    })
    this.emit(s.id)
    const project = this.store.getProject(projectId)
    this.tasks.notice(
      `Schedule "${s.name}"${project ? ` in ${project.name}` : ""} started ${opts.reason === "catch-up" ? "a catch-up run" : "a run"}: task ${task.id}.`,
      { scheduleId: s.id, taskId: task.id },
    )
    return task
  }

  /** Queue the schedule's prompt for the orchestrator chat; it is delivered when the orchestrator is free. */
  private startOrchestratorRun(s: Schedule, reason: "scheduled" | "manual" | "catch-up", at: number, runNumber: number, missed?: number): ScheduleRun {
    if (!this.orchestrator) throw new BadRequestError("The orchestrator isn't available to run this schedule")
    const parts = [`[Scheduled: ${s.name}] ${s.prompt}`]
    const notes = [`Run #${runNumber} of the schedule "${s.name}" (${describeCron(s.cron).toLowerCase()}, ${s.timezone}), for ${fmtTime(at, s.timezone)}.`]
    if (reason === "manual") notes.push(this.owned("Cody started this run by hand."))
    if (reason === "catch-up") notes.push(`Box Yard was offline at the planned time${missed && missed > 1 ? ` and missed ${missed} runs` : ""}; this one run catches up.`)
    const run = this.store.createScheduleRun({ scheduleId: s.id, prompt: parts[0]!, reason, dueAt: at })
    // The notes go to the model only (the chat shows just the labeled prompt).
    this.store.updateSchedule(s.id, { lastRunAt: this.now(), runCount: runNumber, lastSkipReason: null })
    this.emit(s.id)
    this.hub.broadcast({ type: "schedule.run", run })
    this.orchestrator.enqueueScheduled(run.id, notes.join(" "))
    return run
  }

  private countMissed(s: Schedule, dueAt: number, now: number): number {
    let n = 0
    let t: number | null = dueAt
    const c = parseCron(s.cron)
    while (t !== null && t <= now && n < 1000) {
      n++
      t = nextRun(c, t, s.timezone)
    }
    return n
  }

  // ------------------------------------------------------------------ QStash

  /** The URL QStash calls for a schedule. */
  qstashUrl(id: string) {
    return `${this.c.publicUrl.replace(/\/$/, "")}/qstash/schedules/${id}`
  }

  private async syncQStash(id: string) {
    if (!this.qstash) return
    const s = this.store.getSchedule(id)
    if (!s) return
    try {
      if (!s.enabled) {
        if (s.qstashId) await this.qstash.deleteSchedule(s.qstashId)
        this.store.updateSchedule(id, { qstashId: null })
        return
      }
      const qstashId = await this.qstash.upsertSchedule({
        id: `boxyard-${s.id}`,
        destination: this.qstashUrl(s.id),
        cron: expandCron(s.cron),
        timezone: s.timezone,
        body: JSON.stringify({ scheduleId: s.id }),
      })
      this.store.updateSchedule(id, { qstashId })
    } catch (err) {
      // The local timer still runs it, so this is a warning, not a failure.
      console.warn(`[scheduler] couldn't sync schedule ${id} to QStash: ${errorMessage(err)}`)
    }
  }

  private async syncAllQStash() {
    for (const s of this.store.listSchedules()) {
      if (s.enabled !== Boolean(s.qstashId)) await this.syncQStash(s.id)
    }
  }

  // ------------------------------------------------------------------ helpers

  private computeNext(cron: string, tz: string, after: number): number | null {
    return nextRun(cron, after, tz)
  }

  private checkCron(cron: string): string {
    try {
      const c = parseCron(cron)
      if (nextRun(c, this.now(), "UTC") === null) throw new CronError(`"${cron}" never runs`)
      return c.source
    } catch (err) {
      throw new BadRequestError(errorMessage(err))
    }
  }

  private checkTimezone(tz: string): string {
    const t = tz.trim() || "UTC"
    if (!isValidTimeZone(t)) throw new BadRequestError(`Unknown time zone "${tz}". Use an IANA name like America/New_York.`)
    return t
  }

  require(id: string): Schedule {
    const s = this.store.getSchedule(id) ?? this.store.findSchedule(id)
    if (!s) throw new NotFoundError(`Schedule ${id} not found`)
    return s
  }

  private emit(id: string): Schedule {
    const s = this.store.getSchedule(id)!
    this.hub.broadcast({ type: "schedule", schedule: s })
    return s
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function fmtTime(ts: number, tz: string, short = false) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(short ? {} : { year: "numeric", timeZoneName: "short" }),
  }).format(ts)
}
