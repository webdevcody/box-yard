import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store, TaskRow, TurnFlags } from "./store.js"
import { BadRequestError, NotFoundError, cloneUrl, githubSlug, boxCost, normalizeBoxSize } from "./store.js"
import type { BoxProvider, BoxUsageProbe } from "./providers/types.js"
import { q } from "./providers/types.js"
import { EventReader, parseCursor, redisEventsKey, type Cursor, type WorkerEvent } from "./bus.js"
import type { Redis } from "./redis.js"
import type { Artifacts } from "./artifacts.js"
import { MAX_ARTIFACT_BYTES } from "./artifacts.js"
import {
  firstTurnPrompt,
  followupPrompt,
  recapPrompt,
  recapWorkspaceNote,
  workerSystemPrompt,
  type DirectoryEntry,
} from "./prompts.js"
import type { Uploads, StoredUpload } from "./uploads.js"
import { DEFAULT_EFFORT, RESTING_STATUSES, isFinalPrState, type Attachment, type BoxInfo, type Effort, type PrState, type PreviewLink, type Task, type TaskStatus } from "../shared/types.js"
import { autocompactFlag, type SettingsStore } from "./settings.js"
import { formatTokens } from "./usage.js"
import { errorMessage } from "./util/retry.js"
import { capReply, preview } from "./replies.js"
import { PrTracker, prNumber, type PrChange } from "./prs.js"
import { loadRouting, resolveDefaultRoute } from "./routing.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { isQuietRun, noopBlockers, type RunEvidence } from "../shared/quiet.js"

const RUNNER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/box-runner.mjs")
const RUNNER_FALLBACK = path.resolve(process.cwd(), "runner/box-runner.mjs")

/** Statuses a task can sit in between turns. */
const RESTING: TaskStatus[] = [...RESTING_STATUSES]
const PORT_BASE = 4000
const MAX_INTERRUPTS = 2
const STALL_MS = 45_000
const START_TIMEOUT_MS = 15 * 60_000
const BOX_RETRY_MS = 60_000
const AGENT_MSG_LIMIT = 20 // per sender, per 10 minutes
const BRANCH_MARK = "boxyard-branch="
/** Regenerable dirs left out of workspace archives, by name (tracked ones are checked out again on restore). */
const ARCHIVE_EXCLUDED_DIRS = ["node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", ".venv", "__pycache__", "target"]

export interface TaskManagerDeps {
  config: Config
  store: Store
  provider: BoxProvider
  hub: Hub
  redis: Redis | null
  artifacts: Artifacts
  settings: SettingsStore
  uploads: Uploads
}

/** What clients see of an upload: no server paths. */
const publicFiles = (files: StoredUpload[]): Attachment[] => files.map(({ id, name, size, mime }) => ({ id, name, size, mime }))

/** Who a queued task input is from. `captain:<projectId>` is that project's Captain. */
export type InputSource = "cody" | "orchestrator" | "system" | `agent:${string}` | `captain:${string}`
/** Task-message meta for a Captain's message, so the transcript can say which Captain steered the task. */
const captainMeta = (store: Store, projectId: string) => ({ source: "captain", captainProjectId: projectId, captainName: store.getProject(projectId)?.name ?? null })

/** kv key for the box a project's work goes to first. */
const projectBoxKey = (projectId: string) => `project_box:${projectId}`
/** kv key for the project a box was created for. */
const boxOwnerKey = (boxId: string) => `box_owner:${boxId}`

const usageFields = (u: unknown): { contextTokens?: number; contextWindow?: number } => {
  const x = u as { tokens?: unknown; window?: unknown } | null | undefined
  return {
    ...(typeof x?.tokens === "number" ? { contextTokens: x.tokens } : {}),
    ...(typeof x?.window === "number" ? { contextWindow: x.window } : {}),
  }
}

const usageObject = (u: unknown) => {
  const x = u as Record<string, unknown> | null | undefined
  if (!x) return null
  const out = {
    input_tokens: typeof x.input_tokens === "number" ? x.input_tokens : 0,
    cache_creation_input_tokens: typeof x.cache_creation_input_tokens === "number" ? x.cache_creation_input_tokens : 0,
    cache_read_input_tokens: typeof x.cache_read_input_tokens === "number" ? x.cache_read_input_tokens : 0,
    output_tokens: typeof x.output_tokens === "number" ? x.output_tokens : 0,
  }
  return Object.values(out).some((n) => n > 0) ? out : null
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "task"

/**
 * Runs every task: places it on a box from the pool, starts Claude turns,
 * reads the events workers send back, and moves work between boxes when one
 * disappears. All state lives in SQLite, so a restart picks up where it left off.
 */
export class TaskManager {
  private readonly c: Config
  private readonly store: Store
  private readonly provider: BoxProvider
  private readonly hub: Hub
  private readonly redis: Redis | null
  private readonly artifacts: Artifacts
  private readonly uploads: Uploads
  private readonly reader: EventReader
  private readonly settings: SettingsStore
  /** Polls GitHub for the state of every open PR. */
  readonly prs: PrTracker

  private timers: NodeJS.Timeout[] = []
  private scheduling = false
  private rescheduleWanted = false
  private polling = false
  private holds = new Map<string, AbortController>()
  private lastEventAt = new Map<string, number>()
  private pollFailures = new Map<string, number>()
  private stopRequested = new Set<string>()
  private creatingBoxes = 0
  /** Boxes being created, per project they're for. */
  private creatingFor = new Map<string, number>()
  /** Tasks that found no box this scheduling pass and want a new one. */
  private wantsBox = new Set<string>()
  private lastBoxError: { at: number; message: string } | null = null
  private agentMsgLog = new Map<string, number[]>()
  private archiving = new Set<string>()
  private lastRetentionAt = 0
  private directoryTimer: NodeJS.Timeout | null = null
  private stopped = false
  private lastBoxProbeAt = new Map<string, number>()
  private budgetNoticeAt = 0
  /** Called after every notice; return true when another owner handled delivery. */
  onNotice: ((content: string, meta: Record<string, unknown> | null) => boolean | void) | null = null

  constructor(deps: TaskManagerDeps) {
    this.c = deps.config
    this.store = deps.store
    this.provider = deps.provider
    this.hub = deps.hub
    this.redis = deps.redis
    this.artifacts = deps.artifacts
    this.settings = deps.settings
    this.uploads = deps.uploads
    this.reader = new EventReader(deps.provider, deps.redis)
    this.prs = new PrTracker({
      store: deps.store,
      token: (projectId) => (this.c.mock ? null : (this.store.projectEnv(projectId).GITHUB_TOKEN ?? this.c.githubToken) || null),
      onChange: (change) => this.prChanged(change),
      log: (msg) => console.warn(msg),
    })
    fs.mkdirSync(path.join(this.c.dataDir, "archives"), { recursive: true })
  }

  get busMode() {
    return this.reader.mode
  }

  get boxError() {
    return this.lastBoxError && Date.now() - this.lastBoxError.at < 10 * 60_000 ? this.lastBoxError.message : null
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    this.recover()
    this.timers.push(setInterval(() => void this.poll(), this.c.pollMs))
    this.timers.push(setInterval(() => void this.maintain(), 20_000))
    this.publishDirectory()
    void this.cleanupOrphanBoxes()
    this.prs.start()
    this.schedule()
  }

  stop() {
    this.stopped = true
    this.prs.stop()
    for (const t of this.timers) clearInterval(t)
    if (this.emitBoxesTimer) clearTimeout(this.emitBoxesTimer)
    if (this.directoryTimer) clearTimeout(this.directoryTimer)
    for (const h of this.holds.values()) h.abort()
    this.holds.clear()
  }

  /** After a restart: re-attach to running turns and requeue half-started ones. */
  private recover() {
    for (const row of this.store.listTaskRows({ status: ["starting"] })) {
      // We died while launching. Inputs are only deleted after a launch
      // succeeds, so the turn can simply run again (launch kills any
      // half-started runner first).
      this.store.updateTask(row.id, { status: "queued", currentTurnId: null })
    }
    for (const row of this.store.listTaskRows({ status: ["working"] })) {
      if (!row.box_id || !row.current_turn_id) {
        this.store.updateTask(row.id, { status: "queued", currentTurnId: null })
        continue
      }
      this.lastEventAt.set(row.id, Date.now())
      this.holdOpen(row.id, row.box_id)
    }
    for (const box of this.store.listBoxes()) {
      // A box that was mid-creation when we died may exist without us knowing its id.
      if (box.status === "creating") this.store.removeBox(box.id)
    }
  }

  private async cleanupOrphanBoxes() {
    if (!this.provider.listIds) return
    try {
      const label = this.installLabel()
      const known = new Set(this.store.listBoxes().map((b) => b.id))
      const ids = await this.provider.listIds(label)
      for (const id of ids) {
        if (!known.has(id)) {
          console.log(`[box-yard] deleting orphan box ${id}`)
          await this.provider.destroy(id).catch(() => {})
        }
      }
    } catch (err) {
      console.warn(`[box-yard] orphan cleanup skipped: ${errorMessage(err)}`)
    }
  }

  private installLabel() {
    let id = this.store.getKv("install_id")
    if (!id) {
      id = randomUUID().slice(0, 8)
      this.store.setKv("install_id", id)
    }
    return `by-${id}`
  }

  // ------------------------------------------------------------------ public API

  createTask(input: {
    id?: string
    projectId: string
    title: string
    prompt: string
    env?: Record<string, string>
    scheduleId?: string | null
    model?: string | null
    effort?: Effort | null
    routingRule?: string | null
    routingReason?: string | null
    attachments?: StoredUpload[]
    /** Who the attached files are from (a Captain labels them as its own). */
    source?: InputSource
  }): Task {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
    if (!input.title.trim()) throw new BadRequestError("title is required")
    if (!input.prompt.trim()) throw new BadRequestError("prompt is required")
    const route = this.initialRoute(project, input)
    const task = this.store.createTask({
      ...input,
      model: route.model,
      effort: route.effort,
      routingRule: route.routingRule,
      routingReason: route.routingReason,
      branch: project.repo ? `boxyard/${slugify(input.title)}-${randomUUID().slice(0, 4)}` : null,
    })
    const files = input.attachments ?? []
    this.store.addTaskMessage(task.id, "user", input.prompt, { kind: "task_prompt", ...(files.length ? { attachments: publicFiles(files) } : {}) })
    if (files.length) this.store.queueInput(task.id, input.source ?? "orchestrator", "These files go with the task:", files.map((f) => f.id))
    this.emitTask(task.id)
    this.publishDirectory()
    this.schedule()
    return this.store.getTask(task.id)!
  }

  sendInput(
    taskId: string,
    content: string,
    source: InputSource = "cody",
    attachments: StoredUpload[] = [],
    route?: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null } | null,
  ): Task {
    const row = this.requireRow(taskId)
    if (!content.trim() && !attachments.length) throw new BadRequestError("message is empty")
    // The files are copied into the box when the next turn starts, so this works while the agent is mid-turn.
    this.store.queueInput(row.id, source, content.trim() || "(no text)", attachments.map((f) => f.id))
    if (source === "cody" || source === "orchestrator" || source.startsWith("captain:")) {
      const from = source.startsWith("captain:") ? captainMeta(this.store, source.slice("captain:".length)) : { source }
      const msg = this.store.addTaskMessage(row.id, "user", content.trim(), { ...from, ...(attachments.length ? { attachments: publicFiles(attachments) } : {}) })
      this.hub.broadcast({ type: "task.message", message: msg })
    }
    const patch: Parameters<Store["updateTask"]>[1] = { lastActiveAt: Date.now() }
    if (route?.model) patch.model = route.model
    if (route?.effort) patch.effort = route.effort
    if (route?.routingRule !== undefined) patch.routingRule = route.routingRule
    if (route?.routingReason !== undefined) patch.routingReason = route.routingReason
    if (row.status === "needs_input" && source !== "system" && !source.startsWith("agent:")) patch.question = null
    if (!row.current_turn_id && RESTING.includes(row.status)) {
      patch.status = "queued"
      patch.error = null
    }
    this.store.updateTask(row.id, patch)
    if (source !== "system" && (route?.model || route?.effort)) {
      this.addEvent(row.id, `Routing updated for the next turn: ${this.routeLabel({ model: route.model ?? row.model, effort: route.effort ?? row.effort, routingRule: route.routingRule ?? row.routing_rule, routingReason: route.routingReason ?? row.routing_reason })}.`)
    }
    this.emitTask(row.id)
    this.schedule()
    return this.store.getTask(row.id)!
  }

  setTaskModel(taskId: string, route: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null }): Task {
    const row = this.requireRow(taskId)
    const patch: Parameters<Store["updateTask"]>[1] = {}
    if (route.model !== undefined) patch.model = route.model
    if (route.effort !== undefined) patch.effort = route.effort
    if (route.routingRule !== undefined) patch.routingRule = route.routingRule
    if (route.routingReason !== undefined) patch.routingReason = route.routingReason
    this.store.updateTask(row.id, patch)
    this.addEvent(row.id, `Routing updated for subsequent turns: ${this.routeLabel({ model: route.model ?? row.model, effort: route.effort ?? row.effort, routingRule: route.routingRule ?? row.routing_rule, routingReason: route.routingReason ?? row.routing_reason })}.`)
    this.emitTask(row.id)
    return this.store.getTask(row.id)!
  }

  async stopTask(taskId: string): Promise<Task> {
    const row = this.requireRow(taskId)
    if (row.current_turn_id && row.box_id) {
      this.stopRequested.add(row.id)
      if (row.status === "working") await this.killTurn(row).catch(() => {})
      // The runner writes turn_end after it stops; that settles the status.
    } else if (row.status === "queued" || row.status === "starting") {
      this.store.clearInputs(row.id)
      this.store.updateTask(row.id, { compactPending: false, status: row.turn_count > 0 ? "idle" : "failed", error: row.turn_count > 0 ? null : "Stopped before it started." }, { quiet: true })
    }
    this.addEvent(row.id, "Stopped by Cody.")
    this.emitTask(row.id)
    return this.store.getTask(row.id)!
  }

  /** Finish a task: stop it, archive it, free its box folder. */
  async closeTask(taskId: string): Promise<Task> {
    const row = this.requireRow(taskId)
    if (row.current_turn_id) await this.stopTask(taskId)
    this.store.clearInputs(row.id)
    this.store.updateTask(row.id, { status: "done", question: null }, { quiet: true })
    this.addEvent(row.id, "Closed. Its workspace was archived and its box slot freed.")
    this.emitTask(row.id)
    void this.evictWhenSettled(row.id)
    this.publishDirectory()
    return this.store.getTask(row.id)!
  }

  /**
   * Compact a task's Claude session. Runs as its own turn (`/compact` on the
   * resumed session), right away if the task is idle, or right after the
   * current turn if it is busy. Queued messages wait until it is done.
   */
  compactTask(taskId: string): Task {
    const row = this.requireRow(taskId)
    if (!row.session_started) throw new BadRequestError("This agent hasn't started its session yet, so there is nothing to compact.")
    if (row.compacting || row.compact_pending) return this.store.getTask(row.id)!
    if (row.status === "failed") throw new BadRequestError("The agent's last turn failed. Retry it before compacting.")
    this.store.updateTask(row.id, { compactPending: true })
    this.emitTask(row.id)
    this.schedule()
    return this.store.getTask(row.id)!
  }

  retryTask(taskId: string): Task {
    const row = this.requireRow(taskId)
    if (row.current_turn_id) throw new BadRequestError("Task is still running")
    return this.sendInput(
      row.id,
      row.turn_count === 0
        ? "Start the task."
        : `Your last turn ended with an error${row.error ? ` (${row.error.slice(0, 500)})` : ""}. Check where things stand and continue.`,
      "system",
    )
  }

  async deleteTask(taskId: string) {
    const row = this.requireRow(taskId)
    if (row.current_turn_id && row.box_id) await this.killTurn(row).catch(() => {})
    this.holds.get(row.id)?.abort()
    if (row.box_id) await this.removeTaskDir(row.box_id, row.id).catch(() => {})
    if (row.archive_path) {
      fs.rmSync(row.archive_path, { force: true })
      this.store.noteTaskArchiveUnavailable(row.id, row.archive_path, "archive deleted with task")
    }
    if (this.redis) await this.redis.cmd("DEL", redisEventsKey(row.id)).catch(() => {})
    this.store.deleteTask(row.id)
    this.hub.broadcast({ type: "task.deleted", taskId: row.id })
    this.publishDirectory()
    this.schedule()
  }

  async previewUrl(taskId: string, port: number): Promise<PreviewLink> {
    const row = this.requireRow(taskId)
    if (!row.box_id) throw new BadRequestError("Task has no box right now; send it a message to wake it up.")
    await this.provider.wake(row.box_id)
    const url = await this.provider.publicUrl(row.box_id, port)
    const link = { port, url, label: `Port ${port}` }
    this.upsertPreview(row.id, link)
    return link
  }

  /** Pool limits in effect now. Read fresh on every use, so saved changes apply without a restart. */
  limits() {
    const { maxBoxes, slotsPerBox, maxAgents, maxResidentPerBox, boxIdleDeleteMinutes } = this.settings.get()
    return { maxBoxes, slotsPerBox, maxAgents, maxResidentPerBox, boxIdleDeleteMinutes }
  }

  /** Agents (running turns) across all boxes. */
  runningTotal() {
    return this.store.listTaskRows().filter((r) => r.current_turn_id).length
  }

  poolLimits() {
    const l = this.limits()
    return {
      maxBoxes: l.maxBoxes,
      agentsPerBox: l.slotsPerBox,
      maxAgents: l.maxAgents,
      boxes: this.store.listBoxes().length,
      agentsRunning: this.runningTotal(),
    }
  }

  boxes(): BoxInfo[] {
    this.meterBoxes()
    const rates = this.settings.get().costRates
    const now = Date.now()
    return this.store.listBoxes().map((b) => {
      const residents = this.store.listTaskRows({ boxId: b.id })
      const size = normalizeBoxSize(b.size)
      const uptimeMs = Math.max(0, now - b.created_at)
      return {
        id: b.id,
        provider: b.provider,
        status: b.status,
        size,
        keepAlive: Boolean(b.keep_alive),
        slots: this.limits().slotsPerBox,
        runningTurns: residents.filter((r) => r.current_turn_id).length,
        residentTasks: residents.map((r) => r.id),
        projects: [...new Set(residents.map((r) => this.store.getProject(r.project_id)?.name ?? r.project_id))],
        activeMs: b.active_ms ?? 0,
        uptimeMs,
        diskBytes: b.disk_bytes ?? null,
        estimatedCostUsd: boxCost({ activeMs: b.active_ms ?? 0, uptimeMs, diskBytes: b.disk_bytes, size, keepAlive: Boolean(b.keep_alive) }, rates),
        usageSource: b.usage_source ?? "estimated",
        createdAt: b.created_at,
        lastUsedAt: b.last_used_at,
      }
    })
  }

  async destroyBox(boxId: string) {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    for (const row of this.store.listTaskRows({ boxId })) {
      if (row.current_turn_id) await this.killTurn(row).catch(() => {})
    }
    await this.loseBox(boxId, "Box deleted by Cody.")
    await this.provider.destroy(boxId).catch((err) => console.warn(`destroy ${boxId}: ${errorMessage(err)}`))
  }

  // ------------------------------------------------------------------ scheduler

  /** Ask the scheduler to run. Calls collapse while a pass is in progress. */
  schedule() {
    if (this.stopped) return
    if (this.scheduling) {
      this.rescheduleWanted = true
      return
    }
    this.scheduling = true
    void this.schedulePass()
      .catch((err) => console.error("[box-yard] scheduler error", err))
      .finally(() => {
        this.scheduling = false
        if (this.rescheduleWanted) {
          this.rescheduleWanted = false
          this.schedule()
        }
      })
  }

  private runningOn(boxId: string) {
    return this.store.listTaskRows({ boxId }).filter((r) => r.current_turn_id).length
  }

  private async schedulePass() {
    this.meterBoxes()
    if (this.budgetBlocked()) return
    const waiting = this.store
      .listTaskRows()
      .filter((r) => !r.current_turn_id && (r.status === "queued" || (r.status !== "failed" && (r.compact_pending || this.store.hasInputs(r.id)))))
      .filter((r) => r.status !== "starting" && r.status !== "working")
      .sort((a, b) => a.last_active_at - b.last_active_at)

    this.wantsBox.clear()
    for (const row of waiting) {
      // Over the total agent cap: wait without growing the pool. Running work is never stopped.
      const cap = this.limits().maxAgents
      const boxId = cap > 0 && this.runningTotal() >= cap ? null : await this.place(row)
      if (!boxId) {
        if (row.status !== "queued") {
          this.store.updateTask(row.id, { status: "queued" })
          this.emitTask(row.id)
        }
        continue
      }
      const turnId = randomUUID()
      // Reserve the slot before any await so parallel passes see it taken.
      this.store.updateTask(row.id, {
        status: "starting",
        boxId,
        currentTurnId: turnId,
        error: null,
        ...(row.compact_pending ? { compactPrevStatus: row.status } : {}),
      })
      this.store.touchBox(boxId)
      this.emitTask(row.id)
      void this.launch(row.id, boxId, turnId)
    }

    // Grow the pool: one new box per project per `slotsPerBox` tasks waiting for one.
    const perProject = new Map<string, number>()
    for (const row of waiting) {
      if (this.wantsBox.has(row.id)) perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1)
    }
    for (const [projectId, n] of perProject) {
      const need = Math.ceil(n / this.limits().slotsPerBox) - (this.creatingFor.get(projectId) ?? 0)
      for (let i = 0; i < need && this.poolHasRoom(); i++) void this.createBox(projectId)
    }
  }

  /** Pick a box for a task's next turn, or null to wait. */
  private async place(row: TaskRow): Promise<string | null> {
    if (row.box_id) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "ready") {
        if (this.runningOn(box.id) < this.limits().slotsPerBox) return box.id
        // Its box is busy. Move to a free box if the archive is fresh enough.
        if (!this.hasFreshArchive(row)) return null
        const other = this.pickBox(row.id, box.id)
        if (!other) return null
        const oldBox = box.id
        this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
        void this.removeTaskDir(oldBox, row.id).catch(() => {})
        this.addEvent(row.id, `Moved from busy box ${oldBox} to ${other}.`)
        return this.assign(row.id, other)
      }
      if (box?.status === "creating") return null
      // Box is gone or lost; the workspace comes back from the archive.
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    }
    const boxId = this.pickBox(row.id)
    return boxId ? this.assign(row.id, boxId) : null
  }

  /**
   * Pick a box for a task. A project keeps its work together, so the order is:
   * 1. a box that already hosts this project (warm repo mirror, shared files),
   * 2. an empty box,
   * 3. nothing yet, when the pool has room: a new box is made for the project,
   * 4. a free slot on a box another project uses (the pool is full).
   * Returns null to wait; `wantsBox` tells the scheduler to grow the pool.
   */
  private pickBox(taskId: string, exclude?: string): string | null {
    const row = this.store.getTaskRow(taskId)
    const projectId = row?.project_id
    const preferred = projectId ? this.store.getKv(projectBoxKey(projectId)) : null
    const candidates = this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && b.id !== exclude)
      .map((b) => {
        const residents = this.store.listTaskRows({ boxId: b.id }).filter((r) => r.id !== taskId)
        // A box made for a project belongs to it, even before its first task lands.
        const owner = this.store.getKv(boxOwnerKey(b.id))
        const mine = residents.some((r) => r.project_id === projectId) || b.id === preferred || owner === projectId
        const others = residents.some((r) => r.project_id !== projectId) || Boolean(owner && owner !== projectId)
        // 0 = this project's box, 1 = empty unowned box, 2 = another project's box
        const rank = mine ? 0 : others ? 2 : 1
        return { id: b.id, rank, running: residents.filter((r) => r.current_turn_id).length, residents: residents.length }
      })
      .filter((b) => b.running < this.limits().slotsPerBox)
      .sort((a, b) => a.rank - b.rank || a.running - b.running || a.residents - b.residents)
    for (const b of candidates) {
      if (b.rank === 2 && this.poolHasRoom()) {
        // Rather than crowd another project's box, make one for this project.
        this.wantsBox.add(taskId)
        return null
      }
      if (b.residents < this.limits().maxResidentPerBox || this.evictOne(b.id, taskId)) {
        this.wantsBox.delete(taskId)
        return b.id
      }
    }
    if (this.poolHasRoom()) this.wantsBox.add(taskId)
    return null
  }

  /** Room to create another box (and box creation isn't failing right now). */
  private poolHasRoom() {
    const recentlyFailed = this.lastBoxError && Date.now() - this.lastBoxError.at < BOX_RETRY_MS
    // listBoxes() includes the placeholders of boxes being created.
    return !recentlyFailed && this.store.listBoxes().length < this.limits().maxBoxes
  }

  /** Give a task a home on a box, with its own block of preview ports. */
  private assign(taskId: string, boxId: string): string {
    const used = new Set(
      this.store
        .listTaskRows({ boxId })
        .map((r) => r.port_base)
        .filter((p): p is number => p !== null),
    )
    let port = PORT_BASE
    while (used.has(port)) port += 10
    this.store.updateTask(taskId, { boxId, portBase: port })
    const projectId = this.store.getTaskRow(taskId)?.project_id
    if (projectId) this.store.setKv(projectBoxKey(projectId), boxId)
    return boxId
  }

  /** Free a folder on a full box by removing the least recently used, archived, resting task. */
  private evictOne(boxId: string, forTaskId: string): boolean {
    const victim = this.store
      .listTaskRows({ boxId })
      .filter(
        (r) =>
          r.id !== forTaskId &&
          !r.current_turn_id &&
          RESTING.includes(r.status) &&
          this.hasFreshArchive(r),
      )
      .sort((a, b) => a.last_active_at - b.last_active_at)[0]
    if (!victim) return false
    this.store.updateTask(victim.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(boxId, victim.id).catch(() => {})
    this.addEvent(victim.id, `Workspace parked in the archive to make room on box ${boxId}. It comes back on the next message.`)
    this.emitTask(victim.id)
    return true
  }

  private async createBox(projectId?: string) {
    this.creatingBoxes++
    if (projectId) this.creatingFor.set(projectId, (this.creatingFor.get(projectId) ?? 0) + 1)
    const placeholder = `creating-${randomUUID().slice(0, 8)}`
    this.store.upsertBox({ id: placeholder, provider: this.provider.name, status: "creating", created_at: Date.now(), last_used_at: Date.now(), size: this.settings.get().workerSize, keep_alive: 0, usage_source: "estimated" })
    this.emitBoxes()
    const project = projectId ? this.store.getProject(projectId) : null
    try {
      const labels = ["boxyard", this.installLabel(), ...(project ? [`p-${slugify(project.name)}`] : [])]
      const id = await this.provider.create({ labels, size: this.settings.get().workerSize })
      this.store.removeBox(placeholder)
      this.store.upsertBox({ id, provider: this.provider.name, status: "ready", created_at: Date.now(), last_used_at: Date.now(), size: this.settings.get().workerSize, keep_alive: 0, usage_source: "estimated" })
      // The new box belongs to the project that asked for it, so its tasks land there.
      if (projectId && this.store.getProject(projectId)) {
        this.store.setKv(projectBoxKey(projectId), id)
        this.store.setKv(boxOwnerKey(id), projectId)
      }
      void this.refreshBoxUsage(id, true).finally(() => this.emitBoxes())
      this.lastBoxError = null
      console.log(`[box-yard] created box ${id}${project ? ` for project ${project.name}` : ""}`)
    } catch (err) {
      this.store.removeBox(placeholder)
      const message = `Couldn't create a worker box: ${errorMessage(err)}`
      console.error(`[box-yard] ${message}`)
      if (!this.lastBoxError || this.lastBoxError.message !== message) this.notice(`⚠️ ${message}. Retrying in a minute.`)
      this.lastBoxError = { at: Date.now(), message }
      setTimeout(() => this.schedule(), BOX_RETRY_MS).unref()
    } finally {
      this.creatingBoxes--
      if (projectId) {
        const left = (this.creatingFor.get(projectId) ?? 1) - 1
        if (left > 0) this.creatingFor.set(projectId, left)
        else this.creatingFor.delete(projectId)
      }
      this.emitBoxes()
      this.schedule()
    }
  }

  // ------------------------------------------------------------------ turns

  taskDir(boxId: string, taskId: string) {
    return `${this.provider.root(boxId)}/tasks/${taskId}`
  }

  private async launch(taskId: string, boxId: string, turnId: string) {
    let row = this.requireRow(taskId)
    const dir = this.taskDir(boxId, taskId)
    try {
      await this.provider.wake(boxId)
      const project = this.store.getProject(row.project_id)
      if (!project) throw new Error("Project was deleted")

      const check = await this.provider.exec(boxId, `[ -d ${q(dir + "/work")} ] && echo present || echo missing`)
      if (check.exitCode !== 0) throw new Error(`box not responding: ${check.stderr.slice(-300)}`)
      const prepared = check.stdout.includes("missing") ? await this.prepareWorkspace(row, boxId, dir) : null
      row = this.requireRow(taskId)

      // The task ran before but its folder came back without an archive (expired,
      // never made, or lost with its box): its Claude session is gone too. Start a
      // fresh session that carries a recap instead of resuming a missing one.
      const recapped = Boolean(prepared && !prepared.restored && row.session_started)
      if (recapped && row.compact_pending) throw new Error("its Claude session is gone (no workspace archive), so there is nothing to compact")
      const compact = Boolean(row.compact_pending) && Boolean(row.session_started)
      // A compaction is a turn of its own; queued messages wait for the next one.
      const queued = compact ? [] : this.store.peekInputs(taskId)
      const inputs = await this.deliverAttachments(boxId, dir, queued)
      const firstTurn = !row.session_started
      const directory = this.directory()
      const notes = this.store.listNotes(project.id)
      const projectName = (id: string) => this.store.getProject(id)?.name
      const followup = followupPrompt(inputs.length ? inputs : [{ source: "system", content: "Continue." }], projectName)
      if (recapped) {
        row = this.recapSession(row, prepared!.branch, project.baseBranch)
      }
      const prompt = compact
        ? "/compact"
        : firstTurn
        ? firstTurnPrompt({ task: row, notes, directory, extraInputs: inputs.length ? [followup] : [] })
        : recapped
        ? `${recapPrompt(this.store.getTask(taskId)!, this.store.listTaskMessages(taskId, 60), { workspace: recapWorkspaceNote(row.branch, prepared!.branch, project.baseBranch) })}\n\n---\n\n${followup}`
        : followup

      const runnerPath = `${this.provider.root(boxId)}/.boxyard/box-runner.mjs`
      await this.provider.writeFile(boxId, runnerPath, this.runnerSource())
      await this.provider.writeFile(boxId, `${dir}/task.json`, JSON.stringify(this.taskJson(row, project, boxId), null, 2))
      const agent = this.agentSettings(row)
      await this.provider.writeFile(
        boxId,
        `${dir}/turn.json`,
        JSON.stringify({
          turnId,
          prompt,
          sessionId: row.session_id,
          resume: !firstTurn && !recapped,
          compact,
          ...agent,
          systemPrompt: workerSystemPrompt({ project, task: row, branch: row.branch, port: row.port_base ?? PORT_BASE }),
          directory,
          notes: notes.map((n) => ({ author: n.author, content: n.content })),
          recap: recapPrompt(this.store.getTask(taskId)!, this.store.listTaskMessages(taskId, 60)),
        }),
      )

      if (this.stopRequested.has(taskId)) throw new StoppedBeforeStart()
      this.store.startTaskTurn({
        id: turnId,
        taskId,
        turnIndex: compact ? row.turn_count : row.turn_count + 1,
        model: agent.model,
        effort: agent.effort,
        routingRule: row.routing_rule,
        routingReason: row.routing_reason,
        status: compact ? "compact" : "started",
      })

      // setsid (where it exists; macOS has none) + nohup: the turn survives a
      // dropped exec connection. The runner writes turn.pid itself.
      const start = await this.provider.exec(
        boxId,
        `cd ${q(dir)} && ([ -f turn.pid ] && kill -TERM -- -$(cat turn.pid) 2>/dev/null; rm -f turn.pid; true) && ($(command -v setsid || true) nohup ${q(this.provider.nodeBin)} ${q(runnerPath)} turn ${q(dir)} >> runner.log 2>&1 < /dev/null &) && for i in $(seq 1 50); do [ -f turn.pid ] && break; sleep 0.2; done; [ -f turn.pid ] && cat turn.pid || (tail -n 20 runner.log; exit 1)`,
      )
      if (start.exitCode !== 0) throw new Error(`runner did not start: ${(start.stdout + start.stderr).slice(-800)}`)

      this.store.deleteInputs(queued.map((i) => i.id))
      const flags = this.store.turnFlags(row)
      this.store.updateTask(taskId, {
        status: "working",
        sessionStarted: true,
        ...(compact ? { compacting: true, compactPending: false } : { turnCount: row.turn_count + 1 }),
        turnFlags: { interrupts: flags.interrupts } as TurnFlags,
        lastActiveAt: Date.now(),
        question: null,
      })
      this.lastEventAt.set(taskId, Date.now())
      this.emitTask(taskId)
      this.publishDirectory()
      this.holdOpen(taskId, boxId)
      if (this.stopRequested.has(taskId)) await this.killTurn(this.requireRow(taskId)).catch(() => {})
    } catch (err) {
      const stopped = err instanceof StoppedBeforeStart
      this.stopRequested.delete(taskId)
      const message = errorMessage(err)
      if (!stopped) console.error(`[box-yard] launch ${taskId} on ${boxId} failed: ${message}`)
      const current = this.store.getTaskRow(taskId)
      if (!current) return
      this.store.finishTaskTurn(turnId, { status: stopped ? "stopped" : "failed", error: stopped ? null : message })
      // A compaction that couldn't start isn't worth failing the task over.
      const wasCompact = Boolean(current.compact_pending || current.compacting)
      const prev = current.compact_prev_status
      this.store.updateTask(taskId, {
        status: wasCompact ? (prev && !["queued", "starting", "working"].includes(prev) ? prev : "idle") : stopped ? "idle" : "failed",
        currentTurnId: null,
        compactPending: false,
        compacting: false,
        error: stopped || wasCompact ? null : `Couldn't start the agent: ${message}`,
      })
      if (wasCompact && !stopped) this.addEvent(taskId, `Couldn't compact: ${message}`)
      if (!stopped && !wasCompact) {
        this.addEvent(taskId, `Couldn't start the agent: ${message}`)
        this.notice(`❌ **${current.title}** couldn't start: ${message}`, { taskId })
        const health = await this.provider.health(boxId).catch(() => "unknown" as const)
        if (health === "gone" || health === "error") await this.loseBox(boxId, `Box ${boxId} is ${health}.`)
      }
      this.emitTask(taskId)
      this.schedule()
    }
  }

  /** A resumed task whose session is gone gets a new session id; say so in its thread. */
  private recapSession(row: TaskRow, branch: "origin" | "base" | undefined, baseBranch: string): TaskRow {
    this.store.updateTask(row.id, { sessionId: randomUUID() })
    const checkout = !row.branch ? "a fresh workspace" : branch === "base" ? `branch ${row.branch} recreated from ${baseBranch} (it is gone from origin)` : `a fresh checkout of branch ${row.branch}`
    this.addEvent(row.id, `Resumed from a recap: no workspace archive was left, so a new Claude session started on ${checkout} with the task's summary, PR and recent messages.`)
    return this.requireRow(row.id)
  }

  /** Model, effort and auto-compact window for a turn, from the saved settings (read fresh each turn). */
  private agentSettings(row: TaskRow) {
    const s = this.settings.get()
    const effort: Effort = row.effort ?? (s.agentEffort === "orchestrator" ? DEFAULT_EFFORT : s.agentEffort)
    return { model: row.model ?? s.agentModel, effort, autocompact: autocompactFlag(s.agentAutoCompact, row.context_window) }
  }

  /**
   * Copy the files attached to queued inputs into `<task folder>/attachments/` in
   * the box and name their paths in the input text. Binary-safe (Buffers).
   */
  async deliverAttachments<T extends { content: string; attachments: string[] }>(boxId: string, dir: string, inputs: T[]): Promise<T[]> {
    if (!inputs.some((i) => i.attachments.length)) return inputs
    const folder = `${dir}/attachments`
    await this.provider.exec(boxId, `mkdir -p ${q(folder)}`)
    const used = new Set<string>()
    const out: T[] = []
    for (const input of inputs) {
      const lines: string[] = []
      for (const id of input.attachments) {
        const file = this.uploads.get(id)
        if (!file) {
          lines.push(`- (a file was attached but is no longer on the server: ${id})`)
          continue
        }
        let name = file.name
        if (used.has(name)) name = `${id}-${name}`
        used.add(name)
        await this.provider.writeFile(boxId, `${folder}/${name}`, fs.readFileSync(file.path))
        lines.push(`- ${folder}/${name} (${file.mime}, ${file.size} bytes)`)
      }
      const note = lines.length ? `\n\nAttached files (open images and other files with the Read tool):\n${lines.join("\n")}` : ""
      out.push({ ...input, content: input.content + note })
    }
    return out
  }

  private runnerCache: string | null = null
  private runnerSource() {
    if (!this.runnerCache) {
      const file = fs.existsSync(RUNNER_PATH) ? RUNNER_PATH : RUNNER_FALLBACK
      this.runnerCache = fs.readFileSync(file, "utf8")
    }
    return this.runnerCache
  }

  private taskJson(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string) {
    const env: Record<string, string> = { ...this.store.projectEnv(project.id), ...this.store.taskEnv(row.id) }
    if (this.c.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.c.claudeOauthToken
    if (this.c.anthropicApiKey) env.ANTHROPIC_API_KEY = this.c.anthropicApiKey
    if (this.c.githubToken) env.GITHUB_TOKEN = env.GITHUB_TOKEN ?? this.c.githubToken
    const local = this.provider.name === "local"
    const [claudeBin, ...claudeArgs] = (local ? this.c.claudeBin : this.provider.claudeBin).split(" ")
    return {
      taskId: row.id,
      projectId: project.id,
      boxId,
      env,
      claudeBin,
      claudeArgs,
      // A local `claude` login lives in the default config dir, so only
      // isolate when we have a token to log in with.
      isolateConfig: !local || Boolean(this.c.claudeOauthToken || this.c.anthropicApiKey),
      port: row.port_base ?? PORT_BASE,
      baseBranch: project.baseBranch,
      github: { slug: githubSlug(project.repo) },
      publicUrl: this.c.publicUrl || null,
      redis: this.redis ? { url: this.c.redisUrl, token: this.c.redisToken, key: redisEventsKey(row.id) } : null,
    }
  }

  /**
   * Fresh folder for a task: restore its archive, or clone its repo. `branch`
   * says how a clone got the task's branch: from origin, or recreated from the
   * base branch because it no longer exists there.
   */
  private async prepareWorkspace(row: TaskRow, boxId: string, dir: string): Promise<{ restored: boolean; branch?: "origin" | "base" }> {
    const root = this.provider.root(boxId)
    if (row.archive_path && fs.existsSync(row.archive_path)) {
      const remote = `${root}/.boxyard/restore-${row.id}.tgz`
      await this.provider.uploadFile(boxId, row.archive_path, remote)
      const res = await this.provider.exec(
        boxId,
        `mkdir -p ${q(root + "/tasks")} && tar xzf ${q(remote)} -C ${q(root + "/tasks")} && rm -f ${q(remote)} && mkdir -p ${q(dir + "/work")} && rm -f ${q(dir + "/turn.pid")}`,
      )
      if (res.exitCode !== 0) throw new Error(`restoring workspace failed: ${res.stderr.slice(-500)}`)
      await this.restoreExcludedTrackedFiles(boxId, `${dir}/work`)
      // The restored events log keeps its own seq numbers; restart the byte offset.
      const cursor = parseCursor(row.event_cursor)
      const size = await this.provider.exec(boxId, `wc -c < ${q(dir + "/events.jsonl")} 2>/dev/null || echo 0`)
      this.store.updateTask(row.id, { eventCursor: JSON.stringify({ ...cursor, offset: Number.parseInt(size.stdout.trim(), 10) || 0 }) })
      this.addEvent(row.id, `Workspace restored on box ${boxId}.`)
      return { restored: true }
    }

    const project = this.store.getProject(row.project_id)!
    const steps = [`mkdir -p ${q(dir)}`, `rm -rf ${q(dir + "/work")}`]
    if (project.repo) {
      const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f`
      const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.c.githubToken
      const url = cloneUrl(project.repo)
      // One bare mirror per repo per box: later tasks of the project clone from
      // local disk. --dissociate copies the objects, so a task folder stays
      // self-contained when it's archived or moved to another box.
      const mirror = `${root}/.boxyard/repos/${this.repoMirrorName(project.repo)!}`
      const git = `GITHUB_TOKEN=${q(token)} GIT_TERMINAL_PROMPT=0 git -c credential.helper=${q(helper)}`
      steps.push(
        `( [ -d ${q(mirror)} ] && ${git} -C ${q(mirror)} fetch -q --prune origin || (rm -rf ${q(mirror)} && mkdir -p ${q(root + "/.boxyard/repos")} && ${git} clone -q --mirror ${q(url)} ${q(mirror)}) ) >/dev/null 2>&1; true`,
        `cd ${q(dir)}`,
        `${git} clone --reference-if-able ${q(mirror)} --dissociate ${q(url)} work`,
        `cd work`,
        `(git checkout ${q(project.baseBranch)} 2>/dev/null || true)`,
        `git config credential.helper ${q(helper)}`,
        `git config user.name ${q(this.c.gitUserName)}`,
        `git config user.email ${q(this.c.gitUserEmail)}`,
      )
      if (row.branch) steps.push(`( (git checkout ${q(row.branch)} >/dev/null 2>&1 && echo ${BRANCH_MARK}origin) || (git checkout -b ${q(row.branch)} && echo ${BRANCH_MARK}base) )`)
    } else {
      steps.push(`mkdir -p ${q(dir + "/work")}`)
    }
    const res = await this.provider.exec(boxId, steps.join(" && "))
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).replace(/x-access-token:[^@\s]+/g, "x-access-token:***").slice(-800)
      throw new Error(project.repo ? `git clone of ${project.repo} failed: ${detail}` : `workspace setup failed: ${detail}`)
    }
    this.store.updateTask(row.id, { eventCursor: null })
    this.addEvent(row.id, project.repo ? `Cloned ${project.repo} on box ${boxId}${row.branch ? `, branch ${row.branch}` : ""}.` : `Workspace ready on box ${boxId}.`)
    const mark = res.stdout.match(new RegExp(`${BRANCH_MARK}(origin|base)`))?.[1] as "origin" | "base" | undefined
    return { restored: false, branch: mark }
  }

  /**
   * The archive leaves out dirs like `dist/` and `build/` by name, including
   * ones a repo commits. Check those tracked files out again in every repo under
   * work/. Only files under an excluded dir that are missing are touched, so
   * uncommitted edits and deletions elsewhere stay as they were archived.
   */
  private async restoreExcludedTrackedFiles(boxId: string, work: string) {
    const specs = ARCHIVE_EXCLUDED_DIRS.map((d) => q(`:(glob)**/${d}/**`)).join(" ")
    const res = await this.provider.exec(
      boxId,
      `cd ${q(work)} 2>/dev/null && find . -maxdepth 6 -name .git -prune -print | while IFS= read -r g; do r="\${g%/.git}"; git -C "$r" ls-files -z -d -- ${specs} | xargs -0 git -C "$r" checkout -- >/dev/null 2>&1; done; true`,
    )
    if (res.exitCode !== 0) console.warn(`[box-yard] restoring tracked build dirs on ${boxId} failed: ${res.stderr.slice(-300)}`)
  }

  /** Keep an exec stream open while the turn runs so the box isn't paused for being idle. */
  private holdOpen(taskId: string, boxId: string) {
    this.holds.get(taskId)?.abort()
    const ctrl = new AbortController()
    this.holds.set(taskId, ctrl)
    const pidFile = `${this.taskDir(boxId, taskId)}/turn.pid`
    const loop = async () => {
      let quickExits = 0
      while (!ctrl.signal.aborted && !this.stopped) {
        const started = Date.now()
        await this.provider.hold(
          boxId,
          `while [ -f ${q(pidFile)} ] && kill -0 $(cat ${q(pidFile)}) 2>/dev/null; do sleep 15; echo .; done`,
          ctrl.signal,
        )
        if (ctrl.signal.aborted) break
        const row = this.store.getTaskRow(taskId)
        if (!row?.current_turn_id || row.box_id !== boxId) break
        // The process ended (turn_end is on its way) or the stream dropped.
        void this.pollTask(row)
        quickExits = Date.now() - started < 5000 ? quickExits + 1 : 0
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** quickExits)))
      }
      if (this.holds.get(taskId) === ctrl) this.holds.delete(taskId)
    }
    void loop()
  }

  private async killTurn(row: TaskRow) {
    if (!row.box_id) return
    const pidFile = `${this.taskDir(row.box_id, row.id)}/turn.pid`
    await this.provider.exec(row.box_id, `[ -f ${q(pidFile)} ] && (kill -TERM -- -$(cat ${q(pidFile)}) 2>/dev/null || kill -TERM $(cat ${q(pidFile)}) 2>/dev/null); true`)
  }

  // ------------------------------------------------------------------ events

  async poll() {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      const rows = this.store.listTaskRows({ status: ["working", "starting"] }).filter((r) => r.current_turn_id && r.box_id)
      // Small batches keep API usage polite with many agents.
      for (let i = 0; i < rows.length; i += 6) {
        await Promise.all(rows.slice(i, i + 6).map((r) => this.pollTask(r)))
      }
    } finally {
      this.polling = false
    }
  }

  private pollLocks = new Set<string>()

  async pollTask(row: TaskRow) {
    if (!row.box_id || this.pollLocks.has(row.id)) return
    if (row.status === "starting") return // launch() still owns it
    this.pollLocks.add(row.id)
    try {
      const cursor = parseCursor(row.event_cursor)
      const { events, cursor: next } = await this.reader.read(row.id, row.box_id, this.taskDir(row.box_id, row.id), cursor)
      await this.applyEvents(row.id, events, next)
      this.pollFailures.delete(row.id)
    } catch (err) {
      const n = (this.pollFailures.get(row.id) ?? 0) + 1
      this.pollFailures.set(row.id, n)
      if (n === 5 || n % 40 === 0) console.warn(`[box-yard] reading events for ${row.id} failed ${n}x: ${errorMessage(err)}`)
    } finally {
      this.pollLocks.delete(row.id)
    }
  }

  async applyEvents(taskId: string, events: WorkerEvent[], cursor: Cursor) {
    for (const ev of events) {
      // Another reader (poll vs. stalled-turn fallback) may have applied this already.
      const stored = parseCursor(this.store.getTaskRow(taskId)?.event_cursor ?? null)
      if (ev.seq <= stored.seq) continue
      this.store.updateTask(taskId, { eventCursor: JSON.stringify({ ...stored, seq: ev.seq }) })
      this.lastEventAt.set(taskId, Date.now())
      try {
        await this.apply(taskId, ev)
      } catch (err) {
        console.error(`[box-yard] applying ${ev.t} for ${taskId} failed: ${errorMessage(err)}`)
      }
    }
    const row = this.store.getTaskRow(taskId)
    if (row) {
      const stored = parseCursor(row.event_cursor)
      this.store.updateTask(taskId, { eventCursor: JSON.stringify({ ...cursor, seq: Math.max(cursor.seq, stored.seq) }) })
    }
  }

  /** Apply one worker event to the task. Exposed for tests. */
  async apply(taskId: string, ev: WorkerEvent) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    const flags = this.store.turnFlags(row)
    const say = (role: "assistant" | "tool" | "event" | "agent", content: string, meta: Record<string, unknown> | null = null) => {
      if (role === "assistant") {
        const parsed = parseNextSteps(content)
        if (parsed.nextSteps.length) meta = { ...(meta ?? {}), [NEXT_STEPS_META_KEY]: parsed.nextSteps }
        content = parsed.content
      }
      const msg = this.store.addTaskMessage(taskId, role, content, meta)
      this.hub.broadcast({ type: "task.message", message: msg })
    }

    switch (ev.t) {
      case "turn_start":
      case "log":
        return
      case "usage": {
        if (row.compacting || typeof ev.tokens !== "number") return
        this.store.updateTask(taskId, { contextTokens: ev.tokens, ...(typeof ev.window === "number" ? { contextWindow: ev.window } : {}) })
        return this.emitTask(taskId)
      }
      case "assistant":
        return say("assistant", String(ev.text ?? ""))
      case "tool":
        return say("tool", `${ev.name} ${ev.input ?? ""}`.trim(), { name: ev.name })
      case "tool_error":
        return say("tool", String(ev.text ?? "tool error"), { error: true })
      case "session_reset":
        this.store.updateTask(taskId, { sessionId: String(ev.sessionId) })
        return say("event", "Claude session was missing on this box, so the agent started a new one with a recap.")
      case "ask_user": {
        const question = String(ev.question ?? "")
        this.store.updateTask(taskId, { turnFlags: { ...flags, asked: question }, question })
        say("event", `Asked Cody: ${question}`, { kind: "question" })
        return this.emitTask(taskId)
      }
      case "message_agent":
        return this.deliverAgentMessage(row, String(ev.to), String(ev.message ?? ""), Boolean(ev.expectReply))
      case "note": {
        const note = this.store.addNote(row.project_id, `agent: ${row.title}`, String(ev.content ?? ""))
        say("event", `Saved a project note: ${note.content}`)
        const project = this.store.getProject(row.project_id)
        if (project) this.hub.broadcast({ type: "project", project })
        return this.publishNotes(row.project_id)
      }
      case "pr": {
        const url = String(ev.url ?? "")
        const first = row.pr_url !== url
        this.store.updateTask(taskId, {
          prUrl: url,
          branch: String(ev.branch ?? row.branch ?? "") || row.branch,
          turnFlags: { ...flags, sawPr: true },
          // A new PR starts open; the check below tells draft from open.
          ...(first ? { prState: "open", prMergedAt: null, prMergedBy: null } : {}),
        })
        say("event", `${first ? "Opened" : "Updated"} pull request: ${url}`, { kind: "pr", url })
        if (first) this.notice(`🔀 **${row.title}** opened a pull request: ${url}`, { taskId })
        this.prs.refresh(taskId)
        return this.emitTask(taskId)
      }
      case "preview": {
        const port = Number(ev.port)
        if (!row.box_id) return
        try {
          const url = await this.provider.publicUrl(row.box_id, port)
          this.upsertPreview(taskId, { port, url, label: String(ev.label ?? `Port ${port}`) })
          say("event", `Preview on port ${port}: ${url}`, { kind: "preview", url, port })
        } catch (err) {
          say("event", `Couldn't get a public URL for port ${port}: ${errorMessage(err)}`)
        }
        return
      }
      case "artifact": {
        if (!row.box_id) return
        const size = Number(ev.size ?? 0)
        if (size > MAX_ARTIFACT_BYTES) return say("event", `Artifact ${ev.path} is over 25 MB and was skipped.`)
        try {
          const data = await this.provider.readFile(row.box_id, String(ev.path))
          const artifact = this.artifacts.save({
            id: typeof ev.id === "string" ? ev.id : undefined,
            title: String(ev.title ?? path.basename(String(ev.path))),
            filename: path.basename(String(ev.path)),
            data,
            projectId: row.project_id,
            taskId,
          })
          this.hub.broadcast({ type: "artifact", artifact })
          say("event", `Published artifact: ${artifact.title}`, { kind: "artifact", url: artifact.url, artifactId: artifact.id })
          this.notice(`📎 **${row.title}** published ${artifact.title}: ${this.absoluteUrl(artifact.url)}`, { taskId })
        } catch (err) {
          say("event", `Couldn't fetch artifact ${ev.path}: ${errorMessage(err)}`)
        }
        return
      }
      case "done": {
        const noop = ev.outcome === "noop" ? { commits: typeof ev.commits === "number" ? ev.commits : null } : undefined
        this.store.updateTask(taskId, { turnFlags: { ...flags, done: String(ev.summary ?? "Done."), noop } })
        return
      }
      case "turn_end": {
        // The agent may have merged or closed its PR during the turn; ask GitHub.
        const pr = row.pr_url && row.current_turn_id ? await this.prs.check(taskId) : null
        return this.finishTurn(this.store.getTaskRow(taskId) ?? row, ev, pr)
      }
      default:
        return
    }
  }

  /** The tracker saw a PR change state (and maybe moved the task off pr_ready): tell the transcript and the UI. */
  private prChanged({ taskId, info, status }: PrChange) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    if (info.state === "merged") this.addEvent(taskId, `Pull request #${prNumber(row.pr_url) ?? "?"} was merged${info.mergedBy ? ` by ${info.mergedBy}` : ""}: ${row.pr_url}`)
    else if (info.state === "closed") this.addEvent(taskId, `Pull request #${prNumber(row.pr_url) ?? "?"} was closed without merging: ${row.pr_url}`)
    this.emitTask(taskId)
    if (status) this.publishDirectory()
  }

  private finishTurn(row: TaskRow, ev: WorkerEvent, pr: PrState | null = null) {
    if (ev.turnId && row.current_turn_id && ev.turnId !== row.current_turn_id) return // stale event from an older turn
    if (!row.current_turn_id) return
    if (row.compacting) return this.finishCompact(row, ev)
    const flags = this.store.turnFlags(row)
    const stopped = Boolean(ev.stopped) || this.stopRequested.has(row.id)
    this.stopRequested.delete(row.id)
    this.holds.get(row.id)?.abort()
    this.holds.delete(row.id)

    // A merged PR means the work landed; a closed one means there's no PR to review.
    // (The tracker already wrote "Pull request ... was merged" to the transcript when it saw the change.)
    const openPr = Boolean(row.pr_url) && !isFinalPrState(pr)
    let status: TaskStatus
    let error: string | null = null
    if (stopped) status = openPr ? "pr_ready" : "idle"
    else if (!ev.ok) {
      status = "failed"
      error = String(ev.error ?? "The agent exited with an error.")
    } else if (flags.asked) status = "needs_input"
    else if (flags.done) status = "done"
    else if (flags.waitingOn?.length) status = "waiting"
    else if (pr === "merged") status = "done"
    else if (openPr) status = "pr_ready"
    else status = "idle"

    const result = typeof ev.result === "string" ? ev.result : null
    const noopIgnored = flags.noop && !stopped ? noopBlockers(this.runEvidence(row, flags, status)) : []
    const outcome = flags.noop && !stopped && !noopIgnored.length ? "noop" : null
    const turnCost = this.recordTaskClaudeUsage(row, ev)
    if (row.current_turn_id) this.store.finishTaskTurn(row.current_turn_id, { status: stopped ? "stopped" : status, costUsd: turnCost, error })
    this.store.updateTask(row.id, {
      status,
      error,
      currentTurnId: null,
      summary: flags.done ?? (result ? capReply(result) : row.summary),
      ...usageFields(ev.usage),
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : undefined,
      lastActiveAt: Date.now(),
      question: status === "needs_input" ? (flags.asked ?? null) : null,
      turnFlags: { interrupts: 0 },
      outcome,
    }, { quiet: stopped })
    if (row.box_id) this.store.touchBox(row.box_id)

    const cost = turnCost !== null ? ` · $${turnCost.toFixed(3)}` : ""
    this.addEvent(row.id, `Turn ${row.turn_count} ${stopped ? "stopped" : status === "failed" ? "failed" : "finished"}${cost}.`)
    // What the agent said at the end of the turn, for the orchestrator.
    const said = (flags.done && flags.done.length > 40 ? flags.done : result || flags.done || "").replace(/\s+/g, " ").trim()
    const gist = preview(said, 600, "full reply: call wait_for_tasks or get_task")
    const more = this.store.hasInputs(row.id) ? " (more messages are queued for it)" : ""
    if (noopIgnored.length) this.addEvent(row.id, `The agent marked this run a no-op, but it isn't quiet: ${noopIgnored.join(", ")}.`)
    const finished = this.store.getTask(row.id)
    if (finished && isQuietRun(finished)) {
      // Nothing happened: no notice for the Captain or Coordinator, and the run's start notice is dropped too.
      this.addEvent(row.id, "Quiet run: the agent found nothing to do and changed nothing, so it's hidden from Recent and notifications.", { kind: "quiet" })
      this.store.dropTaskNotices(row.id)
    } else if (status === "needs_input") this.notice(`🙋 **${row.title}** needs you: ${flags.asked}`, { taskId: row.id })
    else if (status === "done") this.notice(`✅ **${row.title}** is done: ${gist}`, { taskId: row.id })
    else if (status === "failed") this.notice(`❌ **${row.title}** failed: ${preview(error ?? "", 300, "call get_task for the full error")}`, { taskId: row.id })
    else if (!stopped && !more && (status === "idle" || status === "pr_ready")) {
      this.notice(`💬 **${row.title}** finished its turn: ${gist || "(no reply)"}`, { taskId: row.id })
    }

    this.emitTask(row.id)
    this.publishDirectory()
    void this.archiveAndClean(row.id).finally(() => this.schedule())
    this.schedule()
  }

  /** What a run did, to check the agent's noop mark against (shared/quiet.ts). */
  private runEvidence(row: TaskRow, flags: TurnFlags, status: TaskStatus): RunEvidence {
    return {
      scheduleId: row.schedule_id,
      status,
      prUrl: row.pr_url,
      sawPr: flags.sawPr,
      previews: this.store.taskFromRow(row).previews.length,
      artifacts: this.store.listArtifacts({ taskId: row.id }).length,
      asked: Boolean(flags.asked) || this.store.taskEverAsked(row.id),
      commits: flags.noop?.commits ?? null,
    }
  }

  /** The end of a /compact turn: back to the status before it, with the new usage. Never fails the task. */
  private finishCompact(row: TaskRow, ev: WorkerEvent) {
    this.holds.get(row.id)?.abort()
    this.holds.delete(row.id)
    const stopped = Boolean(ev.stopped) || this.stopRequested.has(row.id)
    this.stopRequested.delete(row.id)
    const prev = row.compact_prev_status
    let status: TaskStatus = prev && !["queued", "starting", "working"].includes(prev) ? prev : row.pr_url ? "pr_ready" : "idle"
    // The PR may have been merged or closed while the compaction ran.
    if (status === "pr_ready" && isFinalPrState(row.pr_state)) status = row.pr_state === "merged" ? "done" : "idle"
    const usage = usageFields(ev.usage)
    this.recordTaskClaudeUsage(row, ev)
    if (row.current_turn_id) this.store.finishTaskTurn(row.current_turn_id, { status: stopped ? "stopped" : ev.ok ? "compacted" : "failed", error: ev.ok ? null : String(ev.error ?? "claude exited with an error") })
    this.store.updateTask(row.id, {
      status,
      currentTurnId: null,
      compacting: false,
      compactPending: false,
      compactPrevStatus: null,
      ...(ev.ok && !stopped ? { ...usage, ...(usage.contextTokens === undefined ? { contextTokens: null } : {}) } : {}),
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : undefined,
    })
    if (row.box_id) this.store.touchBox(row.box_id)
    const before = row.context_tokens
    const after = usage.contextTokens
    if (stopped) this.addEvent(row.id, "Compaction stopped.")
    else if (!ev.ok) this.addEvent(row.id, `Compaction failed: ${String(ev.error ?? "claude exited with an error").slice(0, 400)}`)
    else
      this.addEvent(
        row.id,
        `Context compacted${before ? ` from ${formatTokens(before)}` : ""}${after ? ` to ${formatTokens(after)} tokens` : " (new usage shows after the next turn)"}.`,
      )
    const archiveAvailable = Boolean(row.archive_path && fs.existsSync(row.archive_path))
    const record = this.store.addTaskCompaction({
      taskId: row.id,
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : row.session_id,
      at: Date.now(),
      statusBefore: prev,
      statusAfter: status,
      tokensBefore: before,
      tokensAfter: after ?? null,
      summary: this.taskCompactionSummary(row),
      archivePath: row.archive_path,
      archiveAvailable,
      archiveNote: archiveAvailable ? null : row.archive_path ? "archive path was not present when compaction finished" : "no workspace archive recorded yet",
    })
    this.emitTask(row.id)
    this.publishDirectory()
    void this.archiveAndClean(row.id)
      .then(() => {
        const fresh = this.store.getTaskRow(row.id)
        if (!fresh?.archive_path) return
        const available = fs.existsSync(fresh.archive_path)
        this.store.updateTaskCompactionArchive(record.id, fresh.archive_path, available, available ? null : "archive path was not present after compaction archive")
      })
      .finally(() => this.schedule())
    this.schedule()
  }

  private taskCompactionSummary(row: TaskRow): string {
    const task = this.store.getTask(row.id)
    const messages = this.store.listTaskMessages(row.id, 60)
    const latest = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "event" || m.role === "agent")
    const pieces = [
      task?.summary ? `Outcome: ${task.summary}` : "",
      latest ? `Latest context: [${latest.role}] ${latest.content}` : "",
      row.branch ? `Branch: ${row.branch}` : "",
      row.pr_url ? `PR: ${row.pr_url}` : "",
    ].filter(Boolean)
    return preview(pieces.join("\n"), 1200, "open the task transcript for more")
  }

  private deliverAgentMessage(from: TaskRow, to: string, message: string, expectReply: boolean) {
    const now = Date.now()
    const log = (this.agentMsgLog.get(from.id) ?? []).filter((t) => now - t < 10 * 60_000)
    const say = (taskId: string, content: string, meta: Record<string, unknown>) => {
      const msg = this.store.addTaskMessage(taskId, "agent", content, meta)
      this.hub.broadcast({ type: "task.message", message: msg })
    }
    if (log.length >= AGENT_MSG_LIMIT) {
      say(from.id, `Message to ${to} not delivered: too many agent messages in 10 minutes.`, { to, blocked: true })
      this.store.queueInput(from.id, "system", `Your message to ${to} was not delivered because you sent too many agent messages recently. Ask Cody with ask_user if you are stuck.`)
      return
    }
    log.push(now)
    this.agentMsgLog.set(from.id, log)

    if (/^(cody|user|human|orchestrator)$/i.test(to)) {
      say(from.id, `→ Cody: ${message}`, { to: "cody" })
      this.notice(`💬 **${from.title}** says: ${message}`, { taskId: from.id })
      return
    }
    const target =
      this.store.getTaskRow(to) ?? this.store.listTaskRows().find((r) => r.title.toLowerCase() === to.toLowerCase()) ?? null
    if (!target) {
      say(from.id, `Message to ${to} not delivered: no such agent.`, { to, failed: true })
      this.store.queueInput(from.id, "system", `Your message to "${to}" could not be delivered: there is no agent with that id. Use list_agents.`)
      this.schedule()
      return
    }
    const label = `Message from agent ${from.id} ("${from.title}")`
    const replyHint = expectReply ? ` They are waiting for your answer: reply with message_agent to "${from.id}".` : ""
    this.store.queueInput(target.id, `agent:${from.id}`, `${label}.${replyHint}\n\n${message}`)
    say(target.id, message, { from: from.id, fromTitle: from.title, expectReply })
    say(from.id, `→ ${target.title}: ${message}`, { to: target.id, expectReply })
    if (expectReply) {
      const fresh = this.store.getTaskRow(from.id)!
      const flags = this.store.turnFlags(fresh)
      this.store.updateTask(from.id, { turnFlags: { ...flags, waitingOn: [...new Set([...(flags.waitingOn ?? []), target.id])] } })
    }
    if (!target.current_turn_id && RESTING.includes(target.status)) {
      this.store.updateTask(target.id, { status: "queued" })
    }
    this.emitTask(target.id)
    this.schedule()
  }

  // ------------------------------------------------------------------ archives

  /**
   * How the task's next turn gets its workspace and session back: still on its
   * box, restored from its archive, or (archive gone) a fresh session from a recap.
   */
  resumeMode(taskId: string): "box" | "archive" | "recap" | "new" {
    const row = this.requireRow(taskId)
    if (row.box_id) return "box"
    if (row.archive_path && fs.existsSync(row.archive_path)) return "archive"
    return row.session_started ? "recap" : "new"
  }

  private hasFreshArchive(row: TaskRow) {
    return Boolean(row.archive_path && (row.last_archived_at ?? 0) >= row.last_active_at - 1000 && fs.existsSync(row.archive_path))
  }

  private async archiveAndClean(taskId: string) {
    await this.archive(taskId)
    await this.cleanRestingWorkspace(taskId).catch((err) => console.warn(`[box-yard] cleanup ${taskId} failed: ${errorMessage(err)}`))
  }

  /** Copy the task folder (repo, Claude session, event log) to the orchestrator's disk. */
  async archive(taskId: string) {
    if (!this.c.archiveWorkspaces || this.archiving.has(taskId)) return
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id) return
    this.archiving.add(taskId)
    const boxId = row.box_id
    const tmp = `/tmp/boxyard-archive-${taskId}.tgz`
    try {
      const root = `${this.provider.root(boxId)}/tasks`
      const excludes = [
        ...ARCHIVE_EXCLUDED_DIRS,
        `${taskId}/task.json`, `${taskId}/turn.pid`, `${taskId}/events.lock`, `${taskId}/mcp.json`,
      ]
        .map((e) => `--exclude=${q(e)}`)
        .join(" ")
      const max = this.c.archiveMaxMb * 1024 * 1024
      let res = await this.provider.exec(boxId, `cd ${q(root)} && tar czf ${tmp} ${excludes} ${q(taskId)} 2>/dev/null; wc -c < ${tmp}`)
      let size = Number.parseInt(res.stdout.trim().split("\n").pop() ?? "", 10)
      let partial = false
      if (!Number.isFinite(size)) throw new Error(`tar failed: ${res.stderr.slice(-300)}`)
      if (size > max) {
        // Too big: keep the Claude session, the log and git history (with any
        // uncommitted work stashed into a WIP commit on a side ref).
        partial = true
        res = await this.provider.exec(
          boxId,
          `cd ${q(root + "/" + taskId + "/work")} 2>/dev/null && [ -d .git ] && (git add -A && git -c user.name=box-yard -c user.email=box-yard@local commit -qm "box-yard: wip snapshot" --no-verify && git update-ref refs/boxyard/wip HEAD && git reset -q HEAD~1) >/dev/null 2>&1; cd ${q(root)} && tar czf ${tmp} ${excludes} ${q(taskId + "/claude")} ${q(taskId + "/events.jsonl")} $( [ -d ${q(taskId + "/work/.git")} ] && echo ${q(taskId + "/work/.git")}) 2>/dev/null; wc -c < ${tmp}`,
        )
        size = Number.parseInt(res.stdout.trim().split("\n").pop() ?? "", 10)
        if (!Number.isFinite(size) || size > max) throw new Error(`workspace is too large to archive (${Math.round(size / 1e6)} MB)`)
      }
      const data = await this.provider.readFile(boxId, tmp)
      const file = path.join(this.c.dataDir, "archives", `${taskId}.tgz`)
      fs.writeFileSync(`${file}.tmp`, data)
      fs.renameSync(`${file}.tmp`, file)
      if (this.store.getTaskRow(taskId)) {
        this.store.updateTask(taskId, { archivePath: file, lastArchivedAt: Date.now() })
        if (partial) this.addEvent(taskId, "Workspace was too big to archive whole; saved the Claude session and git history (uncommitted work is on refs/boxyard/wip).")
      }
    } catch (err) {
      console.warn(`[box-yard] archive ${taskId} failed: ${errorMessage(err)}`)
    } finally {
      await this.provider.exec(boxId, `rm -f ${tmp}`).catch(() => {})
      this.archiving.delete(taskId)
    }
  }

  /**
   * Remove regenerable dependency/build/cache directories from a resting workspace.
   * The runner's `clean` mode does the work on the box: it deletes only dirs git
   * ignores and doesn't track (never committed source like a checked-in `build/`).
   */
  private async cleanRestingWorkspace(taskId: string) {
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id || !RESTING.includes(row.status) || this.store.hasInputs(row.id) || !this.hasFreshArchive(row)) return
    const runnerPath = `${this.provider.root(row.box_id)}/.boxyard/box-runner.mjs`
    const dir = this.taskDir(row.box_id, row.id)
    const res = await this.provider.exec(row.box_id, `[ -d ${q(dir + "/work")} ] && ${q(this.provider.nodeBin)} ${q(runnerPath)} clean ${q(dir)}`)
    if (res.exitCode !== 0 && res.stderr.trim()) throw new Error(res.stderr.slice(-300))
  }

  private async removeTaskDir(boxId: string, taskId: string) {
    const dir = this.taskDir(boxId, taskId)
    await this.provider.exec(
      boxId,
      `[ -f ${q(dir + "/turn.pid")} ] && kill -TERM -- -$(cat ${q(dir + "/turn.pid")}) 2>/dev/null; rm -rf ${q(dir)}`,
    )
  }

  private async evictWhenSettled(taskId: string) {
    for (let i = 0; i < 30; i++) {
      const row = this.store.getTaskRow(taskId)
      if (!row) return
      if (!row.current_turn_id) break
      await new Promise((r) => setTimeout(r, 2000))
    }
    await this.archive(taskId)
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id || row.status !== "done") return
    if (this.c.archiveWorkspaces && !this.hasFreshArchive(row)) return // keep the folder if we have no current copy
    const boxId = row.box_id
    this.store.updateTask(taskId, { boxId: null, portBase: null, previews: [] })
    await this.removeTaskDir(boxId, taskId).catch(() => {})
    this.emitTask(taskId)
    this.emitBoxes()
  }

  // ------------------------------------------------------------------ usage and budget

  private budgetBlocked() {
    const waiting = this.store
      .listTaskRows()
      .some((r) => !r.current_turn_id && (r.status === "queued" || (r.status !== "failed" && (r.compact_pending || this.store.hasInputs(r.id)))))
    if (!waiting) return false
    const budget = this.store.usageBudgetStatus(this.settings.get())
    if (!budget.blocked) return false
    const now = Date.now()
    if (now - this.budgetNoticeAt > 30 * 60_000) {
      this.budgetNoticeAt = now
      const parts = [
        budget.daily.exceeded ? `daily budget $${budget.daily.limitUsd.toFixed(2)} (used $${budget.daily.usedUsd.toFixed(2)})` : "",
        budget.monthly.exceeded ? `monthly budget $${budget.monthly.limitUsd.toFixed(2)} (used $${budget.monthly.usedUsd.toFixed(2)})` : "",
      ].filter(Boolean)
      this.notice(`⚠️ Usage budget exceeded (${parts.join(", ")}). New agent turns are paused until you raise the budget in Settings or the window resets.`)
    }
    return true
  }

  /** Logs the turn's Claude usage; returns the turn's own cost (the CLI reports the session's running total), or null when it reported none. */
  private recordTaskClaudeUsage(row: TaskRow, ev: WorkerEvent): number | null {
    const usage = usageObject(ev.resultUsage) ?? usageObject(ev.usage)
    const hasCost = typeof ev.costUsd === "number" && Number.isFinite(ev.costUsd)
    if (!usage && !hasCost && typeof ev.durationMs !== "number") return null
    const cost = this.store.recordClaudeUsage({
      source: "task",
      runKind: ev.compact ? "compact" : "turn",
      taskId: row.id,
      projectId: row.project_id,
      turnId: typeof ev.turnId === "string" ? ev.turnId : row.current_turn_id,
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : row.session_id,
      model: row.model ?? this.settings.get().agentModel,
      startedAt: typeof ev.startedAt === "number" ? ev.startedAt : Date.now() - (typeof ev.durationMs === "number" ? ev.durationMs : 0),
      endedAt: Date.now(),
      durationMs: typeof ev.durationMs === "number" ? ev.durationMs : null,
      usage,
      costUsd: hasCost ? (ev.costUsd as number) : null,
      // Runners before this field didn't say; then a session's first logged turn is charged what it reported.
      resumed: ev.resumed === true,
    })
    return hasCost ? cost : null
  }

  private meterBoxes(now = Date.now()) {
    for (const box of this.store.listBoxes()) {
      if (box.status === "deleting" || box.status === "lost") continue
      const last = box.last_metered_at ?? box.created_at
      const elapsed = Math.max(0, now - last)
      if (elapsed < 1000) continue
      const running = this.store.listTaskRows({ boxId: box.id }).some((r) => r.current_turn_id)
      const activeMs = running ? elapsed : 0
      this.store.recordBoxUsageInterval({
        boxId: box.id,
        provider: box.provider,
        size: normalizeBoxSize(box.size),
        keepAlive: Boolean(box.keep_alive),
        startedAt: last,
        endedAt: now,
        activeMs,
        uptimeMs: elapsed,
        diskBytes: box.disk_bytes,
        source: box.usage_source ?? "estimated",
      })
      this.store.meterBox(box.id, { activeMs: (box.active_ms ?? 0) + activeMs, lastMeteredAt: now })
    }
  }

  private async refreshBoxUsage(boxId: string, force = false) {
    if (!this.provider.usage) return
    const now = Date.now()
    if (!force && now - (this.lastBoxProbeAt.get(boxId) ?? 0) < 5 * 60_000) return
    this.lastBoxProbeAt.set(boxId, now)
    let probe: BoxUsageProbe
    try {
      probe = await this.provider.usage(boxId)
    } catch {
      return
    }
    const patch: Parameters<Store["meterBox"]>[1] = {
      ...(probe.size ? { size: normalizeBoxSize(probe.size) } : {}),
      ...(typeof probe.keepAlive === "boolean" ? { keepAlive: probe.keepAlive } : {}),
      ...(typeof probe.diskBytes === "number" ? { diskBytes: probe.diskBytes, diskUpdatedAt: now } : {}),
      usageSource: probe.source,
    }
    const row = this.store.getBox(boxId)
    if (row && typeof probe.activeMs === "number" && probe.activeMs > (row.active_ms ?? 0)) patch.activeMs = probe.activeMs
    this.store.meterBox(boxId, patch)
  }

  private async maintainRestingStorage(now = Date.now()) {
    await this.parkRetainedWorkspaces(now)
    await this.pruneArchives(now)
    await this.pruneUnusedRepoMirrors()
  }

  private async parkRetainedWorkspaces(now: number) {
    const days = this.settings.get().workspaceRetentionDays
    if (days <= 0) return
    const cutoff = now - days * 24 * 60 * 60_000
    for (const row of this.store.listTaskRows()) {
      if (!row.box_id || row.current_turn_id || !RESTING.includes(row.status) || this.store.hasInputs(row.id)) continue
      if (row.last_active_at > cutoff || !this.hasFreshArchive(row)) continue
      const boxId = row.box_id
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
      await this.removeTaskDir(boxId, row.id).catch((err) => console.warn(`[box-yard] park ${row.id}: ${errorMessage(err)}`))
      this.addEvent(row.id, `Workspace parked after ${days} idle ${days === 1 ? "day" : "days"}; it will restore from the archive on the next message.`)
      this.emitTask(row.id)
    }
  }

  /**
   * Archives that retention must never delete: the work behind a PR that isn't
   * merged yet, and anything touched in the last `archiveKeepTouchedDays`.
   */
  private archiveProtected(row: TaskRow, now: number) {
    if (row.pr_url && row.pr_state !== "merged") return true
    const keepDays = this.settings.get().archiveKeepTouchedDays
    const touched = Math.max(row.last_active_at, row.updated_at)
    return keepDays > 0 && touched > now - keepDays * 24 * 60 * 60_000
  }

  private async pruneArchives(now: number) {
    const days = this.settings.get().archiveRetentionDays
    if (days <= 0) return
    const cutoff = now - days * 24 * 60 * 60_000
    const dir = path.join(this.c.dataDir, "archives")
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tgz")) continue
      const file = path.join(dir, name)
      const taskId = name.slice(0, -4)
      const row = this.store.getTaskRow(taskId)
      const stat = fs.statSync(file)
      if (stat.mtimeMs > cutoff) continue
      if (!row) {
        fs.rmSync(file, { force: true })
        continue
      }
      const longDone = row.status === "done" && !row.current_turn_id && !this.store.hasInputs(row.id) && row.last_active_at <= cutoff
      if (!longDone || this.archiveProtected(row, now)) continue
      fs.rmSync(file, { force: true })
      if (row.archive_path === file) this.store.updateTask(row.id, { archivePath: null, lastArchivedAt: null }, { touch: false })
    }
  }

  private repoMirrorName(repo: string | null) {
    return repo ? `${slugify(repo.replace(/^https?:\/\/[^/]+\//, ""))}.git` : null
  }

  private async pruneUnusedRepoMirrors() {
    for (const box of this.store.listBoxes()) {
      if (box.status !== "ready") continue
      const residents = this.store.listTaskRows({ boxId: box.id })
      // Avoid racing a clone/fetch that may be using a mirror.
      if (residents.some((r) => r.current_turn_id || r.status === "starting")) continue
      const keep = new Set<string>()
      for (const row of residents) {
        const name = this.repoMirrorName(this.store.getProject(row.project_id)?.repo ?? null)
        if (name) keep.add(name)
      }
      const owner = this.store.getKv(boxOwnerKey(box.id))
      if (owner) {
        const name = this.repoMirrorName(this.store.getProject(owner)?.repo ?? null)
        if (name) keep.add(name)
      }
      const repos = `${this.provider.root(box.id)}/.boxyard/repos`
      const keepList = [...keep].join(" ")
      const script = `[ -d ${q(repos)} ] || exit 0; for d in ${q(repos)}/*.git; do [ -e "$d" ] || continue; b=$(basename "$d"); case " ${keepList} " in *" $b "*) ;; *) rm -rf "$d";; esac; done`
      await this.provider.exec(box.id, script).catch((err) => console.warn(`[box-yard] prune mirrors ${box.id}: ${errorMessage(err)}`))
    }
  }

  // ------------------------------------------------------------------ health

  /** Find stalled turns, dead processes and lost boxes; trim idle boxes. */
  async maintain() {
    if (this.stopped) return
    const now = Date.now()
    this.meterBoxes(now)
    for (const box of this.store.listBoxes()) void this.refreshBoxUsage(box.id)
    const active = this.store.listTaskRows({ status: ["working", "starting"] })
    const checkedBoxes = new Map<string, Awaited<ReturnType<BoxProvider["health"]>>>()
    const health = async (boxId: string) => {
      if (!checkedBoxes.has(boxId)) checkedBoxes.set(boxId, await this.provider.health(boxId).catch(() => "unknown" as const))
      return checkedBoxes.get(boxId)!
    }

    for (const row of active) {
      if (!row.box_id || !row.current_turn_id) continue
      if (row.status === "starting") {
        if (now - row.updated_at > START_TIMEOUT_MS) {
          this.store.updateTask(row.id, { status: "failed", currentTurnId: null, error: "Starting the agent timed out." })
          this.emitTask(row.id)
        }
        continue
      }
      const last = this.lastEventAt.get(row.id) ?? row.updated_at
      if (now - last < STALL_MS) continue
      const h = await health(row.box_id)
      if (h === "gone" || h === "error") {
        await this.loseBox(row.box_id, `Box ${row.box_id} is ${h}.`)
        continue
      }
      if (h === "unknown") continue
      if (h === "paused") {
        // Pausing killed the process. Wake the box; the pid check below will see it dead.
        await this.provider.wake(row.box_id).catch(() => {})
      }
      const pidFile = `${this.taskDir(row.box_id, row.id)}/turn.pid`
      const alive = await this.provider
        .exec(row.box_id, `[ -f ${q(pidFile)} ] && kill -0 $(cat ${q(pidFile)}) 2>/dev/null && echo alive || echo dead`)
        .catch(() => null)
      if (!alive || alive.stdout.includes("alive")) {
        this.lastEventAt.set(row.id, now - STALL_MS / 2) // check again soon
        continue
      }
      // Dead process. Look in the file for anything Redis may have missed.
      try {
        const cursor = parseCursor(row.event_cursor)
        const { events, cursor: next } = await this.reader.readFileTail(row.box_id, this.taskDir(row.box_id, row.id), cursor)
        await this.applyEvents(row.id, events, next)
      } catch {}
      const fresh = this.store.getTaskRow(row.id)
      if (fresh?.current_turn_id === row.current_turn_id) this.interrupt(fresh, "the worker process stopped without finishing")
    }

    // Retire idle boxes when configured to.
    const idleDelete = this.limits().boxIdleDeleteMinutes
    if (idleDelete > 0) {
      for (const box of this.store.listBoxes()) {
        if (box.status !== "ready") continue
        if (now - box.last_used_at < idleDelete * 60_000) continue
        const residents = this.store.listTaskRows({ boxId: box.id })
        if (residents.some((r) => r.current_turn_id || this.store.hasInputs(r.id))) continue
        if (residents.some((r) => !this.hasFreshArchive(r))) continue
        console.log(`[box-yard] deleting idle box ${box.id}`)
        await this.loseBox(box.id, "Box retired after being idle; workspaces are archived.", true)
        await this.provider.destroy(box.id).catch(() => {})
      }
    }
    if (now - this.lastRetentionAt > 5 * 60_000) {
      this.lastRetentionAt = now
      await this.maintainRestingStorage(now)
    }
    this.schedule()
  }

  /** The turn died. Requeue it (a couple of times) so the agent can carry on. */
  private interrupt(row: TaskRow, reason: string) {
    const flags = this.store.turnFlags(row)
    const interrupts = (flags.interrupts ?? 0) + 1
    this.holds.get(row.id)?.abort()
    if (row.compacting) {
      // Not worth retrying: the user can press Compact again.
      const prev = row.compact_prev_status
      this.store.updateTask(row.id, { status: prev && !["queued", "starting", "working"].includes(prev) ? prev : "idle", currentTurnId: null, compacting: false, compactPending: false })
      this.addEvent(row.id, `Compaction interrupted (${reason}).`)
      this.emitTask(row.id)
      this.schedule()
      return
    }
    if (interrupts > MAX_INTERRUPTS) {
      this.store.updateTask(row.id, { status: "failed", currentTurnId: null, error: `Interrupted: ${reason}`, turnFlags: { interrupts: 0 } })
      this.addEvent(row.id, `Turn interrupted (${reason}). Gave up after ${MAX_INTERRUPTS} retries.`)
      this.notice(`❌ **${row.title}** was interrupted: ${reason}`, { taskId: row.id })
    } else {
      this.store.queueInput(row.id, "system", `Your previous turn was interrupted (${reason}). Check where things stand (git status, files) and continue the task.`)
      this.store.updateTask(row.id, { status: "queued", currentTurnId: null, turnFlags: { interrupts } })
      this.addEvent(row.id, `Turn interrupted (${reason}); retrying.`)
    }
    this.emitTask(row.id)
    this.schedule()
  }

  /** A box is gone. Its tasks lose their folder and come back from archives elsewhere. */
  private async loseBox(boxId: string, reason: string, quiet = false) {
    const box = this.store.getBox(boxId)
    if (!box) return
    this.store.setBoxStatus(boxId, "lost")
    this.store.setKv(boxOwnerKey(boxId), null)
    for (const row of this.store.listTaskRows({ boxId })) {
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
      if (row.current_turn_id) this.interrupt(this.requireRow(row.id), reason)
      else if (!quiet) this.addEvent(row.id, `${reason} The workspace will be restored from its archive when needed.`)
      this.emitTask(row.id)
    }
    this.store.removeBox(boxId)
    this.emitBoxes()
    this.schedule()
  }

  // ------------------------------------------------------------------ helpers

  private requireRow(taskId: string): TaskRow {
    const row = this.store.getTaskRow(taskId)
    if (!row) throw new NotFoundError(`Task ${taskId} not found`)
    return row
  }

  private upsertPreview(taskId: string, link: PreviewLink) {
    const task = this.store.getTask(taskId)
    if (!task) return
    const previews = [...task.previews.filter((p) => p.port !== link.port), link].sort((a, b) => a.port - b.port)
    this.store.updateTask(taskId, { previews })
    this.emitTask(taskId)
  }

  private absoluteUrl(url: string) {
    return url.startsWith("/") && this.c.publicUrl ? `${this.c.publicUrl.replace(/\/$/, "")}${url}` : url
  }

  private addEvent(taskId: string, content: string, meta: Record<string, unknown> | null = null) {
    if (!this.store.getTaskRow(taskId)) return
    const msg = this.store.addTaskMessage(taskId, "event", content, meta)
    this.hub.broadcast({ type: "task.message", message: msg })
  }

  private initialRoute(
    project: NonNullable<ReturnType<Store["getProject"]>>,
    input: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null },
  ) {
    const fallback = resolveDefaultRoute(loadRouting(this.c.dataDir, this.settings.get()).config, project)
    return {
      model: input.model ?? fallback.model,
      effort: input.effort ?? fallback.effort,
      routingRule: input.routingRule ?? (input.model || input.effort ? null : fallback.rule),
      routingReason: input.routingReason ?? (input.model || input.effort ? null : fallback.reason),
    }
  }

  private routeLabel(route: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null }) {
    const bits = [route.model ? `model ${route.model}` : null, route.effort ? `${route.effort} effort` : null, route.routingRule ? `rule ${route.routingRule}` : null, route.routingReason ? `reason: ${route.routingReason}` : null].filter(Boolean)
    return bits.length ? bits.join(", ") : "global defaults"
  }

  /** A line for the owner of a task update; by default the Coordinator reads it on its next turn. */
  notice(content: string, meta: Record<string, unknown> | null = null) {
    const handled = Boolean(this.onNotice?.(content, meta))
    const msg = this.store.addChat("notice", content, meta)
    // Keep the historical main-chat notice for existing installs, but do not
    // make the Coordinator process every project task event once a Captain owns it.
    if (handled) this.store.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE id = ?").run(msg.id)
    this.hub.broadcast({ type: "chat.message", message: msg })
  }

  emitTask(taskId: string) {
    if (this.stopped) return
    const task = this.store.getTask(taskId)
    if (task) this.hub.broadcast({ type: "task", task })
    this.emitBoxes()
  }

  private emitBoxesTimer: NodeJS.Timeout | null = null
  private emitBoxes() {
    if (this.emitBoxesTimer) return
    this.emitBoxesTimer = setTimeout(() => {
      this.emitBoxesTimer = null
      if (this.stopped) return
      this.hub.broadcast({ type: "boxes", boxes: this.boxes() })
    }, 250)
    this.emitBoxesTimer.unref?.()
  }

  directory(): DirectoryEntry[] {
    const projects = new Map(this.store.listProjects().map((p) => [p.id, p.name]))
    return this.store
      .listTaskRows()
      .filter((r) => r.status !== "done")
      .map((r) => ({ id: r.id, title: r.title, project: projects.get(r.project_id) ?? "?", status: r.status }))
  }

  /** Share the live agent directory with workers through Redis (debounced). */
  publishDirectory() {
    if (!this.redis || this.directoryTimer) return
    this.directoryTimer = setTimeout(() => {
      this.directoryTimer = null
      if (this.stopped) return
      void this.redis!.cmd("SET", "boxyard:directory", JSON.stringify(this.directory())).catch(() => {})
    }, 1000)
    this.directoryTimer.unref?.()
  }

  publishNotes(projectId: string) {
    if (!this.redis) return
    const notes = this.store.listNotes(projectId).map((n) => ({ author: n.author, content: n.content }))
    void this.redis.cmd("SET", `boxyard:notes:${projectId}`, JSON.stringify(notes)).catch(() => {})
  }
}

class StoppedBeforeStart extends Error {
  constructor() {
    super("stopped before start")
  }
}
