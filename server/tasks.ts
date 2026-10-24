import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store, TaskRow, TurnFlags } from "./store.js"
import { BadRequestError, ConflictError, NotFoundError, cloneUrl, githubSlug, boxCost, normalizeBoxSize } from "./store.js"
import type { BoxProvider, BoxUsageProbe } from "./providers/types.js"
import { q } from "./providers/types.js"
import { THIN_DIR, THIN_MARK, archiveOutcome, archiveScript, ArchiveDecoder, errorTail, thinRestoreScript, type ArchiveOutcome } from "./archive.js"
import { deleteWipScript, gitPrepScript, gitRestoreScript, gitStages, parseGitPrep, parseGitRestore, wipRef, type GitPrepResult } from "./gitFirst.js"
import { EventReader, parseCursor, redisEventsKey, type Cursor, type WorkerEvent } from "./bus.js"
import type { Redis } from "./redis.js"
import type { Artifacts } from "./artifacts.js"
import { MAX_ARTIFACT_BYTES } from "./artifacts.js"
import {
  MERGE_BUTTON_SOURCE,
  firstTurnPrompt,
  followupPrompt,
  mergeRequestPrompt,
  recapPrompt,
  recapWorkspaceNote,
  workerSystemPrompt,
  type DirectoryEntry,
} from "./prompts.js"
import type { Uploads, StoredUpload } from "./uploads.js"
import { BOX_SIZES, DEFAULT_EFFORT, RESTING_STATUSES, SIZE_DEFAULTS, isFinalPrState, type Attachment, type BoxContents, type BoxInfo, type BoxOperation, type BoxSize, type Effort, type PrState, type PreviewLink, type PushState, type Task, type TaskStatus } from "../shared/types.js"
import { autocompactFlag, noteBudgetOf, type SettingsStore } from "./settings.js"
import { budgetNotes } from "../shared/notes.js"
import { MAX_NOTE_CHARS } from "./notes.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { formatTokens } from "./usage.js"
import { errorMessage } from "./util/retry.js"
import { capReply, preview } from "./replies.js"
import { PrTracker, prNumber, type PrChange } from "./prs.js"
import { loadRouting, resolveDefaultRoute } from "./routing.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { isQuietRun, noopBlockers, type RunEvidence } from "../shared/quiet.js"
import { cleanupSummary, dfCommand, diskLine, formatBytes, isOutOfSpace, parseDf, requiredFreeBytes, rootLow, type BoxCleanup, type CleanupStepKey, type DiskSpace } from "../shared/disk.js"
import { BoxJanitor, pushedCheck, pushedVerdict } from "./janitor.js"
import { GIT_MARK, KEEP_STAGE_MARK, MIRROR_MARK, keepPackStages, cloneTaskScript, hydrateMirrorScript, keepPackScript, pruneMirrorsScript, relinkTaskScript, syncMirrorScript, withMirrorLock, type MirrorSpec } from "./gitShare.js"
import type { HookTrigger } from "../shared/hooks.js"
import {
  compareSizes,
  initiatorLabel,
  resizeSummary,
  resizeTitle,
  scaleDownFit as scaleDownFitCheck,
  sizeSpecLine,
  type BoxResize,
  type DiskFit,
  type ResizeInitiator,
  type ResizeMode,
  type ResizePlan,
  type ResizeStep,
} from "../shared/boxSizes.js"

type BoxOp = "clear" | "delete" | "resize"

function busyMessage(boxId: string, op: BoxOperation) {
  const what = { cleanup: "a disk cleanup", clear: "clearing", delete: "deleting", resize: "resizing" }[op]
  return `Box ${boxId} is busy: ${what} is in progress.`
}

/** "Couldn't archive task_a" / "Couldn't archive 3 workspaces (task_a, task_b, task_c)". */
function couldntArchive(taskIds: string[]) {
  return taskIds.length === 1 ? `Couldn't archive ${taskIds[0]}` : `Couldn't archive ${taskIds.length} workspaces (${taskIds.join(", ")})`
}

/** How a resize error names its failed step. */
const RESIZE_STEP_NAMES: Record<ResizeStep["key"], string> = { stop: "stop agents", resize: "resize", create: "create", archive: "archive", move: "move", delete: "destroy" }

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
/** Note suggestions one task can leave for its retro; past that the agent is logging, not suggesting. */
const MAX_SUGGESTIONS_PER_TASK = 20
const BRANCH_MARK = "boxyard-branch="
const CLONE_SIZE_MARK = "boxyard-clone-kb="
/** How often routine upkeep runs a light gc (`gc --auto`) on each box's repo mirrors. */
const MIRROR_GC_MS = 6 * 60 * 60_000
/** A box whose root disk stays low gets its stale temp folders swept at most this often. */
const ROOT_SWEEP_MS = 10 * 60_000
/** A df reading this fresh is good enough for placement. */
const DISK_CACHE_MS = 20_000
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
  /** Tests: a fake GitHub for the PR tracker, and the token it gets (even in mock mode). */
  github?: { fetch?: typeof fetch; token?: (projectId: string) => string | null }
}

/** What clients see of an upload: no server paths. */
const publicFiles = (files: StoredUpload[]): Attachment[] => files.map(({ id, name, size, mime }) => ({ id, name, size, mime }))

/**
 * Who a queued task input is from. `captain:<projectId>` is that project's Captain; `cody:merge` is the "Merge PR" button;
 * `hook:<hookId>` a hook (server/hooks.ts).
 */
export type InputSource = "cody" | typeof MERGE_BUTTON_SOURCE | "orchestrator" | "system" | `agent:${string}` | `captain:${string}` | `hook:${string}`

/**
 * Something happened to a task that hooks (server/hooks.ts) can act on. `originHookIds` are the hooks whose
 * prompts started the turn behind it, so a hook doesn't fire on its own work.
 */
export interface TaskEvent {
  type: HookTrigger
  taskId: string
  /** The turn that ended (task events), or null (a PR merged while the task rested). */
  turnId: string | null
  originHookIds: string[]
  /** The agent opened or pushed to its PR during this turn. */
  sawPr?: boolean
}
export type TaskEventListener = (event: TaskEvent) => void

/** Who asks for a merge other than Cody's Merge button (requestMerge): a hook, with its labels. */
export interface MergeRequester {
  source: InputSource
  /** As the transcript and notices name it after "The": `hook "On PR ready → merge"`. */
  who: string
  /** The message: the standard one rendered for this PR, or the hook's edited prompt. */
  prompt: string
  hook?: { queued: string; meta: Record<string, unknown> }
}

/**
 * How a notice is delivered. `coordinator`: it stays in the Coordinator's updates even when a Captain handles it too.
 * `wake: false`: nobody is woken for it; the Captain and Coordinator read it on their next turn.
 */
export interface NoticeOptions {
  coordinator?: boolean
  wake?: boolean
}
/** Task-message meta for a Captain's message, so the transcript can say which Captain steered the task. */
const captainMeta = (store: Store, projectId: string) => ({ source: "captain", captainProjectId: projectId, captainName: store.getProject(projectId)?.name ?? null })

/** kv key for the box a project's work goes to first. */
const projectBoxKey = (projectId: string) => `project_box:${projectId}`
/** kv key for the project a box was created for. */
const boxOwnerKey = (boxId: string) => `box_owner:${boxId}`
/** The running or last resize of a box (old and new box both point at it). */
const resizeKey = (boxId: string) => `box_resize:${boxId}`
/** The work disk's df total a box of this size last reported, for the scale-down check. */
const diskTotalKey = (size: BoxSize) => `disk_total:${size}`
/** kv key for a repo's last measured clone size in bytes (by mirror name). */
const cloneBytesKey = (mirror: string) => `clone_bytes:${mirror}`

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
  /** Each task's last archive error, until an archive succeeds. */
  private archiveErrors = new Map<string, string>()
  private lastRetentionAt = 0
  /** Routine upkeep: each resting task's last_active_at when its build output was last cleaned. */
  private buildsCleaned = new Map<string, number>()
  /** Routine upkeep: when each box's mirrors last got their light gc (first seen = now). */
  private mirrorGcAt = new Map<string, number>()
  private directoryTimer: NodeJS.Timeout | null = null
  private stopped = false
  private lastBoxProbeAt = new Map<string, number>()
  /** Last delete attempt of a box stuck in "deleting". */
  private lastReclaimAt = new Map<string, number>()
  private lastOrphanSweepAt = Date.now()
  private budgetNoticeAt = 0
  /** Frees disk on low boxes in graduated steps (server/janitor.ts). */
  readonly janitor: BoxJanitor
  /** Latest df per box, so a scheduling pass doesn't run df for every task. */
  private diskCache = new Map<string, { at: number; space: DiskSpace }>()
  /** Bytes new workspaces being set up on a box are about to use: box -> task -> bytes. */
  private reserved = new Map<string, Map<string, number>>()
  /** Boxes the last placement check found too full for a new workspace. */
  private lowBoxes = new Set<string>()
  /** When each box's root disk was last swept for being low (sweepRootDisks). */
  private rootSweptAt = new Map<string, number>()
  /** Boxes being cleared, deleted or resized: nothing is placed on them and their tasks wait. */
  private boxOps = new Map<string, BoxOp>()
  /** Resizes in progress, by box (the old box and, once made, the new one). */
  private resizes = new Map<string, BoxResize>()
  /** Tasks whose setup already hit a full disk once; the next one fails for good. */
  private diskRetried = new Set<string>()
  /** Tasks holding for a cleanup on the box their workspace lives on, after running out of space there. */
  private diskHold = new Map<string, string>()
  private lowDiskNoticeAt = new Map<string, number>()
  /** Called after every notice; return true when another owner handled delivery. */
  onNotice: ((content: string, meta: Record<string, unknown> | null, opts: NoticeOptions) => boolean | void) | null = null
  /** The task event bus hooks listen on (see subscribe). */
  private readonly listeners = new Set<TaskEventListener>()

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
      token: deps.github?.token ?? ((projectId) => (this.c.mock ? null : (this.store.projectEnv(projectId).GITHUB_TOKEN ?? this.c.githubToken) || null)),
      fetch: deps.github?.fetch,
      onChange: (change) => this.prChanged(change),
      log: (msg) => console.warn(msg),
    })
    fs.mkdirSync(path.join(this.c.dataDir, "archives"), { recursive: true })
    this.janitor = new BoxJanitor({
      store: this.store,
      provider: this.provider,
      hub: this.hub,
      probe: (boxId) => this.probeDisk(boxId, 0),
      taskDir: (boxId, taskId) => this.taskDir(boxId, taskId),
      installRunner: async (boxId) => {
        const runnerPath = `${this.provider.root(boxId)}/.boxyard/box-runner.mjs`
        const source = this.runnerSource()
        // Only when it changed: a full disk can't take the write, and cleanup has to work then.
        const sum = createHash("sha256").update(source).digest("hex")
        const current = await this.provider.exec(boxId, `sha256sum ${q(runnerPath)} 2>/dev/null | cut -c1-64`).catch(() => null)
        if (current?.stdout.trim() !== sum) await this.provider.writeFile(boxId, runnerPath, source)
        return runnerPath
      },
      hasFreshArchive: (row) => this.hasFreshArchive(row),
      archive: (taskId) => this.archiveFresh(taskId),
      archiveProblem: (taskId) => this.archiveProblem(taskId),
      park: (taskId, boxId, note) => this.park(taskId, boxId, withOwner(note, this.owner())),
      dropPushed: (taskId, boxId) => this.dropPushed(taskId, boxId),
      pushedOnGitHub: (taskId, boxId) => this.pushedOnGitHub(taskId, boxId),
      mirrorsToKeep: (boxId, owner) => this.mirrorsToKeep(boxId, owner),
      finished: (report) => this.cleanupFinished(report),
    })
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
    // A resize can't pick up where it left off: say so. Its new box (if it got that far) holds no work yet.
    for (const box of this.store.listBoxes()) {
      const r = this.resizeReport(box.id)
      if (r?.status !== "running") continue
      this.finishResize(r, "failed", "Box Yard restarted during the resize; nothing was moved. Try again.")
      // The box it was making holds no work yet: delete it rather than leave it empty.
      const made = r.newBoxId ? this.store.getBox(r.newBoxId) : null
      if (made && !this.store.listTaskRows({ boxId: made.id }).length) void this.dropBox(made.id).then((note) => this.noteResizeCleanup(r, note))
    }
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
      const ids = await this.provider.listIds(label)
      // A box being created is at the provider before it's in the database.
      if (this.creatingBoxes) return
      const known = new Set(this.store.listBoxes().map((b) => b.id))
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
      startedBy: input.scheduleId ? "schedule" : (input.source ?? "cody"),
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
    /** A hook's message: the labelled text the agent gets, and the transcript line's meta ("Hook: <name>"). */
    hook?: { queued: string; meta: Record<string, unknown> },
  ): Task {
    this.enqueue(this.requireRow(taskId), content, source, attachments, route, hook)
    this.emitTask(taskId)
    this.schedule()
    return this.store.getTask(taskId)!
  }

  /** sendInput without the broadcast: queue the message, mark the task queued if it rests, and return the input's id. */
  private enqueue(
    row: TaskRow,
    content: string,
    source: InputSource,
    attachments: StoredUpload[],
    route?: Parameters<TaskManager["sendInput"]>[4],
    hook?: Parameters<TaskManager["sendInput"]>[5],
  ): string {
    if (!content.trim() && !attachments.length) throw new BadRequestError("message is empty")
    // The files are copied into the box when the next turn starts, so this works while the agent is mid-turn.
    const inputId = this.store.queueInput(row.id, source, hook?.queued ?? (content.trim() || "(no text)"), attachments.map((f) => f.id))
    if (source === "cody" || source === MERGE_BUTTON_SOURCE || source === "orchestrator" || source.startsWith("captain:") || hook) {
      const from = hook ? hook.meta : source.startsWith("captain:") ? captainMeta(this.store, source.slice("captain:".length)) : { source }
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
    return inputId
  }

  /**
   * The "Merge PR" button: send the standard merge message (prompts.ts MERGE_REQUEST_PROMPT) to the task's
   * session, right away or queued behind its current turn, like send_to_task. The request stays pending until
   * the turn that handles it ends or the PR is merged or closed, and a second one for the same PR is refused
   * meanwhile. A merge_requested event goes to the transcript, and the notice to the project Captain and the Coordinator.
   *
   * The "On PR ready → merge" hook goes through here too (`by`), with its own prompt (the standard message
   * unless edited) and labels, so a hook merge and a button merge never run in parallel.
   */
  requestMerge(taskId: string, by?: MergeRequester): { task: Task; delivery: "now" | "queued" } {
    const row = this.requireRow(taskId)
    const n = prNumber(row.pr_url)
    if (!row.pr_url || n === null) throw new BadRequestError("This task has no GitHub pull request to merge.")
    if (row.pr_state && row.pr_state !== "open") {
      throw new BadRequestError(`PR #${n} is ${row.pr_state === "draft" ? "a draft" : row.pr_state}, so there is nothing to merge.`)
    }
    const pending = this.store.mergeRequestOf(row)
    if (pending) {
      throw new ConflictError(`A merge of PR #${n} was already requested ${pending.deliveredAt ? "and the agent is on it" : "and is queued"}. Wait for that turn to end.`)
    }
    const busy = Boolean(row.current_turn_id) || row.status === "starting" || row.status === "working"
    const inputId = by
      ? this.enqueue(row, by.prompt, by.source, [], null, by.hook)
      : this.enqueue(row, mergeRequestPrompt(n), MERGE_BUTTON_SOURCE, [])
    const requestedBy = by ? by.who : null
    const owner = this.owner()?.trim() || DEFAULT_OWNER_NAME
    this.store.updateTask(row.id, { mergeRequest: { prNumber: n, prUrl: row.pr_url, requestedAt: Date.now(), deliveredAt: null, inputId, requestedBy } }, { quiet: true })
    const hookRef = by?.hook ? { hookId: by.hook.meta.hookId, hookName: by.hook.meta.hookName, hookRunId: by.hook.meta.hookRunId } : {}
    const meta = { kind: "merge_requested", prNumber: n, prUrl: row.pr_url, ...hookRef }
    const later = busy ? "; it goes out when the current turn ends" : ""
    this.addEvent(row.id, by ? `The ${by.who} asked for a merge of PR #${n}${later}.` : `${owner} asked for a merge of PR #${n} with the Merge button${later}.`, meta)
    this.emitTask(row.id)
    this.schedule()
    // The Captain wakes on it once the task's turn ends; the Coordinator reads it with its next updates.
    this.notice(
      by ? `🚢 The ${by.who} asked **${row.title}** to merge PR #${n}: ${row.pr_url}` : `🚢 ${owner} asked **${row.title}** to merge PR #${n} (Merge button): ${row.pr_url}`,
      { taskId: row.id, ...meta },
      { coordinator: true, wake: by ? false : undefined },
    )
    return { task: this.store.getTask(row.id)!, delivery: busy ? "queued" : "now" }
  }

  /** The turn that carried a pending merge request ended (or the PR moved on): it is no longer pending. */
  private settleMergeRequest(taskId: string, when: "turn" | "pr") {
    const row = this.store.getTaskRow(taskId)
    const req = row ? this.store.mergeRequestOf(row) : null
    if (!row?.merge_request_json || (when === "turn" && req && !req.deliveredAt)) return
    this.store.updateTask(taskId, { mergeRequest: null }, { quiet: true, touch: false })
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
    this.addEvent(row.id, withOwner("Stopped by Cody.", this.owner()))
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
    await this.deleteRemoteWip(row).catch((err) => console.warn(`[box-yard] removing ${wipRef(row.id)} failed: ${errorMessage(err)}`))
    if (row.box_id) await this.removeTaskDir(row.box_id, row.id).catch(() => {})
    if (row.archive_path) {
      fs.rmSync(row.archive_path, { force: true })
      this.store.noteTaskArchiveUnavailable(row.id, row.archive_path, "archive deleted with task")
    }
    this.archiveErrors.delete(row.id)
    if (this.redis) await this.redis.cmd("DEL", redisEventsKey(row.id)).catch(() => {})
    this.store.deleteTask(row.id)
    this.hub.broadcast({ type: "task.deleted", taskId: row.id })
    this.publishDirectory()
    this.schedule()
  }

  /**
   * A deleted task's WIP ref goes from origin too: from its box when it has one, else through GitHub's API
   * (best effort; a ref left behind is a hidden commit nobody sees).
   */
  private async deleteRemoteWip(row: TaskRow) {
    const wip = this.store.getTask(row.id)?.pushState?.wip
    const project = this.store.getProject(row.project_id)
    if (!wip || !project?.repo) return
    if (row.box_id) {
      await this.provider.exec(row.box_id, this.wipDeleteScript(row.box_id, row.id, project))
      return
    }
    const slug = githubSlug(project.repo)
    const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.c.githubToken
    if (this.c.mock || !slug || !token) return
    await fetch(`https://api.github.com/repos/${slug}/git/refs/${wipRef(row.id).replace(/^refs\//, "")}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    })
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

  /** Agents per box and task folders per box for a box of this size: Settings when set there, else the size's defaults. */
  sizeLimits(size: BoxSize): { slotsPerBox: number; maxResidentPerBox: number } {
    const o = this.settings.boxLimitOverrides()
    return { slotsPerBox: o.slotsPerBox ?? SIZE_DEFAULTS[size].slotsPerBox, maxResidentPerBox: o.maxResidentPerBox ?? SIZE_DEFAULTS[size].maxResidentPerBox }
  }

  /** Turns that may run at once on this box (its own size decides the default). */
  private slotsFor(boxId: string) {
    return this.sizeLimits(normalizeBoxSize(this.store.getBox(boxId)?.size)).slotsPerBox
  }

  private residentsFor(boxId: string) {
    return this.sizeLimits(normalizeBoxSize(this.store.getBox(boxId)?.size)).maxResidentPerBox
  }

  /** Size for a new box made for a project: its preferred size, else Settings → Worker size. */
  newBoxSize(projectId?: string | null): BoxSize {
    return (projectId ? this.store.getProject(projectId)?.boxSize : null) ?? this.settings.get().workerSize
  }

  /** Agents (running turns) across all boxes. */
  runningTotal() {
    return this.store.listTaskRows().filter((r) => r.current_turn_id).length
  }

  /**
   * Pool limits for pool_status. Agents and task folders per box are per box size (each box follows its own
   * size unless Settings or env override it for every box), so they're reported by size, plus what overrides them.
   */
  poolLimits() {
    const l = this.limits()
    const info = this.settings.boxLimitInfo()
    const bySize = (k: "slotsPerBox" | "maxResidentPerBox") => Object.fromEntries(BOX_SIZES.map((s) => [s, this.sizeLimits(s)[k]])) as Record<BoxSize, number>
    const why = (k: "slotsPerBox" | "maxResidentPerBox", env: string) => {
      const source = info[k].source
      return source === "ui" ? "saved in Settings › Boxes & limits" : source === "env" ? `${env} env var` : source === "config" ? "server config" : null
    }
    return {
      maxBoxes: l.maxBoxes,
      maxAgents: l.maxAgents,
      agentsPerBox: bySize("slotsPerBox"),
      tasksPerBox: bySize("maxResidentPerBox"),
      overridden: { agentsPerBox: why("slotsPerBox", "BOX_SLOTS"), tasksPerBox: why("maxResidentPerBox", "BOX_MAX_RESIDENT") },
      boxes: this.store.listBoxes().length,
      agentsRunning: this.runningTotal(),
    }
  }

  boxes(): BoxInfo[] {
    this.meterBoxes()
    const rates = this.settings.get().costRates
    const floor = this.diskNeed(null)
    const now = Date.now()
    // Boxes still being deleted show too: they exist (and bill) until the provider confirms.
    return [...this.store.listBoxes(), ...this.store.listDeletingBoxes()].map((b) => {
      const residents = this.store.listTaskRows({ boxId: b.id })
      const size = normalizeBoxSize(b.size)
      const uptimeMs = Math.max(0, now - b.created_at)
      return {
        id: b.id,
        provider: b.provider,
        status: b.status,
        size,
        keepAlive: Boolean(b.keep_alive),
        slots: this.slotsFor(b.id),
        runningTurns: residents.filter((r) => r.current_turn_id).length,
        residentTasks: residents.map((r) => r.id),
        projects: [...new Set(residents.map((r) => this.store.getProject(r.project_id)?.name ?? r.project_id))],
        activeMs: b.active_ms ?? 0,
        uptimeMs,
        diskBytes: b.disk_bytes ?? null,
        diskFreeBytes: b.disk_free_bytes ?? null,
        diskTotalBytes: b.disk_total_bytes ?? null,
        diskCheckedAt: b.disk_checked_at ?? null,
        rootFreeBytes: b.root_free_bytes ?? null,
        rootTotalBytes: b.root_total_bytes ?? null,
        diskLow: this.lowBoxes.has(b.id) || (b.disk_free_bytes !== null && b.disk_free_bytes !== undefined && b.disk_free_bytes < floor),
        cleanup: this.janitor.current(b.id),
        operation: this.boxOperation(b.id),
        resize: this.resizeReport(b.id),
        estimatedCostUsd: boxCost({ activeMs: b.active_ms ?? 0, uptimeMs, diskBytes: b.disk_bytes, size, keepAlive: Boolean(b.keep_alive) }, rates),
        usageSource: b.usage_source ?? "estimated",
        createdAt: b.created_at,
        lastUsedAt: b.last_used_at,
      }
    })
  }

  /** Clear, delete or a disk cleanup in progress on a box. */
  private boxOperation(boxId: string): BoxOperation | null {
    const op = this.boxOps.get(boxId)
    if (op) return op
    const reason = this.janitor.runningReason(boxId)
    // Routine upkeep is quick and quiet; it doesn't hold the box's buttons.
    if (!reason || reason === "routine") return null
    return reason === "clear" ? "clear" : "cleanup"
  }

  /** What Clear box and Delete box would touch: each task with its status and uncommitted files, and the disk in use. */
  async boxContents(boxId: string): Promise<BoxContents> {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    const rows = this.store.listTaskRows({ boxId }).sort((a, b) => a.created_at - b.created_at)
    const changed = new Map<string, number>()
    if (box.status === "ready" && rows.length) {
      // One exec for the whole box: "<taskId> <changed files>" per workspace that is a git repo.
      const root = `${this.provider.root(boxId)}/tasks`
      const script = rows
        .map((r) => `[ -d ${q(`${root}/${r.id}/work/.git`)} ] && echo ${q(r.id)} $(git -C ${q(`${root}/${r.id}/work`)} status --porcelain 2>/dev/null | wc -l)`)
        .join("; ")
      const res = await this.provider.exec(boxId, `${script}; true`).catch(() => null)
      for (const line of res?.stdout.split("\n") ?? []) {
        const [id, n] = line.trim().split(/\s+/)
        if (id && n && /^\d+$/.test(n)) changed.set(id, Number(n))
      }
    }
    return {
      boxId,
      tasks: rows.map((r) => ({
        id: r.id,
        title: r.title,
        projectId: r.project_id,
        status: r.status,
        running: Boolean(r.current_turn_id),
        uncommitted: changed.get(r.id) ?? null,
        archived: this.hasFreshArchive(r),
      })),
      running: rows.filter((r) => r.current_turn_id).length,
      diskUsedBytes: box.disk_free_bytes != null && box.disk_total_bytes != null ? Math.max(0, box.disk_total_bytes - box.disk_free_bytes) : null,
      diskBytes: box.disk_bytes ?? null,
    }
  }

  /**
   * Clear box: archive every workspace (the same archive a closed task gets), take it off the box, then drop
   * leftovers, caches and repo mirrors. The box stays. Resting tasks restore from their archive on the next
   * message. Refuses while agents are running unless `stopAgents`. Resolves with the finished report.
   */
  async clearBox(boxId: string, opts: { stopAgents?: boolean } = {}): Promise<BoxCleanup> {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status !== "ready") throw new BadRequestError(`Box ${boxId} is ${box.status}; only a running box can be cleared.`)
    this.claimBox(boxId, "clear", Boolean(opts.stopAgents))
    try {
      return await this.janitor.run(boxId, {
        reason: "clear",
        target: null,
        parkBelow: Number.POSITIVE_INFINITY,
        clear: true,
        before: opts.stopAgents ? () => this.stopAgentsOn(boxId) : undefined,
      })
    } finally {
      this.boxOps.delete(boxId)
      this.diskCache.delete(boxId)
      this.emitBoxes()
      this.schedule()
    }
  }

  /**
   * Delete a box at the provider. A reachable box first gets every workspace archived (the same archive a
   * closed task gets); if one can't be archived nothing is deleted. Refuses while agents are running unless
   * `stopAgents`. Its tasks go to other or new boxes on their next turn.
   */
  async destroyBox(boxId: string, opts: { stopAgents?: boolean } = {}) {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status === "ready") {
      this.claimBox(boxId, "delete", Boolean(opts.stopAgents))
      try {
        if (opts.stopAgents) await this.stopAgentsOn(boxId)
        // A cleanup may be parking workspaces right now; let it finish first.
        while (this.janitor.isRunning(boxId)) await new Promise((r) => setTimeout(r, 200))
        const kept: string[] = []
        for (const row of this.store.listTaskRows({ boxId })) {
          if (await this.skipArchiveIfPushed(row.id, boxId, `delete box ${boxId}`)) continue
          await this.archiveFresh(row.id)
          const fresh = this.store.getTaskRow(row.id)
          if (fresh?.box_id === boxId && fresh.session_started && !this.hasFreshArchive(fresh)) kept.push(fresh.id)
        }
        if (kept.length) throw new ConflictError(`${couldntArchive(kept)}, so ${boxId} was not deleted: ${this.archiveProblems(kept)}`)
      } catch (err) {
        this.boxOps.delete(boxId)
        this.emitBoxes()
        this.schedule()
        throw err
      }
    } else {
      // Lost or still being created: there's no workspace to reach, only turns to end.
      for (const row of this.store.listTaskRows({ boxId })) {
        if (row.current_turn_id) await this.killTurn(row).catch(() => {})
      }
    }
    try {
      await this.loseBox(boxId, withOwner("Box deleted by Cody.", this.owner()))
      await this.provider.destroy(boxId).catch((err) => console.warn(`destroy ${boxId}: ${errorMessage(err)}`))
    } finally {
      this.boxOps.delete(boxId)
    }
  }

  /** Mark a box for clear/delete/resize, or say why not: another operation on it, or agents running without `stopAgents`. */
  private claimBox(boxId: string, op: BoxOp, stopAgents: boolean) {
    const busy = this.boxOperation(boxId)
    if (busy) throw new ConflictError(busyMessage(boxId, busy))
    const running = this.store.listTaskRows({ boxId }).filter((r) => r.current_turn_id).length
    if (running && !stopAgents) throw new ConflictError(`${running} ${running === 1 ? "agent is" : "agents are"} running on ${boxId}: stop ${running === 1 ? "it" : "them"} first.`)
    this.boxOps.set(boxId, op)
    this.emitBoxes()
  }

  /** Stop every agent on a box and wait for their turns to end (they're archived afterwards like any stop). */
  private async stopAgentsOn(boxId: string, timeoutMs = 60_000) {
    const runningRows = () => this.store.listTaskRows({ boxId }).filter((r) => r.current_turn_id)
    for (const row of runningRows()) {
      await this.stopTask(row.id).catch(() => {})
      this.addEvent(row.id, withOwner(`Stopped so Cody could ${this.boxOps.get(boxId) ?? "clear"} box ${boxId}.`, this.owner()))
    }
    const until = Date.now() + timeoutMs
    while (runningRows().length) {
      if (Date.now() > until) throw new ConflictError(`Agents on ${boxId} didn't stop within ${Math.round(timeoutMs / 1000)}s; nothing was removed.`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  // ------------------------------------------------------------------ resize

  /** In place when the provider can change a box's size, else by moving the box's work to a new box. */
  resizeMode(): ResizeMode {
    return this.provider.resize ? "in-place" : "migration"
  }

  /** The running resize of a box, or its last one. */
  resizeReport(boxId: string): BoxResize | null {
    const live = this.resizes.get(boxId)
    if (live) return structuredClone(live)
    const raw = this.store.getKv(resizeKey(boxId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as BoxResize
    } catch {
      return null
    }
  }

  /** Projects with work on a box, or that it was made for. */
  projectsOnBox(boxId: string): string[] {
    const owner = this.store.getKv(boxOwnerKey(boxId))
    return [...new Set([...this.store.listTaskRows({ boxId }).map((r) => r.project_id), ...(owner ? [owner] : [])])]
  }

  /** What resizing a box to `to` would do, and why it can't right now (for the Resize modal). */
  async resizePlan(boxId: string, to: BoxSize): Promise<ResizePlan> {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    const from = normalizeBoxSize(box.size)
    const rows = this.store.listTaskRows({ boxId })
    const fit = compareSizes(to, from) < 0 && box.status === "ready" ? await this.scaleDownFit(boxId, to) : null
    return {
      boxId,
      from,
      to,
      mode: this.resizeMode(),
      running: rows.filter((r) => r.current_turn_id).map((r) => ({ id: r.id, title: r.title })),
      tasks: rows.length,
      fit,
      refusal: this.resizeRefusal(boxId, to, fit),
    }
  }

  /** Would the box's disk in use fit `to` with the free space new workspaces need on top? */
  private async scaleDownFit(boxId: string, to: BoxSize): Promise<DiskFit> {
    // Measured now: a cleanup just before a scale-down should count.
    const space = await this.probeDisk(boxId, 0)
    const box = this.store.getBox(boxId)
    const used = space
      ? Math.max(0, space.totalBytes - space.freeBytes)
      : box?.disk_free_bytes != null && box.disk_total_bytes != null
      ? Math.max(0, box.disk_total_bytes - box.disk_free_bytes)
      : null
    // The same need placement checks before a new workspace: the floor, or its repo's clone size x factor.
    const headroom = Math.max(this.diskNeed(null), ...this.store.listTaskRows({ boxId }).map((r) => this.diskNeed(r)))
    const observed = Number(this.store.getKv(diskTotalKey(to)) ?? NaN)
    return scaleDownFitCheck({ usedBytes: used, to, headroomBytes: headroom, observedTotalBytes: Number.isFinite(observed) ? observed : null })
  }

  private resizeRefusal(boxId: string, to: BoxSize, fit: DiskFit | null): string | null {
    const box = this.store.getBox(boxId)
    if (!box) return `Box ${boxId} not found.`
    if (box.status !== "ready") return `Box ${boxId} is ${box.status}; only a running box can be resized.`
    const from = normalizeBoxSize(box.size)
    if (from === to) return `Box ${boxId} is already ${to}.`
    const busy = this.boxOperation(boxId)
    if (busy) return busyMessage(boxId, busy)
    if (fit && !fit.ok) return `Can't scale ${boxId} down to ${to}: ${fit.reason}`
    return null
  }

  /**
   * Resize a box up or down. Refuses while agents are running unless `stopAgents` (never for MCP callers), and
   * refuses a scale-down whose disk in use wouldn't fit. Answers right away with the running report; progress
   * goes out as SSE `box.resize`. While it runs nothing is placed on the box (or on the new one).
   */
  async resizeBox(boxId: string, to: BoxSize, opts: { stopAgents?: boolean; by?: ResizeInitiator; reason?: string | null } = {}): Promise<BoxResize> {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (!(BOX_SIZES as readonly string[]).includes(to)) throw new BadRequestError(`Unknown size "${to}": use small, medium or large.`)
    const from = normalizeBoxSize(box.size)
    const fit = compareSizes(to, from) < 0 && box.status === "ready" ? await this.scaleDownFit(boxId, to) : null
    const refusal = this.resizeRefusal(boxId, to, fit)
    if (refusal) throw this.boxOperation(boxId) ? new ConflictError(refusal) : new BadRequestError(refusal)
    this.claimBox(boxId, "resize", Boolean(opts.stopAgents))
    const mode = this.resizeMode()
    const running = this.runningOn(boxId)
    const step = (key: ResizeStep["key"], label: string, skip = false): ResizeStep => ({ key, label, status: skip ? "skipped" : "pending", detail: null })
    const r: BoxResize = {
      id: `rsz_${randomUUID().slice(0, 12)}`,
      boxId,
      newBoxId: null,
      from,
      to,
      mode,
      status: "running",
      steps: [
        ...(opts.stopAgents && running ? [step("stop", `Stop ${running} running ${running === 1 ? "agent" : "agents"}`)] : []),
        ...(mode === "in-place"
          ? [step("resize", `Resize ${boxId} to ${to}`)]
          : [
              step("create", `Create a ${to} box`),
              step("archive", "Archive every workspace"),
              step("move", "Move tasks and projects to the new box"),
              step("delete", `Delete ${boxId}`),
            ]),
      ],
      movedTasks: [],
      by: opts.by ?? { kind: "cody" },
      reason: opts.reason?.trim() || null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    }
    this.resizes.set(boxId, r)
    this.publishResize(r)
    console.log(`[box-yard] resizing box ${boxId} ${from} -> ${to} (${mode})`)
    void this.runResize(r, Boolean(opts.stopAgents))
    return structuredClone(r)
  }

  private async runResize(r: BoxResize, stopAgents: boolean) {
    try {
      if (stopAgents && r.steps.some((s) => s.key === "stop")) {
        await this.resizeStep(r, "stop", async () => {
          await this.stopAgentsOn(r.boxId)
          return null
        })
      }
      // A cleanup may be parking workspaces right now; let it finish first.
      while (this.janitor.isRunning(r.boxId)) await new Promise((res) => setTimeout(res, 200))
      if (r.mode === "in-place") await this.resizeInPlace(r)
      else await this.resizeByMigration(r)
      this.finishResize(r, "done")
    } catch (err) {
      const step = r.steps.find((s) => s.status === "failed")
      this.finishResize(r, "failed", step ? `${RESIZE_STEP_NAMES[step.key]} step failed: ${errorMessage(err)}` : errorMessage(err))
    }
  }

  private async resizeInPlace(r: BoxResize) {
    await this.resizeStep(r, "resize", async () => {
      await this.provider.resize!(r.boxId, r.to)
      this.store.meterBox(r.boxId, { size: r.to })
      this.diskCache.delete(r.boxId)
      this.lowBoxes.delete(r.boxId)
      const space = await this.probeDisk(r.boxId, 0)
      return space ? `now ${sizeSpecLine(r.to)}; ${diskLine({ freeBytes: space.freeBytes, totalBytes: space.totalBytes })}` : `now ${sizeSpecLine(r.to)}`
    })
  }

  /**
   * Resize without provider support: a new box of the target size takes over. Every workspace is archived first
   * (the same archive a closed task gets; nothing moves if one can't be), then the tasks and the box's project are
   * pointed at the new box and the old one is deleted. Workspaces restore from their archive on their next turn.
   */
  private async resizeByMigration(r: BoxResize) {
    const old = this.store.getBox(r.boxId)!
    const owner = this.store.getKv(boxOwnerKey(r.boxId))
    let created: string | null = null
    try {
      await this.resizeStep(r, "create", async () => {
        // Counted like a pool box being created, so the orphan sweep leaves it alone until it's in the database.
        this.creatingBoxes++
        let id: string
        try {
          id = await this.provider.create({ labels: this.boxLabels(owner), size: r.to })
          this.store.upsertBox({ id, provider: this.provider.name, status: "ready", created_at: Date.now(), last_used_at: Date.now(), size: r.to, keep_alive: old.keep_alive, usage_source: "estimated" })
        } catch (err) {
          throw new Error(`Couldn't create a ${r.to} box: ${errorMessage(err)}`)
        } finally {
          this.creatingBoxes--
        }
        created = id
        // Nothing lands on it until the move is done.
        this.boxOps.set(id, "resize")
        r.newBoxId = id
        this.resizes.set(id, r)
        void this.refreshBoxUsage(id, true).catch(() => {})
        return id
      })
      await this.resizeStep(r, "archive", async () => {
        const kept: string[] = []
        const fromGitHub: string[] = []
        const rows = this.store.listTaskRows({ boxId: r.boxId })
        for (const row of rows) {
          if (await this.skipArchiveIfPushed(row.id, r.boxId, `move to the ${r.to} box`)) {
            fromGitHub.push(row.id)
            continue
          }
          await this.archiveFresh(row.id)
          const fresh = this.store.getTaskRow(row.id)
          if (fresh?.box_id === r.boxId && fresh.session_started && !this.hasFreshArchive(fresh)) kept.push(fresh.id)
        }
        if (kept.length) throw new ConflictError(`${couldntArchive(kept)}, so nothing moved and ${r.boxId} keeps its work: ${this.archiveProblems(kept)}`)
        if (!rows.length) return "no workspaces on the box"
        const archived = rows.length - fromGitHub.length
        const parts = [
          ...(archived ? [`${archived} ${archived === 1 ? "workspace" : "workspaces"} archived`] : []),
          ...(fromGitHub.length ? [`${fromGitHub.length} restorable from GitHub (PR merged, nothing unpushed)`] : []),
        ]
        return parts.join(", ")
      })
    } catch (err) {
      // Nothing moved to it, so it must not sit there empty (and billed).
      if (created) r.cleanup = await this.dropBox(created)
      throw err
    }
    const to = r.newBoxId!
    await this.resizeStep(r, "move", async () => {
      for (const row of this.store.listTaskRows({ boxId: r.boxId })) {
        this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
        this.assign(row.id, to, { touch: false })
        r.movedTasks.push(row.id)
        const back = row.archive_path
          ? "The workspace comes back from its archive on the next turn."
          : row.session_started
          ? "The next turn starts from a recap, on a fresh checkout of its branch."
          : "Its workspace is set up there on its first turn."
        this.addEvent(row.id, `Moved to box ${to} (${r.to}) while ${r.boxId} was resized. ${back}`)
        this.emitTask(row.id)
      }
      if (owner) this.store.setKv(boxOwnerKey(to), owner)
      for (const p of this.store.listProjects()) if (this.store.getKv(projectBoxKey(p.id)) === r.boxId) this.store.setKv(projectBoxKey(p.id), to)
      const n = r.movedTasks.length
      return n ? `${n} ${n === 1 ? "task" : "tasks"} moved to ${to}` : `nothing to move; ${to} takes over`
    })
    await this.resizeStep(r, "delete", async () => {
      await this.loseBox(r.boxId, `Box ${r.boxId} was resized.`, true)
      try {
        await this.provider.destroy(r.boxId)
        return null
      } catch (err) {
        // The work already moved; a box the provider didn't delete is only a leftover.
        console.warn(`destroy ${r.boxId}: ${errorMessage(err)}`)
        return `couldn't delete it at the provider (${errorMessage(err)}); remove it there`
      }
    })
  }

  /**
   * Delete a box Box Yard made but never used (a failed migration). Its row stays, as "deleting", until the provider
   * confirms, so a failed delete is retried (maintain) instead of leaving a box nobody sees. Says what happened.
   */
  private async dropBox(boxId: string): Promise<string> {
    const box = this.store.getBox(boxId)
    this.boxOps.delete(boxId)
    this.resizes.delete(boxId)
    this.store.setKv(boxOwnerKey(boxId), null)
    if (!box) return `The new box ${boxId} is already gone.`
    this.store.setBoxStatus(boxId, "deleting")
    this.emitBoxes()
    try {
      await this.provider.destroy(boxId)
      this.store.removeBox(boxId)
      console.log(`[box-yard] deleted unused box ${boxId}`)
      return `Deleted the new ${normalizeBoxSize(box.size)} box ${boxId}.`
    } catch (err) {
      console.warn(`[box-yard] destroy ${boxId}: ${errorMessage(err)}`)
      return `Couldn't delete the new box ${boxId} yet (${errorMessage(err)}); Box Yard keeps trying.`
    } finally {
      this.emitBoxes()
    }
  }

  /**
   * Boxes that must not linger: ones whose delete failed (status "deleting"), and empty boxes a failed resize made
   * that are still here (a restart mid-resize, or a failure from before failed resizes cleaned up after themselves).
   */
  private async reclaimUnusedBoxes(now: number) {
    for (const box of [...this.store.listDeletingBoxes(), ...this.store.listBoxes()]) {
      if (this.boxOps.has(box.id) || this.store.listTaskRows({ boxId: box.id }).length) continue
      if (box.status === "deleting") {
        if (now - (this.lastReclaimAt.get(box.id) ?? 0) < 5 * 60_000) continue
        this.lastReclaimAt.set(box.id, now)
        const made = this.resizeReport(box.id)
        const note = await this.dropBox(box.id)
        if (made?.newBoxId === box.id && made.boxId !== box.id) this.noteResizeCleanup(made, note)
        continue
      }
      const r = this.resizeReport(box.id)
      if (box.status !== "ready" || r?.status !== "failed" || r.newBoxId !== box.id || r.boxId === box.id) continue
      // Used since (it took tasks once the resize gave up): it's a pool box like any other now.
      if (box.last_used_at > (r.finishedAt ?? r.startedAt) + 60_000) continue
      const note = await this.dropBox(box.id)
      console.log(`[box-yard] reclaimed ${box.id}, left empty by the failed resize of ${r.boxId}: ${note}`)
      this.noteResizeCleanup(r, note)
    }
  }

  /** Add what happened to a failed resize's new box to its report, on the box that was being resized. */
  private noteResizeCleanup(r: BoxResize, note: string) {
    const current = this.resizeReport(r.boxId)
    if (current?.id !== r.id) return
    const updated = { ...current, cleanup: note }
    this.store.setKv(resizeKey(r.boxId), JSON.stringify(updated))
    this.hub.broadcast({ type: "box.resize", resize: updated })
  }

  private async resizeStep(r: BoxResize, key: ResizeStep["key"], fn: () => Promise<string | null>) {
    const s = r.steps.find((x) => x.key === key)!
    s.status = "running"
    this.publishResize(r)
    try {
      s.detail = await fn()
      s.status = "done"
    } catch (err) {
      s.status = "failed"
      s.detail = errorMessage(err)
      throw err
    } finally {
      this.publishResize(r)
    }
  }

  private publishResize(r: BoxResize) {
    const copy = structuredClone(r)
    for (const id of [r.boxId, r.newBoxId]) if (id) this.store.setKv(resizeKey(id), JSON.stringify(copy))
    this.hub.broadcast({ type: "box.resize", resize: copy })
    this.emitBoxes()
  }

  private finishResize(r: BoxResize, status: "done" | "failed", error: string | null = null) {
    r.status = status
    r.error = error
    r.finishedAt = Date.now()
    for (const s of r.steps) if (s.status === "pending" || s.status === "running") s.status = s.status === "running" ? "failed" : "skipped"
    for (const id of [r.boxId, r.newBoxId]) {
      if (!id) continue
      if (this.boxOps.get(id) === "resize") this.boxOps.delete(id)
      this.resizes.delete(id)
    }
    this.diskCache.delete(r.boxId)
    this.publishResize(r)
    console.log(`[box-yard] resize of ${r.boxId} ${status}${error ? `: ${error}` : ""}`)
    if (r.by.kind !== "cody") this.announceResize(r)
    this.schedule()
  }

  /** A resize the Coordinator or a Captain made: a notice for the Coordinator and the box's Captains, and a notification for Cody. */
  private announceResize(r: BoxResize) {
    const captainProject = r.by.kind === "captain" ? r.by.projectId : null
    const who = initiatorLabel(r.by, captainProject ? this.store.getProject(captainProject)?.name : undefined)
    const boxId = r.newBoxId && r.status === "done" ? r.newBoxId : r.boxId
    const projectIds = [...new Set(this.store.listTaskRows({ boxId }).map((t) => t.project_id).concat(this.store.getKv(boxOwnerKey(boxId)) ?? []))].filter(
      (id) => this.store.getProject(id),
    )
    const why = r.reason ? ` Reason: ${r.reason}` : ""
    const content =
      r.status === "done"
        ? `📦 ${who} resized box ${r.boxId} ${r.from} → ${r.to}: ${resizeSummary(r)}.${why}`
        : `⚠️ ${who} couldn't resize box ${r.boxId} ${r.from} → ${r.to}: ${resizeSummary(r)}${/[.!?]$/.test(resizeSummary(r)) ? "" : "."}${why}`
    this.notice(content, { boxId, resizeId: r.id, projectIds, ...(captainProject ? { captainProjectId: captainProject } : {}) })
    const names = projectIds.map((id) => this.store.getProject(id)!.name)
    this.store.addBoxNotification({
      boxId,
      title: resizeTitle(r),
      summary: `${who}${r.reason ? `: ${r.reason}` : ""}${r.status === "failed" ? ` (${r.error ?? "failed"})` : ""}`,
      status: r.status === "done" ? "done" : "failed",
      projectId: projectIds[0],
      projectName: names.join(", "),
    })
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
      // A workspace about to be made here takes disk the next placement mustn't count on.
      if (row.box_id !== boxId) this.reserve(boxId, row.id, this.cloneBytes(row) ?? 0)
      // Reserve the slot before any await so parallel passes see it taken.
      this.store.updateTask(row.id, {
        status: "starting",
        boxId,
        currentTurnId: turnId,
        error: null,
        waitReason: null,
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
      const need = Math.ceil(n / this.sizeLimits(this.newBoxSize(projectId)).slotsPerBox) - (this.creatingFor.get(projectId) ?? 0)
      for (let i = 0; i < need && this.poolHasRoom(); i++) void this.createBox(projectId)
    }
  }

  /** Pick a box for a task's next turn, or null to wait. */
  private async place(row: TaskRow): Promise<string | null> {
    // A cleanup step is working in its folder right now.
    if (this.janitor.isBusy(row.id)) return null
    const op = row.box_id ? this.boxOps.get(row.box_id) : undefined
    if (op) {
      // Its workspace is being archived off the box; it moves to another box once that's done.
      this.setWaitReason(row.id, `Waiting while box ${row.box_id} is ${op === "clear" ? "cleared" : op === "resize" ? "resized" : "deleted"}`)
      return null
    }
    if (row.box_id) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "ready") {
        // It ran out of space here; its workspace stays, so it waits for the cleanup on this box.
        if (this.diskHold.get(row.id) === box.id && this.janitor.isRunning(box.id)) {
          this.setWaitReason(row.id, `Waiting for disk cleanup on ${box.id}`)
          return null
        }
        if (this.runningOn(box.id) < this.slotsFor(box.id)) return box.id
        // Its box is busy. Move to a free box if the archive is fresh enough.
        if (!this.hasFreshArchive(row)) return null
        const other = await this.pickBox(row.id, box.id)
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
    const boxId = await this.pickBox(row.id)
    return boxId ? this.assign(row.id, boxId) : null
  }

  /**
   * Pick a box for a task. A project keeps its work together, so the order is:
   * 1. a box that already hosts this project (warm repo mirror, shared files),
   * 2. an empty box,
   * 3. nothing yet, when the pool has room: a new box is made for the project,
   * 4. a free slot on a box another project uses (the pool is full).
   * A box without enough free disk for a new workspace is skipped and cleaned up
   * in the background; the task waits for that cleanup only when no other box
   * (or new one) can take it.
   * Returns null to wait; `wantsBox` tells the scheduler to grow the pool.
   */
  private async pickBox(taskId: string, exclude?: string): Promise<string | null> {
    const row = this.store.getTaskRow(taskId)
    const projectId = row?.project_id
    const preferred = projectId ? this.store.getKv(projectBoxKey(projectId)) : null
    const candidates = this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && b.id !== exclude && !this.boxOps.has(b.id))
      .map((b) => {
        const residents = this.store.listTaskRows({ boxId: b.id }).filter((r) => r.id !== taskId)
        // A box made for a project belongs to it, even before its first task lands.
        const owner = this.store.getKv(boxOwnerKey(b.id))
        const mine = residents.some((r) => r.project_id === projectId) || b.id === preferred || owner === projectId
        const others = residents.some((r) => r.project_id !== projectId) || Boolean(owner && owner !== projectId)
        // 0 = this project's box, 1 = empty unowned box, 2 = another project's box
        const rank = mine ? 0 : others ? 2 : 1
        const limits = this.sizeLimits(normalizeBoxSize(b.size))
        return { id: b.id, rank, running: residents.filter((r) => r.current_turn_id).length, residents: residents.length, ...limits }
      })
      .filter((b) => b.running < b.slotsPerBox)
      .sort((a, b) => a.rank - b.rank || a.running - b.running || a.residents - b.residents)
    const low: { boxId: string; state: "running" | "exhausted" }[] = []
    for (const b of candidates) {
      if (b.rank === 2 && this.poolHasRoom()) {
        // Rather than crowd another project's box, make one for this project.
        this.wantsBox.add(taskId)
        this.holdForDisk(taskId, low)
        return null
      }
      if (b.residents >= b.maxResidentPerBox && !this.canEvict(b.id, taskId)) continue
      const room = row ? await this.diskRoom(b.id, row) : "ok"
      if (room !== "ok") {
        low.push({ boxId: b.id, state: room })
        continue
      }
      if (b.residents < b.maxResidentPerBox || this.evictOne(b.id, taskId)) {
        this.wantsBox.delete(taskId)
        this.holdForDisk(taskId, [])
        return b.id
      }
    }
    if (this.poolHasRoom()) this.wantsBox.add(taskId)
    else {
      // Its setup already ran out of space once and no box has room even after cleanup:
      // the threshold is cautious, so make the one retry on the cleaned box instead of waiting forever.
      const cleaned = this.diskRetried.has(taskId) ? low.find((l) => l.state === "exhausted") : undefined
      if (cleaned && (this.store.listTaskRows({ boxId: cleaned.boxId }).filter((r) => r.id !== taskId).length < this.residentsFor(cleaned.boxId) || this.evictOne(cleaned.boxId, taskId))) {
        this.holdForDisk(taskId, [])
        return cleaned.boxId
      }
    }
    this.holdForDisk(taskId, low)
    return null
  }

  /**
   * Pre-flight disk check for a new workspace on a box: "ok", or the state of the
   * cleanup it just started (or that already did all it could) when the box is low.
   */
  private async diskRoom(boxId: string, row: TaskRow): Promise<"ok" | "running" | "exhausted"> {
    const space = await this.probeDisk(boxId, DISK_CACHE_MS)
    // df failing shouldn't stop work; a real shortage shows up as ENOSPC and is retried.
    if (!space) return "ok"
    const need = this.diskNeed(row)
    let pending = 0
    for (const [id, bytes] of this.reserved.get(boxId) ?? []) if (id !== row.id) pending += bytes
    if (space.freeBytes - pending >= need) {
      if (this.lowBoxes.delete(boxId)) this.emitBoxes()
      return "ok"
    }
    if (!this.lowBoxes.has(boxId)) {
      this.lowBoxes.add(boxId)
      console.log(`[box-yard] box ${boxId} is low on disk: ${formatBytes(space.freeBytes)} free, ${formatBytes(need + pending)} needed`)
      this.emitBoxes()
    }
    return this.janitor.ensure(boxId, need + pending)
  }

  /** Say on a queued task why it's waiting when that's about disk space, or clear it. */
  private holdForDisk(taskId: string, low: { boxId: string; state: "running" | "exhausted" }[]) {
    const first = low[0]
    let reason: string | null = null
    if (first) {
      if (this.wantsBox.has(taskId)) reason = `Waiting for a new box: ${first.boxId} is low on disk`
      else if (first.state === "running" || low.some((l) => this.janitor.isRunning(l.boxId))) {
        reason = `Waiting for disk cleanup on ${low.find((l) => this.janitor.isRunning(l.boxId))?.boxId ?? first.boxId}`
      } else reason = `Waiting for disk space on ${first.boxId}: cleanup couldn't free enough room`
    }
    this.setWaitReason(taskId, reason)
  }

  private setWaitReason(taskId: string, reason: string | null) {
    const row = this.store.getTaskRow(taskId)
    if (!row || (row.wait_reason ?? null) === reason) return
    this.store.updateTask(taskId, { waitReason: reason }, { touch: false })
    if (reason) this.addEvent(taskId, `${reason}.`)
    this.emitTask(taskId)
  }

  /** df on a box's work disk, cached for `maxAgeMs`. Saves the numbers on the box row for the Boxes page. */
  async probeDisk(boxId: string, maxAgeMs = DISK_CACHE_MS): Promise<DiskSpace | null> {
    const hit = this.diskCache.get(boxId)
    if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return hit.space
    const res = await this.provider.exec(boxId, dfCommand(this.provider.root(boxId))).catch(() => null)
    const space = res && res.exitCode === 0 ? parseDf(res.stdout) : null
    if (!space) return null
    const now = Date.now()
    this.diskCache.set(boxId, { at: now, space })
    if (this.store.getBox(boxId)) {
      const before = this.store.getBox(boxId)
      const size = normalizeBoxSize(before?.size)
      if (space.totalBytes > 0 && this.store.getKv(diskTotalKey(size)) !== String(space.totalBytes)) this.store.setKv(diskTotalKey(size), String(space.totalBytes))
      const root = space.root ?? null
      this.store.meterBox(boxId, { diskFreeBytes: space.freeBytes, diskTotalBytes: space.totalBytes, diskCheckedAt: now, rootFreeBytes: root?.freeBytes ?? null, rootTotalBytes: root?.totalBytes ?? null })
      // A real change is worth a Boxes update (df runs often while placing), and so is a stale
      // "measured … ago" on the page.
      const changed =
        Math.abs((before?.disk_free_bytes ?? 0) - space.freeBytes) > 16 * 1024 * 1024 ||
        before?.disk_total_bytes !== space.totalBytes ||
        Math.abs((before?.root_free_bytes ?? 0) - (root?.freeBytes ?? 0)) > 16 * 1024 * 1024
      if (changed || now - (before?.disk_checked_at ?? 0) > 60_000) this.emitBoxes()
    }
    return space
  }

  /** Free disk a new workspace for `row` needs (Settings: the floor, or cloneFactor x its repo's last clone size). */
  private diskNeed(row: TaskRow | null): number {
    const s = this.settings.get()
    return requiredFreeBytes({ minFreeMb: s.diskMinFreeMb, cloneFactor: s.diskCloneFactor }, row ? this.cloneBytes(row) : null)
  }

  /** The task's repo's last measured clone size, if Box Yard has cloned it before. */
  private cloneBytes(row: TaskRow): number | null {
    const mirror = this.repoMirrorName(this.store.getProject(row.project_id)?.repo ?? null)
    const raw = mirror ? this.store.getKv(cloneBytesKey(mirror)) : null
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  }

  private reserve(boxId: string, taskId: string, bytes: number) {
    const m = this.reserved.get(boxId) ?? new Map<string, number>()
    m.set(taskId, bytes)
    this.reserved.set(boxId, m)
  }

  private release(boxId: string, taskId: string) {
    const m = this.reserved.get(boxId)
    if (!m?.delete(taskId)) return
    if (!m.size) this.reserved.delete(boxId)
    // The workspace landed (or didn't): the next check reads df again.
    this.diskCache.delete(boxId)
  }

  /**
   * Clean up a box now (the Boxes page button). Runs every safe step; done
   * workspaces are parked only while the box is below the low-disk threshold.
   * Resolves with the first report (status "running") without waiting for the end.
   */
  async cleanBox(boxId: string): Promise<BoxCleanup> {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status !== "ready") throw new BadRequestError(`Box ${boxId} is ${box.status}; only a running box can be cleaned up.`)
    const op = this.boxOps.get(boxId)
    if (op && !this.janitor.isRunning(boxId)) throw new ConflictError(busyMessage(boxId, op))
    // Routine upkeep is short: let it finish, then run the full cleanup that was asked for.
    if (this.janitor.runningReason(boxId) === "routine") await this.janitor.settle(boxId)
    if (!this.janitor.isRunning(boxId)) void this.janitor.run(boxId, { reason: "manual", target: null, parkBelow: this.diskNeed(null) })
    return this.janitor.current(boxId)!
  }

  private cleanupFinished(report: BoxCleanup) {
    this.diskCache.delete(report.boxId)
    if (report.enough && report.targetFreeBytes !== null) this.lowBoxes.delete(report.boxId)
    const summary = cleanupSummary(report)
    // At most one "still low" notice per box an hour: each one can wake the Coordinator.
    const quiet = Date.now() - (this.lowDiskNoticeAt.get(report.boxId) ?? 0) < 60 * 60_000
    if (report.reason !== "manual" && !report.enough && !quiet && this.store.getBox(report.boxId)) {
      this.lowDiskNoticeAt.set(report.boxId, Date.now())
      const free = diskLine({ freeBytes: report.freeAfter, totalBytes: report.totalBytes, checkedAt: report.finishedAt })
      this.notice(
        `⚠️ Box ${report.boxId} is low on disk: cleanup ${summary}, and it has ${free}; new workspaces need ${formatBytes(report.targetFreeBytes)} free. ` +
          `Tasks that can't go elsewhere wait for room. Add a box (raise Max boxes) or free space on it.`,
      )
    }
    this.emitBoxes()
    this.schedule()
  }

  /** Repo mirrors a box still needs: those of its tasks' projects and of the project it was made for. */
  private mirrorsToKeep(boxId: string, includeOwner = true): Set<string> {
    const keep = new Set<string>()
    for (const row of this.store.listTaskRows({ boxId })) {
      const name = this.repoMirrorName(this.store.getProject(row.project_id)?.repo ?? null)
      if (name) keep.add(name)
    }
    const owner = includeOwner ? this.store.getKv(boxOwnerKey(boxId)) : null
    if (owner) {
      const name = this.repoMirrorName(this.store.getProject(owner)?.repo ?? null)
      if (name) keep.add(name)
    }
    return keep
  }

  /** Take a resting task's folder off its box; it restores from its archive on the next message. */
  private async park(taskId: string, boxId: string, note: string) {
    this.store.updateTask(taskId, { boxId: null, portBase: null, previews: [] }, { touch: false })
    await this.removeTaskDir(boxId, taskId)
    this.addEvent(taskId, note)
    this.emitTask(taskId)
  }

  /**
   * Emergency cleanup: remove a done task's folder without an archive because its PR is merged and nothing in it is
   * unpushed (the janitor checked), so GitHub has all of it. An older archive is let go too: the next message starts
   * from a recap of the task instead of an out-of-date session.
   */
  private async dropPushed(taskId: string, boxId: string) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    this.store.updateTask(taskId, { boxId: null, portBase: null, previews: [], archivePath: null, lastArchivedAt: null }, { touch: false })
    if (row.archive_path) this.store.noteTaskArchiveUnavailable(taskId, row.archive_path, "out of date; workspace removed after its PR merged")
    await this.removeTaskDir(boxId, taskId)
    const pr = prNumber(row.pr_url)
    console.log(`[box-yard] removed workspace ${taskId} from ${boxId} without an archive: PR${pr ? ` #${pr}` : ""} merged, nothing unpushed`)
    this.addEvent(
      taskId,
      `Workspace removed from box ${boxId} to free disk, without an archive: its PR${pr ? ` #${pr}` : ""} is merged and nothing in it was unpushed, so GitHub has all of it. The next message starts from a recap.`,
    )
    this.emitTask(taskId)
  }

  /**
   * A done task whose PR is merged and whose folder holds nothing GitHub lacks (the janitor's pushedCheck): it
   * needs no archive to leave its box.
   */
  private async pushedOnGitHub(taskId: string, boxId: string): Promise<boolean> {
    const row = this.store.getTaskRow(taskId)
    if (!row || row.box_id !== boxId || row.status !== "done" || row.pr_state !== "merged" || row.current_turn_id || this.store.hasInputs(row.id)) return false
    const res = await this.provider.exec(boxId, pushedCheck(`${this.taskDir(boxId, taskId)}/work`)).catch(() => null)
    return res ? pushedVerdict(res.stdout) === "yes" : false
  }

  /**
   * Before a box operation that needs every workspace archived (resize, Delete box): a merged and fully pushed
   * task skips the archive. It's recorded as restorable from GitHub — no archive, so its next message starts from
   * a recap — like the emergency cleanup does, and doesn't hold the operation up. True when it did.
   */
  private async skipArchiveIfPushed(taskId: string, boxId: string, operation: string): Promise<boolean> {
    const row = this.store.getTaskRow(taskId)
    if (!row || this.hasFreshArchive(row) || !(await this.pushedOnGitHub(taskId, boxId))) return false
    this.store.updateTask(taskId, { archivePath: null, lastArchivedAt: null }, { touch: false })
    if (row.archive_path) this.store.noteTaskArchiveUnavailable(taskId, row.archive_path, "out of date; GitHub has the merged work")
    const pr = prNumber(row.pr_url)
    console.log(`[box-yard] ${taskId} needs no archive to ${operation}: PR${pr ? ` #${pr}` : ""} merged, nothing unpushed`)
    this.addEvent(
      taskId,
      `No archive needed to ${operation}: its PR${pr ? ` #${pr}` : ""} is merged and nothing in the workspace was unpushed, so GitHub has all of it. The next message starts from a recap.`,
    )
    return true
  }

  /** Room to create another box (and box creation isn't failing right now). */
  private poolHasRoom() {
    const recentlyFailed = this.lastBoxError && Date.now() - this.lastBoxError.at < BOX_RETRY_MS
    // listBoxes() includes the placeholders of boxes being created.
    return !recentlyFailed && this.store.listBoxes().length < this.limits().maxBoxes
  }

  /** Give a task a home on a box, with its own block of preview ports. */
  private assign(taskId: string, boxId: string, opts: { touch?: boolean } = {}): string {
    const used = new Set(
      this.store
        .listTaskRows({ boxId })
        .map((r) => r.port_base)
        .filter((p): p is number => p !== null),
    )
    let port = PORT_BASE
    while (used.has(port)) port += 10
    this.store.updateTask(taskId, { boxId, portBase: port }, opts)
    const projectId = this.store.getTaskRow(taskId)?.project_id
    if (projectId) this.store.setKv(projectBoxKey(projectId), boxId)
    return boxId
  }

  private canEvict(boxId: string, forTaskId: string) {
    return Boolean(this.evictionVictim(boxId, forTaskId))
  }

  private evictionVictim(boxId: string, forTaskId: string) {
    return this.store
      .listTaskRows({ boxId })
      .filter(
        (r) =>
          r.id !== forTaskId &&
          !r.current_turn_id &&
          RESTING.includes(r.status) &&
          this.hasFreshArchive(r),
      )
      .sort((a, b) => a.last_active_at - b.last_active_at)[0]
  }

  /** Free a folder on a full box by removing the least recently used, archived, resting task. */
  private evictOne(boxId: string, forTaskId: string): boolean {
    const victim = this.evictionVictim(boxId, forTaskId)
    if (!victim) return false
    this.store.updateTask(victim.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(boxId, victim.id).catch(() => {})
    this.addEvent(victim.id, `Workspace parked in the archive to make room on box ${boxId}. It comes back on the next message.`)
    this.emitTask(victim.id)
    return true
  }

  private boxLabels(projectId?: string | null) {
    const project = projectId ? this.store.getProject(projectId) : null
    return ["boxyard", this.installLabel(), ...(project ? [`p-${slugify(project.name)}`] : [])]
  }

  private async createBox(projectId?: string) {
    this.creatingBoxes++
    if (projectId) this.creatingFor.set(projectId, (this.creatingFor.get(projectId) ?? 0) + 1)
    const placeholder = `creating-${randomUUID().slice(0, 8)}`
    const size = this.newBoxSize(projectId)
    this.store.upsertBox({ id: placeholder, provider: this.provider.name, status: "creating", created_at: Date.now(), last_used_at: Date.now(), size, keep_alive: 0, usage_source: "estimated" })
    this.emitBoxes()
    const project = projectId ? this.store.getProject(projectId) : null
    try {
      const labels = this.boxLabels(projectId)
      const id = await this.provider.create({ labels, size })
      this.store.removeBox(placeholder)
      this.store.upsertBox({ id, provider: this.provider.name, status: "ready", created_at: Date.now(), last_used_at: Date.now(), size, keep_alive: 0, usage_source: "estimated" })
      // The new box belongs to the project that asked for it, so its tasks land there.
      if (projectId && this.store.getProject(projectId)) {
        this.store.setKv(projectBoxKey(projectId), id)
        this.store.setKv(boxOwnerKey(id), projectId)
      }
      void this.refreshBoxUsage(id, true).finally(() => {
        this.emitBoxes()
        this.schedule()
      })
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
    /** The workspace is being made fresh, so a failure leaves nothing worth keeping in its folder. */
    let fresh = false
    try {
      await this.provider.wake(boxId)
      const project = this.store.getProject(row.project_id)
      if (!project) throw new Error("Project was deleted")

      const check = await this.provider.exec(boxId, `[ -d ${q(dir + "/work")} ] && echo present || echo missing`)
      if (check.exitCode !== 0) throw new Error(`box not responding: ${check.stderr.slice(-300)}`)
      fresh = check.stdout.includes("missing")
      const prepared = fresh ? await this.prepareWorkspace(row, boxId, dir) : null
      this.release(boxId, taskId)
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
      // The prompt gets the notes that fit the budget and says how many didn't; read_notes still has them all.
      const budgeted = budgetNotes(notes, noteBudgetOf(this.settings.get(), project))
      const projectName = (id: string) => this.store.getProject(id)?.name
      const ownerName = this.owner()
      const followup = followupPrompt(inputs.length ? inputs : [{ source: "system", content: "Continue." }], projectName, ownerName)
      if (recapped) {
        row = this.recapSession(row, prepared!.branch, project.baseBranch)
      }
      const prompt = compact
        ? "/compact"
        : firstTurn
        ? firstTurnPrompt({ task: row, notes: budgeted.shown, hiddenNotes: budgeted.hidden.length, directory, extraInputs: inputs.length ? [followup] : [], ownerName })
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
          systemPrompt: workerSystemPrompt({ project, task: row, branch: row.branch, port: row.port_base ?? PORT_BASE, ownerName, pushAtTurnEnd: this.pushAtTurnEnd(project) }),
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

      const merge = this.store.mergeRequestOf(row)
      if (merge && !merge.deliveredAt && queued.some((i) => i.id === merge.inputId)) {
        this.store.updateTask(taskId, { mergeRequest: { ...merge, deliveredAt: Date.now() } }, { quiet: true, touch: false })
      }
      this.store.deleteInputs(queued.map((i) => i.id))
      this.diskRetried.delete(taskId)
      this.diskHold.delete(taskId)
      const flags = this.store.turnFlags(row)
      // Hooks whose prompts are in this turn (a retried turn keeps the interrupted one's), so they don't fire on it.
      const hookIds = [...new Set([...queued.filter((i) => i.source.startsWith("hook:")).map((i) => i.source.slice("hook:".length)), ...(flags.interrupts ? (flags.hookIds ?? []) : [])])]
      this.store.updateTask(taskId, {
        status: "working",
        sessionStarted: true,
        ...(compact ? { compacting: true, compactPending: false } : { turnCount: row.turn_count + 1 }),
        turnFlags: { interrupts: flags.interrupts, ...(hookIds.length ? { hookIds } : {}) } as TurnFlags,
        lastActiveAt: Date.now(),
        question: null,
      })
      this.lastEventAt.set(taskId, Date.now())
      this.emitTask(taskId)
      this.publishDirectory()
      this.holdOpen(taskId, boxId)
      if (this.stopRequested.has(taskId)) await this.killTurn(this.requireRow(taskId)).catch(() => {})
    } catch (err) {
      this.release(boxId, taskId)
      const stopped = err instanceof StoppedBeforeStart
      this.stopRequested.delete(taskId)
      let message = errorMessage(err)
      if (!stopped) console.error(`[box-yard] launch ${taskId} on ${boxId} failed: ${message}`)
      const current = this.store.getTaskRow(taskId)
      if (!current) return
      // A compaction that couldn't start isn't worth failing the task over.
      const wasCompact = Boolean(current.compact_pending || current.compacting)
      const outOfSpace = !stopped && isOutOfSpace(message)
      if (outOfSpace && !wasCompact && !this.diskRetried.has(taskId)) {
        this.store.finishTaskTurn(turnId, { status: "failed", error: message })
        await this.retryAfterOutOfSpace(current, boxId, fresh)
        return
      }
      if (outOfSpace) {
        this.diskRetried.delete(taskId)
        this.diskHold.delete(taskId)
        const space = await this.probeDisk(boxId, 0)
        message = `box ${boxId} is out of disk space${space ? ` (${diskLine({ freeBytes: space.freeBytes, totalBytes: space.totalBytes })})` : ""}, even after cleaning it up and retrying. Free space on it or add a box, then retry. ${message}`
      }
      this.store.finishTaskTurn(turnId, { status: stopped ? "stopped" : "failed", error: stopped ? null : message })
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
        // The inputs stay queued when a launch fails; a hook's among them caused this, so it mustn't fire on it.
        const originHookIds = this.store.peekInputs(taskId).filter((i) => i.source.startsWith("hook:")).map((i) => i.source.slice("hook:".length))
        this.emitTaskEvent({ type: "task.failed", taskId, turnId, originHookIds })
        const health = await this.provider.health(boxId).catch(() => "unknown" as const)
        if (health === "gone" || health === "error") await this.loseBox(boxId, `Box ${boxId} is ${health}.`)
      }
      this.emitTask(taskId)
      this.schedule()
    }
  }

  /**
   * The box ran out of disk while setting the task up. Clean that box up and try
   * once more: a fresh workspace is dropped (it was half-made) and placed again,
   * on another box if one has room; an existing workspace waits for the cleanup
   * on its own box. The task stays queued with a visible reason meanwhile.
   */
  private async retryAfterOutOfSpace(row: TaskRow, boxId: string, fresh: boolean) {
    this.diskRetried.add(row.id)
    this.diskCache.delete(boxId)
    this.lowBoxes.add(boxId)
    const need = this.diskNeed(row)
    this.janitor.ensure(boxId, need, "out-of-space", true)
    if (fresh) {
      this.diskHold.delete(row.id)
      await this.removeTaskDir(boxId, row.id).catch(() => {})
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    } else {
      this.diskHold.set(row.id, boxId)
    }
    this.store.updateTask(row.id, {
      status: "queued",
      currentTurnId: null,
      compactPending: false,
      error: null,
      waitReason: `Waiting for disk cleanup on ${boxId}`,
    })
    this.addEvent(
      row.id,
      `Box ${boxId} ran out of disk space while ${fresh ? "setting up the workspace" : "starting the turn"}. ` +
        `Cleaning it up and retrying once${fresh ? ", on another box if one has room" : " when the cleanup is done"}.`,
    )
    this.emitTask(row.id)
    this.emitBoxes()
    this.schedule()
  }

  /** A resumed task whose session is gone gets a new session id; say so in its thread. */
  private recapSession(row: TaskRow, branch: "origin" | "base" | undefined, baseBranch: string): TaskRow {
    this.store.updateTask(row.id, { sessionId: randomUUID() })
    const checkout = !row.branch ? "a fresh workspace" : branch === "base" ? `branch ${row.branch} recreated from ${baseBranch} (it is gone from origin)` : `a fresh checkout of branch ${row.branch}`
    this.addEvent(row.id, `Resumed from a recap: no workspace archive was left, so a new Claude session started on ${checkout} with the task's summary, PR and recent messages.`)
    return this.requireRow(row.id)
  }

  /** What Box Yard calls its human (Settings.ownerName). */
  owner(): string {
    return this.settings.get().ownerName
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
        // Upload, not writeFile: Upstash rejects a base64 write body over ~10 MB,
        // so any attachment over ~7.5 MB failed with "invalid request body".
        await this.provider.uploadFile(boxId, file.path, `${folder}/${name}`)
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
      // The runner puts it into its MCP tool descriptions and replies.
      ownerName: this.owner(),
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
    const project = this.store.getProject(row.project_id)!
    const mirror = project.repo ? this.mirrorSpec(boxId, project) : null
    if (row.archive_path && fs.existsSync(row.archive_path)) {
      const remote = `${root}/.boxyard/restore-${row.id}.tgz`
      let from: "git" | "partial" | null = null
      try {
        await this.provider.uploadFile(boxId, row.archive_path, remote)
        const res = await this.provider.exec(
          boxId,
          `mkdir -p ${q(root + "/tasks")} && tar xzf ${q(remote)} -C ${q(root + "/tasks")} && rm -f ${q(remote)} && mkdir -p ${q(dir + "/work")} && rm -f ${q(dir + "/turn.pid")}`,
        )
        if (res.exitCode !== 0) throw new Error(`restoring workspace failed: ${res.stderr.slice(-500)}`)
        // A thin archive (git-thin/) gets its repo back from the mirror or GitHub plus its bundle of unpushed commits.
        if (mirror) await this.restoreThinGit(boxId, dir, mirror)
        if (mirror) await this.relinkSharedObjects(boxId, dir, mirror)
        // A git-first archive has no repo: clone it and put the branch, HEAD and WIP back. A partial one has only
        // .git: check its working tree out.
        from = await this.restoreGit(row, project, boxId, dir, mirror)
        await this.restoreExcludedTrackedFiles(boxId, `${dir}/work`, mirror?.env ?? "")
      } catch (err) {
        // Leave no half-built folder: the next try starts from the archive again (it stays as it was).
        await this.provider.exec(boxId, `rm -rf ${q(dir)} ${q(remote)} ${q(`${dir}/.boxyard-clone`)}`).catch(() => {})
        throw err
      }
      // The restored events log keeps its own seq numbers; restart the byte offset.
      const cursor = parseCursor(row.event_cursor)
      const size = await this.provider.exec(boxId, `wc -c < ${q(dir + "/events.jsonl")} 2>/dev/null || echo 0`)
      this.store.updateTask(row.id, { eventCursor: JSON.stringify({ ...cursor, offset: Number.parseInt(size.stdout.trim(), 10) || 0 }) })
      this.addEvent(row.id, from === "git" ? `Workspace restored on box ${boxId}: its session from the archive, its code from git.` : `Workspace restored on box ${boxId}.`)
      return { restored: true }
    }

    const steps = [`mkdir -p ${q(dir)}`, `rm -rf ${q(dir + "/work")}`]
    if (mirror) {
      const { spec, env, helper } = mirror
      // One mirror per repo per box (see server/gitShare.ts): the task's clone borrows its objects, so a task
      // folder holds its working tree and only the objects it made or fetched itself.
      const refs = [`refs/heads/${project.baseBranch}`, ...(row.branch ? [`refs/heads/${row.branch}`] : [])]
      steps.push(
        env,
        withMirrorLock(spec.mirror, [syncMirrorScript(spec), hydrateMirrorScript(spec, refs), `cd ${q(dir)}`, cloneTaskScript(spec)].join("\n")),
        `cd work`,
        `git config credential.helper ${q(helper)}`,
        `git config user.name ${q(this.c.gitUserName)}`,
        `git config user.email ${q(this.c.gitUserEmail)}`,
        // The clone has no checkout yet (so it never fetches the default branch's files for nothing).
        `(git checkout -q -f ${q(project.baseBranch)} 2>/dev/null || git checkout -q -f 2>/dev/null || true)`,
      )
      if (row.branch) steps.push(`( (git checkout ${q(row.branch)} >/dev/null 2>&1 && echo ${BRANCH_MARK}origin) || (git checkout -b ${q(row.branch)} && echo ${BRANCH_MARK}base) )`)
      // How much disk a clone of this repo takes, for the next pre-flight check.
      steps.push(`(echo ${CLONE_SIZE_MARK}$(du -sk . 2>/dev/null | cut -f1); true)`)
    } else {
      steps.push(`mkdir -p ${q(dir + "/work")}`)
    }
    const res = await this.provider.exec(boxId, steps.join(" && "))
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).replace(/x-access-token:[^@\s]+/g, "x-access-token:***").slice(-800)
      throw new Error(project.repo ? `git clone of ${project.repo} failed: ${detail}` : `workspace setup failed: ${detail}`)
    }
    this.store.updateTask(row.id, { eventCursor: null })
    const kb = Number(res.stdout.match(new RegExp(`${CLONE_SIZE_MARK}(\\d+)`))?.[1])
    const mirrorName = this.repoMirrorName(project.repo)
    if (mirrorName && Number.isFinite(kb) && kb > 0) this.store.setKv(cloneBytesKey(mirrorName), String(kb * 1024))
    if (res.stdout.includes(`${MIRROR_MARK}recreate`)) {
      this.addEvent(row.id, `Re-created the box's mirror of ${project.repo} as a ${mirror!.spec.partial ? "partial (blob:none)" : "full"} clone to match the project's partial clone setting.`)
    }
    this.addEvent(row.id, project.repo ? `Cloned ${project.repo} on box ${boxId}${row.branch ? `, branch ${row.branch}` : ""}.` : `Workspace ready on box ${boxId}.`)
    const mark = res.stdout.match(new RegExp(`${BRANCH_MARK}(origin|base)`))?.[1] as "origin" | "base" | undefined
    return { restored: false, branch: mark }
  }

  /** Whether a project's box mirrors are partial clones (blob:none): its own choice, else Settings. */
  partialClone(project: { partialClone?: boolean | null }): boolean {
    return project.partialClone ?? this.settings.get().gitPartialClone
  }

  /** The repo mirror on a box for a project, with the git command, env and credential helper that reach GitHub. */
  private mirrorSpec(boxId: string, project: NonNullable<ReturnType<Store["getProject"]>>) {
    const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f`
    const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.c.githubToken
    const spec: MirrorSpec = {
      root: this.provider.root(boxId),
      mirror: `${this.provider.root(boxId)}/.boxyard/repos/${this.repoMirrorName(project.repo)!}`,
      url: cloneUrl(project.repo!),
      partial: this.partialClone(project),
      git: `git -c credential.helper=${q(helper)}`,
    }
    return { spec, helper, env: `export GITHUB_TOKEN=${q(token ?? "")} GIT_TERMINAL_PROMPT=0` }
  }

  /**
   * A thin archive (server/archive.ts) carries the branch, refs, unpushed commits and uncommitted work but not the
   * history GitHub has: clone that again from the mirror or GitHub and put the rest back. Fails loudly when a ref's
   * commit can't be found (the archive stays as it was for another try), never with commits silently gone.
   */
  private async restoreThinGit(boxId: string, dir: string, { spec, env, helper }: { spec: MirrorSpec; env: string; helper: string }) {
    const check = await this.provider.exec(boxId, `[ -d ${q(`${dir}/${THIN_DIR}`)} ] && echo thin`)
    if (!check.stdout.includes("thin")) return
    const res = await this.provider.exec(boxId, `${env}\n${thinRestoreScript(dir, spec, { helper, userName: this.c.gitUserName, userEmail: this.c.gitUserEmail })}`)
    const mark = res.stdout.split("\n").find((l) => l.startsWith(THIN_MARK))?.slice(THIN_MARK.length)
    if (mark !== "ok") {
      const why = mark?.replace(/^fail /, "") || errorTail(res.stderr || res.stdout) || `exit ${res.exitCode}`
      throw new Error(`restoring workspace failed: rebuilding its git history from ${spec.url} and the archived commits didn't work (${why})`)
    }
  }

  /**
   * A restored work/ that borrows objects from a mirror: make sure this box has the mirror, point the clone at
   * it (the archive may come from another box), and add the archive's keep pack. Fails when HEAD still can't
   * be read, rather than handing the agent a broken repo.
   */
  private async relinkSharedObjects(boxId: string, dir: string, { spec, env }: { spec: MirrorSpec; env: string }) {
    const alternates = q(`${dir}/work/.git/objects/info/alternates`)
    const script = [env, `if [ -f ${alternates} ]; then ${withMirrorLock(spec.mirror, syncMirrorScript(spec))}; fi`, relinkTaskScript(dir, spec.mirror)].join("\n")
    const res = await this.provider.exec(boxId, script)
    if (res.stdout.includes(`${GIT_MARK}broken`)) {
      // Drop the half-restored folder so the next try restores from the archive again (it stays as it was).
      await this.provider.exec(boxId, `rm -rf ${q(dir + "/work")}`).catch(() => {})
      throw new Error(`restoring workspace failed: its git history borrows objects from the repo mirror, and box ${boxId} couldn't fetch ${spec.url} to rebuild it`)
    }
  }

  /**
   * Rebuild work/ from git after unpacking an archive (server/gitFirst.ts gitRestoreScript): from git.manifest
   * (git-first and thin archives), or the working tree of a partial archive. Throws when that fails.
   */
  private async restoreGit(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, dir: string, mirror: ReturnType<TaskManager["mirrorSpec"]> | null) {
    const refs = [`refs/heads/${project.baseBranch}`, ...(row.branch ? [`refs/heads/${row.branch}`] : [])]
    const clone = mirror
      ? { script: withMirrorLock(mirror.spec.mirror, [syncMirrorScript(mirror.spec), hydrateMirrorScript(mirror.spec, refs), cloneTaskScript(mirror.spec, ".boxyard-clone")].join("\n")), helper: mirror.helper }
      : null
    const script = gitRestoreScript({
      dir,
      taskId: row.id,
      baseBranch: project.baseBranch,
      gitUserName: this.c.gitUserName,
      gitUserEmail: this.c.gitUserEmail,
      clone,
      git: mirror?.spec.git ?? "git",
      env: mirror?.env ?? "true",
    })
    const res = await this.provider.exec(boxId, script)
    const out = parseGitRestore(res.stdout, res.stderr)
    if (!out.ok) throw new Error(`restoring workspace failed: ${out.reason}`)
    return out.from
  }

  /**
   * The archive leaves out dirs like `dist/` and `build/` by name, including
   * ones a repo commits. Check those tracked files out again in every repo under
   * work/. Only files under an excluded dir that are missing are touched, so
   * uncommitted edits and deletions elsewhere stay as they were archived.
   */
  private async restoreExcludedTrackedFiles(boxId: string, work: string, env: string) {
    const specs = ARCHIVE_EXCLUDED_DIRS.map((d) => q(`:(glob)**/${d}/**`)).join(" ")
    // `env` carries the token: a partial clone fetches the blobs it checks out.
    const res = await this.provider.exec(
      boxId,
      `${env ? `${env}; ` : ""}cd ${q(work)} 2>/dev/null && find . -maxdepth 6 -name .git -prune -print | while IFS= read -r g; do r="\${g%/.git}"; git -C "$r" ls-files -z -d -- ${specs} | xargs -0 git -C "$r" checkout -- >/dev/null 2>&1; done; true`,
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
        say("event", `${withOwner("Asked Cody:", this.owner())} ${question}`, { kind: "question" })
        return this.emitTask(taskId)
      }
      case "message_agent":
        return this.deliverAgentMessage(row, String(ev.to), String(ev.message ?? ""), Boolean(ev.expectReply))
      case "note": {
        // Agents suggest notes; the project's Captain curates them in the notes retro (server/retro.ts).
        const content = String(ev.content ?? "").trim().slice(0, MAX_NOTE_CHARS)
        if (!content) return
        if (this.store.listNoteSuggestions({ taskId, limit: MAX_SUGGESTIONS_PER_TASK }).length >= MAX_SUGGESTIONS_PER_TASK) {
          return say("event", `Note suggestion not kept: this task already made ${MAX_SUGGESTIONS_PER_TASK}. ${content}`, { kind: "note_suggestion", dropped: true })
        }
        const suggestion = this.store.addNoteSuggestion({
          projectId: row.project_id,
          taskId,
          taskTitle: row.title,
          content,
          why: String(ev.why ?? "").trim().slice(0, 1000),
        })
        say("event", `Suggested a project note: ${suggestion.content}`, { kind: "note_suggestion", suggestionId: suggestion.id })
        this.hub.broadcast({ type: "note_suggestions", projectId: row.project_id })
        return
      }
      case "pr": {
        const url = String(ev.url ?? "")
        const first = row.pr_url !== url
        const headSha = typeof ev.headSha === "string" && /^[0-9a-f]{7,64}$/i.test(ev.headSha) ? ev.headSha : null
        this.store.updateTask(taskId, {
          prUrl: url,
          branch: String(ev.branch ?? row.branch ?? "") || row.branch,
          turnFlags: { ...flags, sawPr: true },
          // A new PR starts open; the check below tells draft from open (and reads its labels).
          ...(first ? { prState: "open", prMergedAt: null, prMergedBy: null, prLabels: [] } : {}),
          // The runner reports the commit it pushed; GitHub's answer replaces it when it comes.
          ...(headSha ? { prHeadSha: headSha } : first ? { prHeadSha: null } : {}),
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
  private prChanged({ taskId, prev, info, status }: PrChange) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    const stateChanged = prev !== info.state
    if (stateChanged && info.state === "merged") this.addEvent(taskId, `Pull request #${prNumber(row.pr_url) ?? "?"} was merged${info.mergedBy ? ` by ${info.mergedBy}` : ""}: ${row.pr_url}`)
    else if (stateChanged && info.state === "closed") this.addEvent(taskId, `Pull request #${prNumber(row.pr_url) ?? "?"} was closed without merging: ${row.pr_url}`)
    if (info.state !== "open") this.settleMergeRequest(taskId, "pr")
    this.emitTask(taskId)
    if (status) this.publishDirectory()
    // Hooks: a merge seen live (not the startup backfill of an old PR), or a resting task's draft marked ready.
    const flags = this.store.turnFlags(row)
    const originHookIds = (row.current_turn_id ? flags.hookIds : flags.lastHookIds) ?? []
    if (info.state === "merged" && (prev === "open" || prev === "draft")) {
      this.emitTaskEvent({ type: "pr.merged", taskId, turnId: row.current_turn_id, originHookIds })
    } else if (prev === "draft" && info.state === "open" && row.status === "pr_ready" && !row.current_turn_id) {
      this.emitTaskEvent({ type: "task.pr_ready", taskId, turnId: null, originHookIds })
    }
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
      turnFlags: { interrupts: 0, ...(flags.hookIds ? { lastHookIds: flags.hookIds } : {}) },
      outcome,
    }, { quiet: stopped })
    this.settleMergeRequest(row.id, "turn")
    if (row.box_id) this.store.touchBox(row.box_id)

    const cost = turnCost !== null ? ` · $${turnCost.toFixed(3)}` : ""
    this.addEvent(row.id, `Turn ${row.turn_count} ${stopped ? "stopped" : status === "failed" ? "failed" : "finished"}${cost}.`)
    // What the agent said at the end of the turn, for the orchestrator.
    const said = (flags.done && flags.done.length > 40 ? flags.done : result || flags.done || "").replace(/\s+/g, " ").trim()
    const gist = preview(said, 600, "full reply: call wait_for_tasks or get_task")
    const more = this.store.hasInputs(row.id) ? " (more messages are queued for it)" : ""
    if (noopIgnored.length) this.addEvent(row.id, withOwner(`The agent marked this run a no-op, but it isn't quiet: ${noopIgnored.join(", ")}.`, this.owner()))
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
    if (!stopped) this.turnEvents(row, status, Boolean(more), Boolean(finished && isQuietRun(finished)), flags)

    this.emitTask(row.id)
    this.publishDirectory()
    void this.archive(row.id).finally(() => this.schedule())
    this.schedule()
  }

  /** The hook events a finished turn raises. A stopped turn raises none: Cody stepped in. */
  private turnEvents(row: TaskRow, status: TaskStatus, more: boolean, quiet: boolean, flags: TurnFlags) {
    const base = { taskId: row.id, turnId: row.current_turn_id, originHookIds: flags.hookIds ?? [], sawPr: Boolean(flags.sawPr) }
    if (row.schedule_id && ["done", "idle", "pr_ready", "failed"].includes(status) && !more) this.emitTaskEvent({ ...base, type: "schedule.run_finished" })
    // A quiet run did nothing worth acting on; only schedule.run_finished hooks that include quiet runs see it.
    if (quiet) return
    if (status === "failed") this.emitTaskEvent({ ...base, type: "task.failed" })
    else if (status === "needs_input") this.emitTaskEvent({ ...base, type: "task.needs_input" })
    else if (!more && (status === "idle" || status === "pr_ready" || status === "done")) {
      this.emitTaskEvent({ ...base, type: "task.finished" })
      if (status === "pr_ready") this.emitTaskEvent({ ...base, type: "task.pr_ready" })
    }
  }

  /** Listen to task events (the hook engine does). Returns an unsubscribe function. */
  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitTaskEvent(event: TaskEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error(`[box-yard] ${event.type} listener for ${event.taskId} failed: ${errorMessage(err)}`)
      }
    }
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
    void this.archive(row.id)
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
      this.store.queueInput(from.id, "system", withOwner(`Your message to ${to} was not delivered because you sent too many agent messages recently. Ask Cody with ask_user if you are stuck.`, this.owner()))
      return
    }
    log.push(now)
    this.agentMsgLog.set(from.id, log)

    if (/^(cody|user|human|orchestrator)$/i.test(to)) {
      say(from.id, `→ ${this.owner()}: ${message}`, { to: "cody" })
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

  /** Archive a task unless its archive is already fresh, waiting for one that's being written right now. */
  private async archiveFresh(taskId: string) {
    while (this.archiving.has(taskId)) await new Promise((r) => setTimeout(r, 100))
    const row = this.store.getTaskRow(taskId)
    if (row && !this.hasFreshArchive(row)) await this.archive(taskId)
  }

  /**
   * Push the task's git work (when the project pushes at turn end) and copy what git can't carry to the
   * orchestrator's disk. Git-first (server/gitFirst.ts): once origin has the branch and the WIP ref, the archive
   * holds the Claude session, the log, runner state and gitignored files, with a manifest and a pack of the
   * task's own objects. Otherwise the whole folder, then (too big) only .git and a WIP snapshot, then a thin
   * archive (HEAD, the refs and a bundle of the commits GitHub lacks; server/archive.ts). Archives stream off the box
   * (server/archive.ts), so this works on a box whose work disk is full. A failure is kept for `archiveProblem`.
   * `closing`: the task is done, so its WIP ref is removed from origin once an archive has the work.
   */
  async archive(taskId: string, opts: { closing?: boolean } = {}) {
    if (this.archiving.has(taskId)) return
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id) return
    const project = this.store.getProject(row.project_id)
    const push = Boolean(project && this.pushAtTurnEnd(project))
    if (!this.c.archiveWorkspaces && !push) return
    this.archiving.add(taskId)
    const boxId = row.box_id
    const file = path.join(this.c.dataDir, "archives", `${taskId}.tgz`)
    const part = `${file}.part`
    const maxBytes = this.c.archiveMaxMb * 1024 * 1024
    let pushed: GitPrepResult | null = null
    try {
      if (push) {
        pushed = await this.prepGit(row, project!, boxId, { packMaxBytes: this.c.archiveWorkspaces ? Math.floor(maxBytes / 2) : 0 })
        this.recordPush(taskId, pushed)
      }
      if (!this.c.archiveWorkspaces) return
      let res: ArchiveOutcome | null = null
      let kind: "git" | "whole" | "partial" | "thin" = "git"
      let note: string | null = null
      // Closing drops the WIP ref, so the archive's own pack has to carry the work.
      const packOk = (r: GitPrepResult) => r.pack === "yes" || r.pack === "none"
      if (pushed?.status === "pushed" && pushed.stage && (!opts.closing || packOk(pushed))) {
        res = await this.streamArchive(boxId, taskId, part, { git: { stage: pushed.stage, ignored: true } })
        if (!res.ok && res.tooBig) {
          res = await this.streamArchive(boxId, taskId, part, { git: { stage: pushed.stage, ignored: false } })
          if (res.ok) note = `Archived without the files git ignores in work/ (over ${this.c.archiveMaxMb} MB compressed); git has the rest.`
        }
        if (!res.ok) console.warn(`[box-yard] git-first archive of ${taskId} failed, archiving the whole workspace: ${res.error}`)
      }
      if (!res?.ok) {
        // A clone that borrows the mirror's objects: stage the borrowed ones GitHub may not have, so the archive
        // restores anywhere (server/gitShare.ts). On /tmp or the work disk, whichever has more room.
        const keep = await this.provider.exec(boxId, keepPackScript(this.taskDir(boxId, taskId), taskId, this.provider.root(boxId)))
        if (keep.exitCode !== 0) console.warn(`[box-yard] keep pack for ${taskId} failed: ${keep.stderr.slice(-300)}`)
        const keepStage = keep.stdout.match(new RegExp(`${KEEP_STAGE_MARK}(\\S+)`))?.[1]
        kind = "whole"
        res = await this.streamArchive(boxId, taskId, part, { keepStage })
        // Too big: keep the Claude session, the log and git history, with any uncommitted work as a WIP commit on a side ref.
        if (!res.ok && res.tooBig && project?.repo) {
          kind = "partial"
          res = await this.streamArchive(boxId, taskId, part, { partial: true, keepStage })
        }
        // Still too big (a heavy history, e.g. a clone from before tasks shared the box mirror): leave out what GitHub has.
        if (kind === "partial" && !res.ok && res.tooBig) {
          kind = "thin"
          res = await this.streamArchive(boxId, taskId, part, { thin: true, keepStage })
        }
        if (!res.ok && res.tooBig)
          throw new Error(
            kind === "thin"
              ? `workspace is too large to archive even without its files and the history GitHub has (Claude session, log, unpushed commits and uncommitted work are over ${this.c.archiveMaxMb} MB compressed; BOXYARD_ARCHIVE_MAX_MB raises the limit)`
              : `workspace is too large to archive even without its files (Claude session, log and git history are over ${this.c.archiveMaxMb} MB compressed; BOXYARD_ARCHIVE_MAX_MB raises the limit)`,
          )
        if (!res.ok) throw new Error(kind === "thin" ? `archiving without the history GitHub has failed: ${res.error}` : res.error)
      }
      fs.renameSync(part, file)
      this.archiveErrors.delete(taskId)
      if (this.store.getTaskRow(taskId)) {
        this.store.updateTask(taskId, { archivePath: file, lastArchivedAt: Date.now() })
        if (kind === "thin") {
          const wip = res.wip === "clean" ? "nothing was uncommitted" : "uncommitted work comes back as uncommitted changes"
          this.addEvent(
            taskId,
            `Workspace and git history were too big to archive; saved the Claude session, the branch and the commits GitHub doesn't have. The rest of the history is fetched again on restore (${wip}).`,
          )
        } else if (kind === "partial") {
          const wip = res.wip === "clean" ? "nothing was uncommitted" : "uncommitted work is on refs/boxyard/wip"
          this.addEvent(taskId, `Workspace was too big to archive whole; saved the Claude session and git history (${wip}).`)
        }
        if (note) this.addEvent(taskId, note)
      }
      // The archive has the work now (its pack does when the task is closing), so the WIP ref can go.
      if (opts.closing && pushed?.pushedWip) {
        await this.provider.exec(boxId, this.wipDeleteScript(boxId, taskId, project!)).catch(() => {})
        const state = this.store.getTask(taskId)?.pushState
        if (state) this.store.updateTask(taskId, { pushState: { ...state, wip: null } }, { touch: false })
      }
    } catch (err) {
      this.archiveErrors.set(taskId, errorMessage(err))
      console.warn(`[box-yard] archive ${taskId} failed: ${errorMessage(err)}`)
    } finally {
      fs.rmSync(part, { force: true })
      const stages = [...keepPackStages(this.provider.root(boxId), taskId), ...gitStages(this.provider.root(boxId), taskId)]
      await this.provider.exec(boxId, `rm -rf ${stages.map(q).join(" ")}`).catch(() => {})
      this.archiving.delete(taskId)
    }
  }

  /** Whether a project's tasks push their git work at the end of every turn: its own choice, else Settings. */
  pushAtTurnEnd(project: { repo?: string | null; pushAtTurnEnd?: boolean | null }): boolean {
    if (!project.repo) return false
    // Mock mode never pushes to GitHub: its agent's commits are made up.
    if (this.c.mock && githubSlug(project.repo)) return false
    return project.pushAtTurnEnd ?? this.settings.get().gitPushAtTurnEnd
  }

  /** Snapshot a task's git work on its box and push it to origin (server/gitFirst.ts). */
  private async prepGit(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, o: { packMaxBytes: number }): Promise<GitPrepResult> {
    const { spec, env } = this.mirrorSpec(boxId, project)
    const last = this.store.getTask(row.id)?.pushState?.wip ?? null
    const script = gitPrepScript({
      root: this.provider.root(boxId),
      work: `${this.taskDir(boxId, row.id)}/work`,
      taskId: row.id,
      branch: row.branch,
      baseBranch: project.baseBranch,
      lastWip: last,
      packMaxBytes: o.packMaxBytes,
      git: spec.git,
      env,
    })
    try {
      const res = await this.provider.exec(boxId, script)
      return parseGitPrep(res.stdout, res.stderr)
    } catch (err) {
      return parseGitPrep("", errorMessage(err))
    }
  }

  /**
   * Save what the turn-end push did. Its transcript says so only when that changes (a push starts failing,
   * or works again), so a repo without write access doesn't get a line every turn.
   */
  private recordPush(taskId: string, r: GitPrepResult) {
    const prev = this.store.getTask(taskId)?.pushState ?? null
    // A push that didn't happen leaves origin's WIP ref as it was; remember it, so it's still deleted later.
    const wip = r.status === "pushed" ? r.pushedWip : (r.pushedWip ?? prev?.wip ?? null)
    const state: PushState = { status: r.status, at: Date.now(), branch: r.branch, head: r.head, wip, reason: r.reason }
    this.store.updateTask(taskId, { pushState: state }, { touch: false })
    this.emitTask(taskId)
    // The same problem with other commits in its message is still the same problem.
    const gist = (s: PushState) => `${s.status} ${(s.reason ?? "").replace(/\b[0-9a-f]{7,64}\b/g, "…")}`
    if (prev && gist(prev) === gist(state)) return
    if (state.status === "pushed") {
      if (state.reason) this.addEvent(taskId, `Turn-end push: ${state.reason}.`)
      else if (prev) this.addEvent(taskId, "Turn-end push works again: origin has this task's branch and uncommitted work, so its archive is small.")
    } else {
      const what = state.status === "skipped" ? "Skipped the turn-end push" : "The turn-end push failed"
      this.addEvent(taskId, `${what} (${state.reason ?? "no reason given"}). The archive keeps the whole workspace instead.`)
    }
  }

  /** The script that removes a task's WIP ref from origin, run in its work folder. */
  private wipDeleteScript(boxId: string, taskId: string, project: NonNullable<ReturnType<Store["getProject"]>>) {
    const { spec, env } = this.mirrorSpec(boxId, project)
    return deleteWipScript(`${this.taskDir(boxId, taskId)}/work`, taskId, spec.git, env)
  }

  /** Stream one archive of a task folder into `dest` on this machine. */
  private async streamArchive(
    boxId: string,
    taskId: string,
    dest: string,
    mode: { partial?: boolean; thin?: boolean; git?: { stage: string; ignored: boolean }; keepStage?: string },
  ): Promise<ArchiveOutcome> {
    const maxBytes = this.c.archiveMaxMb * 1024 * 1024
    // A thin archive is a partial one that also leaves out the history GitHub has.
    const partial = Boolean(mode.partial || mode.thin)
    const excludes = [...ARCHIVE_EXCLUDED_DIRS, `${taskId}/task.json`, `${taskId}/turn.pid`, `${taskId}/events.lock`, `${taskId}/mcp.json`]
    const project = mode.thin ? this.store.getProject(this.store.getTaskRow(taskId)?.project_id ?? "") : null
    const mirror = project?.repo ? this.mirrorSpec(boxId, project).spec.mirror : undefined
    const script = archiveScript({ root: `${this.provider.root(boxId)}/tasks`, taskId, excludes, maxBytes, partial, thin: mode.thin, mirror, git: mode.git, keepStage: mode.keepStage })
    const fd = fs.openSync(dest, "w")
    let writeError: unknown = null
    try {
      const decoder = new ArchiveDecoder((data) => {
        if (writeError || decoder.bytes > maxBytes) return
        try {
          fs.writeSync(fd, data)
        } catch (err) {
          writeError = err
        }
      })
      const { exitCode } = await this.provider.execStream(boxId, script, (chunk) => decoder.push(chunk))
      decoder.end()
      if (writeError) throw new Error(`saving the archive on the Box Yard server failed: ${errorMessage(writeError)}`)
      return archiveOutcome(decoder, { maxBytes, partial, exitCode })
    } finally {
      fs.closeSync(fd)
    }
  }

  /** "archive task_a: …; archive task_b: …" */
  private archiveProblems(taskIds: string[]) {
    return taskIds.map((id) => this.archiveProblem(id)).join("; ")
  }

  /**
   * Why a task has no fresh archive, as "archive task_x: <reason>": its last attempt's error, archiving being off,
   * or a running agent. For the messages of operations that need every workspace archived.
   */
  archiveProblem(taskId: string): string {
    const row = this.store.getTaskRow(taskId)
    const why = !this.c.archiveWorkspaces
      ? "workspace archiving is off (BOXYARD_ARCHIVE=0)"
      : row?.current_turn_id
      ? "its agent is running"
      : this.archiveErrors.get(taskId) ?? "no archive was made"
    return `archive ${taskId}: ${why}`
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
    await this.archive(taskId, { closing: true })
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
    const now = Date.now()
    if (!force && now - (this.lastBoxProbeAt.get(boxId) ?? 0) < 5 * 60_000) return
    this.lastBoxProbeAt.set(boxId, now)
    if (!this.provider.usage) {
      await this.probeDisk(boxId, 0).catch(() => null)
      return
    }
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
    await this.probeDisk(boxId, 0).catch(() => null)
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
      const keep = this.mirrorsToKeep(box.id)
      // A mirror some task folder still borrows objects from stays, whatever the database says.
      await this.provider.exec(box.id, pruneMirrorsScript(this.provider.root(box.id), [...keep])).catch((err) => console.warn(`[box-yard] prune mirrors ${box.id}: ${errorMessage(err)}`))
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
        if (box.status !== "ready" || this.boxOps.has(box.id)) continue
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
    await this.reclaimUnusedBoxes(now)
    // Boxes at the provider that Box Yard has no row for (a delete that failed before rows waited for it). Not while
    // a box is being created: it's at the provider before it's in the database.
    if (now - this.lastOrphanSweepAt > 60 * 60_000 && !this.creatingBoxes) {
      this.lastOrphanSweepAt = now
      await this.cleanupOrphanBoxes()
    }
    // Clean a box that is filling up before a task trips over it.
    const floor = this.diskNeed(null)
    for (const box of this.store.listBoxes()) {
      if (box.status !== "ready" || box.disk_free_bytes === null || box.disk_free_bytes === undefined) continue
      if (box.disk_free_bytes < floor && !this.janitor.isRunning(box.id) && !this.boxOps.has(box.id)) this.janitor.ensure(box.id, floor)
    }
    await this.sweepRootDisks(now)
    await this.routineUpkeep(now)
    this.schedule()
  }

  /**
   * Routine upkeep on each box, as a quiet janitor run (so what it frees lands in the box's cleanup report):
   * remove the git-ignored build output of tasks resting longer than Settings › buildCleanupIdleMinutes (once
   * per idle stretch), and every MIRROR_GC_MS drop stale task folders and gc the repo mirrors lightly.
   */
  private async routineUpkeep(now: number) {
    const idleMs = this.settings.get().buildCleanupIdleMinutes * 60_000
    const runs: Promise<unknown>[] = []
    for (const box of this.store.listBoxes()) {
      if (this.stopped || box.status !== "ready" || this.boxOps.has(box.id) || this.janitor.isRunning(box.id)) continue
      if (!this.mirrorGcAt.has(box.id)) this.mirrorGcAt.set(box.id, now)
      const idle = idleMs <= 0 ? [] : this.store
        .listTaskRows({ boxId: box.id })
        .filter((r) => !r.current_turn_id && RESTING.includes(r.status) && !this.store.hasInputs(r.id) && now - r.last_active_at >= idleMs && this.buildsCleaned.get(r.id) !== r.last_active_at)
      const gc = now - this.mirrorGcAt.get(box.id)! >= MIRROR_GC_MS
      if (!idle.length && !gc) continue
      if (gc) this.mirrorGcAt.set(box.id, now)
      for (const r of idle) this.buildsCleaned.set(r.id, r.last_active_at)
      const steps: CleanupStepKey[] = [...(gc ? (["tmp", "partials", "git"] as const) : []), ...(idle.length ? (["builds"] as const) : [])]
      runs.push(this.janitor.run(box.id, { reason: "routine", target: null, parkBelow: 0, steps, builds: idle.map((r) => r.id), light: true }))
    }
    await Promise.all(runs)
  }

  /**
   * A box whose root disk (/tmp, HOME) is filling up: a quiet run that removes stale temp folders and old /tmp
   * files and package caches (the caches step). At most every ROOT_SWEEP_MS per box, so a disk that stays full
   * isn't swept on every tick.
   */
  private async sweepRootDisks(now: number) {
    const runs: Promise<unknown>[] = []
    for (const box of this.store.listBoxes()) {
      if (this.stopped || box.status !== "ready" || this.boxOps.has(box.id) || this.janitor.isRunning(box.id)) continue
      if (!rootLow({ freeBytes: box.root_free_bytes, totalBytes: box.root_total_bytes })) continue
      if (now - (this.rootSweptAt.get(box.id) ?? 0) < ROOT_SWEEP_MS) continue
      this.rootSweptAt.set(box.id, now)
      console.log(`[box-yard] box ${box.id} is low on its root disk: ${formatBytes(box.root_free_bytes)} free of ${formatBytes(box.root_total_bytes)}`)
      runs.push(this.janitor.run(box.id, { reason: "routine", target: null, parkBelow: 0, steps: ["tmp", "caches"], light: true }))
    }
    await Promise.all(runs)
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
      this.store.updateTask(row.id, { status: "failed", currentTurnId: null, error: `Interrupted: ${reason}`, turnFlags: { interrupts: 0, lastHookIds: flags.hookIds } })
      this.settleMergeRequest(row.id, "turn")
      this.addEvent(row.id, `Turn interrupted (${reason}). Gave up after ${MAX_INTERRUPTS} retries.`)
      this.notice(`❌ **${row.title}** was interrupted: ${reason}`, { taskId: row.id })
      this.emitTaskEvent({ type: "task.failed", taskId: row.id, turnId: row.current_turn_id, originHookIds: flags.hookIds ?? [] })
    } else {
      this.store.queueInput(row.id, "system", `Your previous turn was interrupted (${reason}). Check where things stand (git status, files) and continue the task.`)
      this.store.updateTask(row.id, { status: "queued", currentTurnId: null, turnFlags: { interrupts, ...(flags.hookIds ? { hookIds: flags.hookIds } : {}) } })
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
    this.janitor.forget(boxId)
    this.diskCache.delete(boxId)
    this.reserved.delete(boxId)
    this.lowBoxes.delete(boxId)
    for (const [taskId, held] of this.diskHold) if (held === boxId) this.diskHold.delete(taskId)
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

  /**
   * A line for the owner of a task update; by default the Coordinator reads it on its next turn.
   * `coordinator: true` keeps it in the Coordinator's updates even when a Captain handles it too.
   */
  notice(content: string, meta: Record<string, unknown> | null = null, opts: NoticeOptions = {}) {
    const handled = Boolean(this.onNotice?.(content, meta, opts))
    const msg = this.store.addChat("notice", content, meta)
    // Keep the historical main-chat notice for existing installs, but do not
    // make the Coordinator process every project task event once a Captain owns it.
    if (handled && !opts.coordinator) this.store.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE id = ?").run(msg.id)
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
