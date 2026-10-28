import express, { type NextFunction, type Request, type Response } from "express"
import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { z } from "zod"
import { selfUrl } from "./bind.js"
import { configProblems, qstashEnabled, redisEnabled, tildePath, type Config } from "./config.js"
import { openDb, type DB } from "./db.js"
import { Store, BadRequestError, NotFoundError } from "./store.js"
import { Hub } from "./hub.js"
import { Artifacts } from "./artifacts.js"
import { Uploads, uploadsDir, tooLarge } from "./uploads.js"
import { TaskManager, type DockerRunner, type GpuRunner, type TaskManagerDeps } from "./tasks.js"
import { Orchestrator } from "./orchestrator.js"
import { MAX_QUESTION_CHARS, MAX_QUOTE_CHARS, SideThreads } from "./sideThreads.js"
import { CaptainManager } from "./captains.js"
import { SettingsStore, TtsSettingsStore, parseSettingKeys } from "./settings.js"
import { SettingsTools } from "./settingsTools.js"
import { TtsError, TtsService, type TtsOptions } from "./tts.js"
import { mcpHandler } from "./mcp.js"
import { ProjectNotes, MAX_NOTE_CHARS } from "./notes.js"
import { NotesRetro, retroSuggestionIds } from "./retro.js"
import { Auth } from "./auth.js"
import { Redis } from "./redis.js"
import { LocalProvider, LocalRunnerProvider, LocalRunnerRouter } from "./providers/local.js"
import { UpstashProvider } from "./providers/upstash.js"
import { AutoProvider } from "./providers/auto.js"
import type { BoxProvider } from "./providers/types.js"
import { redact, type CredentialStore } from "./credentials.js"
import { Setup, type SetupDeps } from "./setup.js"
import { CREDENTIAL_KEYS, type CredentialKey } from "../shared/setup.js"
import { startSelfHold, startSelfSnapshots } from "./backup.js"
import { buildInfo } from "./build.js"
import { Scheduler } from "./scheduler.js"
import { heavyDevRoutes, seedHeavy } from "./mockHeavy.js"
import { QStash, verifyQStashSignature } from "./qstash.js"
import { describeCron, nextRuns, parseCron, isValidTimeZone } from "../shared/cron.js"
import { HookStore } from "./hookStore.js"
import { HookEngine } from "./hooks.js"
import { HOOK_ACTIONS, HOOK_SOURCES, HOOK_TEMPLATES, HOOK_TRIGGERS } from "../shared/hooks.js"
import { DEFAULT_OWNER_NAME } from "../shared/owner.js"
import { NOTE_BUDGET_LIMITS } from "../shared/notes.js"
import { RUNNERS, SETUP_RUNNERS, type Runner } from "../shared/runner.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { RunPodService } from "./runpod/service.js"
import { Identities } from "./identity/identities.js"
import { IdentityDetector } from "./identity/detect.js"
import { SecretBox } from "./identity/secretBox.js"
import { isGpuBox, shortGpu } from "../shared/runpod.js"
import { isDockerBox } from "../shared/docker.js"
import { gpuMachinePatch } from "./runpod/settings.js"
import { DockerService } from "./docker/service.js"
import { projectDockerPatch } from "./docker/settings.js"
import { BOX_SIZES, EFFORTS, PROJECT_BOX_LIMITS, type Health } from "../shared/types.js"
import { BOX_ACTORS, BOX_EVENT_TYPES, type BoxActorKind, type BoxEventType } from "../shared/boxHistory.js"
import { CLOUD_PROVIDERS, MAX_TTS_CHARS } from "../shared/tts.js"

const idSchema = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9-]{6,40}$/)
  .optional()
const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Env var names must be like MY_VAR"), z.string())

const attachmentIds = z.array(z.string()).max(20).optional()

/** A project's own notes budget; null goes back to the one in Settings. */
/** A project's own box settings; null clears one (the global setting applies). */
const projectBoxLimits = {
  agentsPerBox: z.number().int().min(PROJECT_BOX_LIMITS.agentsPerBox.min).max(PROJECT_BOX_LIMITS.agentsPerBox.max).nullable().optional(),
  wholeMachine: z.boolean().optional(),
  tasksPerBox: z.number().int().min(PROJECT_BOX_LIMITS.tasksPerBox.min).max(PROJECT_BOX_LIMITS.tasksPerBox.max).nullable().optional(),
  maxBoxes: z.number().int().min(PROJECT_BOX_LIMITS.maxBoxes.min).max(PROJECT_BOX_LIMITS.maxBoxes.max).nullable().optional(),
  gpuMaxHourlyUsd: z.number().min(PROJECT_BOX_LIMITS.gpuMaxHourlyUsd.min).max(PROJECT_BOX_LIMITS.gpuMaxHourlyUsd.max).nullable().optional(),
  gpuMachine: gpuMachinePatch.optional(),
  docker: projectDockerPatch.optional(),
}

const projectNotesBudget = {
  notesMaxCount: z.number().int().min(NOTE_BUDGET_LIMITS.maxNotes.min).max(NOTE_BUDGET_LIMITS.maxNotes.max).nullable().optional(),
  notesMaxTokens: z.number().int().min(NOTE_BUDGET_LIMITS.maxTokens.min).max(NOTE_BUDGET_LIMITS.maxTokens.max).nullable().optional(),
}

const labelList = z.array(z.string().trim().min(1).max(100)).max(30).optional()
const hookFilters = z.object({
  projectId: z.string().min(1).nullish(),
  titleRegex: z.string().max(300).nullish(),
  promptRegex: z.string().max(300).nullish(),
  sources: z.array(z.enum(HOOK_SOURCES)).optional(),
  labels: labelList,
  excludeLabels: labelList,
  includeDrafts: z.boolean().optional(),
  includeQuiet: z.boolean().optional(),
  includeAgentWakes: z.boolean().optional(),
})

const schemas = {
  tts: z
    .object({
      text: z.string().max(MAX_TTS_CHARS * 2),
      provider: z.enum(CLOUD_PROVIDERS as [string, ...string[]]).optional(),
      voice: z.string().max(64).optional(),
      model: z.string().max(80).optional(),
      speed: z.number().optional(),
      instructions: z.string().max(2000).optional(),
    })
    .strict(),
  notificationsRead: z
    .object({ ids: z.array(z.string().max(64)).max(500).optional(), taskId: z.string().max(64).optional(), all: z.boolean().optional() })
    .refine((b) => b.all || b.taskId || b.ids?.length, "Pass ids, taskId or all"),
  project: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    repo: z.string().max(300).nullable().optional(),
    baseBranch: z.string().max(200).optional(),
    env: envSchema.optional(),
    boxSize: z.enum(BOX_SIZES).nullable().optional(),
    partialClone: z.boolean().nullable().optional(),
    pushAtTurnEnd: z.boolean().nullable().optional(),
    depCache: z.boolean().nullable().optional(),
    runner: z.enum(RUNNERS).optional(),
    identityId: z.string().min(1).max(64).optional(),
    ...projectBoxLimits,
    ...projectNotesBudget,
  }),
  projectOrder: z.object({ ids: z.array(z.string().max(64)).max(1000) }).strict(),
  projectPatch: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    repo: z.string().max(300).nullable().optional(),
    baseBranch: z.string().max(200).optional(),
    env: envSchema.optional(),
    removeEnv: z.array(z.string()).optional(),
    boxSize: z.enum(BOX_SIZES).nullable().optional(),
    partialClone: z.boolean().nullable().optional(),
    pushAtTurnEnd: z.boolean().nullable().optional(),
    depCache: z.boolean().nullable().optional(),
    runner: z.enum(RUNNERS).optional(),
    identityId: z.string().min(1).max(64).optional(),
    ...projectBoxLimits,
    ...projectNotesBudget,
  }),
  note: z.object({ content: z.string().trim().min(1).max(MAX_NOTE_CHARS) }),
  task: z.object({
    id: idSchema,
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(50_000),
    env: envSchema.optional(),
    model: z.string().trim().max(100).nullish(),
    effort: z.enum(EFFORTS).nullish(),
    attachments: attachmentIds,
    /** Run on this computer ("local") or a box over the project's "Runs on", for every turn (Task.runsOn). */
    runsOn: z.enum(RUNNERS).nullish(),
  }),
  message: z.object({ content: z.string().trim().max(50_000), attachments: attachmentIds, runsOn: z.enum(RUNNERS).optional() }),
  queuedEdit: z.object({ text: z.string().max(50_000), version: z.number().int().positive().optional() }),
  sendNow: z.object({ allowMergeInterrupt: z.boolean().optional() }),
  chat: z.object({ id: idSchema, content: z.string().trim().max(50_000), attachments: attachmentIds }),
  sideThread: z.object({
    id: idSchema,
    /** Omitted or null: the Coordinator chat; else that project's Captain chat. */
    projectId: z.string().min(1).nullish(),
    anchorId: z.string().min(1).max(100),
    quote: z.string().trim().min(1).max(MAX_QUOTE_CHARS),
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
    messageId: idSchema,
  }),
  sideThreadMessage: z.object({ id: idSchema, content: z.string().trim().min(1).max(MAX_QUESTION_CHARS) }),
  login: z.object({ password: z.string() }),
  schedule: z.object({
    id: idSchema,
    target: z.enum(["project", "orchestrator"]).optional(),
    projectId: z.string().min(1).nullish(),
    name: z.string().trim().min(1).max(120),
    cron: z.string().trim().min(1).max(200),
    timezone: z.string().max(100).optional(),
    prompt: z.string().trim().min(1).max(50_000),
    enabled: z.boolean().optional(),
    catchUp: z.enum(["once", "skip"]).optional(),
    allowOverlap: z.boolean().optional(),
  }),
  hook: z.object({
    projectId: z.string().min(1).nullable(),
    name: z.string().trim().min(1).max(120),
    trigger: z.enum(HOOK_TRIGGERS),
    filters: hookFilters.optional(),
    action: z.enum(HOOK_ACTIONS),
    taskTitle: z.string().max(120).nullish(),
    prompt: z.string().trim().min(1).max(20_000),
    enabled: z.boolean().optional(),
    allowSelfTrigger: z.boolean().optional(),
    maxFiresPerTask: z.number().int().min(1).max(50).optional(),
    template: z.enum(HOOK_TEMPLATES).nullish(),
  }),
  hookPatch: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    trigger: z.enum(HOOK_TRIGGERS).optional(),
    filters: hookFilters.optional(),
    action: z.enum(HOOK_ACTIONS).optional(),
    taskTitle: z.string().max(120).nullish(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    enabled: z.boolean().optional(),
    allowSelfTrigger: z.boolean().optional(),
    maxFiresPerTask: z.number().int().min(1).max(50).optional(),
  }),
  hookTemplate: z.object({
    projectId: z.string().min(1).nullable(),
    template: z.string().min(1),
    enabled: z.boolean().optional(),
  }),
  schedulePatch: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().max(100).optional(),
    prompt: z.string().trim().min(1).max(50_000).optional(),
    enabled: z.boolean().optional(),
    catchUp: z.enum(["once", "skip"]).optional(),
    allowOverlap: z.boolean().optional(),
  }),
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const res = schema.safeParse(body)
  if (!res.success) {
    throw new BadRequestError(res.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "))
  }
  return res.data
}

/**
 * BOX_PROVIDER, or UPSTASH_BOX_API_KEY in the env, fixes where boxes are made, as before. With neither (a first run),
 * boxes are folders on this machine until an Upstash key is saved in Settings › Credentials, then Upstash boxes,
 * with no restart. Without `credentials` (scripts), only the env counts.
 */
export function makeProvider(c: Config, credentials?: CredentialStore): BoxProvider {
  if (c.provider === "upstash") return new UpstashProvider(c, credentials)
  const local = new LocalProvider(path.join(c.dataDir, "local-boxes"), c.claudeBin)
  if (!credentials || c.mock || c.boxProvider === "local") return local
  return new AutoProvider(local, new UpstashProvider(c, credentials), () => Boolean(credentials.get("upstashBoxApiKey")))
}

/** The local runner: agents of "Runs on: This computer" projects, in `<localDir>/<task_id>` (BOXYARD_LOCAL_DIR). */
export function localRunner(c: Config): LocalRunnerProvider {
  return new LocalRunnerProvider(c.localDir, c.claudeBin)
}

export interface BoxYard {
  app: express.Express
  db: DB
  store: Store
  hub: Hub
  tasks: TaskManager
  orchestrator: Orchestrator
  captains: CaptainManager
  threads: SideThreads
  scheduler: Scheduler
  settings: SettingsStore
  /** The Coordinator's get_settings / update_settings, on the Settings UI's save paths. */
  settingsTools: SettingsTools
  /** Settings › Credentials and the first-run setup status (GET /api/setup). */
  setup: Setup
  ttsSettings: TtsSettingsStore
  tts: TtsService
  hooks: HookEngine
  notes: ProjectNotes
  retro: NotesRetro
  /** Settings › Docker and the containers behind "Runs on: Docker container" (docs/docker.md). */
  docker: DockerService
  /** Settings › Identities: the GitHub account, author and Claude login each project's agents use (docs/identities.md). */
  identities: Identities
  start(): Promise<void>
  stop(): void
}

/** Wire up the database, task manager, orchestrator and HTTP routes. */
export function createBoxYard(
  c: Config,
  opts: {
    provider?: BoxProvider
    /** Stands in for the local runner (tests); it is always routed LOCAL_BOX_ID. */
    localRunner?: BoxProvider
    /** Stands in for RunPod GPU pods (tests): `runpod-*` boxes route to its provider, and placement asks it. */
    gpu?: GpuRunner
    /** Stands in for the Docker runner's placement (tests): `docker-*` boxes route to its provider, and placement asks it. */
    docker?: DockerRunner
    /** Tests: real Docker containers even in mock mode, whose agents run this claude command (test/docker-real.e2e.test.ts). */
    realDocker?: { claudeBin: string }
    webDir?: string
    qstash?: QStash | null
    now?: () => number
    github?: TaskManagerDeps["github"]
    /** Stand-ins for ElevenLabs' HTTP API and OpenAI's Realtime socket (tests). */
    tts?: Pick<TtsOptions, "fetch" | "WebSocket" | "timeoutMs" | "voicesTtlMs">
    /** Stand-ins for the services the setup Test buttons call (tests). GitHub's comes from `github.fetch`. */
    setup?: Pick<SetupDeps, "listBoxes" | "fetch" | "anthropicBaseUrl" | "timeoutMs" | "localCheck">
  } = {},
): BoxYard {
  const db = openDb(c.dataDir)
  const store = new Store(db)
  if (c.mockHeavy && seedHeavy(db, store)) console.log("[box-yard] seeded the heavy mock dataset (BOXYARD_MOCK_HEAVY=1)")
  const hub = new Hub()
  const artifacts = new Artifacts(store, path.join(c.dataDir, "artifacts"))
  const redis = redisEnabled(c) ? new Redis(c.redisUrl, c.redisToken) : null
  const settings = new SettingsStore(store, c)
  // Project identities (docs/identities.md): their secrets are encrypted with a key that is never in the database.
  const identities = new Identities({
    db,
    secrets: new SecretBox({ dataDir: c.dataDir, envKey: c.secretKey }),
    credentials: settings.credentials,
    github: opts.github?.fetch,
    mock: c.mock,
  })
  /** Reads this computer's gh, git and ssh for detect_identities and the gh:/file:/agent: references (server-side only). */
  const identityDetector = new IdentityDetector({ github: opts.github?.fetch })
  /** Every credential value in effect: no transcript keeps one, and no error shows one. */
  const secretValues = () => [...settings.credentials.secrets(), ...identities.secretValues()]
  store.transcriptSecrets = secretValues
  /** A project's identity has to allow where it runs (Identity.runners). */
  const requireIdentityRunner = (identityId: string, runner: Runner) => {
    const problem = identities.runnerProblem(identities.require(identityId).id, runner)
    if (problem) throw new BadRequestError(`Can't run there: ${problem}.`)
  }
  // RunPod GPU pods, for projects that run on "RunPod GPU" (docs/runpod.md). Idle until a RunPod key is set.
  const install = () => {
    let id = store.getKv("install_id")
    if (!id) store.setKv("install_id", (id = randomUUID().slice(0, 8)))
    return id
  }
  const runpod = new RunPodService({
    store,
    credentials: settings.credentials,
    dataDir: c.dataDir,
    install,
    git: { name: c.gitUserName, email: c.gitUserEmail },
  })
  // Docker containers on this computer, for projects that run on "Docker container" (docs/docker.md). Docker is only
  // asked when one is needed; in mock mode the containers are folders.
  const dockerService = new DockerService({
    store,
    credentials: settings.credentials,
    install,
    git: { name: c.gitUserName, email: c.gitUserEmail },
    bin: c.dockerBin || null,
    mock: c.mock && !opts.realDocker ? { dir: path.join(c.dataDir, "docker-boxes"), claudeBin: c.claudeBin } : null,
    claudeBin: opts.realDocker?.claudeBin,
  })
  // Every box provider gets the local runner, the GPU pods and the Docker containers beside it (shared/runner.ts).
  const gpu = opts.gpu ?? runpod
  const docker = opts.docker ?? dockerService
  // A task's GPU pod or Docker container as its placement shows it: the GPU type and pod id, or the container's name,
  // as this process last saw them (no API or Docker call).
  store.placeExtra = (boxId) => {
    if (isDockerBox(boxId)) {
      const name = docker.provider.cached().find((x) => x.boxId === boxId)?.name
      return name ? { container: name } : null
    }
    if (!isGpuBox(boxId)) return null
    const pod = gpu?.provider.cached(boxId)
    return pod ? { podId: pod.id, gpu: pod.gpu?.id ? shortGpu(pod.gpu.id) : null } : null
  }
  const provider = new LocalRunnerRouter(opts.provider ?? makeProvider(c, settings.credentials), opts.localRunner ?? localRunner(c), gpu.provider, docker.provider)
  const setup = new Setup({
    c,
    store,
    credentials: settings.credentials,
    settings,
    provider: () => provider.name,
    githubFetch: opts.github?.fetch,
    dockerProblem: () => docker.problem(),
    ...opts.setup,
  })
  const ttsSettings = new TtsSettingsStore(store, c)
  const tts = new TtsService({
    settings: ttsSettings,
    baseUrls: { elevenlabs: c.elevenlabsBaseUrl.replace(/\/+$/, ""), openai: c.openaiBaseUrl.replace(/\/+$/, "") },
    ...opts.tts,
  })
  const uploads = new Uploads(uploadsDir(c.dataDir), c.maxUploadMb * 1024 * 1024)
  // Read the running commit now, before a `git pull` can move HEAD under this process.
  buildInfo()
  const tasks = new TaskManager({ config: c, store, provider, hub, redis, artifacts, uploads, settings, github: opts.github, gpu, docker, identities })
  tasks.runnerProblem = (runner) => setup.runnerProblem(runner)
  runpod.onPodEvent = (e) => tasks.gpuPodEvent(e)
  runpod.onProgress = (boxId, message) => tasks.startProgress(boxId, message)
  runpod.images.onChange(() => hub.broadcast({ type: "runpod.build", build: runpod.images.status() }))
  dockerService.onEvent = (e) => tasks.dockerEvent(e)
  dockerService.onProgress = (boxId, message) => tasks.startProgress(boxId, message)
  dockerService.images.onChange(() => hub.broadcast({ type: "docker.build", build: dockerService.images.status() }))
  // Waiting tasks look again: a new token, Claude login or runner list can change where (and whether) they run.
  identities.onChange(() => {
    hub.broadcast({ type: "identities", identities: identities.list() })
    tasks.schedule()
  })
  const qstash = opts.qstash !== undefined ? opts.qstash : qstashEnabled(c) ? new QStash(c.qstashToken, c.qstashUrl) : null
  const mcpToken = randomBytes(24).toString("hex")
  // Claude sessions on this computer reach /mcp on the address we listen on (127.0.0.1 unless HOST is one IP).
  const mcpUrl = `${selfUrl(c.host, c.port)}/mcp`
  const captains = new CaptainManager(c, store, hub, { url: mcpUrl, token: mcpToken }, settings)
  const orchestrator = new Orchestrator(c, store, hub, { url: mcpUrl, token: mcpToken }, settings)
  const scheduler = new Scheduler({ config: c, store, tasks, hub, orchestrator, qstash, now: opts.now })
  const threads = new SideThreads(c, store, hub, settings, mcpUrl, (projectId) => (projectId ? captains.threadHost(projectId) : orchestrator.threadHost()))
  tasks.onNotice = (content, meta, opts) => {
    const wake = opts.wake !== false
    const handled = captains.notice(content, meta, { wake })
    // With opts.coordinator the Coordinator still reads it with its next updates (TaskManager.notice leaves it unseen).
    if (wake && !handled) orchestrator.nudge()
    return handled
  }
  // An agent's message_captain goes to its own project's Captain; the Captain's turn tells a still-waiting agent it's done.
  tasks.onCaptainMessage = (projectId, input) => captains.fromAgent(projectId, input)
  captains.onAgentMessagesHandled = (_projectId, messages, reply) => tasks.captainHandledAgentMessages(messages, reply)
  captains.claudeLogin = (projectId) => identities.ownClaude(projectId)
  const hooks = new HookEngine({
    store,
    hooks: new HookStore(db),
    tasks,
    hub,
    messageCaptain: (projectId, content, meta) => void captains.get(projectId).send(content, { source: "hook", meta }),
    messageCoordinator: (content, meta) => void orchestrator.hookMessage(content, meta),
    ownerName: () => settings.get().ownerName,
  })
  hooks.start()
  const notes = new ProjectNotes({
    store,
    hub,
    settings,
    publish: (projectId) => tasks.publishNotes(projectId),
    tellCaptain: (projectId, content, meta) => captains.projectNotice(projectId, content, meta),
  })
  const retro = new NotesRetro({
    store,
    subscribe: (listener) => tasks.subscribe(listener),
    enabled: () => settings.get().notesRetroEnabled,
    deliver: (projectId, content, meta) => captains.projectNotice(projectId, content, meta),
    budget: (projectId) => notes.budgetStatus(projectId),
    ownerName: () => settings.get().ownerName,
    changed: (projectId) => notes.suggestionsChanged(projectId),
  })
  retro.start()
  // The Captain's turn that read a retro is over: whatever it left pending is rejected, so nothing waits.
  captains.onNoticesHandled = (projectId, notices, ok) => {
    const ids = notices.flatMap((n) => retroSuggestionIds(n.meta))
    if (ids.length) retro.settle(projectId, ids, ok)
  }
  // A Captain's automatic report, or its reply to a send_to_captain: a notice that wakes the Coordinator, like a task's.
  captains.onReport = (projectId, content, report) => {
    const project = store.getProject(projectId)
    const who = `Captain${project ? ` for ${project.name}` : ""}`
    const msg = report.replyTo
      ? store.addChat("notice", `${who} replied: ${content}`, { projectId, captain: true, replyTo: report.replyTo })
      : store.addChat("notice", `${who}: ${content}`, { projectId, captain: true })
    hub.broadcast({ type: "chat.message", message: msg })
    orchestrator.nudge()
  }
  store.onNotification = (notification) => hub.broadcast({ type: "notification", notification })
  const auth = new Auth(c.password, store)
  const publicUrl = () => c.publicUrl

  let claudeVersion: string | null | undefined
  const checkClaude = () =>
    new Promise<string | null>((resolve) => {
      const [bin, ...pre] = c.claudeBin.split(" ")
      execFile(bin!, [...pre, "--version"], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : stdout.trim()))
    })

  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", true)
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => void ((req as Request & { rawBody?: string }).rawBody = buf.toString("utf8")) }))

  // The Settings UI's saves. The Coordinator's update_settings goes through the same ones, side effects included.
  const saveSettings = (patch: unknown) => {
    const info = settings.update(patch)
    hub.broadcast({ type: "settings", info })
    applyPoolChange()
    // A smaller notes budget can put projects over it: their Captains hear about it.
    notes.checkAllBudgets()
    // Turning the notes retro on picks up what finished while it was off.
    retro.catchUp()
    return info
  }
  const saveRunpodSettings = (patch: unknown) => {
    runpod.store.update(patch)
    applyPoolChange()
  }
  const saveDockerSettings = (patch: unknown) => {
    dockerService.store.update(patch)
    applyPoolChange()
  }
  const saveTtsSettings = (patch: unknown) => {
    const info = ttsSettings.update(patch)
    hub.broadcast({ type: "tts", info })
    return info
  }
  const saveRunner = async (runner: unknown) => {
    setup.setRunner(runner)
    if (setup.onThisComputer()) await setup.refreshLocal()
    const status = setup.status()
    hub.broadcast({ type: "setup", status })
    // A gh login may now stand in for the GitHub token, and /api/health's problems change.
    applyPoolChange()
    return status
  }
  const settingsTools = new SettingsTools({
    settings,
    tts: ttsSettings,
    runpod: runpod.store,
    docker: dockerService.store,
    runner: () => setup.runnerChoice(),
    credentials: () => setup.status().credentials,
    server: () => ({
      timezone: { value: c.defaultTimezone, envVar: "BOXYARD_TIMEZONE" },
      maxUploadMb: { value: c.maxUploadMb, envVar: "BOXYARD_MAX_UPLOAD_MB" },
      scheduler: { value: scheduler.mode, envVar: "QSTASH_TOKEN", note: "qstash when QSTASH_TOKEN is set, else local" },
      boxProvider: { value: setup.status().boxes.provider, envVar: "BOX_PROVIDER", note: "BOX_PROVIDER, else Upstash once an Upstash key is saved in Settings › Credentials" },
      localDir: { value: tildePath(c.localDir), envVar: "BOXYARD_LOCAL_DIR" },
    }),
    save: { settings: saveSettings, runpod: saveRunpodSettings, docker: saveDockerSettings, voice: saveTtsSettings, runner: saveRunner },
  })

  // MCP endpoint for the Coordinator and Captains (their own token, local only in practice).
  app.all(
    "/mcp",
    mcpHandler(
      { store, tasks, hub, artifacts, publicUrl, scheduler, uploads, settings, settingsTools, captains, hooks, notes, coordinatorCompactionsDir: orchestrator.compactionsDir, defaultRunner: () => setup.defaultRunner(), identities, identityDetector, threads },
      mcpToken,
    ),
  )

  // QStash calls this when a schedule is due. No login: the QStash signature is the auth.
  app.post("/qstash/schedules/:id", express.text({ type: () => true, limit: "1mb" }), (req, res) => {
    const id = String(req.params.id)
    const raw = (req as Request & { rawBody?: string }).rawBody ?? (typeof req.body === "string" ? req.body : "")
    const problem = verifyQStashSignature({
      signature: req.header("upstash-signature"),
      body: raw,
      url: scheduler.qstashUrl(id),
      keys: [c.qstashCurrentSigningKey, c.qstashNextSigningKey],
    })
    if (problem) return void res.status(401).json({ error: `QStash signature rejected: ${problem}` })
    // 200 even when there is nothing to do, so QStash doesn't retry.
    res.json({ result: scheduler.fireFromQStash(id) })
  })

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, pid: process.pid })
  })

  // ---- auth
  app.get("/api/me", (req, res) => {
    res.json({ authed: auth.isAuthed(req), authRequired: auth.enabled })
  })
  app.post("/api/login", (req, res) => {
    const { password } = parse(schemas.login, req.body)
    const result = auth.enabled ? auth.attempt(req, password) : ({ ok: true } as const)
    if (result.ok) {
      auth.login(res, req.secure)
      res.json({ ok: true })
    } else if (result.blocked) {
      res.set("Retry-After", String(Math.ceil(result.blocked.retryAfterMs / 1000)))
      res.status(429).json({ error: result.blocked.message })
    } else {
      res.status(401).json({ error: "Wrong password." })
    }
  })
  app.post("/api/logout", (_req, res) => {
    auth.logout(res)
    res.json({ ok: true })
  })

  const api = express.Router()
  api.use(auth.middleware())

  api.get("/health", async (_req, res) => {
    if (claudeVersion === undefined) claudeVersion = await checkClaude()
    // A "This computer" setup may be signed in with the computer's own claude login instead of a token.
    const problems = configProblems({ ...c, ...settings.credentials.values() }, { claudeLogin: setup.localCheck()?.claudeLogin === true })
    if (!claudeVersion) problems.push(`The claude CLI (${c.claudeBin}) was not found for the Coordinator. Install it: npm i -g @anthropic-ai/claude-code`)
    if (tasks.boxError) problems.push(tasks.boxError)
    const body: Health = {
      ok: problems.length === 0,
      provider: provider.name,
      mock: c.mock || /fake-claude/.test(c.claudeBin),
      bus: tasks.busMode,
      claude: { available: Boolean(claudeVersion), version: claudeVersion ?? null },
      problems,
      pool: tasks.limits(),
      orchestratorBusy: orchestrator.busy,
      scheduler: scheduler.mode,
      build: buildInfo(),
    }
    res.json(body)
  })

  api.get("/stream", (_req, res) => hub.attach(res))

  // ---- projects
  api.get("/projects", (_req, res) => {
    res.json(store.listProjects())
  })
  api.post("/projects", (req, res) => {
    const body = parse(schemas.project, req.body)
    if (store.findProject(body.name)) throw new BadRequestError(`A project named "${body.name}" already exists.`)
    // Unless it says otherwise, a new project runs where setup chose (This computer or Upstash boxes).
    const runner = body.runner ?? setup.defaultRunner()
    requireIdentityRunner(body.identityId ?? DEFAULT_IDENTITY_ID, runner)
    const project = store.createProject({ ...body, runner })
    hub.broadcast({ type: "project", project })
    res.status(201).json(project)
  })
  // The owner's project order (sidebar drag-to-reorder): every project id, first to last.
  api.put("/projects/order", (req, res) => {
    const projects = store.reorderProjects(parse(schemas.projectOrder, req.body).ids)
    const ids = projects.map((p) => p.id)
    hub.broadcast({ type: "projects.order", ids })
    res.json({ ids })
  })
  api.patch("/projects/:id", (req, res) => {
    const body = parse(schemas.projectPatch, req.body)
    const before = store.getProject(req.params.id!)
    if (before && (body.identityId !== undefined || body.runner !== undefined)) requireIdentityRunner(body.identityId ?? before.identityId, body.runner ?? before.runner ?? "box")
    const project = store.updateProject(req.params.id!, body)
    hub.broadcast({ type: "project", project })
    // A smaller notes budget for this project can put it over: its Captain hears about it.
    notes.checkBudget(project.id)
    // Its waiting tasks look for a slot where it runs now (Local agents, or the box pool), or under its new box limits.
    if (body.runner || [body.boxSize, body.agentsPerBox, body.wholeMachine, body.tasksPerBox, body.maxBoxes, body.gpuMaxHourlyUsd, body.gpuMachine, body.docker, body.identityId].some((v) => v !== undefined)) tasks.schedule()
    if (body.identityId !== undefined && body.identityId !== before?.identityId) hub.broadcast({ type: "identities", identities: identities.list() })
    res.json(project)
  })

  // ---- identities (shared/identities.ts, docs/identities.md): values go in, only fingerprints come out
  api.get("/identities", (_req, res) => {
    res.json(identities.list())
  })
  api.post("/identities", (req, res) => {
    res.status(201).json(identities.create(req.body))
  })
  api.patch("/identities/:id", (req, res) => {
    res.json(identities.update(req.params.id!, req.body))
  })
  /** ?moveProjects=1 moves its projects to Default first; without it, an identity a project uses is refused (409). */
  api.delete("/identities/:id", (req, res) => {
    const { movedProjectIds } = identities.delete(req.params.id!, { moveProjects: req.query.moveProjects === "1" })
    for (const id of movedProjectIds) {
      const project = store.getProject(id)
      if (project) hub.broadcast({ type: "project", project })
    }
    if (movedProjectIds.length) tasks.schedule()
    res.json({ ok: true, movedProjectIds })
  })
  /** Save a GitHub token for one owner ({owner, token}; owner "" serves every owner). GitHub must accept it. */
  api.put("/identities/:id/tokens", async (req, res) => {
    res.json(await identities.saveToken(req.params.id!, req.body))
  })
  api.delete("/identities/:id/tokens", (req, res) => {
    res.json(identities.removeToken(req.params.id!, typeof req.query.owner === "string" ? req.query.owner : ""))
  })
  /** Save the identity's own Claude login ({kind: "api_key" | "oauth_token", value}). */
  api.put("/identities/:id/claude", (req, res) => {
    res.json(identities.saveClaude(req.params.id!, req.body))
  })
  api.delete("/identities/:id/claude", (req, res) => {
    res.json(identities.removeClaude(req.params.id!))
  })
  api.put("/identities/:id/signing", async (req, res) => {
    res.json(await identities.saveSigning(req.params.id!, req.body))
  })
  api.patch("/identities/:id/signing", (req, res) => {
    res.json(identities.setRequireSigned(req.params.id!, req.body))
  })
  api.delete("/identities/:id/signing", (req, res) => {
    res.json(identities.removeSigning(req.params.id!))
  })
  api.delete("/projects/:id", async (req, res) => {
    const id = req.params.id!
    for (const s of store.listSchedules({ projectId: id })) await scheduler.remove(s.id)
    for (const t of store.listTasks({ projectId: id })) await tasks.deleteTask(t.id)
    await tasks.projectDeleted(id)
    store.deleteProject(id)
    hub.broadcast({ type: "project.deleted", projectId: id })
    res.json({ ok: true })
  })
  /** The box size auto-sizing picks for the project from its measured runs (shared/autoSize.ts), for its settings. */
  api.get("/projects/:id/auto-size", (req, res) => {
    const project = store.getProject(req.params.id!)
    if (!project) throw new NotFoundError(`Project ${req.params.id} not found`)
    res.json(tasks.autoBoxSize(project.id))
  })
  // ---- project snapshots (shared/snapshots.ts): new boxes for the project start from one
  /** The project's snapshot and its running or last snapshot job. */
  api.get("/projects/:id/snapshot", (req, res) => {
    const project = store.getProject(req.params.id!)
    if (!project) throw new NotFoundError(`Project ${req.params.id} not found`)
    res.json({ snapshot: project.snapshot, job: tasks.snapshotJob(project.id) })
  })
  /** Take (or replace) the project's snapshot from one of its boxes; answers right away with the running job (SSE project.snapshot follows). 409 while agents run on it. */
  api.post("/projects/:id/snapshot", async (req, res) => {
    const body = parse(z.object({ boxId: z.string().min(1), reason: z.string().max(500).optional() }), req.body ?? {})
    res.status(202).json(await tasks.snapshotBox(body.boxId, req.params.id!, { by: { kind: "cody" }, reason: body.reason ?? null }))
  })
  /** Forget the project's snapshot and delete it at the provider; its new boxes start cold. */
  api.delete("/projects/:id/snapshot", async (req, res) => {
    res.json(await tasks.clearProjectSnapshot(req.params.id!))
  })
  // ---- project notes (curated by the Captain) and agents' note suggestions
  const ownerEditor = () => ({ by: settings.get().ownerName })
  /** A note or suggestion, only through the project it belongs to. */
  const ofProject = <T extends { projectId: string }>(item: T, projectId: string): T => {
    if (item.projectId !== projectId) throw new BadRequestError("That belongs to another project")
    return item
  }
  api.post("/projects/:id/notes", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    notes.add(id, parse(schemas.note, req.body).content, ownerEditor())
    res.status(201).json(store.getProject(id)!)
  })
  api.patch("/projects/:id/notes/:noteId", (req, res) => {
    const id = req.params.id!
    const note = ofProject(notes.require(req.params.noteId!), id)
    notes.update(note.id, parse(schemas.note, req.body).content, ownerEditor())
    res.json(store.getProject(id)!)
  })
  api.delete("/projects/:id/notes/:noteId", (req, res) => {
    const id = req.params.id!
    notes.remove(ofProject(notes.require(req.params.noteId!), id).id, ownerEditor())
    res.json(store.getProject(id)!)
  })
  api.get("/projects/:id/suggestions", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    const all = req.query.status === "all"
    res.json(store.listNoteSuggestions({ projectId: id, status: all ? undefined : ["pending"], limit: all ? 200 : 500 }))
  })
  api.get("/projects/:id/captain", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.state(id))
  })
  api.get("/projects/:id/captain/messages", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.messages(id, 500))
  })
  api.post("/projects/:id/captain/messages", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    const body = parse(schemas.chat, req.body)
    const files = withAttachments(body.content, body.attachments)
    res.status(201).json(captains.send(id, body.content, { id: body.id, attachments: files, source: "cody" }))
  })
  // A message queued mid-turn (meta.queued) can be edited or deleted (Undo: restore) until the next turn takes it.
  api.patch("/projects/:id/captain/messages/:messageId", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.editQueued(id, req.params.messageId!, parse(schemas.queuedEdit, req.body).text))
  })
  api.delete("/projects/:id/captain/messages/:messageId", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.cancelQueued(id, req.params.messageId!))
  })
  api.post("/projects/:id/captain/messages/:messageId/restore", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.restoreQueued(id, req.params.messageId!))
  })
  api.post("/projects/:id/captain/compact", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.requestCompact(id))
  })
  api.get("/projects/:id/captain/compactions", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    res.json(captains.compactions(id))
  })

  // ---- tasks
  api.get("/tasks", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined
    res.json(store.listTasks({ projectId }))
  })
  api.post("/tasks", async (req, res) => {
    const { attachments, model, ...body } = parse(schemas.task, req.body)
    // A runner that can't run fails here with the reason; it never falls back to the other one.
    await tasks.requireRunner(body.runsOn)
    res.status(201).json(tasks.createTask({ ...body, model: model || null, attachments: uploads.resolveAll(attachments) }))
  })
  api.get("/tasks/:id", (req, res) => {
    const task = store.getTask(req.params.id!)
    if (!task) return void res.status(404).json({ error: "Task not found" })
    res.json(task)
  })
  api.get("/tasks/:id/messages", (req, res) => {
    res.json(store.listTaskMessages(req.params.id!, 1000))
  })
  api.post("/tasks/:id/messages", async (req, res) => {
    const body = parse(schemas.message, req.body)
    await tasks.requireRunner(body.runsOn)
    const files = withAttachments(body.content, body.attachments)
    if (body.runsOn) tasks.setRunsOn(req.params.id!, body.runsOn)
    res.json(tasks.sendInput(req.params.id!, body.content, "cody", files))
  })
  // Queued messages (waiting for the task's next turn): list, edit, delete and undo. 409 once a turn has taken one.
  api.get("/tasks/:id/queue", (req, res) => {
    res.json(tasks.listQueue(req.params.id!))
  })
  api.patch("/tasks/:id/queue/:inputId", (req, res) => {
    const body = parse(schemas.queuedEdit, req.body)
    res.json(tasks.editQueued(req.params.id!, req.params.inputId!, body.text, body.version))
  })
  api.delete("/tasks/:id/queue/:inputId", (req, res) => {
    res.json(tasks.cancelQueued(req.params.id!, req.params.inputId!))
  })
  api.post("/tasks/:id/queue/:inputId/restore", (req, res) => {
    res.json(tasks.restoreQueued(req.params.id!, req.params.inputId!))
  })
  // Send now: stop the current turn (like Stop) so the next one delivers every queued message. 409 mid-merge
  // unless allowMergeInterrupt.
  api.post("/tasks/:id/queue/send-now", async (req, res) => {
    const body = parse(schemas.sendNow, req.body ?? {})
    res.json(await tasks.sendQueuedNow(req.params.id!, { by: "cody", allowMergeInterrupt: body.allowMergeInterrupt }))
  })
  api.post("/tasks/:id/compact", (req, res) => {
    res.json(tasks.compactTask(req.params.id!))
  })
  api.post("/tasks/:id/stop", async (req, res) => {
    res.json(await tasks.stopTask(req.params.id!))
  })
  api.post("/tasks/:id/close", async (req, res) => {
    res.json(await tasks.closeTask(req.params.id!))
  })
  // The "Merge PR" button: the standard merge message to the task's session (409 while one is pending for the PR).
  api.post("/tasks/:id/merge", (req, res) => {
    res.json(tasks.requestMerge(req.params.id!))
  })
  api.post("/tasks/:id/retry", (req, res) => {
    res.json(tasks.retryTask(req.params.id!))
  })
  api.post("/tasks/:id/preview", async (req, res) => {
    const port = Number((req.body as { port?: unknown })?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestError("port must be 1-65535")
    res.json(await tasks.previewUrl(req.params.id!, port))
  })
  api.delete("/tasks/:id", async (req, res) => {
    await tasks.deleteTask(req.params.id!)
    res.json({ ok: true })
  })

  // ---- schedules
  api.get("/schedules", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined
    const target = req.query.target === "project" || req.query.target === "orchestrator" ? req.query.target : undefined
    res.json(scheduler.list({ projectId, target }))
  })
  api.get("/schedule-runs", (_req, res) => {
    res.json(store.listScheduleRuns({ limit: 300 }))
  })
  api.get("/schedules/preview", (req, res) => {
    // Validate a cron + time zone and show the next runs, for the create form.
    const cron = String(req.query.cron ?? "")
    const timezone = String(req.query.timezone || c.defaultTimezone)
    try {
      if (!isValidTimeZone(timezone)) throw new Error(`Unknown time zone "${timezone}"`)
      parseCron(cron)
      res.json({ ok: true, description: describeCron(cron), next: nextRuns(cron, Date.now(), timezone, 5), timezone })
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message, next: [], timezone })
    }
  })
  api.post("/schedules", async (req, res) => {
    res.status(201).json(await scheduler.create(parse(schemas.schedule, req.body)))
  })
  api.get("/schedules/:id/runs", (req, res) => {
    res.json(scheduler.runs(req.params.id!))
  })
  api.patch("/schedules/:id", async (req, res) => {
    res.json(await scheduler.update(req.params.id!, parse(schemas.schedulePatch, req.body)))
  })
  api.post("/schedules/:id/run", (req, res) => {
    res.status(201).json(scheduler.runNow(req.params.id!))
  })
  api.delete("/schedules/:id", async (req, res) => {
    await scheduler.remove(req.params.id!)
    res.json({ ok: true })
  })
  api.get("/settings", (_req, res) => {
    // Text-to-speech keys appear only as set/unset plus where they come from.
    res.json({ defaultTimezone: c.defaultTimezone, scheduler: scheduler.mode, maxUploadMb: c.maxUploadMb, ttsKeys: ttsSettings.info().keys, localDir: tildePath(c.localDir) })
  })

  // ---- first-run setup and Settings › Credentials. Values go in, never out: responses carry set/unset and the source.
  api.get("/setup", async (_req, res) => {
    if (setup.onThisComputer()) await setup.refreshLocal()
    res.json(setup.status())
  })
  /** The setup choice of where agents run: "local" (This computer, no Upstash key needed) or "box". New projects follow it. */
  api.put("/setup/runner", async (req, res) => {
    res.json(await saveRunner(parse(z.object({ runner: z.enum(SETUP_RUNNERS) }).strict(), req.body).runner))
  })
  /** Look at this computer's tools and logins again now (the "Check again" button). */
  api.post("/setup/local/check", async (_req, res) => {
    await setup.refreshLocal(true)
    const status = setup.status()
    hub.broadcast({ type: "setup", status })
    res.json(status)
  })
  api.put("/setup/credentials", (req, res) => {
    settings.credentials.update(req.body)
    const status = setup.status()
    hub.broadcast({ type: "setup", status })
    // A new box key or token can unblock queued work, and /api/health's problems change.
    applyPoolChange()
    res.json(status)
  })
  /** Repo names (never the token) for the first prompts Zen suggests. */
  api.get("/setup/repos", async (_req, res) => {
    res.json(await setup.recentRepos())
  })
  /** A cheap live check: the value in the body when there is one (not saved), else the one in effect. */
  api.post("/setup/test/:key", async (req, res) => {
    const key = String(req.params.key)
    if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) throw new BadRequestError(`Unknown credential: ${key}`)
    const { value } = parse(z.object({ value: z.string().max(4000).optional() }).strict(), req.body ?? {})
    res.json(await setup.test(key as CredentialKey, value))
  })

  // ---- RunPod GPU (Settings › RunPod GPU): settings, pods, volumes and the pod image build. No secrets go out.
  const runpodStatus = () =>
    runpod.status({ name: (id) => store.getProjectName(id), running: (boxId) => store.listTaskRows({ boxId }).filter((r) => r.current_turn_id).length })
  api.get("/runpod", async (_req, res) => {
    res.json(await runpodStatus())
  })
  api.put("/runpod/settings", async (req, res) => {
    saveRunpodSettings(req.body)
    res.json(await runpodStatus())
  })
  api.get("/runpod/gpus", async (_req, res) => {
    res.json(await runpod.gpuOptions())
  })
  /** Build Box Yard's pod image with this computer's Docker and push it to `repo` (theirs: docker login is theirs). */
  api.post("/runpod/image/build", async (req, res) => {
    const { repo } = parse(z.object({ repo: z.string().trim().min(3).max(300) }).strict(), req.body)
    runpod.store.update({ imageRepo: repo })
    try {
      res.json(await runpod.images.start(repo))
    } catch (err) {
      throw new BadRequestError((err as Error).message)
    }
  })
  api.post("/runpod/pods/:boxId/keep-warm", async (req, res) => {
    const { minutes } = parse(z.object({ minutes: z.number().int().positive().nullable() }).strict(), req.body)
    await runpod.keepWarm(String(req.params.boxId), minutes)
    res.json(await runpodStatus())
  })
  api.delete("/runpod/volumes/:id", async (req, res) => {
    await runpod.deleteVolume(String(req.params.id))
    res.json(await runpodStatus())
  })

  // ---- Docker (Settings › Docker): settings, containers and the image build. No secrets go out. Deleting a container
  // (and its volume) is DELETE /boxes/docker-<projectId>, which archives its workspaces first like any box.
  const dockerStatus = () =>
    dockerService.status({
      name: (id) => store.getProjectName(id),
      running: (boxId) => store.listTaskRows({ boxId }).filter((r) => r.current_turn_id).length,
      tasks: (boxId) => store.listTaskRows({ boxId }).length,
    })
  api.get("/docker", async (_req, res) => {
    res.json(await dockerStatus())
  })
  api.put("/docker/settings", async (req, res) => {
    saveDockerSettings(req.body)
    res.json(await dockerStatus())
  })
  /** Build Box Yard's agent image now (docker/Dockerfile), in the background; SSE docker.build follows. */
  api.post("/docker/image/build", async (_req, res) => {
    res.json(await dockerService.buildImage())
  })
  /** Stop a project's container; its volume keeps every workspace. 409 while an agent runs in it. */
  api.post("/docker/containers/:boxId/stop", async (req, res) => {
    await tasks.stopDockerContainer(String(req.params.boxId), { actor: { kind: "owner" }, reason: "Stopped from Settings › Docker." })
    res.json(await dockerStatus())
  })

  // ---- text-to-speech (Settings › Voice): settings, the provider proxy and voice lists
  api.get("/tts/settings", (_req, res) => {
    res.json(ttsSettings.info())
  })
  api.put("/tts/settings", (req, res) => {
    res.json(saveTtsSettings(req.body))
  })
  const ttsFailed = (res: Response, err: unknown) => {
    if (!(err instanceof TtsError)) throw err
    res.removeHeader("Content-Type")
    res.removeHeader("X-TTS-Cache")
    res.removeHeader("X-TTS-Voice")
    res.status(err.status).json({ error: err.message, provider: err.provider, upstreamStatus: err.upstreamStatus })
  }
  api.get("/tts/voices", async (req, res) => {
    const provider = String(req.query.provider ?? "")
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) throw new BadRequestError("provider must be elevenlabs or openai")
    try {
      res.json(await tts.voices(provider as (typeof CLOUD_PROVIDERS)[number], req.query.refresh === "1"))
    } catch (err) {
      ttsFailed(res, err)
    }
  })
  /** Synthesize `text` with the saved provider (or the one given) and stream the audio back as it arrives (mp3, or OpenAI's PCM). */
  api.post("/tts", async (req, res) => {
    const body = parse(schemas.tts, req.body) as Parameters<TtsService["synthesize"]>[0]
    let audio: Awaited<ReturnType<TtsService["synthesize"]>>
    try {
      audio = await tts.synthesize(body)
    } catch (err) {
      return ttsFailed(res, err)
    }
    res.on("close", () => {
      if (!res.writableFinished) audio.cancel()
    })
    res.setHeader("Content-Type", audio.contentType)
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-TTS-Cache", audio.cache)
    res.setHeader("X-TTS-Voice", audio.voice)
    try {
      for await (const chunk of audio.chunks) {
        if (res.destroyed) break
        if (!res.write(chunk)) await new Promise((r) => res.once("drain", r))
      }
      res.end()
    } catch (err) {
      // Failed before any audio went out: a normal JSON error. After that, cut the response short.
      if (!res.headersSent) return ttsFailed(res, err)
      res.destroy(err as Error)
    }
  })

  // ---- hooks: `?projectId=<id>` for a project's hooks, `?scope=global` for the Coordinator's, neither for all
  const owner = () => settings.get().ownerName?.trim() || DEFAULT_OWNER_NAME
  const hookScope = (q: Request["query"]) => (q.scope === "global" ? null : typeof q.projectId === "string" ? q.projectId : undefined)
  api.get("/hooks", (req, res) => {
    res.json(hooks.list({ projectId: hookScope(req.query) }))
  })
  api.get("/hooks/templates", (_req, res) => {
    res.json(hooks.templates())
  })
  api.get("/hooks/runs", (req, res) => {
    const scope = hookScope(req.query)
    const limit = Number(req.query.limit) || 100
    res.json(
      hooks.runs({
        projectId: scope ?? undefined,
        hookScope: scope === null ? null : undefined,
        hookId: typeof req.query.hookId === "string" ? req.query.hookId : undefined,
        taskId: typeof req.query.taskId === "string" ? req.query.taskId : undefined,
        limit,
      }),
    )
  })
  api.post("/hooks", (req, res) => {
    res.status(201).json(hooks.create({ ...parse(schemas.hook, req.body), createdBy: owner() }))
  })
  api.post("/hooks/from-template", (req, res) => {
    const body = parse(schemas.hookTemplate, req.body)
    res.status(201).json(hooks.fromTemplate(body.template, { projectId: body.projectId, createdBy: owner(), enabled: body.enabled }))
  })
  api.patch("/hooks/:id", (req, res) => {
    res.json(hooks.update(req.params.id!, parse(schemas.hookPatch, req.body)))
  })
  api.delete("/hooks/:id", (req, res) => {
    hooks.remove(req.params.id!)
    res.json({ ok: true })
  })

  // ---- file attachments. One file per request, sent as the raw body: POST /api/uploads?name=shot.png
  api.post(
    "/uploads",
    (req, res, next) => {
      const length = Number(req.header("content-length") ?? 0)
      if (length > uploads.maxBytes) return next(tooLarge(String(req.query.name || "file"), uploads.maxBytes))
      next()
    },
    express.raw({ type: () => true, limit: uploads.maxBytes }),
    (req, res) => {
      const name = String(req.query.name || "").trim()
      if (!name) throw new BadRequestError("name is required, e.g. /api/uploads?name=screenshot.png")
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const { path: _path, ...file } = uploads.save(name, data)
      res.status(201).json(file)
    },
  )
  api.get("/uploads/:id/:name", (req, res) => {
    const file = uploads.get(String(req.params.id))
    if (!file) return void res.status(404).json({ error: "Not found" })
    // Served as a download or image, never as a page, so an uploaded .html can't act as Box Yard.
    res.setHeader("Content-Type", file.mime)
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Content-Security-Policy", "sandbox")
    res.sendFile(file.path)
  })

  /** Look up the uploads a message refers to; a message needs text or at least one file. */
  const withAttachments = (content: string, ids: string[] | undefined) => {
    const files = uploads.resolveAll(ids)
    if (!content.trim() && !files.length) throw new BadRequestError("content: message is empty")
    return files
  }

  // ---- Coordinator chat (internal routes keep /orchestrator for compatibility)
  api.get("/chat", (_req, res) => {
    res.json(store.listChat(500))
  })
  api.post("/chat", (req, res) => {
    const body = parse(schemas.chat, req.body)
    const files = withAttachments(body.content, body.attachments)
    res.status(201).json(orchestrator.send(body.content, body.id, files))
  })
  // A message queued mid-turn (meta.queued) can be edited or deleted (Undo: restore) until the next turn takes it.
  api.patch("/chat/messages/:messageId", (req, res) => {
    res.json(orchestrator.editQueued(req.params.messageId!, parse(schemas.queuedEdit, req.body).text))
  })
  api.delete("/chat/messages/:messageId", (req, res) => {
    res.json(orchestrator.cancelQueued(req.params.messageId!))
  })
  api.post("/chat/messages/:messageId/restore", (req, res) => {
    res.json(orchestrator.restoreQueued(req.params.messageId!))
  })
  // ---- side threads: a question about a highlighted passage in the Coordinator chat (no projectId) or a Captain's
  const threadChat = (v: unknown) => (typeof v === "string" && v ? v : null)
  api.get("/threads", (req, res) => {
    res.json(threads.list(threadChat(req.query.projectId)))
  })
  api.post("/threads", (req, res) => {
    const body = parse(schemas.sideThread, req.body)
    res.status(201).json(threads.create({ ...body, projectId: body.projectId ?? null }))
  })
  api.get("/threads/:id/messages", (req, res) => {
    res.json(threads.messages(req.params.id!))
  })
  api.post("/threads/:id/messages", (req, res) => {
    const body = parse(schemas.sideThreadMessage, req.body)
    res.status(201).json(threads.send(req.params.id!, body.content, body.id))
  })
  api.post("/threads/:id/stop", (req, res) => {
    threads.get(req.params.id!)
    threads.stop(req.params.id!)
    res.json({ ok: true })
  })
  api.delete("/threads/:id", (req, res) => {
    threads.delete(req.params.id!)
    res.json({ ok: true })
  })
  api.get("/orchestrator", (_req, res) => {
    res.json(orchestrator.state())
  })
  // ?from=&to= (epoch ms) adds `period`: the page's numbers for that range. The client
  // sends its own local midnights, so "Today" and the daily chart follow Cody's time zone.
  api.get("/usage", (req, res) => {
    tasks.boxes()
    const now = Date.now()
    const from = Number(req.query.from)
    const to = req.query.to === undefined ? now : Number(req.query.to)
    const period = req.query.from === undefined ? undefined : { from, to }
    if (period && (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 400 * 24 * 3_600_000)) {
      throw new BadRequestError("from and to must be epoch milliseconds, from before to, at most 400 days apart")
    }
    res.json(store.usageReport(settings.get(), now, period))
  })
  api.post("/orchestrator/compact", (_req, res) => {
    res.json(orchestrator.requestCompact("button"))
  })

  // ---- compaction history
  api.get("/compactions", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10)
    res.json(store.listOrchestratorCompactions({ taskId, limit: Number.isFinite(limit) ? limit : 50 }))
  })
  api.get("/compactions/:id", (req, res) => {
    const record = store.getOrchestratorCompaction(req.params.id!, true)
    if (!record) return void res.status(404).json({ error: "Compaction not found" })
    res.json(record)
  })
  api.get("/task-compactions", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10)
    res.json(store.listTaskCompactions({ taskId, sessionId, limit: Number.isFinite(limit) ? limit : 50 }))
  })
  /** New limits take effect now: waiting tasks may start, and boxes/health refresh. Nothing running is stopped. */
  const applyPoolChange = () => {
    hub.broadcast({ type: "boxes", boxes: tasks.boxes() })
    tasks.schedule()
  }
  api.get("/agent-settings", (_req, res) => {
    res.json(settings.info())
  })
  api.put("/agent-settings", (req, res) => {
    res.json(saveSettings(req.body))
  })
  // No `keys`: forget every saved value. `?keys=slotsPerBox,maxResidentPerBox`: forget only those (unknown keys are a 400).
  api.delete("/agent-settings", (req, res) => {
    const info = settings.reset(req.query.keys === undefined ? undefined : parseSettingKeys(req.query.keys))
    hub.broadcast({ type: "settings", info })
    applyPoolChange()
    notes.checkAllBudgets()
    retro.catchUp()
    res.json(info)
  })
  api.post("/chat/stop", (_req, res) => {
    orchestrator.cancel()
    res.json({ ok: true })
  })

  // ---- artifacts and boxes
  // ---- notifications (task finished / needs you)
  api.get("/notifications", (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10)
    res.json(store.listNotifications(Number.isFinite(limit) ? limit : 50))
  })
  api.post("/notifications/read", (req, res) => {
    const body = parse(schemas.notificationsRead, req.body ?? {})
    const readAt = Date.now()
    const ids = store.markNotificationsRead(body, readAt)
    if (ids.length) hub.broadcast({ type: "notifications.read", ids, readAt })
    res.json({ ids, readAt })
  })

  api.get("/artifacts", (req, res) => {
    const q = req.query as Record<string, string | undefined>
    res.json(store.listArtifacts({ projectId: q.projectId, taskId: q.taskId }))
  })
  // The cloud meter: box spend today against Settings › Daily cloud limit, $/hour now, and the boxes.
  api.get("/cloud", async (_req, res) => {
    res.json(await tasks.cloudStatus())
  })
  // "Raise today's limit": one more day's worth until midnight; boxes waiting on the limit are made at once.
  api.post("/cloud/raise", async (_req, res) => {
    tasks.raiseCloudLimit("user")
    res.json(await tasks.cloudStatus())
  })
  // "Allow more boxes": past the ones Box Yard makes in an hour without asking, for the next hour.
  api.post("/cloud/allow-boxes", async (_req, res) => {
    tasks.allowMoreBoxes("user")
    res.json(await tasks.cloudStatus())
  })
  api.get("/boxes", (_req, res) => {
    // Boxes deleted outside Box Yard drop out in the background (throttled); the SSE "boxes" update follows.
    void tasks.reconcileBoxes()
    res.json(tasks.boxes())
  })
  /** The box history log, newest first: filter by box (deleted ones too), event type and actor; page with ?before=<id>. */
  api.get("/box-history", (req, res) => {
    const f = parse(
      z.object({
        boxId: z.string().trim().min(1).optional(),
        type: z.enum(BOX_EVENT_TYPES.map((t) => t.key) as [BoxEventType, ...BoxEventType[]]).optional(),
        actor: z.enum(BOX_ACTORS.map((a) => a.key) as [BoxActorKind, ...BoxActorKind[]]).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    )
    const limit = f.limit ?? 50
    // One extra row says whether there are older ones.
    const events = tasks.history.list({ ...f, limit: limit + 1 })
    res.json({ events: events.slice(0, limit), more: events.length > limit, boxIds: tasks.history.boxIds() })
  })
  /** Start a graduated disk cleanup on a box; answers right away with the running report (SSE box.cleanup follows). */
  api.post("/boxes/:id/cleanup", async (req, res) => {
    res.status(202).json(await tasks.cleanBox(req.params.id!))
  })
  /** What Clear box / Delete box would touch: tasks by status, uncommitted files, disk in use. */
  api.get("/boxes/:id/contents", async (req, res) => {
    res.json(await tasks.boxContents(req.params.id!))
  })
  /** Archive every workspace and remove it from the box; the box stays. 409 while agents run, unless {stopAgents: true}. */
  api.post("/boxes/:id/clear", async (req, res) => {
    const body = parse(z.object({ stopAgents: z.boolean().optional() }), req.body ?? {})
    res.json(await tasks.clearBox(req.params.id!, { stopAgents: body.stopAgents }))
  })
  /**
   * Archive every workspace, then destroy the box, or terminate a RunPod GPU pod (`runpod-*`; its volume stays).
   * 409 while agents run, unless ?stopAgents=1, and when the safety check flags a task (queued, unpushed or
   * uncommitted work), unless ?override=1 (Delete anyway). GET /boxes/:id/contents has the check.
   */
  api.delete("/boxes/:id", async (req, res) => {
    const result = await tasks.destroyBox(req.params.id!, { stopAgents: req.query.stopAgents === "1", override: req.query.override === "1" })
    res.json({ ok: true, ...result })
  })

  /** What resizing to ?size= would do: in place or by migration, the running agents, and a scale-down's disk fit. */
  api.get("/boxes/:id/resize", async (req, res) => {
    const { size } = parse(z.object({ size: z.enum(BOX_SIZES) }), req.query)
    res.json(await tasks.resizePlan(req.params.id!, size))
  })
  /** Resize a box up or down; answers right away with the running report (SSE box.resize follows). 409 while agents run, unless {stopAgents: true}. */
  api.post("/boxes/:id/resize", async (req, res) => {
    const body = parse(z.object({ size: z.enum(BOX_SIZES), stopAgents: z.boolean().optional() }), req.body ?? {})
    res.status(202).json(await tasks.resizeBox(req.params.id!, body.size, { stopAgents: body.stopAgents, by: { kind: "cody" } }))
  })

  if (c.mockHeavy) api.use(heavyDevRoutes(store, hub))
  app.use("/api", api)

  app.get("/artifacts/:id/:name", auth.middleware(), (req, res) => {
    const id = String(req.params.id)
    const artifact = store.getArtifact(id)
    const file = store.artifactPath(id)
    if (!artifact || !file || !fs.existsSync(file)) return void res.status(404).send("Not found")
    res.setHeader("Content-Type", artifact.mime)
    // Hosted HTML runs sandboxed so it can't act as Box Yard.
    if (artifact.mime.startsWith("text/html")) res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
    res.sendFile(file)
  })

  // ---- the React app
  const webDir = opts.webDir ?? path.resolve(process.cwd(), "dist/web")
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }))
    app.get(/^\/(?!api\/|mcp|artifacts\/|qstash\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")))
  } else {
    app.get("/", (_req, res) =>
      res.type("text").send("Box Yard API is running. Build the web app with `npm run build`, or use `npm run dev` (http://localhost:5173)."),
    )
  }

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" })
  })

  // Errors become JSON with a helpful message; 5xx are logged. Neither ever shows a credential.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500
    const secrets = secretValues()
    const message = redact(err instanceof Error ? err.message : String(err), secrets)
    if (status >= 500) console.error("[box-yard]", redact(err instanceof Error ? (err.stack ?? message) : message, secrets))
    if (res.headersSent) return
    res.status(status).json({ error: message })
  })

  let stopSnapshots: (() => void) | null = null
  let stopHold: (() => void) | null = null
  return {
    app,
    db,
    store,
    hub,
    tasks,
    orchestrator,
    captains,
    threads,
    scheduler,
    settings,
    settingsTools,
    setup,
    ttsSettings,
    tts,
    hooks,
    notes,
    retro,
    docker: dockerService,
    identities,
    async start() {
      // A "This computer" setup's gh login can stand in for the GitHub token: look for it before PRs are followed.
      if (setup.onThisComputer()) await setup.refreshLocal()
      await tasks.start()
      scheduler.start()
      orchestrator.resumeScheduled()
      stopSnapshots = startSelfSnapshots(c, db)
      stopHold = startSelfHold(c, () => {
        if (orchestrator.busy) return true
        if (captains.anyBusy()) return true
        if (threads.anyBusy) return true
        if (store.listTaskRows({ status: ["queued", "starting", "working"] }).length) return true
        // Without QStash nothing wakes a paused box for a schedule, so stay up for ones due soon.
        if (!qstash) {
          const soon = Date.now() + 15 * 60_000
          if (store.listSchedules({}).some((x) => x.enabled && x.nextRunAt !== null && x.nextRunAt <= soon)) return true
        }
        return false
      })
    },
    stop() {
      retro.stop()
      hooks.stop()
      scheduler.stop()
      tasks.stop()
      captains.stop()
      orchestrator.stop()
      threads.stopAll()
      stopSnapshots?.()
      stopHold?.()
      hub.close()
      db.close()
    },
  }
}
