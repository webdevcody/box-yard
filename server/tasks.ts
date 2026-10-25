import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { BoxRow, QueuedInputRow, Store, TaskRow, TurnFlags } from "./store.js"
import { BadRequestError, ConflictError, NotFoundError, cloneUrl, githubSlug, boxCost, normalizeBoxSize } from "./store.js"
import type { BoxProvider, BoxUsageProbe, ExecResult } from "./providers/types.js"
import { providerOf, q, tasksRootOf } from "./providers/types.js"
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
  type BoxPromptInfo,
  type DirectoryEntry,
} from "./prompts.js"
import type { Uploads, StoredUpload } from "./uploads.js"
import { BOX_SIZES, RESTING_STATUSES, SIZE_DEFAULTS, isFinalPrState, type Attachment, type BoxContents, type BoxInfo, type BoxOperation, type BoxSize, type CaptainMessage, type Effort, type PrState, type PreviewLink, type Project, type PushState, type QueuedMessage, type QueuedSender, type Task, type TaskStatus } from "../shared/types.js"
import { autocompactFlag, noteBudgetOf, type SettingsStore } from "./settings.js"
import { budgetNotes } from "../shared/notes.js"
import { MAX_NOTE_CHARS } from "./notes.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { userMessageLabel } from "../shared/sender.js"
import { AGENT_CAPTAIN_LIMIT, AGENT_CAPTAIN_WAIT_MAX_SECONDS, AGENT_CAPTAIN_WINDOW_MS } from "../shared/captain.js"
import type { AgentCaptainMessage } from "./captains.js"
import { formatTokens } from "./usage.js"
import { errorMessage, isRateLimited } from "./util/retry.js"
import { isUploadTooBig, putFile } from "./upload.js"
import { capReply, preview } from "./replies.js"
import { PrTracker, prNumber, type PrChange } from "./prs.js"
import { isCopiedDefaultRoute, loadRouting, resolveAgentRoute } from "./routing.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { isQuietRun, noopBlockers, type RunEvidence } from "../shared/quiet.js"
import { memoryPressure, type BoxMemory, type MemoryPolicy } from "../shared/memory.js"
import { cleanupSummary, dfCommand, diskLine, formatBytes, isOutOfSpace, parseDf, requiredFreeBytes, rootLow, type BoxCleanup, type CleanupStepKey, type DiskSpace } from "../shared/disk.js"
import { BoxJanitor, DEPS_DIR, pushedCheck, pushedVerdict } from "./janitor.js"
import { GIT_MARK, KEEP_STAGE_MARK, MIRROR_MARK, keepPackStages, cloneTaskScript, hydrateMirrorScript, keepPackScript, pruneMirrorsScript, relinkTaskScript, syncMirrorScript, withMirrorLock, type MirrorSpec } from "./gitShare.js"
import type { HookTrigger } from "../shared/hooks.js"
import { LOCAL_BOX_ID, RUNNER_PHRASE, isLocalRunnerBox, type Runner } from "../shared/runner.js"
import { MAX_GPU_PODS, gpuBoxId, gpuBoxIndex, gpuBoxProject, gpuPodLabel, isGpuBox, type RunPodSettings } from "../shared/runpod.js"
import { POD_HTTP_PORTS, shortGpu, type RunPodProvider } from "./providers/runpod.js"
import { SleepWatch, sleepLength } from "./sleep.js"
import { BoxHistory, type BoxEventInput } from "./boxHistory.js"
import type { BoxActor, BoxEvent } from "../shared/boxHistory.js"
import { SNAPSHOT_STEP_LABELS, snapshotSkipReason, type ProjectSnapshot, type SnapshotInitiator, type SnapshotJob, type SnapshotStep } from "../shared/snapshots.js"
import { SCRATCH_MARKER, depsSaveScript, depsSaveSummary, stripCounts, stripScript, stripSummary } from "./boxSnapshot.js"
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

type BoxOp = "clear" | "delete" | "resize" | "snapshot"

function busyMessage(boxId: string, op: BoxOperation) {
  const what = { cleanup: "a disk cleanup", clear: "clearing", delete: "deleting", resize: "resizing", snapshot: "a project snapshot" }[op]
  return `Box ${boxId} is busy: ${what} is in progress.`
}

/** The box history actor for whoever asked for a resize (Cody from the UI, the Coordinator or a Captain). */
const resizeActor = (by: ResizeInitiator): BoxActor => (by.kind === "cody" ? { kind: "owner" } : by)
/** The box history actor for whoever asked for a project snapshot. */
const snapshotActor = (by: SnapshotInitiator): BoxActor => (by.kind === "cody" ? { kind: "owner" } : by)

/** Task ids a cleanup took off its box ("task_x (archived)" and the like in its steps' removed lists). */
const cleanupTaskIds = (report: BoxCleanup) => [
  ...new Set(report.steps.flatMap((s) => s.removed.map((r) => /^(task_[A-Za-z0-9_-]+)/.exec(r)?.[1]).filter((id): id is string => Boolean(id)))),
]

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
/** A task that takes one of its box's agent slots: a turn id, or starting/working (the same rule as Store.slotsInUse). */
const holdsSlot = (r: TaskRow) => Boolean(r.current_turn_id) || r.status === "starting" || r.status === "working"
/** "1 box", "3 boxes". */
const boxCount = (n: number) => `${n} ${n === 1 ? "box" : "boxes"}`
/** The biggest archive a task moves to another box with: a restore uploads it as one file (Upstash takes up to 100 MB). */
const MOVE_MAX_ARCHIVE_BYTES = 90 * 1024 * 1024
const PORT_BASE = 4000
const MAX_INTERRUPTS = 2
const STALL_MS = 45_000
const START_TIMEOUT_MS = 15 * 60_000
/** Local turns that sleep cut off in a row before one counts as failed after all (each needs a real sleep). */
const MAX_SLEEP_RESUMES = 10
/** A local turn that fails within this long of the computer waking counts as cut off by the sleep. */
const SLEEP_WAKE_GRACE_MS = 15 * 60_000
/** Below this the runner's own clocks saw a hiccup, not a sleep (SleepWatch's threshold). */
const RUNNER_SLEEP_MIN_MS = 20_000
/** A local task waits with this while every Settings › Local agents slot is taken. */
const LOCAL_SLOT_WAIT = "Waiting for a free local agent slot (Settings › Local agents)"
const GPU_SLOT_WAIT = "Waiting for a free agent slot on its project's GPU pod (Agents per box, or Settings › RunPod GPU › Agents per pod)"
/** Where a GPU project's $/hr cap is raised, for the wait reason. */
const GPU_CAP_HOW = "raise it in Project › Settings › Boxes or with update_project gpu_max_hourly_usd; Settings › RunPod GPU › Max per project is the default"
/** How often Box Yard touches an idle GPU pod's heartbeat, so its own watchdog only fires when Box Yard is gone. */
const GPU_HEARTBEAT_MS = 5 * 60_000
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
/** How often maintain() asks the provider which boxes it still has (reconcileBoxes). */
const RECONCILE_MS = 5 * 60_000
/** The same check when the Boxes page or pool_status loads, throttled so page loads don't hammer the provider's API. */
export const RECONCILE_LOOK_MS = 60_000
/** Tries at restoring an archive before the task restarts from a recap instead (prepareWorkspace). */
const RESTORE_ATTEMPTS = 2
/** Regenerable dirs left out of workspace archives, by name (tracked ones are checked out again on restore). */
const ARCHIVE_EXCLUDED_DIRS = [
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", ".venv", "__pycache__", "target",
  // Test reports, framework output and tool caches: never source, and they get big (Playwright traces, videos).
  "playwright-report", "test-results", ".svelte-kit", ".nuxt", ".output", ".angular", ".gradle", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".npm", ".pnpm-store",
]

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
  /** RunPod GPU pods (Runs on: RunPod GPU), when this install has the runner. */
  gpu?: GpuRunner | null
}

/** What TaskManager needs of the RunPod GPU runner (server/runpod/service.ts). */
/** What TaskManager uses of the GPU pods' provider: RunPodProvider, or a stand-in in tests. */
export type GpuPodProvider = BoxProvider & Pick<RunPodProvider, "listPods" | "cached" | "nextPodPrice" | "capOf">
type GpuPods = Awaited<ReturnType<GpuPodProvider["listPods"]>>

export interface GpuRunner {
  provider: GpuPodProvider
  settings(): RunPodSettings
  /** A RunPod API key is set. */
  enabled(): boolean
  /** The owner asked to keep this box's pod up until then, even idle (ms since epoch), or null. */
  keepWarmUntil(boxId: string): number | null
}

/** How prepareWorkspace set a task's folder up. `fallback`: its archive couldn't be restored, so it was cloned fresh. */
interface PreparedWorkspace {
  restored: boolean
  branch?: "origin" | "base"
  fallback?: { reason: string; wip: boolean }
}

/** "on box local-1a2b", or "on this computer" for the local runner: where a task's log says its workspace is. */
const onBox = (boxId: string) => (isLocalRunnerBox(boxId) ? "on this computer" : isGpuBox(boxId) ? `on its project's GPU pod #${gpuBoxIndex(boxId)}` : `on box ${boxId}`)

/** What clients see of an upload: no server paths. */
const publicFiles = (files: StoredUpload[]): Attachment[] => files.map(({ id, name, size, mime }) => ({ id, name, size, mime }))

/**
 * Who a queued task input is from. `captain:<projectId>` is that project's Captain; `cody:merge` is the "Merge PR" button;
 * `hook:<hookId>` a hook (server/hooks.ts).
 */
export type InputSource = "cody" | typeof MERGE_BUTTON_SOURCE | "orchestrator" | "system" | `agent:${string}` | `captain:${string}` | `hook:${string}`

/** A task to start (TaskManager.createTask / createTasks). */
export interface NewTask {
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
  /** Its own runner over the project's "Runs on", for every turn (Task.runsOn). Check it first with requireRunner. */
  runsOn?: Runner | null
}

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
  hook?: { prefix: string; meta: Record<string, unknown> }
}

/**
 * How a notice is delivered. `coordinator`: it stays in the Coordinator's updates even when a Captain handles it too.
 * `wake: false`: nobody is woken for it; the Captain and Coordinator read it on their next turn.
 */
export interface NoticeOptions {
  coordinator?: boolean
  wake?: boolean
}
/** An agent's message_captain that waits mid-turn for the Captain's reply (the runner polls its reply file). */
interface CaptainWait {
  /** The runner's message id (cmsg_…), which names the reply file. */
  id: string
  turnId: string | null
  /** When the runner stops waiting, plus a little slack for the write. */
  until: number
}

/** Task-message meta for a Captain's message, so the transcript can say which Captain steered the task. */
const captainMeta = (store: Store, projectId: string) => ({ source: "captain", captainProjectId: projectId, captainName: store.getProject(projectId)?.name ?? null })

/** kv key for the box a project's work goes to first. */
const projectBoxKey = (projectId: string) => `project_box:${projectId}`
/** kv key for the project a box was created for. */
const boxOwnerKey = (boxId: string) => `box_owner:${boxId}`
/** kv key for the status a resting task had before a message queued it (where cancelling every message returns it). */
const queuedFromKey = (taskId: string) => `queued_from:${taskId}`
/** The claim on a queued input handed to the agent mid-turn (Store.lockInput). */
const handoffClaim = (turnId: string) => `handoff:${turnId}`
/** Is a box of size `size` big enough for a project that needs `min` (null: any box is)? */
const sizeFits = (size: unknown, min: BoxSize | null) => !min || compareSizes(normalizeBoxSize(size), min) >= 0

/** How long placement leaves a box alone after its automatic resize failed. */
const AUTO_RESIZE_RETRY_MS = 15 * 60_000

/** The running or last resize of a box (old and new box both point at it). */
const resizeKey = (boxId: string) => `box_resize:${boxId}`
/** A project's running or last snapshot job (shared/snapshots.ts). */
const snapshotJobKey = (projectId: string) => `snapshot_job:${projectId}`
/** Snapshot ids Box Yard made and must delete (a job's first snapshot, a replaced one), kept until the provider confirms. */
const PENDING_SNAPSHOTS_KEY = "snapshots_to_delete"
/** A box row's last memory and load reading, or null before the first. */
const boxMemory = (b: BoxRow): BoxMemory | null =>
  b.mem_used_bytes != null && b.mem_total_bytes != null ? { usedBytes: b.mem_used_bytes, totalBytes: b.mem_total_bytes, load1: b.load_avg ?? 0, cpus: b.cpu_count ?? 1 } : null

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
  /** When this computer slept: local-runner turns and starts that sleep broke resume instead of failing (#104). */
  readonly sleep: SleepWatch

  private timers: NodeJS.Timeout[] = []
  private scheduling = false
  private rescheduleWanted = false
  private polling = false
  private holds = new Map<string, AbortController>()
  private lastEventAt = new Map<string, number>()
  private pollFailures = new Map<string, number>()
  private stopRequested = new Set<string>()
  /** Tasks whose turn was picked (starting) when Cody cancelled every message it was for: launch drops that turn. */
  private cancelledAll = new Set<string>()
  private creatingBoxes = 0
  /**
   * Pool boxes being created by createBox: what Settings › Boxes created at once caps. Not `creatingBoxes`, which
   * also counts a snapshot job's scratch box for as long as the job runs.
   */
  private poolCreates = 0
  /** Boxes being created, per project they're for. */
  private creatingFor = new Map<string, number>()
  /** Tasks that found no box this scheduling pass and want a new one. */
  private wantsBox = new Set<string>()
  private lastBoxError: { at: number; message: string } | null = null
  /**
   * Box creation's backoff: failed creates in a row, when the next one may start, and how many may run at
   * once right now (Settings › Boxes created at once, halved by a rate limit and grown back by one per new box).
   */
  private boxCreate = { failures: 0, retryAt: 0, window: Number.POSITIVE_INFINITY }
  /** Box creation backoff timings. Tests shorten them. */
  readonly boxCreateTuning = { retryBaseMs: 2_000, retryMaxMs: 60_000, rateLimitMs: 10_000 }
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
  /** When reconcileBoxes last asked the provider which boxes it still has, and the check in flight. */
  private lastReconcileAt = 0
  private reconciling: Promise<void> | null = null
  /** Boxes the last probe couldn't reach, since when (the next probe that reaches one clears it). */
  private unreachable = new Map<string, number>()
  private checkingReach = new Set<string>()
  private budgetNoticeAt = 0
  /** Frees disk on low boxes in graduated steps (server/janitor.ts). */
  readonly janitor: BoxJanitor
  /** Every box lifecycle event and who did it (server/boxHistory.ts); write it with recordBoxEvent. */
  readonly history: BoxHistory
  /** Who asked for the disk cleanup running on a box ("manual" runs: Cody's button or the Coordinator's tool). */
  private cleanupBy = new Map<string, BoxActor>()
  /** Latest df per box, so a scheduling pass doesn't run df for every task. */
  private diskCache = new Map<string, { at: number; space: DiskSpace }>()
  /** Bytes new workspaces being set up on a box are about to use: box -> task -> bytes. */
  private reserved = new Map<string, Map<string, number>>()
  /** The box's slot limit when each running turn claimed its slot, by turn id (see limitLoweredFrom). */
  private claimedSlots = new Map<string, number>()
  /** Boxes the last placement check found too full for a new workspace. */
  private lowBoxes = new Set<string>()
  /** When each box's root disk was last swept for being low (sweepRootDisks). */
  private rootSweptAt = new Map<string, number>()
  /** Boxes being cleared, deleted or resized: nothing is placed on them and their tasks wait. */
  private boxOps = new Map<string, BoxOp>()
  /** Resizes in progress, by box (the old box and, once made, the new one). */
  private resizes = new Map<string, BoxResize>()
  /** Project snapshot jobs running now, by project. */
  private snapshotJobs = new Map<string, SnapshotJob>()
  /** "<projectId>:<why>" for a snapshot new boxes couldn't use that the Captain was already told about. */
  private snapshotNoted = new Set<string>()
  private lastSnapshotRetryAt = 0
  /** `<task>:<box>` pairs already told they run on a box smaller than their project's size (no fresh archive), and noteOnce keys. */
  private smallBoxNoted = new Set<string>()
  /** Tasks whose setup already hit a full disk once; the next one fails for good. */
  private diskRetried = new Set<string>()
  /** Tasks holding for a cleanup on the box their workspace lives on, after running out of space there. */
  private diskHold = new Map<string, string>()
  private lowDiskNoticeAt = new Map<string, number>()
  /** Called after every notice; return true when another owner handled delivery. */
  onNotice: ((content: string, meta: Record<string, unknown> | null, opts: NoticeOptions) => boolean | void) | null = null
  /** Hands an agent's message_captain to its project's Captain (CaptainManager.fromAgent); null when there are no Captains. */
  onCaptainMessage: ((projectId: string, input: AgentCaptainMessage) => { message: CaptainMessage; heldUntil: number | null }) | null = null
  /** Why a task can't be pinned to a runner right now (Setup.runnerProblem), or null when it can. Unset: always can. */
  runnerProblem: ((runner: Runner) => Promise<string | null>) | null = null
  /** Agents waiting mid-turn for their Captain's reply, by task. */
  private captainWaits = new Map<string, CaptainWait[]>()
  /** RunPod GPU pods, or null when this install has no GPU runner. */
  private readonly gpu: GpuRunner | null
  /** When each GPU pod's heartbeat was last touched by the idle sweep, and when the sweep last ran. */
  private gpuTouchedAt = new Map<string, number>()
  private lastGpuSweepAt = 0
  /** The pods as placement or the sweep last listed them, for list_projects (which doesn't call RunPod). */
  private gpuSeen: GpuPods = []
  /** Tasks whose Captain heard why they wait for a GPU pod (a $/hr cap), by the kind of wait: a notice once. */
  private gpuWaitNoticed = new Map<string, string>()
  /** The task event bus hooks listen on (see subscribe). */
  private readonly listeners = new Set<TaskEventListener>()

  constructor(deps: TaskManagerDeps) {
    this.gpu = deps.gpu ?? null
    this.c = deps.config
    this.store = deps.store
    this.provider = deps.provider
    this.hub = deps.hub
    this.redis = deps.redis
    this.artifacts = deps.artifacts
    this.settings = deps.settings
    this.uploads = deps.uploads
    this.reader = new EventReader(deps.provider, deps.redis)
    this.sleep = new SleepWatch()
    this.prs = new PrTracker({
      store: deps.store,
      token: deps.github?.token ?? ((projectId) => (this.c.mock ? null : (this.store.projectEnv(projectId).GITHUB_TOKEN ?? this.settings.credentials.get("githubToken")) || null)),
      fetch: deps.github?.fetch,
      onChange: (change) => this.prChanged(change),
      log: (msg) => console.warn(msg),
    })
    fs.mkdirSync(path.join(this.c.dataDir, "archives"), { recursive: true })
    this.history = new BoxHistory(this.store.db)
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
    this.sleep.start(5_000, (gap) => console.log(`[box-yard] this computer slept for ${Math.round(gap.ms / 1000)}s`))
    this.schedule()
  }

  stop() {
    this.stopped = true
    this.prs.stop()
    this.sleep.stop()
    for (const t of this.timers) clearInterval(t)
    if (this.emitBoxesTimer) clearTimeout(this.emitBoxesTimer)
    if (this.directoryTimer) clearTimeout(this.directoryTimer)
    for (const h of this.holds.values()) h.abort()
    this.holds.clear()
  }

  /** After a restart: re-attach to running turns and requeue half-started ones. */
  private recover() {
    this.forgetCopiedRoutes()
    // A resize can't pick up where it left off: say so. Its new box (if it got that far) holds no work yet.
    for (const box of this.store.listBoxes()) {
      const r = this.resizeReport(box.id)
      if (r?.status !== "running") continue
      this.finishResize(r, "failed", "Box Yard restarted during the resize; nothing was moved. Try again.")
      // The box it was making holds no work yet: delete it rather than leave it empty.
      const made = r.newBoxId ? this.store.getBox(r.newBoxId) : null
      if (made && !this.store.listTaskRows({ boxId: made.id }).length)
        void this.dropBox(made.id, r, `Box Yard restarted during the resize of ${r.boxId}, so nothing moved to it.`).then((note) => this.noteResizeCleanup(r, note))
    }
    // A project snapshot can't pick up either. Its scratch box carries this install's label, so the orphan sweep
    // deletes it; its snapshots are on the to-delete list.
    for (const p of this.store.listProjects()) {
      const job = this.snapshotJob(p.id)
      if (job?.status !== "running") continue
      job.error = "Box Yard restarted while the snapshot was being taken; try again."
      this.finishSnapshot(job, "failed", "")
    }
    void this.retryPendingSnapshots(true)
    // No turn is starting yet: messages a launch had claimed are queued (and editable) again.
    this.store.releaseInputs()
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
          const err = await this.provider.destroy(id).then(() => null, (e: unknown) => errorMessage(e))
          this.recordBoxEvent({
            boxId: id,
            type: "orphan_deleted",
            actor: { kind: "orphan-sweep" },
            reason: `At the provider with this install's label (${label}) but not in Box Yard's database.`,
            detail: err ? `The delete failed: ${err}` : null,
            size: null,
            projects: [],
            taskIds: [],
          })
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

  createTask(input: NewTask): Task {
    return this.createTasks([input])[0]!
  }

  /**
   * Throws a clear 400 when a task asked to run on `runner` (its runs_on) can't: this computer lacks claude or its
   * sign-in, or there are no Upstash boxes. Nothing falls back to the other runner. No runner asked for: no check.
   */
  async requireRunner(runner: Runner | null | undefined): Promise<void> {
    if (!runner || !this.runnerProblem) return
    const problem = await this.runnerProblem(runner)
    if (problem) throw new BadRequestError(`Can't run it on ${RUNNER_PHRASE[runner]}: ${problem}.`)
  }

  /**
   * Pin a task to a runner from its next turn on (send_to_task runs_on). Placement moves its workspace there when
   * nothing would be lost (toLocal / fromLocal), else it stays where it is and its log says why. Check with
   * requireRunner first.
   */
  setRunsOn(taskId: string, runner: Runner) {
    const row = this.requireRow(taskId)
    if (row.runs_on === runner) return
    this.store.updateTask(row.id, { runsOn: runner })
    this.addEvent(row.id, `Runs on ${RUNNER_PHRASE[runner]} from its next turn on (this task only, over its project's "Runs on").`)
    this.emitTask(row.id)
  }

  /**
   * Start several tasks at once (create_tasks). Every input is checked before anything is written, and all
   * rows go in one transaction, so either every task exists or none does. The scheduler then runs once for the
   * whole batch, so their boxes are created together (up to Settings › Boxes created at once) rather than one
   * per call.
   */
  createTasks(inputs: NewTask[]): Task[] {
    const projects = inputs.map((input) => {
      const project = this.store.getProject(input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (!input.title.trim()) throw new BadRequestError("title is required")
      if (!input.prompt.trim()) throw new BadRequestError("prompt is required")
      return project
    })
    const ids = this.store.db.transaction(() =>
      inputs.map((input, i) => {
        const route = this.initialRoute(input)
        const task = this.store.createTask({
          ...input,
          startedBy: input.scheduleId ? "schedule" : (input.source ?? "cody"),
          model: route.model,
          effort: route.effort,
          routingRule: route.routingRule,
          routingReason: route.routingReason,
          runsOn: input.runsOn ?? null,
          branch: projects[i]!.repo ? `boxyard/${slugify(input.title)}-${randomUUID().slice(0, 4)}` : null,
        })
        const files = input.attachments ?? []
        this.store.addTaskMessage(task.id, "user", input.prompt, { kind: "task_prompt", ...(files.length ? { attachments: publicFiles(files) } : {}) })
        if (files.length) this.store.queueInput(task.id, input.source ?? "orchestrator", "These files go with the task:", files.map((f) => f.id))
        return task.id
      }),
    )()
    for (const id of ids) this.emitTask(id)
    this.publishDirectory()
    this.schedule()
    return ids.map((id) => this.store.getTask(id)!)
  }

  sendInput(
    taskId: string,
    content: string,
    source: InputSource = "cody",
    attachments: StoredUpload[] = [],
    route?: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null } | null,
    /** A hook's message: the label the agent gets before it, and the transcript line's meta ("Hook: <name>"). */
    hook?: { prefix: string; meta: Record<string, unknown> },
  ): Task {
    return this.send(taskId, content, source, attachments, route, hook).task
  }

  /** sendInput that also says which queued message it made (the MCP tools hand it back for cancel/edit). */
  send(taskId: string, content: string, source: InputSource = "cody", attachments: StoredUpload[] = [], route?: Parameters<TaskManager["sendInput"]>[4], hook?: Parameters<TaskManager["sendInput"]>[5]): { task: Task; inputId: string } {
    const inputId = this.enqueue(this.requireRow(taskId), content, source, attachments, route, hook)
    this.emitTask(taskId)
    this.schedule()
    return { task: this.store.getTask(taskId)!, inputId }
  }

  // ---- queued messages: list, edit, cancel (with undo). Every change is a compare-and-set against the delivery claim.

  /** A task's queued messages in send order: the task page's Queued rows and the queue MCP tools. */
  listQueue(taskId: string): QueuedMessage[] {
    this.requireRow(taskId)
    return this.store.listQueuedInputs(taskId).map((r) => this.queuedMessage(r))
  }

  /** Replace a queued message's text. Refused (409) once a turn has taken it, or when `version` is stale. */
  editQueued(taskId: string, inputId: string, text: string, version?: number): QueuedMessage {
    this.requireRow(taskId)
    const current = this.store.getQueuedInput(taskId, inputId)
    if (!current) throw this.queueConflict(null)
    if (!text.trim() && !current.attachments.length) throw new BadRequestError("A queued message can't be empty. Delete it instead.")
    const change = this.store.editInput(taskId, inputId, text.trim(), version)
    if (!change.ok) throw this.queueConflict(change.row, version)
    this.emitTask(taskId)
    return this.queuedMessage(change.row)
  }

  /**
   * Delete a queued message before it goes out (restoreQueued undoes it for a while). When it was the last one,
   * a task that was only waiting to deliver it goes back to how it was, and a turn that was starting for it is dropped.
   */
  cancelQueued(taskId: string, inputId: string): QueuedMessage {
    this.requireRow(taskId)
    const change = this.store.cancelInput(taskId, inputId)
    if (!change.ok) throw this.queueConflict(change.row)
    const row = this.requireRow(taskId)
    if (!this.store.hasInputs(taskId) && row.session_started && !row.compact_pending && !this.store.turnFlags(row).interrupts) {
      if (row.current_turn_id && row.status === "starting") this.cancelledAll.add(taskId)
      else if (!row.current_turn_id && row.status === "queued") this.store.updateTask(taskId, { status: this.queuedFrom(taskId), waitReason: null })
    }
    this.emitTask(taskId)
    return this.queuedMessage(change.row)
  }

  /** Undo a cancel: the message is queued again in its old place, and a resting task resumes for it. */
  restoreQueued(taskId: string, inputId: string): QueuedMessage {
    this.requireRow(taskId)
    const change = this.store.restoreInput(taskId, inputId)
    if (!change.ok) {
      if (change.row?.status === "queued") return this.queuedMessage(change.row)
      throw new ConflictError(change.row ? this.queueConflict(change.row).message : "That message can't be restored any more: it is gone.")
    }
    this.cancelledAll.delete(taskId)
    const row = this.requireRow(taskId)
    if (!row.current_turn_id && RESTING.includes(row.status)) {
      this.store.setKv(queuedFromKey(row.id), row.status)
      this.store.updateTask(taskId, { status: "queued", error: null })
    }
    this.emitTask(taskId)
    this.schedule()
    return this.queuedMessage(change.row)
  }

  /** Why a queued message can't be changed (any more), as a 409. */
  private queueConflict(row: QueuedInputRow | null, version?: number): ConflictError {
    if (!row) return new ConflictError("That message was already delivered to the agent (or the task was stopped), so it can't be changed.")
    if (row.status === "delivering") return new ConflictError("That message is already being delivered to the agent, so it can't be changed.")
    if (row.status === "cancelled") return new ConflictError("That message was deleted.")
    if (version !== undefined && row.version !== version) return new ConflictError("That message was changed since you opened it. Reload and try again.")
    return new ConflictError("That message can't be changed right now.")
  }

  /** The status a resting task had before a message queued it: where cancelling all its messages returns it. */
  private queuedFrom(taskId: string): TaskStatus {
    const prev = this.store.getKv(queuedFromKey(taskId)) as TaskStatus | null
    return prev && RESTING.includes(prev) && prev !== "queued" ? prev : "idle"
  }

  private queuedMessage(r: QueuedInputRow): QueuedMessage {
    const [kind, ref] = r.source.split(/:(.*)/s) as [string, string | undefined]
    const meta = r.message ?? (kind === "captain" && ref ? captainMeta(this.store, ref) : kind === "hook" ? { source: "hook" } : { source: r.source })
    const owner = this.owner()
    const sender: { kind: QueuedSender; label: string } =
      kind === "agent"
        ? { kind: "agent", label: `From ${(ref && this.store.getTask(ref)?.title) || ref || "an agent"}` }
        : kind === "system"
          ? { kind: "system", label: "Box Yard" }
          : kind === "orchestrator"
            ? { kind: "coordinator", label: "Coordinator" }
            : kind === "captain"
              ? { kind: "captain", label: userMessageLabel(meta, owner) }
              : kind === "hook"
                ? { kind: "hook", label: userMessageLabel(meta, owner) }
                : { kind: "owner", label: userMessageLabel(meta, owner) }
    const shown = Array.isArray(r.message?.attachments) ? (r.message.attachments as Attachment[]) : null
    const attachments = shown ?? r.attachments.flatMap((id) => {
      const f = this.uploads.get(id)
      return f ? publicFiles([f]) : []
    })
    return {
      id: r.id,
      taskId: r.taskId,
      source: r.source,
      kind: sender.kind,
      sender: sender.label,
      text: r.content,
      attachments,
      status: r.status === "delivering" ? "delivering" : "queued",
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
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
    // Messages from Cody, the Coordinator, a Captain or a hook get their transcript line when a turn delivers them;
    // until then the task page shows them as Queued rows (editable, cancellable).
    const shown = source === "cody" || source === MERGE_BUTTON_SOURCE || source === "orchestrator" || source.startsWith("captain:") || hook
    const from = hook ? hook.meta : source.startsWith("captain:") ? captainMeta(this.store, source.slice("captain:".length)) : { source }
    const message = shown ? { ...from, ...(attachments.length ? { attachments: publicFiles(attachments) } : {}) } : undefined
    const inputId = this.store.queueInput(row.id, source, content.trim(), attachments.map((f) => f.id), { prefix: hook?.prefix, message })
    // The project's Captain answering an agent that waits mid-turn (message_captain): hand it over now.
    if (source === `captain:${row.project_id}` && !hook && !attachments.length && content.trim()) this.handToWaitingAgent(row, inputId, content.trim())
    const patch: Parameters<Store["updateTask"]>[1] = { lastActiveAt: Date.now() }
    if (route?.model) patch.model = route.model
    if (route?.effort) patch.effort = route.effort
    if (route?.routingRule !== undefined) patch.routingRule = route.routingRule
    if (route?.routingReason !== undefined) patch.routingReason = route.routingReason
    if (row.status === "needs_input" && source !== "system" && !source.startsWith("agent:")) patch.question = null
    if (!row.current_turn_id && RESTING.includes(row.status)) {
      patch.status = "queued"
      patch.error = null
      this.store.setKv(queuedFromKey(row.id), row.status)
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
      this.dropQueuedMessages(row.id)
      this.store.updateTask(row.id, { compactPending: false, status: row.turn_count > 0 ? "idle" : "failed", error: row.turn_count > 0 ? null : "Stopped before it started." }, { quiet: true })
    }
    this.addEvent(row.id, withOwner("Stopped by Cody.", this.owner()))
    this.emitTask(row.id)
    return this.store.getTask(row.id)!
  }

  /** The queue is dropped (stop, close): what people sent lands in the transcript marked undelivered. */
  private dropQueuedMessages(taskId: string) {
    for (const m of this.store.dropInputs(taskId)) this.hub.broadcast({ type: "task.message", message: m })
  }

  /** Finish a task: stop it, archive it, free its box folder. */
  async closeTask(taskId: string): Promise<Task> {
    const row = this.requireRow(taskId)
    if (row.current_turn_id) await this.stopTask(taskId)
    this.dropQueuedMessages(row.id)
    this.store.updateTask(row.id, { status: "done", question: null }, { quiet: true })
    this.addEvent(row.id, isLocalRunnerBox(row.box_id) ? "Closed. Its folder on this computer stays until the task is deleted." : "Closed. Its workspace was archived and its box slot freed.")
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
    const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.settings.credentials.get("githubToken")
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
    // A GPU pod isn't started just for a link: publicUrl says when it's down.
    if (!isGpuBox(row.box_id)) await this.provider.wake(row.box_id)
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
    if (isLocalRunnerBox(boxId)) return this.settings.get().localAgents
    if (isGpuBox(boxId)) return this.store.projectBoxLimits(gpuBoxProject(boxId)).agentsPerBox ?? this.gpu?.settings().agentsPerPod ?? 1
    return this.sizeLimits(normalizeBoxSize(this.store.getBox(boxId)?.size)).slotsPerBox
  }

  /**
   * When a box runs more agents than its slots because the limit was lowered under them (Settings › Agents per
   * box, or the box's size default): the limit those turns started under, or null. Only turns started since
   * this server came up are known.
   */
  private limitLoweredFrom(boxId: string, residents: TaskRow[]): number | null {
    const running = residents.filter(holdsSlot)
    const slots = this.slotsFor(boxId)
    if (running.length <= slots) return null
    const was = Math.max(0, ...running.map((r) => (r.current_turn_id ? (this.claimedSlots.get(r.current_turn_id) ?? 0) : 0)))
    return was > slots ? was : null
  }

  /** Size for a new box made for a project: its preferred size, else Settings → Worker size. */
  newBoxSize(projectId?: string | null): BoxSize {
    return (projectId ? this.store.getProject(projectId)?.boxSize : null) ?? this.settings.get().workerSize
  }

  /** Agents (running turns) across all boxes. Local-runner turns have their own limit (Settings › Local agents). */
  runningTotal() {
    return this.store.listTaskRows().filter((r) => holdsSlot(r) && !isLocalRunnerBox(r.box_id) && !isGpuBox(r.box_id)).length
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
      localAgents: this.slotsFor(LOCAL_BOX_ID),
      localAgentsRunning: this.runningOn(LOCAL_BOX_ID),
      boxesCreating: this.boxCreation(),
    }
  }

  /**
   * A project's box settings as they apply now (list_projects, pool_status): each one its own ("… (this project)")
   * or the global setting it falls back to. Agents and task folders per box follow each box's size unless Settings
   * or env set one number for every box.
   */
  projectBoxSettings(p: Pick<Project, "id" | "boxSize" | "agentsPerBox" | "tasksPerBox" | "maxBoxes">) {
    const s = this.settings.get()
    const o = this.settings.boxLimitOverrides()
    const global = (k: "slotsPerBox" | "maxResidentPerBox", label: string) =>
      o[k] !== null ? `global: ${o[k]} (Settings › ${label})` : `global: each box's size default (${BOX_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(", ")})`
    const own = (v: number | string) => `${v} (this project)`
    const used = this.projectBoxCap(p.id)?.used.size ?? 0
    return {
      boxSize: p.boxSize ? own(p.boxSize) : `global: ${s.workerSize} (Settings › Worker size)`,
      agentsPerBox: p.agentsPerBox !== null ? own(p.agentsPerBox === 1 ? "1: each agent alone on a box" : p.agentsPerBox) : global("slotsPerBox", "Agents per box"),
      tasksPerBox: p.tasksPerBox !== null ? own(p.tasksPerBox) : global("maxResidentPerBox", "Resident tasks per box"),
      maxBoxes: p.maxBoxes !== null ? `${p.maxBoxes} (this project; it uses ${boxCount(used)} now)` : `global: only the pool's Max boxes (${s.maxBoxes})`,
    }
  }

  /**
   * A project's RunPod GPU pods and caps as they apply now (list_projects, pool_status), from the pods as last listed
   * (`fresh` lists them again). Null when this Box Yard has no GPU runner.
   */
  async projectGpuSettings(p: Pick<Project, "id" | "gpuMaxHourlyUsd" | "maxBoxes" | "gpuMachine">, fresh = false) {
    if (!this.gpu) return null
    if (fresh && this.gpu.enabled()) await this.gpuPods()
    const s = this.gpu.settings()
    const usd = (n: number) => `$${Math.round(n * 100) / 100}/hr`
    const pods = this.gpuSeen.filter((x) => gpuBoxProject(x.boxId) === p.id).sort((a, b) => gpuBoxIndex(a.boxId) - gpuBoxIndex(b.boxId))
    const own = p.gpuMaxHourlyUsd
    const m = p.gpuMachine
    const from = (mine: unknown, global: string) => (mine !== null ? "this project" : `global: Settings › RunPod GPU › ${global}`)
    return {
      gpuTypes: `${(m.gpuTypes ?? s.gpuTypes).map(shortGpu).join(", ")} (${from(m.gpuTypes, "GPU types")})`,
      cloud: `${m.cloud ?? s.cloud} (${from(m.cloud, "Cloud")})`,
      minRamGb: `${m.minRamGb ?? s.minRamGb} (${from(m.minRamGb, "Min RAM")})`,
      minVcpus: `${m.minVcpus ?? s.minVcpus} (${from(m.minVcpus, "Min vCPUs")})`,
      maxHourlyUsd: own !== null ? `${own ? usd(own) : "none"} (this project)` : `global: ${usd(s.maxHourlyUsd)} (Settings › RunPod GPU › Max per project)`,
      totalMaxHourlyUsd: `${usd(s.totalMaxHourlyUsd)} for every project's pods together (Settings › RunPod GPU › Max for all pods)`,
      maxPods: p.maxBoxes !== null ? `${Math.min(p.maxBoxes, MAX_GPU_PODS)} (its Max boxes)` : `${MAX_GPU_PODS} (no Max boxes set; the $/hr caps bound it)`,
      agentsPerPod: this.slotsFor(gpuBoxId(p.id)),
      pods: pods.map(({ boxId, pod }) => `#${gpuBoxIndex(boxId)} ${boxId}: ${pod.status.toLowerCase()}${pod.gpu?.id ? ` ${shortGpu(pod.gpu.id)}` : ""}${pod.cost ? ` ${usd(pod.cost)}` : ""}, ${this.runningOn(boxId)}/${this.slotsFor(boxId)} agents`),
      spend: usd(pods.reduce((sum, x) => sum + (x.pod.cost ?? 0), 0)),
    }
  }

  /** Box creation for pool_status: how many are on their way, how many may be at once, and any backoff. */
  private boxCreation() {
    const wait = this.boxCreate.retryAt - Date.now()
    const atOnce = this.createConcurrency()
    return {
      now: this.poolCreates,
      atOnce: atOnce < this.settings.get().boxCreateConcurrency ? `${atOnce} (lowered after a rate limit; Settings › Boxes created at once is ${this.settings.get().boxCreateConcurrency})` : atOnce,
      ...(wait > 0 ? { backoff: `the next create waits ${Math.ceil(wait / 1000)}s after ${this.boxCreate.failures || 1} failure${this.boxCreate.failures > 1 ? "s" : ""}${this.lastBoxError ? `: ${this.lastBoxError.message}` : ""}` } : {}),
    }
  }

  boxes(): BoxInfo[] {
    this.meterBoxes()
    const rates = this.settings.get().costRates
    const floor = this.diskNeed(null)
    const memoryPolicy = this.memoryPolicy()
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
        runningTurns: residents.filter(holdsSlot).length,
        projectLimit: this.projectLimitOn(b.id, residents),
        limitLoweredFrom: this.limitLoweredFrom(b.id, residents),
        residentTasks: residents.map((r) => r.id),
        projects: [...new Set(residents.map((r) => this.store.getProject(r.project_id)?.name ?? r.project_id))],
        projectIds: this.projectsOnBox(b.id),
        activeMs: b.active_ms ?? 0,
        uptimeMs,
        diskBytes: b.disk_bytes ?? null,
        diskFreeBytes: b.disk_free_bytes ?? null,
        diskTotalBytes: b.disk_total_bytes ?? null,
        diskCheckedAt: b.disk_checked_at ?? null,
        unreachableSince: this.unreachable.get(b.id) ?? null,
        rootFreeBytes: b.root_free_bytes ?? null,
        rootTotalBytes: b.root_total_bytes ?? null,
        memUsedBytes: b.mem_used_bytes ?? null,
        memTotalBytes: b.mem_total_bytes ?? null,
        loadAvg: b.load_avg ?? null,
        cpuCount: b.cpu_count ?? null,
        memoryPressure: memoryPressure(boxMemory(b), memoryPolicy),
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
      const root = tasksRootOf(this.provider, boxId)
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
    if (!box && this.history.boxIds().includes(boxId)) return goneCleanup(boxId, "clear")
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status === "ready" && !this.boxOperation(boxId) && (await this.goneAtProvider(boxId))) {
      await this.loseGoneBox(boxId, "Clear box")
      return goneCleanup(boxId, "clear")
    }
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
    if (!box) {
      // Already deleted or lost: deleting it again is a no-op.
      if (this.history.boxIds().includes(boxId)) return
      throw new NotFoundError(`Box ${boxId} not found`)
    }
    // Deleted outside Box Yard: there's nothing to archive or destroy, only records to drop.
    if (box.status === "ready" && !this.boxOps.has(boxId) && (await this.goneAtProvider(boxId))) return this.loseGoneBox(boxId, "Delete box")
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
      await this.loseBox(boxId, withOwner("Box deleted by Cody.", this.owner()), false, {
        type: "deleted",
        actor: { kind: "owner" },
        detail: box.status === "ready" ? "Deleted from the Boxes page; every workspace was archived first." : `Deleted from the Boxes page while ${box.status}.`,
      })
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
        let made: Awaited<ReturnType<TaskManager["createFor"]>>
        try {
          made = await this.createFor(owner, this.boxLabels(owner), r.to)
          id = made.id
          this.store.upsertBox({ id, provider: providerOf(this.provider, id).name, status: "ready", created_at: Date.now(), last_used_at: Date.now(), size: r.to, keep_alive: old.keep_alive, usage_source: "estimated" })
        } catch (err) {
          throw new Error(`Couldn't create a ${r.to} box: ${errorMessage(err)}`)
        } finally {
          this.creatingBoxes--
        }
        created = id
        this.recordBoxEvent({
          boxId: id,
          type: "created",
          actor: { kind: "resize" },
          reason: `Target of the resize of ${r.boxId} ${r.from} → ${r.to}, asked by ${initiatorLabel(r.by, this.initiatorProjectName(r.by))}${r.reason ? `: ${r.reason}` : "."}`,
          relatedBoxId: r.boxId,
          resizeId: r.id,
          detail: createdDetail(made, owner ? this.store.getProject(owner)?.name : undefined),
          projects: this.projectsOnBox(r.boxId).map((p) => ({ id: p, name: this.store.getProject(p)?.name ?? p })),
          taskIds: this.store.listTaskRows({ boxId: r.boxId }).map((row) => row.id),
        })
        this.afterCreateFor(id, owner, made, { kind: "resize" })
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
      if (created) r.cleanup = await this.dropBox(created, r, `Nothing moved to it: the resize of ${r.boxId} failed at its ${r.steps.find((s) => s.status === "failed")?.key ?? "create"} step.`)
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
      await this.loseBox(r.boxId, `Box ${r.boxId} was resized.`, true, {
        type: "deleted",
        actor: { kind: "resize" },
        reason: `Resized ${r.from} → ${r.to}; ${to} took over its work.`,
        fromSize: r.from,
        toSize: r.to,
        relatedBoxId: to,
        resizeId: r.id,
        projects: this.projectsOnBox(to).map((id) => ({ id, name: this.store.getProject(id)?.name ?? id })),
        taskIds: r.movedTasks,
      })
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
  private async dropBox(boxId: string, r: BoxResize | null, why: string): Promise<string> {
    const box = this.store.getBox(boxId)
    this.boxOps.delete(boxId)
    this.resizes.delete(boxId)
    this.store.setKv(boxOwnerKey(boxId), null)
    if (!box) return `The new box ${boxId} is already gone.`
    this.store.setBoxStatus(boxId, "deleting")
    this.emitBoxes()
    try {
      await this.provider.destroy(boxId)
      this.recordBoxEvent({
        boxId,
        type: "deleted",
        actor: { kind: "resize-cleanup" },
        reason: why,
        fromSize: r?.from ?? null,
        toSize: r?.to ?? null,
        relatedBoxId: r && r.boxId !== boxId ? r.boxId : null,
        resizeId: r?.id ?? null,
        // Made for the box being resized: its projects are the ones that lost the box.
        projects: r ? this.projectsOnBox(r.boxId).map((p) => ({ id: p, name: this.store.getProject(p)?.name ?? p })) : [],
        taskIds: [],
      })
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
        const fromResize = made?.newBoxId === box.id && made.boxId !== box.id ? made : null
        const note = await this.dropBox(box.id, fromResize, `Retried the delete of a box ${fromResize ? `the failed resize of ${fromResize.boxId} made` : "Box Yard was deleting"}; the last attempt didn't go through.`)
        if (fromResize) this.noteResizeCleanup(fromResize, note)
        continue
      }
      const r = this.resizeReport(box.id)
      if (box.status !== "ready" || r?.status !== "failed" || r.newBoxId !== box.id || r.boxId === box.id) continue
      // Used since (it took tasks once the resize gave up): it's a pool box like any other now.
      if (box.last_used_at > (r.finishedAt ?? r.startedAt) + 60_000) continue
      const note = await this.dropBox(box.id, r, `Left empty by the failed resize of ${r.boxId} (${r.from} → ${r.to}) and never used since.`)
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
    const migrated = status === "done" && r.mode === "migration" && r.newBoxId
    this.recordBoxEvent({
      boxId: r.boxId,
      type: status === "done" ? "resized" : "resize_failed",
      actor: resizeActor(r.by),
      reason: r.reason,
      size: r.from,
      fromSize: r.from,
      toSize: r.to,
      relatedBoxId: r.newBoxId,
      resizeId: r.id,
      detail: status === "done" ? `${r.mode === "in-place" ? "In place" : `Migrated to ${r.newBoxId}`}: ${resizeSummary(r)}` : (error ?? "failed"),
      ...(migrated ? { projects: this.projectsOnBox(r.newBoxId!).map((p) => ({ id: p, name: this.store.getProject(p)?.name ?? p })), taskIds: r.movedTasks } : {}),
    })
    console.log(`[box-yard] resize of ${r.boxId} ${status}${error ? `: ${error}` : ""}`)
    if (r.by.kind !== "cody") this.announceResize(r)
    this.schedule()
  }

  private initiatorProjectName(by: ResizeInitiator) {
    return by.kind === "captain" ? this.store.getProject(by.projectId)?.name : undefined
  }

  /** A resize the Coordinator or a Captain made: a notice for the Coordinator and the box's Captains, and a notification for Cody. */
  private announceResize(r: BoxResize) {
    const captainProject = r.by.kind === "captain" ? r.by.projectId : null
    const who = initiatorLabel(r.by, captainProject ? this.store.getProject(captainProject)?.name : undefined)
    const boxId = r.newBoxId && r.status === "done" ? r.newBoxId : r.boxId
    const forProject = r.by.kind === "scheduler" ? [r.by.projectId] : []
    const projectIds = [...new Set(this.store.listTaskRows({ boxId }).map((t) => t.project_id).concat(this.store.getKv(boxOwnerKey(boxId)) ?? [], forProject))].filter(
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

  // ------------------------------------------------------------------ project snapshots

  /** A project's running snapshot job, or its last one (shared/snapshots.ts). */
  snapshotJob(projectId: string): SnapshotJob | null {
    const live = this.snapshotJobs.get(projectId)
    if (live) return structuredClone(live)
    const raw = this.store.getKv(snapshotJobKey(projectId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as SnapshotJob
    } catch {
      return null
    }
  }

  /**
   * Take a snapshot of a box for a project, for its new boxes to start from. The box itself is never changed: it's
   * snapshotted as it is (nothing is placed on it meanwhile), that snapshot is restored on a scratch box, the scratch
   * box is stripped of every workspace, login, temp file and log (server/boxSnapshot.ts) and snapshotted again, and
   * the scratch box and the first snapshot are deleted. Refuses while agents run on the box, for a project that runs
   * on this computer, and for a box that doesn't hold the project's work. Answers right away with the running job;
   * progress goes out as SSE `project.snapshot`. A snapshot the project had is deleted once the new one is saved.
   */
  async snapshotBox(boxId: string, projectId: string, opts: { by?: SnapshotInitiator; reason?: string | null } = {}): Promise<SnapshotJob> {
    const project = this.store.getProject(projectId)
    if (!project) throw new NotFoundError(`Project ${projectId} not found`)
    if (project.runner === "local") throw new BadRequestError(`${project.name} runs on this computer, so it has no boxes to snapshot.`)
    if (isLocalRunnerBox(boxId)) throw new BadRequestError("This computer (the local runner) is never snapshotted.")
    if (project.runner === "gpu" || isGpuBox(boxId)) throw new BadRequestError(`${project.name} runs on RunPod GPU pods: pod #1's network volume keeps caches between its runs, so it has no box snapshot.`)
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status !== "ready") throw new BadRequestError(`Box ${boxId} is ${box.status}; only a running box can be snapshotted.`)
    const own = providerOf(this.provider, boxId)
    if (!own.snapshot || !own.deleteSnapshot) throw new BadRequestError(`${own.name} boxes can't be snapshotted.`)
    if (!this.projectsOnBox(boxId).includes(projectId)) {
      throw new BadRequestError(`Box ${boxId} doesn't hold ${project.name}'s work: snapshot a box its tasks ran on, so its repo and dependencies are there.`)
    }
    if (this.snapshotJobs.has(projectId)) throw new ConflictError(`A snapshot for ${project.name} is already being taken.`)
    this.claimBox(boxId, "snapshot", false)
    const step = (key: SnapshotStep["key"]): SnapshotStep => ({ key, label: SNAPSHOT_STEP_LABELS[key], status: "pending", detail: null })
    const job: SnapshotJob = {
      id: `snp_${randomUUID().slice(0, 12)}`,
      projectId,
      boxId,
      size: normalizeBoxSize(box.size),
      status: "running",
      steps: (["snapshot", "restore", "strip", "save", "cleanup"] as const).map(step),
      by: opts.by ?? { kind: "cody" },
      reason: opts.reason?.trim() || null,
      scratchBoxId: null,
      snapshotId: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    }
    this.snapshotJobs.set(projectId, job)
    this.publishSnapshot(job)
    console.log(`[box-yard] snapshotting box ${boxId} for project ${project.name}`)
    void this.runSnapshot(job)
    return structuredClone(job)
  }

  /** Forget a project's snapshot and delete it at the provider; its new boxes start cold again. */
  async clearProjectSnapshot(projectId: string): Promise<Project> {
    const project = this.store.getProject(projectId)
    if (!project) throw new NotFoundError(`Project ${projectId} not found`)
    if (this.snapshotJobs.has(projectId)) throw new ConflictError(`A snapshot for ${project.name} is being taken; clear it once that's done.`)
    const snap = project.snapshot
    if (!snap) return project
    const updated = this.store.setProjectSnapshot(projectId, null)!
    this.hub.broadcast({ type: "project", project: updated })
    await this.dropSnapshot(snap.id)
    console.log(`[box-yard] cleared project ${project.name}'s snapshot ${snap.id}`)
    return updated
  }

  /** A project being deleted: its snapshot goes too. A job still running for it drops its own when it sees the project gone. */
  async projectDeleted(projectId: string) {
    const snap = this.store.getProject(projectId)?.snapshot
    if (!snap) return
    this.store.setProjectSnapshot(projectId, null)
    await this.dropSnapshot(snap.id)
  }

  private async runSnapshot(job: SnapshotJob) {
    const own = providerOf(this.provider, job.boxId)
    const project = this.store.getProject(job.projectId)!
    const base = `boxyard-${this.installLabel().slice(3)}-${slugify(project.name).slice(0, 24) || "project"}-${job.id.slice(4)}`
    let raw: string | null = null
    let scratch: string | null = null
    let saved: { id: string; bytes: number | null } | null = null
    let stripped = ""
    // The scratch box is at the provider but never in the database: counted as a box being created, so the orphan
    // sweep leaves it alone. It carries this install's label, so after a crash the sweep deletes it.
    let holdingScratch = false
    try {
      await this.snapshotStep(job, "snapshot", async () => {
        try {
          // A cleanup may be removing files right now; let it finish first.
          while (this.janitor.isRunning(job.boxId)) await new Promise((r) => setTimeout(r, 200))
          await own.wake(job.boxId).catch(() => {})
          const info = await own.snapshot!(job.boxId, `${base}-raw`)
          raw = info.id
          this.addPendingSnapshot(raw)
          return `${raw}${info.bytes ? ` (${formatBytes(info.bytes)})` : ""}`
        } finally {
          // The rest happens on a copy: the box takes work again.
          if (this.boxOps.get(job.boxId) === "snapshot") this.boxOps.delete(job.boxId)
          this.emitBoxes()
          this.schedule()
        }
      })
      await this.snapshotStep(job, "restore", async () => {
        this.creatingBoxes++
        holdingScratch = true
        const id = await own.create({ labels: [...this.boxLabels(job.projectId), "snapshot-scratch"], size: job.size, snapshotId: raw! })
        if (id === job.boxId || this.store.getBox(id)) throw new Error(`the provider answered with a box Box Yard already uses (${id})`)
        scratch = id
        job.scratchBoxId = id
        this.recordBoxEvent({
          boxId: id,
          type: "created",
          actor: { kind: "snapshot" },
          reason: `Scratch copy of ${job.boxId} for ${project.name}'s snapshot; it's stripped, snapshotted and deleted.`,
          size: job.size,
          relatedBoxId: job.boxId,
          projects: [{ id: project.id, name: project.name }],
          taskIds: [],
        })
        const root = own.root(id)
        const mark = await own.exec(id, `mkdir -p ${q(`${root}/.boxyard`)} && printf '%s' ${q(job.id)} > ${q(`${root}/${SCRATCH_MARKER}`)}`)
        if (mark.exitCode !== 0) throw new Error(`couldn't mark the scratch box: ${(mark.stderr || mark.stdout).trim().slice(-300)}`)
        return id
      })
      await this.snapshotStep(job, "strip", async () => {
        const id = scratch!
        const root = own.root(id)
        const tasks = own.tasksRoot?.(id) ?? `${root}/tasks`
        const notes: string[] = []
        const current = this.store.getProject(job.projectId) ?? project
        const works = this.store
          .listTaskRows({ boxId: job.boxId })
          .filter((r) => r.project_id === job.projectId)
          .map((r) => `${tasks}/${r.id}/work`)
        if (works.length && this.depCache(current)) {
          const runner = `${root}/.boxyard/box-runner.mjs`
          await own.writeFile(id, runner, this.runnerSource())
          const deps = await own.exec(id, depsSaveScript({ root, nodeBin: own.nodeBin, runner, works, maxMb: this.settings.get().depCacheMaxMb }))
          const line = depsSaveSummary(deps.stdout)
          if (line) notes.push(line)
        }
        const keepMirror = this.repoMirrorName(current.repo)
        const res = await own.exec(id, stripScript({ root, tasks, ...(own.snapshotDirs?.(id) ?? { home: "$HOME", tmp: "/tmp" }), keepMirror, jobId: job.id }))
        if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim().slice(-500) || `the strip script exited ${res.exitCode}`)
        stripped = stripSummary(stripCounts(res.stdout), keepMirror)
        return [stripped, ...notes].join(". ")
      })
      await this.snapshotStep(job, "save", async () => {
        const info = await own.snapshot!(scratch!, base)
        saved = info
        this.addPendingSnapshot(info.id)
        const snap: ProjectSnapshot = { id: info.id, provider: own.name, size: job.size, boxId: job.boxId, bytes: info.bytes, takenAt: Date.now() }
        const old = this.store.getProject(job.projectId)?.snapshot ?? null
        const updated = this.store.setProjectSnapshot(job.projectId, snap)
        if (!updated) throw new Error(`project ${project.name} was deleted meanwhile`)
        this.removePendingSnapshot(info.id)
        job.snapshotId = info.id
        for (const k of this.snapshotNoted) if (k.startsWith(`${job.projectId}:`)) this.snapshotNoted.delete(k)
        this.hub.broadcast({ type: "project", project: updated })
        // Replace: the snapshot it had goes once the new one is the project's.
        if (old && old.id !== info.id) await this.dropSnapshot(old.id)
        return `${info.id}${info.bytes ? ` (${formatBytes(info.bytes)})` : ""}${old && old.id !== info.id ? `; deleted the previous snapshot ${old.id}` : ""}`
      })
    } catch (err) {
      job.error = `${SNAPSHOT_STEP_LABELS[job.steps.find((s) => s.status === "failed")?.key ?? "snapshot"]}: ${errorMessage(err)}`
    }
    // Always: the scratch box and the first snapshot go, and so does a final one the project didn't keep.
    const failedEarly = job.error !== null
    await this.snapshotStep(job, "cleanup", async () => {
      const done: string[] = []
      const left: string[] = []
      if (scratch) {
        const id: string = scratch
        const err = await own.destroy(id).then(
          () => null,
          (e: unknown) => errorMessage(e),
        )
        this.recordBoxEvent({
          boxId: id,
          type: "deleted",
          actor: { kind: "snapshot" },
          reason: `Scratch copy of ${job.boxId} for ${project.name}'s snapshot, no longer needed.`,
          detail: err ? `The delete failed (${err}); the orphan sweep removes it.` : null,
          size: job.size,
          relatedBoxId: job.boxId,
          projects: [{ id: project.id, name: project.name }],
          taskIds: [],
        })
        if (err) left.push(`scratch box ${id} (${err})`)
        else done.push(`scratch box ${id}`)
      }
      const unwanted: string[] = [...(raw ? [raw] : []), ...(saved && job.snapshotId !== (saved as { id: string }).id ? [(saved as { id: string }).id] : [])]
      for (const id of unwanted) {
        const err = await own.deleteSnapshot!(id).then(
          () => null,
          (e: unknown) => errorMessage(e),
        )
        if (err) left.push(`snapshot ${id} (${err})`)
        else {
          this.removePendingSnapshot(id)
          done.push(`snapshot ${id}`)
        }
      }
      if (left.length) throw new Error(`couldn't delete ${left.join(", ")}; Box Yard retries the snapshots`)
      return done.length ? `deleted ${done.join(" and ")}` : null
    }).catch((err) => {
      if (!failedEarly) console.warn(`[box-yard] snapshot ${job.id} cleanup: ${errorMessage(err)}`)
    })
    if (holdingScratch) this.creatingBoxes--
    this.finishSnapshot(job, failedEarly ? "failed" : "done", stripped)
  }

  private async snapshotStep(job: SnapshotJob, key: SnapshotStep["key"], fn: () => Promise<string | null>) {
    const s = job.steps.find((x) => x.key === key)!
    s.status = "running"
    this.publishSnapshot(job)
    try {
      s.detail = await fn()
      s.status = "done"
    } catch (err) {
      s.status = "failed"
      s.detail = errorMessage(err)
      throw err
    } finally {
      this.publishSnapshot(job)
    }
  }

  private publishSnapshot(job: SnapshotJob) {
    const copy = structuredClone(job)
    this.store.setKv(snapshotJobKey(job.projectId), JSON.stringify(copy))
    this.hub.broadcast({ type: "project.snapshot", job: copy })
    this.emitBoxes()
  }

  private finishSnapshot(job: SnapshotJob, status: "done" | "failed", stripped: string) {
    job.status = status
    job.finishedAt = Date.now()
    for (const s of job.steps) if (s.status === "pending" || s.status === "running") s.status = s.status === "running" ? "failed" : "skipped"
    this.snapshotJobs.delete(job.projectId)
    if (this.boxOps.get(job.boxId) === "snapshot") this.boxOps.delete(job.boxId)
    this.publishSnapshot(job)
    const project = this.store.getProject(job.projectId)
    const name = project?.name ?? job.projectId
    this.recordBoxEvent({
      boxId: job.boxId,
      type: status === "done" ? "snapshot" : "snapshot_failed",
      actor: snapshotActor(job.by),
      reason: job.reason,
      size: job.size,
      relatedBoxId: job.scratchBoxId,
      projects: [{ id: job.projectId, name }],
      detail:
        status === "done"
          ? `Saved as ${name}'s snapshot ${job.snapshotId}: new boxes for it start from it. ${stripped}.`
          : `${job.error ?? "failed"}. The box itself wasn't changed.`,
    })
    console.log(`[box-yard] snapshot of ${job.boxId} for ${name} ${status}${job.error ? `: ${job.error}` : ""}`)
    if (project) this.announceSnapshot(job, project)
    this.schedule()
  }

  /** A notice for the project's Captain and the Coordinator (waking the Captain that asked), and a notification for Cody. */
  private announceSnapshot(job: SnapshotJob, project: Project) {
    const who = job.by.kind === "cody" ? withOwner("Cody", this.owner()) : job.by.kind === "coordinator" ? "The Coordinator" : `The ${project.name} Captain`
    const why = job.reason ? ` Reason: ${job.reason}` : ""
    const content =
      job.status === "done"
        ? `📦 **${project.name}** snapshot saved: ${who} snapshotted box ${job.boxId} (${job.size}). New ${project.name} boxes of ${job.size} or bigger now start from snapshot ${job.snapshotId}, with its repo, dependencies and tools.${why}`
        : `⚠️ **${project.name}** snapshot failed: ${who} tried to snapshot box ${job.boxId}. ${job.error ?? "It failed"}${/[.!?]$/.test(job.error ?? "") ? "" : "."} Box ${job.boxId} wasn't changed.${why}`
    this.notice(content, { boxId: job.boxId, snapshotJobId: job.id, projectIds: [project.id], ...(job.by.kind === "captain" ? { captainProjectId: job.by.projectId } : {}) })
    this.store.addBoxNotification({
      boxId: job.boxId,
      title: job.status === "done" ? `Snapshot saved for ${project.name}` : `Snapshot for ${project.name} failed`,
      summary: `${who}${job.reason ? `: ${job.reason}` : ""}${job.status === "failed" ? ` (${job.error ?? "failed"})` : ""}`,
      status: job.status === "done" ? "done" : "failed",
      projectId: project.id,
      projectName: project.name,
      href: `/projects/${project.id}?tab=settings`,
    })
  }

  /** Delete a snapshot, or keep it on the list to retry (maintain) when the provider can't right now. */
  private async dropSnapshot(snapshotId: string) {
    this.addPendingSnapshot(snapshotId)
    await this.retryPendingSnapshots(true)
  }

  private pendingSnapshots(): string[] {
    try {
      const ids = JSON.parse(this.store.getKv(PENDING_SNAPSHOTS_KEY) ?? "[]") as unknown
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim() !== "") : []
    } catch {
      return []
    }
  }

  private addPendingSnapshot(id: string) {
    const ids = this.pendingSnapshots()
    if (!ids.includes(id)) this.store.setKv(PENDING_SNAPSHOTS_KEY, JSON.stringify([...ids, id]))
  }

  private removePendingSnapshot(id: string) {
    const ids = this.pendingSnapshots().filter((x) => x !== id)
    this.store.setKv(PENDING_SNAPSHOTS_KEY, ids.length ? JSON.stringify(ids) : null)
  }

  /**
   * Delete the snapshots Box Yard made and no longer wants (a job's first snapshot, a replaced or cleared one, one a
   * restart left behind). Never one a project still uses, and never more than the ids on the list.
   */
  private async retryPendingSnapshots(force = false) {
    const ids = this.pendingSnapshots()
    if (!ids.length || (!force && Date.now() - this.lastSnapshotRetryAt < 10 * 60_000)) return
    this.lastSnapshotRetryAt = Date.now()
    const inUse = new Set(this.store.listProjects().flatMap((p) => (p.snapshot ? [p.snapshot.id] : [])))
    const running = new Set([...this.snapshotJobs.values()].flatMap((j) => (j.snapshotId ? [j.snapshotId] : [])))
    for (const id of ids) {
      if (inUse.has(id)) {
        this.removePendingSnapshot(id)
        continue
      }
      if (running.has(id) || !this.provider.deleteSnapshot) continue
      try {
        await this.provider.deleteSnapshot(id)
        this.removePendingSnapshot(id)
      } catch (err) {
        console.warn(`[box-yard] couldn't delete snapshot ${id} yet: ${errorMessage(err)}`)
      }
    }
  }

  /**
   * Make a box for a project: from its snapshot when the project has one a box of this size and provider can use,
   * else cold. A restore that fails makes the box cold instead, says so in the box history and warns the project's
   * Captain; a snapshot the provider no longer has is cleared. Throws only when the cold create fails too.
   */
  private async createFor(projectId: string | null | undefined, labels: string[], size: BoxSize): Promise<{ id: string; from: ProjectSnapshot | null; cold: string | null }> {
    const project = projectId ? this.store.getProject(projectId) : null
    const snap = project && project.runner !== "local" ? project.snapshot : null
    if (!project || !snap) return { id: await this.provider.create({ labels, size }), from: null, cold: null }
    const skip = snapshotSkipReason(snap, size, this.provider.name)
    if (skip) return { id: await this.provider.create({ labels, size }), from: null, cold: skip }
    try {
      return { id: await this.provider.create({ labels, size, snapshotId: snap.id }), from: snap, cold: null }
    } catch (err) {
      const code = (err as { statusCode?: unknown } | null)?.statusCode
      const gone = code === 404 || code === 410
      console.warn(`[box-yard] couldn't start a box for ${project.name} from snapshot ${snap.id}: ${errorMessage(err)}`)
      const id = await this.provider.create({ labels, size })
      if (gone && this.store.getProject(project.id)?.snapshot?.id === snap.id) {
        const updated = this.store.setProjectSnapshot(project.id, null)
        if (updated) this.hub.broadcast({ type: "project", project: updated })
      }
      return { id, from: null, cold: `restoring snapshot ${snap.id} failed (${errorMessage(err)})${gone ? "; the provider no longer has it, so it was cleared from the project" : ""}` }
    }
  }

  /**
   * After a box is made for a project: the history and the Captain hear how it started. From the snapshot, its repo
   * mirror is fetched so the first clone there is quick. Cold despite a snapshot: a "Snapshot not used" event, and a
   * warning for the Captain (once per snapshot for one that doesn't fit; every time a restore fails).
   */
  private afterCreateFor(boxId: string, projectId: string | null | undefined, made: { from: ProjectSnapshot | null; cold: string | null }, actor: BoxActor) {
    const project = projectId ? this.store.getProject(projectId) : null
    if (!project) return
    if (made.from && project.repo) {
      const m = this.mirrorSpec(boxId, project)
      void this.provider
        .exec(boxId, `${m.env} && ${withMirrorLock(m.spec.mirror, syncMirrorScript(m.spec))}`)
        .then((res) => res.exitCode === 0 || console.warn(`[box-yard] mirror refresh on ${boxId}: ${(res.stderr || res.stdout).slice(-300)}`))
        .catch((err) => console.warn(`[box-yard] mirror refresh on ${boxId}: ${errorMessage(err)}`))
    }
    if (!made.cold) return
    const failed = made.cold.startsWith("restoring")
    this.recordBoxEvent({ boxId, type: "snapshot_fallback", actor, reason: `New box for ${project.name}, which has a snapshot.`, detail: `Started cold: ${made.cold}.` })
    const key = `${project.id}:${made.cold}`
    if (!failed && this.snapshotNoted.has(key)) return
    this.snapshotNoted.add(key)
    this.notice(`⚠️ **${project.name}** snapshot not used: box ${boxId} started cold because ${made.cold}.`, { boxId, projectIds: [project.id] })
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

  /** Agent slots in use on a box: running turns plus tasks starting there (Store.slotsInUse). */
  private runningOn(boxId: string) {
    return this.store.slotsInUse(boxId)
  }

  private async schedulePass() {
    this.meterBoxes()
    if (this.budgetBlocked()) return
    const waiting = this.store
      .listTaskRows()
      .filter((r) => this.wantsTurn(r))
      .sort((a, b) => a.last_active_at - b.last_active_at)

    this.wantsBox.clear()
    const live = new Set(this.store.listTaskRows().map((r) => r.current_turn_id).filter(Boolean))
    for (const id of this.claimedSlots.keys()) if (!live.has(id)) this.claimedSlots.delete(id)
    for (const listed of waiting) {
      // Over the total agent cap: wait without growing the pool. Running work is never stopped. Tasks that run on
      // this computer (their own runs_on, else their project's) only count against Settings › Local agents (place).
      const cap = this.limits().maxAgents
      const local = this.store.taskRunner(listed) !== "box"
      const boxId = !local && cap > 0 && this.runningTotal() >= cap ? null : await this.place(listed)
      // Placement awaits: the task may have moved on meanwhile (its last queued message cancelled, stopped, started).
      const row = this.store.getTaskRow(listed.id)
      if (!row || !this.wantsTurn(row)) continue
      if (!boxId) {
        if (row.status !== "queued") {
          this.store.updateTask(row.id, { status: "queued" })
          this.emitTask(row.id)
        }
        continue
      }
      const turnId = randomUUID()
      // Check and take the slot in one transaction: placement awaited, and nothing else may have taken the last
      // slot meanwhile (another start, another server on this database). Lost it: wait for the next pass.
      const slots = this.slotsFor(boxId)
      const claimed = this.store.claimTurnSlot(row.id, boxId, slots, {
        status: "starting",
        currentTurnId: turnId,
        error: null,
        waitReason: null,
        waitBoxSize: null,
        ...(row.compact_pending ? { compactPrevStatus: row.status } : {}),
      })
      if (!claimed) {
        if (row.status !== "queued") this.store.updateTask(row.id, { status: "queued" })
        this.setWaitReason(row.id, isLocalRunnerBox(boxId) ? LOCAL_SLOT_WAIT : isGpuBox(boxId) ? GPU_SLOT_WAIT : `Waiting for a free slot on ${boxId}`)
        this.emitTask(row.id)
        continue
      }
      this.claimedSlots.set(turnId, slots)
      // A workspace about to be made here takes disk the next placement mustn't count on.
      if (row.box_id !== boxId) this.reserve(boxId, row.id, this.cloneBytes(row) ?? 0)
      this.store.touchBox(boxId)
      this.emitTask(row.id)
      void this.launch(row.id, boxId, turnId)
    }

    // Grow the pool: one new box per project per `slotsPerBox` tasks waiting for one, less the boxes already on
    // their way, so a batch never gets more boxes than it needs.
    const perProject = new Map<string, number>()
    for (const row of waiting) {
      if (this.wantsBox.has(row.id)) perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1)
    }
    const need = new Map<string, number>()
    for (const [projectId, n] of perProject) {
      const creating = this.creatingFor.get(projectId) ?? 0
      // Never past the project's own Max boxes, counting the boxes it uses and those on their way.
      const cap = this.projectBoxCap(projectId)
      const more = Math.min(Math.ceil(n / this.growthSlots(projectId)), cap ? cap.max - cap.used.size : Infinity) - creating
      if (more > 0) need.set(projectId, more)
    }
    // Several at once, up to Settings › Boxes created at once (each finished create runs another pass). The project
    // with the fewest boxes on their way goes next, so one project's big fan-out doesn't hold up another's single
    // task. createBox counts itself in `creatingFor` before its first await.
    const cap = this.createConcurrency()
    while (need.size && this.canCreateBox(cap)) {
      const [projectId, more] = [...need].reduce((best, next) => ((this.creatingFor.get(next[0]) ?? 0) < (this.creatingFor.get(best[0]) ?? 0) ? next : best))
      void this.createBox(projectId)
      if (more > 1) need.set(projectId, more - 1)
      else need.delete(projectId)
    }
  }

  /** Box creates that may run at once: Settings › Boxes created at once, fewer for a while after a rate limit. */
  private createConcurrency() {
    return Math.max(1, Math.min(this.settings.get().boxCreateConcurrency, this.boxCreate.window))
  }

  /** Another box create may start: the pool has room, no backoff is running and fewer than `cap` are on their way. */
  private canCreateBox(cap: number) {
    return this.poolCreates < cap && Date.now() >= this.boxCreate.retryAt && this.poolHasRoom()
  }

  /** Box creation keeps failing (twice or more in a row, and backing off): placement stops counting on new boxes. */
  private boxCreateFailing() {
    return this.boxCreate.failures >= 2 && Date.now() < this.boxCreate.retryAt
  }

  /**
   * A box create failed: back off before the next one starts and return for how long. Creates already running go
   * on, so one failure costs the queue a couple of seconds, not a minute. The wait doubles with each failure in a
   * row (up to `retryMaxMs`), and a rate limit also halves how many run at once.
   */
  private boxCreateFailed(err: unknown): number {
    const t = this.boxCreateTuning
    const b = this.boxCreate
    const now = Date.now()
    b.failures++
    let delay = Math.min(t.retryMaxMs, t.retryBaseMs * 2 ** (b.failures - 1))
    if (isRateLimited(err)) {
      // Once per backoff: the other creates of the same burst often hit the same limit.
      if (now >= b.retryAt) b.window = Math.max(1, Math.floor(Math.min(b.window, this.poolCreates) / 2))
      delay = Math.max(delay, t.rateLimitMs)
    }
    delay = Math.round(delay * (0.9 + Math.random() * 0.2))
    b.retryAt = Math.max(b.retryAt, now + delay)
    return b.retryAt - now
  }

  /** A box came up: creation works, so the failure count resets and a lowered concurrency grows back by one. */
  private boxCreateWorked() {
    const b = this.boxCreate
    b.failures = 0
    if (Number.isFinite(b.window)) b.window = b.window + 1 >= this.settings.get().boxCreateConcurrency ? Number.POSITIVE_INFINITY : b.window + 1
  }

  /** A task that waits for a turn: queued, or resting with queued messages or a compaction to run. */
  private wantsTurn(r: TaskRow): boolean {
    if (r.current_turn_id || r.status === "starting" || r.status === "working") return false
    return r.status === "queued" || (r.status !== "failed" && (Boolean(r.compact_pending) || this.store.hasInputs(r.id)))
  }

  /** Agents of a project one new box takes: its slots, or fewer when the project sets Agents per box. */
  private growthSlots(projectId: string): number {
    const slots = this.sizeLimits(this.newBoxSize(projectId)).slotsPerBox
    return Math.min(slots, this.store.projectBoxLimits(projectId).agentsPerBox ?? slots)
  }

  /** Pick a box for a task's next turn, or null to wait. */
  private async place(row: TaskRow): Promise<string | null> {
    // A cleanup step is working in its folder right now.
    if (this.janitor.isBusy(row.id)) return null
    const op = row.box_id ? this.boxOps.get(row.box_id) : undefined
    if (op) {
      // Its workspace is being archived off the box; it moves to another box once that's done.
      this.setWaitReason(row.id, `Waiting while box ${row.box_id} is ${op === "clear" ? "cleared" : op === "resize" ? "resized" : op === "snapshot" ? "snapshotted" : "deleted"}`)
      return null
    }
    // The task's runs_on, else its project's "Runs on": it moves to (or off) this computer or its GPU pod when nothing
    // would be lost.
    const runner = this.store.taskRunner(row)
    if (isGpuBox(row.box_id) && !(runner === "gpu" && gpuBoxProject(row.box_id) === row.project_id)) {
      const moved = await this.fromGpu(row, runner)
      return moved === "stay" ? this.gpuSlot(row) : moved
    }
    if (runner === "gpu") {
      const here = await this.toGpu(row)
      if (here !== "stay") return here
    } else if (runner === "local") {
      const here = await this.toLocal(row)
      if (here !== "stay") return here
    } else if (isLocalRunnerBox(row.box_id)) {
      const moved = await this.fromLocal(row)
      return moved === "stay" ? this.localSlot(row) : moved
    }
    if (row.box_id) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "ready") {
        // It ran out of space here; its workspace stays, so it waits for the cleanup on this box.
        if (this.diskHold.get(row.id) === box.id && this.janitor.isRunning(box.id)) {
          this.setWaitReason(row.id, `Waiting for disk cleanup on ${box.id}`)
          return null
        }
        const min = this.minBoxSize(row.project_id)
        if (!sizeFits(box.size, min)) {
          const moved = await this.leaveSmallBox(row, box.id, min!)
          if (moved !== "stay") return moved
        }
        // Busy: no free slot, or a free one that a project's Agents per box or the box's memory rules out.
        const full = this.runningOn(box.id) >= this.slotsFor(box.id)
        const busy = full ? null : (this.limitBlock(row, box.id) ?? (await this.memoryBlock(box.id, row.id)))
        if (!full && !busy) return box.id
        // Its box is busy. Its workspace lives there, so it waits for a slot unless it can move without losing work.
        const noSlot = full ? `Waiting for a free slot on ${box.id}` : null
        if (!this.canMove(row)) {
          this.setWaitReason(row.id, busy ? `Waiting: ${busy}` : noSlot)
          return null
        }
        const other = await this.pickBox(row.id, box.id, busy, noSlot)
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
   * A task whose box is busy may restore on another box (of its project's size, through `pickBox`) only when
   * nothing would be lost and the restore can't fail: it never ran, or `moveBlock` finds nothing in the way.
   * One being archived right now waits for that to finish.
   */
  private canMove(row: TaskRow): boolean {
    if (this.archiving.has(row.id)) return false
    return !row.session_started || this.moveBlock(row) === null
  }

  /**
   * Why a task that ran can't move to another box right now, or null when it can: its turn-end archive must hold
   * the workspace, be small enough to upload in one restore (the provider's file limit, 100 MB on Upstash), and
   * in a repo project its code must be on origin from a turn-end push (git-first: the branch and WIP ref) after
   * its last turn, so the new box checks the branch out rather than unpacking it.
   */
  private moveBlock(row: TaskRow, maxBytes = MOVE_MAX_ARCHIVE_BYTES): string | null {
    if (!this.archiveHoldsWorkspace(row)) return "its workspace has no archive from after its last turn"
    const bytes = fs.statSync(row.archive_path!, { throwIfNoEntry: false })?.size
    if (bytes === undefined) return "its workspace has no archive from after its last turn"
    if (bytes > maxBytes) return `its archive is ${formatBytes(bytes)}, over the ${formatBytes(MOVE_MAX_ARCHIVE_BYTES)} a restore uploads safely`
    if (this.store.getProject(row.project_id)?.repo) {
      const push = this.store.getTask(row.id)?.pushState
      const ended = this.store.lastTurnFinishedAt(row.id) ?? 0
      if (push?.status !== "pushed" || push.at < ended) return "origin doesn't have its branch and uncommitted work from its last turn"
    }
    return null
  }

  /**
   * Its archive has everything its workspace has: written after its last turn ended. Unlike `hasFreshArchive`
   * this ignores `last_active_at`, which a queued message bumps without touching the workspace (so a follow-up
   * would otherwise always pin a resting task to its box).
   */
  private archiveHoldsWorkspace(row: TaskRow): boolean {
    if (this.hasFreshArchive(row)) return true
    if (!row.archive_path || !row.last_archived_at || !fs.existsSync(row.archive_path)) return false
    const ended = this.store.lastTurnFinishedAt(row.id)
    return ended !== null && row.last_archived_at >= ended
  }

  /**
   * A resting task whose folder is on a box smaller than its project's size (placed before the size was set, or
   * by an older Box Yard): it moves to a box of the size through `pickBox`, like a restore, when its archive is
   * fresh, and waits (with the reason) until there is one. Without a fresh archive moving would lose work, so it
   * stays and the task's log says so: "stay" means place it there as usual.
   */
  private async leaveSmallBox(row: TaskRow, boxId: string, min: BoxSize): Promise<string | null | "stay"> {
    // Its turn-end archive is being written right now; it's fresh in a moment.
    if (this.archiving.has(row.id)) return null
    const block = row.session_started ? this.moveBlock(row) : null
    if (block) {
      const note = `Running on ${boxId} (${normalizeBoxSize(this.store.getBox(boxId)?.size)}) though its project needs ${min} boxes: it can't move safely (${block}).`
      if (!this.smallBoxNoted.has(`${row.id}:${boxId}`)) {
        this.smallBoxNoted.add(`${row.id}:${boxId}`)
        this.addEvent(row.id, note)
      }
      return "stay"
    }
    const other = await this.pickBox(row.id, boxId)
    if (!other) return null
    this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(boxId, row.id).catch(() => {})
    this.addEvent(row.id, `Moved from ${boxId} (${normalizeBoxSize(this.store.getBox(boxId)?.size)}) to ${other}: its project needs ${min} boxes.`)
    return this.assign(row.id, other)
  }

  /**
   * A task of a project that runs on this computer (the local runner, shared/runner.ts): its turn takes a Settings ›
   * Local agents slot here, never a box slot. One whose workspace is still on a box (the project ran on boxes when it
   * last worked) moves here when nothing would be lost, like `canMove` but with no upload limit (a restore here is a
   * copy); otherwise it stays on that box ("stay") and its log says why. One whose box is gone restores here.
   */
  private async toLocal(row: TaskRow): Promise<string | null | "stay"> {
    if (row.box_id && !isLocalRunnerBox(row.box_id)) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "creating") return null
      if (box?.status === "ready") {
        // Its turn-end archive is being written right now; it can move in a moment.
        if (this.archiving.has(row.id)) return null
        const block = row.session_started ? this.moveBlock(row, Infinity) : null
        if (block) {
          this.noteOnce(row.id, `${row.id}:${box.id}:local`, `${row.runs_on ? "It was asked to run on this computer" : "Its project runs on this computer now"}, but its workspace stays on box ${box.id}: it can't move safely (${block}).`)
          return "stay"
        }
        if (!this.localRoom(row)) return null
        this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
        void this.removeTaskDir(box.id, row.id).catch(() => {})
        this.addEvent(row.id, `Moved from box ${box.id} to this computer: ${row.runs_on ? "it was asked to run here" : "its project runs its agents here now"}.`)
        return this.assign(row.id, LOCAL_BOX_ID)
      }
      // Box is gone or lost; the workspace comes back from the archive, here.
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    }
    return this.localSlot(row)
  }

  /**
   * A task on this computer whose project runs on boxes again: it moves to a box (through `pickBox`) once its
   * workspace is archived and pushed (`moveBlock`). Local tasks keep no archive, so the first look makes one.
   * One that can't move (the archive failed, is too big to upload, or origin lacks its work) stays here ("stay").
   */
  private async fromLocal(row: TaskRow): Promise<string | null | "stay"> {
    if (this.archiving.has(row.id)) return null
    const block = row.session_started ? this.moveBlock(row) : null
    if (block && this.c.archiveWorkspaces && !this.archiveHoldsWorkspace(row) && !this.archiveErrors.has(row.id)) {
      this.setWaitReason(row.id, "Waiting for its workspace on this computer to be archived, so it can move to a box")
      void this.archive(row.id, { forMove: true }).finally(() => this.schedule())
      return null
    }
    if (block) {
      this.noteOnce(row.id, `${row.id}:${LOCAL_BOX_ID}:box`, `${row.runs_on ? "It was asked to run on an Upstash box" : "Its project runs on Upstash boxes now"}, but its workspace stays on this computer: it can't move safely (${block}).`)
      return "stay"
    }
    const other = await this.pickBox(row.id)
    if (!other) return null
    this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(LOCAL_BOX_ID, row.id).catch(() => {})
    this.addEvent(row.id, `Moved from this computer to box ${other}: ${row.runs_on ? "it was asked to run on an Upstash box" : "its project runs on Upstash boxes again"}.`)
    return this.assign(row.id, other)
  }

  /** This computer for a local task's next turn, or null (with the reason) while its Local agents slots are taken. */
  private localSlot(row: TaskRow): string | null {
    if (!this.localRoom(row)) return null
    return isLocalRunnerBox(row.box_id) ? LOCAL_BOX_ID : this.assign(row.id, LOCAL_BOX_ID)
  }

  /** A free Local agents slot that the projects' Agents per box let this task take; else false, with the reason. */
  private localRoom(row: TaskRow): boolean {
    if (this.runningOn(LOCAL_BOX_ID) >= this.slotsFor(LOCAL_BOX_ID)) {
      this.setWaitReason(row.id, LOCAL_SLOT_WAIT)
      return false
    }
    const limit = this.limitBlock(row, LOCAL_BOX_ID)
    if (limit) this.setWaitReason(row.id, `Waiting: ${limit}`)
    return !limit
  }

  /**
   * A task of a project that runs on RunPod GPU (shared/runpod.ts): its turns run on one of the project's pods,
   * `runpod-<projectId>[-<n>]`, which `gpuTarget` picks and launch starts when it isn't up. A workspace still on a
   * box or on this computer moves to a pod when nothing would be lost (`moveBlock`, no upload limit: a restore over
   * SSH has none); otherwise it stays where it is ("stay" for a box; on this computer it keeps running there) and
   * its log says why.
   */
  private async toGpu(row: TaskRow): Promise<string | null | "stay"> {
    if (isGpuBox(row.box_id)) return this.gpuSlot(row)
    const why = row.runs_on ? "it was asked to run on a RunPod GPU pod" : "its project runs on a RunPod GPU pod now"
    if (isLocalRunnerBox(row.box_id)) {
      if (this.archiving.has(row.id)) return null
      const block = row.session_started ? this.moveBlock(row, Infinity) : null
      if (block && this.c.archiveWorkspaces && !this.archiveHoldsWorkspace(row) && !this.archiveErrors.has(row.id)) {
        this.setWaitReason(row.id, "Waiting for its workspace on this computer to be archived, so it can move to the GPU pod")
        void this.archive(row.id, { forMove: true }).finally(() => this.schedule())
        return null
      }
      if (block) {
        this.noteOnce(row.id, `${row.id}:${LOCAL_BOX_ID}:gpu`, `${row.runs_on ? "It was asked to run on a RunPod GPU pod" : "Its project runs on a RunPod GPU pod now"}, but its workspace stays on this computer: it can't move safely (${block}).`)
        return this.localSlot(row)
      }
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
      void this.removeTaskDir(LOCAL_BOX_ID, row.id).catch(() => {})
      this.addEvent(row.id, `Moved from this computer to its project's GPU pod: ${why}.`)
      return this.gpuSlot(row)
    }
    if (row.box_id) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "creating") return null
      if (box?.status === "ready") {
        if (this.archiving.has(row.id)) return null
        const block = row.session_started ? this.moveBlock(row, Infinity) : null
        if (block) {
          this.noteOnce(row.id, `${row.id}:${box.id}:gpu`, `${row.runs_on ? "It was asked to run on a RunPod GPU pod" : "Its project runs on a RunPod GPU pod now"}, but its workspace stays on box ${box.id}: it can't move safely (${block}).`)
          return "stay"
        }
        const target = await this.gpuTarget(row)
        if (!target) return null
        this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
        void this.removeTaskDir(box.id, row.id).catch(() => {})
        this.addEvent(row.id, `Moved from box ${box.id} to its project's GPU pod #${gpuBoxIndex(target)}: ${why}.`)
        return this.gpuAssign(row, target)
      }
      // Box is gone or lost; the workspace comes back from the archive, on the pod.
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    }
    return this.gpuSlot(row)
  }

  /**
   * A task on a GPU pod whose project (or its own runs_on) moved to boxes or this computer: it moves once its
   * workspace is archived (the turn-end archive usually is) and, for a box, pushed and small enough to upload.
   * One that can't move stays on the pod ("stay").
   */
  private async fromGpu(row: TaskRow, runner: Runner): Promise<string | null | "stay"> {
    const from = row.box_id!
    if (this.archiving.has(row.id)) return null
    const block = row.session_started ? this.moveBlock(row, runner === "box" ? MOVE_MAX_ARCHIVE_BYTES : Infinity) : null
    if (block && this.c.archiveWorkspaces && !this.archiveHoldsWorkspace(row) && !this.archiveErrors.has(row.id)) {
      this.setWaitReason(row.id, "Waiting for its workspace on the GPU pod to be archived, so it can move")
      void this.archive(row.id, { forMove: true }).finally(() => this.schedule())
      return null
    }
    if (block) {
      this.noteOnce(row.id, `${row.id}:${from}:${runner}`, `It should run on ${RUNNER_PHRASE[runner]} now, but its workspace stays on its project's GPU pod: it can't move safely (${block}).`)
      return "stay"
    }
    let to: string | null
    if (runner === "local") {
      if (!this.localRoom(row)) return null
      to = LOCAL_BOX_ID
    } else if (runner === "gpu") {
      to = await this.gpuTarget(row)
      if (!to) return null
    } else {
      to = await this.pickBox(row.id)
      if (!to) return null
    }
    this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(from, row.id).catch(() => {})
    this.addEvent(row.id, `Moved from its project's GPU pod to ${runner === "box" ? `box ${to}` : RUNNER_PHRASE[runner]}.`)
    return runner === "gpu" ? this.gpuAssign(row, to) : this.assign(row.id, to)
  }

  /** One of the project's GPU pods for a task's next turn, or null (with the reason) while it must wait. */
  private async gpuSlot(row: TaskRow): Promise<string | null> {
    const target = await this.gpuTarget(row)
    return target ? this.gpuAssign(row, target) : null
  }

  /**
   * Which of its project's pods a GPU task's next turn takes, or null with the reason:
   * 1. its own pod while that's up: its workspace is there (it moves only when nothing would be lost, `canMove`),
   * 2. another of the project's pods that is up (or starting) and has a free slot,
   * 3. a new pod, while the project has fewer than its Max boxes (MAX_GPU_PODS when unset) and one more fits under
   *    the per-project and total $/hr caps (`gpuCapBlock`). Pods are `runpod-<projectId>` (#1), then `-2`, `-3`, …
   * Slots per pod are its project's Agents per box, else Settings › RunPod GPU › Agents per pod (`slotsFor`).
   */
  private async gpuTarget(row: TaskRow): Promise<string | null> {
    if (!this.gpu) {
      this.setWaitReason(row.id, "Waiting: RunPod GPU isn't available on this Box Yard")
      return null
    }
    if (!this.gpu.enabled()) {
      this.setWaitReason(row.id, "Waiting: RunPod GPU isn't set up (add a RunPod API key in Settings › RunPod GPU)")
      return null
    }
    const pods = await this.gpuPods(row.id)
    if (!pods) return null
    const projectId = row.project_id
    const live = new Set(pods.map((p) => p.boxId))
    const own = isGpuBox(row.box_id) && gpuBoxProject(row.box_id) === projectId ? row.box_id : null
    const onPod = own && live.has(own) ? own : null
    if (onPod) {
      if (this.gpuRoom(row, onPod)) return onPod
      if (!this.canMove(row)) return null
    }
    const up = this.gpuBoxesUp(projectId, live)
    const free = up.find((id) => id !== onPod && this.runningOn(id) < this.slotsFor(id) && !this.limitBlock(row, id))
    if (free) return free
    const max = this.gpuMaxPods(projectId)
    if (up.length >= max) {
      const set = this.store.projectBoxLimits(projectId).maxBoxes !== null
      this.setWaitReason(
        row.id,
        `Waiting for a free agent slot on its project's ${up.length === 1 ? "GPU pod" : `${up.length} GPU pods`} (${set ? `its Max boxes is ${max}` : `at most ${max} pods`}; Agents per box, or Settings › RunPod GPU › Agents per pod)`,
      )
      return null
    }
    const block = await this.gpuCapBlock(projectId, pods, up)
    if (block) {
      this.gpuWait(row, block.kind, block.reason)
      return null
    }
    // A new pod: the task's old one when it's in range (its number stays), else the first unused number.
    if (own && !up.includes(own) && gpuBoxIndex(own) <= max) return own
    for (let n = 1; n <= max; n++) if (!up.includes(gpuBoxId(projectId, n))) return gpuBoxId(projectId, n)
    return null
  }

  /** Put a task on the GPU pod `gpuTarget` picked. One moving between its project's pods restores there from its archive. */
  private gpuAssign(row: TaskRow, target: string): string {
    this.gpuWaitNoticed.delete(row.id)
    const from = this.store.getTaskRow(row.id)?.box_id ?? null
    if (from === target) return target
    if (isGpuBox(from)) {
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
      if (this.gpuSeen.some((p) => p.boxId === from)) void this.removeTaskDir(from, row.id).catch(() => {})
      if (row.session_started) this.addEvent(row.id, `Moved from GPU pod #${gpuBoxIndex(from)} to #${gpuBoxIndex(target)} of its project.`)
    }
    // The pod exposes one preview port per task folder (POD_HTTP_PORTS): park an archived, resting one for room.
    if (this.store.listTaskRows({ boxId: target }).length >= POD_HTTP_PORTS.length) this.evictOne(target, row.id)
    return this.assign(row.id, target)
  }

  private gpuRoom(row: TaskRow, boxId: string): boolean {
    if (this.runningOn(boxId) >= this.slotsFor(boxId)) {
      this.setWaitReason(row.id, GPU_SLOT_WAIT)
      return false
    }
    const limit = this.limitBlock(row, boxId)
    if (limit) this.setWaitReason(row.id, `Waiting: ${limit}`)
    return !limit
  }

  /** This install's GPU pods (cached for a few seconds by the provider), or null with the reason when RunPod can't say. */
  private async gpuPods(taskId?: string): Promise<GpuPods | null> {
    try {
      this.gpuSeen = await this.gpu!.provider.listPods()
      return this.gpuSeen
    } catch (err) {
      if (taskId) this.setWaitReason(taskId, `Waiting: couldn't list the RunPod pods (${errorMessage(err)})`)
      return null
    }
  }

  /** The project's pods that are up or on their way (a turn holds a slot on it), by number. */
  private gpuBoxesUp(projectId: string, live: Set<string>): string[] {
    const ids = new Set([...live].filter((id) => gpuBoxProject(id) === projectId))
    for (const id of this.store.gpuBoxesInUse()) if (gpuBoxProject(id) === projectId) ids.add(id)
    return [...ids].sort((a, b) => gpuBoxIndex(a) - gpuBoxIndex(b))
  }

  /** The most pods a GPU project may have up at once: its Max boxes, else MAX_GPU_PODS (the $/hr caps bound it too). */
  private gpuMaxPods(projectId: string): number {
    return Math.min(MAX_GPU_PODS, this.store.projectBoxLimits(projectId).maxBoxes ?? MAX_GPU_PODS)
  }

  /**
   * Why the project can't have another pod now: it would take its pods over their $/hr cap (its own, else Settings ›
   * RunPod GPU › Max per project), or every pod of this install over the total cap. A pod counts at its RunPod price,
   * one still starting at the next pod's list price. Null when it fits, or when RunPod's prices can't be read (the
   * pod start checks the caps again).
   */
  private async gpuCapBlock(projectId: string, pods: GpuPods, up: string[]): Promise<{ kind: string; reason: string } | null> {
    const gpu = this.gpu!
    let next: Awaited<ReturnType<GpuPodProvider["nextPodPrice"]>>
    try {
      next = await gpu.provider.nextPodPrice(projectId)
    } catch {
      return null
    }
    const cap = gpu.provider.capOf(projectId)
    const name = this.store.getProjectName(projectId) ?? projectId
    if (!next) {
      return { kind: "cap", reason: `RunPod cap $${cap}/hr is below the price of every GPU type in Settings › RunPod GPU (${GPU_CAP_HOW})` }
    }
    const cost = (id: string) => pods.find((p) => p.boxId === id)?.pod.cost ?? next.usd
    const usd = (n: number) => `$${Math.round(n * 100) / 100}/hr`
    const mine = up.reduce((sum, id) => sum + cost(id), 0)
    const pods_ = (n: number) => (n === 1 ? "pod costs" : `${n} pods cost`)
    if (cap && mine + next.usd > cap + 1e-9) {
      return { kind: "cap", reason: `RunPod cap $${cap}/hr reached: ${name}'s ${pods_(up.length)} ${usd(mine)} and another ${next.gpu} is ${usd(next.usd)} (${GPU_CAP_HOW})` }
    }
    const total = gpu.settings().totalMaxHourlyUsd
    const all = new Set([...pods.map((p) => p.boxId), ...this.store.gpuBoxesInUse()])
    const spend = [...all].reduce((sum, id) => sum + cost(id), 0)
    if (total && spend + next.usd > total + 1e-9) {
      return { kind: "total", reason: `RunPod total cap $${total}/hr reached: this Box Yard's ${pods_(all.size)} ${usd(spend)} and another ${next.gpu} is ${usd(next.usd)} (Settings › RunPod GPU › Max for all pods)` }
    }
    return null
  }

  /** A GPU task waits for a pod a cap rules out: the reason on the task, and its Captain hears it once. */
  private gpuWait(row: TaskRow, kind: string, reason: string) {
    this.setWaitReason(row.id, `Waiting: ${reason}`)
    if (this.gpuWaitNoticed.get(row.id) === kind) return
    this.gpuWaitNoticed.set(row.id, kind)
    this.notice(`⚠️ **${row.title}** waits: ${reason}.`, { taskId: row.id, projectIds: [row.project_id] })
  }

  /** Progress while a GPU pod starts: one line in the log of each task starting on it. */
  gpuProgress(boxId: string, message: string) {
    for (const row of this.store.listTaskRows({ boxId })) {
      if (row.status === "starting") this.addEvent(row.id, `${message}…`)
    }
  }

  /** A GPU pod started or was terminated (by RunPodProvider), for the box history. */
  gpuPodEvent(e: { boxId: string; kind: "started" | "terminated"; detail: string; actor?: BoxActor; reason?: string }) {
    this.recordBoxEvent({
      boxId: e.boxId,
      boxName: gpuPodLabel(e.boxId, this.store.getProjectName(gpuBoxProject(e.boxId))),
      type: e.kind === "started" ? "created" : "deleted",
      actor: e.actor ?? { kind: e.kind === "started" ? "scheduler" : "provider" },
      reason: e.reason ?? (e.kind === "started" ? "A task of a RunPod GPU project needed its pod." : "The pod was terminated."),
      detail: e.detail,
      size: null,
    })
  }

  /**
   * Stop the project's GPU pod now (Settings › RunPod GPU › Stop, or the idle sweep). Its workspaces must be in
   * their archives: running turns are never stopped, and a task without a fresh archive is archived first.
   */
  async stopGpuPod(boxId: string, opts: { actor: BoxActor; reason: string; force?: boolean }): Promise<void> {
    if (!this.gpu) throw new BadRequestError("RunPod GPU isn't available on this Box Yard")
    const residents = this.store.listTaskRows({ boxId })
    if (!opts.force && residents.some((r) => r.current_turn_id || r.status === "starting")) throw new ConflictError("An agent is running on that pod; stop it first")
    for (const r of residents) if (r.session_started && !this.archiveHoldsWorkspace(r)) await this.archiveFresh(r.id).catch(() => {})
    const unsaved = this.store.listTaskRows({ boxId }).filter((r) => r.session_started && !this.archiveHoldsWorkspace(r))
    if (unsaved.length && !opts.force) throw new ConflictError(`Couldn't archive ${unsaved.map((r) => r.id).join(", ")}; the pod stays up so nothing is lost`)
    await this.gpu.provider.destroy(boxId)
    this.gpuTouchedAt.delete(boxId)
    this.gpuPodEvent({ boxId, kind: "terminated", detail: "Its network volume stays.", actor: opts.actor, reason: opts.reason })
  }

  /**
   * Once a minute: stop GPU pods idle for Settings › RunPod GPU › Stop when idle (no turn running or waiting, every
   * workspace archived, past any keep-warm), and touch the heartbeat of the others, so a pod's own watchdog
   * (runpod/watchdog.sh) only fires when this Box Yard has gone quiet (the computer slept).
   */
  private async sweepGpuPods(now: number) {
    if (!this.gpu?.enabled() || now - this.lastGpuSweepAt < 60_000) return
    this.lastGpuSweepAt = now
    const s = this.gpu.settings()
    let pods: Awaited<ReturnType<RunPodProvider["listPods"]>>
    try {
      pods = await this.gpu.provider.listPods(true)
    } catch (err) {
      console.warn(`[box-yard] RunPod pods: ${errorMessage(err)}`)
      return
    }
    this.gpuSeen = pods
    const live = new Set(pods.map((p) => p.boxId))
    for (const { boxId, pod } of pods) {
      if (pod.status !== "RUNNING") continue
      const residents = this.store.listTaskRows({ boxId })
      const busy = residents.some((r) => r.current_turn_id || r.status === "starting")
      // Each pod stops on its own: it stays for a task of its own that waits, or for one of its project's that waits
      // for any pod (not one whose workspace is on another pod) while it has a free slot.
      const room = this.runningOn(boxId) < this.slotsFor(boxId)
      const waiting =
        residents.some((r) => this.wantsTurn(r)) ||
        (room &&
          this.store
            .listTaskRows({ projectId: gpuBoxProject(boxId) })
            .some((r) => this.wantsTurn(r) && this.store.taskRunner(r) === "gpu" && !(isGpuBox(r.box_id) && r.box_id !== boxId && live.has(r.box_id))))
      const started = pod.startedAt ? Date.parse(pod.startedAt) : now
      const lastUse = Math.max(started || 0, ...residents.map((r) => r.last_active_at))
      const warm = this.gpu.keepWarmUntil(boxId) ?? 0
      const idleMs = now - lastUse
      if (!busy && !waiting && warm < now && idleMs >= s.idleMinutes * 60_000) {
        const unsaved = residents.filter((r) => r.session_started && !this.archiveHoldsWorkspace(r))
        if (unsaved.length) {
          for (const r of unsaved) if (!this.archiving.has(r.id) && !this.archiveErrors.has(r.id)) void this.archive(r.id)
        } else {
          console.log(`[box-yard] stopping idle GPU pod ${pod.id} (${boxId})`)
          await this.stopGpuPod(boxId, {
            actor: { kind: "janitor" },
            reason: `Idle for ${Math.round(idleMs / 60_000)} min (Settings › RunPod GPU stops pods after ${s.idleMinutes} min); every workspace was archived.`,
          }).catch((err) => console.warn(`[box-yard] stop GPU pod ${boxId}: ${errorMessage(err)}`))
          continue
        }
      }
      if (now - (this.gpuTouchedAt.get(boxId) ?? 0) >= GPU_HEARTBEAT_MS) {
        this.gpuTouchedAt.set(boxId, now)
        await this.provider.exec(boxId, "true").catch(() => {})
      }
    }
  }

  /** Add a line to a task's log the first time `key` comes up (a placement decision every pass would repeat). */
  private noteOnce(taskId: string, key: string, line: string) {
    if (this.smallBoxNoted.has(key)) return
    this.smallBoxNoted.add(key)
    this.addEvent(taskId, line)
  }

  /**
   * Pick a box for a task. A project keeps its work together, so the order is:
   * 1. a box that already hosts this project (warm repo mirror, shared files),
   * 2. an empty box,
   * 3. nothing yet, when the pool has room: a new box is made for the project,
   * 4. a free slot on a box another project uses (the pool is full).
   * Only boxes of at least the project's box size count (`minBoxSize`); when none has a free slot and the pool
   * is full, `ensureSizedBox` grows an idle box or the task waits with the reason. A project at its own Max boxes
   * only uses the boxes it already has, and a box's agents and task folders are capped by the strictest of its own
   * limit, the task's project's and those of the projects already there (`limitBlock`, `residentCap`).
   * A box without enough free disk for a new workspace is skipped and cleaned up
   * in the background; the task waits for that cleanup only when no other box
   * (or new one) can take it.
   * Returns null to wait; `wantsBox` tells the scheduler to grow the pool.
   */
  private async pickBox(taskId: string, exclude?: string, busyHere: string | null = null, waitHere: string | null = null): Promise<string | null> {
    const row = this.store.getTaskRow(taskId)
    const projectId = row?.project_id
    const preferred = projectId ? this.store.getKv(projectBoxKey(projectId)) : null
    const min = this.minBoxSize(projectId)
    const cap = projectId ? this.projectBoxCap(projectId, taskId) : null
    const candidates = this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && b.id !== exclude && !this.boxOps.has(b.id) && sizeFits(b.size, min) && (!cap?.full || cap.used.has(b.id)))
      .map((b) => {
        const residents = this.store.listTaskRows({ boxId: b.id }).filter((r) => r.id !== taskId)
        // A box made for a project belongs to it, even before its first task lands.
        const owner = this.store.getKv(boxOwnerKey(b.id))
        const mine = residents.some((r) => r.project_id === projectId) || b.id === preferred || owner === projectId
        const others = residents.some((r) => r.project_id !== projectId) || Boolean(owner && owner !== projectId)
        // 0 = this project's box, 1 = empty unowned box, 2 = another project's box
        const rank = mine ? 0 : others ? 2 : 1
        const limits = this.sizeLimits(normalizeBoxSize(b.size))
        const maxResidentPerBox = this.residentCap(limits.maxResidentPerBox, projectId, residents)
        return { id: b.id, rank, running: residents.filter(holdsSlot).length, residents: residents.length, slotsPerBox: limits.slotsPerBox, maxResidentPerBox }
      })
      .filter((b) => b.running < b.slotsPerBox)
      .sort((a, b) => a.rank - b.rank || a.running - b.running || a.residents - b.residents)
    const low: { boxId: string; state: "running" | "exhausted" }[] = []
    // Boxes with a free slot that a project's Agents per box or memory rule out, why (the first one is the wait reason).
    const busy: string[] = busyHere ? [busyHere] : []
    // A new box may be made for it: the pool has room, and so does its project (its own Max boxes).
    const canGrow = this.poolHasRoom() && !cap?.full
    for (const b of candidates) {
      if (b.rank === 2 && canGrow) {
        // Rather than crowd another project's box, make one for this project.
        this.wantsBox.add(taskId)
        this.holdForDisk(taskId, low, busy[0], waitHere)
        return null
      }
      if (b.residents >= b.maxResidentPerBox && !this.canEvict(b.id, taskId)) continue
      const why = row ? (this.limitBlock(row, b.id) ?? (await this.memoryBlock(b.id, taskId))) : null
      if (why) {
        busy.push(why)
        continue
      }
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
    if (canGrow) this.wantsBox.add(taskId)
    else {
      // Its setup already ran out of space once and no box has room even after cleanup:
      // the threshold is cautious, so make the one retry on the cleaned box instead of waiting forever.
      const cleaned = this.diskRetried.has(taskId) ? candidates.find((c) => c.id === low.find((l) => l.state === "exhausted")?.boxId) : undefined
      if (cleaned && (cleaned.residents < cleaned.maxResidentPerBox || this.evictOne(cleaned.id, taskId))) {
        this.holdForDisk(taskId, [])
        return cleaned.id
      }
      // No box of the project's size has a free slot and the pool (or the project) can't grow.
      if (min && !candidates.length && row) {
        await this.ensureSizedBox(row, min, cap?.full ? cap : null)
        return null
      }
    }
    // Every box of its size is full and none can be added: say so rather than wait without a reason.
    const poolFull = !this.wantsBox.has(taskId) && !canGrow ? (cap?.full ? this.projectFullReason(projectId!, cap.max) : this.noNewBoxReason()) : null
    this.holdForDisk(taskId, low, busy[0], waitHere ?? poolFull)
    return null
  }

  /**
   * The smallest box a project's tasks may run on: the project's own box size (projects.box_size, set on the
   * project's settings), or null when it has none and any box will do. Boxes go small < medium < large.
   */
  private minBoxSize(projectId?: string | null): BoxSize | null {
    return (projectId ? this.store.getProject(projectId)?.boxSize : null) ?? null
  }

  /**
   * A task of a project with a box size, the pool full and no box of at least that size with a free slot.
   * The rule, when Settings › Resize an idle box… (placementResizeEnabled, off by default) is on: when an idle box exists (ready, no agent running or starting on it, no other operation or cleanup
   * on it), it's resized up to the size through the usual resize (in place, or by migration: archive every
   * workspace, move them to a new box, delete the old one), and the task waits for it. The box with the least on
   * its disk goes first, since that's the least to archive; agents are never stopped. With no idle box the task
   * waits, and with the setting off it always waits. Either way the reason is on the task, and it never falls back to
   * a smaller box.
   */
  private async ensureSizedBox(row: TaskRow, min: BoxSize, own: { max: number; used: Set<string> } | null = null) {
    const waitFor = `Waiting for a ${min} box`
    // A project at its own Max boxes waits for (or grows) one of its own boxes; a box on its way for another doesn't help.
    const full = own ? `${this.store.getProjectName(row.project_id) ?? row.project_id} is at its limit of ${boxCount(own.max)}` : "the pool is full"
    const pending = this.sizedBoxComing(min, own?.used)
    if (pending) return this.setWaitReason(row.id, `${waitFor}: ${pending}`, min)
    // Settings › Resize an idle box when no big-enough box is free (off by default): off, the task just waits.
    if (!this.settings.get().placementResizeEnabled) return this.setWaitReason(row.id, `${waitFor}: ${full} and none has room`, min)
    const idle = this.idleBoxesBelow(min).filter((b) => !own || own.used.has(b.id))
    for (const box of idle) {
      const project = this.store.getProject(row.project_id)
      try {
        await this.resizeBox(box.id, min, {
          by: { kind: "scheduler", projectId: row.project_id, taskId: row.id },
          reason: `${project?.name ?? row.project_id} needs ${min} boxes, the pool is at its limit and ${box.id} was idle`,
        })
      } catch (err) {
        console.warn(`[box-yard] couldn't resize idle box ${box.id} to ${min} for ${row.id}: ${errorMessage(err)}`)
        continue
      }
      return this.setWaitReason(row.id, `${waitFor}: ${this.sizedBoxComing(min) ?? `resizing box ${box.id}`}`, min)
    }
    this.setWaitReason(row.id, `${waitFor}: ${full} and no box is idle to resize`, min)
  }

  /**
   * A box of at least `size` on its way: being created, or a resize up to it running. Says which, or null. With
   * `only` (a project at its Max boxes), just a resize of one of those boxes counts.
   */
  private sizedBoxComing(size: BoxSize, only?: Set<string>): string | null {
    // A migration's old box leaves the list before its resize is over, so the resizes are read on their own.
    for (const r of this.resizes.values()) if (r.status === "running" && sizeFits(r.to, size) && (!only || only.has(r.boxId))) return `resizing box ${r.boxId} (${r.from} → ${r.to})`
    if (only) return null
    return this.store.listBoxes().some((b) => b.status === "creating" && sizeFits(b.size, size)) ? "a new one is being created" : null
  }

  /**
   * Boxes smaller than `size` that can be resized without stopping anything: ready, no turn running or starting,
   * no clear/delete/resize or cleanup on them, and no resize by placement that failed in the last 15 minutes
   * (it'd only fail again). Least disk in use first (the least to archive), then fewest task folders.
   */
  private idleBoxesBelow(size: BoxSize) {
    const now = Date.now()
    return this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && !sizeFits(b.size, size) && !this.boxOps.has(b.id) && !this.janitor.isRunning(b.id))
      .filter((b) => {
        const last = this.resizeReport(b.id)
        return !(last?.status === "failed" && last.by.kind === "scheduler" && now - (last.finishedAt ?? 0) < AUTO_RESIZE_RETRY_MS)
      })
      .map((b) => ({ box: b, rows: this.store.listTaskRows({ boxId: b.id }) }))
      .filter(({ rows }) => rows.every((r) => !r.current_turn_id && r.status !== "starting" && r.status !== "working"))
      .map(({ box, rows }) => ({
        box,
        rows: rows.length,
        used: box.disk_free_bytes != null && box.disk_total_bytes != null ? box.disk_total_bytes - box.disk_free_bytes : Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.used - b.used || a.rows - b.rows)
      .map(({ box }) => box)
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

  /**
   * Say on a queued task why it's waiting when that's about disk space (or else `busy`: Agents per box, memory; or
   * else `waitHere`: no free slot on the box its workspace is on), or clear it.
   */
  private holdForDisk(taskId: string, low: { boxId: string; state: "running" | "exhausted" }[], busy?: string | null, waitHere?: string | null) {
    const first = low[0]
    let reason: string | null = null
    if (!first && busy) reason = this.wantsBox.has(taskId) ? `Waiting for a new box: ${busy}` : `Waiting: ${busy}`
    else if (!first && waitHere) reason = this.wantsBox.has(taskId) ? `${waitHere} or a new box` : waitHere
    if (first) {
      if (this.wantsBox.has(taskId)) reason = `Waiting for a new box: ${first.boxId} is low on disk`
      else if (first.state === "running" || low.some((l) => this.janitor.isRunning(l.boxId))) {
        reason = `Waiting for disk cleanup on ${low.find((l) => this.janitor.isRunning(l.boxId))?.boxId ?? first.boxId}`
      } else reason = `Waiting for disk space on ${first.boxId}: cleanup couldn't free enough room`
    }
    this.setWaitReason(taskId, reason)
  }

  private setWaitReason(taskId: string, reason: string | null, size: BoxSize | null = null) {
    const row = this.store.getTaskRow(taskId)
    if (!row || ((row.wait_reason ?? null) === reason && (row.wait_box_size ?? null) === (reason ? size : null))) return
    this.store.updateTask(taskId, { waitReason: reason, waitBoxSize: reason ? size : null }, { touch: false })
    if (reason) this.addEvent(taskId, `${reason}.`)
    this.emitTask(taskId)
  }

  /**
   * The box facts a worker's system prompt states (stable from turn to turn, so the prompt cache holds): agents
   * that may share it are the box's slots, or fewer under its project's Agents per box.
   */
  private boxPromptInfo(boxId: string, project: Project): BoxPromptInfo {
    const box = this.slotsFor(boxId)
    const slots = Math.min(box, project.agentsPerBox ?? box)
    const alone = project.agentsPerBox === 1
    if (isLocalRunnerBox(boxId)) return { memoryBytes: os.totalmem(), slots, alone, local: true }
    if (isGpuBox(boxId)) {
      const pod = this.gpu?.provider.cached(boxId)
      return { memoryBytes: null, slots, alone, gpu: { name: pod?.gpu?.id ? shortGpu(pod.gpu.id) : "GPU" } }
    }
    return { memoryBytes: this.store.getBox(boxId)?.mem_total_bytes ?? null, slots, alone }
  }

  /** Settings → Boxes & limits → Memory and load: when placement skips a box. */
  private memoryPolicy(): MemoryPolicy {
    const s = this.settings.get()
    return { maxUsedPercent: s.memoryMaxUsedPercent, minFreeMb: s.memoryMinFreeMb, maxLoadPerCpu: s.loadMaxPerCpu }
  }

  /**
   * Why a box is too loaded for another agent right now ("box … is busy: 3.4 GB of 4 GB memory in use (85%), over
   * 80%"), or null. It reads the df probe's memory and load, so it costs nothing extra. It only counts while other
   * agents run there: memory that no turn holds won't free up by waiting, and an idle box should still take work.
   */
  private async memoryBlock(boxId: string, taskId: string): Promise<string | null> {
    const policy = this.memoryPolicy()
    if (!policy.maxUsedPercent && !policy.minFreeMb && !policy.maxLoadPerCpu) return null
    if (!this.store.listTaskRows({ boxId }).some((r) => r.current_turn_id && r.id !== taskId)) return null
    const space = await this.probeDisk(boxId, DISK_CACHE_MS)
    const why = memoryPressure(space?.memory, policy)
    return why ? `box ${boxId} is busy: ${why}` : null
  }

  /**
   * Why the projects' Agents per box keep this task off a box right now, or null. A box runs at most the strictest
   * of the task's project's limit and those of the projects with an agent running there (1: alone), every project's
   * agents counted; the box's own limit is checked apart. Store.claimTurnSlot holds the same rule when the turn
   * claims its slot.
   */
  private limitBlock(row: TaskRow, boxId: string): string | null {
    const running = this.store.listTaskRows({ boxId }).filter((r) => holdsSlot(r) && r.id !== row.id)
    if (!running.length) return null
    const name = (projectId: string) => this.store.getProjectName(projectId) ?? projectId
    const where = isLocalRunnerBox(boxId) ? "this computer" : isGpuBox(boxId) ? `GPU pod #${gpuBoxIndex(boxId)}` : `box ${boxId}`
    const mine = this.store.projectBoxLimits(row.project_id).agentsPerBox
    if (mine !== null && running.length >= mine) {
      const rule = mine === 1 ? "runs each of its agents alone on a box" : `runs at most ${mine} agents on a box`
      return `${name(row.project_id)} ${rule}, and ${where} has ${running.length === 1 ? "an agent" : `${running.length} agents`} running`
    }
    for (const projectId of new Set(running.map((r) => r.project_id))) {
      const cap = this.store.projectBoxLimits(projectId).agentsPerBox
      if (cap === null || running.length < cap) continue
      return `${where} is running an agent of ${name(projectId)}, which ${cap === 1 ? "runs its agents alone on a box" : `allows at most ${cap} agents on a box`}`
    }
    return null
  }

  /** The strictest Agents per box among the projects running agents on a box, when it's below the box's slots (BoxInfo). */
  private projectLimitOn(boxId: string, residents: TaskRow[]): BoxInfo["projectLimit"] {
    const slots = this.slotsFor(boxId)
    let out: BoxInfo["projectLimit"] = null
    for (const projectId of new Set(residents.filter(holdsSlot).map((r) => r.project_id))) {
      const cap = this.store.projectBoxLimits(projectId).agentsPerBox
      if (cap !== null && cap < (out?.slots ?? slots)) out = { slots: cap, project: this.store.getProjectName(projectId) ?? projectId }
    }
    return out
  }

  /**
   * Task folders a box may hold with this project's: the box's own limit, or less when the project or one with a
   * folder there (`residents`) sets Tasks per box. The stricter wins, like Agents per box.
   */
  private residentCap(boxLimit: number, projectId: string | undefined, residents: TaskRow[]): number {
    let cap = boxLimit
    for (const p of new Set([...(projectId ? [projectId] : []), ...residents.map((r) => r.project_id)])) {
      const n = this.store.projectBoxLimits(p).tasksPerBox
      if (n !== null && n < cap) cap = n
    }
    return cap
  }

  /**
   * A project's own Max boxes and the ready boxes its tasks use now: made for it, or holding one of its task folders
   * (`except` left out, so a task that moves doesn't count the box it leaves). `full` also counts the boxes being
   * created for it. null when it sets none: only Settings › Max boxes applies.
   */
  private projectBoxCap(projectId: string, except?: string): { max: number; used: Set<string>; full: boolean } | null {
    const max = this.store.projectBoxLimits(projectId).maxBoxes
    if (max === null) return null
    const ready = new Set(this.store.listBoxes().filter((b) => b.status === "ready").map((b) => b.id))
    const used = new Set<string>()
    for (const r of this.store.listTaskRows({ projectId })) if (r.id !== except && r.box_id && ready.has(r.box_id)) used.add(r.box_id)
    for (const id of ready) if (this.store.getKv(boxOwnerKey(id)) === projectId) used.add(id)
    return { max, used, full: used.size + (this.creatingFor.get(projectId) ?? 0) >= max }
  }

  /** Why a task waits when its project's own boxes are full and it's at its Max boxes. */
  private projectFullReason(projectId: string, max: number) {
    return `Waiting for a free slot: ${this.store.getProjectName(projectId) ?? projectId} is at its limit of ${boxCount(max)}`
  }

  /** df on a box's work disk, cached for `maxAgeMs`. Saves the numbers on the box row for the Boxes page. */
  async probeDisk(boxId: string, maxAgeMs = DISK_CACHE_MS): Promise<DiskSpace | null> {
    const hit = this.diskCache.get(boxId)
    if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return hit.space
    let res: ExecResult
    try {
      res = await this.provider.exec(boxId, dfCommand(this.provider.root(boxId)))
    } catch {
      void this.markUnreachable(boxId)
      return null
    }
    this.markReachable(boxId)
    const space = res.exitCode === 0 ? parseDf(res.stdout) : null
    if (!space) return null
    const now = Date.now()
    this.diskCache.set(boxId, { at: now, space })
    if (this.store.getBox(boxId)) {
      const before = this.store.getBox(boxId)
      const size = normalizeBoxSize(before?.size)
      if (space.totalBytes > 0 && this.store.getKv(diskTotalKey(size)) !== String(space.totalBytes)) this.store.setKv(diskTotalKey(size), String(space.totalBytes))
      const root = space.root ?? null
      const mem = space.memory
      this.store.meterBox(boxId, {
        diskFreeBytes: space.freeBytes,
        diskTotalBytes: space.totalBytes,
        diskCheckedAt: now,
        rootFreeBytes: root?.freeBytes ?? null,
        rootTotalBytes: root?.totalBytes ?? null,
        // A probe without the memory part (an old or fake df) keeps the last reading.
        ...(mem ? { memUsedBytes: mem.usedBytes, memTotalBytes: mem.totalBytes, loadAvg: mem.load1, cpuCount: mem.cpus } : {}),
      })
      // A real change is worth a Boxes update (df runs often while placing), and so is a stale
      // "measured … ago" on the page.
      const changed =
        Math.abs((before?.disk_free_bytes ?? 0) - space.freeBytes) > 16 * 1024 * 1024 ||
        before?.disk_total_bytes !== space.totalBytes ||
        Math.abs((before?.root_free_bytes ?? 0) - (root?.freeBytes ?? 0)) > 16 * 1024 * 1024 ||
        (mem && (Math.abs((before?.mem_used_bytes ?? 0) - mem.usedBytes) > 64 * 1024 * 1024 || Math.abs((before?.load_avg ?? 0) - mem.load1) >= 0.5))
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
  async cleanBox(boxId: string, by: BoxActor = { kind: "owner" }): Promise<BoxCleanup> {
    const box = this.store.getBox(boxId)
    if (!box && this.history.boxIds().includes(boxId)) return goneCleanup(boxId, "manual")
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    if (box.status === "ready" && !this.boxOps.has(boxId) && !this.janitor.isRunning(boxId) && (await this.goneAtProvider(boxId))) {
      await this.loseGoneBox(boxId, "Clean up now", by)
      return goneCleanup(boxId, "manual")
    }
    if (box.status !== "ready") throw new BadRequestError(`Box ${boxId} is ${box.status}; only a running box can be cleaned up.`)
    const op = this.boxOps.get(boxId)
    if (op && !this.janitor.isRunning(boxId)) throw new ConflictError(busyMessage(boxId, op))
    // Routine upkeep is short: let it finish, then run the full cleanup that was asked for.
    if (this.janitor.runningReason(boxId) === "routine") await this.janitor.settle(boxId)
    if (!this.janitor.isRunning(boxId)) {
      this.cleanupBy.set(boxId, by)
      void this.janitor.run(boxId, { reason: "manual", target: null, parkBelow: this.diskNeed(null) })
    }
    return this.janitor.current(boxId)!
  }

  private cleanupFinished(report: BoxCleanup) {
    this.diskCache.delete(report.boxId)
    this.recordCleanup(report)
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

  /**
   * A finished cleanup in the box history: always for Clear box and Clean up now, otherwise only when the janitor
   * freed or removed something or failed (a box that stays low is retried every few minutes; those runs say nothing).
   */
  private recordCleanup(report: BoxCleanup) {
    const by = this.cleanupBy.get(report.boxId)
    this.cleanupBy.delete(report.boxId)
    const asked = report.reason === "clear" || report.reason === "manual"
    const did = report.freedBytes >= 1024 * 1024 || report.steps.some((s) => s.removed.length)
    if (!asked && !did && (report.status !== "failed" || report.reason === "routine")) return
    const why: Record<BoxCleanup["reason"], string> = {
      "low-disk": "The box was low on disk.",
      "out-of-space": "A task ran out of space on the box.",
      manual: "Clean up now.",
      clear: "Clear box: every workspace archived and taken off the box.",
      routine: "Routine upkeep (build output of idle tasks, temp folders, mirror gc).",
    }
    this.recordBoxEvent({
      boxId: report.boxId,
      type: report.reason === "clear" ? "cleared" : "cleanup",
      actor: report.reason === "clear" ? { kind: "owner" } : report.reason === "manual" ? (by ?? { kind: "owner" }) : { kind: "janitor" },
      reason: why[report.reason],
      freedBytes: report.freedBytes,
      detail: `${cleanupSummary(report)}${report.status === "failed" ? ` (failed: ${report.error ?? "unknown error"})` : ""}`,
      taskIds: cleanupTaskIds(report),
    })
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

  /** Why a task with no free slot can't count on a new box: the pool is at Max boxes, or creating boxes keeps failing. */
  private noNewBoxReason() {
    if (this.store.listBoxes().length < this.limits().maxBoxes && this.boxCreateFailing()) {
      return "Waiting for a free slot or a new box: creating boxes keeps failing, so Box Yard retries with backoff"
    }
    return "Waiting for a free slot: every box is full and the pool is at its limit"
  }

  /** Room to create another box (and box creation isn't failing right now). */
  private poolHasRoom() {
    // listBoxes() includes the placeholders of boxes being created.
    return !this.boxCreateFailing() && this.store.listBoxes().length < this.limits().maxBoxes
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
    this.poolCreates++
    if (projectId) this.creatingFor.set(projectId, (this.creatingFor.get(projectId) ?? 0) + 1)
    const placeholder = `creating-${randomUUID().slice(0, 8)}`
    const size = this.newBoxSize(projectId)
    this.store.upsertBox({ id: placeholder, provider: this.provider.name, status: "creating", created_at: Date.now(), last_used_at: Date.now(), size, keep_alive: 0, usage_source: "estimated" })
    this.emitBoxes()
    const project = projectId ? this.store.getProject(projectId) : null
    // The tasks that made the pool grow, for the history row.
    const waiting = [...this.wantsBox].filter((id) => !projectId || this.store.getTaskRow(id)?.project_id === projectId)
    try {
      const labels = this.boxLabels(projectId)
      const made = await this.createFor(projectId, labels, size)
      const id = made.id
      this.store.removeBox(placeholder)
      this.store.upsertBox({ id, provider: providerOf(this.provider, id).name, status: "ready", created_at: Date.now(), last_used_at: Date.now(), size, keep_alive: 0, usage_source: "estimated" })
      // The new box belongs to the project that asked for it, so its tasks land there.
      if (projectId && this.store.getProject(projectId)) {
        this.store.setKv(projectBoxKey(projectId), id)
        this.store.setKv(boxOwnerKey(id), projectId)
      }
      this.recordBoxEvent({
        boxId: id,
        type: "created",
        actor: { kind: "scheduler" },
        reason: project ? `Project ${project.name} needed a box for its tasks.` : "Tasks were waiting and the pool had room.",
        detail: createdDetail(made, project?.name),
        taskIds: waiting,
      })
      this.afterCreateFor(id, projectId, made, { kind: "scheduler" })
      void this.refreshBoxUsage(id, true).finally(() => {
        this.emitBoxes()
        this.schedule()
      })
      this.lastBoxError = null
      this.boxCreateWorked()
      console.log(`[box-yard] created box ${id}${project ? ` for project ${project.name}` : ""}`)
    } catch (err) {
      this.store.removeBox(placeholder)
      const delay = this.boxCreateFailed(err)
      const message = `Couldn't create a worker box: ${errorMessage(err)}`
      console.error(`[box-yard] ${message}`)
      if (!this.lastBoxError || this.lastBoxError.message !== message) this.notice(`⚠️ ${message}. Retrying in ${Math.max(1, Math.round(delay / 1000))}s.`)
      this.lastBoxError = { at: Date.now(), message }
      setTimeout(() => this.schedule(), delay).unref()
    } finally {
      this.creatingBoxes--
      this.poolCreates--
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
    return `${tasksRootOf(this.provider, boxId)}/${taskId}`
  }

  private async launch(taskId: string, boxId: string, turnId: string) {
    let row = this.requireRow(taskId)
    const dir = this.taskDir(boxId, taskId)
    const launchedAt = Date.now()
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
      if (recapped && row.compact_pending) {
        // No folder left behind: the next turn must find the session gone too and start from a recap, not resume it.
        await this.removeTaskDir(boxId, taskId).catch(() => {})
        throw new Error("its Claude session is gone (no workspace archive), so there is nothing to compact")
      }
      const compact = Boolean(row.compact_pending) && Boolean(row.session_started)
      // A compaction is a turn of its own; queued messages wait for the next one. The rest are claimed for this
      // turn: locked against edits and cancels, delivered (deleted) once it starts, released if it can't.
      const queued = compact ? [] : this.store.claimInputs(taskId, turnId)
      if (!compact) this.emitTask(taskId)
      // Cody cancelled every message this turn was for: don't run it on "Continue.".
      if (!compact && !queued.length && row.session_started && this.cancelledAll.has(taskId)) throw new StoppedBeforeStart(true)
      this.cancelledAll.delete(taskId)
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
        row = this.recapSession(row, prepared!, project.baseBranch)
      }
      const prompt = compact
        ? "/compact"
        : firstTurn
        ? firstTurnPrompt({ task: row, notes: budgeted.shown, hiddenNotes: budgeted.hidden.length, directory, extraInputs: inputs.length ? [followup] : [], ownerName })
        : recapped
        ? `${recapPrompt(this.store.getTask(taskId)!, this.store.listTaskMessages(taskId, 60), { workspace: recapWorkspaceNote(row.branch, prepared!.branch, project.baseBranch, prepared!.fallback) })}\n\n---\n\n${followup}`
        : followup

      const runnerPath = `${this.provider.root(boxId)}/.boxyard/box-runner.mjs`
      await this.provider.writeFile(boxId, runnerPath, this.runnerSource())
      await this.provider.writeFile(boxId, `${dir}/task.json`, JSON.stringify(this.taskJson(row, project, boxId), null, 2))
      const { route, ...agent } = this.agentSettings(row, project)
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
          systemPrompt: workerSystemPrompt({ project, task: row, branch: row.branch, port: row.port_base ?? PORT_BASE, ownerName, pushAtTurnEnd: this.pushAtTurnEnd(project), box: this.boxPromptInfo(boxId, project) }),
          directory,
          notes: notes.map((n) => ({ author: n.author, content: n.content })),
          recap: recapPrompt(this.store.getTask(taskId)!, this.store.listTaskMessages(taskId, 60)),
          ...(this.depCache(project) ? { deps: { npm: true, dir: `${this.provider.root(boxId)}/${DEPS_DIR}`, maxMb: this.settings.get().depCacheMaxMb } } : {}),
        }),
      )

      if (this.stopRequested.has(taskId)) throw new StoppedBeforeStart()
      // Setup ran long enough for maintain() to give up on this start: its slot is free again, so no agent may run.
      const superseded = () => this.store.getTaskRow(taskId)?.current_turn_id !== turnId
      if (superseded()) throw new TurnSuperseded()
      this.store.startTaskTurn({
        id: turnId,
        taskId,
        turnIndex: compact ? row.turn_count : row.turn_count + 1,
        model: agent.model,
        effort: agent.effort,
        routingRule: route.rule,
        routingReason: route.reason,
        status: compact ? "compact" : "started",
      })

      // setsid (where it exists; macOS has none) + nohup: the turn survives a
      // dropped exec connection. The runner writes turn.pid itself.
      const start = await this.provider.exec(
        boxId,
        `cd ${q(dir)} && ([ -f turn.pid ] && kill -TERM -- -$(cat turn.pid) 2>/dev/null; rm -f turn.pid; true) && ($(command -v setsid || true) nohup ${q(providerOf(this.provider, boxId).nodeBin)} ${q(runnerPath)} turn ${q(dir)} >> runner.log 2>&1 < /dev/null &) && for i in $(seq 1 50); do [ -f turn.pid ] && break; sleep 0.2; done; [ -f turn.pid ] && cat turn.pid || (tail -n 20 runner.log; exit 1)`,
      )
      if (start.exitCode !== 0) throw new Error(`runner did not start: ${(start.stdout + start.stderr).slice(-800)}`)
      if (superseded()) {
        await this.provider.exec(boxId, `cd ${q(dir)} && [ -f turn.pid ] && kill -TERM -- -$(cat turn.pid) 2>/dev/null; true`).catch(() => {})
        this.store.finishTaskTurn(turnId, { status: "stopped", error: "Its start timed out." })
        throw new TurnSuperseded()
      }

      const merge = this.store.mergeRequestOf(row)
      if (merge && !merge.deliveredAt && queued.some((i) => i.id === merge.inputId)) {
        this.store.updateTask(taskId, { mergeRequest: { ...merge, deliveredAt: Date.now() } }, { quiet: true, touch: false })
      }
      for (const message of this.store.deliverInputs(turnId)) this.hub.broadcast({ type: "task.message", message })
      this.diskRetried.delete(taskId)
      this.diskHold.delete(taskId)
      const flags = this.store.turnFlags(row)
      // Hooks whose prompts are in this turn (a retried turn keeps the interrupted one's), so they don't fire on it.
      const hookIds = [...new Set([...queued.filter((i) => i.source.startsWith("hook:")).map((i) => i.source.slice("hook:".length)), ...(flags.interrupts || flags.sleeps ? (flags.hookIds ?? []) : [])])]
      this.store.updateTask(taskId, {
        status: "working",
        sessionStarted: true,
        ...(compact ? { compacting: true, compactPending: false } : { turnCount: row.turn_count + 1 }),
        turnFlags: { interrupts: flags.interrupts, sleeps: flags.sleeps, ...(hookIds.length ? { hookIds } : {}) } as TurnFlags,
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
      this.store.releaseInputs(turnId)
      // The task already moved on (failed by the start timeout, maybe started again): nothing here is ours to change.
      if (err instanceof TurnSuperseded) {
        console.warn(`[box-yard] launch ${taskId} on ${boxId}: turn ${turnId} was given up on before its agent started`)
        this.schedule()
        return
      }
      const stopped = err instanceof StoppedBeforeStart
      const cancelled = stopped && err.cancelled
      if (cancelled) this.cancelledAll.delete(taskId)
      this.stopRequested.delete(taskId)
      let message = errorMessage(err)
      if (!stopped) console.error(`[box-yard] launch ${taskId} on ${boxId} failed: ${message}`)
      const current = this.store.getTaskRow(taskId)
      if (!current) return
      // A compaction that couldn't start isn't worth failing the task over.
      const wasCompact = Boolean(current.compact_pending || current.compacting)
      const local = isLocalRunnerBox(boxId)
      // This computer slept while the agent was being set up (a clone or fetch lost its connection): start it again (#104).
      if (local && !stopped && this.sleep.sleptBetween(launchedAt) > 0) {
        this.store.finishTaskTurn(turnId, { status: "interrupted", error: message })
        this.store.updateTask(taskId, { status: "queued", currentTurnId: null, error: null })
        this.addEvent(taskId, `This computer slept while the agent was starting (${message}); starting it again.`)
        this.emitTask(taskId)
        this.schedule()
        return
      }
      const outOfSpace = !stopped && isOutOfSpace(message)
      // The disk cleanup and its retry are for boxes: the janitor never touches this computer.
      if (outOfSpace && !local && !wasCompact && !this.diskRetried.has(taskId)) {
        this.store.finishTaskTurn(turnId, { status: "failed", error: message })
        await this.retryAfterOutOfSpace(current, boxId, fresh)
        return
      }
      if (outOfSpace && local) message = `this computer is out of disk space. Free some space on it, then retry. ${message}`
      else if (outOfSpace) {
        this.diskRetried.delete(taskId)
        this.diskHold.delete(taskId)
        const space = await this.probeDisk(boxId, 0)
        message = `box ${boxId} is out of disk space${space ? ` (${diskLine({ freeBytes: space.freeBytes, totalBytes: space.totalBytes })})` : ""}, even after cleaning it up and retrying. Free space on it or add a box, then retry. ${message}`
      }
      this.store.finishTaskTurn(turnId, { status: stopped ? "stopped" : "failed", error: stopped ? null : message })
      const prev = current.compact_prev_status
      this.store.updateTask(taskId, {
        status: wasCompact ? (prev && !["queued", "starting", "working"].includes(prev) ? prev : "idle") : cancelled ? this.queuedFrom(taskId) : stopped ? "idle" : "failed",
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
        if (health === "gone" || health === "error")
          await this.loseBox(boxId, `Box ${boxId} is ${health}.`, false, { type: "lost", actor: { kind: "provider" }, reason: `The provider reports the box ${health} (an agent couldn't start on it).` })
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
  private recapSession(row: TaskRow, { branch, fallback }: PreparedWorkspace, baseBranch: string): TaskRow {
    this.store.updateTask(row.id, { sessionId: randomUUID() })
    const checkout = !row.branch ? "a fresh workspace" : branch === "base" ? `branch ${row.branch} recreated from ${baseBranch} (it is gone from origin)` : `a fresh checkout of branch ${row.branch}`
    const why = fallback ? "its workspace archive couldn't be restored" : "no workspace archive was left"
    this.addEvent(row.id, `Resumed from a recap: ${why}, so a new Claude session started on ${checkout} with the task's summary, PR and recent messages.`)
    return this.requireRow(row.id)
  }

  /** What Box Yard calls its human (Settings.ownerName). */
  owner(): string {
    return this.settings.get().ownerName
  }

  /** Model, effort, route and auto-compact window for a turn, from the task, routing YAML and saved settings (read fresh each turn; precedence in resolveAgentRoute). */
  private agentSettings(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>) {
    const { settings: s, sources } = this.settings.info()
    const route = resolveAgentRoute({
      task: { model: row.model, effort: row.effort, routingRule: row.routing_rule, routingReason: row.routing_reason },
      config: loadRouting(this.c.dataDir, s).config,
      project,
      settings: s,
      sources,
    })
    return { model: route.model, effort: route.effort, autocompact: autocompactFlag(s.agentAutoCompact, row.context_window), route }
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
        // so any attachment over ~7.5 MB failed with "invalid request body". putFile splits one over 100 MB.
        await putFile(this.provider, boxId, file.path, `${folder}/${name}`)
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
    // Read on every turn, so a credential saved in Settings › Credentials reaches the next turn without a restart.
    const creds = this.settings.credentials
    const claude = creds.claudeEnv()
    Object.assign(env, claude)
    const githubToken = creds.get("githubToken")
    if (githubToken) env.GITHUB_TOKEN = env.GITHUB_TOKEN ?? githubToken
    const provider = providerOf(this.provider, boxId)
    const local = provider.name === "local"
    const [claudeBin, ...claudeArgs] = (local ? this.c.claudeBin : provider.claudeBin).split(" ")
    return {
      taskId: row.id,
      projectId: project.id,
      boxId,
      env,
      claudeBin,
      claudeArgs,
      // A local `claude` login lives in the default config dir, so only
      // isolate when we have a token to log in with.
      isolateConfig: !local || Object.keys(claude).length > 0,
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
   * base branch because it no longer exists there. A restore that fails is tried once more (not when the box refused
   * the upload for its size: that fails the same way every time); then the task restarts from a recap on a fresh
   * checkout (`fallback`), so a broken archive can't fail every start.
   */
  private async prepareWorkspace(row: TaskRow, boxId: string, dir: string): Promise<PreparedWorkspace> {
    const project = this.store.getProject(row.project_id)!
    const mirror = project.repo ? this.mirrorSpec(boxId, project) : null
    if (row.archive_path && fs.existsSync(row.archive_path)) {
      let failure: unknown = null
      for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
        try {
          return await this.restoreArchive(row, project, boxId, dir, mirror)
        } catch (err) {
          failure = err
          // Out of disk has its own retry once the box is cleaned up (retryAfterOutOfSpace); shutting down isn't the archive's fault.
          if (this.stopped || isOutOfSpace(errorMessage(err))) throw err
          console.warn(`[box-yard] restoring ${row.id} on ${boxId} failed (attempt ${attempt} of ${RESTORE_ATTEMPTS}): ${errorMessage(err)}`)
          if (isUploadTooBig(err)) break
        }
      }
      return this.recapAfterFailedRestore(row, project, boxId, dir, mirror, failure)
    }
    return this.cloneWorkspace(row, project, boxId, dir, mirror)
  }

  /** Unpack the task's archive into its folder and rebuild work/. Throws (leaving no folder) when that fails. */
  private async restoreArchive(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, dir: string, mirror: ReturnType<TaskManager["mirrorSpec"]> | null): Promise<PreparedWorkspace> {
    const root = this.provider.root(boxId)
    const tasks = tasksRootOf(this.provider, boxId)
    const remote = `${root}/.boxyard/restore-${row.id}.tgz`
    let from: "git" | "partial" | null = null
    try {
      // In parts when it's over the box's upload limit (Upstash: 100 MB per file).
      await putFile(this.provider, boxId, row.archive_path!, remote)
      const res = await this.provider.exec(
        boxId,
        `mkdir -p ${q(tasks)} && tar xzf ${q(remote)} -C ${q(tasks)} && rm -f ${q(remote)} && mkdir -p ${q(dir + "/work")} && rm -f ${q(dir + "/turn.pid")}`,
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
    this.addEvent(row.id, from === "git" ? `Workspace restored ${onBox(boxId)}: its session from the archive, its code from git.` : `Workspace restored ${onBox(boxId)}.`)
    return { restored: true }
  }

  /**
   * The archive couldn't be restored: start over like a task whose archive expired, on a fresh checkout of its
   * branch with the uncommitted work its last turn pushed (refs/boxyard/wip/<task>) laid over it when origin has
   * that, and a recap. The archive is set aside on the server, not deleted, and the Captain gets a notice.
   */
  private async recapAfterFailedRestore(
    row: TaskRow,
    project: NonNullable<ReturnType<Store["getProject"]>>,
    boxId: string,
    dir: string,
    mirror: ReturnType<TaskManager["mirrorSpec"]> | null,
    failure: unknown,
  ): Promise<PreparedWorkspace> {
    const reason = errorMessage(failure).replace(/^restoring workspace failed: /, "").trim().slice(0, 500) || "unknown error"
    let prepared: PreparedWorkspace
    try {
      prepared = await this.cloneWorkspace(row, project, boxId, dir, mirror)
    } catch (err) {
      // No half-built folder, and the archive stays as it was (origin may only be unreachable for now): the next start tries it again.
      await this.provider.exec(boxId, `rm -rf ${q(dir)}`).catch(() => {})
      throw new Error(`restoring workspace failed: ${reason}; the fresh checkout to restart from a recap failed too: ${errorMessage(err)}`)
    }
    const wip = mirror ? await this.applyPushedWip(row, boxId, dir, mirror) : false
    const kept = this.setAsideArchive(row, reason)
    const checkout = !row.branch ? "a fresh workspace" : prepared.branch === "base" ? `branch ${row.branch} recreated from ${project.baseBranch}` : `a fresh checkout of branch ${row.branch}`
    const work = wip ? ", with the uncommitted work its last turn pushed" : ""
    const where = kept ? ` The archive is kept on the server as ${kept} (removed after ${this.settings.get().archiveRetentionDays || "no"} days).` : ""
    this.addEvent(row.id, `Couldn't restore the workspace archive ${onBox(boxId)} (${reason}), so the task restarts from a recap on ${checkout}${work}.${where}`)
    this.notice(`⚠️ **${row.title}** restarts from a recap: its workspace archive couldn't be restored ${onBox(boxId)} (${reason}). A new Claude session starts on ${checkout}${work}; anything else that wasn't pushed is only in the old archive.${where}`, { taskId: row.id })
    return { ...prepared, fallback: { reason, wip } }
  }

  /**
   * After a fresh checkout: put back the uncommitted work the task's last turn pushed to origin (gitFirst.ts), as
   * uncommitted changes, when the checkout is at the commit that snapshot was made on. Best effort: false when
   * there is none or it doesn't fit.
   */
  private async applyPushedWip(row: TaskRow, boxId: string, dir: string, { env }: { env: string }): Promise<boolean> {
    const push = this.store.getTask(row.id)?.pushState
    if (!push?.wip) return false
    const mark = "boxyard-wip="
    const res = await this.provider
      .exec(
        boxId,
        [
          env,
          `cd ${q(`${dir}/work`)} || exit 1`,
          `git fetch -q origin ${q(wipRef(row.id))} >/dev/null 2>&1 && w=$(git rev-parse -q --verify FETCH_HEAD) || { echo ${mark}none; exit 0; }`,
          // The snapshot's first parent is HEAD when it was made; on any other commit its files would undo commits.
          `[ "$(git rev-parse -q --verify HEAD)" = "$(git rev-parse -q --verify "$w^1")" ] || { echo ${mark}moved; exit 0; }`,
          `git read-tree -u --reset "$w^{tree}" && git reset -q && echo ${mark}applied`,
        ].join("\n"),
      )
      .catch(() => null)
    const state = res?.stdout.match(new RegExp(`${mark}(\\w+)`))?.[1]
    if (state !== "applied") console.warn(`[box-yard] ${row.id}: pushed uncommitted work not put back after a failed restore (${state ?? (errorTail(res?.stderr ?? "") || "no result")})`)
    return state === "applied"
  }

  /**
   * Move an archive that couldn't be restored out of the next archive's way, as `<task>.unrestored.tgz`. Archive
   * retention removes it as an orphan after archiveRetentionDays. The task no longer points at it either way, so a
   * later restore doesn't try it again. Returns where it is, or null when it couldn't be moved.
   */
  private setAsideArchive(row: TaskRow, reason: string): string | null {
    const from = row.archive_path!
    const to = path.join(path.dirname(from), `${row.id}.unrestored.tgz`)
    let kept: string | null = to
    try {
      fs.renameSync(from, to)
      // Retention goes by age, and this one only now stopped being the task's archive.
      const now = new Date()
      fs.utimesSync(to, now, now)
    } catch (err) {
      console.warn(`[box-yard] couldn't set aside ${from}: ${errorMessage(err)}`)
      kept = null
    }
    this.store.updateTask(row.id, { archivePath: null, lastArchivedAt: null }, { touch: false })
    this.store.noteTaskArchiveUnavailable(row.id, from, `couldn't be restored (${reason.slice(0, 200)})${kept ? `; kept as ${kept}` : ""}`)
    return kept
  }

  /** A fresh folder with the task's repo cloned (or an empty work/ without one). */
  private async cloneWorkspace(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, dir: string, mirror: ReturnType<TaskManager["mirrorSpec"]> | null): Promise<PreparedWorkspace> {
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
    this.addEvent(row.id, project.repo ? `Cloned ${project.repo} ${onBox(boxId)}${row.branch ? `, branch ${row.branch}` : ""}.` : `Workspace ready ${onBox(boxId)}.`)
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
    const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.settings.credentials.get("githubToken")
    const spec: MirrorSpec = {
      root: this.provider.root(boxId),
      tasks: tasksRootOf(this.provider, boxId),
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
   * (a git-first archive), or the working tree of a partial archive. A thin archive's git-thin/ is restored before
   * this, by restoreThinGit. Throws when that fails.
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
    const wait = `while [ -f ${q(pidFile)} ] && kill -0 $(cat ${q(pidFile)}) 2>/dev/null; do sleep 15; echo .; done`
    // On this computer it keeps a Mac out of idle sleep while the turn runs (caffeinate; -s holds off system sleep on
    // AC power too), as the stream keeps a box awake. Closing the lid still sleeps it: the turn resumes on wake.
    const command = isLocalRunnerBox(boxId) ? `if command -v caffeinate >/dev/null 2>&1 && [ -f ${q(pidFile)} ]; then exec caffeinate -is -w "$(cat ${q(pidFile)})"; fi; ${wait}` : wait
    const loop = async () => {
      let quickExits = 0
      while (!ctrl.signal.aborted && !this.stopped) {
        const started = Date.now()
        await this.provider.hold(boxId, command, ctrl.signal)
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
      case "deps": {
        // Only what changes the agent's start is shown; saves, misses and skips are in events.jsonl.
        const seconds = typeof ev.ms === "number" ? ` in ${(ev.ms / 1000).toFixed(1)} s` : ""
        if (ev.action === "restored") return say("event", `Restored node_modules from the box's dependency cache${seconds}.`, { kind: "deps" })
        if (ev.action === "failed") return say("event", `Dependency cache step failed: ${String(ev.error ?? "unknown error")}`, { kind: "deps" })
        return
      }
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
      case "message_captain":
        return this.deliverCaptainMessage(row, ev)
      case "captain_reply_taken": {
        // The waiting agent got the Captain's reply mid-turn, so its queued copy mustn't go out again next turn.
        this.endCaptainWait(taskId, String(ev.id ?? ""))
        const taken = typeof ev.inputId === "string" ? this.store.takeInput(taskId, ev.inputId) : null
        if (taken?.message) this.hub.broadcast({ type: "task.message", message: taken.message })
        say("event", "The Captain's reply reached the agent mid-turn, while it waited.", { kind: "captain_reply", agentMessageId: ev.id })
        return this.emitTask(taskId)
      }
      case "captain_wait_end":
        return this.endCaptainWait(taskId, String(ev.id ?? ""))
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
          this.notice(`📎 **${row.title}** published ${artifact.title}: ${this.absoluteUrl(artifact.url)}`, { taskId, artifactId: artifact.id })
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
    } else if (prev === "draft" && info.state === "open" && ["pr_ready", "done", "idle"].includes(row.status) && !row.current_turn_id) {
      this.emitTaskEvent({ type: "task.pr_ready", taskId, turnId: null, originHookIds })
    }
  }

  private finishTurn(row: TaskRow, ev: WorkerEvent, pr: PrState | null = null) {
    if (ev.turnId && row.current_turn_id && ev.turnId !== row.current_turn_id) return // stale event from an older turn
    if (!row.current_turn_id) return
    this.captainWaits.delete(row.id)
    // A Captain reply handed to a wait the agent didn't take: queued (and editable) again, for the next turn.
    this.store.releaseInputs(handoffClaim(row.current_turn_id))
    if (row.compacting) return this.finishCompact(row, ev)
    const flags = this.store.turnFlags(row)
    const stopped = Boolean(ev.stopped) || this.stopRequested.has(row.id)
    this.stopRequested.delete(row.id)
    this.holds.get(row.id)?.abort()
    this.holds.delete(row.id)
    if (!stopped && !ev.ok && isLocalRunnerBox(row.box_id) && (flags.sleeps ?? 0) < MAX_SLEEP_RESUMES) {
      const slept = this.sleptBeforeEnd(row, ev)
      if (slept > 0) return this.resumeAfterSleep(row, ev, flags, slept)
    }

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
    // The PR as it stands now: turn_end just asked GitHub (head commit and state), or the runner's push if it couldn't.
    const livePr = Boolean(row.pr_url) && !isFinalPrState(pr ?? row.pr_state)
    if (!stopped) this.turnEvents(row, status, Boolean(more), Boolean(finished && isQuietRun(finished)), flags, livePr)

    this.emitTask(row.id)
    this.publishDirectory()
    void this.archive(row.id).finally(() => this.schedule())
    this.schedule()
  }

  /**
   * How long this computer slept under a local turn that just failed, when the failure came soon after waking
   * (SLEEP_WAKE_GRACE_MS): a dropped API connection or a timeout that fired on wake. 0 when it didn't sleep, or ran on
   * for a while after. A turn that started before this server did has only the runner's own count (no timing).
   */
  private sleptBeforeEnd(row: TaskRow, ev: WorkerEvent): number {
    const started = (row.current_turn_id ? this.store.getTaskTurn(row.current_turn_id)?.started_at : null) ?? row.updated_at
    const seen = this.sleep.sleptBetween(Math.max(started, Date.now() - SLEEP_WAKE_GRACE_MS))
    const runner = typeof ev.sleptMs === "number" && this.sleep.since > started && ev.sleptMs >= RUNNER_SLEEP_MIN_MS ? ev.sleptMs : 0
    return Math.max(seen, runner)
  }

  /**
   * A local turn this computer's sleep cut off (a laptop lid closed): queued again to carry on in the same session
   * instead of failing (#104). Each needs a real sleep; after MAX_SLEEP_RESUMES in a row the next failure counts.
   */
  private resumeAfterSleep(row: TaskRow, ev: WorkerEvent, flags: TurnFlags, sleptMs: number) {
    const error = String(ev.error ?? "The agent exited with an error.")
    const asleep = sleepLength(sleptMs)
    const turnCost = this.recordTaskClaudeUsage(row, ev)
    this.store.finishTaskTurn(row.current_turn_id!, { status: "interrupted", costUsd: turnCost, error })
    this.store.queueInput(
      row.id,
      "system",
      `Your previous turn was cut off when this computer went to sleep (asleep ${asleep}; it ended with: ${error.slice(0, 300)}). Check where things stand (git status, files, any server or benchmark you started) and continue the task.`,
    )
    this.store.updateTask(row.id, {
      status: "queued",
      error: null,
      currentTurnId: null,
      ...usageFields(ev.usage),
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : undefined,
      turnFlags: { interrupts: flags.interrupts ?? 0, sleeps: (flags.sleeps ?? 0) + 1, ...(flags.hookIds ? { hookIds: flags.hookIds } : {}) },
    })
    this.addEvent(row.id, `Turn ${row.turn_count} was cut off while this computer slept (${asleep}); it carries on now instead of failing.`)
    this.emitTask(row.id)
    this.publishDirectory()
    this.schedule()
  }

  /** The hook events a finished turn raises. A stopped turn raises none: Cody stepped in. */
  private turnEvents(row: TaskRow, status: TaskStatus, more: boolean, quiet: boolean, flags: TurnFlags, livePr: boolean) {
    const base = { taskId: row.id, turnId: row.current_turn_id, originHookIds: flags.hookIds ?? [], sawPr: Boolean(flags.sawPr) }
    if (row.schedule_id && ["done", "idle", "pr_ready", "failed"].includes(status) && !more) this.emitTaskEvent({ ...base, type: "schedule.run_finished" })
    // A quiet run did nothing worth acting on; only schedule.run_finished hooks that include quiet runs see it.
    if (quiet) return
    if (status === "failed") this.emitTaskEvent({ ...base, type: "task.failed" })
    else if (status === "needs_input") this.emitTaskEvent({ ...base, type: "task.needs_input" })
    else if (!more && (status === "idle" || status === "pr_ready" || status === "done")) {
      this.emitTaskEvent({ ...base, type: "task.finished" })
      // Any resting turn with an open PR, not just pr_ready: an agent that opens a PR and calls mark_done ends "done".
      // The hook engine fires once per head commit, so a later turn on the same commit doesn't fire again.
      if (livePr) this.emitTaskEvent({ ...base, type: "task.pr_ready" })
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
        // stop() may have closed the database while the archive ran.
        if (this.stopped) return
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
      this.store.setKv(queuedFromKey(target.id), target.status)
      this.store.updateTask(target.id, { status: "queued" })
    }
    this.emitTask(target.id)
    this.schedule()
  }

  /**
   * An agent's message_captain: to the Captain of the agent's own project, never another (the agent doesn't
   * name one). Rate-limited per task; a waiting agent hears at once why a message wasn't delivered.
   */
  private deliverCaptainMessage(from: TaskRow, ev: WorkerEvent) {
    const id = typeof ev.id === "string" && /^[\w-]{1,64}$/.test(ev.id) ? ev.id : null
    const message = String(ev.message ?? "").trim().slice(0, 8000)
    const wait = id ? Math.max(0, Math.min(AGENT_CAPTAIN_WAIT_MAX_SECONDS, Math.round(Number(ev.wait) || 0))) : 0
    if (!message) return
    const say = (content: string, meta: Record<string, unknown>) => {
      const msg = this.store.addTaskMessage(from.id, "agent", content, { to: "captain", ...meta })
      this.hub.broadcast({ type: "task.message", message: msg })
    }
    const refuse = (why: string) => {
      say(`Message to the Captain not delivered: ${why}`, { blocked: true })
      if (wait && id) void this.writeCaptainReply(from, id, { status: "rejected", text: why })
      else {
        this.store.queueInput(from.id, "system", `Your message_captain was not delivered: ${why}`)
        this.schedule()
      }
    }
    const since = Date.now() - AGENT_CAPTAIN_WINDOW_MS
    const recent = this.store
      .listCaptainMessages(from.project_id, 300)
      .filter((m) => m.role === "user" && m.meta?.source === "agent" && m.meta?.taskId === from.id && m.createdAt >= since).length
    if (recent >= AGENT_CAPTAIN_LIMIT) return refuse(`you already sent the Captain ${AGENT_CAPTAIN_LIMIT} messages in the last 10 minutes (the limit).`)
    if (!this.onCaptainMessage) return refuse("this Box Yard has no Captains.")
    const sent = this.onCaptainMessage(from.project_id, { taskId: from.id, taskTitle: from.title, message, agentMessageId: id ?? "", waitSeconds: wait })
    const captain = `${this.store.getProject(from.project_id)?.name ?? "project"} Captain`
    say(`→ ${captain}: ${message}`, { captainMessageId: sent.message.id, agentMessageId: id, waitSeconds: wait, ...(sent.heldUntil ? { heldUntil: sent.heldUntil } : {}) })
    if (sent.heldUntil) {
      const at = new Date(sent.heldUntil).toISOString().slice(11, 16)
      const why = `the Captain's loop guard is holding repeated messages until ${at} UTC. It keeps yours and reads it then; any reply arrives as your next message.`
      if (wait && id) void this.writeCaptainReply(from, id, { status: "rejected", text: why })
      return
    }
    if (wait && id) {
      const waits = this.captainWaits.get(from.id) ?? []
      waits.push({ id, turnId: from.current_turn_id, until: Number(ev.ts ?? Date.now()) + wait * 1000 + 2000 })
      this.captainWaits.set(from.id, waits)
    }
  }

  /** The agent is in a message_captain wait right now, so a Captain reply reaches it mid-turn. */
  agentWaitingOnCaptain(taskId: string): boolean {
    return this.openCaptainWaits(taskId).length > 0
  }

  private openCaptainWaits(taskId: string): CaptainWait[] {
    const row = this.store.getTaskRow(taskId)
    const now = Date.now()
    const open = (this.captainWaits.get(taskId) ?? []).filter((w) => row?.current_turn_id && w.turnId === row.current_turn_id && w.until > now)
    if (open.length) this.captainWaits.set(taskId, open)
    else this.captainWaits.delete(taskId)
    return open
  }

  private endCaptainWait(taskId: string, id: string) {
    const left = (this.captainWaits.get(taskId) ?? []).filter((w) => w.id !== id)
    if (left.length) this.captainWaits.set(taskId, left)
    else this.captainWaits.delete(taskId)
  }

  /**
   * Give the Captain's reply to the agent's oldest open wait. The input stays in the queue too, locked (not
   * editable): if the wait ran out before the runner read the file, the turn's end unlocks it and the reply arrives
   * as the agent's next message; if the runner read it, its captain_reply_taken event takes the queued copy (it
   * comes before the turn ends) and writes its transcript line.
   */
  private handToWaitingAgent(row: TaskRow, inputId: string, content: string) {
    const wait = this.openCaptainWaits(row.id)[0]
    if (!wait) return
    // Locked from now on, so an edit can't go missing: the agent may read this text any moment.
    if (!row.current_turn_id || !this.store.lockInput(row.id, inputId, handoffClaim(row.current_turn_id))) return
    this.endCaptainWait(row.id, wait.id)
    void this.writeCaptainReply(row, wait.id, { status: "reply", text: content, inputId })
  }

  /**
   * A Captain turn read these message_captain messages. An agent still waiting on one got no reply_to_agent or
   * send_to_task, so tell it now (with what the turn said) rather than let it wait out the clock.
   */
  captainHandledAgentMessages(messages: CaptainMessage[], reply: string) {
    for (const m of messages) {
      const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
      const id = typeof m.meta?.agentMessageId === "string" ? m.meta.agentMessageId : null
      if (!taskId || !id) continue
      const row = this.store.getTaskRow(taskId)
      if (!row || !this.openCaptainWaits(taskId).some((w) => w.id === id)) continue
      this.endCaptainWait(taskId, id)
      void this.writeCaptainReply(row, id, { status: "no_reply", text: preview(reply, 4000, "the full text is in the Captain tab") })
    }
  }

  private async writeCaptainReply(row: TaskRow, id: string, body: { status: "reply" | "no_reply" | "rejected"; text: string; inputId?: string }) {
    if (!row.box_id) return
    try {
      await this.provider.writeFile(row.box_id, `${this.taskDir(row.box_id, row.id)}/captain-reply-${id}.json`, JSON.stringify(body))
    } catch (err) {
      console.warn(`[box-yard] couldn't hand the Captain's answer to ${row.id}: ${errorMessage(err)}`)
    }
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
    // A box task archives as each turn ends, a moment before last_active_at is stamped. A task on this computer
    // never does, so an archive there is current only from after its last activity: a box archive from just
    // before a fast local turn must not pass for one.
    const slack = isLocalRunnerBox(row.box_id) ? 0 : 1000
    return Boolean(row.archive_path && (row.last_archived_at ?? 0) >= row.last_active_at - slack && fs.existsSync(row.archive_path))
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
   * A task on this computer (the local runner) only pushes: its folder is already on this disk, so it gets an archive
   * only `forMove`, when it's about to move to a box.
   */
  async archive(taskId: string, opts: { closing?: boolean; forMove?: boolean } = {}) {
    // One at a time per task. Wait rather than return: the one running may predate the work this call is for.
    while (this.archiving.has(taskId)) await new Promise((r) => setTimeout(r, 100))
    if (this.stopped) return
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id) return
    const project = this.store.getProject(row.project_id)
    const push = Boolean(project && this.pushAtTurnEnd(project))
    const keep = this.c.archiveWorkspaces && (!isLocalRunnerBox(row.box_id) || Boolean(opts.forMove))
    if (!keep && !push) return
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
      if (!keep) return
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

  /** Whether a project's tasks use the box dependency cache (box-runner.mjs depsRestore/depsSave): its own choice, else Settings. */
  depCache(project: { depCache?: boolean | null }): boolean {
    return project.depCache ?? this.settings.get().depCacheEnabled
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
    const script = archiveScript({ root: tasksRootOf(this.provider, boxId), boxRoot: this.provider.root(boxId), taskId, excludes, maxBytes, partial, thin: mode.thin, mirror, git: mode.git, keepStage: mode.keepStage })
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
    if (isLocalRunnerBox(row.box_id)) return // no archive on this computer: its folder stays until the task is deleted
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
    const turnId = typeof ev.turnId === "string" ? ev.turnId : row.current_turn_id
    const cost = this.store.recordClaudeUsage({
      source: "task",
      runKind: ev.compact ? "compact" : "turn",
      taskId: row.id,
      projectId: row.project_id,
      turnId,
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : row.session_id,
      // The model the turn started on (task_turns), which may come from Settings or routing rather than the task row.
      model: (turnId ? this.store.getTaskTurn(turnId)?.model : null) ?? row.model ?? this.settings.get().agentModel,
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
    const provider = providerOf(this.provider, boxId)
    if (!provider.usage) {
      await this.probeDisk(boxId, 0).catch(() => null)
      return
    }
    let probe: BoxUsageProbe
    try {
      probe = await provider.usage(boxId)
    } catch {
      void this.markUnreachable(boxId)
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
    if (row && patch.size && patch.size !== normalizeBoxSize(row.size) && !this.boxOps.has(boxId)) {
      this.recordBoxEvent({
        boxId,
        type: "size_changed",
        actor: { kind: "provider" },
        reason: "The provider reports a different size than Box Yard had on record.",
        size: patch.size,
        fromSize: normalizeBoxSize(row.size),
        toSize: patch.size,
      })
    }
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
      // A folder on this computer is already on this disk: parking it would only swap it for an archive beside it.
      if (isLocalRunnerBox(row.box_id) || row.last_active_at > cutoff || !this.hasFreshArchive(row)) continue
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
    // `<task>.unrestored.tgz` (setAsideArchive) has no task of that id, so it goes as an orphan.
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
        // On this computer the time asleep doesn't count: the setup carries on when it wakes.
        const asleep = isLocalRunnerBox(row.box_id) ? this.sleep.sleptBetween(row.updated_at, now) : 0
        if (now - row.updated_at - asleep > START_TIMEOUT_MS) {
          this.store.updateTask(row.id, { status: "failed", currentTurnId: null, error: "Starting the agent timed out." })
          this.emitTask(row.id)
        }
        continue
      }
      const last = this.lastEventAt.get(row.id) ?? row.updated_at
      if (now - last < STALL_MS) continue
      const h = await health(row.box_id)
      if (isGpuBox(row.box_id) && (h === "paused" || h === "gone" || h === "error")) {
        // The pod went away under a running turn (terminated in RunPod's console, its watchdog, a host failure).
        // Its workspace comes back from the archive on the next turn, on a new pod.
        if (h === "error") await this.gpu?.provider.destroy(row.box_id).catch(() => {})
        this.gpuPodEvent({ boxId: row.box_id, kind: "terminated", detail: `Pod ${h}`, actor: { kind: "provider" }, reason: `RunPod reports the pod ${h === "paused" ? "stopped" : h} while a turn ran.` })
        this.interrupt(this.requireRow(row.id), `its GPU pod ${h === "paused" ? "stopped" : `is ${h}`}`)
        continue
      }
      if (h === "gone" || h === "error") {
        await this.loseBox(row.box_id, `Box ${row.box_id} is ${h}.`, false, { type: "lost", actor: { kind: "provider" }, reason: `The provider reports the box ${h} (a running turn went quiet).` })
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

    // Idle boxes too: one deleted in the provider's console has no turn to notice it. After the stalled turns, so
    // a box a running turn noticed first is recorded with that reason.
    await this.reconcileBoxes(RECONCILE_MS)

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
        await this.loseBox(box.id, "Box retired after being idle; workspaces are archived.", true, {
          type: "deleted",
          actor: { kind: "janitor" },
          reason: `Idle for ${Math.round((now - box.last_used_at) / 60_000)} min (Settings retires boxes after ${idleDelete} min); every workspace was archived.`,
        })
        await this.provider.destroy(box.id).catch(() => {})
      }
    }
    if (now - this.lastRetentionAt > 5 * 60_000) {
      this.lastRetentionAt = now
      await this.maintainRestingStorage(now)
    }
    await this.reclaimUnusedBoxes(now)
    await this.retryPendingSnapshots()
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
    await this.sweepGpuPods(now)
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

  /**
   * Drop boxes the provider no longer has (deleted in its console, or gone some other way): each is lost, with a box
   * history row, and its tasks restore from their archives (or a recap) on their next turn. A box missing from a
   * successful list is then asked about on its own, and only a definite "gone" drops it; an API error (network, 5xx,
   * timeout, auth) keeps every box. Runs at most every `maxAgeMs`; callers during a run share it.
   */
  reconcileBoxes(maxAgeMs = RECONCILE_LOOK_MS): Promise<void> {
    if (this.reconciling) return this.reconciling
    // The heavy mock dataset's boxes exist only in the database.
    if (this.stopped || this.c.mockHeavy || Date.now() - this.lastReconcileAt < maxAgeMs) return Promise.resolve()
    this.lastReconcileAt = Date.now()
    this.reconciling = this.reconcileNow().finally(() => (this.reconciling = null))
    return this.reconciling
  }

  private async reconcileNow() {
    const groups = new Map<BoxProvider, string[]>()
    for (const box of this.store.listBoxes()) {
      // Being created, deleted or resized: those paths own the box (it may not be in the list yet).
      if (box.status !== "ready" || this.boxOps.has(box.id)) continue
      const p = providerOf(this.provider, box.id)
      groups.set(p, [...(groups.get(p) ?? []), box.id])
    }
    for (const [p, ids] of groups) {
      let live: Set<string> | null = null
      if (p.liveIds) {
        try {
          live = new Set(await p.liveIds())
        } catch (err) {
          console.warn(`[box-yard] box reconcile skipped (${p.name}): ${errorMessage(err)}`)
          continue
        }
      }
      for (const id of ids) {
        if (live?.has(id)) continue
        // A list can lag or be cut short, so ask about the box itself before dropping it.
        if (!(await this.goneAtProvider(id))) continue
        const box = this.store.getBox(id)
        if (this.stopped || box?.status !== "ready" || this.boxOps.has(id)) continue
        await this.loseVanished(id, live ? "Missing from the provider's box list, and the provider says it's gone" : "The provider says the box is gone")
      }
    }
  }

  private async loseVanished(boxId: string, why: string) {
    console.log(`[box-yard] box ${boxId} no longer exists at the provider; dropping it`)
    await this.loseBox(boxId, `Box ${boxId} no longer exists at the provider.`, false, {
      type: "lost",
      actor: { kind: "provider" },
      reason: `${why} (deleted outside Box Yard, e.g. in the provider's console).`,
    })
  }

  /** The provider says the box doesn't exist. Errors and every other answer count as "still there". */
  private async goneAtProvider(boxId: string): Promise<boolean> {
    return (await providerOf(this.provider, boxId).health(boxId).catch(() => "unknown" as const)) === "gone"
  }

  /** Delete, Clear or Clean up on a box the provider no longer has: drop it from Box Yard's records instead of failing. */
  private async loseGoneBox(boxId: string, action: string, by: BoxActor = { kind: "owner" }) {
    const who = by.kind === "owner" ? this.owner() : by.kind === "coordinator" ? "the Coordinator" : by.kind === "captain" ? "a Captain" : "Box Yard"
    await this.loseBox(boxId, `Box ${boxId} no longer exists at the provider.`, false, {
      type: "lost",
      actor: { kind: "provider" },
      reason: `The provider no longer has the box (deleted outside Box Yard, e.g. in the provider's console); found when ${who} pressed ${action}.`,
    })
  }

  /**
   * A probe couldn't reach the box: ask the provider about it. Gone: it's dropped. Paused: that's why, and nothing is
   * wrong. Anything else: the Boxes page says it isn't answering and shows its numbers as stale.
   */
  private async markUnreachable(boxId: string) {
    if (!this.store.getBox(boxId) || this.unreachable.has(boxId) || this.checkingReach.has(boxId)) return
    this.checkingReach.add(boxId)
    try {
      const h = await providerOf(this.provider, boxId).health(boxId).catch(() => "unknown" as const)
      const box = this.store.getBox(boxId)
      if (this.stopped || box?.status !== "ready" || h === "paused") return
      if (h === "gone" && !this.boxOps.has(boxId)) return await this.loseVanished(boxId, "A probe couldn't reach the box, and the provider says it's gone")
      this.unreachable.set(boxId, Date.now())
      this.emitBoxes()
    } finally {
      this.checkingReach.delete(boxId)
    }
  }

  private markReachable(boxId: string) {
    if (this.unreachable.delete(boxId)) this.emitBoxes()
  }

  /**
   * A box is gone. Its tasks lose their folder and come back from archives elsewhere. `event` is its history row
   * (deleted by whom, or lost), written while the box's projects and tasks are still known.
   */
  private async loseBox(boxId: string, reason: string, quiet: boolean, event: Omit<BoxEventInput, "boxId">) {
    const box = this.store.getBox(boxId)
    if (!box) return
    this.recordBoxEvent({ boxId, ...event })
    this.store.setBoxStatus(boxId, "lost")
    this.store.setKv(boxOwnerKey(boxId), null)
    this.janitor.forget(boxId)
    this.diskCache.delete(boxId)
    this.unreachable.delete(boxId)
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

  /**
   * Write a box history row and send it to the UI. The box's name, size, projects and tasks come from its row as it
   * is now unless the caller passes them (a box already gone, or tasks already moved). Never throws: the history
   * must not break the box operation it describes.
   */
  recordBoxEvent(input: BoxEventInput): BoxEvent | null {
    try {
      const box = this.store.getBox(input.boxId)
      const projectRef = (id: string) => ({ id, name: this.store.getProject(id)?.name ?? id })
      const event = this.history.add({
        ...input,
        boxName: input.boxName ?? input.boxId,
        size: input.size !== undefined ? input.size : box ? normalizeBoxSize(box.size) : null,
        projects: input.projects ?? this.projectsOnBox(input.boxId).map(projectRef),
        taskIds: input.taskIds ?? this.store.listTaskRows({ boxId: input.boxId }).map((r) => r.id),
      })
      this.hub.broadcast({ type: "box.event", event })
      return event
    } catch (err) {
      console.warn(`[box-yard] box history: couldn't record ${input.type} of ${input.boxId}: ${errorMessage(err)}`)
      return null
    }
  }

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

  /**
   * What a new task stores as its route: only the explicit choices in create_task. Project routes, Settings and the
   * routing YAML's defaults/fallback are resolved every turn (agentSettings), so a later change still reaches it.
   */
  private initialRoute(input: { model?: string | null; effort?: Effort | null; routingRule?: string | null; routingReason?: string | null }) {
    return {
      model: input.model ?? null,
      effort: input.effort ?? null,
      routingRule: input.routingRule ?? null,
      routingReason: input.routingReason ?? null,
    }
  }

  /** Clear routes that older versions copied from the routing YAML onto task rows (#44), so Settings reaches those tasks again. */
  private forgetCopiedRoutes() {
    const config = loadRouting(this.c.dataDir, this.settings.get()).config
    if (!config) return
    for (const row of this.store.listTaskRows()) {
      const project = this.store.getProject(row.project_id)
      if (!project || !isCopiedDefaultRoute(config, project, row)) continue
      this.store.updateTask(row.id, { model: null, effort: null, routingRule: null, routingReason: null }, { quiet: true, touch: false })
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

/** What Clean up / Clear answer for a box the provider no longer has: nothing to do, and Box Yard dropped it. */
function goneCleanup(boxId: string, reason: BoxCleanup["reason"]): BoxCleanup {
  const now = Date.now()
  return { boxId, reason, status: "done", startedAt: now, finishedAt: now, targetFreeBytes: null, freeBefore: null, freeAfter: null, totalBytes: null, freedBytes: 0, steps: [], enough: true, error: null }
}

/** The created event's detail for a project's new box: from its snapshot, or cold despite one. */
function createdDetail(made: { from: ProjectSnapshot | null; cold: string | null }, projectName?: string): string | null {
  if (made.from) return `From ${projectName ?? "the project"}'s snapshot ${made.from.id}, taken from box ${made.from.boxId} (${made.from.size}).`
  return made.cold ? `Started cold: ${made.cold}.` : null
}

/** The turn this launch was for is no longer the task's (its start timed out, or it was reset): leave the task alone. */
class TurnSuperseded extends Error {
  constructor() {
    super("turn superseded")
  }
}

class StoppedBeforeStart extends Error {
  /** `cancelled`: not a Stop, Cody cancelled every queued message the turn was for. */
  constructor(readonly cancelled = false) {
    super("stopped before start")
  }
}
