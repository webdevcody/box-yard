import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Request, Response } from "express"
import { z } from "zod"
import { capReply, preview } from "./replies.js"
import type { Store } from "./store.js"
import type { TaskManager } from "./tasks.js"
import type { Hub } from "./hub.js"
import type { Artifacts } from "./artifacts.js"
import type { Uploads } from "./uploads.js"
import type { Scheduler } from "./scheduler.js"
import type { CaptainManager } from "./captains.js"
import type { HookEngine } from "./hooks.js"
import { ACTION_INFO, HOOK_ACTIONS, HOOK_SOURCES, HOOK_TEMPLATES, HOOK_TRIGGERS, HOOK_VARIABLES, TRIGGER_INFO, type Hook, type HookRun } from "../shared/hooks.js"
import { describeCron } from "../shared/cron.js"
import { isQuietRun, withoutQuiet } from "../shared/quiet.js"
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings.js"
import { ProjectNotes, SUGGESTION_ACTIONS, MAX_NOTE_CHARS, type SuggestionAction } from "./notes.js"
import { MAX_REASON_CHARS, NOTE_BUDGET_LIMITS } from "../shared/notes.js"
import { BOX_SIZES, EFFORTS, TASK_STATUSES, type BoxSize, type Effort, type NoteSuggestion, type Project, type ProjectNote, type Schedule, type ScheduleRun, type Task } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { cleanupSummary, diskLine, rootDiskLine, rootLow } from "../shared/disk.js"
import { compareSizes, resizeSummary, resizeTitle, sizeSpecLine } from "../shared/boxSizes.js"

export interface McpDeps {
  store: Store
  tasks: TaskManager
  hub: Hub
  artifacts: Artifacts
  publicUrl: () => string
  scheduler: Scheduler
  uploads: Uploads
  /** Optional so tests can build the server without it; then effort is fixed. */
  settings?: SettingsStore
  captains?: CaptainManager
  /** Optional so older tests can build the server without it; then the hook tools aren't offered. */
  hooks?: HookEngine
  /** Every note change goes through it. Built from the other deps when a test leaves it out. */
  notes?: ProjectNotes
}

/** Who is calling the MCP server. Captains only see and touch their own project. */
export type McpCaller = { kind: "coordinator" } | { kind: "captain"; projectId: string }

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

const attachmentsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Files Cody attached in this chat, as the ids (up_…) or paths shown in their message. They are copied into the agent's task folder under attachments/ and named in its prompt, so the agent can open screenshots and other files.",
  )

const effortSchema = z
  .enum(EFFORTS)
  .optional()
  .describe(
    "How hard the agent should think (reasoning effort). Pick the lowest level that fits: " +
      "low = one-command chores and lookups (open or close an issue, run one command, read a file, report a status); " +
      "medium = small, well-specified edits or config changes; " +
      "high = real coding work (features, bug fixes, refactors, tests, reviews, research that needs care); " +
      "xhigh/max = large, hard or risky multi-file work, deep debugging or architecture decisions. Default if omitted: high.",
  )

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:\[\]/-]+$/, "Model names have no spaces")
  .optional()
  .describe("Claude model for this task or subsequent turn, chosen from the routing rules. Omit to use project/global defaults.")
const routingRuleSchema = z.string().trim().min(1).max(120).optional().describe("Routing rule name/id that selected this model and effort.")
const routingReasonSchema = z.string().trim().min(1).max(500).optional().describe("Short reason this request matches the rule.")
const routeParams = { model: modelSchema, effort: effortSchema, routing_rule: routingRuleSchema, routing_reason: routingReasonSchema }
const envSchema = z.record(z.string(), z.string()).optional().describe("Env vars as NAME: value")

/**
 * The tools the Coordinator and project Captains use to run Box Yard.
 * A Captain caller is scoped on the server: Coordinator-only tools are not registered, and every
 * project, task, schedule, note, preview and artifact reference must belong to its own project.
 */
/** Rewrite tool and parameter descriptions with the configured owner name as tools are registered. */
function nameOwnerInTools(server: McpServer, ownerName: string | undefined) {
  if (!ownerName?.trim() || ownerName.trim() === DEFAULT_OWNER_NAME) return
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => RegisteredTool
  const named = (text: unknown) => (typeof text === "string" ? withOwner(text, ownerName) : text)
  server.registerTool = ((name: string, config: { description?: string; inputSchema?: Record<string, z.ZodType> }, cb: unknown) => {
    const inputSchema = config.inputSchema
      ? Object.fromEntries(Object.entries(config.inputSchema).map(([k, v]) => [k, v.description ? v.describe(named(v.description) as string) : v]))
      : undefined
    return register(name, { ...config, description: named(config.description), ...(inputSchema ? { inputSchema } : {}) }, cb)
  }) as typeof server.registerTool
}

export function buildMcpServer(deps: McpDeps, caller: McpCaller = { kind: "coordinator" }): McpServer {
  const { store, tasks, hub, artifacts, scheduler, uploads } = deps
  const server = new McpServer({ name: "boxyard", version: "0.1.0" })
  const ownerName = deps.settings?.get().ownerName
  const owner = (text: string) => withOwner(text, ownerName)
  nameOwnerInTools(server, ownerName)
  const scopeId = caller.kind === "captain" ? caller.projectId : null
  const ownProject = (): Project => {
    const p = scopeId ? store.getProject(scopeId) : null
    if (!p) throw new Error(`This Captain's project ${scopeId} no longer exists.`)
    return p
  }
  const outOfScope = (what: string) =>
    new Error(
      `Out of scope: ${what}. You are the Captain for project "${ownProject().name}" and can only work inside that project. ` +
        owner(`If Cody wants work in another project, say so in your reply and the Coordinator will route it.`),
    )
  const project = (ref: string): Project => {
    const p = store.findProject(ref)
    if (!p) throw new Error(scopeId ? `No project "${ref}".` : `No project "${ref}". Use list_projects.`)
    if (scopeId && p.id !== scopeId) throw outOfScope(`project "${p.name}" belongs to another Captain`)
    return p
  }
  /** An optional project filter: a Captain defaults to (and is limited to) its own project. */
  const projectFilter = (ref?: string): string | undefined => (ref ? project(ref).id : (scopeId ?? undefined))
  const task = (ref: string): Task => {
    const byId = store.getTask(ref)
    if (byId && scopeId && byId.projectId !== scopeId) {
      throw outOfScope(`task ${byId.id} ("${byId.title}") is in project "${store.getProject(byId.projectId)?.name ?? byId.projectId}"`)
    }
    const t = byId ?? store.listTasks(scopeId ? { projectId: scopeId } : {}).find((x) => x.title.toLowerCase() === ref.toLowerCase())
    if (!t) throw new Error(`No task "${ref}"${scopeId ? " in this project" : ""}. Use list_tasks.`)
    return t
  }
  const schedule = (ref: string): Schedule => {
    const s = scheduler.require(ref)
    if (scopeId && s.projectId !== scopeId) {
      throw outOfScope(s.projectId ? `schedule "${s.name}" belongs to another project` : `schedule "${s.name}" is a Coordinator schedule`)
    }
    return s
  }
  /** Captains never see the Coordinator-only tools, so they can't call them either. */
  const coordinatorOnly = (tool: RegisteredTool) => {
    if (scopeId) tool.remove()
  }
  /** How worker messages from this caller are labelled (#51). */
  const inputSource = scopeId ? (`captain:${scopeId}` as const) : ("orchestrator" as const)
  const absolute = (url: string) => (url.startsWith("/") && deps.publicUrl() ? `${deps.publicUrl().replace(/\/$/, "")}${url}` : url)
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
  }
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)
  /** What Cody's Settings let MCP callers do with resize_box. */
  const resizeGuard = () => {
    const st = deps.settings?.get()
    return { allowed: st?.autoResizeEnabled ?? true, max_size: (st?.autoResizeMaxSize ?? "large") as BoxSize, how: tasks.resizeMode() }
  }
  const brief = (t: Task) => ({
    id: t.id,
    title: t.title,
    project: store.getProject(t.projectId)?.name ?? t.projectId,
    status: t.status,
    quiet: isQuietRun(t) || undefined,
    question: t.question ?? undefined,
    pr: t.prUrl ?? undefined,
    prState: t.prUrl ? (t.prState ?? undefined) : undefined,
    mergeRequested: t.mergeRequest
      ? t.mergeRequest.requestedBy
        ? `The ${t.mergeRequest.requestedBy} asked for a merge of #${t.mergeRequest.prNumber} (${t.mergeRequest.deliveredAt ? "the agent is on it" : "queued behind its current turn"}); don't start another merge of this PR`
        : owner(`Cody pressed Merge PR for #${t.mergeRequest.prNumber} (${t.mergeRequest.deliveredAt ? "the agent is on it" : "queued behind its current turn"}); don't start another merge of this PR`)
      : undefined,
    previews: t.previews.length ? t.previews.map((p) => p.url) : undefined,
    error: t.error ?? undefined,
    queuedMessages: t.pendingCount || undefined,
    box: t.boxId ?? undefined,
    turns: t.turnCount,
    model: t.model ?? undefined,
    effort: t.effort ?? undefined,
    routing: t.routingRule || t.routingReason ? { rule: t.routingRule ?? undefined, reason: t.routingReason ?? undefined } : undefined,
    lastActive: ago(t.updatedAt),
    summary: t.summary ? preview(t.summary, 300, "call get_task or wait_for_tasks for the full reply") : undefined,
  })
  const compactionView = (c: ReturnType<Store["listOrchestratorCompactions"]>[number], full = false) => ({
    id: c.id,
    at: new Date(c.at).toISOString(),
    trigger: c.trigger,
    tokensBefore: c.tokensBefore,
    tokensAfter: c.tokensAfter,
    markdownFile: c.file,
    jsonFile: c.jsonFile,
    tasks: c.tasks.map((t) => ({
      id: t.taskId,
      title: t.title,
      status: t.status,
      project: t.projectName,
      branch: t.branch ?? undefined,
      pr: t.prUrl ?? undefined,
      sessionId: t.sessionId,
      summary: full ? t.summary : preview(t.summary, 500, "call read_compaction for full linked-task context"),
    })),
    ...(full ? { markdown: c.markdown ?? "" } : {}),
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
    const mode = tasks.resumeMode(t.id)
    if (mode === "box") return `resuming: the agent's Claude session resumes now on box ${t.boxId} with full context`
    if (mode === "archive") return "resuming: the workspace and Claude session are restored from the archive onto a box, then the session resumes with full context"
    if (mode === "recap")
      return `resuming from a recap: this task's workspace archive has expired, so its old Claude session and uncommitted work are gone. A new session starts on a fresh checkout of ${t.branch ? `branch ${t.branch} (or the base branch if it was deleted)` : "the project"} with a recap of the task's summary, PR and recent messages. ${owner("Tell Cody if that matters")}`
    return "starting: the agent's first turn starts as soon as a box slot is free"
  }
  const notes =
    deps.notes ??
    new ProjectNotes({
      store,
      hub,
      settings: deps.settings ?? { get: () => DEFAULT_SETTINGS },
      publish: (id) => tasks.publishNotes(id),
      tellCaptain: deps.captains ? (id, content, meta) => deps.captains!.projectNotice(id, content, meta) : undefined,
    })
  /** Who is editing notes through this server, as stored on the note. */
  const editor = { by: scopeId ? "captain" : "orchestrator", captain: Boolean(scopeId) }
  /** The project a note tool works on: a Captain's own by default; the Coordinator names one. */
  const notesProject = (ref?: string): Project => {
    if (ref) return project(ref)
    if (scopeId) return ownProject()
    throw new Error("Pass project: which project's notes. Use list_projects.")
  }
  const note = (ref: string): ProjectNote => {
    const n = notes.require(ref.trim())
    if (scopeId && n.projectId !== scopeId) throw outOfScope(`note ${n.id} belongs to another project`)
    return n
  }
  const suggestion = (ref: string): NoteSuggestion => {
    const s = notes.requireSuggestion(ref.trim())
    if (scopeId && s.projectId !== scopeId) throw outOfScope(`suggestion ${s.id} belongs to another project`)
    return s
  }
  /** The notes budget, as every note tool reports it. */
  const budgetView = (projectId: string) => {
    const b = notes.budgetStatus(projectId)
    return { budget: b.line, ...(b.over ? { overBudget: true, prune: b.prune } : {}) }
  }
  const suggestionView = (s: NoteSuggestion) => ({
    id: s.id,
    content: s.content,
    why: s.why || undefined,
    task: s.taskId ? `${s.taskId} ${s.taskTitle}` : s.taskTitle,
    status: s.status,
    note: s.noteId ?? undefined,
    resolvedBy: s.resolvedBy ?? undefined,
    reason: s.reason ?? undefined,
    suggested: ago(s.createdAt),
  })
  const projectView = (p: Project) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repo: p.repo,
    baseBranch: p.baseBranch,
    envKeys: p.envKeys,
    ...(p.boxSize ? { preferredBoxSize: p.boxSize } : {}),
    notes: p.notes.map((n) => `${n.id} (${n.author}) ${n.content}`),
    ...(p.notesMaxCount !== null || p.notesMaxTokens !== null ? { notesBudget: notes.budgetStatus(p.id).line } : {}),
    tasks: store.listTasks({ projectId: p.id }).map((t) => `${t.id} ${t.title} [${t.status}]`),
  })

  coordinatorOnly(
    server.registerTool(
      "send_to_captain",
      {
        description:
          "Coordinator tool: send project-scoped work to that project's Captain and return immediately. The Captain has its own persistent Claude session and owns create_task/send_to_task/model routing for the project.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          message: z.string().min(1).describe("The project-scoped request for the Captain."),
        },
      },
      safe(async (a: { project: string; message: string }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        const msg = deps.captains.send(a.project, a.message, { source: "coordinator", tool: "send_to_captain" })
        return ok({ delivered: true, projectId: msg.projectId, messageId: msg.id, state: deps.captains.state(msg.projectId) })
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "ask_captain",
      {
        description:
          "Coordinator tool: send a project-scoped request to a Captain and wait briefly for its reply. Use this for quick project work or project-specific planning.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          message: z.string().min(1),
          timeout_seconds: z.number().int().min(5).max(240).optional().describe("Default 120"),
        },
      },
      safe(async (a: { project: string; message: string; timeout_seconds?: number }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        return ok(await deps.captains.ask(a.project, a.message, a.timeout_seconds ?? 120))
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "wait_for_captain",
      {
        description:
          "Coordinator tool: wait for a Captain's current turn to finish and return its latest reply. If it times out, the Captain keeps working and will report when project events wake it.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          timeout_seconds: z.number().int().min(5).max(240).optional().describe("Default 120"),
        },
      },
      safe(async (a: { project: string; timeout_seconds?: number }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        return ok(await deps.captains.wait(a.project, a.timeout_seconds ?? 120))
      }),
    ),
  )

  server.registerTool(
    "list_projects",
    { description: "List all projects with their repo, env var names, notes and tasks." },
    safe(async () => ok(scopeId ? [projectView(ownProject())] : store.listProjects().map(projectView))),
  )

  coordinatorOnly(
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
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "update_project",
      {
        description: "Change a project's name, description, repo, base branch, env vars or its own notes budget.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          name: z.string().optional(),
          description: z.string().optional(),
          repo: z.string().nullable().optional(),
          base_branch: z.string().optional(),
          env: envSchema,
          remove_env: z.array(z.string()).optional(),
          notes_max: z
            .number()
            .int()
            .min(NOTE_BUDGET_LIMITS.maxNotes.min)
            .max(NOTE_BUDGET_LIMITS.maxNotes.max)
            .nullable()
            .optional()
            .describe("This project's max notes; null goes back to Settings › Max notes."),
          notes_max_tokens: z
            .number()
            .int()
            .min(NOTE_BUDGET_LIMITS.maxTokens.min)
            .max(NOTE_BUDGET_LIMITS.maxTokens.max)
            .nullable()
            .optional()
            .describe("This project's notes token budget; null goes back to the one in Settings."),
        },
      },
      safe(
        async (a: {
          project: string
          name?: string
          description?: string
          repo?: string | null
          base_branch?: string
          env?: Record<string, string>
          remove_env?: string[]
          notes_max?: number | null
          notes_max_tokens?: number | null
        }) => {
          const p = store.updateProject(project(a.project).id, {
            name: a.name,
            description: a.description,
            repo: a.repo,
            baseBranch: a.base_branch,
            env: a.env,
            removeEnv: a.remove_env,
            notesMaxCount: a.notes_max,
            notesMaxTokens: a.notes_max_tokens,
          })
          hub.broadcast({ type: "project", project: p })
          notes.checkBudget(p.id)
          return ok(projectView(p))
        },
      ),
    ),
  )

  coordinatorOnly(
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
    ),
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
      let list = store.listTasks({ projectId: projectFilter(a.project), status: a.status })
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

  coordinatorOnly(
    server.registerTool(
      "list_compactions",
      {
        description:
          "List orchestrator compaction records, newest first. Use this to recover prior context after the orchestrator was compacted; pass task to filter to compactions that mentioned or snapshotted that task.",
        inputSchema: {
          task: z.string().optional().describe("Optional task id or title to filter linked compactions"),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      safe(async (a: { task?: string; limit?: number }) => {
        const taskId = a.task ? task(a.task).id : undefined
        return ok(store.listOrchestratorCompactions({ taskId, limit: a.limit ?? 20 }).map((c) => compactionView(c)))
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "read_compaction",
      {
        description: "Read one orchestrator compaction's markdown summary and linked task snapshots.",
        inputSchema: { compaction: z.string().describe("Compaction id, e.g. 2026-10-22T18-40-05Z") },
      },
      safe(async (a: { compaction: string }) => {
        const c = store.getOrchestratorCompaction(a.compaction, true)
        if (!c) throw new Error(`No compaction "${a.compaction}". Use list_compactions.`)
        return ok(compactionView(c, true))
      }),
    ),
  )

  server.registerTool(
    "find_compactions_by_task",
    {
      description:
        "Find orchestrator compactions linked to a task and that task's own /compact summaries. Use this before resuming older work or writing a PR description that needs historical context.",
      inputSchema: { task: z.string(), limit: z.number().int().min(1).max(100).optional() },
    },
    safe(async (a: { task: string; limit?: number }) => {
      const t = task(a.task)
      return ok({
        task: brief(t),
        // Coordinator compactions span every project, so Captains only get the task's own.
        orchestratorCompactions: scopeId ? undefined : store.listOrchestratorCompactions({ taskId: t.id, limit: a.limit ?? 20 }).map((c) => compactionView(c)),
        taskCompactions: store.listTaskCompactions({ taskId: t.id, limit: a.limit ?? 20 }),
      })
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
        "Use this for new, independent work. For follow-ups on work an agent already did, use send_to_task instead so it keeps its context. Write a self-contained prompt. If Cody attached files (a screenshot of a bug, a spec) that the agent needs, pass them in attachments.",
      inputSchema: {
        project: z.string().describe("Project id or name"),
        title: z.string().min(1).max(120),
        prompt: z.string().min(1),
        env: envSchema,
        related_tasks: z
          .array(z.string())
          .optional()
          .describe("Earlier tasks whose outcome this new agent should know about (their summary, branch and PR are added to its prompt)"),
        attachments: attachmentsSchema,
        ...routeParams,
      },
    },
    safe(async (a: { project: string; title: string; prompt: string; env?: Record<string, string>; related_tasks?: string[]; attachments?: string[]; model?: string; effort?: Effort; routing_rule?: string; routing_reason?: string }) => {
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
      const t = tasks.createTask({
        projectId: project(a.project).id,
        title: a.title,
        prompt,
        env: a.env,
        attachments: uploads.resolveAll(a.attachments),
        model: a.model ?? null,
        effort: a.effort ?? null,
        routingRule: a.routing_rule ?? null,
        routingReason: a.routing_reason ?? null,
        source: inputSource,
      })
      return ok({ ...brief(t), next: "The agent starts as soon as a box slot is free. Use wait_for_tasks to wait for its result if the work is quick." })
    }),
  )

  server.registerTool(
    "send_to_task",
    {
      description:
        "Send a message to an existing task's agent: an answer, feedback, a correction, or follow-up work on the same topic. It continues the SAME Claude session, so the agent remembers everything it did. " +
        "Optionally set model/effort/routing_* for this follow-up; they apply from the agent's next turn on, so a cheap task can be escalated when it struggles. " +
        "If the agent is idle or done, its session resumes right away (restored from the archive if needed). If its archive has expired, a new session starts from a recap (summary, branch, PR, recent messages) on a fresh checkout of its branch; the delivery field says which. If it is mid-turn, the message is queued and delivered as soon as the current turn ends. If the task shows mergeRequested, Cody already asked it to merge that PR with the Merge PR button: don't send merge instructions of your own until that settles. To pass along files Cody attached (a screenshot, a document), use attachments.",
      inputSchema: { task: z.string(), message: z.string().min(1), attachments: attachmentsSchema, ...routeParams },
    },
    safe(async (a: { task: string; message: string; attachments?: string[]; model?: string; effort?: Effort; routing_rule?: string; routing_reason?: string }) => {
      const before = task(a.task)
      const how = delivery(before)
      const t = tasks.sendInput(before.id, a.message, inputSource, uploads.resolveAll(a.attachments), {
        model: a.model,
        effort: a.effort,
        routingRule: a.routing_rule,
        routingReason: a.routing_reason,
      })
      return ok({ ...brief(t), delivery: how })
    }),
  )

  server.registerTool(
    "set_task_model",
    {
      description:
        "Change the model and/or effort an existing task will use on subsequent turns without sending it a message. Use send_to_task instead when you also have follow-up instructions.",
      inputSchema: { task: z.string(), ...routeParams },
    },
    safe(async (a: { task: string; model?: string; effort?: Effort; routing_rule?: string; routing_reason?: string }) => {
      if (!a.model && !a.effort && !a.routing_rule && !a.routing_reason) return fail("Pass at least one of model, effort, routing_rule or routing_reason.")
      const t = tasks.setTaskModel(task(a.task).id, {
        model: a.model ?? undefined,
        effort: a.effort ?? undefined,
        routingRule: a.routing_rule ?? undefined,
        routingReason: a.routing_reason ?? undefined,
      })
      return ok(brief(t))
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
    { description: "Tasks waiting on Cody (questions) or ready for review (PRs), and failures. Quiet schedule runs (no-ops) never show here." },
    safe(async () =>
      ok(withoutQuiet(store.listTasks({ projectId: scopeId ?? undefined, status: ["needs_input", "pr_ready", "failed"] })).map(brief)),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "save_note",
      {
        description:
          "Add a lasting rule to a project's notes right away (same as add_note). Every agent in the project starts with them, so keep it to what Cody decided, box gotchas and facts not in the code.",
        inputSchema: { project: z.string(), content: z.string().min(1).max(MAX_NOTE_CHARS) },
      },
      safe(async (a: { project: string; content: string }) => {
        const p = project(a.project)
        const n = notes.add(p.id, a.content, editor)
        return ok({ saved: n.id, ...budgetView(p.id) })
      }),
    ),
  )

  const noteContent = z.string().min(1).max(MAX_NOTE_CHARS)
  const notesProjectParam = z
    .string()
    .optional()
    .describe(scopeId ? "Leave out: your own project." : "Project id or name.")

  server.registerTool(
    "list_notes",
    {
      description:
        "A project's notes, oldest first, with ids, who wrote and last edited each, and the budget. Every agent in the project starts with these notes; when they're over budget, the ones marked leftOut aren't in agents' prompts.",
      inputSchema: { project: notesProjectParam },
    },
    safe(async (a: { project?: string }) => {
      const p = notesProject(a.project)
      const report = notes.budget(p.id)
      const left = new Set(report.hidden.map((n) => n.id))
      return ok({
        project: p.name,
        ...budgetView(p.id),
        pendingSuggestions: store.pendingSuggestionCount(p.id) || undefined,
        notes: report.shown.concat(report.hidden).sort((x, y) => x.createdAt - y.createdAt).map((n) => ({
          id: n.id,
          content: n.content,
          author: n.author,
          created: ago(n.createdAt),
          ...(n.updatedAt !== n.createdAt ? { edited: `${ago(n.updatedAt)}${n.updatedBy ? ` by ${n.updatedBy}` : ""}` } : {}),
          ...(left.has(n.id) ? { leftOut: true } : {}),
        })),
      })
    }),
  )

  server.registerTool(
    "add_note",
    {
      description:
        "Add a lasting rule to the project's notes: an environment or box gotcha, a decision or preference of Cody's, or a project fact that isn't in the code. One short rule per note.",
      inputSchema: { project: notesProjectParam, content: noteContent },
    },
    safe(async (a: { project?: string; content: string }) => {
      const p = notesProject(a.project)
      const n = notes.add(p.id, a.content, editor)
      return ok({ added: n.id, ...budgetView(p.id) })
    }),
  )

  server.registerTool(
    "update_note",
    {
      description: "Rewrite a note (shorten it, fix it, or fold another note into it). Pass the whole new text.",
      inputSchema: { note: z.string().describe("Note id (note_…) from list_notes."), content: noteContent },
    },
    safe(async (a: { note: string; content: string }) => {
      const n = notes.update(note(a.note).id, a.content, editor)
      return ok({ updated: n.id, ...budgetView(n.projectId) })
    }),
  )

  server.registerTool(
    "delete_note",
    {
      description: "Delete a note that's stale, wrong or covered by another one.",
      inputSchema: { note: z.string().describe("Note id (note_…) from list_notes.") },
    },
    safe(async (a: { note: string }) => {
      const n = notes.remove(note(a.note).id, editor)
      return ok({ deleted: n.id, ...budgetView(n.projectId) })
    }),
  )

  server.registerTool(
    "list_note_suggestions",
    {
      description: "Notes agents suggested (suggest_note) with their reasons, oldest first. Pending ones wait for your notes retro and resolve_suggestion.",
      inputSchema: {
        project: notesProjectParam,
        task: z.string().optional().describe("Only this task's suggestions."),
        status: z.enum(["pending", "all"]).optional().describe("pending (default) or all, including resolved ones."),
      },
    },
    safe(async (a: { project?: string; task?: string; status?: "pending" | "all" }) => {
      const t = a.task ? task(a.task) : null
      const p = t ? store.getProject(t.projectId)! : notesProject(a.project)
      if (t && a.project && project(a.project).id !== t.projectId) throw new Error(`Task ${t.id} isn't in project ${a.project}.`)
      const list = store.listNoteSuggestions({ projectId: p.id, taskId: t?.id, status: a.status === "all" ? undefined : ["pending"] })
      return ok({ project: p.name, ...budgetView(p.id), suggestions: list.map(suggestionView) })
    }),
  )

  server.registerTool(
    "resolve_suggestion",
    {
      description:
        "Decide on an agent's note suggestion: keep it if it will help future agents in this project. accept: add it as a note (pass content to reword it as one short rule). merge: fold it into an existing note (pass note and that note's whole new content). reject: drop it (e.g. it's a run log, already covered, or a code convention for AGENTS.md). Every decision needs a one-line reason; the Notes tab shows it.",
      inputSchema: {
        suggestion: z.string().describe("Suggestion id (sug_…)."),
        action: z.enum(SUGGESTION_ACTIONS),
        content: noteContent.optional().describe("accept: the note's text if you reword it. merge: the merged note's whole new text."),
        note: z.string().optional().describe("merge: the id of the note to merge into."),
        reason: z.string().trim().min(1).max(MAX_REASON_CHARS).describe("Why, in one line (shown on the Notes tab)."),
      },
    },
    safe(async (a: { suggestion: string; action: SuggestionAction; content?: string; note?: string; reason: string }) => {
      const s = suggestion(a.suggestion)
      const target = a.note ? note(a.note) : undefined
      const r = notes.resolve(s.id, { action: a.action, content: a.content, noteId: target?.id, reason: a.reason }, editor)
      const left = store.pendingSuggestionCount(s.projectId)
      return ok({
        [r.suggestion.status]: s.id,
        ...(r.note ? { note: r.note.id } : {}),
        ...budgetView(s.projectId),
        pendingSuggestions: left,
      })
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
        projectId: a.project ? project(a.project).id : (t?.projectId ?? scopeId),
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
          .listArtifacts({ projectId: projectFilter(a.project), taskId: a.task ? task(a.task).id : undefined })
          .map((x) => ({ id: x.id, title: x.title, url: absolute(x.url), size: x.size, task: x.taskId })),
      ),
    ),
  )

  const when = (ts: number | null, tz: string) =>
    ts === null ? null : new Date(ts).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })
  const scheduleView = (s: Schedule) => ({
    id: s.id,
    name: s.name,
    target: s.target,
    project: s.projectId ? (store.getProject(s.projectId)?.name ?? s.projectId) : undefined,
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

  const runView = (r: ScheduleRun) => ({
    id: r.id,
    schedule: store.getSchedule(r.scheduleId)?.name ?? r.scheduleId,
    status: r.status,
    reason: r.reason,
    dueAt: new Date(r.dueAt).toISOString(),
    started: r.startedAt ? ago(r.startedAt) : undefined,
    chatMessage: r.chatMessageId ?? undefined,
    error: r.error ?? undefined,
  })
  const anyRunView = (r: Task | ScheduleRun) => ("scheduleId" in r && "dueAt" in r ? runView(r) : brief(r as Task))

  server.registerTool(
    "list_schedules",
    {
      description:
        "List schedules (recurring jobs). Each has a target: \"project\" (starts a task in a project) or \"orchestrator\" (compatibility name for Coordinator schedules that inject a prompt into this chat). " +
        "Filter by project, or by target; project: \"none\" and target: \"orchestrator\" both list only Coordinator schedules.",
      inputSchema: { project: z.string().optional(), target: z.enum(["project", "orchestrator"]).optional() },
    },
    safe(async (a: { project?: string; target?: "project" | "orchestrator" }) => {
      const orchestratorOnly = a.project?.toLowerCase() === "none" || a.target === "orchestrator"
      if (scopeId) {
        if (orchestratorOnly) throw outOfScope("Coordinator schedules belong to the Coordinator")
        return ok(scheduler.list({ projectId: projectFilter(a.project), target: "project" }).map(scheduleView))
      }
      const list = scheduler.list({
        projectId: a.project && !orchestratorOnly ? project(a.project).id : undefined,
        target: orchestratorOnly ? "orchestrator" : a.target,
      })
      return ok(list.map(scheduleView))
    }),
  )

  server.registerTool(
    "create_schedule",
    {
      description:
        "Create a recurring job of one of two kinds. " +
        "PROJECT schedule (give `project`): every time the cron fires, a new task starts in that project with this prompt (plus a note on the previous run), on a box; Cody can watch it live like any task. Use it for repo-specific recurring work: nightly test runs, dependency bumps, issue triage in one repo. " +
        "COORDINATOR schedule (leave `project` out, or target: \"orchestrator\" for compatibility): every time the cron fires, the prompt is injected into this chat as \"[Scheduled: <name>] <prompt>\" and you handle it like a message from Cody, using your tools. No box is used. Use it for cross-project, digest, reminder or routing work: \"every morning summarize open PRs and anything waiting on me across all repos\", \"remind me to...\". If you're busy, it waits until your turn ends. " +
        "cron is 5 fields (minute hour day-of-month month day-of-week) or @hourly/@daily/@weekly/@monthly. Write the prompt so it works on its own every run.",
      inputSchema: {
        project: z.string().optional().describe("Project id or name for a project schedule. Omit for a Coordinator schedule."),
        target: z
          .enum(["project", "orchestrator"])
          .optional()
          .describe('"project" or "orchestrator" (Coordinator schedule compatibility name). Defaults to "project" when `project` is given, otherwise "orchestrator".'),
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
      async (a: { project?: string; target?: "project" | "orchestrator"; name: string; cron: string; prompt: string; timezone?: string; catch_up?: "once" | "skip"; allow_overlap?: boolean; enabled?: boolean }) => {
        if (scopeId && a.target === "orchestrator") throw outOfScope("Coordinator schedules belong to the Coordinator")
        return ok(
          scheduleView(
            await scheduler.create({
              target: scopeId ? "project" : a.target,
              projectId: projectFilter(a.project),
              name: a.name,
              cron: a.cron,
              prompt: a.prompt,
              timezone: a.timezone,
              catchUp: a.catch_up,
              allowOverlap: a.allow_overlap,
              enabled: a.enabled,
            }),
          ),
        )
      },
    ),
  )

  server.registerTool(
    "update_schedule",
    {
      description: "Change a schedule of either kind: rename, new cron/time zone/prompt, or pause (enabled: false) and resume it. A schedule's kind (project vs Coordinator) can't change; delete it and create a new one.",
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
            await scheduler.update(schedule(a.schedule).id, {
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
    { description: "Delete a schedule (either kind). Tasks from past project runs stay.", inputSchema: { schedule: z.string().describe("Schedule id or name") } },
    safe(async (a: { schedule: string }) => {
      const s = schedule(a.schedule)
      await scheduler.remove(s.id)
      return ok(`Deleted schedule ${s.name}.`)
    }),
  )

  server.registerTool(
    "run_schedule_now",
    {
      description:
        "Start a run of a schedule right now (doesn't change its next planned run). A project schedule starts a task; a Coordinator schedule queues its prompt into this chat (delivered after your current turn ends, so don't wait on it).",
      inputSchema: { schedule: z.string() },
    },
    safe(async (a: { schedule: string }) => ok(anyRunView(scheduler.runNow(schedule(a.schedule).id)))),
  )

  server.registerTool(
    "list_schedule_runs",
    {
      description:
        "Past runs of a schedule, newest first: tasks for a project schedule; for a Coordinator schedule, the injected chat messages with their status (queued, running, done, failed). " +
        "Quiet runs (the agent found nothing to do and changed nothing) are included and marked quiet: true; pass include_quiet: false to leave them out.",
      inputSchema: { schedule: z.string(), limit: z.number().int().min(1).max(100).optional(), include_quiet: z.boolean().optional() },
    },
    safe(async (a: { schedule: string; limit?: number; include_quiet?: boolean }) =>
      ok(
        scheduler
          .runs(schedule(a.schedule).id, a.include_quiet === false ? 100 : (a.limit ?? 10))
          .filter((r) => a.include_quiet !== false || !("outcome" in r && isQuietRun(r)))
          .slice(0, a.limit ?? 10)
          .map(anyRunView),
      ),
    ),
  )

  server.registerTool(
    "pool_status",
    {
      description:
        "Show worker boxes (which projects live on each; running = busy/total agent slots on that box) and queued tasks. pool.agentsPerBox and pool.tasksPerBox give the limit for each box size; pool.overridden says when Settings or an env var replaces the size defaults for every box. Box Yard places tasks itself: a project's tasks share its box, a new project gets its own box while the pool has room.",
    },
    safe(async () =>
      ok({
        boxes: tasks.boxes().map((b) => ({
          id: b.id,
          status: b.status,
          size: `${b.size} (${sizeSpecLine(b.size)})`,
          projects: b.projects,
          running: `${b.runningTurns}/${b.slots}`,
          tasks: b.residentTasks.length,
          disk: `${diskLine({ freeBytes: b.diskFreeBytes, totalBytes: b.diskTotalBytes, checkedAt: b.diskCheckedAt })}${b.diskLow ? " (low)" : ""}`,
          disk_mb:
            b.diskFreeBytes !== null && b.diskTotalBytes !== null
              ? { free: mb(b.diskFreeBytes), used: mb(Math.max(0, b.diskTotalBytes - b.diskFreeBytes)), total: mb(b.diskTotalBytes), measured: b.diskCheckedAt ? ago(b.diskCheckedAt) : null }
              : null,
          ...(rootDiskLine(b) ? { root_disk: `${rootDiskLine(b)}${rootLow({ freeBytes: b.rootFreeBytes ?? null, totalBytes: b.rootTotalBytes ?? null }) ? " (low)" : ""}` } : {}),
          ...(b.cleanup ? { cleanup: b.cleanup.status === "running" ? "running now" : `${cleanupSummary(b.cleanup)} ${ago(b.cleanup.finishedAt ?? b.cleanup.startedAt)}` } : {}),
          ...(b.resize && (b.resize.status === "running" || Date.now() - (b.resize.finishedAt ?? 0) < 24 * 3600_000)
            ? { resize: `${resizeTitle(b.resize)}: ${resizeSummary(b.resize)}${b.resize.finishedAt ? ` ${ago(b.resize.finishedAt)}` : ""}` }
            : {}),
        })),
        pool: tasks.poolLimits(),
        resize_box: resizeGuard(),
        queued: store.listTasks({ projectId: scopeId ?? undefined, status: ["queued"] }).map((t) => `${t.id} ${t.title}${t.waitReason ? ` (${t.waitReason})` : ""}`),
      }),
    ),
  )

  // ---------------------------------------------------------------- hooks
  // Coordinator: global hooks and any project's. A Captain: only its own project's hooks and their runs,
  // never another project's or the global ones (#58 scoping, enforced here, not in the prompt).
  const hookEngine = deps.hooks
  if (hookEngine) {
    const createdBy = () => (scopeId ? `the ${ownProject().name} Captain` : "the Coordinator")
    const hookRef = (ref: string): Hook => {
      const h = hookEngine.find(ref, scopeId ?? undefined)
      if (!h) throw new Error(`No hook "${ref}"${scopeId ? " in this project" : ""}. Use list_hooks.`)
      if (scopeId && h.projectId !== scopeId) {
        throw outOfScope(h.projectId ? `hook "${h.name}" belongs to another project` : `hook "${h.name}" is a global (Coordinator) hook`)
      }
      return h
    }
    /** Where a new hook lives: a Captain's own project; for the Coordinator, the given project or global. */
    const hookScope = (ref?: string | null): string | null => (scopeId ? (ref ? project(ref).id : scopeId) : ref ? project(ref).id : null)
    const hookView = (h: Hook & { lastRun?: HookRun | null }) => ({
      id: h.id,
      name: h.name,
      scope: h.projectId ? (store.getProject(h.projectId)?.name ?? h.projectId) : "global",
      enabled: h.enabled,
      on: `${h.trigger} (${TRIGGER_INFO[h.trigger].label})`,
      action: h.action,
      taskTitle: h.taskTitle ?? undefined,
      filters: Object.keys(h.filters).length ? h.filters : undefined,
      prompt: h.prompt,
      allowSelfTrigger: h.allowSelfTrigger || undefined,
      maxFiresPerTask: h.maxFiresPerTask,
      template: h.template ?? undefined,
      createdBy: h.createdBy,
      lastRun: h.lastRun ? `${h.lastRun.status} ${ago(h.lastRun.createdAt)} on ${h.lastRun.taskId ?? "?"}: ${h.lastRun.result}` : undefined,
    })
    const runView = (r: HookRun) => ({
      at: new Date(r.createdAt).toISOString(),
      hook: r.hookName,
      event: r.event,
      task: r.taskId ? `${r.taskId} "${r.taskTitle ?? ""}"` : undefined,
      headSha: r.headSha ?? undefined,
      action: r.action,
      status: r.status,
      result: r.result,
      target: r.targetTaskId && r.targetTaskId !== r.taskId ? r.targetTaskId : undefined,
      prompt: preview(r.prompt, 400, "see the hook's runs in the app"),
    })
    const filtersSchema = z
      .object({
        project: z.string().optional().describe("Global hooks only: just this project's tasks"),
        title_regex: z.string().max(300).optional().describe("Case-insensitive regex the task title must match"),
        prompt_regex: z.string().max(300).optional().describe("Case-insensitive regex the task prompt must match"),
        sources: z.array(z.enum(HOOK_SOURCES)).optional().describe("Only tasks started by these: cody, captain, coordinator, schedule"),
        labels: z.array(z.string()).optional().describe("The PR must carry at least one of these labels"),
        exclude_labels: z.array(z.string()).optional().describe('Skip PRs with any of these labels, e.g. ["no-automerge"]'),
        include_drafts: z.boolean().optional().describe("Also fire for draft PRs (off by default)"),
        include_quiet: z.boolean().optional().describe("schedule.run_finished: also fire for quiet no-op runs (off by default)"),
      })
      .optional()
    type FiltersArg = z.infer<typeof filtersSchema>
    const toFilters = (f: FiltersArg) =>
      f === undefined
        ? undefined
        : {
            projectId: f.project ? project(f.project).id : null,
            titleRegex: f.title_regex ?? null,
            promptRegex: f.prompt_regex ?? null,
            sources: f.sources,
            labels: f.labels,
            excludeLabels: f.exclude_labels,
            includeDrafts: f.include_drafts,
            includeQuiet: f.include_quiet,
          }
    const triggers = HOOK_TRIGGERS.map((t) => `${t} (${TRIGGER_INFO[t].description})`).join("; ")
    const actions = HOOK_ACTIONS.map((a) => `${a} (${ACTION_INFO[a].description})`).join("; ")

    server.registerTool(
      "create_hook",
      {
        description:
          "Create a hook: an automation that runs when a task event happens, so routine follow-ups happen without anyone watching. " +
          `Triggers: ${triggers}. Actions: ${actions}. ` +
          `The prompt is a template; ${HOOK_VARIABLES.map((v) => `{${v}}`).join(", ")} are filled in when it fires. ` +
          (scopeId
            ? "Your hooks always belong to your project. "
            : "Leave project out for a global hook (every project's tasks, optionally filtered with filters.project), or give project for a project hook its Captain manages. ") +
          'template: "pr_merge" starts from the built-in "On PR ready → merge" hook (the Merge PR button\'s standard merge request; PRs labelled no-automerge skipped); other fields override it. ' +
          "New hooks are OFF unless enabled: true. Turn one on only when Cody asked for the automation. Each fire fires once per event (per PR head commit for task.pr_ready), never on work it started itself, and shows on the task's transcript and as a notice to the Captain and the Coordinator.",
        inputSchema: {
          name: z.string().min(1).max(120).optional().describe("Required unless template is given"),
          project: z.string().optional().describe(scopeId ? "Your project (the default)" : "Project id or name for a project hook; omit for a global hook"),
          template: z.enum(HOOK_TEMPLATES).optional().describe("Start from a built-in hook; the other fields override it, and filters add to its own"),
          trigger: z.enum(HOOK_TRIGGERS).optional().describe("Required unless template is given"),
          action: z.enum(HOOK_ACTIONS).optional().describe("Required unless template is given"),
          prompt: z.string().min(1).max(20_000).optional().describe("Required unless template is given"),
          task_title: z.string().max(120).optional().describe("create_task only: the new task's title (a template)"),
          filters: filtersSchema,
          enabled: z.boolean().optional().describe("Default false"),
          allow_self_trigger: z.boolean().optional().describe("Let it fire on turns its own prompt started. Default false: leave it off unless the loop is intended."),
          max_fires_per_task: z.number().int().min(1).max(50).optional().describe("Most fires per task (default 3)"),
        },
      },
      safe(
        async (a: {
          name?: string
          project?: string
          template?: (typeof HOOK_TEMPLATES)[number]
          trigger?: (typeof HOOK_TRIGGERS)[number]
          action?: (typeof HOOK_ACTIONS)[number]
          prompt?: string
          task_title?: string
          filters?: FiltersArg
          enabled?: boolean
          allow_self_trigger?: boolean
          max_fires_per_task?: number
        }) => {
          const projectId = hookScope(a.project)
          const filters = toFilters(a.filters)
          if (scopeId && filters?.projectId && filters.projectId !== scopeId) throw outOfScope("hooks can only watch your own project")
          if (a.template) {
            // One create with the overrides applied; given filters add to the template's (pr_merge keeps skipping no-automerge).
            const hook = hookEngine.fromTemplate(a.template, {
              projectId,
              createdBy: createdBy(),
              enabled: a.enabled,
              name: a.name,
              prompt: a.prompt,
              trigger: a.trigger,
              action: a.action,
              taskTitle: a.task_title,
              filters,
              allowSelfTrigger: a.allow_self_trigger,
              maxFiresPerTask: a.max_fires_per_task,
            })
            return ok(hookView(hook))
          }
          if (!a.name || !a.trigger || !a.action || !a.prompt) throw new Error("Give name, trigger, action and prompt (or a template).")
          return ok(
            hookView(
              hookEngine.create({
                name: a.name,
                projectId,
                trigger: a.trigger,
                action: a.action,
                prompt: a.prompt,
                taskTitle: a.task_title ?? null,
                filters: filters ?? {},
                enabled: a.enabled ?? false,
                allowSelfTrigger: a.allow_self_trigger,
                maxFiresPerTask: a.max_fires_per_task,
                createdBy: createdBy(),
              }),
            ),
          )
        },
      ),
    )

    server.registerTool(
      "list_hooks",
      {
        description: scopeId
          ? "List your project's hooks (automations on task events), with each one's last run."
          : 'List hooks with each one\'s last run: all of them, one project\'s (project), or only the global ones (project: "global").',
        inputSchema: { project: z.string().optional() },
      },
      safe(async (a: { project?: string }) => {
        if (scopeId) {
          if (a.project && a.project.toLowerCase() === "global") throw outOfScope("global hooks belong to the Coordinator")
          return ok(hookEngine.list({ projectId: a.project ? project(a.project).id : scopeId }).map(hookView))
        }
        const filter = a.project ? { projectId: a.project.toLowerCase() === "global" ? null : project(a.project).id } : {}
        return ok(hookEngine.list(filter).map(hookView))
      }),
    )

    server.registerTool(
      "update_hook",
      {
        description: "Change a hook: rename it, turn it on or off (enabled), or change its trigger, filters, action, prompt or limits. Passing filters replaces all of them. A hook's scope (global vs project) can't change.",
        inputSchema: {
          hook: z.string().describe("Hook id or name"),
          name: z.string().min(1).max(120).optional(),
          enabled: z.boolean().optional(),
          trigger: z.enum(HOOK_TRIGGERS).optional(),
          action: z.enum(HOOK_ACTIONS).optional(),
          prompt: z.string().min(1).max(20_000).optional(),
          task_title: z.string().max(120).optional(),
          filters: filtersSchema,
          allow_self_trigger: z.boolean().optional(),
          max_fires_per_task: z.number().int().min(1).max(50).optional(),
        },
      },
      safe(
        async (a: {
          hook: string
          name?: string
          enabled?: boolean
          trigger?: (typeof HOOK_TRIGGERS)[number]
          action?: (typeof HOOK_ACTIONS)[number]
          prompt?: string
          task_title?: string
          filters?: FiltersArg
          allow_self_trigger?: boolean
          max_fires_per_task?: number
        }) => {
          const h = hookRef(a.hook)
          const filters = toFilters(a.filters)
          if (scopeId && filters?.projectId && filters.projectId !== scopeId) throw outOfScope("hooks can only watch your own project")
          return ok(
            hookView(
              hookEngine.update(h.id, {
                name: a.name,
                enabled: a.enabled,
                trigger: a.trigger,
                action: a.action,
                prompt: a.prompt,
                taskTitle: a.task_title,
                filters,
                allowSelfTrigger: a.allow_self_trigger,
                maxFiresPerTask: a.max_fires_per_task,
              }),
            ),
          )
        },
      ),
    )

    server.registerTool(
      "delete_hook",
      { description: "Delete a hook. Its past runs stay in the log.", inputSchema: { hook: z.string().describe("Hook id or name") } },
      safe(async (a: { hook: string }) => {
        const h = hookRef(a.hook)
        hookEngine.remove(h.id)
        return ok(`Deleted hook "${h.name}".`)
      }),
    )

    server.registerTool(
      "list_hook_runs",
      {
        description:
          "The hook audit log, newest first: when each hook matched an event, what it sent (the rendered prompt) and what happened (fired, skipped by a guard, or failed). Filter by hook, task or project.",
        inputSchema: { hook: z.string().optional(), task: z.string().optional(), project: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
      },
      safe(async (a: { hook?: string; task?: string; project?: string; limit?: number }) => {
        const hookId = a.hook ? hookRef(a.hook).id : undefined
        const taskId = a.task ? task(a.task).id : undefined
        const projectId = scopeId ?? (a.project ? project(a.project).id : undefined)
        // A Captain reads only its own hooks' runs, not the global hooks' (even on its own tasks).
        return ok(hookEngine.runs({ hookId, taskId, projectId, hookScope: scopeId ?? undefined, limit: a.limit ?? 20 }).map(runView))
      }),
    )
  }

  // Boxes are shared across projects, so cleaning one up is the Coordinator's call.
  coordinatorOnly(
    server.registerTool(
      "clean_up_box",
      {
        description:
          "Coordinator tool: free disk on a worker box now, in safe steps (partial clones, caches, git-ignored node_modules/build dirs of resting tasks, git gc, then parking archived done workspaces only if still low). Under 100 MB free it first drops session temp files and removes done workspaces whose PR is merged and fully pushed (no archive needed: GitHub has them). " +
          "Never touches uncommitted work. Runs in the background; check pool_status for the result. Box Yard also does this on its own when a box runs low.",
        inputSchema: { box: z.string().describe("Box id, from pool_status") },
      },
      safe(async (a: { box: string }) => {
        const report = await tasks.cleanBox(a.box)
        return ok({ started: true, box: report.boxId, next: "Call pool_status in a minute to see what it freed." })
      }),
    ),
  )

  server.registerTool(
    "resize_box",
    {
      description:
        "Resize a worker box up or down (small 2 vCPU/4 GB RAM/10 GB disk, medium 4/8/20, large 8/16/30; pool_status shows each box's size and disk). " +
        (tasks?.resizeMode() === "in-place"
          ? "The provider resizes the box in place, keeping its disk. "
          : "Upstash can't change a box's size in place, so Box Yard makes a new box of that size, archives every workspace, moves the tasks and projects to it and deletes the old box; workspaces restore from their archive on each task's next turn. ") +
        "Refused while agents are running on the box (wait until it's idle; never stop agents for this), for a scale-down whose disk in use wouldn't fit, and when Cody's Settings don't allow it or the size is above the maximum set there. " +
        "Runs in the background; Cody, the Coordinator and the box's Captains get a notice with your reason when it finishes." +
        (scopeId ? " As a Captain you can only resize a box your project's tasks live on." : ""),
      inputSchema: {
        box: z.string().describe("Box id, from pool_status"),
        size: z.enum(BOX_SIZES),
        reason: z.string().trim().min(3).max(500).describe("Why, in one sentence for Cody (e.g. \"Low on disk three times today and cleanup frees under 200 MB\")."),
      },
    },
    safe(async (a: { box: string; size: BoxSize; reason: string }) => {
      const guard = resizeGuard()
      if (!guard.allowed) {
        return fail(owner("Cody has turned off automatic box resizing (Settings → Boxes & limits → Resizing). Tell Cody why a resize would help; Cody can resize it from the Boxes page."))
      }
      if (compareSizes(a.size, guard.max_size) > 0) {
        return fail(owner(`Cody's Settings let you resize boxes up to ${guard.max_size}; ${a.size} is above that. Ask Cody to resize it from the Boxes page, or pick ${guard.max_size}.`))
      }
      const box = store.getBox(a.box)
      if (!box) return fail(`No box "${a.box}". Use pool_status.`)
      if (scopeId && !tasks.projectsOnBox(box.id).includes(scopeId)) {
        throw outOfScope(`box ${box.id} doesn't host project "${ownProject().name}"`)
      }
      const by = scopeId ? ({ kind: "captain", projectId: scopeId } as const) : ({ kind: "coordinator" } as const)
      const r = await tasks.resizeBox(box.id, a.size, { by, reason: a.reason })
      return ok({
        started: true,
        box: r.boxId,
        from: r.from,
        to: r.to,
        how: r.mode === "in-place" ? "in place" : "migration to a new box",
        next: "You'll get a notice when it's done; pool_status shows progress.",
      })
    }),
  )

  return server
}

/** The Coordinator's token gets every tool; a Captain's own token is scoped to its project. */
function callerFor(deps: McpDeps, token: string, auth: string | undefined): McpCaller | null {
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null
  if (!bearer) return null
  if (bearer === token) return { kind: "coordinator" }
  const projectId = deps.captains?.projectForToken(bearer)
  return projectId ? { kind: "captain", projectId } : null
}

/** Stateless Streamable HTTP endpoint: a fresh server per request. */
export function mcpHandler(deps: McpDeps, token: string) {
  return async (req: Request, res: Response) => {
    const caller = callerFor(deps, token, req.headers.authorization)
    if (!caller) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null })
      return
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").end()
      return
    }
    const server = buildMcpServer(deps, caller)
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
