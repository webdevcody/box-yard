import express, { type NextFunction, type Request, type Response } from "express"
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { z } from "zod"
import { configProblems, redisEnabled, type Config } from "./config.js"
import { openDb, type DB } from "./db.js"
import { Store, BadRequestError } from "./store.js"
import { Hub } from "./hub.js"
import { Artifacts } from "./artifacts.js"
import { TaskManager } from "./tasks.js"
import { Orchestrator } from "./orchestrator.js"
import { mcpHandler } from "./mcp.js"
import { Auth } from "./auth.js"
import { Redis } from "./redis.js"
import { LocalProvider } from "./providers/local.js"
import { UpstashProvider } from "./providers/upstash.js"
import type { BoxProvider } from "./providers/types.js"
import { startSelfSnapshots } from "./backup.js"
import type { Health } from "../shared/types.js"

const idSchema = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9-]{6,40}$/)
  .optional()
const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Env var names must be like MY_VAR"), z.string())

const schemas = {
  project: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    repo: z.string().max(300).nullable().optional(),
    baseBranch: z.string().max(200).optional(),
    env: envSchema.optional(),
  }),
  projectPatch: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    repo: z.string().max(300).nullable().optional(),
    baseBranch: z.string().max(200).optional(),
    env: envSchema.optional(),
    removeEnv: z.array(z.string()).optional(),
  }),
  note: z.object({ content: z.string().trim().min(1).max(4000) }),
  task: z.object({
    id: idSchema,
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(50_000),
    env: envSchema.optional(),
  }),
  message: z.object({ content: z.string().trim().min(1).max(50_000) }),
  chat: z.object({ id: idSchema, content: z.string().trim().min(1).max(50_000) }),
  login: z.object({ password: z.string() }),
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
  start(): Promise<void>
  stop(): void
}

/** Wire up the database, task manager, orchestrator and HTTP routes. */
export function createBoxYard(c: Config, opts: { provider?: BoxProvider; webDir?: string } = {}): BoxYard {
  const db = openDb(c.dataDir)
  const store = new Store(db)
  const hub = new Hub()
  const artifacts = new Artifacts(store, path.join(c.dataDir, "artifacts"))
  const redis = redisEnabled(c) ? new Redis(c.redisUrl, c.redisToken) : null
  const provider = opts.provider ?? makeProvider(c)
  const tasks = new TaskManager({ config: c, store, provider, hub, redis, artifacts })
  const mcpToken = randomBytes(24).toString("hex")
  const orchestrator = new Orchestrator(c, store, hub, { url: `http://127.0.0.1:${c.port}/mcp`, token: mcpToken })
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
  app.use(express.json({ limit: "10mb" }))

  // MCP endpoint for the orchestrator's Claude (its own token, local only in practice).
  app.all("/mcp", mcpHandler({ store, tasks, hub, artifacts, publicUrl }, mcpToken))

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
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
    if (!claudeVersion) problems.push(`The claude CLI (${c.claudeBin}) was not found on the orchestrator. Install it: npm i -g @anthropic-ai/claude-code`)
    if (tasks.boxError) problems.push(tasks.boxError)
    const body: Health = {
      ok: problems.length === 0,
      provider: provider.name,
      bus: tasks.busMode,
      claude: { available: Boolean(claudeVersion), version: claudeVersion ?? null },
      problems,
      pool: { maxBoxes: c.maxBoxes, slotsPerBox: c.slotsPerBox },
      orchestratorBusy: orchestrator.busy,
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
    for (const t of store.listTasks({ projectId: id })) await tasks.deleteTask(t.id)
    store.deleteProject(id)
    hub.broadcast({ type: "project.deleted", projectId: id })
    res.json({ ok: true })
  })
  api.post("/projects/:id/notes", (req, res) => {
    const id = req.params.id!
    if (!store.getProject(id)) throw new BadRequestError("No such project")
    store.addNote(id, "Cody", parse(schemas.note, req.body).content)
    tasks.publishNotes(id)
    const project = store.getProject(id)!
    hub.broadcast({ type: "project", project })
    res.status(201).json(project)
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
    res.json(tasks.sendInput(req.params.id!, parse(schemas.message, req.body).content, "cody"))
  })
  api.post("/tasks/:id/stop", async (req, res) => {
    res.json(await tasks.stopTask(req.params.id!))
  })
  api.post("/tasks/:id/close", async (req, res) => {
    res.json(await tasks.closeTask(req.params.id!))
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

  // ---- orchestrator chat
  api.get("/chat", (_req, res) => {
    res.json(store.listChat(500))
  })
  api.post("/chat", (req, res) => {
    const body = parse(schemas.chat, req.body)
    res.status(201).json(orchestrator.send(body.content, body.id))
  })
  api.post("/chat/stop", (_req, res) => {
    orchestrator.cancel()
    res.json({ ok: true })
  })
  api.post("/chat/reset", (_req, res) => {
    orchestrator.reset()
    res.json({ ok: true })
  })

  // ---- artifacts and boxes
  api.get("/artifacts", (req, res) => {
    const q = req.query as Record<string, string | undefined>
    res.json(store.listArtifacts({ projectId: q.projectId, taskId: q.taskId }))
  })
  api.get("/boxes", (_req, res) => {
    res.json(tasks.boxes())
  })
  api.delete("/boxes/:id", async (req, res) => {
    await tasks.destroyBox(req.params.id!)
    res.json({ ok: true })
  })

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
    app.get(/^\/(?!api\/|mcp|artifacts\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")))
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
  return {
    app,
    db,
    store,
    hub,
    tasks,
    orchestrator,
    async start() {
      await tasks.start()
      stopSnapshots = startSelfSnapshots(c, db)
    },
    stop() {
      tasks.stop()
      orchestrator.cancel()
      stopSnapshots?.()
      hub.close()
      db.close()
    },
  }
}
