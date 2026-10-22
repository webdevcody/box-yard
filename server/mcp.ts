import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Request, Response } from "express"
import { z } from "zod"
import { capReply, preview } from "./replies.js"
import type { Store } from "./store.js"
import type { TaskManager } from "./tasks.js"
import type { Hub } from "./hub.js"
import type { Artifacts } from "./artifacts.js"
import type { Scheduler } from "./scheduler.js"
import { describeCron } from "../shared/cron.js"
import { TASK_STATUSES, type Project, type Schedule, type Task } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"

export interface McpDeps {
  store: Store
  tasks: TaskManager
  hub: Hub
  artifacts: Artifacts
  publicUrl: () => string
  scheduler: Scheduler
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }
const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
})
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true })

/** Wrap a handler so thrown errors become tool errors the model can read. */
function safe<A>(fn: (args: A) => Promise<ToolResult> | ToolResult) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args)
    } catch (err) {
      return fail(errorMessage(err))
    }
  }
}

const envSchema = z.record(z.string(), z.string()).optional().describe("Env vars as NAME: value")

/** The tools the orchestrator's Claude uses to run Box Yard. */
export function buildMcpServer(deps: McpDeps): McpServer {
  const { store, tasks, hub, artifacts, scheduler } = deps
  const server = new McpServer({ name: "boxyard", version: "0.1.0" })

  const project = (ref: string): Project => {
    const p = store.findProject(ref)
    if (!p) throw new Error(`No project "${ref}". Use list_projects.`)
    return p
  }
  const task = (ref: string): Task => {
    const t = store.getTask(ref) ?? store.listTasks().find((x) => x.title.toLowerCase() === ref.toLowerCase())
    if (!t) throw new Error(`No task "${ref}". Use list_tasks.`)
    return t
  }
  const absolute = (url: string) => (url.startsWith("/") && deps.publicUrl() ? `${deps.publicUrl().replace(/\/$/, "")}${url}` : url)
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
  }
  const brief = (t: Task) => ({
    id: t.id,
    title: t.title,
    project: store.getProject(t.projectId)?.name ?? t.projectId,
    status: t.status,
    question: t.question ?? undefined,
    pr: t.prUrl ?? undefined,
    previews: t.previews.length ? t.previews.map((p) => p.url) : undefined,
    error: t.error ?? undefined,
    queuedMessages: t.pendingCount || undefined,
    box: t.boxId ?? undefined,
    turns: t.turnCount,
    lastActive: ago(t.updatedAt),
    summary: t.summary ? preview(t.summary, 300, "call get_task or wait_for_tasks for the full reply") : undefined,
  })
  /**
   * The agent's latest reply, to be sent once and in full (capped). `summary` is only
   * added when it says something different (e.g. the text passed to mark_done).
   */
  const replyFields = (t: Task, offset = 0) => {
    const last = store.listTaskMessages(t.id, 50).filter((m) => m.role === "assistant").pop()
    const reply = t.summary && (!last || t.summary.length > last.content.length) ? t.summary : (last?.content ?? null)
    const summary = t.summary && t.summary !== reply ? capReply(t.summary) : undefined
    return { reply, fields: { ...brief(t), summary, lastReply: reply === null ? undefined : capReply(reply, offset) } }
  }
  const BUSY = new Set(["queued", "starting", "working"])
  /** What happens to a message sent to this task right now. */
  const delivery = (t: Task) => {
    if (t.status === "working" || t.status === "starting")
      return "queued: the agent is mid-turn; the message is delivered (with any others) as soon as this turn ends, in the same session"
    if (t.status === "queued") return "queued: the task is waiting for a box slot; the message goes out with its next turn"
    if (t.boxId) return `resuming: the agent's Claude session resumes now on box ${t.boxId} with full context`
    return "resuming: the workspace and Claude session are restored from the archive onto a box, then the session resumes with full context"
  }
  const projectView = (p: Project) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repo: p.repo,
    baseBranch: p.baseBranch,
    envKeys: p.envKeys,
    notes: p.notes.map((n) => `(${n.author}) ${n.content}`),
    tasks: store.listTasks({ projectId: p.id }).map((t) => `${t.id} ${t.title} [${t.status}]`),
  })

  server.registerTool(
    "list_projects",
    { description: "List all projects with their repo, env var names, notes and tasks." },
    safe(async () => ok(store.listProjects().map(projectView))),
  )

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project. repo is optional (owner/name or git URL); leave it out for non-coding work. env vars are given to every task in the project.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        repo: z.string().optional(),
        base_branch: z.string().optional(),
        env: envSchema,
      },
    },
    safe(async (a: { name: string; description?: string; repo?: string; base_branch?: string; env?: Record<string, string> }) => {
      if (store.findProject(a.name)) return fail(`A project named "${a.name}" already exists.`)
      const p = store.createProject({ name: a.name, description: a.description, repo: a.repo, baseBranch: a.base_branch, env: a.env })
      hub.broadcast({ type: "project", project: p })
      return ok(projectView(p))
    }),
  )

  server.registerTool(
    "update_project",
    {
      description: "Change a project's name, description, repo, base branch or env vars.",
      inputSchema: {
        project: z.string().describe("Project id or name"),
        name: z.string().optional(),
        description: z.string().optional(),
        repo: z.string().nullable().optional(),
        base_branch: z.string().optional(),
        env: envSchema,
        remove_env: z.array(z.string()).optional(),
      },
    },
    safe(async (a: { project: string; name?: string; description?: string; repo?: string | null; base_branch?: string; env?: Record<string, string>; remove_env?: string[] }) => {
      const p = store.updateProject(project(a.project).id, {
        name: a.name,
        description: a.description,
        repo: a.repo,
        baseBranch: a.base_branch,
        env: a.env,
        removeEnv: a.remove_env,
      })
      hub.broadcast({ type: "project", project: p })
      return ok(projectView(p))
    }),
  )

  server.registerTool(
    "delete_project",
    {
      description: "Delete a project and all its tasks. Only do this when Cody explicitly asks.",
      inputSchema: { project: z.string() },
    },
    safe(async (a: { project: string }) => {
      const p = project(a.project)
      for (const s of store.listSchedules({ projectId: p.id })) await scheduler.remove(s.id)
      for (const t of store.listTasks({ projectId: p.id })) await tasks.deleteTask(t.id)
      store.deleteProject(p.id)
      hub.broadcast({ type: "project.deleted", projectId: p.id })
      return ok(`Deleted project ${p.name}.`)
    }),
  )

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks (each is one agent with its own Claude session), optionally for one project, with given statuses, or matching words in the title, prompt or summary. Use it to find the agent that already did related work before creating a new task.",
      inputSchema: {
        project: z.string().optional(),
        status: z.array(z.enum(TASK_STATUSES)).optional(),
        query: z.string().optional().describe("Words to look for in title, prompt and summary (any word matches; best matches first)"),
      },
    },
    safe(async (a: { project?: string; status?: (typeof TASK_STATUSES)[number][]; query?: string }) => {
      let list = store.listTasks({ projectId: a.project ? project(a.project).id : undefined, status: a.status })
      if (a.query?.trim()) {
        const words = a.query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
        const score = (t: Task) => {
          const hay = `${t.title} ${t.prompt} ${t.summary ?? ""} ${t.prUrl ?? ""}`.toLowerCase()
          return words.filter((w) => hay.includes(w)).length
        }
        list = list.filter((t) => score(t) > 0).sort((x, y) => score(y) - score(x))
      }
      return ok(list.map(brief))
    }),
  )

  server.registerTool(
    "get_task",
    {
      description:
        "Get one task with its latest transcript lines. `lastReply` is the agent's latest reply in full (up to 20k chars); older transcript lines are short previews. If a reply ends with a [truncated: N more chars …] marker, call again with full_reply=true and the offset from the marker — never ask the agent to repeat itself.",
      inputSchema: {
        task: z.string(),
        last_messages: z.number().int().min(0).max(200).optional(),
        full_reply: z.boolean().optional().describe("Return only the agent's latest reply, starting at `offset`, up to 20k chars"),
        offset: z.number().int().min(0).optional().describe("Char offset into the latest reply (with full_reply)"),
      },
    },
    safe(async (a: { task: string; last_messages?: number; full_reply?: boolean; offset?: number }) => {
      const t = task(a.task)
      const { reply, fields } = replyFields(t, a.offset ?? 0)
      if (a.full_reply) return ok({ ...fields, summary: undefined, totalChars: reply?.length ?? 0, offset: a.offset ?? 0 })
      const all = store.listTaskMessages(t.id, Math.max(a.last_messages ?? 20, 50))
      const lastAssistant = [...all].reverse().find((m) => m.role === "assistant")
      const messages = all.slice(-(a.last_messages ?? 20)).map((m) => {
        // The latest reply is returned once, in full, as lastReply.
        if (m === lastAssistant && reply === m.content) return "[assistant] (latest reply: see lastReply)"
        return `[${m.role}] ${preview(m.content, 600, "call get_task with full_reply for the latest reply")}`
      })
      return ok({ ...fields, prompt: t.prompt, branch: t.branch, messages })
    }),
  )

  server.registerTool(
    "create_task",
    {
      description:
        "Start a NEW agent (a fresh Claude Code session) on a task in a project. It gets its own folder on the project's worker box (repo cloned if the project has one). " +
        "Use this for new, independent work. For follow-ups on work an agent already did, use send_to_task instead so it keeps its context. Write a self-contained prompt.",
      inputSchema: {
        project: z.string().describe("Project id or name"),
        title: z.string().min(1).max(120),
        prompt: z.string().min(1),
        env: envSchema,
        related_tasks: z
          .array(z.string())
          .optional()
          .describe("Earlier tasks whose outcome this new agent should know about (their summary, branch and PR are added to its prompt)"),
      },
    },
    safe(async (a: { project: string; title: string; prompt: string; env?: Record<string, string>; related_tasks?: string[] }) => {
      let prompt = a.prompt
      if (a.related_tasks?.length) {
        const context = a.related_tasks.map((ref) => {
          const r = task(ref)
          return [`- ${r.title} (${r.id}, ${r.status})`, r.summary ? `  Outcome: ${preview(r.summary, 1200, "call get_task for the full reply")}` : "", r.branch ? `  Branch: ${r.branch}` : "", r.prUrl ? `  PR: ${r.prUrl}` : ""]
            .filter(Boolean)
            .join("\n")
        })
        prompt = `${prompt}\n\n## Related earlier work\n${context.join("\n")}`
      }
      const t = tasks.createTask({ projectId: project(a.project).id, title: a.title, prompt, env: a.env })
      return ok({ ...brief(t), next: "The agent starts as soon as a box slot is free. Use wait_for_tasks to wait for its result if the work is quick." })
    }),
  )

  server.registerTool(
    "send_to_task",
    {
      description:
        "Send a message to an existing task's agent: an answer, feedback, a correction, or follow-up work on the same topic. It continues the SAME Claude session, so the agent remembers everything it did. " +
        "If the agent is idle or done, its session resumes right away (restored from the archive if needed). If it is mid-turn, the message is queued and delivered as soon as the current turn ends.",
      inputSchema: { task: z.string(), message: z.string().min(1) },
    },
    safe(async (a: { task: string; message: string }) => {
      const before = task(a.task)
      const how = delivery(before)
      const t = tasks.sendInput(before.id, a.message, "orchestrator")
      return ok({ ...brief(t), delivery: how })
    }),
  )

  server.registerTool(
    "wait_for_tasks",
    {
      description:
        "Wait until the given tasks finish their current work (no longer queued/starting/working), up to timeout_seconds. Returns each task's status and the agent's latest reply in full as lastReply (up to 20k chars; a [truncated: …] marker says how to read the rest with get_task full_reply/offset). Never ask an agent to repeat a reply. " +
        "Use this instead of polling get_task. If it times out, the tasks keep running: end your turn, and you'll be woken with an update when they finish.",
      inputSchema: {
        tasks: z.array(z.string()).min(1),
        timeout_seconds: z.number().int().min(5).max(240).optional().describe("Default 120"),
      },
    },
    safe(async (a: { tasks: string[]; timeout_seconds?: number }) => {
      const ids = a.tasks.map((ref) => task(ref).id)
      const deadline = Date.now() + (a.timeout_seconds ?? 120) * 1000
      // A task just created or messaged may not have left "idle" yet; give the scheduler a moment.
      await new Promise((r) => setTimeout(r, 1500))
      const current = () => ids.map((id) => store.getTask(id)).filter((t): t is Task => Boolean(t))
      while (Date.now() < deadline && current().some((t) => BUSY.has(t.status) || t.pendingCount > 0)) {
        await new Promise((r) => setTimeout(r, 1000))
      }
      const list = current()
      const settled = list.filter((t) => !BUSY.has(t.status) && t.pendingCount === 0)
      store.markNoticesSeen(settled.map((t) => t.id))
      return ok({
        allFinished: settled.length === list.length,
        tasks: list.map((t) => ({ ...replyFields(t).fields, stillRunning: !settled.includes(t) })),
      })
    }),
  )

  server.registerTool(
    "stop_task",
    { description: "Stop the agent's current turn. The task keeps its workspace.", inputSchema: { task: z.string() } },
    safe(async (a: { task: string }) => ok(brief(await tasks.stopTask(task(a.task).id)))),
  )

  server.registerTool(
    "close_task",
    {
      description: "Mark a task done and free its box space (its workspace is archived).",
      inputSchema: { task: z.string() },
    },
    safe(async (a: { task: string }) => ok(brief(await tasks.closeTask(task(a.task).id)))),
  )

  server.registerTool(
    "retry_task",
    { description: "Retry a failed task.", inputSchema: { task: z.string() } },
    safe(async (a: { task: string }) => ok(brief(tasks.retryTask(task(a.task).id)))),
  )

  server.registerTool(
    "get_preview_url",
    {
      description: "Get a public URL for a port in a task's box (a dev server the agent started).",
      inputSchema: { task: z.string(), port: z.number().int().min(1).max(65535) },
    },
    safe(async (a: { task: string; port: number }) => ok(await tasks.previewUrl(task(a.task).id, a.port))),
  )

  server.registerTool(
    "list_inbox",
    { description: "Tasks waiting on Cody (questions) or ready for review (PRs), and failures." },
    safe(async () =>
      ok(store.listTasks({ status: ["needs_input", "pr_ready", "failed"] }).map(brief)),
    ),
  )

  server.registerTool(
    "save_note",
    {
      description: "Save a lasting fact to a project's shared notes. Every agent in the project sees them.",
      inputSchema: { project: z.string(), content: z.string().min(1) },
    },
    safe(async (a: { project: string; content: string }) => {
      const p = project(a.project)
      store.addNote(p.id, "orchestrator", a.content)
      tasks.publishNotes(p.id)
      hub.broadcast({ type: "project", project: store.getProject(p.id)! })
      return ok("Saved.")
    }),
  )

  server.registerTool(
    "create_artifact",
    {
      description:
        "Host a file for Cody (markdown, HTML page, CSV, JSON, SVG...). Returns its URL. Use base64 encoding for binary content.",
      inputSchema: {
        title: z.string().min(1),
        filename: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        project: z.string().optional(),
        task: z.string().optional(),
      },
    },
    safe(async (a: { title: string; filename: string; content: string; encoding?: "utf8" | "base64"; project?: string; task?: string }) => {
      const t = a.task ? task(a.task) : null
      const artifact = artifacts.save({
        title: a.title,
        filename: a.filename,
        data: Buffer.from(a.content, a.encoding === "base64" ? "base64" : "utf8"),
        projectId: a.project ? project(a.project).id : (t?.projectId ?? null),
        taskId: t?.id ?? null,
      })
      hub.broadcast({ type: "artifact", artifact })
      return ok({ ...artifact, url: absolute(artifact.url) })
    }),
  )

  server.registerTool(
    "list_artifacts",
    {
      description: "List hosted artifacts, optionally for a project or task.",
      inputSchema: { project: z.string().optional(), task: z.string().optional() },
    },
    safe(async (a: { project?: string; task?: string }) =>
      ok(
        store
          .listArtifacts({ projectId: a.project ? project(a.project).id : undefined, taskId: a.task ? task(a.task).id : undefined })
          .map((x) => ({ id: x.id, title: x.title, url: absolute(x.url), size: x.size, task: x.taskId })),
      ),
    ),
  )

  const when = (ts: number | null, tz: string) =>
    ts === null ? null : new Date(ts).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })
  const scheduleView = (s: Schedule) => ({
    id: s.id,
    name: s.name,
    project: store.getProject(s.projectId)?.name ?? s.projectId,
    cron: s.cron,
    meaning: describeCron(s.cron),
    timezone: s.timezone,
    enabled: s.enabled,
    nextRun: when(s.nextRunAt, s.timezone),
    lastRun: when(s.lastRunAt, s.timezone),
    lastTask: s.lastTaskId ?? undefined,
    lastSkipped: s.lastSkipReason ?? undefined,
    runs: s.runCount,
    catchUp: s.catchUp,
    allowOverlap: s.allowOverlap,
    prompt: s.prompt,
  })

  server.registerTool(
    "list_schedules",
    { description: "List schedules (recurring jobs), optionally for one project.", inputSchema: { project: z.string().optional() } },
    safe(async (a: { project?: string }) => ok(scheduler.list(a.project ? project(a.project).id : undefined).map(scheduleView))),
  )

  server.registerTool(
    "create_schedule",
    {
      description:
        "Create a recurring job. Every time the cron fires, a new task starts in the project with this prompt (plus a note on the previous run), and Cody can watch it live like any task. " +
        "cron is 5 fields (minute hour day-of-month month day-of-week) or @hourly/@daily/@weekly/@monthly. Write the prompt so it works on its own every run.",
      inputSchema: {
        project: z.string().describe("Project id or name"),
        name: z.string().min(1).max(120),
        cron: z.string().describe('e.g. "0 9 * * 1-5" for weekdays at 9:00'),
        prompt: z.string().min(1),
        timezone: z.string().optional().describe("IANA zone like America/New_York. Defaults to the server's zone."),
        catch_up: z.enum(["once", "skip"]).optional().describe("If runs were missed while Box Yard was down: run once to catch up (default) or skip."),
        allow_overlap: z.boolean().optional().describe("Start a run even if the previous one is still going. Default false."),
        enabled: z.boolean().optional(),
      },
    },
    safe(
      async (a: { project: string; name: string; cron: string; prompt: string; timezone?: string; catch_up?: "once" | "skip"; allow_overlap?: boolean; enabled?: boolean }) =>
        ok(
          scheduleView(
            await scheduler.create({
              projectId: project(a.project).id,
              name: a.name,
              cron: a.cron,
              prompt: a.prompt,
              timezone: a.timezone,
              catchUp: a.catch_up,
              allowOverlap: a.allow_overlap,
              enabled: a.enabled,
            }),
          ),
        ),
    ),
  )

  server.registerTool(
    "update_schedule",
    {
      description: "Change a schedule: rename, new cron/time zone/prompt, or pause (enabled: false) and resume it.",
      inputSchema: {
        schedule: z.string().describe("Schedule id or name"),
        name: z.string().optional(),
        cron: z.string().optional(),
        prompt: z.string().optional(),
        timezone: z.string().optional(),
        catch_up: z.enum(["once", "skip"]).optional(),
        allow_overlap: z.boolean().optional(),
        enabled: z.boolean().optional(),
      },
    },
    safe(
      async (a: { schedule: string; name?: string; cron?: string; prompt?: string; timezone?: string; catch_up?: "once" | "skip"; allow_overlap?: boolean; enabled?: boolean }) =>
        ok(
          scheduleView(
            await scheduler.update(a.schedule, {
              name: a.name,
              cron: a.cron,
              prompt: a.prompt,
              timezone: a.timezone,
              catchUp: a.catch_up,
              allowOverlap: a.allow_overlap,
              enabled: a.enabled,
            }),
          ),
        ),
    ),
  )

  server.registerTool(
    "delete_schedule",
    { description: "Delete a schedule. Tasks from past runs stay.", inputSchema: { schedule: z.string().describe("Schedule id or name") } },
    safe(async (a: { schedule: string }) => {
      const s = scheduler.require(a.schedule)
      await scheduler.remove(s.id)
      return ok(`Deleted schedule ${s.name}.`)
    }),
  )

  server.registerTool(
    "run_schedule_now",
    { description: "Start a run of a schedule right now (doesn't change its next planned run).", inputSchema: { schedule: z.string() } },
    safe(async (a: { schedule: string }) => ok(brief(scheduler.runNow(a.schedule)))),
  )

  server.registerTool(
    "list_schedule_runs",
    { description: "Past runs (tasks) of a schedule, newest first.", inputSchema: { schedule: z.string(), limit: z.number().int().min(1).max(100).optional() } },
    safe(async (a: { schedule: string; limit?: number }) => ok(scheduler.runs(a.schedule, a.limit ?? 10).map(brief))),
  )

  server.registerTool(
    "pool_status",
    { description: "Show worker boxes (which projects live on each, busy slots) and queued tasks. Box Yard places tasks itself: a project's tasks share its box, a new project gets its own box while the pool has room." },
    safe(async () =>
      ok({
        boxes: tasks.boxes().map((b) => ({ id: b.id, status: b.status, projects: b.projects, running: `${b.runningTurns}/${b.slots}`, tasks: b.residentTasks.length })),
        pool: tasks.poolLimits(),
        queued: store.listTasks({ status: ["queued"] }).map((t) => `${t.id} ${t.title}`),
      }),
    ),
  )

  return server
}

/** Stateless Streamable HTTP endpoint: a fresh server per request. */
export function mcpHandler(deps: McpDeps, token: string) {
  return async (req: Request, res: Response) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null })
      return
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").end()
      return
    }
    const server = buildMcpServer(deps)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: errorMessage(err) }, id: null })
      }
    }
  }
}
