import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { BoxRow, QueuedInputRow, Store, TaskRow, TurnFlags } from "./store.js"
import { BadRequestError, ConflictError, NotFoundError, cloneUrl, githubSlug, boxRowCost, meterTick, normalizeBoxSize, sourceOf, taskAgentCli } from "./store.js"
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
  prStatusLine,
  mergeRequestPrompt,
  recapPrompt,
  recapWorkspaceNote,
  workerSystemPrompt,
  type BoxPromptInfo,
  type DirectoryEntry,
} from "./prompts.js"
import type { Uploads, StoredUpload } from "./uploads.js"
import { BOX_SIZES, DEFAULT_MODEL, RESTING_STATUSES, SIZE_DEFAULTS, isFinalPrState, type Attachment, type BoxContents, type BoxInfo, type BoxOperation, type BoxSize, type CaptainMessage, type Effort, type PrState, type PreviewLink, type Project, type PushState, type QueuedMessage, type QueuedSender, type SendNowDelivery, type Task, type TaskStatus, type WaitFix, type WaitFor, type BoxFanout, type CloudBox, type CloudSpend, type CloudStatus } from "../shared/types.js"
import { agentRefs, boxBlockReason, limitBlock, localBlockReason, named, type BoxAgent } from "./agentLimits.js"
import { autocompactFlag, noteBudgetOf, type SettingsStore } from "./settings.js"
import { budgetNotes } from "../shared/notes.js"
import { MAX_NOTE_CHARS } from "./notes.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { cloudSpend, localDay, raiseToday, startOfLocalDay, usd } from "./cloudLimit.js"
import { userMessageLabel } from "../shared/sender.js"
import { AGENT_CAPTAIN_LIMIT, AGENT_CAPTAIN_WAIT_MAX_SECONDS, AGENT_CAPTAIN_WINDOW_MS, forwardedFromTask, type ForwardedFromTask } from "../shared/captain.js"
import type { AgentCaptainMessage } from "./captains.js"
import { formatTokens } from "./usage.js"
import { errorMessage, failedStep, isRateLimited } from "./util/retry.js"
import { isUploadTooBig, putFile, uploadSize } from "./upload.js"
import { capReply, preview } from "./replies.js"
import { AUTO_DONE_FROM, PrTracker, prNumber, restingStatus, type PrChange } from "./prs.js"
import { GithubRest, IssueCloser, restPrState } from "./mergeFollowUp.js"
import { prMark, quietAgentWake, taskTrigger, turnTrigger } from "./turnTrigger.js"
import { isCopiedDefaultRoute, loadRouting, resolveAgentRoute } from "./routing.js"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { isQuietRun, noopBlockers, type RunEvidence } from "../shared/quiet.js"
import { memoryPressure, type BoxMemory, type MemoryPolicy } from "../shared/memory.js"
import { cleanupSummary, dfCommand, diskLine, formatBytes, isOutOfSpace, parseDf, requiredFreeBytes, rootLow, type BoxCleanup, type CleanupStepKey, type DiskSpace } from "../shared/disk.js"
import { BoxJanitor, DEPS_DIR, pushedCheck, pushedVerdict } from "./janitor.js"
import { OWN_UPKEEP_MS, OwnCleanup } from "./ownCleanup.js"
import { atRisk, deleteCheckScript, deleteVerdict, parseDeleteCheck, refusalLine, refusalsOf, type BoxDeleteResult, type WorkspaceGit } from "./boxDelete.js"
import { GITHUB_HELPER, GIT_MARK, KEEP_STAGE_MARK, MIRROR_MARK, keepPackStages, cloneTaskScript, gitWithHelper, hydrateMirrorScript, keepPackScript, pruneMirrorsScript, relinkTaskScript, setHelperScript, syncMirrorScript, withMirrorLock, type MirrorSpec } from "./gitShare.js"
import type { HookTrigger } from "../shared/hooks.js"
import { LOCAL_BOX_ID, RUNNER_PHRASE, isLocalRunnerBox, type Runner } from "../shared/runner.js"
import type { TaskIconName } from "../shared/taskIcons.js"
import { parsePriority, queueOrder, type QueueEntry, type TaskPriority } from "../shared/priority.js"
import { MAX_GPU_PODS, gpuBoxId, gpuBoxIndex, gpuBoxProject, gpuPodLabel, isGpuBox, type RunPodSettings } from "../shared/runpod.js"
import { POD_HTTP_PORTS, shortGpu } from "./providers/runpod.js"
import { GPU_POD_NOUNS, GPU_PROVIDER_LABEL, GPU_SETTINGS_PATH, effectiveGpuProvider, globalGpuProviderSource, gpuBoxIdOn, gpuBoxProvider, type GpuProvider } from "../shared/gpu.js"
import { DOCKER_MAX_TASKS, DOCKER_NEEDS_CLAUDE_KEY, DOCKER_NEEDS_CODEX_KEY, dockerBoxId, dockerBoxProject, dockerLabel, isDockerBox, type DockerSettings } from "../shared/docker.js"
import { CODEX_ON_MACHINES, isMachineBox, labelPhrase, machineBoxId, machineLabel, machineMatches, machineOfBox, normalizeLabel, pickMachine, type Machine, type MachineCandidate, type MachinePick } from "../shared/machines.js"
import type { DockerContainerState } from "./providers/docker.js"
import { SleepWatch, sleepLength } from "./sleep.js"
import { CLAUDE_CREDENTIAL_VARS, CODEX_CREDENTIAL_VARS, GIT_AUTHOR_VARS, GLOBAL_CREDENTIALS, codexTurnLogin, credentialSet, identityHomeEnv, ownGithubToken, turnEnv, type CodexTurnLogin, type TurnEnv } from "./turnCredentials.js"
import { authorEnv, chooseAuthor, fallbackWarning, GithubAuthors, hostGitScript, parseHostGit, readHostGit, recordAuthorSource, type HostGit, type TurnAuthor } from "./gitAuthor.js"
import { AGENT_CLI_LABEL, cliForModel, codexModel, isOpenAiModel, type AgentCli } from "../shared/agentCli.js"
import type { Identities, TurnSigning } from "./identity/identities.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { BOX_GIT_CREDENTIAL_SCRIPT } from "./providers/upstash.js"
import { BoxHistory, type BoxEventInput } from "./boxHistory.js"
import { TurnMeter, type MeasuredTurn } from "./turnPeaks.js"
import { turnTiming } from "./turnTimings.js"
import type { TurnClockReading } from "../shared/turnTimings.js"
import { pickAutoSize, type ProjectAutoSize, type TurnPeak } from "../shared/autoSize.js"
import type { BoxActor, BoxEvent } from "../shared/boxHistory.js"
import type { BoxPick } from "../shared/placement.js"
import { SNAPSHOT_STEP_LABELS, snapshotSkipReason, type ProjectSnapshot, type SnapshotInitiator, type SnapshotJob, type SnapshotStep } from "../shared/snapshots.js"
import { SCRATCH_MARKER, depsSaveScript, depsSaveSummary, stripCounts, stripScript, stripSummary } from "./boxSnapshot.js"
import { TURN_SH, parseRunRecord, parseTurnProbe, turnKillScript, turnProbeScript, whileTurnRuns, type TurnProbe } from "./turnProcess.js"
import {
  compareSizes,
  initiatorLabel,
  resizeSummary,
  resizeTitle,
  BOX_SIZE_SPECS,
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
const RESIZE_STEP_NAMES: Record<ResizeStep["key"], string> = { stop: "stop tasks", resize: "resize", create: "create", archive: "archive", move: "move", delete: "destroy" }

const RUNNER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/box-runner.mjs")
const RUNNER_FALLBACK = path.resolve(process.cwd(), "runner/box-runner.mjs")

/** Statuses a task can sit in between turns. */
const RESTING: TaskStatus[] = [...RESTING_STATUSES]
/** A task that takes one of its box's agent slots: a turn id, or starting/working (the same rule as Store.slotsInUse). */
/** A task row's place in the queue (shared/priority.ts): its priority, and when it last joined (last_active_at). */
const queueEntry = (r: TaskRow): QueueEntry => ({ priority: parsePriority(r.priority), queuedAt: r.last_active_at })

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
/** A local task waits with this while every Settings › Tasks running at once on this computer slot is taken. */
const LOCAL_SLOT_WAIT = "Waiting for a free slot on this computer (Settings › Tasks running at once on this computer)"

/** Why a task waits (the text, without "Waiting" for a box's) and the tasks it names as holding it back (Task.waitFor). */
interface Wait {
  text: string
  by: WaitFor[]
}
const asWait = (text: string | null): Wait | null => (text ? { text, by: [] } : null)
/** The tasks a reason names (agentRefs: the first two, then "and N more"). */
const waitFor = (agents: BoxAgent[]): WaitFor[] => named(agents).map((a) => ({ taskId: a.taskId, title: a.title }))
/**
 * The shortest usage interval meterBoxes writes. CPU counters are read about once a minute, so finer rows would only
 * make the cloud spend sums (placement asks often) slower.
 */
const METER_MIN_MS = 15_000
/** How long a cloud spend reading serves placement before it's summed again. */
const CLOUD_SPEND_CACHE_MS = 5_000
/** The cloud meter's $/hour is the boxes' spend over this window, as an hourly rate. */
const CLOUD_RATE_WINDOW_MS = 15 * 60_000
/** kv: the day and limits the cloud spend notices were last posted for ({ day, warned, reached }). */
const CLOUD_NOTICED_KEY = "cloud_limit_noticed"
/** kv: until when (ms since epoch) Cody allowed more new boxes than the hour's free ones (allowMoreBoxes). */
const FANOUT_ALLOWED_KEY = "box_fanout_allowed_until"
/** How long an OK for more boxes lasts, and the window the free ones are counted over. */
const FANOUT_WINDOW_MS = 60 * 60_000
/** The fan-out question is posted at most this often while boxes wait on it. */
const FANOUT_NOTICE_MS = 30 * 60_000
const gpuSlotWait = (kind: GpuProvider) => `Waiting for a free slot on its project's GPU pod (its Tasks running at once, or ${GPU_SETTINGS_PATH[kind]} › Tasks running at once per pod)`
/** Where a GPU project's $/hr cap is raised, for the wait reason. */
/** Why a GPU task waits when its cloud has no key. */
const GPU_NOT_SET_UP: Record<GpuProvider, string> = {
  runpod: "Waiting: RunPod GPU isn't set up (add a RunPod API key in Settings › RunPod GPU)",
  vast: "Waiting: Vast.ai GPU isn't set up (add a Vast.ai API key in Settings › Credentials)",
  daytona: "Waiting: Daytona isn't set up (add a Daytona API key in Settings › Daytona)",
}
const gpuCapHow = (kind: GpuProvider) => `raise it in Project › Settings › Boxes or with update_project gpu_max_hourly_usd; ${GPU_SETTINGS_PATH[kind]} › Max per project is the default`
/** How often Box Yard touches an idle GPU pod's heartbeat, so its own watchdog only fires when Box Yard is gone. */
const GPU_HEARTBEAT_MS = 5 * 60_000
const DOCKER_SLOT_WAIT = "Waiting for a free slot in its project's Docker container (its Tasks running at once, or Settings › Docker › Tasks running at once per container)"
/** How often maintain() asks an SSH machine that didn't answer whether it's back. */
const MACHINE_RECHECK_MS = 60_000

/**
 * The runners whose boxes aren't pool boxes: a project's own RunPod GPU pods (`runpod-<projectId>[-<n>]`) and Docker
 * container, and Cody's SSH machines (`ssh-<machineId>`, shared by every project that runs there).
 */
type OwnRunner = "gpu" | "docker" | "ssh"
/** How placement's log lines name a project's own boxes (toOwnBox, fromOwnBox). */
const OWN_BOX: Record<OwnRunner, { asked: string; projectNow: string; to: string; from: string; stays: string; at: (boxId: string) => string }> = {
  gpu: {
    asked: "It was asked to run on a RunPod GPU pod",
    projectNow: "Its project runs on a RunPod GPU pod now",
    to: "the GPU pod",
    from: "on the GPU pod",
    stays: "on its project's GPU pod",
    at: (boxId) => `its project's GPU pod #${gpuBoxIndex(boxId)}`,
  },
  docker: {
    asked: "It was asked to run in a Docker container",
    projectNow: "Its project runs in a Docker container now",
    to: "its Docker container",
    from: "in its Docker container",
    stays: "in its project's Docker container",
    at: () => "its project's Docker container",
  },
  // TaskManager.ownAt names the machine.
  ssh: {
    asked: "It was asked to run on an SSH machine",
    projectNow: "Its project runs on SSH machines now",
    to: "an SSH machine",
    from: "on its SSH machine",
    stays: "on its SSH machine",
    at: (boxId) => `SSH machine ${machineOfBox(boxId)}`,
  },
}
const ownRunnerOf = (boxId: string | null | undefined): OwnRunner | null =>
  isGpuBox(boxId) ? "gpu" : isDockerBox(boxId) ? "docker" : isMachineBox(boxId) ? "ssh" : null
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
/** How often the idle-box sweep retries a workspace archive that failed, before the box may be deleted. */
const IDLE_ARCHIVE_RETRY_MS = 10 * 60_000
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
  /** Tests: this computer's global git config as a Docker turn's author reads it (default: the server's own). */
  hostGit?: () => Promise<HostGit | null>
  /** RunPod GPU pods (Runs on: GPU), when this install has the runner. */
  gpu?: GpuRunner | null
  /** Vast.ai GPU instances (Runs on: GPU, for projects on Vast.ai), when this install has the runner. */
  vast?: GpuRunner | null
  /** Daytona sandboxes (Runs on: GPU, for projects on Daytona), when this install has the runner. */
  daytona?: GpuRunner | null
  /** Docker containers on this computer (Runs on: Docker container), when this install has the runner. */
  docker?: DockerRunner | null
  /** Cody's SSH machines (Runs on: SSH machine), when this install has the runner. */
  machines?: MachineRunner | null
  identities: Identities
}

/** What TaskManager needs of the SSH machines (server/machines/service.ts). */
export interface MachineRunner {
  list(): Machine[]
  get(id: string): Machine | null
  /** Why tasks can't run on it now (off, untested, failed test, didn't answer lately), or null. */
  problem(m: Machine): string | null
  /** Ask the machines that didn't answer lately again; resolves true when one is back. */
  recheck(olderThanMs: number): Promise<boolean>
}

/** What TaskManager uses of the Docker containers' provider: DockerProvider, or FolderDockerProvider (mock mode, tests). */
export type DockerBoxProvider = BoxProvider & {
  /** This install's containers (and volumes left without one), from Docker; cached a few seconds unless `fresh`. */
  list(fresh?: boolean): Promise<DockerContainerState[]>
  /** The containers as last listed (no Docker call). */
  cached(): DockerContainerState[]
  /** Stop a container; its volume keeps every workspace. */
  stop(boxId: string): Promise<void>
}

/** What TaskManager needs of the Docker runner (server/docker/service.ts). */
export interface DockerRunner {
  provider: DockerBoxProvider
  settings(): DockerSettings
  /** Why containers can't start now (Docker missing or stopped), or null. */
  problem(): Promise<string | null>
}

/** A GPU cloud's pod as TaskManager reads it, in RunPod's words (Vast.ai's instances and Daytona's sandboxes are mapped to them). */
export interface GpuPod {
  id: string
  status: string
  /** $/hr. */
  cost?: number
  gpu?: { id?: string } | null
  dataCenterId?: string | null
  startedAt?: string | null
}

/** What TaskManager uses of a GPU cloud's provider: RunPodProvider, VastProvider, DaytonaProvider, or a stand-in in tests. */
export type GpuPodProvider = BoxProvider & {
  /** This install's pods, cached for a few seconds unless `fresh`. */
  listPods(fresh?: boolean): Promise<{ boxId: string; pod: GpuPod }[]>
  /** The pod as last listed (no API call). */
  cached(boxId: string): GpuPod | null
  /** The cheapest GPU a new pod of the project would get under its cap, or null when none fits. */
  nextPodPrice(projectId: string): Promise<{ gpu: string; usd: number } | null>
  /** The project's $/hr cap on its pods together (0: none of its own). */
  capOf(projectId: string): number
}
type GpuPods = { boxId: string; pod: GpuPod }[]

/** What TaskManager reads of a GPU cloud's settings (Settings › RunPod GPU, Settings › Vast.ai GPU, Settings › Daytona). */
export type GpuRunnerSettings = Pick<RunPodSettings, "agentsPerPod" | "idleMinutes" | "maxHourlyUsd" | "totalMaxHourlyUsd" | "gpuTypes" | "minRamGb" | "minVcpus"> & {
  /** RunPod only: Secure or Community Cloud. */
  cloud?: RunPodSettings["cloud"]
  /** Vast.ai and Daytona only: GPU projects without a cloud of their own run there (Daytona's wins when both are on). */
  defaultForGpu?: boolean
}

/** What TaskManager needs of a GPU runner: RunPod's (server/runpod/service.ts), Vast.ai's (server/vast/service.ts) or Daytona's (server/daytona/service.ts). */
export interface GpuRunner {
  /** Which cloud; unset is RunPod (test stand-ins). */
  kind?: GpuProvider
  provider: GpuPodProvider
  settings(): GpuRunnerSettings
  /** Its API key is set. */
  enabled(): boolean
  /** The owner asked to keep this box's pod up until then, even idle (ms since epoch), or null. */
  keepWarmUntil(boxId: string): number | null
  /**
   * Its pods count toward Settings › Usage › Daily cloud limit (recorded as box usage at their $/hr each minute), and
   * no new one starts while a cloud limit is reached. Daytona's; RunPod and Vast.ai have only their $/hr caps.
   */
  metered?: boolean
}

/** How prepareWorkspace set a task's folder up. `fallback`: its archive couldn't be restored, so it was cloned fresh. */
interface PreparedWorkspace {
  restored: boolean
  branch?: "origin" | "base"
  fallback?: { reason: string; wip: boolean }
}

/**
 * "on box local-1a2b", or "on this computer" for the local runner: where a task's log says its workspace is. An SSH
 * machine's name comes from TaskManager.onBox.
 */
const onBox = (boxId: string, machine?: string) =>
  isLocalRunnerBox(boxId)
    ? "on this computer"
    : isGpuBox(boxId)
      ? `on its project's GPU pod #${gpuBoxIndex(boxId)}`
      : isDockerBox(boxId)
        ? "in its project's Docker container"
        : isMachineBox(boxId)
          ? `on SSH machine ${machine ?? machineOfBox(boxId)}`
          : `on box ${boxId}`

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
  /** With runsOn "ssh": the SSH machines it runs on, by label or machine name; null: any machine. */
  machineLabel?: string | null
  /** The CLI it runs on for good (Task.agentCli); omitted: what its model names, else its project's Agent, else Settings. */
  agentCli?: AgentCli | null
  /** Its icon (shared/taskIcons.ts); omitted picks one from its title. */
  icon?: TaskIconName | null
  /** "high" pulls its turns from the queue before normal tasks' (shared/priority.ts); omitted is normal. */
  priority?: TaskPriority | null
  /** Never moved to done when its PR merges (a long-running runner); omitted: the settings decide. */
  stayOpenOnMerge?: boolean
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
  /** task.finished: a quiet agent wake (server/turnTrigger.ts), which hooks skip unless they include agent wakes. */
  agentWake?: boolean
}
export type TaskEventListener = (event: TaskEvent) => void

/** Who pressed "Send now" (sendQueuedNow): Cody on the task page, or the Coordinator or a Captain over MCP. */
export type SendNowBy = "cody" | "coordinator" | "captain"

export interface SendNowResult {
  task: Task
  delivery: SendNowDelivery
  /** How many messages were queued (not yet claimed by a turn) when it was asked. */
  queued: number
}

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

/** What a retried turn keeps of the turn it retries: its trigger and the PR as that turn began. */
const carriedTrigger = (flags: TurnFlags): Pick<TurnFlags, "trigger" | "prBefore"> =>
  flags.trigger ? { trigger: flags.trigger, ...(flags.prBefore !== undefined ? { prBefore: flags.prBefore } : {}) } : {}

/** Task-message meta for a Captain's message, so the transcript can say which Captain steered the task. */
const captainMeta = (store: Store, projectId: string) => ({ source: "captain", captainProjectId: projectId, captainName: store.getProject(projectId)?.name ?? null })

/** kv key for the box a project's work goes to first. */
const projectBoxKey = (projectId: string) => `project_box:${projectId}`
/** kv key for the project a box was created for. */
const boxOwnerKey = (boxId: string) => `box_owner:${boxId}`
/** The credential set (turnCredentials.ts) a pool box's workspaces were made with; none means the global one. */
const boxCredsKey = (boxId: string) => `box_creds:${boxId}`
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
  /** Closes the issues a merged PR names (server/mergeFollowUp.ts). */
  readonly issues: IssueCloser
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
  /**
   * Box creation backoff timings, and its pace: at most `paceCreates` creates start in any `paceWindowMs` (5 a
   * minute), and the scheduler makes up to `freePerHour` boxes an hour on its own before the rest wait on Cody's OK.
   * Tests change them.
   */
  readonly boxCreateTuning = { retryBaseMs: 2_000, retryMaxMs: 60_000, rateLimitMs: 10_000, paceCreates: 5, paceWindowMs: 60_000, freePerHour: 15 }
  /** When each of the scheduler's box creates in the last hour started: the pace and the fan-out question count them. */
  private createStarts: number[] = []
  /** A pass to run when the pace lets the next create start. */
  private paceTimer: NodeJS.Timeout | null = null
  /** New boxes the queue wants past the hour's free ones (they wait on allowMoreBoxes), what they'd cost, and when the question was last posted. */
  private fanout = { wanted: 0, upToHourlyUsd: 0, noticedAt: 0 }
  /** Tasks that wait for those boxes: their wait reason says so, with the "allow-boxes" fix. */
  private fanoutHeld = new Set<string>()
  /**
   * Placement: another project's box idle this long (no turn, every workspace archived, nothing of its projects
   * waiting) is given to a project that needs one rather than a new box being made. Tests change it.
   */
  readonly placementTuning = { reuseIdleMs: 5 * 60_000 }
  /** How pickBox picked the box it just returned for a task, for `assign` to keep (Task.placement.now.how). */
  private pickedHow = new Map<string, BoxPick>()
  /** New boxes and the tasks that were waiting when each was made: one of them landing there is on a "new box". */
  private madeFor = new Map<string, Set<string>>()
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
  /** Idle boxes kept past Settings › Idle box deletion because a workspace on them isn't archived yet: why. */
  private idleHeld = new Map<string, string>()
  /** When the idle sweep may retry each task's failed archive (retryIdleArchives). */
  private idleArchiveRetryAt = new Map<string, number>()
  private cloudCache: { at: number; key: string; spend: CloudSpend } | null = null
  /** Frees disk on low boxes in graduated steps (server/janitor.ts). */
  readonly janitor: BoxJanitor
  /** Cleans task folders on this computer and SSH machines, which the janitor never sees (server/ownCleanup.ts). */
  readonly ownCleanup: OwnCleanup
  private lastOwnUpkeepAt = 0
  /** Every box lifecycle event and who did it (server/boxHistory.ts); write it with recordBoxEvent. */
  readonly history: BoxHistory
  /** Who asked for the disk cleanup running on a box ("manual" runs: Cody's button or the Coordinator's tool). */
  private cleanupBy = new Map<string, BoxActor>()
  /** Latest df per box, so a scheduling pass doesn't run df for every task. */
  private diskCache = new Map<string, { at: number; space: DiskSpace }>()
  /** Auto-sizing: what each running turn uses on its Upstash box, from the probes (server/turnPeaks.ts). */
  private meter = new TurnMeter()
  /** Auto-sizing: each project's measured turns (table turn_peaks), read once and dropped when another lands. */
  private turnPeakCache = new Map<string, TurnPeak[]>()
  /** Running turns' server side, for their timings (turn_timings): when they were asked for and launched, by turn id. */
  private turnLaunches = new Map<string, { requestedAt: number | null; launchedAt: number; trigger: string | null; model: string | null; effort: string | null; resumed: boolean }>()
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
  /** The GitHub account behind each token, as a turn's author (null: mock mode with no fake GitHub). */
  private readonly githubAuthors: GithubAuthors | null
  /** GitHub's fetch (the seam), or null in mock mode with no fake GitHub. */
  private readonly githubFetch: typeof fetch | null
  /** The token Box Yard itself asks GitHub with about a project's PRs and issues (null: mock mode, or none). */
  private readonly githubTokenFor: (projectId: string) => string | null
  private readonly hostGit: () => Promise<HostGit | null>
  /** Tests: the token a fake GitHub gets when a turn has none of its own. */
  private readonly githubTokenSeam: ((projectId: string) => string | null) | undefined
  /** Tasks whose log already says their commits go out under the fallback author. */
  private authorWarned = new Set<string>()
  /** Tasks whose setup already hit a full disk once; the next one fails for good. */
  private diskRetried = new Set<string>()
  /** Tasks holding for a cleanup on the box their workspace lives on, after running out of space there. */
  private diskHold = new Map<string, string>()
  private lowDiskNoticeAt = new Map<string, number>()
  /** Called after every notice; return true when another owner handled delivery. */
  onNotice: ((content: string, meta: Record<string, unknown> | null, opts: NoticeOptions) => boolean | void) | null = null
  /** Hands an agent's message_captain to its project's Captain (CaptainManager.fromAgent); null when there are no Captains. */
  onCaptainMessage: ((projectId: string, input: AgentCaptainMessage) => { message: CaptainMessage; heldUntil: number | null }) | null = null
  /** Cody's message from a task's chat to its project's Captain (app.ts: CaptainManager.send, source "cody"). */
  onForwardToCaptain: ((projectId: string, content: string, attachments: StoredUpload[], viaTask: ForwardedFromTask) => CaptainMessage) | null = null
  /**
   * Why a task can't be pinned to a runner right now (Setup.runnerProblem), or null when it can. Unset: always can.
   * `key` says whether the task's turns would have a key for `cli` (turnCredentials, codexCredentials); undefined: the global one.
   */
  runnerProblem: ((runner: Runner, key?: boolean, cli?: AgentCli, gpuCloud?: GpuProvider) => Promise<string | null>) | null = null
  /** Agents waiting mid-turn for their Captain's reply, by task. */
  private captainWaits = new Map<string, CaptainWait[]>()
  /** RunPod GPU pods, or null when this install has no GPU runner. */
  private readonly gpu: GpuRunner | null
  /** Vast.ai GPU instances, or null when this install doesn't have that runner. */
  private readonly vast: GpuRunner | null
  /** Daytona sandboxes, or null when this install doesn't have that runner. */
  private readonly daytona: GpuRunner | null
  /** When each GPU pod's heartbeat was last touched by the idle sweep, and when the sweep last ran. */
  private gpuTouchedAt = new Map<string, number>()
  /** Pods stopGpuPod is terminating, with the provider's own line about it once it came (one history row, not two). */
  private gpuTerminating = new Map<string, string | null>()
  private lastGpuSweepAt = 0
  /** Each cloud's pods as placement or the sweep last listed them, for list_projects (which doesn't call the clouds). */
  private gpuSeenBy = new Map<GpuProvider, GpuPods>()
  /** Tasks whose Captain heard why they wait for a GPU pod (a $/hr cap), by the kind of wait: a notice once. */
  private gpuWaitNoticed = new Map<string, string>()
  /** Docker containers on this computer, or null when this install has no Docker runner. */
  private readonly docker: DockerRunner | null
  /** Project identities: every GitHub token, Claude login and git author a turn, clone, push or PR check uses. */
  readonly identities: Identities
  private lastDockerSweepAt = 0
  /** Tasks whose Captain heard why they wait for Docker (missing or stopped), by the reason: a notice once. */
  private dockerWaitNoticed = new Map<string, string>()
  /** Cody's SSH machines, or null when this install has no SSH runner. */
  private readonly machines: MachineRunner | null
  /** Tasks whose Captain heard why they wait for an SSH machine, by the kind of wait: a notice once. */
  private machineWaitNoticed = new Map<string, string>()
  private lastMachineRecheckAt = 0
  /** The task event bus hooks listen on (see subscribe). */
  private readonly listeners = new Set<TaskEventListener>()

  constructor(deps: TaskManagerDeps) {
    this.gpu = deps.gpu ?? null
    this.vast = deps.vast ?? null
    this.daytona = deps.daytona ?? null
    this.docker = deps.docker ?? null
    this.machines = deps.machines ?? null
    this.identities = deps.identities
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
    const githubFetch = deps.github?.fetch ?? (this.c.mock ? null : fetch)
    this.githubFetch = githubFetch
    this.githubAuthors = githubFetch ? new GithubAuthors(githubFetch) : null
    this.hostGit = deps.hostGit ?? (() => readHostGit())
    this.githubTokenSeam = deps.github?.token
    this.githubTokenFor = deps.github?.token ?? ((projectId) => (this.c.mock ? null : this.githubToken(projectId) || null))
    this.prs = new PrTracker({
      store: deps.store,
      token: this.githubTokenFor,
      fetch: deps.github?.fetch,
      onChange: (change) => this.prChanged(change),
      autoDone: (row) => this.autoDoneOnMerge(row) && !this.mergeDoneBlocker(row),
      log: (msg) => console.warn(msg),
    })
    this.issues = new IssueCloser({
      store: deps.store,
      fetch: githubFetch,
      token: this.githubTokenFor,
      enabled: (projectId) => this.closeIssuesOnMerge(projectId),
      event: (taskId, text) => {
        this.addEvent(taskId, text, { kind: "issues_closed" })
        this.emitTask(taskId)
      },
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
      installRunner: (boxId) => this.installCleanupRunner(boxId),
      hasFreshArchive: (row) => this.hasFreshArchive(row),
      archive: (taskId) => this.archiveFresh(taskId),
      archiveProblem: (taskId) => this.archiveProblem(taskId),
      park: (taskId, boxId, note) => this.park(taskId, boxId, withOwner(note, this.owner())),
      dropPushed: (taskId, boxId) => this.dropPushed(taskId, boxId),
      pushedOnGitHub: (taskId, boxId) => this.pushedOnGitHub(taskId, boxId),
      mirrorsToKeep: (boxId, owner) => this.mirrorsToKeep(boxId, owner),
      finished: (report) => this.cleanupFinished(report),
    })
    this.ownCleanup = new OwnCleanup({
      store: this.store,
      provider: this.provider,
      settings: () => {
        const s = this.settings.get()
        return { foldersKept: s.localFoldersKept, buildCleanup: s.localBuildCleanup, buildCleanupIdleHours: s.localBuildCleanupIdleHours, minFreeGb: s.localDiskMinFreeGb }
      },
      stopped: () => this.stopped,
      probe: (boxId) => this.probeDisk(boxId, 0),
      taskDir: (boxId, taskId) => this.taskDir(boxId, taskId),
      installRunner: (boxId) => this.installCleanupRunner(boxId),
      wantsTurn: (row) => this.wantsTurn(row),
      occupied: (taskId) => this.archiving.has(taskId) || this.janitor.isBusy(taskId),
      // A folder on this computer gets an archive only when it's about to leave (forMove), as here.
      archive: (taskId) => this.archive(taskId, { forMove: true }),
      hasFreshArchive: (row) => this.hasFreshArchive(row),
      park: (taskId, boxId, note) => this.park(taskId, boxId, note),
      dropPushed: (taskId, boxId) => this.dropPushed(taskId, boxId),
      where: (boxId) => (isMachineBox(boxId) ? `SSH machine ${this.machineName(boxId)}` : "this computer"),
    })
  }

  /** Put the current runner on a box for a cleanup's `clean` step; returns its path. */
  private async installCleanupRunner(boxId: string): Promise<string> {
    const runnerPath = `${this.provider.root(boxId)}/.boxyard/box-runner.mjs`
    const source = this.runnerSource()
    // Only when it changed: a full disk can't take the write, and cleanup has to work then.
    const sum = createHash("sha256").update(source).digest("hex")
    const current = await this.provider.exec(boxId, `sha256sum ${q(runnerPath)} 2>/dev/null | cut -c1-64`).catch(() => null)
    if (current?.stdout.trim() !== sum) await this.provider.writeFile(boxId, runnerPath, source)
    return runnerPath
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
    const upgraded = this.settings.upgradeForCloudLimit()
    if (upgraded.length) {
      const env = process.env.BOX_POOL_MAX ? ` BOX_POOL_MAX=${process.env.BOX_POOL_MAX} in Box Yard's environment still sets the ceiling; remove it to use Settings.` : ""
      this.notice(
        withOwner(
          `⚙️ **Box limits** changed: boxes are made as work needs them, and a daily cloud limit keeps spend in check. ${upgraded.join("; ")}. Cody can change both in Settings.${env}`,
          this.owner(),
        ),
        { kind: "cloud_limit" },
        { coordinator: true },
      )
    }
    this.timers.push(setInterval(() => void this.poll(), this.c.pollMs))
    this.timers.push(setInterval(() => void this.maintain(), 20_000))
    this.doneMergedResting()
    this.publishDirectory()
    void this.cleanupOrphanBoxes()
    this.prs.start()
    // Merges whose issues were still being closed when Box Yard stopped.
    void this.issues.run()
    this.sleep.start(5_000, (gap) => {
      console.log(`[box-yard] this computer slept for ${Math.round(gap.ms / 1000)}s`)
      // PRs may have been merged meanwhile, and requests that failed while asleep backed the tracker off.
      this.prs.wake()
    })
    this.schedule()
  }

  stop() {
    this.stopped = true
    this.prs.stop()
    this.sleep.stop()
    for (const t of this.timers) clearInterval(t)
    if (this.emitBoxesTimer) clearTimeout(this.emitBoxesTimer)
    if (this.directoryTimer) clearTimeout(this.directoryTimer)
    if (this.paceTimer) clearTimeout(this.paceTimer)
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
    const running: TaskRow[] = []
    for (const row of this.store.listTaskRows({ status: ["working"] })) {
      if (!row.box_id || !row.current_turn_id) {
        this.store.updateTask(row.id, { status: "queued", currentTurnId: null })
        continue
      }
      this.lastEventAt.set(row.id, Date.now())
      running.push(row)
    }
    for (const box of this.store.listBoxes()) {
      // A box that was mid-creation when we died may exist without us knowing its id.
      if (box.status === "creating") this.store.removeBox(box.id)
    }
    for (const row of running) void this.reattach(row).catch((err) => console.warn(`[box-yard] re-attaching ${row.id}: ${errorMessage(err)}`))
  }

  /**
   * After a restart, a turn that was running. Its process still running (the pid, boot and start time its run record
   * names): Box Yard picks it back up, polling from the saved cursor, and the turn ends as usual. Its process gone (it
   * died or finished while Box Yard was down, or the machine or box restarted): what it wrote is read, and a turn
   * still open after that is interrupted, queued to carry on in the same session. A box that can't be asked right
   * now (paused, unreachable) is held open and left to maintain(), as for any quiet turn.
   */
  private async reattach(row: TaskRow) {
    const { box_id: boxId, current_turn_id: turnId } = row
    if (!boxId || !turnId) return
    const health = isLocalRunnerBox(boxId) ? "running" : await this.provider.health(boxId).catch(() => "unknown" as const)
    const probe = health === "running" ? await this.turnProcess(boxId, row.id).catch(() => null) : null
    const fresh = this.store.getTaskRow(row.id)
    if (this.stopped || !fresh || fresh.current_turn_id !== turnId) return
    // Settled here, not by the hold stream (which would end at once and call it a crash).
    if (probe && !probe.alive) return this.turnGone(fresh, "Box Yard restarted and the agent's process had stopped meanwhile (this computer or its box may have restarted)")
    this.holdOpen(row.id, boxId)
    if (probe?.alive) this.addEvent(row.id, "Box Yard restarted and picked this turn back up; the agent kept working.", { kind: "reattached" })
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
   * With the task's project (and its own env), a Claude key its turns would get counts (a Docker container needs one).
   */
  async requireRunner(
    runner: Runner | null | undefined,
    projectId?: string,
    taskEnv: Record<string, string> = {},
    agent?: { agentCli?: AgentCli | null; model?: string | null; machineLabel?: string | null },
  ): Promise<void> {
    if (!runner || !this.runnerProblem) return
    const project = projectId ? this.store.getProject(projectId) : null
    // The CLI the task runs on decides which key counts: a Codex task needs a Codex login, not a Claude one.
    const cli = project ? this.agentCliFor(agent ?? {}, project) : (agent?.agentCli ?? this.settings.get().agentCli)
    const key = !project ? undefined : cli === "codex" ? this.codexCredentials(project.id, taskEnv).kind !== null : this.turnCredentials(project.id, taskEnv).claudeFrom !== null
    const problem = await this.runnerProblem(runner, key, cli, project && runner === "gpu" ? this.gpuCloudOf(project.id) : undefined)
    if (problem) throw new BadRequestError(`Can't run it on ${RUNNER_PHRASE[runner]}: ${problem}.`)
    // A label no machine has is a typo, not a wait: busy, offline or switched-off machines with it are waited for.
    const label = agent?.machineLabel ?? null
    const machines = this.machines?.list() ?? []
    if (runner === "ssh" && label && this.machines && !machines.some((m) => machineMatches(m, label))) {
      const labels = [...new Set(machines.flatMap((m) => m.labels))].sort()
      throw new BadRequestError(
        `Can't run it on ${labelPhrase(normalizeLabel(label))}: no SSH machine has that label or name (${labels.length ? `labels: ${labels.join(", ")}` : "none has a label yet"}). Label one in Settings › Machines, or with update_machine.`,
      )
    }
  }

  /** Throws a clear 400 when the project's identity doesn't allow `runner` (Identity.runners). */
  private requireIdentityRunner(projectId: string, runner: Runner) {
    const problem = this.identities.runnerProblem(this.identities.idOf(projectId), runner)
    if (problem) throw new BadRequestError(`Can't run it on ${RUNNER_PHRASE[runner]}: ${problem}.`)
  }

  /**
   * Pin a task to a runner from its next turn on (send_to_task runs_on). Placement moves its workspace there when
   * nothing would be lost (toLocal / fromLocal), else it stays where it is and its log says why. Check with
   * requireRunner first.
   */
  setRunsOn(taskId: string, runner: Runner, machineLabel: string | null = null) {
    const row = this.requireRow(taskId)
    const label = runner === "ssh" ? normalizeLabel(machineLabel) : null
    if (row.runs_on === runner && (row.machine_label ?? null) === label) return
    this.requireIdentityRunner(row.project_id, runner)
    this.store.updateTask(row.id, { runsOn: runner, machineLabel: label })
    const where = runner === "ssh" ? labelPhrase(label) : RUNNER_PHRASE[runner]
    this.addEvent(row.id, `Runs on ${where} from its next turn on (this task only, over its project's "Runs on").`)
    this.emitTask(row.id)
  }

  /**
   * Start several tasks at once (create_tasks). Every input is checked before anything is written, and all
   * rows go in one transaction, so either every task exists or none does. The scheduler then runs once for the
   * whole batch, so their boxes are created together (up to Settings › Boxes created at once) rather than one
   * per call. Two or more share a batch id (Task.batchId), which the Coordinator's cards view keeps together.
   */
  createTasks(inputs: NewTask[]): Task[] {
    const projects = inputs.map((input) => {
      const project = this.store.getProject(input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (!input.title.trim()) throw new BadRequestError("title is required")
      if (!input.prompt.trim()) throw new BadRequestError("prompt is required")
      if (input.runsOn) this.requireIdentityRunner(project.id, input.runsOn)
      return project
    })
    const batchId = inputs.length > 1 ? `batch_${randomUUID().replace(/-/g, "").slice(0, 12)}` : null
    const ids = this.store.db.transaction(() =>
      inputs.map((input, i) => {
        const route = this.initialRoute(input)
        const task = this.store.createTask({
          ...input,
          agentCli: this.agentCliFor(input, projects[i]!),
          batchId,
          startedBy: input.scheduleId ? "schedule" : (input.source ?? "cody"),
          model: route.model,
          effort: route.effort,
          routingRule: route.routingRule,
          routingReason: route.routingReason,
          runsOn: input.runsOn ?? null,
          machineLabel: input.runsOn === "ssh" ? (input.machineLabel ?? null) : null,
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

  /**
   * The CLI a new task runs on: the one asked for, else the one its model names (a gpt-* model is Codex's), else its
   * project's Agent, else Settings › Box agents › Agent. It keeps it for good.
   */
  private agentCliFor(input: Pick<NewTask, "agentCli" | "model">, project: Project): AgentCli {
    return input.agentCli ?? cliForModel(input.model) ?? project.agentCli ?? this.settings.get().agentCli
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

  /**
   * Cody's message to a task from its card in the Coordinator chat (sendInput queued it): a line in the chat, so the
   * card shows what was sent. Only Cody reads it: it's marked read for the Coordinator, and it doesn't
   * go to the Captain. A notice about the task, so a status-only project's line stays sealed like its other notices.
   */
  sentFromChat(taskId: string, content: string, attachments: StoredUpload[] = []) {
    const row = this.requireRow(taskId)
    const text = content.trim() || (attachments.length === 1 ? "a file" : `${attachments.length} files`)
    const meta = { taskId, projectId: row.project_id, sent: true, ...(attachments.length ? { attachments } : {}) }
    const msg = this.store.addChat("notice", `✉️ **${row.title}** ${withOwner("got a message from Cody", this.owner())}: ${text}`, meta)
    this.store.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE id = ?").run(msg.id)
    this.hub.broadcast({ type: "chat.message", message: msg })
    return msg
  }

  /**
   * Cody's message from a task's chat for its project's Captain instead of the task's agent: task management
   * (split, reprioritise, move, "what's queued") that a busy agent would only read much later and couldn't act on.
   * The Captain gets the task and its queued messages (ids and text); the thread gets a "sent to the Captain" line
   * (an event, so a recap never hands it to the agent), and the Captain's reply follows (captainAnsweredForwards).
   */
  forwardToCaptain(taskId: string, content: string, attachments: StoredUpload[] = []) {
    const row = this.requireRow(taskId)
    if (!this.onForwardToCaptain) throw new BadRequestError("This Box Yard has no Captains.")
    const queue = this.listQueue(taskId).map((q) => ({ id: q.id, sender: q.sender, text: q.text.slice(0, 2000) }))
    const sent = this.onForwardToCaptain(row.project_id, content, attachments, { taskId, taskTitle: row.title, queue })
    const meta = {
      kind: "to_captain",
      captainMessageId: sent.id,
      captainProjectId: row.project_id,
      captainName: this.store.getProject(row.project_id)?.name ?? null,
      queued: queue.length,
      ...(attachments.length ? { attachments: publicFiles(attachments) } : {}),
    }
    const msg = this.store.addTaskMessage(taskId, "event", content.trim(), meta)
    this.hub.broadcast({ type: "task.message", message: msg })
    return msg
  }

  /** A Captain turn read Cody's forwards (forwardToCaptain): its reply goes in each of those tasks' threads, once per task. */
  captainAnsweredForwards(projectId: string, messages: CaptainMessage[], reply: string) {
    const name = this.store.getProject(projectId)?.name ?? null
    const byTask = new Map<string, string[]>()
    for (const m of messages) {
      const via = forwardedFromTask(m.meta)
      if (via && this.store.getTaskRow(via.taskId)) byTask.set(via.taskId, [...(byTask.get(via.taskId) ?? []), m.id])
    }
    for (const [taskId, ids] of byTask) {
      const text = reply.trim() || "The Captain read it and had nothing to add."
      const msg = this.store.addTaskMessage(taskId, "event", text, { kind: "captain_answer", captainMessageIds: ids, captainProjectId: projectId, captainName: name })
      this.hub.broadcast({ type: "task.message", message: msg })
    }
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

  /**
   * Raise or lower a task's priority (set_task_priority, send_to_task's and create_task's `priority`). A high task's
   * turns are pulled from the queue before every normal task's, here, on a box, a GPU pod, a Docker container or an
   * SSH machine; it never stops a running agent, and its project's limits still hold. It stays until changed.
   */
  setTaskPriority(taskId: string, priority: TaskPriority, by: string): Task {
    const row = this.requireRow(taskId)
    if (parsePriority(row.priority) === priority) return this.store.getTask(row.id)!
    this.store.updateTask(row.id, { priority })
    this.addEvent(
      row.id,
      priority === "high"
        ? `High priority (set by ${by}): its turns go before normal tasks waiting for a slot.`
        : `Normal priority (set by ${by}): its turns wait in line with the other tasks again.`,
    )
    this.emitTask(row.id)
    // A queued task moves up (or down) the queue at once.
    this.schedule()
    return this.store.getTask(row.id)!
  }

  async stopTask(taskId: string): Promise<Task> {
    const row = this.requireRow(taskId)
    if (row.current_turn_id && row.box_id) {
      this.stopRequested.add(row.id)
      // The runner writes turn_end after it stops; that settles the status. A turn whose process is gone has no
      // runner left to write it: it's settled here, as stopped.
      if (row.status === "working" && (await this.killTurn(row).catch(() => null)) === "gone") await this.turnGone(row, "its process had already stopped")
    } else if (row.status === "queued" || row.status === "starting") {
      this.dropQueuedMessages(row.id)
      this.store.updateTask(row.id, { compactPending: false, status: row.turn_count > 0 ? "idle" : "failed", error: row.turn_count > 0 ? null : "Stopped before it started." }, { quiet: true })
    }
    this.addEvent(row.id, withOwner("Stopped by Cody.", this.owner()))
    this.emitTask(row.id)
    return this.store.getTask(row.id)!
  }

  /**
   * "Send now": deliver the task's queued messages without waiting for the current turn to end. The turn is
   * stopped like Stop does (workspace and session kept, the queue kept), and the next turn resumes the session
   * with every queued message, in order. A task with no running turn just gets them with its next turn, as
   * with any send. A turn that ends on its own meanwhile keeps its own outcome (the kill only hits that turn),
   * and one new turn delivers the queue either way.
   *
   * A turn that is carrying a merge request is only interrupted with `allowMergeInterrupt` (see mergeInterruptRisk).
   */
  async sendQueuedNow(taskId: string, opts: { by: SendNowBy; allowMergeInterrupt?: boolean }): Promise<SendNowResult> {
    const row = this.requireRow(taskId)
    const inputs = this.store.listQueuedInputs(taskId)
    const queued = inputs.filter((i) => i.status === "queued").length
    const result = (delivery: SendNowResult["delivery"]): SendNowResult => ({ task: this.store.getTask(taskId)!, delivery, queued })
    // A turn already took them (it ended on its own as this was asked), or none is running: the next turn has them.
    if (!queued) return result("already_delivered")
    const running = Boolean(row.current_turn_id && row.box_id) && (row.status === "working" || row.status === "starting")
    if (!running) {
      this.schedule()
      return result("next_turn")
    }
    // A /compact turn is short and queued messages always wait for it: they go out right after.
    if (row.compacting || row.compact_pending) return result("after_compaction")
    // A turn still setting up that hasn't claimed the queue yet takes all of it when it starts.
    if (row.status === "starting" && !inputs.some((i) => i.status === "delivering")) return result("next_turn")
    const risk = this.mergeInterruptRisk(row)
    if (risk && !opts.allowMergeInterrupt) throw new ConflictError(`${risk} Wait for that turn to end, or confirm that you want to interrupt the merge.`)
    const who = opts.by === "coordinator" ? "The Coordinator" : opts.by === "captain" ? "The project's Captain" : withOwner("Cody", this.owner())
    const them = queued === 1 ? "the queued message" : `all ${queued} queued messages`
    this.addEvent(row.id, `${who} sent ${them} now: stopping the current step so the next turn delivers ${queued === 1 ? "it" : "them"}.`, { kind: "send_now", queued })
    if (row.status === "starting") this.stopRequested.add(row.id)
    // Its process ended without a turn_end (it died while Box Yard was down): end the turn here, as stopped. Only that
    // turn: one that ended on its own meanwhile, and the next one, are left alone.
    else if ((await this.killTurn(row, row.current_turn_id).catch(() => null)) === "gone") await this.turnGone(row, "its process had already stopped", { stopped: true })
    // The runner writes turn_end once it stops; that turn ends "stopped" and the scheduler starts the next one.
    this.emitTask(row.id)
    return result("interrupted")
  }

  /** Why stopping the task's current turn now would cut a merge short (it carries a merge request), or null. */
  mergeInterruptRisk(row: TaskRow): string | null {
    const req = this.store.mergeRequestOf(row)
    if (!req?.deliveredAt || !row.current_turn_id || row.status !== "working") return null
    return `The agent is merging PR #${req.prNumber} in its current turn${req.requestedBy ? ` (the ${req.requestedBy} asked)` : ""}, so sending now would stop the merge midway.`
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
    this.addEvent(row.id, isLocalRunnerBox(row.box_id) ? "Closed. Its folder stays on this computer until the task is deleted or this computer's cleanup archives it (Settings › Boxes & limits › This computer and SSH machines)." : "Closed. Its workspace was archived and its box slot freed.")
    this.emitTask(row.id)
    void this.evictWhenSettled(row.id)
    this.publishDirectory()
    return this.store.getTask(row.id)!
  }

  /**
   * Done when its PR merges (autoDoneOnMerge): resting tasks (pr_ready or idle, no turn running) whose PR already
   * merged move to done and their workspaces are archived, as the PR tracker does for a merge it sees. Catches merges
   * seen while it was off (Settings, or the project's own); runs at start and on every settings or project save.
   * A task with queued messages, its own opt-out or another PR that may still be open is left as it is (the other PRs
   * are asked about, quietly). Returns how many moved.
   */
  doneMergedResting(): number {
    let moved = 0
    for (const t of this.store.listTasks({ status: [...AUTO_DONE_FROM] })) {
      if (t.prState !== "merged") continue
      const row = this.store.getTaskRow(t.id)
      if (!row || restingStatus(row, "merged", true) !== "done" || !this.autoDoneOnMerge(row)) continue
      const blocker = this.mergeDoneBlocker(row)
      if (blocker === "other_prs") void this.doneIfOtherPrsSettled(row.id, false)
      if (blocker) continue
      // Not new activity: an old task stays where "recent" lists had it.
      this.store.updateTask(row.id, { status: "done" }, { quiet: true, touch: false })
      this.mergedDone(row.id)
      moved++
    }
    if (moved) this.publishDirectory()
    return moved
  }

  /** Done when its PR merges, for this task: never with its own opt-out, else its project's setting, else Settings'. */
  autoDoneOnMerge(row: Pick<TaskRow, "project_id" | "stay_open_on_merge">): boolean {
    if (row.stay_open_on_merge === 1) return false
    return this.store.getProject(row.project_id)?.autoDoneOnMerge ?? this.settings.get().autoDoneOnMerge
  }

  /** Close the issues a merged PR names, for this project: its own setting, else Settings'. */
  closeIssuesOnMerge(projectId: string): boolean {
    return this.store.getProject(projectId)?.closeIssuesOnMerge ?? this.settings.get().closeIssuesOnMerge
  }

  /** Where the auto-done setting that applies to a task lives, for its events. */
  private autoDoneSource(row: Pick<TaskRow, "project_id">): string {
    return this.store.getProject(row.project_id)?.autoDoneOnMerge != null ? "the project's settings" : "Settings"
  }

  /**
   * Why a merged PR doesn't move this resting task to done now, or null when it does: Cody (or an agent) queued it a
   * message, or it opened another PR that may still be open ("other_prs": doneIfOtherPrsSettled asks GitHub).
   */
  private mergeDoneBlocker(row: TaskRow): "queued" | "other_prs" | null {
    if (this.store.hasInputs(row.id)) return "queued"
    if (this.store.taskPrUrls(row.id).some((u) => u !== row.pr_url)) return "other_prs"
    return null
  }

  /** A task moved to done because its PR merged: say so, and archive its workspace and free its box slot, as close_task does. */
  private mergedDone(taskId: string) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    const where = isLocalRunnerBox(row.box_id) ? "" : " Its workspace is archived and its box slot freed."
    this.addEvent(row.id, `Moved to done: its pull request #${prNumber(row.pr_url) ?? "?"} is merged (${this.autoDoneSource(row)} › Done when its PR merges).${where}`, { kind: "auto_done" })
    this.emitTask(row.id)
    void this.evictWhenSettled(row.id)
  }

  /**
   * The task's PR merged but it opened other PRs too: ask GitHub about them, and move it to done only when none is
   * still open. `announce`: say on the task why it stays (a merge seen live), not on every catch-up.
   */
  private async doneIfOtherPrsSettled(taskId: string, announce: boolean): Promise<void> {
    const first = this.store.getTaskRow(taskId)
    if (!first?.pr_url) return
    const others = this.store.taskPrUrls(taskId).filter((u) => u !== first.pr_url)
    const token = this.githubTokenFor(first.project_id)
    const open: string[] = []
    let unknown: string | null = null
    if (!this.githubFetch || !token) unknown = "this project has no GitHub token"
    else {
      const gh = new GithubRest(this.githubFetch, token)
      for (const url of others) {
        try {
          if ((await restPrState(gh, url)) === "open") open.push(url)
        } catch (err) {
          unknown = errorMessage(err)
          break
        }
      }
    }
    if (this.stopped) return
    const row = this.store.getTaskRow(taskId)
    // Anything moved meanwhile (a message, a new turn, another PR, the setting): leave it.
    if (!row || row.pr_url !== first.pr_url || row.pr_state !== "merged" || restingStatus(row, "merged", true) !== "done" || !this.autoDoneOnMerge(row)) return
    if (this.store.hasInputs(row.id)) return
    const n = prNumber(row.pr_url) ?? "?"
    if (open.length || unknown) {
      if (announce)
        this.addEvent(
          row.id,
          open.length
            ? `Not moved to done, though PR #${n} merged: it also opened ${open.map((u) => `PR #${prNumber(u) ?? "?"}`).join(", ")}, still open.`
            : `Not moved to done, though PR #${n} merged: it also opened other PRs, and Box Yard couldn't check them (${unknown}).`,
          { kind: "auto_done_skipped" },
        )
      return this.emitTask(row.id)
    }
    this.store.updateTask(row.id, { status: "done" }, { quiet: true, touch: !announce ? false : undefined })
    this.mergedDone(row.id)
    this.publishDirectory()
  }

  /** Task options: keep this task open when its PR merges (a long-running runner), or let the settings decide again. */
  setStayOpenOnMerge(taskId: string, stayOpen: boolean, by: string): Task {
    const row = this.requireRow(taskId)
    if ((row.stay_open_on_merge === 1) === stayOpen) return this.store.getTask(row.id)!
    this.store.updateTask(row.id, { stayOpenOnMerge: stayOpen }, { touch: false })
    this.addEvent(
      row.id,
      stayOpen
        ? `Stays open when its PR merges (set by ${by}): Box Yard won't move it to done.`
        : `Done when its PR merges again (set by ${by}): ${this.autoDoneOnMerge({ ...row, stay_open_on_merge: 0 }) ? "a merged PR moves it to done" : "but its project's settings or Settings have that off"}.`,
    )
    this.emitTask(row.id)
    if (!stayOpen) this.doneMergedResting()
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
    if (taskAgentCli(row) === "codex") throw new BadRequestError("This agent runs on Codex, which compacts its own context as it goes (Settings › Box agents › Auto-compact sets when).")
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
    const token = this.githubToken(project.id)
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

  /** The GPU runners this install has: RunPod's, then Vast.ai's, then Daytona's. */
  private gpuRunners(): GpuRunner[] {
    return [this.gpu, this.vast, this.daytona].filter((g): g is GpuRunner => Boolean(g))
  }

  /** The runner of one cloud, or null when this install lacks it. */
  private gpuRunnerOf(kind: GpuProvider): GpuRunner | null {
    return kind === "vast" ? this.vast : kind === "daytona" ? this.daytona : this.gpu
  }

  private gpuKind(g: GpuRunner): GpuProvider {
    return g.kind ?? "runpod"
  }

  /** The runner a GPU box belongs to, by its id's prefix, or null (not a GPU box, or this install lacks that cloud). */
  private gpuFor(boxId: string | null | undefined): GpuRunner | null {
    const kind = gpuBoxProvider(boxId)
    return kind ? this.gpuRunnerOf(kind) : null
  }

  /** The cloud a GPU project's new pods come from: its own pick, else Settings › Daytona or Settings › Vast.ai GPU › Use for GPU projects. */
  gpuCloudOf(projectId: string): GpuProvider {
    return effectiveGpuProvider(this.store.projectGpuProvider(projectId), Boolean(this.vast?.settings().defaultForGpu), Boolean(this.daytona?.settings().defaultForGpu))
  }

  /** Every cloud's pods as last listed. */
  private get gpuSeen(): GpuPods {
    return [...this.gpuSeenBy.values()].flat()
  }

  /** Tasks running at once and task folders kept per box for a box of this size: Settings when set there, else the size's defaults. */
  sizeLimits(size: BoxSize): { slotsPerBox: number; maxResidentPerBox: number } {
    const o = this.settings.boxLimitOverrides()
    return { slotsPerBox: o.slotsPerBox ?? SIZE_DEFAULTS[size].slotsPerBox, maxResidentPerBox: o.maxResidentPerBox ?? SIZE_DEFAULTS[size].maxResidentPerBox }
  }

  /** Turns that may run at once on this box (its own size decides the default). */
  private slotsFor(boxId: string) {
    if (isLocalRunnerBox(boxId)) return this.settings.get().localAgents
    if (isGpuBox(boxId)) return this.store.projectBoxLimits(gpuBoxProject(boxId)).agentsPerBox ?? this.gpuFor(boxId)?.settings().agentsPerPod ?? 1
    if (isDockerBox(boxId)) return this.store.projectBoxLimits(dockerBoxProject(boxId)).agentsPerBox ?? this.docker?.settings().agentsPerContainer ?? 1
    // A removed machine takes no turns.
    if (isMachineBox(boxId)) return this.machineOf(boxId)?.maxTasks ?? 0
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

  /** Size for a new box made for a project: its own box size, else the size auto-sizing picked, else Settings → Worker size. */
  newBoxSize(projectId?: string | null): BoxSize {
    return (projectId ? (this.store.getProject(projectId)?.boxSize ?? this.autoSizeOf(projectId)) : null) ?? this.settings.get().workerSize
  }

  /**
   * Auto-sizing (shared/autoSize.ts): the size a project's measured turns of the last 14 days call for, held to
   * Settings › Max size it may choose. `size` is null until 3 runs are measured. `enabled`: Settings › Resize boxes
   * (autoResizeEnabled) is on, so the size applies where the project has no box size of its own (`override`).
   */
  autoBoxSize(projectId: string): ProjectAutoSize {
    let peaks = this.turnPeakCache.get(projectId)
    if (!peaks) {
      peaks = this.store.turnPeaks(projectId)
      this.turnPeakCache.set(projectId, peaks)
    }
    const s = this.settings.get()
    const diskTotal = (size: BoxSize) => {
      const n = Number(this.store.getKv(diskTotalKey(size)) ?? NaN)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    return { ...pickAutoSize(peaks, { maxSize: s.autoResizeMaxSize, diskTotal }), enabled: s.autoResizeEnabled, override: this.store.getProject(projectId)?.boxSize ?? null }
  }

  /** The size auto-sizing picked for a project's boxes, when it's on and has one. */
  private autoSizeOf(projectId: string): BoxSize | null {
    return this.settings.get().autoResizeEnabled ? this.autoBoxSize(projectId).size : null
  }

  /**
   * Agents (running turns) across all boxes. Local-runner turns have their own limit (Settings › Tasks running at once
   * on this computer), and GPU pods', Docker containers' and SSH machines' their own slots.
   */
  runningTotal() {
    return this.store.listTaskRows().filter((r) => holdsSlot(r) && !isLocalRunnerBox(r.box_id) && !ownRunnerOf(r.box_id)).length
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
   * or the global setting it falls back to. Tasks running at once and task folders kept per box follow each box's size unless Settings
   * or env set one number for every box.
   */
  projectBoxSettings(p: Pick<Project, "id" | "boxSize" | "agentsPerBox" | "tasksPerBox" | "maxBoxes"> & { wholeMachine?: boolean }) {
    const s = this.settings.get()
    const o = this.settings.boxLimitOverrides()
    const global = (k: "slotsPerBox" | "maxResidentPerBox", label: string) =>
      o[k] !== null ? `global: ${o[k]} (Settings › ${label})` : `global: each box's size default (${BOX_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(", ")})`
    const own = (v: number | string) => `${v} (this project)`
    const used = this.projectBoxCap(p.id)?.used.size ?? 0
    return {
      boxSize: p.boxSize ? own(p.boxSize) : this.autoSizeLine(p.id),
      agentsPerBox: p.agentsPerBox !== null ? own(`${p.agentsPerBox} of its tasks at a time on a box or this computer; other projects unaffected`) : global("slotsPerBox", "Tasks running at once per box"),
      tasksPerBox: p.tasksPerBox !== null ? own(p.tasksPerBox) : global("maxResidentPerBox", "Task folders kept per box"),
      maxBoxes: p.maxBoxes !== null ? `${p.maxBoxes} (this project; it uses ${boxCount(used)} now)` : `global: only the pool's Max boxes (${s.maxBoxes})`,
      ...(p.wholeMachine ? { wholeMachine: "yes: no other project's task starts on a box or this computer while one of its tasks runs there" } : {}),
    }
  }

  /** A project's box size when it has none of its own: what auto-sizing picked, else Settings › Worker size. */
  private autoSizeLine(projectId: string): string {
    const worker = `${this.settings.get().workerSize} (Settings › Worker size)`
    const auto = this.autoBoxSize(projectId)
    if (auto.enabled && auto.size) return `auto: ${auto.label}`
    // A project never measured (none of its runs were on Upstash boxes yet) reads as plain Worker size.
    return auto.enabled && auto.runs > 0 ? `global: ${worker}; auto-sizing has it ${auto.label}` : `global: ${worker}`
  }

  /**
   * A project's GPU pods and caps as they apply now (list_projects, pool_status), from the pods as last listed
   * (`fresh` lists them again), on the cloud its new pods come from. Pods it still has on the other cloud (its cloud
   * changed) are listed too, so their spend shows. Null when this Box Yard has no runner for that cloud.
   */
  async projectGpuSettings(p: Pick<Project, "id" | "gpuMaxHourlyUsd" | "maxBoxes" | "gpuMachine"> & { gpuProvider?: GpuProvider | null }, fresh = false) {
    const kind = this.gpuCloudOf(p.id)
    const gpu = this.gpuRunnerOf(kind)
    if (!gpu) return null
    if (fresh) for (const g of this.gpuRunners()) if (g.enabled()) await this.gpuPods(g)
    const s = gpu.settings()
    const where = GPU_SETTINGS_PATH[kind]
    const usd = (n: number) => `$${Math.round(n * 100) / 100}/hr`
    const pods = this.gpuSeen.filter((x) => gpuBoxProject(x.boxId) === p.id).sort((a, b) => gpuBoxIndex(a.boxId) - gpuBoxIndex(b.boxId))
    const own = p.gpuMaxHourlyUsd
    const m = p.gpuMachine
    const from = (mine: unknown, global: string) => (mine !== null ? "this project" : `global: ${where} › ${global}`)
    const ownCloud = p.gpuProvider !== undefined ? p.gpuProvider : this.store.projectGpuProvider(p.id)
    const other = pods.filter((x) => gpuBoxProvider(x.boxId) !== kind)
    return {
      provider: `${GPU_PROVIDER_LABEL[kind]} (${ownCloud ? "this project" : `global: ${globalGpuProviderSource(kind)}`})`,
      gpuTypes: `${(m.gpuTypes ?? s.gpuTypes).map(shortGpu).join(", ")} (${from(m.gpuTypes, "GPU types")})`,
      ...(kind === "runpod" ? { cloud: `${m.cloud ?? s.cloud} (${from(m.cloud, "Cloud")})` } : {}),
      minRamGb: `${m.minRamGb ?? s.minRamGb} (${from(m.minRamGb, "Min RAM")})`,
      minVcpus: `${m.minVcpus ?? s.minVcpus} (${from(m.minVcpus, "Min vCPUs")})`,
      maxHourlyUsd: own !== null ? `${own ? usd(own) : "none"} (this project)` : `global: ${usd(s.maxHourlyUsd)} (${where} › Max per project)`,
      totalMaxHourlyUsd: `${usd(s.totalMaxHourlyUsd)} for every project's pods together (${where} › Max for all pods)`,
      maxPods: p.maxBoxes !== null ? `${Math.min(p.maxBoxes, MAX_GPU_PODS)} (its Max boxes)` : `${MAX_GPU_PODS} (no Max boxes set; the $/hr caps bound it)`,
      agentsPerPod: this.slotsFor(gpuBoxIdOn(kind, p.id)),
      pods: pods.map(({ boxId, pod }) => `#${gpuBoxIndex(boxId)} ${boxId}: ${pod.status.toLowerCase()}${pod.gpu?.id ? ` ${shortGpu(pod.gpu.id)}` : ""}${pod.cost ? ` ${usd(pod.cost)}` : ""}, ${this.runningOn(boxId)}/${this.slotsFor(boxId)} tasks running`),
      spend: usd(pods.reduce((sum, x) => sum + (x.pod.cost ?? 0), 0)),
      ...(other.length ? { otherCloud: `${other.length} on ${GPU_PROVIDER_LABEL[gpuBoxProvider(other[0]!.boxId)!]} from before its cloud changed: they stop when idle` } : {}),
    }
  }

  /**
   * A Docker project's container, image and limits as they apply now (list_projects, pool_status), from the
   * containers as last listed. Null when this Box Yard has no Docker runner.
   */
  projectDockerSettings(p: Pick<Project, "id" | "docker">) {
    if (!this.docker) return null
    const s = this.docker.settings()
    const boxId = dockerBoxId(p.id)
    const c = this.docker.provider.cached().find((x) => x.boxId === boxId)
    return {
      image: p.docker.dockerfile
        ? "its own Dockerfile (this project), built on this computer"
        : p.docker.image
          ? `${p.docker.image} (this project)`
          : `${s.image ?? "Box Yard's own, built from docker/"} (Settings › Docker › Image)`,
      limits: `${s.cpus} CPUs and ${s.memoryMb} MB of memory per container (Settings › Docker)`,
      agentsPerContainer: this.slotsFor(boxId),
      whenIdle: s.idleMinutes ? `stopped after ${s.idleMinutes} min with no agent running; its volume keeps every workspace` : "never stopped when idle (Settings › Docker)",
      container: c
        ? `${c.name}: ${c.state}${c.hostPortBase ? `, previews on localhost:${c.hostPortBase}-${c.hostPortBase + DOCKER_MAX_TASKS - 1}` : ""}, ${this.runningOn(boxId)}/${this.slotsFor(boxId)} tasks running`
        : "none yet (its next task makes it)",
    }
  }

  /** List the Docker containers again (pool_status) unless Docker is down, when the last list stays. */
  async refreshDockerContainers(): Promise<void> {
    if (!this.docker || (await this.docker.problem())) return
    await this.docker.provider.list(true).catch(() => {})
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
        estimatedCostUsd: boxRowCost(b, rates, now),
        usageSource: sourceOf(b.usage_source),
        createdAt: b.created_at,
        lastUsedAt: b.last_used_at,
        idleHeld: this.idleHeld.get(b.id) ?? null,
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

  /**
   * What Clear box, Delete box and Terminate pod would touch: each task with its status, uncommitted files and its
   * verdict in the delete safety check (server/boxDelete.ts), and the disk in use. One exec reads every workspace.
   */
  async boxContents(boxId: string): Promise<BoxContents> {
    if (isMachineBox(boxId)) throw new BadRequestError(`SSH machine ${this.machineName(boxId)} is one of your own computers: Box Yard never clears or deletes it.`)
    const pod = isGpuBox(boxId)
    const container = isDockerBox(boxId)
    const box = pod || container ? null : this.store.getBox(boxId)
    const rows = this.store.listTaskRows({ boxId }).sort((a, b) => a.created_at - b.created_at)
    if (!box && !pod && !container) throw new NotFoundError(`Box ${boxId} not found`)
    let up = box?.status === "ready"
    if (pod) {
      const gpu = this.gpuFor(boxId)
      if (!gpu) throw new NotFoundError(`Box ${boxId} not found`)
      up = Boolean((await this.gpuPods(gpu))?.some((p) => p.boxId === boxId && p.pod.status === "RUNNING"))
      if (!up && !rows.length) throw new NotFoundError(`GPU pod ${boxId} isn't running`)
    }
    if (container) {
      if (!this.docker) throw new NotFoundError(`Box ${boxId} not found`)
      // Stopped or not, its volume holds the workspaces: the check below starts it to read them.
      const listed = await this.docker.provider.list().catch(() => null)
      up = Boolean(listed?.some((c) => c.boxId === boxId))
      if (!up && !rows.length) throw new NotFoundError(`Docker container ${boxId} doesn't exist`)
    }
    let git = new Map<string, WorkspaceGit>()
    let reachable = up
    if (up && rows.length) {
      const script = deleteCheckScript(rows.map((r) => ({ id: r.id, work: `${this.taskDir(boxId, r.id)}/work` })))
      const res = await this.provider.exec(boxId, script).catch(() => null)
      reachable = Boolean(res)
      if (res) git = parseDeleteCheck(res.stdout)
    }
    const op = this.boxOperation(boxId)
    const busy = op
      ? busyMessage(boxId, op)
      : pod
        ? up
          ? null
          : `GPU pod ${boxId} isn't running, so there's no pod to terminate`
        : container
          ? null
          : box!.status === "ready"
            ? null
            : `Box ${boxId} is ${box!.status}`
    const tasks = rows.map((r) => {
      const archived = this.hasFreshArchive(r)
      // A box that isn't up has no workspace to check, but its running and queued tasks still say so.
      const v =
        up || r.current_turn_id || this.wantsTurn(r)
        ? deleteVerdict({
            status: r.status,
            running: Boolean(r.current_turn_id),
            wantsTurn: this.wantsTurn(r),
            prState: r.pr_state,
            hasRepo: Boolean(this.store.getProject(r.project_id)?.repo),
            reachable,
            git: git.get(r.id) ?? null,
            archived,
            archivesAll: pod || container,
          })
        : { verdict: "ok" as const, detail: "no workspace to reach; it restores from its last archive" }
      return {
        id: r.id,
        title: r.title,
        projectId: r.project_id,
        status: r.status,
        running: Boolean(r.current_turn_id),
        uncommitted: git.get(r.id)?.changed ?? null,
        archived,
        prState: r.pr_state,
        ...v,
      }
    })
    return {
      boxId,
      kind: pod ? "pod" : container ? "container" : "box",
      label: pod ? gpuPodLabel(boxId, this.store.getProjectName(gpuBoxProject(boxId))) : container ? dockerLabel(boxId, this.store.getProjectName(dockerBoxProject(boxId))) : boxId,
      tasks,
      running: rows.filter((r) => r.current_turn_id).length,
      diskUsedBytes: box?.disk_free_bytes != null && box.disk_total_bytes != null ? Math.max(0, box.disk_total_bytes - box.disk_free_bytes) : null,
      diskBytes: box?.disk_bytes ?? null,
      busy,
      refusals: refusalsOf(busy, tasks),
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
   * Delete a box at the provider, or terminate a RunPod GPU pod (`runpod-*`; its network volume stays). Box Yard
   * never deletes network volumes or project snapshots here. A reachable box first gets every workspace archived
   * (the same archive a closed task gets; merged and fully pushed ones need none); if one can't be archived nothing
   * is deleted. Its tasks restore from their archive on their next turn, on another box or a new pod.
   *
   * The Coordinator and Captains (`actor`) are held to the safety check (`boxContents`): any refusal stops it, and
   * they can't stop agents. Cody (the default actor) can stop running agents (`stopAgents`) and delete past the
   * rest of the check (`override`: queued tasks are placed again, unpushed work is only in the archive).
   */
  async destroyBox(boxId: string, opts: { stopAgents?: boolean; override?: boolean; actor?: BoxActor; reason?: string | null } = {}): Promise<BoxDeleteResult> {
    const actor = opts.actor ?? { kind: "owner" }
    const owner = actor.kind === "owner"
    const stopAgents = owner && Boolean(opts.stopAgents)
    if (isLocalRunnerBox(boxId)) throw new BadRequestError("That's this computer, not a box: its task folders are cleaned by Settings › Boxes & limits › This computer (build output, Task folders kept, low-disk cleanup).")
    if (isMachineBox(boxId)) throw new BadRequestError(`That's SSH machine ${this.machineName(boxId)}, one of your own computers, not a box: Box Yard never deletes it. Remove it from Box Yard in Settings › Machines (remove_machine).`)
    const pod = isGpuBox(boxId)
    const container = isDockerBox(boxId)
    const kind = pod ? "pod" : container ? "container" : "box"
    const box = pod || container ? null : this.store.getBox(boxId)
    const gone = (): BoxDeleteResult => ({ boxId, kind, label: boxId, archived: [], fromGitHub: [], alreadyGone: true })
    if (container) {
      const listed = this.docker ? await this.docker.provider.list().catch(() => null) : null
      if (listed && !listed.some((c) => c.boxId === boxId) && !this.store.listTaskRows({ boxId }).length) return gone()
    } else if (!pod) {
      if (!box) {
        // Already deleted or lost: deleting it again is a no-op.
        if (this.history.boxIds().includes(boxId)) return gone()
        throw new NotFoundError(`Box ${boxId} not found`)
      }
      // Deleted outside Box Yard: there's nothing to archive or destroy, only records to drop.
      if (box.status === "ready" && !this.boxOps.has(boxId) && (await this.goneAtProvider(boxId))) {
        await this.loseGoneBox(boxId, "Delete box", actor)
        return gone()
      }
    }
    const check = await this.boxContents(boxId)
    const reachable = pod || container || box!.status === "ready"
    if (!owner && check.refusals.length) throw new ConflictError(`${check.label} was not ${pod ? "terminated" : "deleted"}:\n- ${check.refusals.join("\n- ")}`)
    if ((pod || container) && check.busy) throw new ConflictError(check.busy)
    const risky = reachable ? atRisk(check) : []
    if (risky.length && !opts.override) {
      throw new ConflictError(`${check.label} was not ${pod ? "terminated" : "deleted"}: ${risky.map(refusalLine).join("; ")}. Choose ${pod ? "Terminate" : "Delete"} anyway to archive and ${pod ? "terminate" : "delete"} it.`)
    }
    const overridden = risky.length ? withOwner(` Cody chose ${pod ? "Terminate" : "Delete"} anyway past: ${risky.map(refusalLine).join("; ")}.`, this.owner()) : ""
    const result: BoxDeleteResult = { boxId, kind, label: check.label, archived: [], fromGitHub: [] }
    // The check ran before the box was claimed: an agent's delete also refuses a turn that started or got queued since.
    const lateCheck = () => {
      if (owner) return
      const late = this.store.listTaskRows({ boxId }).filter((r) => r.current_turn_id || this.wantsTurn(r))
      if (late.length) {
        const why = late.map((r) => refusalLine({ id: r.id, title: r.title, detail: r.current_turn_id ? "an agent started on it during the check" : "it was queued during the check" }))
        throw new ConflictError(`${check.label} was not ${pod ? "terminated" : "deleted"}:\n- ${why.join("\n- ")}`)
      }
    }
    if (pod) {
      this.claimBox(boxId, "delete", stopAgents)
      try {
        lateCheck()
        if (stopAgents) await this.stopAgentsOn(boxId)
        const reason = opts.reason?.trim() || (owner ? `Terminated from ${GPU_SETTINGS_PATH[gpuBoxProvider(boxId) ?? "runpod"]}.` : "No reason given.")
        await this.stopGpuPod(boxId, { actor, reason: `${reason}${overridden}` })
        // stopGpuPod archived every started workspace (a pod's tasks keep its id and restore on its next start).
        result.archived = this.store.listTaskRows({ boxId }).filter((r) => r.session_started).map((r) => r.id)
        return result
      } finally {
        this.boxOps.delete(boxId)
        this.emitBoxes()
        this.schedule()
      }
    }
    if (container) {
      this.claimBox(boxId, "delete", stopAgents)
      try {
        lateCheck()
        if (stopAgents) await this.stopAgentsOn(boxId)
        const reason = opts.reason?.trim() || (owner ? "Deleted from Settings › Docker." : "No reason given.")
        Object.assign(result, await this.deleteDockerContainer(boxId, { actor, reason: `${reason}${overridden}` }))
        return result
      } finally {
        this.boxOps.delete(boxId)
        this.emitBoxes()
        this.schedule()
      }
    }
    if (reachable) {
      this.claimBox(boxId, "delete", stopAgents)
      try {
        lateCheck()
        if (stopAgents) await this.stopAgentsOn(boxId)
        // A cleanup may be parking workspaces right now; let it finish first.
        while (this.janitor.isRunning(boxId)) await new Promise((r) => setTimeout(r, 200))
        const kept: string[] = []
        for (const row of this.store.listTaskRows({ boxId })) {
          if (await this.skipArchiveIfPushed(row.id, boxId, `delete box ${boxId}`)) {
            result.fromGitHub.push(row.id)
            continue
          }
          await this.archiveFresh(row.id)
          const fresh = this.store.getTaskRow(row.id)
          if (fresh?.box_id === boxId && fresh.session_started && !this.hasFreshArchive(fresh)) kept.push(fresh.id)
          else if (fresh?.session_started) result.archived.push(row.id)
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
      const saved = [
        result.archived.length ? `${result.archived.length} archived` : "",
        result.fromGitHub.length ? `${result.fromGitHub.length} needed no archive (PR merged, nothing unpushed)` : "",
      ].filter(Boolean)
      const detail = owner
        ? reachable
          ? `Deleted from the Boxes page; every workspace was archived first.${overridden}`
          : `Deleted from the Boxes page while ${box!.status}.`
        : `Deleted with delete_box after the safety check passed${saved.length ? `: ${saved.join(", ")}` : ""}.`
      await this.loseBox(boxId, owner ? withOwner("Box deleted by Cody.", this.owner()) : `Box deleted by ${actor.kind === "captain" ? "its project's Captain" : "the Coordinator"}.`, false, {
        type: "deleted",
        actor,
        reason: opts.reason?.trim() || null,
        detail,
      })
      await this.provider.destroy(boxId).catch((err) => console.warn(`destroy ${boxId}: ${errorMessage(err)}`))
    } finally {
      this.boxOps.delete(boxId)
    }
    return result
  }

  /** Mark a box for clear/delete/resize, or say why not: another operation on it, or agents running without `stopAgents`. */
  private claimBox(boxId: string, op: BoxOp, stopAgents: boolean) {
    const busy = this.boxOperation(boxId)
    if (busy) throw new ConflictError(busyMessage(boxId, busy))
    const running = this.store.listTaskRows({ boxId }).filter((r) => r.current_turn_id).length
    if (running && !stopAgents) throw new ConflictError(`${running} ${running === 1 ? "task is" : "tasks are"} running on ${boxId}: stop ${running === 1 ? "it" : "them"} first.`)
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

  /** The box (or GPU pod, or Docker container) holds `projectId`'s work and no other project's: what a Captain may delete. */
  onlyProjectOn(boxId: string, projectId: string): boolean {
    const own = isGpuBox(boxId) ? [gpuBoxProject(boxId)] : isDockerBox(boxId) ? [dockerBoxProject(boxId)] : []
    const on = [...new Set([...own, ...this.projectsOnBox(boxId)])]
    return on.length > 0 && on.every((p) => p === projectId)
  }

  /**
   * Running boxes and GPU pods delete_idle_boxes looks at: with a project, only those holding nothing but its work.
   * Not Docker containers: they cost nothing idle and stop on their own (sweepDocker); delete_box deletes one.
   */
  async deleteCandidates(projectId?: string): Promise<string[]> {
    const pods: string[] = []
    for (const g of this.gpuRunners()) if (g.enabled()) pods.push(...((await this.gpuPods(g)) ?? []).filter((p) => p.pod.status === "RUNNING").map((p) => p.boxId))
    const ids = [...this.store.listBoxes().filter((b) => b.status === "ready").map((b) => b.id), ...pods]
    return projectId ? ids.filter((id) => this.onlyProjectOn(id, projectId)) : ids
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
        ...(opts.stopAgents && running ? [step("stop", `Stop ${running} running ${running === 1 ? "task" : "tasks"}`)] : []),
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
      this.setBoxCreds(to, this.boxCreds(r.boxId))
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
    this.store.setKv(boxCredsKey(boxId), null)
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
    if (project.runner === "ssh" || isMachineBox(boxId)) throw new BadRequestError(`${project.name} runs on SSH machines: they're your own computers, so they're never snapshotted.`)
    if (project.runner === "gpu" || isGpuBox(boxId)) {
      if (this.gpuCloudOf(projectId) === "vast") throw new BadRequestError(`${project.name} runs on Vast.ai GPU instances, which start fresh each time, so it has no box snapshot.`)
      if (this.gpuCloudOf(projectId) === "daytona") throw new BadRequestError(`${project.name} runs on Daytona sandboxes, which start fresh each time, so it has no box snapshot.`)
      throw new BadRequestError(`${project.name} runs on RunPod GPU pods: pod #1's network volume keeps caches between its runs, so it has no box snapshot.`)
    }
    if (project.runner === "docker" || isDockerBox(boxId)) throw new BadRequestError(`${project.name} runs in a Docker container: its volume keeps caches between runs, so it has no box snapshot.`)
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
    await this.dropDockerContainer(projectId, { kind: "owner" }, "Its project was deleted.")
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
    this.noticeCloudSpend()
    // High priority first, then first in, first out (shared/priority.ts). Each is placed in turn, so a task its own
    // project's limits hold back is skipped and the tasks behind it still get the free slots.
    const waiting = this.store
      .listTaskRows()
      .filter((r) => this.wantsTurn(r))
      .sort((a, b) => queueOrder(queueEntry(a), queueEntry(b)))

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
      // Placement awaited: the box it picked may have gone meanwhile (the idle sweep, a delete, a lost box). The task
      // stays queued and the next pass places it again.
      if (!ownRunnerOf(boxId) && !isLocalRunnerBox(boxId) && (this.store.getBox(boxId)?.status !== "ready" || this.boxOps.has(boxId))) {
        this.schedule()
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
        const local = isLocalRunnerBox(boxId) ? (this.localWait(row) ?? { text: LOCAL_SLOT_WAIT, by: [] }) : null
        this.setWaitReason(
          row.id,
          local?.text ??
            (isGpuBox(boxId)
              ? gpuSlotWait(gpuBoxProvider(boxId)!)
              : isDockerBox(boxId)
                ? DOCKER_SLOT_WAIT
                : isMachineBox(boxId)
                  ? `Waiting for a free slot on SSH machine ${this.machineName(boxId)}`
                  : `Waiting for a free slot on ${boxId}`),
          null,
          local?.by,
        )
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
    const urgent = new Set<string>()
    for (const row of waiting) {
      if (!this.wantsBox.has(row.id)) continue
      perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1)
      if (parsePriority(row.priority) === "high") urgent.add(row.project_id)
    }
    const need = new Map<string, number>()
    for (const [projectId, n] of perProject) {
      const creating = this.creatingFor.get(projectId) ?? 0
      // Never past the project's own Max boxes, counting the boxes it uses and those on their way.
      const cap = this.projectBoxCap(projectId)
      const more = Math.min(Math.ceil(n / this.growthSlots(projectId)), cap ? cap.max - cap.used.size : Infinity) - creating
      if (more > 0) need.set(projectId, more)
    }
    // Several at once, up to Settings › Boxes created at once and the pace (each finished create runs another pass),
    // and up to the hour's free ones unless Cody allowed more. A project with a high-priority task waiting goes
    // first; then the one with the fewest boxes on their way, so one project's big fan-out doesn't hold up another's
    // single task. createBox counts itself in `creatingFor` and `createStarts` before its first await.
    const cap = this.createConcurrency()
    const createRank = (projectId: string) => (urgent.has(projectId) ? 0 : 1_000_000) + (this.creatingFor.get(projectId) ?? 0)
    while (need.size && this.fanoutRoom() > 0 && this.canCreateBox(cap)) {
      const [projectId, more] = [...need].reduce((best, next) => (createRank(next[0]) < createRank(best[0]) ? next : best))
      void this.createBox(projectId)
      if (more > 1) need.set(projectId, more - 1)
      else need.delete(projectId)
    }
    this.askForMoreBoxes(waiting, this.fanoutRoom() === 0 ? need : new Map())
  }

  /**
   * The boxes a big queue still wants once the hour's free ones are made wait on one OK from Cody: their tasks say so
   * with the "allow-boxes" fix, and the Coordinator hears it, with what they'd cost, at most every half hour. Tasks the
   * boxes on their way will take go on waiting for those.
   */
  private askForMoreBoxes(waiting: TaskRow[], left: Map<string, number>) {
    const rates = this.settings.get().costRates.boxActiveCpuHourlyUsd
    let wanted = 0
    let upTo = 0
    for (const [projectId, n] of left) {
      const size = this.newBoxSize(projectId)
      wanted += n
      upTo += n * BOX_SIZE_SPECS[size].cpu * rates[size]
    }
    const held = new Set<string>()
    for (const projectId of left.keys()) {
      let covered = (this.creatingFor.get(projectId) ?? 0) * this.growthSlots(projectId)
      for (const row of waiting) {
        if (row.project_id !== projectId || !this.wantsBox.has(row.id)) continue
        if (covered-- > 0) continue
        held.add(row.id)
      }
    }
    // A newly held task may take a free slot beside another project meanwhile (pickBox): one more pass to let it.
    const fresh = [...held].some((id) => !this.fanoutHeld.has(id))
    this.fanout.wanted = wanted
    this.fanout.upToHourlyUsd = upTo
    this.fanoutHeld = held
    if (fresh) this.schedule()
    if (!wanted) return
    const wait = this.fanoutWait()
    for (const id of held) {
      const row = this.store.getTaskRow(id)
      if (row && this.wantsTurn(row) && !row.wait_reason) this.setWaitReason(id, wait, null, [], "allow-boxes")
    }
    const now = Date.now()
    if (now - this.fanout.noticedAt < FANOUT_NOTICE_MS) return
    this.fanout.noticedAt = now
    const free = this.boxCreateTuning.freePerHour
    this.notice(
      withOwner(
        `🙋 **New boxes** need Cody's OK: the queue wants ${boxCount(wanted)} more than the ${free} an hour Box Yard makes without asking, up to ${usd(upTo)}/h if every core is busy. Allow them for an hour from a waiting task or the cloud meter, or with allow_more_boxes.`,
        this.owner(),
      ),
      { kind: "box_fanout" },
      { coordinator: true },
    )
  }

  /**
   * A held task's wait reason (fanoutHeld). No counts or $/h: they change as the queue does, and each change would be
   * another line in the task's log. The meter's sheet and the Coordinator's notice carry them.
   */
  private fanoutWait(): string {
    return `Waiting for a new box: the queue wants more than the ${this.boxCreateTuning.freePerHour} an hour Box Yard makes without asking; allow more for an hour`
  }

  /**
   * Let the scheduler make as many boxes as the queue needs for the next hour (still under the daily cloud limit, the
   * ceiling and the pace). The tasks waiting on it are placed at once.
   */
  allowMoreBoxes(by: "user" | "coordinator" = "user"): BoxFanout {
    const now = Date.now()
    this.store.setKv(FANOUT_ALLOWED_KEY, String(now + FANOUT_WINDOW_MS))
    const wanted = this.fanout.wanted
    this.fanout.wanted = 0
    this.fanout.upToHourlyUsd = 0
    this.fanoutHeld.clear()
    const who = by === "user" ? withOwner("Cody", this.owner()) : "The Coordinator"
    this.notice(`⚙️ **New boxes** allowed: ${who} let Box Yard make more than ${this.boxCreateTuning.freePerHour} boxes in the next hour${wanted ? ` (${boxCount(wanted)} were waiting)` : ""}.`, { kind: "box_fanout" })
    this.schedule()
    this.emitBoxes()
    return this.boxFanout(now)
  }

  /** The fan-out question's state, for the cloud meter. */
  boxFanout(now = Date.now()): BoxFanout {
    return { freePerHour: this.boxCreateTuning.freePerHour, wanted: this.fanout.wanted, upToHourlyUsd: this.fanout.upToHourlyUsd, allowedUntil: this.fanoutAllowedUntil(now) }
  }

  /** Box creates that may run at once: Settings › Boxes created at once, fewer for a while after a rate limit. */
  private createConcurrency() {
    return Math.max(1, Math.min(this.settings.get().boxCreateConcurrency, this.boxCreate.window))
  }

  /** Another box create may start: the pool has room, no backoff is running, fewer than `cap` are on their way and the pace allows one. */
  private canCreateBox(cap: number) {
    return this.poolCreates < cap && Date.now() >= this.boxCreate.retryAt && this.poolHasRoom() && this.paceWait() === 0
  }

  /**
   * How long until the pace lets another create start (0: now): at most 5 start in any minute, so a big queue gets
   * its boxes over a few minutes rather than in one burst the provider may refuse. When it's not now, a pass is set
   * for then.
   */
  private paceWait(now = Date.now()): number {
    const { paceCreates, paceWindowMs } = this.boxCreateTuning
    const recent = this.createStarts.filter((at) => now - at < paceWindowMs)
    if (recent.length < paceCreates) return 0
    const wait = recent[recent.length - paceCreates]! + paceWindowMs - now
    if (!this.paceTimer && !this.stopped) {
      this.paceTimer = setTimeout(() => {
        this.paceTimer = null
        this.schedule()
      }, wait + 50)
      this.paceTimer.unref()
    }
    return wait
  }

  /** New boxes the scheduler may still make on its own this hour: `freePerHour` less those started in the last hour, or no limit while Cody's OK lasts. */
  private fanoutRoom(now = Date.now()): number {
    if (this.fanoutAllowedUntil(now)) return Number.POSITIVE_INFINITY
    this.createStarts = this.createStarts.filter((at) => now - at < FANOUT_WINDOW_MS)
    return Math.max(0, this.boxCreateTuning.freePerHour - this.createStarts.length)
  }

  /** The end of Cody's OK for more boxes, while it lasts; else null. */
  private fanoutAllowedUntil(now = Date.now()): number | null {
    const until = Number(this.store.getKv(FANOUT_ALLOWED_KEY) ?? 0)
    return until > now ? until : null
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
    if (this.janitor.isBusy(row.id) || this.ownCleanup.isBusy(row.id)) return null
    const op = row.box_id ? this.boxOps.get(row.box_id) : undefined
    if (op) {
      // Its workspace is being archived off the box; it moves to another box once that's done.
      this.setWaitReason(row.id, `Waiting while box ${row.box_id} is ${op === "clear" ? "cleared" : op === "resize" ? "resized" : op === "snapshot" ? "snapshotted" : "deleted"}`)
      return null
    }
    // The task's runs_on, else its project's "Runs on": it moves to (or off) this computer, its GPU pod or its Docker
    // container when nothing would be lost.
    const runner = this.store.taskRunner(row)
    // Its identity doesn't allow that runner (its runners changed after the task asked for it): it never runs there.
    const notAllowed = this.identities.runnerProblem(this.identities.idOf(row.project_id), runner)
    if (notAllowed) {
      this.setWaitReason(row.id, `Waiting: ${notAllowed}`)
      return null
    }
    const on = ownRunnerOf(row.box_id)
    if (on && !this.onOwnBox(row, runner)) {
      const moved = await this.fromOwnBox(row, runner)
      return moved === "stay" ? this.ownSlot(row, on) : moved
    }
    if (runner === "gpu" || runner === "docker" || runner === "ssh") {
      const here = await this.toOwnBox(row, runner)
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
        if (this.boxCreds(box.id) !== this.projectCreds(row.project_id)) {
          const moved = await this.leaveOtherCredsBox(row, box.id)
          if (moved !== "stay") return moved
        }
        // Busy: no free slot, or a free one that a project's Agents per box or the box's memory rules out.
        const full = this.runningOn(box.id) >= this.slotsFor(box.id)
        const busy = full ? null : (this.limitBlock(row, box.id) ?? asWait(await this.memoryBlock(box.id, row.id)))
        if (!full && !busy) return box.id
        // Its box is busy. Its workspace lives there, so it waits for a slot unless it can move without losing work.
        const noSlot = full ? `Waiting for a free slot on ${box.id}` : null
        if (!this.canMove(row)) {
          this.setWaitReason(row.id, busy ? `Waiting: ${busy.text}` : noSlot, null, busy?.by)
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
   * A resting task whose folder is on a box of another credential set (the box wall, `projectCreds`): its project
   * got a Claude login or GitHub token of its own after the box was made, or lost it, or the box is from before the
   * wall. It moves through `pickBox` like `leaveSmallBox` when nothing would be lost; one that can't stays ("stay")
   * and its log says why.
   */
  private async leaveOtherCredsBox(row: TaskRow, boxId: string): Promise<string | null | "stay"> {
    if (this.archiving.has(row.id)) return null
    const creds = this.projectCreds(row.project_id)
    const identity = this.credsIdentity(creds)
    const why =
      creds === GLOBAL_CREDENTIALS
        ? "its project uses the global credentials now, and the box is another project's"
        : identity
          ? `its project uses the ${identity} identity, so it gets boxes only that identity's projects use`
          : "its project has its own Claude login or GitHub token, so it gets boxes no other project uses"
    const block = row.session_started ? this.moveBlock(row) : null
    if (block) {
      this.noteOnce(row.id, `${row.id}:${boxId}:creds`, `Running on ${boxId} though ${why}: it can't move safely (${block}).`)
      return "stay"
    }
    const other = await this.pickBox(row.id, boxId)
    if (!other) return null
    this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(boxId, row.id).catch(() => {})
    this.addEvent(row.id, `Moved from ${boxId} to ${other}: ${why}.`)
    return this.assign(row.id, other)
  }

  /**
   * The GitHub token a project's clones, fetches, pushes, PR checks and turns use: its own GITHUB_TOKEN (or GH_TOKEN),
   * else its identity's for the repo's owner (identities.base). Read on every use, so a new token applies at once.
   */
  githubToken(projectId: string): string {
    const project = this.store.getProject(projectId)
    return ownGithubToken(this.store.projectEnv(projectId)) || (project ? this.identities.base(projectId, project.repo).githubToken : "")
  }

  /**
   * The one credential resolver: what a turn of this project, with the task's own env vars on top, logs in with
   * (`turnEnv` over the project's identity, docs/identities.md). taskJson hands it to every runner, and Docker's
   * Claude-key checks ask it too, so no runner reads Settings › Credentials, an identity or a project's env itself.
   */
  turnCredentials(projectId: string, taskEnv: Record<string, string> = {}): TurnEnv {
    const own = { ...this.store.projectEnv(projectId), ...taskEnv }
    return turnEnv(own, this.identities.base(projectId, this.store.getProject(projectId)?.repo ?? null))
  }

  /**
   * Who a turn's commits are by (server/gitAuthor.ts): the project's or identity's author, else Settings' Git author,
   * else (on this computer, Default identity) this computer's own git config, else the GitHub account behind the
   * turn's token, else the fallback author, which the task's log and Settings › Credentials / Identities warn about.
   */
  private async turnAuthor(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, dir: string): Promise<TurnAuthor> {
    const taskEnv = this.store.taskEnv(row.id)
    const own = { ...this.store.projectEnv(project.id), ...taskEnv }
    const { env } = this.turnCredentials(project.id, taskEnv)
    const isDefault = this.identities.idOf(project.id) === DEFAULT_IDENTITY_ID
    const settings = this.settings.get()
    const onComputer = isLocalRunnerBox(boxId) || isDockerBox(boxId)
    const token = env.GITHUB_TOKEN || this.githubTokenSeam?.(project.id) || ""
    const author = await chooseAuthor({
      env,
      identityAuthor: !GIT_AUTHOR_VARS.some((v) => own[v]),
      settings: { name: settings.gitUserName, email: settings.gitUserEmail },
      host: !onComputer
        ? null
        : !isDefault
          ? { skipped: "its identity keeps off this computer's git config" }
          : isLocalRunnerBox(boxId)
            ? { mode: "native", read: async () => parseHostGit((await this.provider.exec(boxId, hostGitScript(`${dir}/work`))).stdout) }
            : { mode: "env", read: this.hostGit },
      github: !token
        ? { skipped: "the turn has no GitHub token" }
        : this.githubAuthors
          ? () => this.githubAuthors!.author(token)
          : { skipped: "mock mode doesn't ask GitHub whose token it is" },
    })
    recordAuthorSource(this.store, project.id, row.id, author)
    if (author.source === "fallback") {
      if (!this.authorWarned.has(row.id)) this.addEvent(row.id, fallbackWarning(author.skipped), { kind: "author" })
      this.authorWarned.add(row.id)
      console.warn(`[box-yard] ${row.id}: commits go out under the fallback author (${author.skipped.join("; ")})`)
    } else this.authorWarned.delete(row.id)
    if (author.note) this.noteOnce(row.id, `${row.id}:author-note`, author.note)
    return author
  }

  /** What a Codex turn of this project logs in with: its own CODEX_API_KEY, else Settings › Credentials' Codex login. */
  codexCredentials(projectId: string, taskEnv: Record<string, string> = {}): CodexTurnLogin {
    return codexTurnLogin({ ...this.store.projectEnv(projectId), ...taskEnv }, this.settings.credentials.codexLogin())
  }

  /** The credential set its project's tasks use (`credentialSet`): tasks of two sets never share a pool box. */
  private projectCreds(projectId: string): string {
    return credentialSet(projectId, this.store.projectEnv(projectId), this.identities.idOf(projectId))
  }

  /** The identity's name when `creds` is an identity's set (`identity:<id>`), else null. */
  private credsIdentity(creds: string): string | null {
    return creds.startsWith("identity:") ? (this.identities.nameOf(creds.slice("identity:".length)) ?? "another") : null
  }

  /** The credential set a pool box's workspaces were made with: its project's when it was made, else the global one. */
  private boxCreds(boxId: string): string {
    return this.store.getKv(boxCredsKey(boxId)) ?? GLOBAL_CREDENTIALS
  }

  private setBoxCreds(boxId: string, creds: string) {
    this.store.setKv(boxCredsKey(boxId), creds === GLOBAL_CREDENTIALS ? null : creds)
  }

  /** Why a task waits when the only boxes with room are of another credential set and no box can be made. */
  private walledReason(creds: string): string {
    const identity = this.credsIdentity(creds)
    return creds === GLOBAL_CREDENTIALS
      ? "Waiting for a box: the boxes with room belong to other identities or to projects with their own Claude login or GitHub token, and the pool is at its limit"
      : identity
        ? `Waiting for a box of its identity: tasks of the ${identity} identity never share a box with another identity's, and the pool is at its limit`
        : "Waiting for a box of its own: its project has its own Claude login or GitHub token, so it never shares a box with another project's tasks, and the pool is at its limit"
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

  /** A free Local agents slot that the projects' limits let this task take (`localWait`); else false, with the reason. */
  private localRoom(row: TaskRow): boolean {
    const wait = this.localWait(row)
    if (wait) this.setWaitReason(row.id, wait.text, null, wait.by)
    return !wait
  }

  /**
   * Its workspace is on its project's own box for `runner`: its GPU pod, or its Docker container; or on an SSH machine
   * that has the label it runs on (its own machine_label, else its project's).
   */
  private onOwnBox(row: TaskRow, runner: Runner): boolean {
    if (runner === "gpu") return isGpuBox(row.box_id) && gpuBoxProject(row.box_id!) === row.project_id
    if (runner === "docker") return isDockerBox(row.box_id) && dockerBoxProject(row.box_id!) === row.project_id
    if (runner === "ssh") {
      const m = isMachineBox(row.box_id) ? this.machineOf(row.box_id) : null
      return Boolean(m && machineMatches(m, this.store.taskMachineLabel(row)))
    }
    return false
  }

  /** A pod of its project's (`gpuSlot`), its project's container (`dockerSlot`) or an SSH machine (`machineSlot`) for its next turn, or null to wait. */
  private ownSlot(row: TaskRow, runner: OwnRunner): Promise<string | null> {
    return runner === "gpu" ? this.gpuSlot(row) : runner === "docker" ? this.dockerSlot(row) : this.machineSlot(row)
  }

  /** Where placement's log lines say a task went: "its project's Docker container", "SSH machine old-thinkpad". */
  private ownAt(runner: OwnRunner, boxId: string): string {
    return runner === "ssh" ? `SSH machine ${this.machineName(boxId)}` : OWN_BOX[runner].at(boxId)
  }

  /** "one of your SSH machines", `SSH machines labelled "gpu"`, "this computer": where a task should run, for its log. */
  private runnerPhrase(row: TaskRow, runner: Runner): string {
    return runner === "ssh" ? labelPhrase(this.store.taskMachineLabel(row)) : RUNNER_PHRASE[runner]
  }

  /**
   * A task of a project that runs on boxes of its own: RunPod GPU pods (shared/runpod.ts), `runpod-<projectId>[-<n>]`,
   * which `gpuTarget` picks, or its Docker container (shared/docker.ts), `docker-<projectId>`. Launch starts the pod
   * or container when it isn't up. A workspace still on a box or on this computer moves there when nothing would be
   * lost (`moveBlock`, no upload limit: a restore over SSH or docker exec has none); otherwise it stays where it is
   * ("stay" for a box; on this computer it keeps running there) and its log says why.
   */
  private async toOwnBox(row: TaskRow, runner: OwnRunner): Promise<string | null | "stay"> {
    const own = OWN_BOX[runner]
    if (this.onOwnBox(row, runner)) return this.ownSlot(row, runner)
    const said = row.runs_on ? own.asked : own.projectNow
    const why = said.charAt(0).toLowerCase() + said.slice(1)
    if (isLocalRunnerBox(row.box_id)) {
      if (this.archiving.has(row.id)) return null
      const block = row.session_started ? this.moveBlock(row, Infinity) : null
      if (block && this.c.archiveWorkspaces && !this.archiveHoldsWorkspace(row) && !this.archiveErrors.has(row.id)) {
        this.setWaitReason(row.id, `Waiting for its workspace on this computer to be archived, so it can move to ${own.to}`)
        void this.archive(row.id, { forMove: true }).finally(() => this.schedule())
        return null
      }
      if (block) {
        this.noteOnce(row.id, `${row.id}:${LOCAL_BOX_ID}:${runner}`, `${said}, but its workspace stays on this computer: it can't move safely (${block}).`)
        return this.localSlot(row)
      }
      const target = runner === "docker" ? await this.dockerTarget(row) : runner === "ssh" ? await this.machineTarget(row) : null
      if (runner !== "gpu" && !target) return null
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
      void this.removeTaskDir(LOCAL_BOX_ID, row.id).catch(() => {})
      this.addEvent(row.id, `Moved from this computer to ${runner === "gpu" ? "its project's GPU pod" : this.ownAt(runner, target!)}: ${why}.`)
      return !target ? this.ownSlot(row, runner) : runner === "ssh" ? this.machineAssign(row, target) : this.dockerAssign(row, target)
    }
    if (row.box_id && !ownRunnerOf(row.box_id)) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "creating") return null
      if (box?.status === "ready") {
        if (this.archiving.has(row.id)) return null
        const block = row.session_started ? this.moveBlock(row, Infinity) : null
        if (block) {
          this.noteOnce(row.id, `${row.id}:${box.id}:${runner}`, `${said}, but its workspace stays on box ${box.id}: it can't move safely (${block}).`)
          return "stay"
        }
        const target = runner === "gpu" ? await this.gpuTarget(row) : runner === "docker" ? await this.dockerTarget(row) : await this.machineTarget(row)
        if (!target) return null
        this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
        void this.removeTaskDir(box.id, row.id).catch(() => {})
        this.addEvent(row.id, `Moved from box ${box.id} to ${this.ownAt(runner, target)}: ${why}.`)
        return runner === "gpu" ? this.gpuAssign(row, target) : runner === "docker" ? this.dockerAssign(row, target) : this.machineAssign(row, target)
      }
      // Box is gone or lost; the workspace comes back from the archive, on the pod or in the container.
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    }
    return this.ownSlot(row, runner)
  }

  /**
   * A task on its project's GPU pod or Docker container whose project (or its own runs_on) moved to another runner:
   * it moves once its workspace is archived (the turn-end archive usually is) and, for a box, pushed and small
   * enough to upload. One that can't move stays where it is ("stay").
   */
  private async fromOwnBox(row: TaskRow, runner: Runner): Promise<string | null | "stay"> {
    const from = row.box_id!
    const own = OWN_BOX[ownRunnerOf(from)!]
    if (this.archiving.has(row.id)) return null
    const block = row.session_started ? this.moveBlock(row, runner === "box" ? MOVE_MAX_ARCHIVE_BYTES : Infinity) : null
    if (block && this.c.archiveWorkspaces && !this.archiveHoldsWorkspace(row) && !this.archiveErrors.has(row.id)) {
      this.setWaitReason(row.id, `Waiting for its workspace ${own.from} to be archived, so it can move`)
      void this.archive(row.id, { forMove: true }).finally(() => this.schedule())
      return null
    }
    if (block) {
      const stays = isMachineBox(from) ? `on SSH machine ${this.machineName(from)}` : own.stays
      this.noteOnce(row.id, `${row.id}:${from}:${runner}`, `It should run on ${this.runnerPhrase(row, runner)} now, but its workspace stays ${stays}: it can't move safely (${block}).`)
      return "stay"
    }
    let to: string | null
    if (runner === "local") {
      if (!this.localRoom(row)) return null
      to = LOCAL_BOX_ID
    } else if (runner === "gpu") {
      to = await this.gpuTarget(row)
      if (!to) return null
    } else if (runner === "docker") {
      to = await this.dockerTarget(row)
      if (!to) return null
    } else if (runner === "ssh") {
      to = await this.machineTarget(row)
      if (!to) return null
    } else {
      to = await this.pickBox(row.id)
      if (!to) return null
    }
    this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(from, row.id).catch(() => {})
    const fromText = isMachineBox(from) ? `SSH machine ${this.machineName(from)}` : own.stays.replace(/^(on|in) /, "")
    const toText = runner === "box" ? `box ${to}` : runner === "ssh" ? `SSH machine ${this.machineName(to)}` : RUNNER_PHRASE[runner]
    this.addEvent(row.id, `Moved from ${fromText} to ${toText}${runner === "ssh" && isMachineBox(from) ? `: it should run on ${this.runnerPhrase(row, runner)}` : ""}.`)
    return runner === "gpu" ? this.gpuAssign(row, to) : runner === "docker" ? this.dockerAssign(row, to) : runner === "ssh" ? this.machineAssign(row, to) : this.assign(row.id, to)
  }

  /** One of the project's GPU pods for a task's next turn, or null (with the reason) while it must wait. */
  private async gpuSlot(row: TaskRow): Promise<string | null> {
    const target = await this.gpuTarget(row)
    return target ? this.gpuAssign(row, target) : null
  }

  /**
   * Which of its project's pods a GPU task's next turn takes, or null with the reason, on the cloud its project's new
   * pods come from (`gpuCloudOf`: RunPod, Vast.ai or Daytona):
   * 1. its own pod while that's up: its workspace is there (it moves only when nothing would be lost, `canMove`),
   * 2. another of the project's pods that is up (or starting) and has a free slot,
   * 3. a new pod, while the project has fewer than its Max boxes (MAX_GPU_PODS when unset) and one more fits under
   *    the per-project and total $/hr caps (`gpuCapBlock`). Pods are `runpod-<projectId>` (#1), then `-2`, `-3`, …
   *    (`vastai-…` on Vast.ai, `daytona-…` on Daytona).
   * Slots per pod are its project's Agents per box, else its cloud's Agents per pod (`slotsFor`). A task whose pod is
   * on the other cloud (its project's cloud changed) moves when nothing would be lost, else keeps running there.
   */
  private async gpuTarget(row: TaskRow): Promise<string | null> {
    const projectId = row.project_id
    const kind = this.gpuCloudOf(projectId)
    const gpu = this.gpuRunnerOf(kind)
    const cloud = GPU_PROVIDER_LABEL[kind]
    if (!gpu) {
      this.setWaitReason(row.id, `Waiting: ${cloud} GPU isn't available on this Box Yard`)
      return null
    }
    if (!gpu.enabled()) {
      this.setWaitReason(row.id, GPU_NOT_SET_UP[kind])
      return null
    }
    const own = isGpuBox(row.box_id) && gpuBoxProject(row.box_id) === projectId ? row.box_id : null
    const ownKind = gpuBoxProvider(own)
    if (own && ownKind !== kind) {
      // Its workspace is on the project's pod on the other cloud: it stays there until it can move without loss.
      const old = this.gpuFor(own)
      const oldPods = old?.enabled() ? await this.gpuPods(old, row.id) : null
      if (old?.enabled() && !oldPods) return null
      if (oldPods?.some((p) => p.boxId === own) && !this.canMove(row)) {
        this.noteOnce(row.id, `${row.id}:${own}:${kind}`, `Its project now runs on ${cloud}, but its workspace stays on ${GPU_PROVIDER_LABEL[ownKind!]} GPU pod #${gpuBoxIndex(own)} until it can move safely (${this.moveBlock(row) ?? "it's being archived"}).`)
        return this.gpuRoom(row, own) ? own : null
      }
    }
    const pods = await this.gpuPods(gpu, row.id)
    if (!pods) return null
    const live = new Set(pods.map((p) => p.boxId))
    const mine = ownKind === kind ? own : null
    const onPod = mine && live.has(mine) ? mine : null
    if (onPod) {
      if (this.gpuRoom(row, onPod)) return onPod
      if (!this.canMove(row)) return null
    }
    const up = this.gpuBoxesUp(kind, projectId, live)
    const free = up.find((id) => id !== onPod && this.runningOn(id) < this.slotsFor(id) && !this.limitBlock(row, id))
    if (free) return free
    const max = this.gpuMaxPods(projectId)
    if (up.length >= max) {
      const set = this.store.projectBoxLimits(projectId).maxBoxes !== null
      this.setWaitReason(
        row.id,
        `Waiting for a free slot on its project's ${up.length === 1 ? "GPU pod" : `${up.length} GPU pods`} (${set ? `its Max boxes is ${max}` : `at most ${max} pods`}; its Tasks running at once, or ${GPU_SETTINGS_PATH[kind]} › Tasks running at once per pod)`,
      )
      return null
    }
    const block = await this.gpuCapBlock(gpu, projectId, pods, up)
    if (block) {
      this.gpuWait(row, block.kind, block.reason, block.fix)
      return null
    }
    // A new pod: the task's old one when it's in range (its number stays), else the first unused number.
    if (mine && !up.includes(mine) && gpuBoxIndex(mine) <= max) return mine
    for (let n = 1; n <= max; n++) if (!up.includes(gpuBoxIdOn(kind, projectId, n))) return gpuBoxIdOn(kind, projectId, n)
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
      const a = gpuBoxProvider(from)
      const b = gpuBoxProvider(target)
      if (row.session_started) {
        this.addEvent(
          row.id,
          a === b
            ? `Moved from GPU pod #${gpuBoxIndex(from)} to #${gpuBoxIndex(target)} of its project.`
            : `Moved from ${GPU_PROVIDER_LABEL[a!]} GPU pod #${gpuBoxIndex(from)} to ${GPU_PROVIDER_LABEL[b!]} GPU pod #${gpuBoxIndex(target)}: its project now runs on ${GPU_PROVIDER_LABEL[b!]}.`,
        )
      }
    }
    // The pod exposes one preview port per task folder (POD_HTTP_PORTS): park an archived, resting one for room.
    if (this.store.listTaskRows({ boxId: target }).length >= POD_HTTP_PORTS.length) this.evictOne(target, row.id)
    return this.assign(row.id, target)
  }

  private gpuRoom(row: TaskRow, boxId: string): boolean {
    if (this.runningOn(boxId) >= this.slotsFor(boxId)) {
      this.setWaitReason(row.id, gpuSlotWait(gpuBoxProvider(boxId) ?? "runpod"))
      return false
    }
    const limit = this.limitBlock(row, boxId)
    if (limit) this.setWaitReason(row.id, `Waiting: ${limit.text}`, null, limit.by)
    return !limit
  }

  /** This install's pods on one cloud (cached for a few seconds by the provider), or null with the reason when the cloud can't say. */
  private async gpuPods(gpu: GpuRunner, taskId?: string): Promise<GpuPods | null> {
    const kind = this.gpuKind(gpu)
    try {
      const pods = await gpu.provider.listPods()
      this.gpuSeenBy.set(kind, pods)
      return pods
    } catch (err) {
      if (taskId) this.setWaitReason(taskId, `Waiting: couldn't list the ${GPU_PROVIDER_LABEL[kind]} ${GPU_POD_NOUNS[kind]} (${errorMessage(err)})`)
      return null
    }
  }

  /** The project's pods on one cloud that are up or on their way (a turn holds a slot on it), by number. */
  private gpuBoxesUp(kind: GpuProvider, projectId: string, live: Set<string>): string[] {
    const ids = new Set([...live].filter((id) => gpuBoxProject(id) === projectId))
    for (const id of this.store.gpuBoxesInUse()) if (gpuBoxProject(id) === projectId && gpuBoxProvider(id) === kind) ids.add(id)
    return [...ids].sort((a, b) => gpuBoxIndex(a) - gpuBoxIndex(b))
  }

  /** The most pods a GPU project may have up at once: its Max boxes, else MAX_GPU_PODS (the $/hr caps bound it too). */
  private gpuMaxPods(projectId: string): number {
    return Math.min(MAX_GPU_PODS, this.store.projectBoxLimits(projectId).maxBoxes ?? MAX_GPU_PODS)
  }

  /**
   * Why the project can't have another pod now: it would take its pods over their $/hr cap (its own, else its cloud's
   * Max per project), or every pod of this install on that cloud over the cloud's total cap. A pod counts at its
   * cloud's price, one still starting at the next pod's price. Null when it fits, or when the prices can't be read
   * (the pod start checks the caps again).
   */
  private async gpuCapBlock(gpu: GpuRunner, projectId: string, pods: GpuPods, up: string[]): Promise<{ kind: string; reason: string; fix?: WaitFix } | null> {
    const cloudKind = this.gpuKind(gpu)
    const cloud = GPU_PROVIDER_LABEL[cloudKind]
    if (gpu.metered) {
      const limit = this.cloudBlock()
      if (limit) return { kind: "cloud", reason: `${cloud} ${GPU_POD_NOUNS[cloudKind]} count toward the cloud limit, and ${limit.text}`, fix: limit.fix }
    }
    let next: Awaited<ReturnType<GpuPodProvider["nextPodPrice"]>>
    try {
      next = await gpu.provider.nextPodPrice(projectId)
    } catch {
      return null
    }
    const cap = gpu.provider.capOf(projectId)
    const name = this.store.getProjectName(projectId) ?? projectId
    if (!next) {
      return {
        kind: "cap",
        reason:
          cloudKind === "vast"
            ? `Vast.ai cap $${cap}/hr is below every offer for the GPU types in Settings › Vast.ai GPU, or none is rentable right now (${gpuCapHow(cloudKind)})`
            : cloudKind === "daytona"
              ? `Daytona cap $${cap}/hr is below the price of the sandbox Settings › Daytona asks for (${gpuCapHow(cloudKind)})`
              : `RunPod cap $${cap}/hr is below the price of every GPU type in Settings › RunPod GPU (${gpuCapHow(cloudKind)})`,
      }
    }
    const cost = (id: string) => pods.find((p) => p.boxId === id)?.pod.cost ?? next.usd
    const usd = (n: number) => `$${Math.round(n * 100) / 100}/hr`
    const mine = up.reduce((sum, id) => sum + cost(id), 0)
    const pods_ = (n: number) => (n === 1 ? "pod costs" : `${n} pods cost`)
    if (cap && mine + next.usd > cap + 1e-9) {
      return { kind: "cap", reason: `${cloud} cap $${cap}/hr reached: ${name}'s ${pods_(up.length)} ${usd(mine)} and another ${next.gpu} is ${usd(next.usd)} (${gpuCapHow(cloudKind)})` }
    }
    const total = gpu.settings().totalMaxHourlyUsd
    const all = new Set([...pods.map((p) => p.boxId), ...this.store.gpuBoxesInUse().filter((id) => gpuBoxProvider(id) === cloudKind)])
    const spend = [...all].reduce((sum, id) => sum + cost(id), 0)
    if (total && spend + next.usd > total + 1e-9) {
      return {
        kind: "total",
        reason: `${cloud} total cap $${total}/hr reached: this Box Yard's ${pods_(all.size)} ${usd(spend)} and another ${next.gpu} is ${usd(next.usd)} (${GPU_SETTINGS_PATH[cloudKind]} › Max for all pods)`,
      }
    }
    return null
  }

  /** A GPU task waits for a pod a cap rules out: the reason on the task, and its Captain hears it once. */
  private gpuWait(row: TaskRow, kind: string, reason: string, fix: WaitFix | null = null) {
    this.setWaitReason(row.id, `Waiting: ${reason}`, null, [], fix)
    if (this.gpuWaitNoticed.get(row.id) === kind) return
    this.gpuWaitNoticed.set(row.id, kind)
    this.notice(`⚠️ **${row.title}** waits: ${reason}.`, { taskId: row.id, projectIds: [row.project_id] })
  }

  /** Its project's container for a Docker task's next turn, or null (with the reason) while it must wait. */
  private async dockerSlot(row: TaskRow): Promise<string | null> {
    const target = await this.dockerTarget(row)
    return target ? this.dockerAssign(row, target) : null
  }

  /**
   * A Docker task's next turn runs in its project's one container, `docker-<projectId>` (launch makes or starts it),
   * when Docker is up and the container has a free slot (its project's Tasks running at once, else Settings › Docker ›
   * Tasks running at once per container); else null with the reason. Never anywhere else: it waits for Docker rather than run
   * outside a container.
   */
  private async dockerTarget(row: TaskRow): Promise<string | null> {
    if (!this.docker) {
      this.setWaitReason(row.id, "Waiting: Docker containers aren't available on this Box Yard")
      return null
    }
    const problem = (await this.docker.problem()) ?? this.dockerClaudeProblem(row)
    if (problem) {
      this.dockerWait(row, problem)
      return null
    }
    const target = dockerBoxId(row.project_id)
    if (this.runningOn(target) >= this.slotsFor(target)) {
      this.setWaitReason(row.id, DOCKER_SLOT_WAIT)
      return null
    }
    const limit = this.limitBlock(row, target)
    if (limit) {
      this.setWaitReason(row.id, `Waiting: ${limit.text}`, null, limit.by)
      return null
    }
    return target
  }

  /**
   * A Docker task's turns need a Claude key (its env, its project's or identity's, or Settings › Credentials): a
   * container can't use this computer's login. Asked of turnCredentials, so it's the key the turn would really get.
   */
  private dockerClaudeProblem(row: TaskRow): string | null {
    if (this.c.mock) return null
    if (taskAgentCli(row) === "codex") return this.codexCredentials(row.project_id, this.store.taskEnv(row.id)).kind ? null : DOCKER_NEEDS_CODEX_KEY
    return this.turnCredentials(row.project_id, this.store.taskEnv(row.id)).claudeFrom ? null : DOCKER_NEEDS_CLAUDE_KEY
  }

  /** Put a task in its project's container. A full one (DOCKER_MAX_TASKS folders, one preview port each) parks an archived, resting one. */
  private dockerAssign(row: TaskRow, target: string): string {
    this.dockerWaitNoticed.delete(row.id)
    if (this.store.getTaskRow(row.id)?.box_id === target) return target
    if (this.store.listTaskRows({ boxId: target }).length >= DOCKER_MAX_TASKS) this.evictOne(target, row.id)
    return this.assign(row.id, target)
  }

  /** A Docker task waits for Docker (not installed, or not running): the reason on the task, and its Captain hears it once. */
  private dockerWait(row: TaskRow, reason: string) {
    this.setWaitReason(row.id, `Waiting: ${reason}`)
    if (this.dockerWaitNoticed.get(row.id) === reason) return
    this.dockerWaitNoticed.set(row.id, reason)
    this.notice(`⚠️ **${row.title}** waits: ${reason}.`, { taskId: row.id, projectIds: [row.project_id] })
  }

  // ------------------------------------------------------------------ SSH machines (docs/machines.md)

  /** A machine by its box id, `ssh-<machineId>`; null when it was removed (or this install has no SSH runner). */
  private machineOf(boxId: string | null | undefined): Machine | null {
    return isMachineBox(boxId) && this.machines ? this.machines.get(machineOfBox(boxId)) : null
  }

  /** "old-thinkpad", or the machine's id when it was removed. */
  machineName(boxId: string): string {
    return this.machineOf(boxId)?.name ?? machineOfBox(boxId)
  }

  /** An SSH machine for a task's next turn (`machineTarget`), or null (with the reason) while it must wait. */
  private async machineSlot(row: TaskRow): Promise<string | null> {
    const target = await this.machineTarget(row)
    return target ? this.machineAssign(row, target) : null
  }

  /**
   * Which SSH machine a task's next turn takes (`pickMachine`, shared/machines.ts), or null with the reason: one with
   * the label it runs on (its own machine_label, else its project's; none: any machine), that works (enabled, tested,
   * answered lately), has a Claude login to use (a Claude key Box Yard forwards, else the machine's own login) and a
   * free slot: its Tasks running at once, and the projects' Agents at once and Needs the whole machine (`limitBlock`).
   * Its workspace's machine first; it moves to another only when nothing would be lost (`moveBlock`, no upload limit).
   * A Codex task never gets one: it waits with CODEX_ON_MACHINES.
   */
  private async machineTarget(row: TaskRow): Promise<string | null> {
    if (!this.machines) {
      this.setWaitReason(row.id, "Waiting: SSH machines aren't available on this Box Yard")
      return null
    }
    const current = isMachineBox(row.box_id) ? machineOfBox(row.box_id) : null
    // A turn-end archive being written right now: it can move in a moment, so it doesn't count as stuck there.
    const canMove = !current || !row.session_started || (!this.archiving.has(row.id) && this.moveBlock(row, Infinity) === null)
    const machines = this.machines.list().map((m): MachineCandidate => {
      const boxId = machineBoxId(m.id)
      const limit = this.limitBlock(row, boxId)
      return {
        id: m.id,
        name: m.name,
        labels: m.labels,
        enabled: m.enabled,
        problem: m.enabled ? this.machines!.problem(m) : null,
        claudeLogin: m.lastTest?.claudeLogin ?? null,
        maxTasks: m.maxTasks,
        running: this.runningOn(boxId),
        blocked: limit ? limit.text : null,
      }
    })
    const claudeKey = this.c.mock || this.turnCredentials(row.project_id, this.store.taskEnv(row.id)).claudeFrom !== null
    const pick = pickMachine({ machines, label: this.store.taskMachineLabel(row), current, canMove, claudeKey, cli: taskAgentCli(row) })
    if ("wait" in pick) {
      this.machineWait(row, pick)
      return null
    }
    return machineBoxId(pick.machineId)
  }

  /** Put a task on the machine `machineTarget` picked. One moving off another machine restores there from its archive. */
  private machineAssign(row: TaskRow, target: string): string {
    this.machineWaitNoticed.delete(row.id)
    const from = this.store.getTaskRow(row.id)?.box_id ?? null
    if (from === target) return target
    if (isMachineBox(from)) {
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] })
      void this.removeTaskDir(from, row.id).catch(() => {})
      if (row.session_started) this.addEvent(row.id, `Moved from SSH machine ${this.machineName(from)} to ${this.machineName(target)}: ${this.machineOf(from) ? "the first has no free slot" : "its machine was removed"}.`)
    }
    return this.assign(row.id, target)
  }

  /**
   * A task waits for an SSH machine: the reason on the task, and its Captain hears it once per kind of wait when no
   * machine can take it (none has the label, none works, no Claude login, a Codex task). A busy one is only a queue:
   * no notice.
   */
  private machineWait(row: TaskRow, pick: Extract<MachinePick, { wait: string }>) {
    this.setWaitReason(row.id, pick.wait)
    if (pick.kind === "busy" || this.machineWaitNoticed.get(row.id) === pick.kind) return
    this.machineWaitNoticed.set(row.id, pick.kind)
    this.notice(`⚠️ **${row.title}** waits: ${pick.wait.replace(/^Waiting:? /, "")}.`, { taskId: row.id, projectIds: [row.project_id] })
  }

  /** A machine was added or removed (Settings › Machines, add_machine, remove_machine), for the box history. */
  machineEvent(e: { machine: Pick<Machine, "id" | "name" | "host" | "user" | "port">; kind: "created" | "deleted" | "lost"; actor: BoxActor; reason: string; detail?: string }) {
    const boxId = machineBoxId(e.machine.id)
    this.recordBoxEvent({
      boxId,
      boxName: machineLabel(e.machine.name, boxId),
      type: e.kind,
      actor: e.actor,
      reason: e.reason,
      detail: e.detail ?? `${e.machine.user}@${e.machine.host}${e.machine.port === 22 ? "" : `:${e.machine.port}`}`,
      size: null,
    })
  }

  /**
   * Before a machine is removed from Box Yard: refused while an agent runs there; otherwise each task folder on it is
   * archived (unless its archive already holds it) and let go, so its task restores elsewhere on its next turn. One
   * that can't be archived (the machine is offline) stops it, unless `force` (Cody only): those tasks then restart
   * from their last archive, or a recap. The folders on the machine are removed when it can be reached.
   */
  async releaseMachine(machineId: string, opts: { force?: boolean } = {}): Promise<{ moved: string[]; lost: string[] }> {
    const boxId = machineBoxId(machineId)
    const rows = this.store.listTaskRows({ boxId })
    const busy = rows.filter((r) => r.current_turn_id || r.status === "starting")
    if (busy.length) throw new ConflictError(`An agent is running on it (${busy.map((r) => r.title).join(", ")}): stop it first, or turn the machine off so no new turns start there.`)
    const lost: string[] = []
    for (const r of rows) {
      if (!r.session_started) continue
      await this.archiveUnlessHeld(r.id).catch(() => {})
      const fresh = this.store.getTaskRow(r.id)
      if (fresh && !this.archiveHoldsWorkspace(fresh)) lost.push(r.id)
    }
    if (lost.length && !opts.force) {
      const titles = lost.map((id) => this.store.getTaskRow(id)?.title ?? id)
      throw new ConflictError(`Its workspaces couldn't all be archived first (${titles.join(", ")}): test the connection and try again, or remove it anyway (they restart from their last archive or a recap).`)
    }
    for (const r of rows) {
      this.store.updateTask(r.id, { boxId: null, portBase: null, previews: [] })
      void this.removeTaskDir(boxId, r.id).catch(() => {})
      this.addEvent(r.id, `Its SSH machine ${this.machineName(boxId)} was removed from Box Yard; ${lost.includes(r.id) ? "its workspace there couldn't be archived, so it restarts from its last archive or a recap" : "its workspace comes back from the archive"} on its next turn.`)
      this.emitTask(r.id)
    }
    return { moved: rows.filter((r) => !lost.includes(r.id)).map((r) => r.id), lost }
  }

  /** A Docker container was made or started (DockerProvider), or stopped, deleted or lost (here), for the box history. */
  dockerEvent(e: { boxId: string; kind: "created" | "started" | "stopped" | "deleted" | "lost"; detail: string; actor?: BoxActor; reason?: string }) {
    const reasons = {
      created: "A task of a Docker project needed its container.",
      started: "A task of a Docker project needed its stopped container.",
      stopped: "The container was stopped.",
      deleted: "The container was deleted.",
      lost: "The container went away.",
    }
    this.recordBoxEvent({
      boxId: e.boxId,
      boxName: dockerLabel(e.boxId, this.store.getProjectName(dockerBoxProject(e.boxId))),
      type: e.kind,
      actor: e.actor ?? { kind: e.kind === "created" || e.kind === "started" ? "scheduler" : "provider" },
      reason: e.reason ?? reasons[e.kind],
      detail: e.detail,
      size: null,
    })
  }

  /**
   * Stop a Docker project's container now (Stop in Settings › Docker, or the idle sweep). Nothing is archived: its
   * volume keeps every workspace, and the next turn starts it again. Refused while an agent runs in it.
   */
  async stopDockerContainer(boxId: string, opts: { actor: BoxActor; reason: string }): Promise<void> {
    if (!this.docker || !isDockerBox(boxId)) throw new BadRequestError(`${boxId} isn't a Docker container of this Box Yard`)
    if (this.store.listTaskRows({ boxId }).some((r) => r.current_turn_id || r.status === "starting")) throw new ConflictError("An agent is running in that container; stop it first")
    const was = (await this.docker.provider.list()).find((c) => c.boxId === boxId)
    if (was?.state !== "running") return
    await this.docker.provider.stop(boxId)
    this.dockerEvent({ boxId, kind: "stopped", detail: `Stopped ${was.name}; its volume keeps every workspace.`, actor: opts.actor, reason: opts.reason })
  }

  /**
   * Delete a Docker project's container and its volume (Delete in Settings › Docker, delete_box). Every started
   * workspace is archived first (one whose PR is merged and fully pushed needs none); if one can't be, nothing is
   * deleted. Its tasks restore from their archive on their next turn, in a new container. The image stays.
   */
  private async deleteDockerContainer(boxId: string, opts: { actor: BoxActor; reason: string }): Promise<Pick<BoxDeleteResult, "archived" | "fromGitHub">> {
    if (!this.docker) throw new BadRequestError("Docker containers aren't available on this Box Yard")
    const archived: string[] = []
    const fromGitHub: string[] = []
    const kept: string[] = []
    for (const row of this.store.listTaskRows({ boxId })) {
      if (!row.session_started) continue
      if (await this.skipArchiveIfPushed(row.id, boxId, `delete its Docker container`)) {
        fromGitHub.push(row.id)
        continue
      }
      await this.archiveUnlessHeld(row.id).catch(() => {})
      const fresh = this.store.getTaskRow(row.id)
      if (fresh && !this.archiveHoldsWorkspace(fresh)) kept.push(fresh.id)
      else archived.push(row.id)
    }
    if (kept.length) throw new ConflictError(`${couldntArchive(kept)}, so its Docker container was not deleted: ${this.archiveProblems(kept)}`)
    const name = (await this.docker.provider.list().catch(() => [])).find((c) => c.boxId === boxId)?.name ?? boxId
    await this.docker.provider.destroy(boxId)
    // Their folders went with the volume: each restores from its archive on its next turn, in a new container.
    for (const row of this.store.listTaskRows({ boxId })) {
      this.store.updateTask(row.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
      this.emitTask(row.id)
    }
    this.dockerEvent({ boxId, kind: "deleted", detail: `Deleted ${name} and its volume; the image stays.`, actor: opts.actor, reason: opts.reason })
    return { archived, fromGitHub }
  }

  /**
   * Remove a Docker container and its volume with nothing to keep: its project was deleted (with its tasks). When
   * Docker can't be asked now, the minute sweep removes it later.
   */
  private async dropDockerContainer(projectId: string, actor: BoxActor, reason: string, known?: DockerContainerState) {
    if (!this.docker) return
    const boxId = dockerBoxId(projectId)
    const c = known ?? (await this.docker.provider.list(true).catch(() => [])).find((x) => x.boxId === boxId)
    if (!c) return
    try {
      await this.docker.provider.destroy(boxId)
    } catch (err) {
      console.warn(`[box-yard] delete Docker container ${c.name}: ${errorMessage(err)}`)
      return
    }
    this.dockerEvent({ boxId, kind: "deleted", detail: `Deleted ${c.name} and its volume; the image stays.`, actor, reason })
  }

  /**
   * Once a minute: stop Docker containers with no turn running, starting or waiting for Settings › Docker › Stop when
   * idle, and remove ones whose project was deleted. Nothing needs archiving first: the volume keeps every
   * workspace, and the next turn starts it again. Docker isn't asked at all while nothing uses it (after a first look).
   */
  private async sweepDocker(now: number) {
    if (!this.docker || now - this.lastDockerSweepAt < 60_000) return
    const first = this.lastDockerSweepAt === 0
    this.lastDockerSweepAt = now
    const used = this.docker.provider.cached().length > 0 || this.store.dockerBoxesInUse().length > 0 || this.store.listProjects().some((p) => p.runner === "docker")
    if (!first && !used) return
    const s = this.docker.settings()
    if (await this.docker.problem()) return
    let containers: DockerContainerState[]
    try {
      containers = await this.docker.provider.list(true)
    } catch (err) {
      console.warn(`[box-yard] Docker containers: ${errorMessage(err)}`)
      return
    }
    for (const c of containers) {
      if (!this.store.getProject(c.projectId)) {
        await this.dropDockerContainer(c.projectId, { kind: "orphan-sweep" }, "Its project no longer exists.", c)
        continue
      }
      if (c.state !== "running" || s.idleMinutes <= 0) continue
      const residents = this.store.listTaskRows({ boxId: c.boxId })
      if (residents.some((r) => r.current_turn_id || r.status === "starting")) continue
      if (this.store.listTaskRows({ projectId: c.projectId }).some((r) => this.wantsTurn(r) && this.store.taskRunner(r) === "docker")) continue
      const started = c.startedAt ? Date.parse(c.startedAt) || now : now
      const lastUse = Math.max(started, ...residents.map((r) => r.last_active_at))
      if (now - lastUse < s.idleMinutes * 60_000) continue
      console.log(`[box-yard] stopping idle Docker container ${c.name}`)
      await this.stopDockerContainer(c.boxId, {
        actor: { kind: "janitor" },
        reason: `Idle for ${Math.round((now - lastUse) / 60_000)} min (Settings › Docker stops containers after ${s.idleMinutes} min); its volume keeps every workspace.`,
      }).catch((err) => console.warn(`[box-yard] stop Docker container ${c.name}: ${errorMessage(err)}`))
    }
  }

  /** Progress while a GPU pod or Docker container starts: one line in the log of each task starting on it. */
  startProgress(boxId: string, message: string) {
    for (const row of this.store.listTaskRows({ boxId })) {
      if (row.status === "starting") this.addEvent(row.id, `${message}…`)
    }
  }

  /** A GPU pod started or was terminated (by RunPodProvider, VastProvider or DaytonaProvider), for the box history. */
  gpuPodEvent(e: { boxId: string; kind: "started" | "terminated"; detail: string; actor?: BoxActor; reason?: string }) {
    // Box Yard is terminating it (stopGpuPod): that one row, with who and why, takes the provider's detail.
    if (e.kind === "terminated" && !e.actor && this.gpuTerminating.has(e.boxId)) {
      this.gpuTerminating.set(e.boxId, e.detail)
      return
    }
    this.recordBoxEvent({
      boxId: e.boxId,
      boxName: gpuPodLabel(e.boxId, this.store.getProjectName(gpuBoxProject(e.boxId))),
      type: e.kind === "started" ? "created" : "deleted",
      actor: e.actor ?? { kind: e.kind === "started" ? "scheduler" : "provider" },
      reason: e.reason ?? (e.kind === "started" ? `A task of a ${GPU_PROVIDER_LABEL[gpuBoxProvider(e.boxId) ?? "runpod"]} GPU project needed its pod.` : "The pod was terminated."),
      detail: e.detail,
      size: null,
    })
  }

  /**
   * Terminate a GPU pod now (Terminate pod, delete_box, or the idle sweep); a RunPod pod's network volume stays, a
   * Vast.ai instance's or Daytona sandbox's disk goes with it. Its workspaces must be in their archives: running turns are never stopped,
   * and a task without a fresh archive is archived first.
   */
  async stopGpuPod(boxId: string, opts: { actor: BoxActor; reason: string; force?: boolean }): Promise<void> {
    const gpu = this.gpuFor(boxId)
    const kind = gpuBoxProvider(boxId) ?? "runpod"
    if (!gpu) throw new BadRequestError(`${GPU_PROVIDER_LABEL[kind]} ${kind === "daytona" ? "sandboxes aren't" : "GPU isn't"} available on this Box Yard`)
    const residents = this.store.listTaskRows({ boxId })
    if (!opts.force && residents.some((r) => r.current_turn_id || r.status === "starting")) throw new ConflictError("An agent is running on that pod; stop it first")
    for (const r of residents) if (r.session_started) await this.archiveUnlessHeld(r.id).catch(() => {})
    const unsaved = this.store.listTaskRows({ boxId }).filter((r) => r.session_started && !this.archiveHoldsWorkspace(r))
    if (unsaved.length && !opts.force) throw new ConflictError(`Couldn't archive ${unsaved.map((r) => r.id).join(", ")}; the pod stays up so nothing is lost`)
    this.gpuTerminating.set(boxId, null)
    let detail: string | null = null
    try {
      await gpu.provider.destroy(boxId)
    } finally {
      detail = this.gpuTerminating.get(boxId) ?? null
      this.gpuTerminating.delete(boxId)
    }
    this.gpuTouchedAt.delete(boxId)
    const after = kind === "runpod" ? "Its network volume stays." : "Its disk went with it; every workspace is in its archive."
    this.gpuPodEvent({ boxId, kind: "terminated", detail: `${detail ? `${detail}. ` : ""}${after}`, actor: opts.actor, reason: opts.reason })
  }

  /**
   * Once a minute: stop GPU pods idle for their cloud's Stop when idle (no turn running or waiting, every workspace
   * archived, past any keep-warm), and touch the heartbeat of the others, so a pod's own watchdog (runpod/watchdog.sh,
   * vast/watchdog.sh) only fires when this Box Yard has gone quiet (the computer slept).
   */
  private async sweepGpuPods(now: number) {
    const runners = this.gpuRunners().filter((g) => g.enabled())
    if (!runners.length || now - this.lastGpuSweepAt < 60_000) return
    this.lastGpuSweepAt = now
    for (const gpu of runners) await this.sweepGpuCloud(gpu, now)
  }

  private async sweepGpuCloud(gpu: GpuRunner, now: number) {
    const kind = this.gpuKind(gpu)
    const where = GPU_SETTINGS_PATH[kind]
    const s = gpu.settings()
    let pods: GpuPods
    try {
      pods = await gpu.provider.listPods(true)
    } catch (err) {
      console.warn(`[box-yard] ${GPU_PROVIDER_LABEL[kind]} ${GPU_POD_NOUNS[kind]}: ${errorMessage(err)}`)
      return
    }
    this.gpuSeenBy.set(kind, pods)
    if (gpu.metered) this.meterGpuPods(kind, pods, now)
    const live = new Set(this.gpuSeen.map((p) => p.boxId))
    for (const { boxId, pod } of pods) {
      if (pod.status !== "RUNNING") continue
      const residents = this.store.listTaskRows({ boxId })
      const busy = residents.some((r) => r.current_turn_id || r.status === "starting")
      // Each pod stops on its own: it stays for a task of its own that waits, or for one of its project's that waits
      // for any pod on this cloud (not one whose workspace is on another pod) while it has a free slot.
      const room = this.runningOn(boxId) < this.slotsFor(boxId)
      const projectId = gpuBoxProject(boxId)
      const waiting =
        residents.some((r) => this.wantsTurn(r)) ||
        (room &&
          this.gpuCloudOf(projectId) === kind &&
          this.store
            .listTaskRows({ projectId })
            .some((r) => this.wantsTurn(r) && this.store.taskRunner(r) === "gpu" && !(isGpuBox(r.box_id) && r.box_id !== boxId && live.has(r.box_id))))
      const started = pod.startedAt ? Date.parse(pod.startedAt) : now
      const lastUse = Math.max(started || 0, ...residents.map((r) => r.last_active_at))
      const warm = gpu.keepWarmUntil(boxId) ?? 0
      const idleMs = now - lastUse
      if (!busy && !waiting && warm < now && idleMs >= s.idleMinutes * 60_000) {
        const unsaved = residents.filter((r) => r.session_started && !this.archiveHoldsWorkspace(r))
        if (unsaved.length) {
          for (const r of unsaved) if (!this.archiving.has(r.id) && !this.archiveErrors.has(r.id)) void this.archive(r.id)
        } else {
          console.log(`[box-yard] stopping idle GPU pod ${pod.id} (${boxId})`)
          await this.stopGpuPod(boxId, {
            actor: { kind: "janitor" },
            reason: `Idle for ${Math.round(idleMs / 60_000)} min (${where} stops pods after ${s.idleMinutes} min); every workspace was archived.`,
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

  /**
   * Record what a metered cloud's pods cost since they were last metered (or started) as box usage at their $/hr, so
   * they count toward Settings › Usage › Daily cloud limit and show in the cloud meter's spend. Runs with the sweep,
   * once a minute; a pod that's gone keeps what was recorded.
   */
  private meterGpuPods(kind: GpuProvider, pods: GpuPods, now: number) {
    for (const { boxId, pod } of pods) {
      if ((pod.status !== "RUNNING" && pod.status !== "STARTING") || !pod.cost) continue
      const started = pod.startedAt ? Date.parse(pod.startedAt) : NaN
      const from = Math.max(this.store.lastBoxUsageEnd(boxId) ?? 0, Number.isFinite(started) ? started : now - 60_000)
      if (now - from < 1000) continue
      this.store.recordBoxUsageInterval({
        boxId,
        provider: kind,
        size: "small",
        keepAlive: false,
        startedAt: from,
        endedAt: now,
        activeMs: 0,
        uptimeMs: now - from,
        diskBytes: null,
        source: "estimated",
        computeUsd: (pod.cost * (now - from)) / 3_600_000,
      })
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
   * 3. another project's idle box, given to this project (`reuseIdleBox`),
   * 4. nothing yet, when the pool has room: a new box is made for the project,
   * 5. a free slot on a box another project uses (no new box can be made, or the new one waits on Cody's OK).
   * Only boxes of at least the project's box size count (`minBoxSize`); when none has a free slot and the pool
   * is full, `ensureSizedBox` grows an idle box or the task waits with the reason. A project at its own Max boxes
   * only uses the boxes it already has, and a box's agents and task folders are capped by the strictest of its own
   * limit, the task's project's and those of the projects already there (`limitBlock`, `residentCap`).
   * A box without enough free disk for a new workspace is skipped and cleaned up
   * in the background; the task waits for that cleanup only when no other box
   * (or new one) can take it.
   * Returns null to wait; `wantsBox` tells the scheduler to grow the pool.
   */
  private async pickBox(taskId: string, exclude?: string, busyHere: Wait | null = null, waitHere: string | null = null): Promise<string | null> {
    this.pickedHow.delete(taskId)
    const row = this.store.getTaskRow(taskId)
    const projectId = row?.project_id
    const preferred = projectId ? this.store.getKv(projectBoxKey(projectId)) : null
    const min = this.minBoxSize(projectId)
    const cap = projectId ? this.projectBoxCap(projectId, taskId) : null
    const creds = projectId ? this.projectCreds(projectId) : GLOBAL_CREDENTIALS
    const fitting = this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && b.id !== exclude && !this.boxOps.has(b.id) && sizeFits(b.size, min) && (!cap?.full || cap.used.has(b.id)))
    // The box wall: only boxes of its project's credential set.
    const walled = fitting.some((b) => this.boxCreds(b.id) !== creds)
    const candidates = fitting
      .filter((b) => this.boxCreds(b.id) === creds)
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
    const busy: Wait[] = busyHere ? [busyHere] : []
    // A new box may be made for it: the pool has room, and so does its project (its own Max boxes).
    const canGrow = this.poolHasRoom() && !cap?.full
    // How the box it lands on was picked: a new one made while it waited, or a slot beside another project.
    const how = (b: { id: string; rank: number }): BoxPick | null => (b.rank === 2 ? "shared" : this.madeFor.get(b.id)?.has(taskId) ? "new" : null)
    let reuseTried = false
    for (const b of candidates) {
      if (b.rank === 2 && !reuseTried && row) {
        // Its project has no box with room: another project's idle box goes to it before a new one is made.
        reuseTried = true
        const reused = await this.reuseIdleBox(row, candidates.filter((c) => c.rank === 2).map((c) => c.id))
        if (reused) {
          this.wantsBox.delete(taskId)
          this.holdForDisk(taskId, [])
          this.pickedHow.set(taskId, "reused")
          return reused
        }
      }
      // Rather than crowd another project's box, make one for this project. One whose new box waits on Cody's OK
      // (past the hour's free ones) takes a free slot beside another project meanwhile.
      if (b.rank === 2 && canGrow && !this.fanoutHeld.has(taskId)) {
        this.wantsBox.add(taskId)
        this.holdForDisk(taskId, low, busy[0], waitHere)
        return null
      }
      if (b.residents >= b.maxResidentPerBox && !this.canEvict(b.id, taskId)) continue
      const why = row ? (this.limitBlock(row, b.id) ?? asWait(await this.memoryBlock(b.id, taskId))) : null
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
        const picked = how(b)
        if (picked) this.pickedHow.set(taskId, picked)
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
        const picked = how(cleaned)
        if (picked) this.pickedHow.set(taskId, picked)
        return cleaned.id
      }
      // No box of the project's size has a free slot and the pool (or the project) can't grow.
      if (min && !candidates.length && row) {
        await this.ensureSizedBox(row, min, cap?.full ? cap : null)
        return null
      }
    }
    // Every box of its size is full and none can be added: say so rather than wait without a reason.
    const poolFull = !this.wantsBox.has(taskId) && !canGrow ? (cap?.full ? this.projectFullReason(projectId!, cap.max) : walled && !candidates.length ? this.walledReason(creds) : this.noNewBoxReason()) : null
    // A cloud limit is named on any wait it causes; the ceiling's fix only goes with the reason that says the pool is full.
    const noBox = !canGrow && !cap?.full ? (this.cloudBlock() ?? (!busy[0] && !low.length && !waitHere ? this.noNewBox() : null)) : null
    this.holdForDisk(taskId, low, busy[0], waitHere ?? poolFull, noBox)
    return null
  }

  /**
   * The smallest box a project's tasks may run on: the project's own box size (projects.box_size, set on the
   * project's settings), else the size auto-sizing picked from its runs (`autoBoxSize`), or null when neither says and
   * any box will do. Boxes go small < medium < large.
   */
  private minBoxSize(projectId?: string | null): BoxSize | null {
    return (projectId ? (this.store.getProject(projectId)?.boxSize ?? this.autoSizeOf(projectId)) : null) ?? null
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
    const cloud = own ? null : this.cloudBlock()
    const full = own ? `${this.store.getProjectName(row.project_id) ?? row.project_id} is at its limit of ${boxCount(own.max)}` : (cloud?.text ?? "the pool is full")
    const pending = this.sizedBoxComing(min, own?.used)
    if (pending) return this.setWaitReason(row.id, `${waitFor}: ${pending}`, min)
    // Settings › Resize an idle box when no big-enough box is free (off by default): off, the task just waits.
    if (!this.settings.get().placementResizeEnabled) return this.setWaitReason(row.id, `${waitFor}: ${full} and none has room`, min)
    const creds = this.projectCreds(row.project_id)
    const idle = this.idleBoxesBelow(min).filter((b) => (!own || own.used.has(b.id)) && this.boxCreds(b.id) === creds)
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
    this.setWaitReason(row.id, `${waitFor}: ${full} and no box is idle to resize`, min, [], cloud?.fix ?? null)
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
  private holdForDisk(taskId: string, low: { boxId: string; state: "running" | "exhausted" }[], busy?: Wait | null, waitHere?: string | null, noBox?: { text: string; fix: WaitFix } | null) {
    const first = low[0]
    let reason: string | null = null
    if (!first && busy) reason = this.wantsBox.has(taskId) ? `Waiting for a new box: ${busy.text}` : `Waiting: ${busy.text}`
    else if (!first && waitHere) reason = this.wantsBox.has(taskId) ? `${waitHere} or a new box` : waitHere
    if (first) {
      if (this.wantsBox.has(taskId)) reason = `Waiting for a new box: ${first.boxId} is low on disk`
      else if (first.state === "running" || low.some((l) => this.janitor.isRunning(l.boxId))) {
        reason = `Waiting for disk cleanup on ${low.find((l) => this.janitor.isRunning(l.boxId))?.boxId ?? first.boxId}`
      } else reason = `Waiting for disk space on ${first.boxId}: cleanup couldn't free enough room`
    }
    // A cloud limit is why no new box helps: the reason says so, and the task offers the fix.
    if (reason && noBox && !reason.includes(noBox.text)) reason = `${reason}; no new box: ${noBox.text}`
    // Its new box waits on Cody's OK for more boxes than the hour's free ones (askForMoreBoxes).
    const held = !reason && this.wantsBox.has(taskId) && this.fanoutHeld.has(taskId)
    if (held) reason = this.fanoutWait()
    this.setWaitReason(taskId, reason, null, !first && busy ? busy.by : [], reason && noBox ? noBox.fix : held ? "allow-boxes" : null)
  }

  /** `by`: the tasks the reason names as holding it back, in its order (Task.waitFor), so the UI can link them. */
  private setWaitReason(taskId: string, reason: string | null, size: BoxSize | null = null, by: WaitFor[] = [], fix: WaitFix | null = null) {
    const row = this.store.getTaskRow(taskId)
    const waitFor = reason ? by : []
    const waitFix = reason ? fix : null
    const same = (row?.wait_for_json ?? null) === (waitFor.length ? JSON.stringify(waitFor) : null)
    const sameFix = (row?.wait_fix ?? null) === waitFix
    if (!row || ((row.wait_reason ?? null) === reason && (row.wait_box_size ?? null) === (reason ? size : null) && same && sameFix)) return
    this.store.updateTask(taskId, { waitReason: reason, waitBoxSize: reason ? size : null, waitFor, waitFix }, { touch: false })
    // A fix appearing or going with the same reason isn't news for the task's log.
    if (reason && !((row.wait_reason ?? null) === reason && (row.wait_box_size ?? null) === size && same)) this.addEvent(taskId, `${reason}.`)
    this.emitTask(taskId)
  }

  /**
   * The box facts a worker's system prompt states (stable from turn to turn, so the prompt cache holds): agents
   * that may share it are the box's slots, or its project's Agents at once when it needs the whole machine.
   */
  private boxPromptInfo(boxId: string, project: Project): BoxPromptInfo {
    const box = this.slotsFor(boxId)
    // Other projects' agents may share the box up to its own limit, unless the project needs the whole machine.
    const slots = project.wholeMachine ? Math.min(box, project.agentsPerBox ?? box) : box
    const alone = project.wholeMachine && slots === 1
    if (isLocalRunnerBox(boxId)) return { memoryBytes: os.totalmem(), slots, alone, local: true }
    if (isGpuBox(boxId)) {
      const pod = this.gpuFor(boxId)?.provider.cached(boxId)
      const cloud = gpuBoxProvider(boxId) ?? "runpod"
      return { memoryBytes: null, slots, alone, gpu: { name: pod?.gpu?.id ? shortGpu(pod.gpu.id) : "GPU", ...(cloud !== "runpod" ? { cloud } : {}) } }
    }
    if (isDockerBox(boxId)) {
      const d = this.docker?.settings()
      return { memoryBytes: d ? d.memoryMb * 1024 * 1024 : null, slots, alone, docker: { cpus: d?.cpus ?? null } }
    }
    if (isMachineBox(boxId)) {
      const m = this.machineOf(boxId)
      const t = m?.lastTest
      return { memoryBytes: t?.memoryBytes ?? null, slots, alone, machine: { name: m?.name ?? machineOfBox(boxId), os: t?.osName || t?.os || null, cpus: t?.cpus ?? null } }
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
   * Why the projects' own limits keep this task off a box or GPU pod right now, naming the running tasks that hold it
   * back, or null: its project's Agents at once (its own agents only), or Needs the whole machine (server/agentLimits.ts).
   * The box's own limit is checked apart. Store.claimTurnSlot holds the same rule when the turn claims its slot.
   */
  private limitBlock(row: TaskRow, boxId: string): Wait | null {
    const agent = this.store.boxAgent(row.id)
    const block = agent ? limitBlock(agent, this.store.boxAgents(boxId, row.id)) : null
    if (!agent || !block) return null
    const where = isGpuBox(boxId) ? `GPU pod #${gpuBoxIndex(boxId)}` : isDockerBox(boxId) ? "its Docker container" : isMachineBox(boxId) ? `SSH machine ${this.machineName(boxId)}` : `box ${boxId}`
    return { text: boxBlockReason(agent, block, where), by: waitFor(block.by) }
  }

  /**
   * Why a task can't start on this computer right now, naming the agents there that hold it back, or null: Settings ›
   * Local agents is full, or the projects' own limits keep it off (`limitBlock`'s rule). The reason comes whole,
   * with no "Waiting:" before it. Store.claimTurnSlot holds the same rule when the turn claims its slot.
   */
  private localWait(row: TaskRow): Wait | null {
    const running = this.store.boxAgents(LOCAL_BOX_ID, row.id)
    const slots = this.slotsFor(LOCAL_BOX_ID)
    if (running.length >= slots) {
      if (!running.length) return { text: LOCAL_SLOT_WAIT, by: [] }
      return { text: `Waiting for ${agentRefs(running)}: this computer runs ${slots === 1 ? "1 task" : `${slots} tasks`} at a time (Settings › Tasks running at once on this computer)`, by: waitFor(running) }
    }
    const agent = this.store.boxAgent(row.id)
    const block = agent ? limitBlock(agent, running) : null
    return agent && block ? { text: localBlockReason(agent, block), by: waitFor(block.by) } : null
  }

  /**
   * A project running on a box that needs the whole machine (BoxInfo): no other project's agents start there while it
   * runs, and its own run up to its Agents at once.
   */
  private projectLimitOn(boxId: string, residents: TaskRow[]): BoxInfo["projectLimit"] {
    const slots = this.slotsFor(boxId)
    for (const projectId of new Set(residents.filter(holdsSlot).map((r) => r.project_id))) {
      const own = this.store.projectBoxLimits(projectId)
      if (own.wholeMachine) return { slots: Math.min(slots, own.agentsPerBox ?? slots), project: this.store.getProjectName(projectId) ?? projectId }
    }
    return null
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
      // The box's own CPU time, which is what Upstash bills (a shared cgroup's, like local folders', says nothing).
      if (typeof mem?.cpuUsageUsec === "number" && providerOf(this.provider, boxId).ownCgroup) this.store.accrueBoxCpu(boxId, "cgroup", mem.cpuUsageUsec, now)
      if (mem && providerOf(this.provider, boxId).ownCgroup) this.measureTurns(boxId, size, space, mem, now)
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

  /**
   * Auto-sizing: a probe's reading for the turns running on the box (server/turnPeaks.ts). Its disk counts for a
   * project only while the task folders on the box are all its own.
   */
  private measureTurns(boxId: string, boxSize: BoxSize, space: DiskSpace, memory: BoxMemory, now: number) {
    const residents = this.store.listTaskRows({ boxId })
    const turns = residents.filter((r) => r.current_turn_id).map((r) => ({ turnId: r.current_turn_id!, taskId: r.id, projectId: r.project_id }))
    const owners = new Set(residents.map((r) => r.project_id))
    const diskOwner = owners.size === 1 ? [...owners][0]! : null
    this.meter.sample({ boxId, boxSize, memory, diskUsedBytes: Math.max(0, space.totalBytes - space.freeBytes), turns, diskOwner, now })
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

  /**
   * Why a task with no free slot can't count on a new box: a cloud limit is reached, the pool is at its ceiling (Max
   * boxes), or creating boxes keeps failing.
   */
  private noNewBoxReason() {
    const cloud = this.cloudBlock()
    if (cloud) return `Waiting for a new box: ${cloud.text}`
    if (this.store.listBoxes().length < this.limits().maxBoxes && this.boxCreateFailing()) {
      return "Waiting for a free slot or a new box: creating boxes keeps failing, so Box Yard retries with backoff"
    }
    return "Waiting for a free slot: every box is full and the pool is at its limit"
  }

  /** Room to create another box: under the ceiling and today's cloud limit, and box creation isn't failing right now. */
  private poolHasRoom() {
    // listBoxes() includes the placeholders of boxes being created.
    return !this.boxCreateFailing() && this.store.listBoxes().length < this.limits().maxBoxes && !this.cloudSpend().blockedReason
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
    const placedHow = this.pickedHow.get(taskId) ?? null
    this.pickedHow.delete(taskId)
    this.store.updateTask(taskId, { boxId, portBase: port, placedHow }, opts)
    const made = this.madeFor.get(boxId)
    if (made?.delete(taskId) && !made.size) this.madeFor.delete(boxId)
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

  /**
   * Give another project's idle box to `row`'s project rather than make a new one: of `boxIds` (boxes of the same
   * credential set with a free slot, from pickBox), the least recently used one that can go. Its workspaces are parked
   * in the archive (they come back on their next message, on any box) and the box is this project's from now on.
   * Returns the box, or null when none can go.
   */
  private async reuseIdleBox(row: TaskRow, boxIds: string[]): Promise<string | null> {
    const now = Date.now()
    const boxes = boxIds
      .map((id) => this.store.getBox(id))
      .filter((b): b is BoxRow => Boolean(b) && this.canReuse(b!, row, now))
      .sort((a, b) => a.last_used_at - b.last_used_at)
    for (const box of boxes) {
      if (await this.memoryBlock(box.id, row.id)) continue
      if ((await this.diskRoom(box.id, row)) !== "ok") continue
      // Checked again: the disk and memory probes awaited, and a turn may have started there meanwhile.
      if (!this.canReuse(box, row, Date.now())) continue
      this.repurposeBox(box, row)
      return box.id
    }
    return null
  }

  /**
   * A box that may go to `row`'s project: ready and untouched by any operation, idle for `reuseIdleMs`, every task
   * on it resting with nothing queued and its workspace in the archive, and nothing of the projects it hosts
   * waiting for a turn (that work would want this box back). pickBox only offers boxes of the project's credential
   * set, so the box wall holds.
   */
  private canReuse(box: BoxRow, row: TaskRow, now: number): boolean {
    if (box.status !== "ready" || this.boxOps.has(box.id) || this.janitor.isRunning(box.id)) return false
    if (now - box.last_used_at < this.placementTuning.reuseIdleMs) return false
    if (this.boxCreds(box.id) !== this.projectCreds(row.project_id)) return false
    const residents = this.store.listTaskRows({ boxId: box.id }).filter((r) => r.id !== row.id)
    const resting = (r: TaskRow) =>
      !r.current_turn_id && RESTING.includes(r.status) && !this.wantsTurn(r) && !this.archiving.has(r.id) && (!r.session_started || this.archiveHoldsWorkspace(r))
    if (!residents.every(resting)) return false
    const hosted = this.projectsOnBox(box.id).filter((p) => p !== row.project_id)
    return !hosted.some((p) => this.store.listTaskRows({ projectId: p }).some((r) => (r.box_id === null || r.box_id === box.id) && this.wantsTurn(r)))
  }

  /** Hand an idle box to `row`'s project: park its workspaces in the archive and make it the project's box. */
  private repurposeBox(box: BoxRow, row: TaskRow) {
    const residents = this.store.listTaskRows({ boxId: box.id }).filter((r) => r.id !== row.id)
    const name = (id: string) => this.store.getProjectName(id) ?? id
    const from = this.projectsOnBox(box.id).filter((p) => p !== row.project_id)
    const to = name(row.project_id)
    const idleMin = Math.max(1, Math.round((Date.now() - box.last_used_at) / 60_000))
    // Recorded first, so the history row names the projects it hosted.
    this.recordBoxEvent({
      boxId: box.id,
      type: "reused",
      actor: { kind: "scheduler" },
      reason: `Idle for ${idleMin} min and ${to} needed a box: reusing it instead of making a new one.`,
      detail: `From ${from.map(name).join(", ") || "no project"} to ${to}${residents.length ? `; ${residents.length === 1 ? "1 workspace" : `${residents.length} workspaces`} parked in the archive` : ""}.`,
    })
    for (const r of residents) {
      this.store.updateTask(r.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
      void this.removeTaskDir(box.id, r.id).catch(() => {})
      this.addEvent(r.id, `Workspace parked in the archive: box ${box.id} was idle and went to project ${to}. It comes back on the next message.`)
      this.emitTask(r.id)
    }
    // The box is this project's now: the others' tasks look for a box of their own next time.
    for (const p of this.store.listProjects()) if (p.id !== row.project_id && this.store.getKv(projectBoxKey(p.id)) === box.id) this.store.setKv(projectBoxKey(p.id), null)
    this.store.setKv(boxOwnerKey(box.id), row.project_id)
    this.addEvent(row.id, `Placed on box ${box.id}, idle for ${idleMin} min, rather than making a new box.`)
    this.emitBoxes()
  }

  private boxLabels(projectId?: string | null) {
    const project = projectId ? this.store.getProject(projectId) : null
    return ["boxyard", this.installLabel(), ...(project ? [`p-${slugify(project.name)}`] : [])]
  }

  private async createBox(projectId?: string) {
    this.creatingBoxes++
    this.poolCreates++
    this.createStarts.push(Date.now())
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
        this.setBoxCreds(id, this.projectCreds(projectId))
      }
      this.recordBoxEvent({
        boxId: id,
        type: "created",
        actor: { kind: "scheduler" },
        reason: project ? `Project ${project.name} needed a box for its tasks.` : "Tasks were waiting and the pool had room.",
        detail: createdDetail(made, project?.name),
        taskIds: waiting,
      })
      for (const box of this.madeFor.keys()) if (!this.store.getBox(box)) this.madeFor.delete(box)
      if (waiting.length) this.madeFor.set(id, new Set(waiting))
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
    /** signing.key is on the box and no runner has taken it yet. */
    let keyWaiting = false
    /** task.json (the turn's credentials) is on an SSH machine and no runner has started to remove it after the turn. */
    let credsWaiting = false
    /** And codex-auth.json, the Codex login for this turn. */
    let codexWaiting = false
    try {
      // Placement doesn't send Codex tasks to SSH machines (pickMachine waits); never reach one with nothing written.
      if (isMachineBox(boxId) && taskAgentCli(row) === "codex") throw new Error(CODEX_ON_MACHINES)
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
      const messages = followupPrompt(inputs.length ? inputs : [{ source: "system", content: "Continue." }], projectName, ownerName)
      // A resumed task with a PR hears the PR's state as it stands now (GitHub, with a short timeout), so it never
      // reports a stale one, like "still waiting for review" on a PR Cody merged hours ago.
      const pr = !compact && !firstTurn && row.pr_url ? await this.prs.live(taskId) : null
      const followup = pr ? `${messages}\n\n---\n\n${prStatusLine(pr, { baseBranch: project.baseBranch })}` : messages
      row = this.requireRow(taskId)
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
      await this.dropBoxGitCredential(boxId)
      // A key Box Yard keeps goes to the box for this one turn: the runner moves it out of the task folder and
      // removes it when the turn ends (box-runner.mjs setupSigning).
      const signing = this.identities.signingFor(project.id)
      if (signing?.privateKey) {
        keyWaiting = true
        await this.provider.writeFile(boxId, `${dir}/signing.key`, signing.privateKey)
      }
      const author = await this.turnAuthor(row, project, boxId, dir)
      const taskJson = this.taskJson(row, project, boxId, signing, author)
      if (taskJson.agent === "codex") {
        await this.ensureCodex(boxId)
        // The ChatGPT login goes to the box for this turn; the runner keeps whichever copy is newer, and Box Yard reads
        // back the one Codex refreshed when the turn ends (takeBackCodexAuth).
        const auth = taskJson.codexLogin === "chatgpt" && taskJson.isolateCodex ? this.settings.credentials.codexAuth() : ""
        if (auth) {
          codexWaiting = true
          await this.provider.writeFile(boxId, `${dir}/codex-auth.json`, auth)
        }
      }
      credsWaiting = isMachineBox(boxId)
      await this.provider.writeFile(boxId, `${dir}/task.json`, JSON.stringify(taskJson, null, 2))
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
          systemPrompt: workerSystemPrompt({ project, task: row, branch: row.branch, port: row.port_base ?? PORT_BASE, ownerName, pushAtTurnEnd: this.pushAtTurnEnd(project), box: this.boxPromptInfo(boxId, project), agent: taskAgentCli(row) }),
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
      // What started the turn (mixed queues: the highest-ranked sender, server/turnTrigger.ts), and the PR as it began.
      // A retry keeps the retried turn's, and a first turn counts as whoever started the task.
      const before = this.store.turnFlags(row)
      const retry = Boolean(before.interrupts || before.sleeps || before.oomRetries)
      const trigger = compact
        ? null
        : turnTrigger(
            queued.map((i) => i.source),
            { carried: firstTurn ? taskTrigger(row) : retry ? (before.trigger ?? null) : null, fallback: "system" },
          )
      const prBefore = retry && before.prBefore !== undefined ? before.prBefore : prMark(row)
      this.store.startTaskTurn({
        id: turnId,
        taskId,
        turnIndex: compact ? row.turn_count : row.turn_count + 1,
        model: agent.model,
        effort: agent.effort,
        routingRule: route.rule,
        routingReason: route.reason,
        status: compact ? "compact" : "started",
        trigger,
      })

      // A workspace cloned before Box Yard's credential helper cleared the box's own (mirrorSpec's `only`) gets it now.
      const helper = project.repo && this.onlyBoxYardHelper(boxId, project.id) ? `([ ! -d work/.git ] || (cd work && ${setHelperScript(GITHUB_HELPER, true)}) >/dev/null 2>&1; true) && ` : ""
      // setsid (where it exists; on macOS the runner makes its own session) + nohup: the turn survives a dropped
      // exec connection and a Box Yard restart. Any half-started runner is stopped first, by its run record, so a
      // pid someone else holds now is never hit. The runner writes run.json and turn.pid itself.
      const start = await this.provider.exec(
        boxId,
        `${TURN_SH}\ncd ${q(dir)} && ([ ! -f signing.key ] || chmod 600 signing.key) && ${helper}(by_turn_kill . TERM; rm -f turn.pid run.json; true) && ($(command -v setsid || true) nohup ${q(providerOf(this.provider, boxId).nodeBin)} ${q(runnerPath)} turn ${q(dir)} >> runner.log 2>&1 < /dev/null &) && for i in $(seq 1 50); do [ -f turn.pid ] && break; sleep 0.2; done; [ -f turn.pid ] && cat turn.pid || (tail -n 20 runner.log; exit 1)`,
      )
      if (start.exitCode !== 0) throw new Error(`runner did not start: ${(start.stdout + start.stderr).slice(-800)}`)
      keyWaiting = false
      credsWaiting = false
      codexWaiting = false
      // A turn that never reported its end (lost with its box) is forgotten after a day.
      for (const [id, l] of this.turnLaunches) if (l.launchedAt < Date.now() - 86_400_000) this.turnLaunches.delete(id)
      this.turnLaunches.set(turnId, {
        // The oldest message it answers, else (a first turn) the task's creation; a retry or "Continue." has none.
        requestedAt: queued.length ? Math.min(...queued.map((i) => i.createdAt)) : firstTurn ? row.created_at : null,
        launchedAt,
        trigger: compact ? "compaction" : (trigger ?? null),
        model: agent.model ?? null,
        effort: agent.effort ?? null,
        resumed: !firstTurn && !recapped,
      })
      if (superseded()) {
        await this.provider.exec(boxId, turnKillScript(dir)).catch(() => {})
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
      const hookIds = [...new Set([...queued.filter((i) => i.source.startsWith("hook:")).map((i) => i.source.slice("hook:".length)), ...(retry ? (flags.hookIds ?? []) : [])])]
      this.store.updateTask(taskId, {
        status: "working",
        sessionStarted: true,
        ...(compact ? { compacting: true, compactPending: false } : { turnCount: row.turn_count + 1 }),
        turnFlags: { interrupts: flags.interrupts, sleeps: flags.sleeps, oomRetries: flags.oomRetries, ...(hookIds.length ? { hookIds } : {}), ...(trigger ? { trigger, prBefore } : {}) } as TurnFlags,
        lastActiveAt: Date.now(),
        question: null,
      })
      this.lastEventAt.set(taskId, Date.now())
      this.emitTask(taskId)
      this.publishDirectory()
      this.holdOpen(taskId, boxId)
      // Auto-sizing: the box's memory, CPU and out-of-memory count as the turn begins, to measure it against.
      if (providerOf(this.provider, boxId).ownCgroup) void this.probeDisk(boxId, 0).catch(() => null)
      if (this.stopRequested.has(taskId)) await this.killTurn(this.requireRow(taskId)).catch(() => {})
    } catch (err) {
      this.release(boxId, taskId)
      // A key sent for a turn that never started doesn't stay on the box. Emptied first: in Docker that's the tmpfs copy.
      if (keyWaiting && !this.stopped) {
        await this.provider.writeFile(boxId, `${dir}/signing.key`, "").catch(() => {})
        await this.provider.exec(boxId, `rm -f ${q(`${dir}/signing.key`)}`).catch(() => {})
      }
      // Nor the turn's credentials on an SSH machine (in its tmpfs, or on its disk).
      if (credsWaiting && !this.stopped) {
        await this.provider.writeFile(boxId, `${dir}/task.json`, "").catch(() => {})
        await this.provider.exec(boxId, `rm -f ${q(`${dir}/task.json`)}`).catch(() => {})
      }
      if (codexWaiting && !this.stopped) {
        await this.provider.writeFile(boxId, `${dir}/codex-auth.json`, "").catch(() => {})
        await this.provider.exec(boxId, `rm -f ${q(`${dir}/codex-auth.json`)}`).catch(() => {})
      }
      // Box Yard is stopping, and its database may be closed already: the next start picks the task up.
      if (this.stopped) {
        try {
          this.store.releaseInputs(turnId)
        } catch {}
        return
      }
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
    this.addEvent(row.id, `Resumed from a recap: ${why}, so a new ${AGENT_CLI_LABEL[taskAgentCli(row)]} session started on ${checkout} with the task's summary, PR and recent messages.`)
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
    // Codex runs OpenAI models: a Claude model from Settings, routing or the built-in default gives way to the Codex model.
    // And the reverse: an OpenAI model on a Claude Code task gives way to Settings' (or the built-in) Claude model.
    const cli = taskAgentCli(row)
    const model = cli === "codex" ? codexModel(route.model, s.agentCodexModel) : isOpenAiModel(route.model) ? (isOpenAiModel(s.agentModel) ? DEFAULT_MODEL : s.agentModel) : route.model
    return { model, effort: route.effort, autocompact: autocompactFlag(s.agentAutoCompact, row.context_window), route }
  }

  /** Boxes this server run found Codex on (or installed it on). */
  private readonly codexReady = new Set<string>()

  /**
   * Codex on the box, installed the first time a Codex task lands on one that lacks it (Upstash and RunPod boxes start
   * with Claude Code only; Box Yard's Docker image has both). On this computer it's the owner's to install, and on an
   * SSH machine nothing is ever installed: Codex tasks don't run there (CODEX_ON_MACHINES).
   */
  private async ensureCodex(boxId: string) {
    if (isMachineBox(boxId)) throw new Error(CODEX_ON_MACHINES)
    const provider = providerOf(this.provider, boxId)
    if (this.codexReady.has(boxId) || provider.name === "local" || this.c.mock) return
    const install = "npm install -g @openai/codex --no-audit --no-fund >/dev/null 2>&1"
    const res = await this.provider.exec(boxId, `command -v codex >/dev/null 2>&1 || ${install} || sudo -n ${install}; command -v codex >/dev/null 2>&1 && codex --version`)
    if (res.exitCode !== 0) throw failedStep("installing Codex on the box (npm install -g @openai/codex)", new Error(errorTail(res.stderr || res.stdout) || `exit code ${res.exitCode}`))
    this.codexReady.add(boxId)
  }

  /**
   * After a Codex turn that ran on Settings' ChatGPT login: read the box's copy back, so tokens Codex refreshed there
   * reach every later turn (the refresh token it replaced is spent). Best effort: a copy that isn't newer is ignored.
   */
  private async takeBackCodexAuth(row: TaskRow) {
    if (taskAgentCli(row) !== "codex" || !row.box_id || this.settings.credentials.codexLogin()?.kind !== "chatgpt") return
    if (this.codexCredentials(row.project_id, this.store.taskEnv(row.id)).kind !== "chatgpt") return
    try {
      const file = await this.provider.readFile(row.box_id, `${this.taskDir(row.box_id, row.id)}/codex/auth.json`)
      if (this.settings.credentials.adoptCodexAuth(file.toString("utf8"))) console.log(`[box-yard] ${row.id}: kept the Codex login it refreshed`)
    } catch {}
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
        await putFile(this.provider, boxId, file.path, `${folder}/${name}`).catch((err) => {
          throw failedStep(`uploading the attached file ${file.name} (${uploadSize(file.size)}) to the box`, err)
        })
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

  /** Upstash boxes whose git config has Box Yard's credential helper and no stored token, this server run. */
  private readonly boxGitChecked = new Set<string>()

  /**
   * An Upstash box made before credentials left Box.create still has the global GitHub token stored in its git config,
   * where it answers before a project's own: replace it with Box Yard's helper, once per box per server run.
   * Best effort: a box it fails on is tried again on its next turn.
   */
  private async dropBoxGitCredential(boxId: string) {
    if (this.boxGitChecked.has(boxId) || providerOf(this.provider, boxId).name !== "upstash") return
    const res = await this.provider.exec(boxId, BOX_GIT_CREDENTIAL_SCRIPT).catch(() => null)
    if (res?.exitCode === 0) this.boxGitChecked.add(boxId)
    else console.warn(`[box-yard] couldn't reset the git credential on ${boxId}: ${errorTail(res?.stderr ?? "") || "no result"}`)
  }

  private taskJson(row: TaskRow, project: NonNullable<ReturnType<Store["getProject"]>>, boxId: string, signing: TurnSigning | null, author: TurnAuthor) {
    // Read on every turn, so a credential saved in Settings › Credentials or on an identity reaches the next turn without a restart.
    const creds = this.turnCredentials(project.id, this.store.taskEnv(row.id))
    const { env, claudeFrom } = creds
    if (author.author) Object.assign(env, authorEnv(author.author))
    let { unsetEnv } = creds
    const provider = providerOf(this.provider, boxId)
    const local = provider.name === "local"
    const machine = provider.name === "ssh"
    // On this computer, an identity other than Default doesn't get the owner's git config or gh login.
    const home = this.identityHome(boxId, project.id)
    if (home) for (const [k, v] of Object.entries(identityHomeEnv(home))) if (!(k in env)) env[k] = v
    const [claudeBin, ...claudeArgs] = (local ? this.c.claudeBin : provider.claudeBin).split(" ")
    const agent = taskAgentCli(row)
    const codex = agent === "codex" ? this.codexCredentials(project.id, this.store.taskEnv(row.id)) : null
    if (codex) {
      // A Codex turn logs in with Codex's login: Settings' Claude login stays off its box (a project's own env stays).
      if (claudeFrom === "global") for (const k of CLAUDE_CREDENTIAL_VARS) delete env[k]
      Object.assign(env, codex.env)
      unsetEnv = [...new Set([...unsetEnv, ...[...CLAUDE_CREDENTIAL_VARS, ...CODEX_CREDENTIAL_VARS].filter((v) => !(v in env))])]
    }
    const [codexBin, ...codexArgs] = (local || this.c.mock ? this.c.codexBin : (provider.codexBin ?? "codex")).split(" ")
    return {
      taskId: row.id,
      projectId: project.id,
      boxId,
      env,
      unsetEnv,
      agent,
      claudeBin,
      claudeArgs,
      // A local `claude` login (or an SSH machine's own) lives in the default config dir, so only
      // isolate when we have a token to log in with.
      isolateConfig: !(local || machine) || claudeFrom !== null,
      // An SSH machine keeps no turn credentials between turns: the runner removes task.json as the turn ends.
      ...(machine ? { dropAfterTurn: true } : {}),
      ...(codex
        ? {
            codexBin,
            codexArgs,
            // "chatgpt": the login file comes as codex-auth.json for the turn (box-runner.mjs prepareCodexHome).
            codexLogin: codex.kind,
            // The same rule for Codex: on this computer (or an SSH machine) with no Codex login set, its own `codex login` (~/.codex).
            isolateCodex: !(local || machine) || this.c.mock || codex.kind !== null,
          }
        : {}),
      port: row.port_base ?? PORT_BASE,
      // The runner puts it into its MCP tool descriptions and replies.
      ownerName: this.owner(),
      // Where its commits' author came from (server/gitAuthor.ts); the author itself is in env.
      authorSource: author.source,
      baseBranch: project.baseBranch,
      github: { slug: githubSlug(project.repo) },
      // How its commits are signed: never the private key, which comes as signing.key for one turn.
      signing: signing
        ? {
            identity: signing.identity,
            kind: signing.kind,
            publicKey: signing.publicKey,
            fingerprint: signing.fingerprint,
            program: signing.program,
            requireSigned: signing.requireSigned,
            problem: signing.kind === "file" && !signing.privateKey ? `the ${signing.identity} identity's signing key can't be read with this server's secret key: save it again in Settings › Identities` : null,
          }
        : null,
      identityHome: home,
      // Where the runner keeps the turn's signing key: the box's memory when it has a tmpfs for secrets (Docker).
      secretsDir: provider.secretsDir ?? null,
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
      // In parts when it's over the box's upload limit (Upstash: 100 MB per file). Each failure names its step.
      await putFile(this.provider, boxId, row.archive_path!, remote).catch((err) => {
        throw failedStep(`restoring workspace failed: uploading its ${uploadSize(fs.statSync(row.archive_path!).size)} archive to the box`, err)
      })
      const res = await this.provider.exec(
        boxId,
        `mkdir -p ${q(tasks)} && tar xzf ${q(remote)} -C ${q(tasks)} && rm -f ${q(remote)} && mkdir -p ${q(dir + "/work")} && rm -f ${q(dir + "/turn.pid")} ${q(dir + "/run.json")}`,
      )
      if (res.exitCode !== 0) throw new Error(`restoring workspace failed: unpacking its archive on the box failed: ${(res.stderr || res.stdout).trim().slice(-500) || `exit code ${res.exitCode}`}`)
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
    this.store.updateTask(row.id, { eventCursor: JSON.stringify({ ...cursor, offset: Number.parseInt(size.stdout.trim(), 10) || 0, ino: null }) })
    this.addEvent(row.id, from === "git" ? `Workspace restored ${onBox(boxId, this.machineName(boxId))}: its session from the archive, its code from git.` : `Workspace restored ${onBox(boxId, this.machineName(boxId))}.`)
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
    this.addEvent(row.id, `Couldn't restore the workspace archive ${onBox(boxId, this.machineName(boxId))} (${reason}), so the task restarts from a recap on ${checkout}${work}.${where}`)
    this.notice(`⚠️ **${row.title}** restarts from a recap: its workspace archive couldn't be restored ${onBox(boxId, this.machineName(boxId))} (${reason}). A new Claude session starts on ${checkout}${work}; anything else that wasn't pushed is only in the old archive.${where}`, { taskId: row.id })
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
      const { spec, env, helper, only } = mirror
      // One mirror per repo per box (see server/gitShare.ts): the task's clone borrows its objects, so a task
      // folder holds its working tree and only the objects it made or fetched itself.
      const refs = [`refs/heads/${project.baseBranch}`, ...(row.branch ? [`refs/heads/${row.branch}`] : [])]
      steps.push(
        env,
        withMirrorLock(spec.mirror, [syncMirrorScript(spec), hydrateMirrorScript(spec, refs), `cd ${q(dir)}`, cloneTaskScript(spec)].join("\n")),
        `cd work`,
        setHelperScript(helper, only),
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
    this.addEvent(row.id, project.repo ? `Cloned ${project.repo} ${onBox(boxId, this.machineName(boxId))}${row.branch ? `, branch ${row.branch}` : ""}.` : `Workspace ready ${onBox(boxId, this.machineName(boxId))}.`)
    const mark = res.stdout.match(new RegExp(`${BRANCH_MARK}(origin|base)`))?.[1] as "origin" | "base" | undefined
    return { restored: false, branch: mark }
  }

  /** Whether a project's box mirrors are partial clones (blob:none): its own choice, else Settings. */
  partialClone(project: { partialClone?: boolean | null }): boolean {
    return project.partialClone ?? this.settings.get().gitPartialClone
  }

  /**
   * The repo mirror on a box for a project, with the git command, env and credential helper that reach GitHub.
   * `only`: Box Yard's helper is the only one git asks, so a credential the box's own git config stores can't answer
   * before the token Box Yard gives it. That's every box but this computer, where the owner's own git login still
   * answers first unless the project has a GITHUB_TOKEN of its own or an identity other than Default.
   */
  private mirrorSpec(boxId: string, project: NonNullable<ReturnType<Store["getProject"]>>) {
    const helper = GITHUB_HELPER
    const token = this.githubToken(project.id)
    const only = this.onlyBoxYardHelper(boxId, project.id)
    const spec: MirrorSpec = {
      root: this.provider.root(boxId),
      tasks: tasksRootOf(this.provider, boxId),
      mirror: `${this.provider.root(boxId)}/.boxyard/repos/${this.repoMirrorName(project.repo)!}`,
      url: cloneUrl(project.repo!),
      partial: this.partialClone(project),
      git: gitWithHelper(helper, only),
    }
    const home = this.identityHome(boxId, project.id)
    const walls = home ? ` ${Object.entries(identityHomeEnv(home)).map(([k, v]) => `${k}=${q(v)}`).join(" ")}` : ""
    return { spec, helper, only, env: `export GITHUB_TOKEN=${q(token ?? "")} GIT_TERMINAL_PROMPT=0${walls}` }
  }

  /**
   * On this computer, the folder of a non-Default identity's own git config and gh login, which its turns and Box
   * Yard's git work for its projects use instead of the owner's (~/.gitconfig, the system config, ~/.config/gh). Null
   * on boxes (no one else's config is there) and for the Default identity (the owner's own, as before).
   */
  private identityHome(boxId: string, projectId: string): string | null {
    const id = this.identities.idOf(projectId)
    return isLocalRunnerBox(boxId) && id !== DEFAULT_IDENTITY_ID ? `${this.provider.root(boxId)}/.boxyard/identities/${id}` : null
  }

  /** See mirrorSpec's `only`. */
  private onlyBoxYardHelper(boxId: string, projectId: string): boolean {
    return !isLocalRunnerBox(boxId) || Boolean(ownGithubToken(this.store.projectEnv(projectId))) || this.identities.idOf(projectId) !== DEFAULT_IDENTITY_ID
  }

  /**
   * A thin archive (server/archive.ts) carries the branch, refs, unpushed commits and uncommitted work but not the
   * history GitHub has: clone that again from the mirror or GitHub and put the rest back. Fails loudly when a ref's
   * commit can't be found (the archive stays as it was for another try), never with commits silently gone.
   */
  private async restoreThinGit(boxId: string, dir: string, { spec, env, helper, only }: { spec: MirrorSpec; env: string; helper: string; only: boolean }) {
    const check = await this.provider.exec(boxId, `[ -d ${q(`${dir}/${THIN_DIR}`)} ] && echo thin`)
    if (!check.stdout.includes("thin")) return
    const res = await this.provider.exec(boxId, `${env}\n${thinRestoreScript(dir, spec, { helper, only })}`)
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
      ? { script: withMirrorLock(mirror.spec.mirror, [syncMirrorScript(mirror.spec), hydrateMirrorScript(mirror.spec, refs), cloneTaskScript(mirror.spec, ".boxyard-clone")].join("\n")), helper: mirror.helper, only: mirror.only }
      : null
    const script = gitRestoreScript({
      dir,
      taskId: row.id,
      baseBranch: project.baseBranch,
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
    const dir = this.taskDir(boxId, taskId)
    // Only while it's the turn's own process (its run record), never a process that took its pid after a restart.
    const wait = whileTurnRuns(dir, "sleep 15; echo .")
    // On this computer (or a Mac SSH machine) it keeps a Mac out of idle sleep while the turn runs (caffeinate; -s holds
    // off system sleep on AC power too), as the stream keeps a box awake. Closing the lid still sleeps it: the turn
    // resumes on wake.
    const command = isLocalRunnerBox(boxId) || isMachineBox(boxId) ? `${TURN_SH}\nif command -v caffeinate >/dev/null 2>&1 && by_turn_alive ${q(dir)}; then exec caffeinate -is -w "$p"; fi\n${wait}` : wait
    const loop = async () => {
      let quickExits = 0
      while (!ctrl.signal.aborted && !this.stopped) {
        const started = Date.now()
        await this.provider.hold(boxId, command, ctrl.signal)
        if (ctrl.signal.aborted) break
        const row = this.store.getTaskRow(taskId)
        if (!row?.current_turn_id || row.box_id !== boxId) break
        // The process ended (turn_end is on its way) or the stream dropped.
        await this.pollTask(row)
        if (ctrl.signal.aborted || this.stopped) break
        // Ended without a turn_end (killed, crashed): settle it now rather than at the next stall check.
        const after = this.store.getTaskRow(taskId)
        if (!ctrl.signal.aborted && after?.status === "working" && after.current_turn_id === row.current_turn_id) {
          const probe = await this.turnProcess(boxId, taskId).catch(() => null)
          if (probe && !probe.alive && !ctrl.signal.aborted) {
            await this.turnGone(after, "the worker process stopped without finishing")
            break
          }
        }
        quickExits = Date.now() - started < 5000 ? quickExits + 1 : 0
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** quickExits)))
      }
      if (this.holds.get(taskId) === ctrl) this.holds.delete(taskId)
    }
    void loop()
  }

  /**
   * Stop the task's running turn: its process group, found by its run record (so never a process that took its pid
   * after a restart). `turnId`: only if that turn is still the one on the box (not a newer one). "gone": its process
   * had already ended (it died while Box Yard was down, or the machine restarted), so no turn_end will come from it.
   */
  private async killTurn(row: TaskRow, turnId?: string | null): Promise<"signalled" | "gone"> {
    if (!row.box_id) return "gone"
    const probe = await this.turnProcess(row.box_id, row.id).catch(() => null)
    if (probe && !probe.alive) return "gone"
    await this.provider.exec(row.box_id, turnKillScript(this.taskDir(row.box_id, row.id), "TERM", turnId))
    return "signalled"
  }

  /** Whether the task's turn process still runs, by its run record; null when the box can't say (unreachable). */
  private async turnProcess(boxId: string, taskId: string): Promise<TurnProbe | null> {
    const res = await this.provider.exec(boxId, turnProbeScript(this.taskDir(boxId, taskId)))
    return res.exitCode === 0 ? parseTurnProbe(res.stdout) : null
  }

  /**
   * The turn's process ended without a turn_end Box Yard has seen. What it wrote is read first: its last output, and
   * its turn_end if it got that far (which ends the turn as usual, as when Box Yard was down while it finished). A
   * turn still open after that is settled: stopped when someone asked it to stop (`stopped`, or Stop), else
   * interrupted and queued to carry on in the same session. Only if it's still the task's turn: a newer one is left be.
   */
  private async turnGone(row: TaskRow, reason: string, opts: { stopped?: boolean } = {}) {
    const turnId = row.current_turn_id
    if (!row.box_id || !turnId) return
    await this.drainEvents(row).catch((err) => console.warn(`[box-yard] reading the last events of ${row.id}: ${errorMessage(err)}`))
    if (this.stopped) return
    const fresh = this.store.getTaskRow(row.id)
    if (!fresh || fresh.current_turn_id !== turnId) return
    if (opts.stopped || this.stopRequested.has(row.id)) return this.finishTurn(fresh, { seq: 0, ts: Date.now(), turnId, t: "turn_end", stopped: true, ok: true, exitCode: null })
    this.interrupt(fresh, reason)
  }

  /**
   * Apply every event a turn whose process is gone wrote, straight from its events.jsonl: nothing more is coming, and
   * Redis may have missed some. From the saved cursor; with Redis (whose cursor isn't a file offset) from where the
   * turn's events start, by its run record, or the end of the file for a runner from before run records.
   */
  private async drainEvents(row: TaskRow) {
    const boxId = row.box_id
    if (!boxId) return
    const dir = this.taskDir(boxId, row.id)
    // A poll in progress would apply the same events: wait for it, and keep the next one out.
    for (let i = 0; this.pollLocks.has(row.id) && i < 200; i++) await new Promise((r) => setTimeout(r, 50))
    this.pollLocks.add(row.id)
    try {
      let cursor = parseCursor(this.store.getTaskRow(row.id)?.event_cursor ?? null)
      if (this.reader.mode === "redis") {
        const record = await this.provider.exec(boxId, `cat ${q(`${dir}/run.json`)} 2>/dev/null; true`).then((r) => parseRunRecord(r.stdout), () => null)
        if (record?.eventsOffset === null || record?.eventsOffset === undefined) {
          const { events, cursor: next } = await this.reader.readFileTail(boxId, dir, cursor)
          return await this.applyEvents(row.id, events, next)
        }
        cursor = { ...cursor, offset: record.eventsOffset, ino: null }
      }
      for (let i = 0; i < 1000; i++) {
        const { events, cursor: next } = await this.reader.readFile(boxId, dir, cursor)
        await this.applyEvents(row.id, events, next)
        if (next.offset === cursor.offset && next.ino === cursor.ino) break
        cursor = { ...next, seq: parseCursor(this.store.getTaskRow(row.id)?.event_cursor ?? null).seq }
      }
    } finally {
      this.pollLocks.delete(row.id)
    }
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
      case "signing":
        return say("event", `This turn's commits aren't signed: ${String(ev.error ?? "signing isn't set up")}.`, { kind: "signing" })
      case "session_reset":
        this.store.updateTask(taskId, { sessionId: String(ev.sessionId) })
        return say("event", `${taskAgentCli(row) === "codex" ? "Codex" : "Claude"} session was missing on this box, so the agent started a new one with a recap.`)
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
        await this.takeBackCodexAuth(row)
        // The agent may have merged or closed its PR during the turn; ask GitHub.
        const pr = row.pr_url && row.current_turn_id ? await this.prs.check(taskId) : null
        // A failed turn on an Upstash box: read the box now, so a process its cgroup killed for memory counts (auto-sizing).
        if (!ev.ok && !ev.stopped && row.box_id && row.current_turn_id && providerOf(this.provider, row.box_id).ownCgroup) await this.probeDisk(row.box_id, 0).catch(() => null)
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
    // A merge seen live (not the startup backfill of an old PR): its follow-ups, then the pr.merged hooks.
    const live = info.state === "merged" && (prev === "open" || prev === "draft")
    if (live) this.followUpMerge(row, status)
    // Hooks: a merge seen live, or a resting task's draft marked ready.
    const flags = this.store.turnFlags(row)
    const originHookIds = (row.current_turn_id ? flags.hookIds : flags.lastHookIds) ?? []
    if (live) {
      this.emitTaskEvent({ type: "pr.merged", taskId, turnId: row.current_turn_id, originHookIds })
    } else if (prev === "draft" && info.state === "open" && ["pr_ready", "done", "idle"].includes(row.status) && !row.current_turn_id) {
      this.emitTaskEvent({ type: "task.pr_ready", taskId, turnId: null, originHookIds })
    }
  }

  /**
   * A task's PR merged (seen live): close the issues it names (Close the issues it names), and when the tracker moved
   * the resting task to done (Done when its PR merges), archive it as close_task does; when it didn't, say why.
   * A merge seen during a turn is settled when the turn ends (finishTurn).
   */
  private followUpMerge(row: TaskRow, status: TaskStatus | null) {
    if (row.pr_url && this.closeIssuesOnMerge(row.project_id)) this.issues.queue(row.id, row.pr_url)
    if (status === "done") return this.mergedDone(row.id)
    if (row.current_turn_id || !AUTO_DONE_FROM.includes(row.status) || !this.autoDoneOnMerge(row)) return
    const blocker = this.mergeDoneBlocker(row)
    if (blocker === "other_prs") void this.doneIfOtherPrsSettled(row.id, true)
    else if (blocker === "queued") {
      this.addEvent(row.id, `Not moved to done, though PR #${prNumber(row.pr_url) ?? "?"} merged: it has queued messages to answer first.`, { kind: "auto_done_skipped" })
      this.emitTask(row.id)
    }
  }

  private finishTurn(row: TaskRow, ev: WorkerEvent, pr: PrState | null = null) {
    if (ev.turnId && row.current_turn_id && ev.turnId !== row.current_turn_id) return // stale event from an older turn
    if (!row.current_turn_id) return
    this.captainWaits.delete(row.id)
    // A Captain reply handed to a wait the agent didn't take: queued (and editable) again, for the next turn.
    this.store.releaseInputs(handoffClaim(row.current_turn_id))
    // Auto-sizing: what the turn used on its box, and whether it ran out of memory there.
    const measured = this.recordTurnPeak(row.current_turn_id, ev, !ev.ok && !ev.stopped && !this.stopRequested.has(row.id))
    const timing = this.recordTurnTiming(row, ev)
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
    const oom = !stopped && !ev.ok && measured?.oom ? this.oomRetry(row, flags, measured.boxSize) : null
    if (oom && "to" in oom) return this.retryAfterOom(row, ev, flags, measured!.boxSize, oom.to)

    // A merged PR means the work landed; a closed one means there's no PR to review.
    // (The tracker already wrote "Pull request ... was merged" to the transcript when it saw the change.)
    const openPr = Boolean(row.pr_url) && !isFinalPrState(pr)
    let status: TaskStatus
    let mergedDone = false
    let error: string | null = null
    if (stopped) status = openPr ? "pr_ready" : "idle"
    else if (!ev.ok) {
      status = "failed"
      error = String(ev.error ?? "The agent exited with an error.")
      if (oom && "why" in oom) error = `It ran out of memory on its ${measured!.boxSize} box, and isn't retried on a bigger one: ${oom.why}. ${error}`
    } else if (flags.asked) status = "needs_input"
    else if (flags.done) status = "done"
    else if (flags.waitingOn?.length) status = "waiting"
    // Done when its PR merges off (or this task stays open): the task rests idle until it's marked done. Queued
    // messages or another PR that may still be open keep it idle too (the PR is asked about once the turn has ended).
    else if (pr === "merged" && this.autoDoneOnMerge(row) && !this.mergeDoneBlocker(row)) {
      status = "done"
      mergedDone = true
    } else if (openPr) status = "pr_ready"
    else status = "idle"
    const askOtherPrs = pr === "merged" && status === "idle" && this.autoDoneOnMerge(row) && this.mergeDoneBlocker(row) === "other_prs"

    const result = typeof ev.result === "string" ? ev.result : null
    const noopIgnored = flags.noop && !stopped ? noopBlockers(this.runEvidence(row, flags, status)) : []
    const outcome = flags.noop && !stopped && !noopIgnored.length ? "noop" : null
    // Only other agents' messages started this turn, and nothing real changed: Cody isn't told (server/turnTrigger.ts).
    const agentWake = !stopped && quietAgentWake({ trigger: flags.trigger, status, sawPr: Boolean(flags.sawPr), prBefore: flags.prBefore, prAfter: prMark(row) })
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
    }, { quiet: stopped || agentWake })
    this.settleMergeRequest(row.id, "turn")
    if (row.box_id) this.store.touchBox(row.box_id)

    const cost = turnCost !== null ? ` · $${turnCost.toFixed(3)}` : ""
    this.addEvent(row.id, `Turn ${row.turn_count} ${stopped ? "stopped" : status === "failed" ? "failed" : "finished"}${cost}.`, timing)
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
    else if (status === "done") this.finishedNotice(row, `✅ **${row.title}** is done: ${gist}`, agentWake)
    else if (status === "failed") this.notice(`❌ **${row.title}** failed: ${preview(error ?? "", 300, "call get_task for the full error")}`, { taskId: row.id })
    else if (!stopped && !more && (status === "idle" || status === "pr_ready")) {
      this.finishedNotice(row, `💬 **${row.title}** finished its turn: ${gist || "(no reply)"}`, agentWake)
    }
    // The PR as it stands now: turn_end just asked GitHub (head commit and state), or the runner's push if it couldn't.
    const livePr = Boolean(row.pr_url) && !isFinalPrState(pr ?? row.pr_state)
    if (!stopped) this.turnEvents(row, status, Boolean(more), Boolean(finished && isQuietRun(finished)), flags, livePr, agentWake)

    this.emitTask(row.id)
    this.publishDirectory()
    // Done when its PR merges: archived and its box slot freed, as close_task does.
    if (mergedDone) this.mergedDone(row.id)
    else if (askOtherPrs) void this.doneIfOtherPrsSettled(row.id, true)
    void this.archive(row.id).finally(() => this.schedule())
    this.schedule()
  }

  /**
   * A finished turn's timings into turn_timings (shared/turnTimings.ts): the runner's reading of the CLI run (box clock)
   * plus the server's side, from the request through the launch to this poll seeing turn_end. Its id, or null when the
   * runner sent none (an older runner, a crash). Instrumentation only: it never fails the turn.
   */
  private recordTurnTiming(row: TaskRow, ev: WorkerEvent): { timingId: string; timingMs: number } | null {
    const turnId = row.current_turn_id!
    const launch = this.turnLaunches.get(turnId) ?? null
    this.turnLaunches.delete(turnId)
    const t = ev.timing as (TurnClockReading & { preSpawnMs?: number; processMs?: number | null; mcpMs?: number | null }) | null | undefined
    if (!t || typeof t.startedAt !== "number" || typeof t.endedAt !== "number" || !Array.isArray(t.steps)) return null
    try {
      const { preSpawnMs: _pre, runnerStartedAt: _runner, processMs, mcpMs, ...reading } = t as typeof t & { runnerStartedAt?: number }
      const id = `tim_${turnId.replace(/^[a-z]+_/, "")}`
      const timing = turnTiming(reading, {
        id,
        role: "task",
        kind: row.compacting ? "compact" : "turn",
        projectId: row.project_id,
        taskId: row.id,
        sessionId: typeof ev.sessionId === "string" ? ev.sessionId : row.session_id,
        model: launch?.model ?? row.model ?? null,
        effort: launch?.effort ?? null,
        trigger: launch?.trigger ?? null,
        resumed: typeof ev.resumed === "boolean" ? ev.resumed : (launch?.resumed ?? false),
        requestedAt: launch?.requestedAt ?? null,
        launchedAt: launch?.launchedAt ?? null,
        // Server clock → box clock: on an Upstash box both keep NTP time.
        setupMs: launch ? Math.max(0, reading.startedAt - launch.launchedAt) : null,
        processMs: processMs ?? null,
        mcpMs: mcpMs ?? null,
        seenAt: Date.now(),
      })
      this.store.recordTurnTiming(timing)
      return { timingId: id, timingMs: timing.totalMs }
    } catch (err) {
      console.error(`[box-yard] couldn't record the timings of ${turnId}:`, err)
      return null
    }
  }

  /**
   * Auto-sizing: a finished turn's measurements into turn_peaks (server/turnPeaks.ts), or null when no probe measured
   * it. `failed`: an out-of-memory kill while other projects' turns shared the box counts for it, and so does its
   * agent being killed outright (exit 137).
   */
  private recordTurnPeak(turnId: string, ev: WorkerEvent, failed: boolean): MeasuredTurn | null {
    const m = this.meter.take(turnId, { failed, killed: failed && ev.exitCode === 137 })
    if (!m) return null
    this.store.recordTurnPeak(m)
    this.turnPeakCache.delete(m.projectId)
    return m
  }

  /**
   * A turn that ran out of memory on a `from` box: retried on the size auto-sizing picks now (`to`), or why not. Once
   * in a row, with Settings › Size and resize boxes automatically on and no box size of the project's own; a second
   * one fails as usual.
   */
  private oomRetry(row: TaskRow, flags: TurnFlags, from: BoxSize): { to: BoxSize } | { why: string } {
    if (flags.oomRetries) return { why: "it already had its retry on a bigger box" }
    const auto = this.autoBoxSize(row.project_id)
    if (auto.override) return { why: `its project's Box size is set to ${auto.override}, so Box Yard doesn't pick one (raise it in the project's settings)` }
    if (!auto.enabled) return { why: "Settings › Size and resize boxes automatically is off" }
    if (auto.size && compareSizes(auto.size, from) > 0) return { to: auto.size }
    return { why: from === BOX_SIZES[BOX_SIZES.length - 1] ? "there's no bigger box" : `Settings › Max size it may choose is ${this.settings.get().autoResizeMaxSize}` }
  }

  /**
   * A turn that ran out of memory on its Upstash box (auto-sizing, `oomRetry`): queued again to carry on in the same
   * session on a `to` box. Its turn-end archive is written first, and `leaveSmallBox` then moves it there like any
   * task below its project's size. The Captain gets a notice.
   */
  private retryAfterOom(row: TaskRow, ev: WorkerEvent, flags: TurnFlags, from: BoxSize, to: BoxSize) {
    const error = String(ev.error ?? "The agent exited with an error.")
    const turnCost = this.recordTaskClaudeUsage(row, ev)
    this.store.finishTaskTurn(row.current_turn_id!, { status: "interrupted", costUsd: turnCost, error })
    const ram = (size: BoxSize) => `${size}, ${BOX_SIZE_SPECS[size].ramGb} GB RAM`
    this.store.queueInput(
      row.id,
      "system",
      `Your previous turn ran out of memory on its box (${ram(from)}) and ended with: ${error.slice(0, 300)}. You carry on now on a bigger box (${ram(to)}). Check where things stand (git status, files, any server or build you started) and continue the task, running memory-hungry steps (builds, test suites, browsers) one at a time.`,
    )
    this.store.updateTask(row.id, {
      status: "queued",
      error: null,
      currentTurnId: null,
      ...usageFields(ev.usage),
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : undefined,
      turnFlags: { interrupts: flags.interrupts ?? 0, oomRetries: (flags.oomRetries ?? 0) + 1, ...(flags.hookIds ? { hookIds: flags.hookIds } : {}), ...carriedTrigger(flags) },
    })
    if (row.box_id) this.store.touchBox(row.box_id)
    this.addEvent(row.id, `Turn ${row.turn_count} ran out of memory on its ${from} box ${row.box_id}; it carries on now on a ${to} box instead of failing.`)
    this.notice(`⚠️ **${row.title}** ran out of memory: its ${from} box ${row.box_id} was too small, so it carries on on a ${to} box, and its project's tasks get ${to} boxes from now on.`, { taskId: row.id })
    this.emitTask(row.id)
    this.publishDirectory()
    // The workspace goes to its archive first, so the move to the bigger box loses nothing.
    void this.archive(row.id).finally(() => this.schedule())
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
      turnFlags: { interrupts: flags.interrupts ?? 0, sleeps: (flags.sleeps ?? 0) + 1, ...(flags.hookIds ? { hookIds: flags.hookIds } : {}), ...carriedTrigger(flags) },
    })
    this.addEvent(row.id, `Turn ${row.turn_count} was cut off while this computer slept (${asleep}); it carries on now instead of failing.`)
    this.emitTask(row.id)
    this.publishDirectory()
    this.schedule()
  }

  /**
   * A resting turn's update. A quiet agent wake's goes to the project's Captain only, without waking it (it reads it
   * on its next turn), and to the transcript: not to the Coordinator chat or Zen.
   */
  private finishedNotice(row: TaskRow, content: string, agentWake: boolean) {
    if (!agentWake) return this.notice(content, { taskId: row.id })
    this.onNotice?.(content, { taskId: row.id, agentWake: true }, { wake: false })
    const captain = `${this.store.getProject(row.project_id)?.name ?? "project"} Captain`
    this.addEvent(row.id, `Only other agents' messages started this turn and nothing changed, so its update went to the ${captain}, not the Coordinator chat: ${content}`, { kind: "agent_wake" })
  }

  /** The hook events a finished turn raises. A stopped turn raises none: Cody stepped in. */
  private turnEvents(row: TaskRow, status: TaskStatus, more: boolean, quiet: boolean, flags: TurnFlags, livePr: boolean, agentWake = false) {
    const base = { taskId: row.id, turnId: row.current_turn_id, originHookIds: flags.hookIds ?? [], sawPr: Boolean(flags.sawPr) }
    if (row.schedule_id && ["done", "idle", "pr_ready", "failed"].includes(status) && !more) this.emitTaskEvent({ ...base, type: "schedule.run_finished" })
    // A quiet run did nothing worth acting on; only schedule.run_finished hooks that include quiet runs see it.
    if (quiet) return
    if (status === "failed") this.emitTaskEvent({ ...base, type: "task.failed" })
    else if (status === "needs_input") this.emitTaskEvent({ ...base, type: "task.needs_input" })
    else if (!more && (status === "idle" || status === "pr_ready" || status === "done")) {
      // A quiet agent wake's task.finished fires only the hooks that include agent wakes (HookFilters.includeAgentWakes).
      this.emitTaskEvent({ ...base, type: "task.finished", ...(agentWake ? { agentWake: true } : {}) })
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
    // Coordinator sees: status only. A message across that line would leave one side's words where the Coordinator
    // reads them (the open task's transcript and queue), so agents don't message between a sealed project and an open one.
    if (target.project_id !== from.project_id && this.identities.statusOnly(from.project_id) !== this.identities.statusOnly(target.project_id)) {
      say(from.id, `Message to ${to} not delivered: status only.`, { to, blocked: true })
      this.store.queueInput(
        from.id,
        "system",
        withOwner(
          `Your message to "${to}" was not delivered: Cody set ${this.identities.statusOnly(from.project_id) ? "your project" : "its project"} to show the Coordinator its status only, so agents don't message between it and other projects. Ask your Captain with message_captain if you need something from there.`,
          this.owner(),
        ),
      )
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

  /**
   * Archive a task unless its archive already holds its workspace, before its folder is destroyed. One being written
   * right now (its last turn's, which starts as the turn ends) is waited for first: until it lands, the one before
   * can pass for current within `hasFreshArchive`'s slack, and the folder would go while it's still being read.
   */
  private async archiveUnlessHeld(taskId: string) {
    while (this.archiving.has(taskId)) await new Promise((r) => setTimeout(r, 100))
    const row = this.store.getTaskRow(taskId)
    if (row && !this.archiveHoldsWorkspace(row)) await this.archiveFresh(taskId)
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
   * only `forMove`, when its folder is about to leave (a move to a box, or the local cleanup parking it).
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
    const began = Date.now()
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
        // A turn that started while this ran (the next one starts as soon as a turn ends) may have changed the
        // folder after it was read, so the archive is only as new as its start: else it would pass for one from
        // after that turn, and a delete or move would skip archiving it again.
        const ranSince = (this.store.lastTurnStartedAt(taskId) ?? 0) >= began
        this.store.updateTask(taskId, { archivePath: file, lastArchivedAt: ranSince ? began : Date.now() })
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
      // An SSH machine's root comes from its record, which may be gone by now (removed, or Box Yard stopping).
      try {
        const root = this.provider.root(boxId)
        const stages = [...keepPackStages(root, taskId), ...gitStages(root, taskId)]
        await this.provider.exec(boxId, `rm -rf ${stages.map(q).join(" ")}`).catch(() => {})
      } catch {}
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
      requireSigned: this.identities.requiredSigner(project.id),
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
    // A Codex login stays with Box Yard and the box, never in an archive; Codex's own logs and scratch aren't worth keeping.
    const codex = [`${taskId}/codex-auth.json`, `${taskId}/codex/auth.json`, `${taskId}/codex/log`, `${taskId}/codex/tmp`, `${taskId}/codex/.tmp`, `${taskId}/codex/cache`]
    const excludes = [...ARCHIVE_EXCLUDED_DIRS, `${taskId}/task.json`, `${taskId}/turn.pid`, `${taskId}/run.json`, `${taskId}/events.lock`, `${taskId}/mcp.json`, `${taskId}/signing.key`, ...codex]
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
    // The copies a tmpfs for secrets keeps (an SSH machine's lives as long as the machine, not the turn).
    const secrets = providerOf(this.provider, boxId).secretsDir
    const held = secrets ? ` ${q(`${secrets}/${taskId}.json`)} ${q(`${secrets}/${taskId}.signing.key`)}` : ""
    await this.provider.exec(boxId, `${turnKillScript(dir)}; rm -rf ${q(dir)}${held}`)
  }

  private async evictWhenSettled(taskId: string) {
    for (let i = 0; i < 30; i++) {
      if (this.stopped) return
      const row = this.store.getTaskRow(taskId)
      if (!row) return
      if (!row.current_turn_id) break
      await new Promise((r) => setTimeout(r, 2000))
    }
    await this.archive(taskId, { closing: true })
    // Box Yard may have stopped (and closed the database) while it archived.
    if (this.stopped) return
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id || row.status !== "done") return
    if (isLocalRunnerBox(row.box_id)) return // no archive on this computer: its folder stays, for the local cleanup (server/ownCleanup.ts)
    if (this.c.archiveWorkspaces && !this.hasFreshArchive(row)) return // keep the folder if we have no current copy
    const boxId = row.box_id
    this.store.updateTask(taskId, { boxId: null, portBase: null, previews: [] })
    await this.removeTaskDir(boxId, taskId).catch(() => {})
    this.emitTask(taskId)
    this.emitBoxes()
  }

  // ------------------------------------------------------------------ usage and budget

  /**
   * Box spend against Settings › Daily cloud limit, cached for a few seconds (placement asks for every task).
   * `fresh` reads it again (after a raise or a settings change).
   */
  cloudSpend(fresh = false): CloudSpend {
    const now = Date.now()
    const s = this.settings.get()
    // A change of limits or rates in Settings counts at once.
    const key = JSON.stringify([s.budget, s.costRates])
    if (!fresh && this.cloudCache?.key === key && now - this.cloudCache.at < CLOUD_SPEND_CACHE_MS) return this.cloudCache.spend
    const spend = cloudSpend(this.store, s.budget, s.costRates, now)
    this.cloudCache = { at: now, key, spend }
    return spend
  }

  /** "Raise today's limit": one more day's worth until midnight. New boxes may be made again at once. */
  raiseCloudLimit(by: "user" | "coordinator" | "captain" = "user"): CloudSpend {
    const s = this.settings.get()
    if (s.budget.dailyUsd <= 0) throw new BadRequestError("There's no daily cloud limit to raise (Settings › Usage › Daily cloud limit is off)")
    const raised = raiseToday(this.store, s.budget, this.cloudSpend(true).todayUsd)
    const spend = this.cloudSpend(true)
    const who = by === "user" ? withOwner("Cody", this.owner()) : by === "coordinator" ? "The Coordinator" : "A Captain"
    this.notice(`⚙️ **Cloud limit** raised: ${who} raised today's limit to ${usd(spend.dailyLimitUsd)} (Settings says ${usd(s.budget.dailyUsd)}; ${usd(raised)} more until midnight).`, { kind: "cloud_limit" })
    this.schedule()
    this.emitBoxes()
    return spend
  }

  /** The cloud meter (GET /api/cloud): spend against the limits, $/hour now, and every box with what it cost today. */
  async cloudStatus(): Promise<CloudStatus> {
    this.meterBoxes()
    const now = Date.now()
    const s = this.settings.get()
    const spend = cloudSpend(this.store, s.budget, s.costRates, now)
    this.cloudCache = { at: now, key: JSON.stringify([s.budget, s.costRates]), spend }
    const today = this.store.boxSpendSince(startOfLocalDay(now), s.costRates).byBox
    const recent = this.store.boxSpendSince(now - CLOUD_RATE_WINDOW_MS, s.costRates).totals.costUsd
    const idleDelete = s.boxIdleDeleteMinutes
    const list: CloudBox[] = [...this.store.listBoxes(), ...this.store.listDeletingBoxes()].map((b) => {
      const residents = this.store.listTaskRows({ boxId: b.id })
      const runningTurns = residents.filter(holdsSlot).length
      const idleSince = b.status === "ready" && runningTurns === 0 ? b.last_used_at : null
      return {
        id: b.id,
        status: b.status,
        size: normalizeBoxSize(b.size),
        projects: [...new Set(residents.map((r) => this.store.getProjectName(r.project_id) ?? r.project_id))],
        runningTurns,
        todayUsd: today.get(b.id)?.costUsd ?? 0,
        totalUsd: boxRowCost(b, s.costRates, now),
        idleSince,
        deletesAt: idleSince !== null && idleDelete > 0 ? idleSince + idleDelete * 60_000 : null,
        idleHeld: this.idleHeld.get(b.id) ?? null,
      }
    })
    const gpuSpend = async (g: GpuRunner | null): Promise<CloudStatus["gpu"]> => {
      if (!g?.enabled()) return null
      const pods = await g.provider.listPods().catch(() => null)
      return pods ? { pods: pods.length, hourlyUsd: pods.reduce((sum, p) => sum + (p.pod.cost ?? 0), 0), capUsd: g.settings().totalMaxHourlyUsd } : null
    }
    const [gpu, vast, daytona] = await Promise.all([gpuSpend(this.gpu), gpuSpend(this.vast), gpuSpend(this.daytona)])
    return {
      spend,
      hourlyUsd: (recent * 3_600_000) / CLOUD_RATE_WINDOW_MS,
      boxes: {
        running: list.filter((b) => b.runningTurns > 0).length,
        idle: list.filter((b) => b.status === "ready" && b.runningTurns === 0).length,
        creating: list.filter((b) => b.status === "creating").length,
        total: list.filter((b) => b.status !== "deleting").length,
      },
      ceiling: s.maxBoxes,
      idleDeleteMinutes: idleDelete,
      list,
      gpu,
      vast,
      daytona,
      fanout: this.boxFanout(now),
    }
  }

  /** Say once a day when cloud spend reaches 80% of today's limit, and when it reaches the limit (again after a raise). */
  private noticeCloudSpend() {
    const spend = this.cloudSpend()
    if (spend.state === "ok") return
    const day = localDay(Date.now())
    let seen: { day?: string; warned?: number; reached?: number } = {}
    try {
      seen = JSON.parse(this.store.getKv(CLOUD_NOTICED_KEY) ?? "{}") ?? {}
    } catch {}
    if (seen.day !== day) seen = { day }
    const limit = spend.dailyLimitUsd || spend.monthlyLimitUsd
    if (spend.state === "reached") {
      if (seen.reached === limit) return
      seen.reached = seen.warned = limit
      const raise = spend.dailyLimitUsd > 0 && spend.blockedReason?.startsWith("today") ? "until midnight, or until you raise today's limit (the cloud meter on the Boxes page, a waiting task, or Settings › Usage)" : "until you raise the monthly limit in Settings › Usage"
      this.notice(`⚠️ **Cloud spend** hit the limit: ${spend.blockedReason}. New boxes wait ${raise}; running agents keep going, and free slots on the boxes there are still used.`, { kind: "cloud_limit" }, { coordinator: true })
    } else {
      if (seen.warned === limit) return
      seen.warned = limit
      const what = spend.dailyLimitUsd > 0 && spend.todayUsd >= spend.dailyLimitUsd * 0.8 ? `${usd(spend.todayUsd)} of today's ${usd(spend.dailyLimitUsd)} limit` : `${usd(spend.monthUsd)} of the ${usd(spend.monthlyLimitUsd)} monthly limit`
      this.notice(`⚠️ **Cloud spend** reached 80%: ${what}. At the limit new boxes wait; running work goes on.`, { kind: "cloud_limit" }, { coordinator: true })
    }
    this.store.setKv(CLOUD_NOTICED_KEY, JSON.stringify(seen))
  }

  /** A new box can't be made because a cloud limit or the box ceiling is reached: why, and its one-click fix; else null. */
  private noNewBox(): { text: string; fix: WaitFix } | null {
    const cloud = this.cloudBlock()
    if (cloud) return cloud
    return this.store.listBoxes().length >= this.limits().maxBoxes ? { text: "the pool is at its limit", fix: "box-settings" } : null
  }

  /** A new box can't be made because a cloud limit is reached: the reason and its one-click fix, or null. */
  private cloudBlock(): { text: string; fix: WaitFix } | null {
    const spend = this.cloudSpend()
    if (!spend.blockedReason) return null
    const daily = spend.blockedReason.startsWith("today")
    return {
      text: daily ? `${spend.blockedReason} (raise today's limit, or it resets at midnight)` : `${spend.blockedReason} (raise it in Settings › Usage)`,
      fix: daily ? "raise-cloud-limit" : "cloud-settings",
    }
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

  /** Move each box's measured CPU (or, unmeasured, its running time) into a priced usage interval: see meterTick. */
  private meterBoxes(now = Date.now()) {
    const rates = this.settings.get().costRates
    for (const box of this.store.listBoxes()) {
      if (box.status === "deleting" || box.status === "lost") continue
      const last = box.last_metered_at ?? box.created_at
      const elapsed = Math.max(0, now - last)
      if (elapsed < METER_MIN_MS) continue
      const running = this.store.listTaskRows({ boxId: box.id }).some((r) => r.current_turn_id)
      const size = normalizeBoxSize(box.size)
      const tick = meterTick(box, rates.boxActiveCpuHourlyUsd[size], elapsed, running)
      this.store.recordBoxUsageInterval({
        boxId: box.id,
        provider: box.provider,
        size,
        keepAlive: Boolean(box.keep_alive),
        startedAt: last,
        endedAt: now,
        activeMs: tick.activeMs,
        uptimeMs: elapsed,
        diskBytes: box.disk_bytes,
        source: tick.source,
        computeUsd: tick.computeUsd,
      })
      this.store.meterBox(box.id, { ...tick.patch, lastMeteredAt: now })
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
    }
    // The provider's running totals: meterBoxes prices what they grew by (see meterTick).
    if (typeof probe.cpuNs === "number") this.store.accrueBoxCpu(boxId, "provider", probe.cpuNs, now)
    if (typeof probe.computeUsd === "number") this.store.accrueBoxCompute(boxId, probe.computeUsd, now)
    const row = this.store.getBox(boxId)
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
    // Issue closes that failed for now (network, rate limit) and are due again.
    void this.issues.run()
    this.meter.keepOnly(new Set(this.store.listTaskRows({ status: ["working", "starting"] }).flatMap((r) => (r.current_turn_id ? [r.current_turn_id] : []))))
    for (const box of this.store.listBoxes()) {
      void this.refreshBoxUsage(box.id)
      // A box running a turn has its CPU read every minute (one df there), so its spend and $/hour stay current.
      if (box.status === "ready" && providerOf(this.provider, box.id).ownCgroup && this.store.listTaskRows({ boxId: box.id }).some((r) => r.current_turn_id))
        void this.probeDisk(box.id, 60_000).catch(() => null)
    }
    const active = this.store.listTaskRows({ status: ["working", "starting"] })
    const checkedBoxes = new Map<string, Awaited<ReturnType<BoxProvider["health"]>>>()
    const health = async (boxId: string) => {
      if (!checkedBoxes.has(boxId)) checkedBoxes.set(boxId, await this.provider.health(boxId).catch(() => "unknown" as const))
      return checkedBoxes.get(boxId)!
    }
    /** Docker boxes already recorded as lost this pass (one history row, however many turns ran there). */
    const dockerLost = new Set<string>()

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
        if (h === "error") await this.gpuFor(row.box_id)?.provider.destroy(row.box_id).catch(() => {})
        const cloud = GPU_PROVIDER_LABEL[gpuBoxProvider(row.box_id) ?? "runpod"]
        this.gpuPodEvent({ boxId: row.box_id, kind: "terminated", detail: `Pod ${h}`, actor: { kind: "provider" }, reason: `${cloud} reports the pod ${h === "paused" ? "stopped" : h} while a turn ran.` })
        this.interrupt(this.requireRow(row.id), `its GPU pod ${h === "paused" ? "stopped" : `is ${h}`}`)
        continue
      }
      if (isDockerBox(row.box_id) && h !== "running") {
        // The container stopped (Docker restarted, or someone stopped it) or went with its volume, or Docker itself
        // stopped: the turn died with it. The next turn starts the container again; a workspace that went with its
        // volume comes back from its archive.
        const why = h === "unknown" ? await this.docker?.problem() : null
        if (h === "unknown" && !why) continue
        if (h === "gone" && !dockerLost.has(row.box_id)) {
          dockerLost.add(row.box_id)
          this.dockerEvent({ boxId: row.box_id, kind: "lost", detail: "Its container and volume are gone", actor: { kind: "provider" }, reason: "Docker reports the container and its volume gone while a turn ran." })
        }
        this.interrupt(this.requireRow(row.id), h === "paused" ? "its Docker container stopped" : h === "gone" ? "its Docker container and volume are gone" : `Docker stopped (${why})`)
        continue
      }
      if (isMachineBox(row.box_id) && h !== "running") {
        // Removed from Box Yard under a running turn: nothing can reach it to read the turn's end.
        if (h === "gone" || !this.machineOf(row.box_id)) {
          this.interrupt(this.requireRow(row.id), `its SSH machine ${this.machineName(row.box_id)} was removed from Box Yard`)
          continue
        }
        // Offline (asleep, off the network): the turn may still be running there. Check again soon; placement skips
        // the machine meanwhile, and the turn's end is read once it answers.
        this.lastEventAt.set(row.id, now - STALL_MS / 2)
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
      const probe = await this.turnProcess(row.box_id, row.id).catch(() => null)
      if (!probe || probe.alive) {
        this.lastEventAt.set(row.id, now - STALL_MS / 2) // check again soon
        continue
      }
      await this.turnGone(row, "the worker process stopped without finishing")
    }

    // SSH machines that didn't answer lately: placement skips them until one answers again.
    if (this.machines && now - this.lastMachineRecheckAt >= MACHINE_RECHECK_MS) {
      this.lastMachineRecheckAt = now
      if (await this.machines.recheck(MACHINE_RECHECK_MS).catch(() => false)) this.schedule()
    }

    // Idle boxes too: one deleted in the provider's console has no turn to notice it. After the stalled turns, so
    // a box a running turn noticed first is recorded with that reason.
    await this.reconcileBoxes(RECONCILE_MS)

    // Retire idle boxes when configured to.
    const idleDelete = this.limits().boxIdleDeleteMinutes
    if (idleDelete > 0) {
      for (const box of this.store.listBoxes()) {
        if (box.status !== "ready" || this.boxOps.has(box.id)) {
          this.idleHeld.delete(box.id)
          continue
        }
        if (now - box.last_used_at < idleDelete * 60_000) {
          this.idleHeld.delete(box.id)
          continue
        }
        const residents = this.store.listTaskRows({ boxId: box.id })
        // A task about to start here, or waiting for a turn, keeps the box (placement may be picking it right now).
        if (residents.some((r) => r.current_turn_id || r.status === "starting" || this.wantsTurn(r) || this.store.hasInputs(r.id))) {
          this.idleHeld.delete(box.id)
          continue
        }
        // Only a workspace its archive holds may go (one no agent ever ran in has nothing to keep). One whose archive
        // failed is retried every IDLE_ARCHIVE_RETRY_MS, and the box stays, saying why, until it lands: a box never
        // goes with work only it has.
        const unsaved = residents.filter((r) => r.session_started && !this.archiveHoldsWorkspace(r))
        if (unsaved.length) {
          this.retryIdleArchives(box.id, unsaved, now)
          continue
        }
        this.idleHeld.delete(box.id)
        console.log(`[box-yard] deleting idle box ${box.id}`)
        await this.loseBox(box.id, "Box retired after being idle; workspaces are archived.", true, {
          type: "deleted",
          actor: { kind: "janitor" },
          reason: `Idle for ${Math.round((now - box.last_used_at) / 60_000)} min (Settings retires boxes after ${idleDelete} min); every workspace was archived.`,
        })
        // A delete that doesn't go through leaves a box with no row: the orphan sweep deletes it (cleanupOrphanBoxes).
        await this.provider.destroy(box.id).catch((err) => console.warn(`[box-yard] destroy idle box ${box.id}: ${errorMessage(err)}; the orphan sweep retries it`))
      }
    } else this.idleHeld.clear()
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
    this.ownComputersUpkeep(now)
    await this.sweepGpuPods(now)
    await this.sweepDocker(now)
    this.schedule()
  }

  /**
   * An idle box due for deletion holds workspaces its archives don't: archive them again (each at most every
   * IDLE_ARCHIVE_RETRY_MS, so a failing one doesn't hammer the box), and keep the box until they land. The reason is
   * on the box (BoxInfo.idleHeld) so the cost of keeping it isn't silent.
   */
  private retryIdleArchives(boxId: string, unsaved: TaskRow[], now: number) {
    for (const r of unsaved) {
      if (this.archiving.has(r.id) || now < (this.idleArchiveRetryAt.get(r.id) ?? 0)) continue
      this.idleArchiveRetryAt.set(r.id, now + IDLE_ARCHIVE_RETRY_MS)
      void this.archive(r.id).catch((err) => console.warn(`[box-yard] idle archive ${r.id}: ${errorMessage(err)}`))
    }
    const failing = unsaved.find((r) => this.archiveErrors.has(r.id))
    const why = failing
      ? `Kept though idle: archiving ${failing.title} keeps failing (${this.archiveErrors.get(failing.id)}); Box Yard retries every ${Math.round(IDLE_ARCHIVE_RETRY_MS / 60_000)} min`
      : `Kept though idle: archiving ${unsaved.length === 1 ? unsaved[0]!.title : `${unsaved.length} tasks`} first`
    if (this.idleHeld.get(boxId) !== why) {
      this.idleHeld.set(boxId, why)
      this.emitBoxes()
    }
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
   * Task folders on this computer and on SSH machines, every OWN_UPKEEP_MS (server/ownCleanup.ts): Settings › Free a
   * finished task's build output, Task folders kept and the low-disk floor. Only computers that hold task folders, and
   * only SSH machines that work right now.
   */
  private ownComputersUpkeep(now: number) {
    if (now - this.lastOwnUpkeepAt < OWN_UPKEEP_MS) return
    this.lastOwnUpkeepAt = now
    const held = new Set(this.store.listTaskRows().flatMap((r) => (r.box_id && (isLocalRunnerBox(r.box_id) || isMachineBox(r.box_id)) ? [r.box_id] : [])))
    const boxIds = [...held].filter((id) => {
      if (isLocalRunnerBox(id)) return true
      const m = this.machineOf(id)
      return Boolean(m?.enabled && !this.machines!.problem(m))
    })
    // Not awaited: archiving a backlog of old folders mustn't hold up maintain() (stalled turns, lost boxes). A pass
    // still running on a computer makes the next one there skip it.
    for (const id of boxIds) void this.ownCleanup.upkeep(id, now)
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
    this.captainWaits.delete(row.id)
    if (row.current_turn_id) this.store.finishTaskTurn(row.current_turn_id, { status: "interrupted", error: reason })
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
      this.store.updateTask(row.id, { status: "queued", currentTurnId: null, turnFlags: { interrupts, ...(flags.hookIds ? { hookIds: flags.hookIds } : {}), ...carriedTrigger(flags) } })
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
    this.store.setKv(boxCredsKey(boxId), null)
    this.janitor.forget(boxId)
    this.meter.forgetBox(boxId)
    this.diskCache.delete(boxId)
    this.unreachable.delete(boxId)
    this.reserved.delete(boxId)
    this.lowBoxes.delete(boxId)
    this.idleHeld.delete(boxId)
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
