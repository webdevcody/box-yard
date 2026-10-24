import express, { type NextFunction, type Request, type Response } from "express"
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { z } from "zod"
import { configProblems, qstashEnabled, redisEnabled, type Config } from "./config.js"
import { openDb, type DB } from "./db.js"
import { Store, BadRequestError } from "./store.js"
import { Hub } from "./hub.js"
import { Artifacts } from "./artifacts.js"
import { Uploads, uploadsDir, tooLarge } from "./uploads.js"
import { TaskManager, type TaskManagerDeps } from "./tasks.js"
import { Orchestrator } from "./orchestrator.js"
import { CaptainManager } from "./captains.js"
import { SettingsStore, TtsSettingsStore, parseSettingKeys } from "./settings.js"
import { TtsError, TtsService } from "./tts.js"
import { mcpHandler } from "./mcp.js"
import { Auth } from "./auth.js"
import { Redis } from "./redis.js"
import { LocalProvider } from "./providers/local.js"
import { UpstashProvider } from "./providers/upstash.js"
import type { BoxProvider } from "./providers/types.js"
import { startSelfHold, startSelfSnapshots } from "./backup.js"
import { Scheduler } from "./scheduler.js"
import { heavyDevRoutes, seedHeavy } from "./mockHeavy.js"
import { QStash, verifyQStashSignature } from "./qstash.js"
import { describeCron, nextRuns, parseCron, isValidTimeZone } from "../shared/cron.js"
import { HookStore } from "./hookStore.js"
import { HookEngine } from "./hooks.js"
import { HOOK_ACTIONS, HOOK_SOURCES, HOOK_TEMPLATES, HOOK_TRIGGERS } from "../shared/hooks.js"
import { DEFAULT_OWNER_NAME } from "../shared/owner.js"
import { BOX_SIZES, type Health } from "../shared/types.js"
import { CLOUD_PROVIDERS, MAX_TTS_CHARS } from "../shared/tts.js"

const idSchema = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9-]{6,40}$/)
  .optional()
const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Env var names must be like MY_VAR"), z.string())

const attachmentIds = z.array(z.string()).max(20).optional()

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
  }),
  projectPatch: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    repo: z.string().max(300).nullable().optional(),
    baseBranch: z.string().max(200).optional(),
    env: envSchema.optional(),
    removeEnv: z.array(z.string()).optional(),
    boxSize: z.enum(BOX_SIZES).nullable().optional(),
    partialClone: z.boolean().nullable().optional(),
  }),
  note: z.object({ content: z.string().trim().min(1).max(4000) }),
  task: z.object({
    id: idSchema,
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(50_000),
    env: envSchema.optional(),
  }),
  message: z.object({ content: z.string().trim().max(50_000), attachments: attachmentIds }),
  chat: z.object({ id: idSchema, content: z.string().trim().max(50_000), attachments: attachmentIds }),
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

export function makeProvider(c: Config): BoxProvider {
  if (c.provider === "upstash") return new UpstashProvider(c)
  return new LocalProvider(path.join(c.dataDir, "local-boxes"), c.claudeBin)
}

export interface BoxYard {
  app: express.Express
  db: DB
  store: Store
  hub: Hub
  tasks: TaskManager
  orchestrator: Orchestrator
  captains: CaptainManager
  scheduler: Scheduler
  settings: SettingsStore
  ttsSettings: TtsSettingsStore
  tts: TtsService
  hooks: HookEngine
  start(): Promise<void>
  stop(): void
}

/** Wire up the database, task manager, orchestrator and HTTP routes. */
export function createBoxYard(
  c: Config,
  opts: {
    provider?: BoxProvider
    webDir?: string
    qstash?: QStash | null
    now?: () => number
    github?: TaskManagerDeps["github"]
    /** Stand-ins for the ElevenLabs / OpenAI HTTP APIs (tests). */
    tts?: { fetch?: typeof fetch; timeoutMs?: number; voicesTtlMs?: number }
  } = {},
): BoxYard {
  const db = openDb(c.dataDir)
  const store = new Store(db)
  if (c.mockHeavy && seedHeavy(db, store)) console.log("[box-yard] seeded the heavy mock dataset (BOXYARD_MOCK_HEAVY=1)")
  const hub = new Hub()
  const artifacts = new Artifacts(store, path.join(c.dataDir, "artifacts"))
  const redis = redisEnabled(c) ? new Redis(c.redisUrl, c.redisToken) : null
  const provider = opts.provider ?? makeProvider(c)
  const settings = new SettingsStore(store, c)
  const ttsSettings = new TtsSettingsStore(store, c)
  const tts = new TtsService({
    settings: ttsSettings,
    baseUrls: { elevenlabs: c.elevenlabsBaseUrl.replace(/\/+$/, ""), openai: c.openaiBaseUrl.replace(/\/+$/, "") },
    ...opts.tts,
  })
  const uploads = new Uploads(uploadsDir(c.dataDir), c.maxUploadMb * 1024 * 1024)
  const tasks = new TaskManager({ config: c, store, provider, hub, redis, artifacts, uploads, settings, github: opts.github })
  const qstash = opts.qstash !== undefined ? opts.qstash : qstashEnabled(c) ? new QStash(c.qstashToken, c.qstashUrl) : null
  const mcpToken = randomBytes(24).toString("hex")
  const captains = new CaptainManager(c, store, hub, { url: `http://127.0.0.1:${c.port}/mcp`, token: mcpToken }, settings)
  const orchestrator = new Orchestrator(c, store, hub, { url: `http://127.0.0.1:${c.port}/mcp`, token: mcpToken }, settings)
  const scheduler = new Scheduler({ config: c, store, tasks, hub, orchestrator, qstash, now: opts.now })
  tasks.onNotice = (content, meta, opts) => {
    const wake = opts.wake !== false
    const handled = captains.notice(content, meta, { wake })
    // With opts.coordinator the Coordinator still reads it with its next updates (TaskManager.notice leaves it unseen).
    if (wake && !handled) orchestrator.nudge()
    return handled
  }
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
  captains.onReport = (projectId, content) => {
    const project = store.getProject(projectId)
    const msg = store.addChat("notice", `Captain${project ? ` for ${project.name}` : ""}: ${content}`, { projectId, captain: true })
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

  // MCP endpoint for the Coordinator and Captains (their own token, local only in practice).
  app.all("/mcp", mcpHandler({ store, tasks, hub, artifacts, publicUrl, scheduler, uploads, settings, captains, hooks }, mcpToken))

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
    if (!auth.enabled || auth.check(password)) {
      auth.login(res, req.secure)
      res.json({ ok: true })
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
    const problems = configProblems(c)
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
    const project = store.createProject(body)
    hub.broadcast({ type: "project", project })
    res.status(201).json(project)
  })
  api.patch("/projects/:id", (req, res) => {
    const project = store.updateProject(req.params.id!, parse(schemas.projectPatch, req.body))
    hub.broadcast({ type: "project", project })
    res.json(project)
  })
  api.delete("/projects/:id", async (req, res) => {
    const id = req.params.id!
    for (const s of store.listSchedules({ projectId: id })) await scheduler.remove(s.id)
    for (const t of store.listTasks({ projectId: id })) await tasks.deleteTask(t.id)
    store.deleteProject(id)
    hub.broadcast({ type: "project.deleted", projectId: id })
    res.json({ ok: true })
  })
  api.post("/projects/:id/notes", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    store.addNote(id, settings.get().ownerName, parse(schemas.note, req.body).content)
    tasks.publishNotes(id)
    const project = store.getProject(id)!
    hub.broadcast({ type: "project", project })
    res.status(201).json(project)
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
  api.post("/tasks", (req, res) => {
    res.status(201).json(tasks.createTask(parse(schemas.task, req.body)))
  })
  api.get("/tasks/:id", (req, res) => {
    const task = store.getTask(req.params.id!)
    if (!task) return void res.status(404).json({ error: "Task not found" })
    res.json(task)
  })
  api.get("/tasks/:id/messages", (req, res) => {
    res.json(store.listTaskMessages(req.params.id!, 1000))
  })
  api.post("/tasks/:id/messages", (req, res) => {
    const body = parse(schemas.message, req.body)
    const files = withAttachments(body.content, body.attachments)
    res.json(tasks.sendInput(req.params.id!, body.content, "cody", files))
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
    res.json({ defaultTimezone: c.defaultTimezone, scheduler: scheduler.mode, maxUploadMb: c.maxUploadMb, ttsKeys: ttsSettings.info().keys })
  })

  // ---- text-to-speech (Settings › Voice): settings, the provider proxy and voice lists
  api.get("/tts/settings", (_req, res) => {
    res.json(ttsSettings.info())
  })
  api.put("/tts/settings", (req, res) => {
    const info = ttsSettings.update(req.body)
    hub.broadcast({ type: "tts", info })
    res.json(info)
  })
  const ttsFailed = (res: Response, err: unknown) => {
    if (!(err instanceof TtsError)) throw err
    res.removeHeader("Content-Type")
    res.removeHeader("X-TTS-Cache")
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
  /** Synthesize `text` with the saved provider (or the one given) and stream the mp3 back. */
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
    const info = settings.update(req.body)
    hub.broadcast({ type: "settings", info })
    applyPoolChange()
    res.json(info)
  })
  // No `keys`: forget every saved value. `?keys=slotsPerBox,maxResidentPerBox`: forget only those (unknown keys are a 400).
  api.delete("/agent-settings", (req, res) => {
    const info = settings.reset(req.query.keys === undefined ? undefined : parseSettingKeys(req.query.keys))
    hub.broadcast({ type: "settings", info })
    applyPoolChange()
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
  api.get("/boxes", (_req, res) => {
    res.json(tasks.boxes())
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
  /** Archive every workspace, then destroy the box. 409 while agents run, unless ?stopAgents=1. */
  api.delete("/boxes/:id", async (req, res) => {
    await tasks.destroyBox(req.params.id!, { stopAgents: req.query.stopAgents === "1" })
    res.json({ ok: true })
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

  // Errors become JSON with a helpful message; 5xx are logged.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : String(err)
    if (status >= 500) console.error("[box-yard]", err)
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
    scheduler,
    settings,
    ttsSettings,
    tts,
    hooks,
    async start() {
      await tasks.start()
      scheduler.start()
      orchestrator.resumeScheduled()
      stopSnapshots = startSelfSnapshots(c, db)
      stopHold = startSelfHold(c, () => {
        if (orchestrator.busy) return true
        if (captains.anyBusy()) return true
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
      hooks.stop()
      scheduler.stop()
      tasks.stop()
      captains.stop()
      orchestrator.stop()
      stopSnapshots?.()
      stopHold?.()
      hub.close()
      db.close()
    },
  }
}
