import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Request, Response } from "express"
import { z } from "zod"
import { capReply, preview } from "./replies.js"
import { STATUS_ONLY_SNAPSHOT } from "./compactionTasks.js"
import type { Store } from "./store.js"
import type { SendNowResult, TaskManager } from "./tasks.js"
import type { Hub } from "./hub.js"
import type { Artifacts } from "./artifacts.js"
import type { StoredUpload, Uploads } from "./uploads.js"
import type { Scheduler } from "./scheduler.js"
import { CAPTAIN_WAIT_DEFAULT_SECONDS, CAPTAIN_WAIT_MAX_SECONDS, type CaptainManager } from "./captains.js"
import type { HookEngine } from "./hooks.js"
import { placementLine } from "../shared/placement.js"
import { ACTION_INFO, HOOK_ACTIONS, HOOK_SOURCES, HOOK_TEMPLATES, HOOK_TRIGGERS, HOOK_VARIABLES, TRIGGER_INFO, type Hook, type HookRun } from "../shared/hooks.js"
import { describeCron } from "../shared/cron.js"
import { isQuietRun, withoutQuiet } from "../shared/quiet.js"
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings.js"
import { SETTINGS_GROUPS, changeLine, type SettingsGroup, type SettingsTools } from "./settingsTools.js"
import { ProjectNotes, SUGGESTION_ACTIONS, MAX_NOTE_CHARS, type SuggestionAction } from "./notes.js"
import { MAX_REASON_CHARS, NOTE_BUDGET_LIMITS } from "../shared/notes.js"
import { BOX_SIZES, EFFORTS, PROJECT_BOX_LIMITS, TASK_STATUSES, type BoxFanout, type BoxSize, type CloudSpend, type Effort, type NoteSuggestion, type Project, type ProjectNote, type QueuedMessage, type Schedule, type ScheduleRun, type Task } from "../shared/types.js"
import { RUNPOD_GPU_GUIDE, RUNPOD_MACHINE_LIMITS, isGpuBox } from "../shared/runpod.js"
import { isDockerBox } from "../shared/docker.js"
import { boxHead, boxSummary, mapLimit } from "./boxDelete.js"
import type { BoxActor } from "../shared/boxHistory.js"
import { errorMessage } from "./util/retry.js"
import { PR_REPORT_FRESH_MS } from "./prs.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { usd } from "./cloudLimit.js"
import { cleanupSummary, diskLine, rootDiskLine, rootLow } from "../shared/disk.js"
import { compareSizes, resizeSummary, resizeTitle, sizeSpecLine } from "../shared/boxSizes.js"
import { loadLine, memLine } from "../shared/memory.js"
import type { MachineStats } from "./machineStats.js"
import { BOX_EVENT_TYPES, boxActorLabel, type BoxEventType } from "../shared/boxHistory.js"
import { snapshotJobLine } from "../shared/snapshots.js"
import { RUNNERS, type Runner } from "../shared/runner.js"
import { AGENT_CLIS, type AgentCli } from "../shared/agentCli.js"
import { TASK_PRIORITIES, byQueueOrder, type TaskPriority } from "../shared/priority.js"
import fs from "node:fs"
import type { Artifact, CompactionTaskSnapshot, OrchestratorCompactionRecord } from "../shared/types.js"
import { compactionTime } from "./compactions.js"
import type { Identities } from "./identity/identities.js"
import { IdentityDetector } from "./identity/detect.js"
import { applyRefs, assignChecked, createWithRefs, detectFor, importDetected, testRepos, type IdentityRefs } from "./identity/setup.js"
import { redact } from "./credentials.js"
import { redactValues } from "./redact.js"
import { scopeLine, type Connectors } from "./connectors/connectors.js"
import type { Connector } from "../shared/connectors.js"
import { COORDINATOR_SEES, DEFAULT_IDENTITY_ID, IDENTITY_COLORS, type CoordinatorSees, type Identity, type IdentityColor } from "../shared/identities.js"
import { PROJECT_COLORS, type ProjectColor } from "../shared/projectColors.js"
import { TASK_ICONS, type TaskIconName } from "../shared/taskIcons.js"
import { READ_ONLY_REFUSAL, THREAD_TOOLS } from "./sideThreads.js"
import { timingReport, type McpHandshakes } from "./turnTimings.js"
import { formatMs, TURN_ROLES, TURN_STAGES, type Quantiles, type TurnRole } from "../shared/turnTimings.js"
import { chatAround, DEFAULT_HISTORY_SOURCES, HISTORY_SOURCES, parseTerms, searchHistory, TRANSCRIPT_SCAN_ROWS, type HistoryHit, type HistorySource } from "./history.js"

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
  /** get_settings / update_settings (Coordinator only). Optional so tests can build the server without them. */
  settingsTools?: SettingsTools
  captains?: CaptainManager
  /** Optional so older tests can build the server without it; then the hook tools aren't offered. */
  hooks?: HookEngine
  /** Every note change goes through it. Built from the other deps when a test leaves it out. */
  notes?: ProjectNotes
  /** The Coordinator's compaction log folder, for search_history. Without it, the Coordinator's summaries aren't searched. */
  coordinatorCompactionsDir?: string
  /** Where new projects run (the setup choice). Without it, Upstash boxes. */
  defaultRunner?: () => Runner
  /** Settings › Identities (docs/identities.md). Without it, the identity tools aren't offered. */
  identities?: Identities
  /** How detect_identities and the gh:, file: and agent: references read this computer (tests: a fake one). */
  identityDetector?: IdentityDetector
  /** Side threads' read-only tokens (server/sideThreads.ts). */
  threads?: { callerForToken(token: string): McpCaller | null }
  /** This computer's memory, swap and load (machine_stats). Without it, the tool isn't offered. */
  machine?: MachineStats
  /** Settings › Connectors (docs/connectors.md). Without it, list_connectors isn't offered. */
  connectors?: Connectors
}

/**
 * Who is calling the MCP server. Captains only see and touch their own project. A read-only caller (a side thread
 * of either chat) sees the same tools but may only run THREAD_TOOLS.
 */
export type McpCaller = ({ kind: "coordinator" } | { kind: "captain"; projectId: string }) & { readOnly?: boolean }

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }
const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
})
/** Unindented JSON, for the history tools whose lists can be long. */
const okCompact = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] })
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

/** What a status-only project's task shows instead of its question or error (docs/identities.md › Coordinator sees). */
const STATUS_ONLY_FIELD = "(status only: ask the project's Captain)"

const SEND_NOW_DESCRIPTION =
  "true: deliver it now. If the agent is mid-turn, its current step is stopped (like stop_task: workspace, session and queue kept) and the next turn resumes the session with this and every other queued message, in send order. Use it only when the message changes what the agent is doing right now. No effect when it isn't mid-turn."
const ALLOW_MERGE_INTERRUPT_DESCRIPTION =
  "A turn that is carrying a merge request (the task shows mergeRequested with deliveredAt) is never interrupted unless you pass allow_merge_interrupt: true; without it the call fails and nothing changes."

/** What sendQueuedNow did, for the MCP reply. */
function sendNowDelivery(r: SendNowResult): string {
  if (r.delivery === "interrupted") return `interrupting: the current step is being stopped; the next turn resumes the session with all ${r.queued} queued message${r.queued === 1 ? "" : "s"}, in order`
  if (r.delivery === "after_compaction") return "after compaction: the agent is compacting its context; the queued messages go out right after, in the same session"
  if (r.delivery === "already_delivered") return "already delivered: a turn has taken the queued messages (or none were queued)"
  return "next turn: no turn had to be stopped; the queued messages go out with the agent's next turn"
}

const attachmentsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Files for the agent: ones Cody attached in this chat, as the ids (up_…) or paths shown in their message, or hosted artifacts, as ids (art_…) or /artifacts/ URLs. They are copied into the agent's task folder under attachments/ and named in its prompt, so the agent can open screenshots, briefs and other files.",
  )

/** An artifact id, alone or inside an /artifacts/ URL. */
const ARTIFACT_REF = /\b(art_[a-f0-9]{12})\b/
/** read_artifact returns at most this many characters of text per call. */
const ARTIFACT_TEXT_MAX = 50_000
const ARTIFACT_TEXT_DEFAULT = 20_000
/** Images up to this size come back as an image the model can see. */
const ARTIFACT_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml)|image\/svg\+xml)/
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/
/** A compaction digest lists at most this many of its linked tasks. */
const DIGEST_TASKS = 10

const effortSchema = z
  .enum(EFFORTS)
  .optional()
  .describe(
    "How hard the agent should think (reasoning effort). Omit it to use the project route, Settings or routing defaults; pass one for a matching routing rule, an escalation, or when Settings leaves effort to the Coordinator, and then pick the lowest level that fits: " +
      "low = one-command chores and lookups (open or close an issue, run one command, read a file, report a status); " +
      "medium = small, well-specified edits or config changes; " +
      "high = real coding work (features, bug fixes, refactors, tests, reviews, research that needs care); " +
      "xhigh/max = large, hard or risky multi-file work, deep debugging or architecture decisions. " +
      "Opus 4.6 and Sonnet 4.6 have no xhigh (it runs as high); Opus 4.5, Sonnet 4.5, Haiku 4.5 and older take no effort.",
  )

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:\[\]/-]+$/, "Model names have no spaces")
  .optional()
  .describe(
    "Claude model for this task or subsequent turn, from a matching routing rule or Cody's request. Omit to use the project route, Settings or routing defaults; a value here overrides them. " +
      "Any id `claude --model` takes: claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, an alias (opus, sonnet, haiku, fable, best, opusplan, opus[1m], sonnet[1m]) or an older id such as claude-opus-4-6.",
  )
const routingRuleSchema = z.string().trim().min(1).max(120).optional().describe("Routing rule name/id that selected this model and effort.")
const routingReasonSchema = z.string().trim().min(1).max(500).optional().describe("Short reason this request matches the rule.")
const routeParams = { model: modelSchema, effort: effortSchema, routing_rule: routingRuleSchema, routing_reason: routingReasonSchema }
const relatedTasksSchema = z
  .array(z.string())
  .optional()
  .describe("Earlier tasks whose outcome this new agent should know about (their summary, branch and PR are added to its prompt)")
/** The most tasks one create_tasks call starts. */
export const MAX_TASK_BATCH = 100
const runsOnSchema = z
  .enum(RUNNERS)
  .optional()
  .describe(
    'Where this agent runs, over the project\'s "Runs on" setting, for every later turn too (send_to_task, retries, hooks, Merge PR): "local" = this computer (the one running Box Yard, unsandboxed), "box" = an Upstash box, "gpu" = the project\'s RunPod GPU pod (billed per hour; needs a RunPod key), "docker" = the project\'s own isolated Docker container on this computer (needs Docker running and a Claude key). Omit it to follow the project. Pass "local" when Cody says to do it "locally", "on my machine" or "on this computer", and "docker" for "in a container" or "isolated". If the runner can\'t run (e.g. claude missing or signed out on this computer, or Docker stopped), the call fails with the reason; it never falls back to the other runner.',
  )
const envSchema = z.record(z.string(), z.string()).optional().describe("Env vars as NAME: value")
const agentSchema = z
  .enum(AGENT_CLIS)
  .optional()
  .describe(
    'The agent CLI it runs on, for good: "claude" (Claude Code) or "codex" (OpenAI Codex). Omit it to follow the project\'s Agent (else Settings › Box agents); a gpt-* or o* model picks "codex" on its own. Pass "codex" when Cody asks for Codex, GPT or OpenAI.',
  )
const iconSchema = z
  .enum(TASK_ICONS)
  .optional()
  .describe("The task's icon in the Coordinator chat, drawn in its project's colour. Omit it to pick one from the title.")

/** When a task's turns are pulled from the queue (shared/priority.ts). */
const PRIORITY_HELP =
  '"high" puts its turns at the front of the queue: when a slot frees up (Settings › Tasks running at once on this computer (localAgents), a box, a GPU pod or a Docker container), it goes before every normal task waiting, first in, first out among the high ones. ' +
  "Use it when Cody wants something to run before the work already queued, e.g. while the localAgents limit is full. It never stops a running agent, and its project's own limits (agents_per_box, whole_machine) still hold; a high task they hold back doesn't block other tasks. " +
  "It stays on the task (its follow-ups go first too) until set_task_priority lowers it."
const prioritySchema = z.enum(TASK_PRIORITIES).optional()

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

/**
 * A side thread's tools: every tool stays listed with its description (so the thread's fork keeps the chat's prompt
 * cache), but only THREAD_TOOLS run; the rest answer READ_ONLY_REFUSAL. The CLI's allowlist refuses them first.
 */
function readOnlyTools(server: McpServer) {
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => RegisteredTool
  const refuse = async () => ({ content: [{ type: "text" as const, text: READ_ONLY_REFUSAL }], isError: true })
  server.registerTool = ((name: string, config: Record<string, unknown>, cb: unknown) => register(name, config, THREAD_TOOLS.has(name) ? cb : refuse)) as typeof server.registerTool
}

/** The box settings create_project and update_project take. */
interface BoxSettingsArgs {
  box_size?: BoxSize | null
  agents_per_box?: number | null
  whole_machine?: boolean
  tasks_per_box?: number | null
  max_boxes?: number | null
  gpu_max_hourly_usd?: number | null
  gpu_types?: string[] | null
  gpu_cloud?: "SECURE" | "COMMUNITY" | null
  gpu_min_ram_gb?: number | null
  gpu_min_vcpus?: number | null
}

/** pool_status's line on cloud spend: "today $3.20 of the $10 daily limit (32%)", and what happens at the limit. */
function cloudLine(spend: CloudSpend): string {
  const today = spend.dailyLimitUsd > 0 ? `today ${usd(spend.todayUsd)} of the ${usd(spend.dailyLimitUsd)} daily limit (${Math.round((spend.todayUsd / spend.dailyLimitUsd) * 100)}%)` : `today ${usd(spend.todayUsd)}, no daily limit`
  const raised = spend.raisedUsd > 0 ? `, raised ${usd(spend.raisedUsd)} until midnight` : ""
  const month = spend.monthlyLimitUsd > 0 ? `; last 30 days ${usd(spend.monthUsd)} of the ${usd(spend.monthlyLimitUsd)} monthly limit` : ""
  const state = spend.blockedReason ? `. Limit reached: new boxes wait (running work goes on and free slots are still used); raise_cloud_limit raises today's` : spend.state === "warning" ? ". Over 80%" : ""
  return `${today}${raised}${month}${state}`
}

/** pool_status's line on new boxes past the hour's free ones: how many wait on Cody's OK, or until when it lasts. */
function fanoutLine(f: BoxFanout): string {
  const free = `Box Yard makes up to ${f.freePerHour} new boxes an hour without asking`
  if (f.allowedUntil) return `${free}; Cody allowed more until ${new Date(f.allowedUntil).toISOString()}`
  if (f.wanted > 0) return `${free}; ${f.wanted} more wait for Cody's OK (up to ${usd(f.upToHourlyUsd)}/h if every core is busy): allow_more_boxes allows them for an hour`
  return free
}

export function buildMcpServer(deps: McpDeps, caller: McpCaller = { kind: "coordinator" }): McpServer {
  const { store, tasks, hub, artifacts, scheduler, uploads } = deps
  const server = new McpServer({ name: "boxyard", version: "0.1.0" })
  const ownerName = deps.settings?.get().ownerName
  const owner = (text: string) => withOwner(text, ownerName)
  nameOwnerInTools(server, ownerName)
  if (caller.readOnly) readOnlyTools(server)
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
  /**
   * Coordinator sees: status only (docs/identities.md). For a project whose identity says so, the Coordinator gets its
   * tasks' status (title, state, PR, box, when) and none of their content: replies, summaries, questions, errors,
   * prompts, transcripts, queued messages, notes, artifacts and its Captain's history. Status views leave those fields
   * out, and every tool that returns content checks unsealed() first. A Captain sees all of its own project.
   */
  const statusOnly = (projectId: string | null | undefined): boolean => !scopeId && Boolean(projectId) && (deps.identities?.statusOnly(projectId!) ?? false)
  const statusOnlyError = (projectId: string, what: string) =>
    new Error(
      `Status only: ${what}. ` +
        owner(
          `Cody set project "${store.getProject(projectId)?.name ?? projectId}" to show you its status only (its identity's Coordinator sees). Its Captain sees everything: ask it with ask_captain or send_to_captain, and it answers with the state of the work.`,
        ),
    )
  /** list_projects' word on a status-only project. */
  const STATUS_ONLY_PROJECT = owner(
    "status only: Cody set its identity to show you its tasks' status (title, state, PR, box), not their replies, questions, errors, prompts, notes or artifacts. Ask its Captain for anything more.",
  )
  /** The check every content-returning tool makes: none of a status-only project's content reaches the Coordinator. */
  const unsealed = (projectId: string | null | undefined, what: string) => {
    if (statusOnly(projectId)) throw statusOnlyError(projectId!, what)
  }
  /** A hosted artifact by id or URL. A Captain only reaches its own project's (or its tasks'); nobody a status-only one's. */
  const artifactRef = (ref: string): Artifact => {
    const id = ARTIFACT_REF.exec(ref)?.[1] ?? ref.trim()
    const a = store.getArtifact(id)
    if (!a) throw new Error(`No artifact "${ref}". Use list_artifacts.`)
    const projectId = a.projectId ?? (a.taskId ? store.getTask(a.taskId)?.projectId : null)
    if (scopeId && a.projectId !== scopeId && (!a.taskId || store.getTask(a.taskId)?.projectId !== scopeId)) {
      throw outOfScope(`artifact ${a.id} ("${a.title}") is not in this project`)
    }
    unsealed(projectId, `artifact ${a.id} is in it`)
    return a
  }
  /** An attachment ref, checked (an upload, or an artifact in scope that still has its file) but not copied yet. */
  const attachmentSource = (ref: string): { upload: StoredUpload } | { artifact: Artifact; file: string } => {
    if (!ARTIFACT_REF.test(ref)) return { upload: uploads.resolve(ref) }
    const a = artifactRef(ref)
    const file = store.artifactPath(a.id)
    if (!file || !fs.existsSync(file)) throw new Error(`Artifact ${a.id} ("${a.title}") has no file on this server any more.`)
    return { artifact: a, file }
  }
  /**
   * Attachment refs as uploads: an artifact is copied into a new upload, so it is delivered like one. `copies`
   * shares one copy of each artifact across the tasks of a batch.
   */
  const attachmentsOf = (refs: string[] | undefined, copies = new Map<string, StoredUpload>()) =>
    [...new Set(refs ?? [])].map((ref) => {
      const src = attachmentSource(ref)
      if ("upload" in src) return src.upload
      const copy = copies.get(src.artifact.id) ?? uploads.save(src.artifact.filename, fs.readFileSync(src.file))
      copies.set(src.artifact.id, copy)
      return copy
    })
  /**
   * The "Related earlier work" section create_task adds to a prompt. A status-only project's task goes only into a new
   * task of its own project: get_task would show the Coordinator another project's prompt.
   */
  const relatedWork = (refs: string[], projectId: string) =>
    `## Related earlier work\n${refs
      .map((ref) => {
        const r = task(ref)
        if (r.projectId !== projectId) unsealed(r.projectId, `related task ${r.id} is in it, and its outcome would go into another project's prompt`)
        return [`- ${r.title} (${r.id}, ${r.status})`, r.summary ? `  Outcome: ${preview(r.summary, 1200, "call get_task for the full reply")}` : "", r.branch ? `  Branch: ${r.branch}` : "", r.prUrl ? `  PR: ${r.prUrl}` : ""]
          .filter(Boolean)
          .join("\n")
      })
      .join("\n")}`
  /** Captains never see the Coordinator-only tools, so they can't call them either. */
  const coordinatorOnly = (tool: RegisteredTool) => {
    if (scopeId) tool.remove()
  }
  /** Tools only a project's Captain has (agents message their Captain, never the Coordinator). */
  const captainOnly = (tool: RegisteredTool) => {
    if (!scopeId) tool.remove()
  }
  /** How worker messages from this caller are labelled (#51). */
  const inputSource = scopeId ? (`captain:${scopeId}` as const) : ("orchestrator" as const)
  /** Who set a task's priority, for its log. */
  const prioritySetter = scopeId ? "its project's Captain" : "the Coordinator"
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
  /**
   * When GitHub last confirmed a task's PR state, and for a PR that may still be open, a warning when that isn't
   * recent: list_inbox, get_task and list_tasks ask GitHub first (refreshPrs), so this shows when GitHub couldn't answer.
   */
  const prFreshness = (t: Task) => {
    if (!t.prUrl) return {}
    const { checkedAt, error } = tasks.prs.prCheck(t.id)
    const settled = t.prState === "merged" || t.prState === "closed"
    const fresh = checkedAt !== null && Date.now() - checkedAt < PR_REPORT_FRESH_MS
    return {
      prCheckedAt: checkedAt === null ? undefined : new Date(checkedAt).toISOString(),
      prUnverified:
        settled || fresh
          ? undefined
          : owner(
              `${checkedAt === null ? "GitHub hasn't confirmed this PR's state since Box Yard started" : `GitHub last confirmed this PR's state ${ago(checkedAt)}`}${error ? ` (${error})` : ""}. ` +
                "It may be merged or closed already: don't tell Cody it's waiting on him. Have the task's agent check it with gh.",
            ),
    }
  }
  /** Ask GitHub about these tasks' PRs whose state is older than PR_REPORT_FRESH_MS, before reporting them. */
  const refreshPrs = (list: Task[]) => tasks.prs.ensureFresh(list.filter((t) => t.prUrl).map((t) => t.id))
  const fullBrief = (t: Task) => ({
    id: t.id,
    title: t.title,
    project: store.getProject(t.projectId)?.name ?? t.projectId,
    status: t.status,
    quiet: isQuietRun(t) || undefined,
    question: t.question ?? undefined,
    pr: t.prUrl ?? undefined,
    prState: t.prUrl ? (t.prState ?? undefined) : undefined,
    ...prFreshness(t),
    mergeRequested: t.mergeRequest
      ? t.mergeRequest.requestedBy
        ? `The ${t.mergeRequest.requestedBy} asked for a merge of #${t.mergeRequest.prNumber} (${t.mergeRequest.deliveredAt ? "the agent is on it" : "queued behind its current turn"}); don't start another merge of this PR`
        : owner(`Cody pressed Merge PR for #${t.mergeRequest.prNumber} (${t.mergeRequest.deliveredAt ? "the agent is on it" : "queued behind its current turn"}); don't start another merge of this PR`)
      : undefined,
    previews: t.previews.length ? t.previews.map((p) => p.url) : undefined,
    error: t.error ?? undefined,
    queuedMessages: t.pendingCount || undefined,
    box: t.boxId ?? undefined,
    placement: placementLine(t),
    runsOn: t.runsOn ?? undefined,
    priority: t.priority === "high" ? t.priority : undefined,
    turns: t.turnCount,
    model: t.model ?? undefined,
    effort: t.effort ?? undefined,
    routing: t.routingRule || t.routingReason ? { rule: t.routingRule ?? undefined, reason: t.routingReason ?? undefined } : undefined,
    lastActive: ago(t.updatedAt),
    summary: t.summary ? preview(t.summary, 300, "call get_task or wait_for_tasks for the full reply") : undefined,
  })
  const brief = (t: Task) => {
    const b = fullBrief(t)
    if (!statusOnly(t.projectId)) return b
    // A status-only project's task: whether it asks something or failed, not what.
    return { ...b, statusOnly: true, question: t.question ? STATUS_ONLY_FIELD : undefined, error: t.error ? STATUS_ONLY_FIELD : undefined, summary: undefined, previews: undefined }
  }
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  /** A task's status now, next to the one a snapshot recorded (undefined when unchanged or gone). */
  const statusNow = (t: CompactionTaskSnapshot) => {
    const now = store.getTask(t.taskId)?.status
    return now && now !== t.status ? now : undefined
  }
  /** One compaction in full: its markdown and every linked task snapshot. */
  const compactionView = (c: OrchestratorCompactionRecord) => ({
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
      statusNow: statusNow(t),
      project: t.projectName,
      branch: t.branch ?? undefined,
      pr: t.prUrl ?? undefined,
      sessionId: t.sessionId,
      // A snapshot written before Cody sealed the project still holds its content.
      summary: statusOnly(t.projectId) ? STATUS_ONLY_SNAPSHOT : t.summary,
    })),
    markdown: c.markdown ?? "",
  })
  /**
   * A compaction in a list: when it was and which tasks it covers, not their snapshots (read_compaction has
   * those). A list of full views once reached ~160k tokens in one call.
   */
  const compactionDigest = (c: OrchestratorCompactionRecord) => ({
    id: c.id,
    at: new Date(c.at).toISOString(),
    trigger: c.trigger,
    tokensBefore: c.tokensBefore,
    tokensAfter: c.tokensAfter,
    file: c.file,
    tasks: c.tasks.slice(0, DIGEST_TASKS).map((t) => ({ id: t.taskId, title: clip(t.title, 70), status: t.status, now: statusNow(t) })),
    moreTasks: c.tasks.length > DIGEST_TASKS ? c.tasks.length - DIGEST_TASKS : undefined,
  })
  /**
   * The agent's latest reply, to be sent once and in full (capped). `summary` is only
   * added when it says something different (e.g. the text passed to mark_done).
   */
  const replyFields = (t: Task, offset = 0) => {
    if (statusOnly(t.projectId)) return { reply: null, fields: brief(t) }
    const last = store.listTaskMessages(t.id, 50).filter((m) => m.role === "assistant").pop()
    const reply = t.summary && (!last || t.summary.length > last.content.length) ? t.summary : (last?.content ?? null)
    const summary = t.summary && t.summary !== reply ? capReply(t.summary) : undefined
    return { reply, fields: { ...brief(t), summary, lastReply: reply === null ? undefined : capReply(reply, offset) } }
  }
  const BUSY = new Set(["queued", "starting", "working"])
  /** What happens to a message sent to this task right now. */
  const delivery = (t: Task) => {
    // Only the task's own Captain reaches an agent waiting in message_captain (TaskManager.handToWaitingAgent).
    if (scopeId && t.projectId === scopeId && tasks.agentWaitingOnCaptain(t.id))
      return "mid-turn: the agent is waiting on its message_captain, so it gets this right away, in its current turn"
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
  /** A note to rewrite or delete. A status-only project's are its Captain's to keep (add_note still adds one). */
  const note = (ref: string): ProjectNote => {
    const n = notes.require(ref.trim())
    if (scopeId && n.projectId !== scopeId) throw outOfScope(`note ${n.id} belongs to another project`)
    unsealed(n.projectId, `note ${n.id} is in it, and its Captain keeps its notes`)
    return n
  }
  const suggestion = (ref: string): NoteSuggestion => {
    const s = notes.requireSuggestion(ref.trim())
    if (scopeId && s.projectId !== scopeId) throw outOfScope(`suggestion ${s.id} belongs to another project`)
    unsealed(s.projectId, `suggestion ${s.id} is in it, and its Captain keeps its notes`)
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
  /** A project's own box settings, for create_project and update_project (null clears one: the global applies). */
  const boxSettingsInput = {
    box_size: z
      .enum(BOX_SIZES)
      .nullable()
      .optional()
      .describe(
        "Size of new boxes made for the project, and the smallest box its tasks run on. null: auto-sizing picks it from what the project's turns used (boxSettings.boxSize in list_projects says what it picked), else Settings › Worker size. Set it only to override auto-sizing.",
      ),
    agents_per_box: z
      .number()
      .int()
      .min(PROJECT_BOX_LIMITS.agentsPerBox.min)
      .max(PROJECT_BOX_LIMITS.agentsPerBox.max)
      .nullable()
      .optional()
      .describe(
        "Tasks running at once: how many of this project's own tasks may run at the same time on one box, GPU pod or this computer. Other projects' tasks never wait for it (only the box's own limit, Settings › Tasks running at once per box or on this computer, bounds them). 1: one at a time, for game engines, big builds, test suites and headless browsers that run a box out of memory. null: only the box's own limit.",
      ),
    whole_machine: z
      .boolean()
      .optional()
      .describe(
        "Needs the whole machine: while one of this project's tasks runs on a box or this computer, no other project's task starts there, and its tasks wait for the others' to finish. For heavy benchmarks that need the machine to themselves. Off by default.",
      ),
    tasks_per_box: z
      .number()
      .int()
      .min(PROJECT_BOX_LIMITS.tasksPerBox.min)
      .max(PROJECT_BOX_LIMITS.tasksPerBox.max)
      .nullable()
      .optional()
      .describe("Most task folders on a box that holds one of this project's (fewer for a big repo); older archived ones are parked. Where projects share a box the stricter limit wins. null: Settings › Task folders kept per box."),
    max_boxes: z
      .number()
      .int()
      .min(PROJECT_BOX_LIMITS.maxBoxes.min)
      .max(PROJECT_BOX_LIMITS.maxBoxes.max)
      .nullable()
      .optional()
      .describe(
        "Most boxes this project's tasks use at once (made for it or holding its task folders), within the pool's Max boxes. null: only the pool's Max boxes. On RunPod GPU it's the most pods the project has at once (each runs agents_per_box tasks at once).",
      ),
    gpu_max_hourly_usd: z
      .number()
      .min(PROJECT_BOX_LIMITS.gpuMaxHourlyUsd.min)
      .max(PROJECT_BOX_LIMITS.gpuMaxHourlyUsd.max)
      .nullable()
      .optional()
      .describe(
        "RunPod GPU only: the most this project's pods may cost together, $/hr. A task that would need a pod over it waits and says so. 0: no cap of its own (the total cap in Settings › RunPod GPU still applies). null: Settings › RunPod GPU › Max per project.",
      ),
    gpu_types: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(10)
      .nullable()
      .optional()
      .describe(
        `RunPod GPU only: GPU types its new pods try, in order, as RunPod gpuTypeIds. Cheap ones for browser/WebGL game testing: ${Object.entries(RUNPOD_GPU_GUIDE)
          .map(([id, g]) => `"${id}" (${g.vramGb} GB, ${g.usd})`)
          .join(", ")}. null: Settings › RunPod GPU › GPU types.`,
      ),
    gpu_cloud: z
      .enum(["SECURE", "COMMUNITY"])
      .nullable()
      .optional()
      .describe("RunPod GPU only: where its new pods run. COMMUNITY is cheaper and has more GPU types (RTX 3070) but no network volume, so caches start cold. null: Settings › RunPod GPU › Cloud."),
    gpu_min_ram_gb: z
      .number()
      .int()
      .min(RUNPOD_MACHINE_LIMITS.minRamGb.min)
      .max(RUNPOD_MACHINE_LIMITS.minRamGb.max)
      .nullable()
      .optional()
      .describe("RunPod GPU only: its new pods only go to hosts with at least this much RAM, GB (a game's browser needs ~12). null: Settings › RunPod GPU › Min RAM."),
    gpu_min_vcpus: z
      .number()
      .int()
      .min(RUNPOD_MACHINE_LIMITS.minVcpus.min)
      .max(RUNPOD_MACHINE_LIMITS.minVcpus.max)
      .nullable()
      .optional()
      .describe("RunPod GPU only: …and at least this many vCPUs. null: Settings › RunPod GPU › Min vCPUs."),
  }
  const boxSettingsPatch = (a: BoxSettingsArgs) => ({
    boxSize: a.box_size,
    agentsPerBox: a.agents_per_box,
    wholeMachine: a.whole_machine,
    tasksPerBox: a.tasks_per_box,
    maxBoxes: a.max_boxes,
    gpuMaxHourlyUsd: a.gpu_max_hourly_usd,
    gpuMachine: { gpuTypes: a.gpu_types, cloud: a.gpu_cloud, minRamGb: a.gpu_min_ram_gb, minVcpus: a.gpu_min_vcpus },
  })
  const projectView = async (p: Project) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repo: p.repo,
    baseBranch: p.baseBranch,
    envKeys: p.envKeys,
    // The CLI its new tasks run on (its own, else Settings › Box agents'); each task keeps the one it started on.
    agent: p.agentCli ?? `${(deps.settings?.get() ?? DEFAULT_SETTINGS).agentCli} (Settings)`,
    boxSettings: tasks.projectBoxSettings(p),
    // Its RunPod pods and $/hr caps, when it runs on RunPod GPU.
    ...(p.runner === "gpu" && tasks ? { gpu: await tasks.projectGpuSettings(p, true) } : {}),
    // Its Docker container, image and limits, when it runs in a Docker container.
    ...(p.runner === "docker" && tasks?.projectDockerSettings(p) ? { docker: tasks.projectDockerSettings(p) } : {}),
    ...(p.snapshot
      ? { snapshot: `${p.snapshot.id}, taken from box ${p.snapshot.boxId} (${p.snapshot.size}) ${ago(p.snapshot.takenAt)}: new boxes of ${p.snapshot.size} or bigger start from it` }
      : {}),
    ...(tasks?.snapshotJob(p.id)?.status === "running" ? { snapshotJob: snapshotJobLine(tasks.snapshotJob(p.id)!) } : {}),
    ...(statusOnly(p.id)
      ? { coordinatorSees: STATUS_ONLY_PROJECT, notes: p.notes.length ? `${p.notes.length} (status only)` : [] }
      : { notes: p.notes.map((n) => `${n.id} (${n.author}) ${n.content}`) }),
    ...(p.notesMaxCount !== null || p.notesMaxTokens !== null ? { notesBudget: notes.budgetStatus(p.id).line } : {}),
    tasks: store.listTasks({ projectId: p.id }).map((t) => `${t.id} ${t.title} [${t.status}]`),
  })

  coordinatorOnly(
    server.registerTool(
      "send_to_captain",
      {
        description: owner(
          "Coordinator tool: send project-scoped work to that project's Captain and return immediately. The Captain has its own persistent Claude session and owns create_task/send_to_task/model routing for the project. " +
            'Its reply shows on Cody\'s chat as soon as it\'s written ("Captain for <project> replied: …") and reaches you as a Box Yard update, so you don\'t need wait_for_captain. ' +
            "It wakes you only when there's something for you to do: a question or decision for Cody, a failure, a next step, or act_on_reply. A reply only for Cody's information (a status, an answer) comes with your next turn's updates instead. Replies to Captains you asked in the same turn (a fan-out) always wake you.",
        ),
        inputSchema: {
          project: z.string().describe("Project id or name"),
          message: z.string().min(1).describe("The project-scoped request for the Captain."),
          act_on_reply: z
            .boolean()
            .optional()
            .describe("true when you'll act on the reply yourself (start a next step, route it on, answer Cody with it): the reply then always wakes you."),
        },
      },
      safe(async (a: { project: string; message: string; act_on_reply?: boolean }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        const msg = deps.captains.send(a.project, a.message, { source: "coordinator", tool: "send_to_captain", actOnReply: a.act_on_reply === true })
        return ok({ delivered: true, projectId: msg.projectId, messageId: msg.id, state: deps.captains.state(msg.projectId) })
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "ask_captain",
      {
        description:
          "Coordinator tool: send a project-scoped request to a Captain and wait briefly (at most 60 s) for its reply; it returns as soon as the reply lands. Use it only for quick questions. If the wait runs out, the Captain keeps working and its reply reaches you as a Box Yard update. Prefer send_to_captain for anything that may take a while.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          message: z.string().min(1),
          timeout_seconds: z.number().int().min(5).max(CAPTAIN_WAIT_MAX_SECONDS).optional().describe(`Default ${CAPTAIN_WAIT_DEFAULT_SECONDS}, at most ${CAPTAIN_WAIT_MAX_SECONDS}`),
        },
      },
      safe(async (a: { project: string; message: string; timeout_seconds?: number }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        return ok(await deps.captains.ask(a.project, a.message, a.timeout_seconds ?? CAPTAIN_WAIT_DEFAULT_SECONDS))
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "wait_for_captain",
      {
        description:
          "Coordinator tool: wait briefly (at most 60 s) for a Captain's next reply to you; it returns as soon as that lands or the Captain goes idle, with its latest reply. Rarely needed: replies to send_to_captain are pushed to you as Box Yard updates. If it times out, the Captain keeps working and its reply still reaches you.",
        inputSchema: {
          project: z.string().describe("Project id or name"),
          timeout_seconds: z.number().int().min(5).max(CAPTAIN_WAIT_MAX_SECONDS).optional().describe(`Default ${CAPTAIN_WAIT_DEFAULT_SECONDS}, at most ${CAPTAIN_WAIT_MAX_SECONDS}`),
        },
      },
      safe(async (a: { project: string; timeout_seconds?: number }) => {
        if (!deps.captains) return fail("Captains are not available in this Box Yard process.")
        return ok(await deps.captains.wait(a.project, a.timeout_seconds ?? CAPTAIN_WAIT_DEFAULT_SECONDS))
      }),
    ),
  )

  server.registerTool(
    "list_projects",
    { description: owner("List all projects, in the order Cody keeps them in the sidebar, with their repo, env var names, notes and tasks.") },
    safe(async () => ok(scopeId ? [await projectView(ownProject())] : await Promise.all(store.listProjects().map(projectView)))),
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
          agent: agentSchema.describe('The agent CLI its tasks run on: "claude" (Claude Code) or "codex" (OpenAI Codex). Omit it to use Settings › Box agents.'),
          ...boxSettingsInput,
        },
      },
      safe(async (a: { name: string; description?: string; repo?: string; base_branch?: string; env?: Record<string, string>; agent?: AgentCli } & BoxSettingsArgs) => {
        if (store.findProject(a.name)) return fail(`A project named "${a.name}" already exists.`)
        const p = store.createProject({ name: a.name, description: a.description, repo: a.repo, baseBranch: a.base_branch, env: a.env, runner: deps.defaultRunner?.(), agentCli: a.agent ?? null, ...boxSettingsPatch(a) })
        hub.broadcast({ type: "project", project: p })
        return ok(await projectView(p))
      }),
    ),
  )

  // The Coordinator changes any of a project's settings; a Captain only its own project's box settings.
  server.registerTool(
    "update_project",
    {
      description: scopeId
        ? "Change your project's box settings, and on RunPod GPU its $/hr cap (gpu_max_hourly_usd) and the machine its new pods get (gpu_types, gpu_cloud, gpu_min_ram_gb, gpu_min_vcpus). Each one left out stays as it is; null clears it, so the global one in Settings › Boxes & limits (or Settings › RunPod GPU) applies again. list_projects shows them (boxSettings, gpu). Running tasks are never stopped by a lower limit; it applies to the next ones."
        : "Change a project's name, description, repo, base branch, env vars, box settings (box_size, agents_per_box = tasks running at once, whole_machine, tasks_per_box = task folders kept per box, max_boxes, and on RunPod GPU gpu_max_hourly_usd, gpu_types, gpu_cloud, gpu_min_ram_gb, gpu_min_vcpus: null clears one so the global setting applies) or its own notes budget, or its colour in the chat and sidebar (color).",
      inputSchema: scopeId
        ? { project: z.string().optional().describe("Your project (the default)"), ...boxSettingsInput }
        : {
            project: z.string().describe("Project id or name"),
            name: z.string().optional(),
            description: z.string().optional(),
            repo: z.string().nullable().optional(),
            base_branch: z.string().optional(),
            env: envSchema,
            remove_env: z.array(z.string()).optional(),
            agent: z
              .enum(AGENT_CLIS)
              .nullable()
              .optional()
              .describe('The agent CLI its new tasks run on: "claude" or "codex"; null goes back to Settings › Box agents. Its existing tasks keep theirs.'),
            ...boxSettingsInput,
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
            color: z
              .enum(PROJECT_COLORS)
              .nullable()
              .optional()
              .describe("Its colour in the Coordinator chat (task icons, the project bar, cards) and the sidebar. null goes back to the one picked from its name."),
          },
    },
    safe(
      async (
        a: {
          project?: string
          name?: string
          description?: string
          repo?: string | null
          base_branch?: string
          env?: Record<string, string>
          remove_env?: string[]
          agent?: AgentCli | null
          notes_max?: number | null
          notes_max_tokens?: number | null
          color?: ProjectColor | null
        } & BoxSettingsArgs,
      ) => {
        if (!a.project && !scopeId) return fail("Name the project to update.")
        const id = a.project ? project(a.project).id : ownProject().id
        const box = boxSettingsPatch(a)
        const p = store.updateProject(
          id,
          scopeId
            ? box
            : {
                name: a.name,
                description: a.description,
                repo: a.repo,
                baseBranch: a.base_branch,
                env: a.env,
                removeEnv: a.remove_env,
                agentCli: a.agent,
                ...box,
                notesMaxCount: a.notes_max,
                notesMaxTokens: a.notes_max_tokens,
                color: a.color,
              },
        )
        hub.broadcast({ type: "project", project: p })
        notes.checkBudget(p.id)
        // Waiting tasks may fit under the new limits.
        if (Object.values(box).some((v) => v !== undefined)) tasks.schedule()
        return ok(await projectView(p))
      },
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
        await tasks.projectDeleted(p.id)
        deps.connectors?.projectDeleted(p.id)
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
      const filter = { projectId: projectFilter(a.project), status: a.status }
      // Fresh PR states first: a PR merged on GitHub moves its task from pr_ready to done.
      await refreshPrs(store.listTasks(filter))
      let list = store.listTasks(filter)
      if (a.query?.trim()) {
        const words = a.query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
        const score = (t: Task) => {
          // A status-only task matches on its title and PR only, so a query can't probe its prompt or summary.
          const hay = (statusOnly(t.projectId) ? `${t.title} ${t.prUrl ?? ""}` : `${t.title} ${t.prompt} ${t.summary ?? ""} ${t.prUrl ?? ""}`).toLowerCase()
          return words.filter((w) => hay.includes(w)).length
        }
        list = list.filter((t) => score(t) > 0).sort((x, y) => score(y) - score(x))
      }
      return ok(list.map(brief))
    }),
  )

  /** A project's Captain compactions live in files under the Captain's data dir; null when no Captains run here. */
  const captainCompactions = (projectId: string, filter: { taskId?: string; limit?: number; before?: number }) =>
    deps.captains ? deps.captains.compactionRecords(projectId, filter).map((c) => ({ ...compactionDigest(c), captain: projectId })) : null
  const noCaptains = "Captains are not available in this Box Yard process."
  const beforeOf = (ref?: string) => {
    if (!ref) return undefined
    const at = compactionTime(ref)
    if (at === null) throw new Error(`"${ref}" is not a compaction id or an ISO time.`)
    return at
  }

  server.registerTool(
    "list_compactions",
    {
      description:
        (scopeId
          ? "List your own Captain compaction records, newest first: when, and which tasks each covers (with their status then and now)."
          : "List compaction records, newest first: the Coordinator's own, or a project Captain's when you pass project. Each says when, and which tasks it covers (with their status then and now).") +
        " Open one with read_compaction. To find something specific in them, search_history is faster. To page, pass before = the last id you got.",
      inputSchema: {
        task: z.string().optional().describe("Optional task id or title to filter linked compactions"),
        project: z
          .string()
          .optional()
          .describe(scopeId ? "Leave out: your own project." : "Project id or name: list that project's Captain compactions instead of the Coordinator's."),
        before: z.string().optional().describe("Only compactions older than this one (an id from a previous page) or this ISO time"),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
      },
    },
    safe(async (a: { task?: string; project?: string; before?: string; limit?: number }) => {
      const taskId = a.task ? task(a.task).id : undefined
      const projectId = projectFilter(a.project)
      const filter = { taskId, limit: a.limit ?? 10, before: beforeOf(a.before) }
      if (!projectId) return okCompact(store.listOrchestratorCompactions(filter).map(compactionDigest))
      unsealed(projectId, "its Captain's compactions are its content")
      const list = captainCompactions(projectId, filter)
      return list ? okCompact(list) : fail(noCaptains)
    }),
  )

  server.registerTool(
    "read_compaction",
    {
      description: scopeId
        ? "Read one of your Captain compactions: its markdown summary and linked task snapshots (statusNow says where a task's status has moved on since)."
        : "Read one compaction's markdown summary and linked task snapshots (statusNow says where a task's status has moved on since): the Coordinator's, or a project Captain's when you pass project.",
      inputSchema: {
        compaction: z.string().describe("Compaction id, e.g. 2026-10-22T18-40-05Z"),
        project: z.string().optional().describe(scopeId ? "Leave out: your own project." : "Project id or name, for one of that project's Captain compactions."),
      },
    },
    safe(async (a: { compaction: string; project?: string }) => {
      const projectId = projectFilter(a.project)
      if (!projectId) {
        const c = store.getOrchestratorCompaction(a.compaction, true)
        if (!c) throw new Error(`No Coordinator compaction "${a.compaction}". Use list_compactions, and pass project for a Captain compaction.`)
        return ok(compactionView(c))
      }
      unsealed(projectId, "its Captain's compactions are its content")
      if (!deps.captains) return fail(noCaptains)
      const c = deps.captains.compactionRecord(projectId, a.compaction)
      if (!c) throw new Error(`No Captain compaction "${a.compaction}" in this project. Use list_compactions.`)
      return ok({ ...compactionView(c), captain: projectId })
    }),
  )

  server.registerTool(
    "find_compactions_by_task",
    {
      description: scopeId
        ? "Find your Captain compactions linked to a task and that task's own /compact summaries. Use this before resuming older work or writing a PR description that needs historical context."
        : "Find Coordinator compactions and the task's project Captain compactions linked to a task, and that task's own /compact summaries. Use this before resuming older work or writing a PR description that needs historical context.",
      inputSchema: { task: z.string(), limit: z.number().int().min(1).max(50).optional().describe("Default 10 of each") },
    },
    safe(async (a: { task: string; limit?: number }) => {
      const t = task(a.task)
      const limit = a.limit ?? 10
      if (statusOnly(t.projectId)) {
        return okCompact({ task: brief(t), orchestratorCompactions: store.listOrchestratorCompactions({ taskId: t.id, limit }).map(compactionDigest), statusOnly: STATUS_ONLY_PROJECT })
      }
      return okCompact({
        task: brief(t),
        // Coordinator compactions span every project, so Captains only get their own and the task's.
        orchestratorCompactions: scopeId ? undefined : store.listOrchestratorCompactions({ taskId: t.id, limit }).map(compactionDigest),
        // task() keeps a Captain inside its own project, so this is never another project's Captain.
        captainCompactions: captainCompactions(t.projectId, { taskId: t.id, limit }) ?? undefined,
        taskCompactions: store
          .listTaskCompactions({ taskId: t.id, limit })
          .map((c) => ({ ...c, at: new Date(c.at).toISOString(), summary: preview(c.summary, 3000, "the task page has the full summary") })),
      })
    }),
  )

  const hitView = (h: HistoryHit) => {
    const projectName = h.projectId ? (store.getProject(h.projectId)?.name ?? h.projectId) : undefined
    const open =
      h.kind === "coordinator_summary"
        ? `read_compaction {"compaction":"${h.id}"}`
        : h.kind === "captain_summary"
          ? `read_compaction {"compaction":"${h.id}"${scopeId ? "" : `,"project":"${projectName}"`}}`
          : h.kind === "coordinator_chat" || h.kind === "captain_chat"
            ? `search_history {"around":"${h.id}"}`
            : h.kind === "task_summary"
              ? `find_compactions_by_task {"task":"${h.taskIds?.[0]}"}`
              : `get_task {"task":"${h.taskIds?.[0] ?? h.id}"}`
    return {
      kind: h.kind,
      at: new Date(h.at).toISOString(),
      id: h.id,
      project: scopeId ? undefined : projectName,
      file: h.file,
      where: h.where,
      tasks: h.taskIds?.length ? h.taskIds : undefined,
      snippet: h.snippet,
      open,
    }
  }

  server.registerTool(
    "search_history",
    {
      description:
        (scopeId
          ? "Search your project's history by keywords: your compaction summaries, your chat with Cody, and the project's tasks (titles, prompts, replies, questions, errors, PRs, and their /compact summaries). "
          : "Search Box Yard's history by keywords: your compaction summaries and every Captain's, your chat with Cody and the Captains' chats, and all tasks (titles, prompts, replies, questions, errors, PRs, and their /compact summaries). ") +
        "Use it when Cody refers to something from before your last compaction, or you need an old decision, id or link. Returns short snippets, newest first, with dates, task ids, and how to open each hit. " +
        "Every word must match (case-insensitive); quote a phrase to match it exactly. Pass around = a chat hit's id to read that message in full with the messages around it.",
      inputSchema: {
        query: z.string().max(300).optional().describe('Keywords, e.g. local runner brief, or "auto-merge" label'),
        project: z
          .string()
          .optional()
          .describe(scopeId ? "Leave out: your own project." : "Project id or name: only that project's Captain history and tasks (your own summaries and chat are left out)."),
        sources: z
          .array(z.enum(HISTORY_SOURCES))
          .optional()
          .describe(
            `Where to look. Default: summaries, chat and tasks. transcripts adds agents' task transcripts (the newest ${TRANSCRIPT_SCAN_ROWS.toLocaleString("en-US")} lines; slower).`,
          ),
        since: z.string().optional().describe("ISO date or time: only history from then on"),
        until: z.string().optional().describe("ISO date or time: only history up to then"),
        limit: z.number().int().min(1).max(30).optional().describe("Default 10"),
        around: z.string().optional().describe("A chat message id from a hit: returns it in full with up to 3 messages before and after, instead of searching"),
      },
    },
    safe(async (a: { query?: string; project?: string; sources?: HistorySource[]; since?: string; until?: string; limit?: number; around?: string }) => {
      const projectId = projectFilter(a.project)
      unsealed(projectId, "its history is its content")
      const scope = { projectId, coordinator: !scopeId, statusOnly }
      if (a.around) {
        const thread = chatAround(store, a.around.trim(), scope)
        if (!thread) throw new Error(`No chat message "${a.around}"${scopeId ? " in this project's Captain chat" : ""}. Pass the id of a chat hit.`)
        return okCompact({ ...thread, projectId: undefined, project: thread.projectId && !scopeId ? store.getProject(thread.projectId)?.name : undefined, messages: thread.messages.map((m) => ({ ...m, at: new Date(m.at).toISOString() })) })
      }
      const terms = parseTerms(a.query ?? "")
      if (!terms.length) throw new Error("Pass query (keywords), or around (a chat message id).")
      const time = (v: string | undefined, name: string) => {
        if (!v) return undefined
        const t = Date.parse(v)
        if (!Number.isFinite(t)) throw new Error(`${name} "${v}" is not an ISO date or time.`)
        return t
      }
      const limit = a.limit ?? 10
      const { hits, perSource } = searchHistory(
        {
          store,
          coordinatorCompactionsDir: scopeId ? undefined : deps.coordinatorCompactionsDir,
          captainCompactions: deps.captains ? (id) => deps.captains!.compactionRecords(id) : undefined,
        },
        scope,
        { terms, sources: a.sources?.length ? a.sources : DEFAULT_HISTORY_SOURCES, since: time(a.since, "since"), until: time(a.until, "until"), limit },
      )
      const found = Object.values(perSource).reduce((n, x) => n + (x ?? 0), 0)
      return okCompact({
        terms,
        hits: hits.map(hitView),
        more: found > hits.length ? `At least ${found - hits.length} more matched (per source: ${JSON.stringify(perSource)}). Narrow with sources, since/until or more words.` : undefined,
        none: hits.length ? undefined : "Nothing matched every word. Try fewer or different words, or sources including transcripts.",
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
      await refreshPrs([task(a.task)])
      const t = task(a.task)
      if (statusOnly(t.projectId)) return ok({ ...brief(t), branch: t.branch, coordinatorSees: STATUS_ONLY_PROJECT })
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
        "Start a NEW agent (a fresh Claude Code or Codex session, see agent) on a task in a project. It gets its own folder on the project's worker box (repo cloned if the project has one). " +
        "Use this for new, independent work. For follow-ups on work an agent already did, use send_to_task instead so it keeps its context. Write a self-contained prompt. If Cody attached files (a screenshot of a bug, a spec) that the agent needs, pass them in attachments.",
      inputSchema: {
        project: z.string().describe("Project id or name"),
        title: z.string().min(1).max(120),
        prompt: z.string().min(1),
        env: envSchema,
        related_tasks: relatedTasksSchema,
        attachments: attachmentsSchema,
        runs_on: runsOnSchema,
        agent: agentSchema,
        icon: iconSchema,
        priority: prioritySchema.describe(`"high" or "normal" (the default). ${PRIORITY_HELP}`),
        ...routeParams,
      },
    },
    safe(async (a: { project: string; title: string; prompt: string; env?: Record<string, string>; related_tasks?: string[]; attachments?: string[]; runs_on?: Runner; agent?: AgentCli; icon?: TaskIconName; priority?: TaskPriority; model?: string; effort?: Effort; routing_rule?: string; routing_reason?: string }) => {
      const projectId = project(a.project).id
      const prompt = a.related_tasks?.length ? `${a.prompt}\n\n${relatedWork(a.related_tasks, projectId)}` : a.prompt
      await tasks.requireRunner(a.runs_on, projectId, a.env, { agentCli: a.agent, model: a.model })
      const t = tasks.createTask({
        projectId,
        title: a.title,
        prompt,
        env: a.env,
        attachments: attachmentsOf(a.attachments),
        model: a.model ?? null,
        effort: a.effort ?? null,
        routingRule: a.routing_rule ?? null,
        routingReason: a.routing_reason ?? null,
        source: inputSource,
        runsOn: a.runs_on ?? null,
        agentCli: a.agent ?? null,
        icon: a.icon ?? null,
        priority: a.priority ?? null,
      })
      return ok({ ...brief(t), next: "The agent starts as soon as a box slot is free. Use wait_for_tasks to wait for its result if the work is quick." })
    }),
  )

  const batchItem = z.object({
    title: z.string().min(1).max(120),
    prompt: z.string().min(1).describe("This task's own instructions. common_prompt, when given, goes before it."),
    attachments: z.array(z.string()).optional().describe("Files for this task only, added to the shared attachments (up_… or art_… ids or paths, as in create_task)"),
    related_tasks: z.array(z.string()).optional().describe("Earlier tasks for this task only, added to the shared related_tasks"),
    env: envSchema,
    runs_on: runsOnSchema.describe('Where this task runs: "local" (this computer), "box" (an Upstash box), "gpu" (the project\'s RunPod GPU pod) or "docker" (the project\'s Docker container on this computer), over the shared runs_on and the project\'s "Runs on"'),
    agent: agentSchema.describe('"claude" or "codex" for this task, over the shared agent and the project\'s Agent'),
    icon: iconSchema,
    priority: prioritySchema.describe('"high" or "normal" for this task, over the shared priority. See create_task.'),
    ...routeParams,
  })
  type BatchItem = z.infer<typeof batchItem>

  server.registerTool(
    "create_tasks",
    {
      description:
        `Start MANY new agents in one call (fan-out): 1 to ${MAX_TASK_BATCH} tasks in one project, each a fresh agent session exactly like create_task. ` +
        "Use it instead of a series of create_task calls whenever you start two or more independent tasks at once: every create_task call costs you a whole step, so dozens of them take minutes before the last task even exists, while create_tasks queues them all at once and Box Yard creates the boxes they need in parallel. " +
        "Write what the tasks share once, in common_prompt (it goes before each task's own prompt). attachments, related_tasks, env, runs_on, agent, priority, model, effort and routing_* at the top apply to every task; an item's own attachments, related_tasks and env are added to them, and its own runs_on, agent, priority, model, effort and routing_* win. " +
        "All or nothing: every item is checked before anything is created (project scope, a non-empty title and prompt, titles unique within the call, attachment and related-task ids, and that a runs_on runner can run). If any item is invalid, NO task is created and the error lists every problem by item number (#1 is the first), so fix those and call create_tasks again with the whole list. " +
        "Returns the new tasks' ids in the order given.",
      inputSchema: {
        project: z.string().describe("Project id or name. Every task in the call goes there."),
        tasks: z.array(batchItem).min(1).max(MAX_TASK_BATCH).describe(`The tasks to start, 1 to ${MAX_TASK_BATCH}, each with its own title and prompt`),
        common_prompt: z
          .string()
          .optional()
          .describe("The brief every task shares (goal, constraints, what done means, what to report back). It goes before each task's own prompt, so you write it once."),
        attachments: attachmentsSchema.describe("Files every task gets: ids (up_…) or paths of files Cody attached in this chat, or artifact ids (art_…) or /artifacts/ URLs. Each is copied into every agent's task folder under attachments/."),
        related_tasks: relatedTasksSchema.describe("Earlier tasks whose outcome every new agent should know about (their summary, branch and PR are added to each prompt)"),
        env: envSchema.describe("Env vars for every task, as NAME: value; an item's own env wins for the same name"),
        runs_on: runsOnSchema.describe(
          'Where every task runs (an item\'s own runs_on wins): "local" = this computer, "box" = an Upstash box, "gpu" = the project\'s RunPod GPU pod, "docker" = the project\'s isolated Docker container on this computer, over the project\'s "Runs on", for every later turn too. Omit it to follow the project. Pass "local" when Cody says to do it "locally", "on my machine" or "on this computer".',
        ),
        agent: agentSchema.describe('The agent CLI every task runs on, "claude" or "codex" (an item\'s own agent wins). Omit it to follow the project\'s Agent.'),
        model: modelSchema.describe("Model for every task (an item's own model wins). Omit it to use the project route, Settings or routing defaults."),
        effort: effortSchema.describe("Reasoning effort for every task (an item's own effort wins). Omit it to use the project route, Settings or routing defaults; see create_task for the levels."),
        priority: prioritySchema.describe(`"high" or "normal" (the default) for every task (an item's own priority wins). ${PRIORITY_HELP}`),
        routing_rule: routingRuleSchema,
        routing_reason: routingReasonSchema,
      },
    },
    safe(
      async (a: {
        project: string
        tasks: BatchItem[]
        common_prompt?: string
        attachments?: string[]
        related_tasks?: string[]
        env?: Record<string, string>
        runs_on?: Runner
        agent?: AgentCli
        priority?: TaskPriority
        model?: string
        effort?: Effort
        routing_rule?: string
        routing_reason?: string
      }) => {
        const p = project(a.project)
        // Check everything before creating anything, and report every problem at once.
        const problems: string[] = []
        const check = (where: string, fn: () => unknown) => {
          try {
            fn()
          } catch (err) {
            problems.push(`${where}: ${errorMessage(err)}`)
          }
        }
        for (const ref of new Set(a.attachments ?? [])) check(`attachments "${ref}"`, () => attachmentSource(ref))
        for (const ref of new Set(a.related_tasks ?? [])) check(`related_tasks "${ref}"`, () => task(ref))
        const titles = new Map<string, number>()
        a.tasks.forEach((item, i) => {
          const where = `#${i + 1} "${clip(item.title.trim(), 60)}"`
          if (!item.title.trim()) problems.push(`#${i + 1}: title is empty`)
          if (!item.prompt.trim()) problems.push(`${where}: prompt is empty`)
          const key = item.title.trim().toLowerCase()
          const first = titles.get(key)
          if (key && first !== undefined) problems.push(`${where}: same title as #${first + 1}; titles must be unique within the call`)
          else titles.set(key, i)
          for (const ref of new Set(item.attachments ?? [])) if (!a.attachments?.includes(ref)) check(`${where} attachments "${ref}"`, () => attachmentSource(ref))
          for (const ref of new Set(item.related_tasks ?? [])) if (!a.related_tasks?.includes(ref)) check(`${where} related_tasks "${ref}"`, () => task(ref))
        })
        // Each runner asked for is checked once per Claude login (an item's env can bring its own); every item that wants one that can't run is listed.
        const runners = new Map<string, Promise<string | null>>()
        const why = await Promise.all(
          a.tasks.map((item) => {
            const r = item.runs_on ?? a.runs_on
            if (!r) return null
            const env = { ...a.env, ...item.env }
            const agent = { agentCli: item.agent ?? a.agent, model: item.model ?? a.model }
            const key = `${r} ${tasks.turnCredentials(p.id, env).claudeFrom} ${tasks.codexCredentials(p.id, env).kind} ${agent.agentCli ?? ""} ${agent.model ?? ""}`
            if (!runners.has(key)) runners.set(key, tasks.requireRunner(r, p.id, env, agent).then(() => null, (err: unknown) => errorMessage(err)))
            return runners.get(key)!
          }),
        )
        a.tasks.forEach((item, i) => {
          if (why[i]) problems.push(`#${i + 1} "${clip(item.title.trim(), 60)}": runs_on "${item.runs_on ?? a.runs_on}": ${why[i]}`)
        })
        if (problems.length) {
          const shown = problems.slice(0, 25)
          throw new Error(
            `No task was created: ${problems.length === 1 ? "one problem" : `${problems.length} problems`}. Fix ${problems.length === 1 ? "it" : "them"} and call create_tasks again with the whole list.\n` +
              shown.map((x) => `- ${x}`).join("\n") +
              (problems.length > shown.length ? `\n- …and ${problems.length - shown.length} more` : ""),
          )
        }
        const common = a.common_prompt?.trim()
        const copies = new Map<string, StoredUpload>()
        // Files first (an artifact is copied once for the whole batch): if one can't be copied, no task exists yet.
        const inputs = a.tasks.map((item) => {
          const related = [...new Set([...(a.related_tasks ?? []), ...(item.related_tasks ?? [])])]
          const prompt = [common, item.prompt, related.length ? relatedWork(related, p.id) : ""].filter(Boolean).join("\n\n")
          const env = a.env || item.env ? { ...a.env, ...item.env } : undefined
          return {
            projectId: p.id,
            title: item.title,
            prompt,
            env,
            attachments: attachmentsOf([...(a.attachments ?? []), ...(item.attachments ?? [])], copies),
            model: item.model ?? a.model ?? null,
            effort: item.effort ?? a.effort ?? null,
            routingRule: item.routing_rule ?? a.routing_rule ?? null,
            routingReason: item.routing_reason ?? a.routing_reason ?? null,
            source: inputSource,
            runsOn: item.runs_on ?? a.runs_on ?? null,
            agentCli: item.agent ?? a.agent ?? null,
            icon: item.icon ?? null,
            priority: item.priority ?? a.priority ?? null,
          }
        })
        const created = tasks.createTasks(inputs)
        return okCompact({
          project: p.name,
          created: created.length,
          tasks: created.map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.priority === "high" ? { priority: t.priority } : {}) })),
          next: "Every task is queued. Each agent starts as soon as a box slot is free, and Box Yard creates the boxes they need in parallel. Follow them with list_tasks, or wait_for_tasks when the work is quick.",
        })
      },
    ),
  )

  server.registerTool(
    "send_to_task",
    {
      description:
        "Send a message to an existing task's agent: an answer, feedback, a correction, or follow-up work on the same topic. It continues the SAME Claude session, so the agent remembers everything it did. " +
        "Optionally set model/effort/routing_* for this follow-up; they apply from the agent's next turn on, so a cheap task can be escalated when it struggles. " +
        "If the agent is idle or done, its session resumes right away (restored from the archive if needed). If its archive has expired, a new session starts from a recap (summary, branch, PR, recent messages) on a fresh checkout of its branch; the delivery field says which. If it is mid-turn, the message is queued and delivered as soon as the current turn ends; pass interrupt: true to deliver it now instead (see interrupt). If the task shows mergeRequested, Cody already asked it to merge that PR with the Merge PR button: don't send merge instructions of your own until that settles. To pass along files Cody attached (a screenshot, a document), use attachments. " +
        'To continue an existing task somewhere else (Cody: "continue it locally", "on my machine"), pass runs_on: it pins the task to that runner from its next turn on. Before its next turn (after any running turn ends) its workspace moves there when nothing would be lost: its turn-end archive and push hold all the work. If it can\'t move safely (no fresh archive, the archive is too big, or the push failed), it keeps running where its workspace is and the task\'s log says why. A runner that can\'t run fails the call with the reason, and nothing is sent.',
      inputSchema: {
        task: z.string(),
        message: z.string().min(1),
        attachments: attachmentsSchema,
        runs_on: z
          .enum(RUNNERS)
          .optional()
          .describe('Pin the task to "local" (this computer), "box" (an Upstash box), "gpu" (the project\'s RunPod GPU pod) or "docker" (the project\'s Docker container on this computer) from its next turn on, over the project\'s "Runs on". Omit it to leave it where it runs.'),
        interrupt: z.boolean().optional().describe(SEND_NOW_DESCRIPTION),
        allow_merge_interrupt: z.boolean().optional().describe(ALLOW_MERGE_INTERRUPT_DESCRIPTION),
        priority: prioritySchema.describe(
          `"high" or "normal". When the task rests and has to wait for a slot, a high follow-up goes before every normal task waiting. Omit it to keep the task's priority (normal unless raised). ${PRIORITY_HELP}`,
        ),
        ...routeParams,
      },
    },
    safe(async (a: { task: string; message: string; attachments?: string[]; runs_on?: Runner; interrupt?: boolean; allow_merge_interrupt?: boolean; priority?: TaskPriority; model?: string; effort?: Effort; routing_rule?: string; routing_reason?: string }) => {
      const before = task(a.task)
      // Refused before anything is sent, so a refusal leaves no message behind.
      const risk = a.interrupt && !a.allow_merge_interrupt ? tasks.mergeInterruptRisk(store.getTaskRow(before.id)!) : null
      if (risk) return fail(`${risk} Nothing was sent. Send it without interrupt (it goes out when the turn ends), or pass allow_merge_interrupt: true if it can't wait.`)
      await tasks.requireRunner(a.runs_on, before.projectId, store.taskEnv(before.id), { agentCli: before.agentCli })
      if (a.runs_on) tasks.setRunsOn(before.id, a.runs_on)
      // Before the message: queuing it runs the scheduler, which must already see the new priority.
      if (a.priority) tasks.setTaskPriority(before.id, a.priority, prioritySetter)
      const how = delivery(before)
      const { task: t, inputId } = tasks.send(before.id, a.message, inputSource, attachmentsOf(a.attachments), {
        model: a.model,
        effort: a.effort,
        routingRule: a.routing_rule,
        routingReason: a.routing_reason,
      })
      if (a.interrupt) {
        const now = await tasks.sendQueuedNow(t.id, { by: scopeId ? "captain" : "coordinator", allowMergeInterrupt: a.allow_merge_interrupt })
        return ok({ ...brief(now.task), delivery: now.delivery === "interrupted" ? sendNowDelivery(now) : how })
      }
      // Until a turn takes it, the message can still be changed or withdrawn by this id.
      const queued = store.getQueuedInput(t.id, inputId) ? inputId : undefined
      return ok({ ...brief(t), delivery: how, queuedMessageId: queued })
    }),
  )

  const queuedView = (m: QueuedMessage) => ({
    id: m.id,
    from: m.sender,
    text: preview(m.text, 2000, "the rest is in the task page's queue"),
    attachments: m.attachments.length ? m.attachments.map((f) => f.name) : undefined,
    status: m.status === "delivering" ? "delivering: a turn is starting with it, it can't be changed any more" : "queued",
    version: m.version,
    queued: ago(m.createdAt),
  })

  server.registerTool(
    "list_queued_messages",
    {
      description:
        "List the messages queued for a task's next turn (sent with send_to_task, by Cody, a Captain, a hook or another agent while it was busy), oldest first. Use it before cancel_queued_message or edit_queued_message, or to check what an agent will get when its turn ends.",
      inputSchema: { task: z.string() },
    },
    safe(async (a: { task: string }) => {
      const t = task(a.task)
      unsealed(t.projectId, "its queued messages are its content (cancel_queued_message and deliver_queued_now still work)")
      const list = tasks.listQueue(t.id)
      return ok({ task: t.id, title: t.title, status: t.status, messages: list.map(queuedView) })
    }),
  )

  server.registerTool(
    "deliver_queued_now",
    {
      description:
        "Send now: deliver the messages queued for a task's next turn without waiting for its current turn to end. It stops the current step the way stop_task does (the workspace, session and queue are kept), then the next turn resumes the session with every queued message, in send order. " +
        "Use it when a queued message changes or cancels what the agent is doing and waiting for the turn to end would waste work. If no turn is running, the messages simply go out with the next turn. " +
        ALLOW_MERGE_INTERRUPT_DESCRIPTION,
      inputSchema: { task: z.string(), allow_merge_interrupt: z.boolean().optional().describe(ALLOW_MERGE_INTERRUPT_DESCRIPTION) },
    },
    safe(async (a: { task: string; allow_merge_interrupt?: boolean }) => {
      const t = task(a.task)
      const now = await tasks.sendQueuedNow(t.id, { by: scopeId ? "captain" : "coordinator", allowMergeInterrupt: a.allow_merge_interrupt })
      return ok({ ...brief(now.task), queuedMessages: now.queued, delivery: sendNowDelivery(now) })
    }),
  )

  server.registerTool(
    "cancel_queued_message",
    {
      description:
        "Withdraw a message queued for a task's next turn, before the agent gets it (ids from list_queued_messages or send_to_task's queuedMessageId). Fails with \"already delivered\" once a turn has taken it: then send a correction with send_to_task instead. If it was the only message, the agent isn't woken for it.",
      inputSchema: { task: z.string(), message_id: z.string() },
    },
    safe(async (a: { task: string; message_id: string }) => {
      const t = task(a.task)
      const m = tasks.cancelQueued(t.id, a.message_id)
      return ok({ cancelled: m.id, from: m.sender, remaining: tasks.listQueue(t.id).length })
    }),
  )

  server.registerTool(
    "edit_queued_message",
    {
      description:
        "Replace the text of a message queued for a task's next turn, before the agent gets it. Fails with \"already delivered\" once a turn has taken it. Pass version (from list_queued_messages) to refuse the edit if someone changed the message meanwhile.",
      inputSchema: {
        task: z.string(),
        message_id: z.string(),
        message: z.string().min(1).describe("The new text; it replaces the old text entirely"),
        version: z.number().int().positive().optional(),
      },
    },
    safe(async (a: { task: string; message_id: string; message: string; version?: number }) => {
      const t = task(a.task)
      unsealed(t.projectId, "its queued messages are its content")
      return ok(queuedView(tasks.editQueued(t.id, a.message_id, a.message, a.version)))
    }),
  )

  captainOnly(
    server.registerTool(
      "reply_to_agent",
      {
        description:
          'Captain tool: answer an agent in this project that messaged you with message_captain (labelled "From task "<title>" (task_…)"). ' +
          "If the agent is still waiting mid-turn, it gets the reply right away in its current turn; otherwise the reply is queued and arrives as its next message, like send_to_task (which also reaches a waiting agent). " +
          "Keep it short and actionable. The delivery field says which happened.",
        inputSchema: {
          task: z.string().describe("The task id from the message label (task_…)."),
          message: z.string().min(1).describe("Your answer to the agent."),
        },
      },
      safe(async (a: { task: string; message: string }) => {
        const before = task(a.task)
        const how = delivery(before)
        const t = tasks.sendInput(before.id, a.message, inputSource)
        return ok({ ...brief(t), delivery: how })
      }),
    ),
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
    "set_task_priority",
    {
      description:
        "Raise or lower an existing task's priority without sending it a message, e.g. move a task that is already queued to the front of the queue. " +
        PRIORITY_HELP +
        " pool_status's queued list shows the queue in order, high first.",
      inputSchema: { task: z.string(), priority: z.enum(TASK_PRIORITIES).describe('"high" (front of the queue) or "normal"') },
    },
    safe(async (a: { task: string; priority: TaskPriority }) => {
      const t = tasks.setTaskPriority(task(a.task).id, a.priority, prioritySetter)
      return ok({ ...brief(t), next: t.status === "queued" ? "pool_status's queued list shows where it is in the queue." : "It applies the next time the task waits for a slot." })
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
    safe(async (a: { task: string; port: number }) => {
      const t = task(a.task)
      unsealed(t.projectId, "its previews show its work")
      return ok(await tasks.previewUrl(t.id, a.port))
    }),
  )

  server.registerTool(
    "list_inbox",
    {
      description:
        "Tasks waiting on Cody (questions) or ready for review (PRs), and failures. Quiet schedule runs (no-ops) never show here. PR states are checked with GitHub just before (prCheckedAt); one marked prUnverified may already be merged.",
    },
    safe(async () => {
      const inbox = () => withoutQuiet(store.listTasks({ projectId: scopeId ?? undefined, status: ["needs_input", "pr_ready", "failed"] }))
      // A PR merged outside Box Yard leaves the inbox here (its task moves to done) instead of being reported as waiting.
      await refreshPrs(inbox())
      return ok(inbox().map(brief))
    }),
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
      unsealed(p.id, "its notes are its content")
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
      unsealed(p.id, "its note suggestions are its content")
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
    safe(async (a: { project?: string; task?: string }) => {
      const t = a.task ? task(a.task) : null
      const projectId = projectFilter(a.project)
      unsealed(projectId ?? t?.projectId, "its artifacts are its content")
      return ok(
        store
          .listArtifacts({ projectId, taskId: t?.id })
          .filter((x) => !statusOnly(x.projectId ?? (x.taskId ? store.getTask(x.taskId)?.projectId : null)))
          .map((x) => ({ id: x.id, title: x.title, url: absolute(x.url), size: x.size, task: x.taskId })),
      )
    }),
  )

  server.registerTool(
    "read_artifact",
    {
      description:
        "Read a hosted artifact (a report, brief, page or image an agent or you published) by id or URL. Text comes back in pages of up to 50k characters; small images come back as an image. " +
        "To hand an artifact to an agent instead, pass its id in create_task or send_to_task attachments.",
      inputSchema: {
        artifact: z.string().describe("Artifact id (art_…) or its /artifacts/ URL"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from, for the next page of a long text"),
        max_chars: z.number().int().min(1000).max(ARTIFACT_TEXT_MAX).optional().describe(`Default ${ARTIFACT_TEXT_DEFAULT}`),
      },
    },
    safe(async (a: { artifact: string; offset?: number; max_chars?: number }) => {
      const art = artifactRef(a.artifact)
      const file = store.artifactPath(art.id)
      if (!file || !fs.existsSync(file)) throw new Error(`Artifact ${art.id} ("${art.title}") has no file on this server any more.`)
      const info = {
        id: art.id,
        title: art.title,
        filename: art.filename,
        mime: art.mime,
        size: art.size,
        project: art.projectId ? (store.getProject(art.projectId)?.name ?? art.projectId) : undefined,
        task: art.taskId ?? undefined,
        created: new Date(art.createdAt).toISOString(),
        url: absolute(art.url),
      }
      const data = fs.readFileSync(file)
      if (IMAGE_MIME.test(art.mime)) {
        if (data.length > ARTIFACT_IMAGE_MAX_BYTES) return ok({ ...info, note: `The image is over ${ARTIFACT_IMAGE_MAX_BYTES / 1024 / 1024} MB, so it isn't returned. Attach it to a task to have an agent look at it.` })
        return { content: [{ type: "text", text: JSON.stringify(info) }, { type: "image", data: data.toString("base64"), mimeType: art.mime }] }
      }
      // Text by type, or by content for an unknown type (no NUL bytes, valid UTF-8).
      const head = data.subarray(0, 8192)
      const looksText = TEXT_MIME.test(art.mime) || (art.mime === "application/octet-stream" && !head.includes(0) && !data.toString("utf8").includes("\uFFFD"))
      if (!looksText) return ok({ ...info, note: "Not a text file, so its content isn't returned. Attach it to a task (attachments) to have an agent open it." })
      const text = data.toString("utf8")
      const offset = Math.min(a.offset ?? 0, text.length)
      const max = a.max_chars ?? ARTIFACT_TEXT_DEFAULT
      const end = Math.min(text.length, offset + max)
      // The text goes in a block of its own, unescaped.
      const meta = { ...info, totalChars: text.length, offset, more: end < text.length ? `${text.length - end} more chars: call again with offset ${end}` : undefined }
      return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "text", text: text.slice(offset, end) }] }
    }),
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

  const gpuPools = async () => {
    const gpu = (scopeId ? [ownProject()] : store.listProjects()).filter((p) => p.runner === "gpu")
    if (!gpu.length) return {}
    const views = await Promise.all(gpu.map(async (p) => [p.name, await tasks.projectGpuSettings(p, true)] as const))
    return { gpu_projects: Object.fromEntries(views.filter(([, v]) => v)) }
  }
  const dockerPools = async () => {
    const docker = (scopeId ? [ownProject()] : store.listProjects()).filter((p) => p.runner === "docker")
    if (!docker.length) return {}
    // A fresh look at the containers (Docker answers fast; a stopped Docker leaves the last list).
    await tasks.refreshDockerContainers()
    const views = docker.map((p) => [p.name, tasks.projectDockerSettings(p)] as const)
    return { docker_projects: Object.fromEntries(views.filter(([, v]) => v)) }
  }

  server.registerTool(
    "pool_status",
    {
      description:
        "Show worker boxes (which projects live on each; running = tasks running/tasks running at once on that box) and queued tasks, numbered in the order the scheduler pulls them (high priority first, marked [high priority]; then first in, first out). pool.agentsPerBox (tasks running at once per box) and pool.tasksPerBox (task folders kept per box) give the limit for each box size; pool.overridden says when Settings or an env var replaces the size defaults for every box, and pool.projects lists projects with their own box settings (agentsPerBox caps only that project's own tasks running at once on a box; wholeMachine keeps other projects' tasks off its box while it runs). gpu_projects lists RunPod GPU projects' pods, spend and $/hr caps; a queued task says when a cap holds it. docker_projects lists Docker projects' containers (one per project, on this computer), images and limits. The computer running Box Yard itself isn't here: machine_stats shows its memory and load. Box Yard places tasks itself: a project's tasks share its box, a new project gets its own box while the pool has room.",
    },
    safe(async () => {
      // Drop boxes deleted outside Box Yard first (throttled), without waiting long on a slow provider.
      await Promise.race([tasks.reconcileBoxes(), new Promise((r) => setTimeout(r, 5_000).unref?.())])
      return ok({
        boxes: tasks.boxes().map((b) => ({
          id: b.id,
          status: b.status,
          size: `${b.size} (${sizeSpecLine(b.size)})`,
          projects: b.projects,
          running: `${b.runningTurns}/${b.slots}`,
          ...(b.projectLimit ? { limit: `${b.projectLimit.slots} while ${b.projectLimit.project} runs here (its Tasks running at once)` } : {}),
          tasks: b.residentTasks.length,
          disk: `${diskLine({ freeBytes: b.diskFreeBytes, totalBytes: b.diskTotalBytes, checkedAt: b.diskCheckedAt })}${b.diskLow ? " (low)" : ""}`,
          ...(b.unreachableSince ? { unreachable: `stopped answering ${ago(b.unreachableSince)}; disk and memory are from the last check that worked` } : {}),
          disk_mb:
            b.diskFreeBytes !== null && b.diskTotalBytes !== null
              ? { free: mb(b.diskFreeBytes), used: mb(Math.max(0, b.diskTotalBytes - b.diskFreeBytes)), total: mb(b.diskTotalBytes), measured: b.diskCheckedAt ? ago(b.diskCheckedAt) : null }
              : null,
          ...(b.memUsedBytes != null && b.memTotalBytes != null
            ? { memory: `${memLine({ usedBytes: b.memUsedBytes, totalBytes: b.memTotalBytes })}, ${loadLine({ load1: b.loadAvg ?? 0, cpus: b.cpuCount ?? 1 })}${b.memoryPressure ? " (busy: new tasks go elsewhere)" : ""}` }
            : {}),
          ...(rootDiskLine(b) ? { root_disk: `${rootDiskLine(b)}${rootLow({ freeBytes: b.rootFreeBytes ?? null, totalBytes: b.rootTotalBytes ?? null }) ? " (low)" : ""}` } : {}),
          ...(b.cleanup ? { cleanup: b.cleanup.status === "running" ? "running now" : `${cleanupSummary(b.cleanup)} ${ago(b.cleanup.finishedAt ?? b.cleanup.startedAt)}` } : {}),
          ...(b.operation ? { busy: b.operation } : {}),
          ...(b.resize && (b.resize.status === "running" || Date.now() - (b.resize.finishedAt ?? 0) < 24 * 3600_000)
            ? { resize: `${resizeTitle(b.resize)}: ${resizeSummary(b.resize)}${b.resize.finishedAt ? ` ${ago(b.resize.finishedAt)}` : ""}` }
            : {}),
        })),
        pool: {
          ...tasks.poolLimits(),
          // Projects that set their own box settings (a Captain sees only its own).
          projects: Object.fromEntries(
            (scopeId ? [ownProject()] : store.listProjects())
              .filter((p) => p.boxSize || tasks.autoBoxSize(p.id).size || p.agentsPerBox !== null || p.wholeMachine || p.tasksPerBox !== null || p.maxBoxes !== null)
              .map((p) => [p.name, tasks.projectBoxSettings(p)]),
          ),
        },
        resize_box: resizeGuard(),
        // What boxes cost today against Settings › Daily cloud limit: at the limit new boxes wait (running work goes on).
        cloud: cloudLine(tasks.cloudSpend()),
        new_boxes: owner(fanoutLine(tasks.boxFanout())),
        // RunPod GPU projects: their pods (each a box of its own, runpod-<project>[-<n>]), spend and $/hr caps.
        ...(await gpuPools()),
        // Docker projects: their one container each (docker-<project>), image and limits.
        ...(await dockerPools()),
        // In the order the scheduler pulls them: high priority first, then first in, first out.
        queued: store
          .listTasks({ projectId: scopeId ?? undefined, status: ["queued"] })
          .sort(byQueueOrder)
          .map((t, i) => {
            // The tasks holding it back, by id (a Captain only gets its own project's).
            const by = t.waitFor.filter((w) => !scopeId || store.getTaskRow(w.taskId)?.project_id === scopeId).map((w) => w.taskId)
            return `${i + 1}. ${t.priority === "high" ? "[high priority] " : ""}${t.id} ${t.title}${t.waitReason ? ` (${t.waitReason}${by.length ? `; held back by ${by.join(", ")}` : ""})` : ""}`
          }),
      })
    }),
  )

  const machine = deps.machine
  if (machine)
    server.registerTool(
      "machine_stats",
      {
        description:
          "This computer's resources (the one running Box Yard, where \"Runs on: This computer\" tasks and the Docker containers run; pool_status covers the Upstash boxes): memory used and free with the OS's memory pressure, swap and whether it's growing, the 1/5/15-minute load and CPU count, the heaviest processes by kind (claude, chrome, docker, node, other), local tasks running against the localAgents limit with what each one uses, and the last 15 minutes of samples (one a minute). " +
          "It reads the computer directly, so never start a task to measure it. " +
          "recommendation says whether there's room to raise localAgents (tasks running at once on this computer), when to hold, and when to lower it, with the value to set: a starting point that raises by at most 2 a step. " +
          (scopeId
            ? "Only the Coordinator changes localAgents; tell Cody when your project's local tasks are held back by it."
            : "To keep local concurrency in line with the machine on a schedule, make a Coordinator schedule (create_schedule without a project, e.g. every 10 minutes) whose prompt calls machine_stats, then update_settings { localAgents } within the min and max Cody gave, and says nothing when nothing changes."),
      },
      safe(async () => {
        const limits = tasks.poolLimits()
        return ok(await machine.report({ running: limits.localAgentsRunning, limit: limits.localAgents }))
      }),
    )

  coordinatorOnly(
    server.registerTool(
      "raise_cloud_limit",
      {
        description:
          "Raise today's cloud limit (Settings › Daily cloud limit) by one more day's worth, until local midnight, so boxes waiting on it are made now. " +
          "Use it when Cody asks to; pool_status's cloud line says where spend stands. To change the limit for good, use update_settings budget.dailyUsd.",
      },
      safe(async () => {
        const spend = tasks.raiseCloudLimit("coordinator")
        return ok({ raised: true, cloud: cloudLine(spend) })
      }),
    ),
  )

  coordinatorOnly(
    server.registerTool(
      "allow_more_boxes",
      {
        description:
          "Let Box Yard make more new boxes than the ones it makes in an hour without asking, for the next hour, so tasks waiting on that OK get boxes now (still under the daily cloud limit and the box ceiling). " +
          "Use it when Cody says yes to the New boxes question; pool_status's new_boxes line says how many wait and what they'd cost.",
      },
      safe(async () => ok({ allowed: true, new_boxes: owner(fanoutLine(tasks.allowMoreBoxes("coordinator"))) })),
    ),
  )

  // ---------------------------------------------------------------- global Settings
  // Coordinator only: Captains get neither tool, and update_settings refuses a Captain even if one reached it.
  const settingsTools = deps.settingsTools
  if (settingsTools) {
    coordinatorOnly(
      server.registerTool(
        "get_settings",
        {
          description:
            "Read Box Yard's global Settings, everything the Settings dialog shows (slotsPerBox = tasks running at once per box, maxAgents = max tasks running at once, localAgents = tasks running at once on this computer, maxResidentPerBox = task folders kept per box): each key with its current value, its default, the values or range it allows, where it comes from (ui = saved in Settings, env = from envVar, default) and whether you can change it with update_settings. " +
            "An env var only seeds a value: saving one here overrides it, as in the Settings UI. Rows with envLocked (group server) come only from env vars on the server. " +
            "API keys and tokens (group credentials, voice.*ApiKey) show only as set / not set.",
          inputSchema: { group: z.enum(SETTINGS_GROUPS).optional().describe("Only this group: settings (Coordinator, box agents, boxes & limits, usage), runpod, docker, voice, runner, credentials or server.") },
        },
        safe(async (a: { group?: SettingsGroup }) => okCompact({ settings: settingsTools.list(a.group) })),
      ),
    )
    coordinatorOnly(
      server.registerTool(
        "update_settings",
        {
          description:
            "Change global Settings for Cody, through the same checks and save path as the Settings UI (the pool re-reads its limits right away). " +
            'Pass a partial patch keyed like get_settings: { "slotsPerBox": 3, "maxBoxes": 20, "localAgents": 3, "agentModel": "claude-opus-5-5", "runpod.maxHourlyUsd": 2, "runner": "local" } (slotsPerBox is tasks running at once per box, localAgents tasks running at once on this computer, maxAgents max tasks running at once). ' +
            'An object setting takes only the fields that change ({ "budget": { "dailyUsd": 5 } }). ' +
            "The whole patch is checked first: an unknown key, an out-of-range value, a server env-only key or any API key or token fails the call and nothing changes. " +
            "Returns before → after for every value that changed (a new workerSize also moves the size-default box limits), and Cody gets a notice with your reason.",
          inputSchema: {
            patch: z.record(z.string(), z.unknown()).describe("Settings to change, by get_settings key."),
            reason: z.string().trim().min(3).max(500).describe('Why, in one line for Cody (e.g. "Cody asked for 3 tasks running at once per box").'),
          },
        },
        safe(async (a: { patch: Record<string, unknown>; reason: string }) => {
          if (scopeId) throw outOfScope("global Settings are changed only by the Coordinator")
          const changes = await settingsTools.update(a.patch)
          if (!changes.length) return ok({ changed: [], note: "Every value was already set that way; nothing was saved." })
          const line = changeLine(changes)
          console.log(`[box-yard] settings changed by the Coordinator: ${line} (reason: ${a.reason})`)
          tasks.notice(`⚙️ **Settings** changed by the Coordinator: ${line}. Reason: ${a.reason}`, { kind: "settings", changes, reason: a.reason }, { wake: false })
          return ok({ changed: changes, next: "Applies from the next turn on; the pool already uses new limits." })
        }),
      ),
    )
  }

  // ---------------------------------------------------------------- connectors (docs/connectors.md)
  // External MCP servers some sessions get. Read-only here: only Settings adds, signs in, scopes or removes one, so no
  // model can widen a connector's reach. The view has no value in it (a remote server shows its host only: some put a
  // key in the path), and the whole result is also run through the connectors' own secret values.
  const connectorStore = deps.connectors
  if (connectorStore) {
    const projectName = (id: string) => store.getProject(id)?.name ?? id
    const connectorView = (c: Connector) => {
      const yours = scopeId ? { captain: connectorStore.reaches(c, { kind: "captain", projectId: scopeId }), agents: RUNNERS.filter((runner) => connectorStore.reaches(c, { kind: "agent", projectId: scopeId, runner })) } : undefined
      return {
        name: c.name,
        label: c.label,
        tools: `mcp__${c.name}__*`,
        kind: c.kind,
        server: c.kind === "stdio" ? `command: ${(c.command ?? "").split("/").pop()}` : (() => {
          try {
            return new URL(c.url!).host
          } catch {
            return "?"
          }
        })(),
        auth: c.auth,
        enabled: c.enabled,
        status: c.status,
        ...(c.statusDetail ? { detail: c.statusDetail } : {}),
        ...(c.oauth ? { signedIn: c.oauth.signedInAt !== null && c.status !== "needs_auth", renewsItself: c.oauth.refreshable, signInHost: c.oauth.signInHost } : {}),
        secrets: c.secrets.map((x) => ({ name: x.name, fingerprint: x.fingerprint, ...(x.readable ? {} : { unreadable: true }) })),
        lastTest: c.lastTest && { at: new Date(c.lastTest.at).toISOString(), ok: c.lastTest.ok, tools: c.lastTest.tools.slice(0, 60).map((t) => t.name), ...(c.lastTest.error ? { error: c.lastTest.error } : {}) },
        ...(scopeId
          ? { yours, otherProjects: c.scope.projects ? c.scope.projects.filter((id) => id !== scopeId).length : "every project" }
          : { reaches: scopeLine(c.scope, projectName), ...(c.sealedSkipped.length ? { leftOut: `${c.sealedSkipped.map(projectName).join(", ")} (status only, and the Coordinator uses it)` } : {}) }),
      }
    }
    server.registerTool(
      "list_connectors",
      {
        description:
          "External MCP connectors Cody set up in Settings › Connectors (Gmail, Notion, Linear, …): each one's name (its tools are mcp__<name>__*), server host or command, how it signs in, status (connected; needs_auth: Cody signs in again in Settings › Connectors; error, with the detail; untested), its last test's tools, and " +
          (scopeId ? "whether you and your project's agents get it (yours). Only connectors that reach your project are listed. " : "who gets it. ") +
          "Never a token or key: secrets show as fingerprints. You can't add, change or sign in a connector: tell Cody what to do in Settings › Connectors.",
        inputSchema: {},
      },
      safe(async () => {
        const list = connectorStore
          .list()
          .filter((c) => !scopeId || connectorStore.reaches(c, { kind: "captain", projectId: scopeId }) || RUNNERS.some((runner) => connectorStore.reaches(c, { kind: "agent", projectId: scopeId, runner })))
        const text = JSON.stringify({ connectors: list.map(connectorView) })
        return { content: [{ type: "text", text: redactValues(text, connectorStore.secretValues()) }] }
      }),
    )
  }

  // ---------------------------------------------------------------- identities (docs/identities.md)
  // Which GitHub account, git author, signing key and Claude login each project's agents use. No value passes through
  // here: the tools take references (gh:<login>, file:~/.ssh/<key>, agent:<fingerprint>) that the server reads itself,
  // and return logins, emails, owners and fingerprints only. A Captain sees every identity (a name and a login aren't
  // another project's data) but only its own project in them, and changes only an identity no other project uses.
  const identities = deps.identities
  if (identities) {
    const detector = deps.identityDetector ?? new IdentityDetector()
    /** safe(), with any token or key shape taken out of the error: one may echo a path or name the model passed in. */
    const guarded = <A,>(fn: (args: A) => Promise<ToolResult> | ToolResult) =>
      safe(async (a: A) => {
        try {
          return await fn(a)
        } catch (err) {
          throw new Error(redact(errorMessage(err)))
        }
      })
    const identity = (ref: string): Identity => {
      const i = identities.find(ref)
      if (!i) throw new Error(`No identity "${ref}". Use list_identities.`)
      return i
    }
    /** A Captain's view: its own project only, and no check lines (they can name other projects' repos). */
    const identityView = (i: Identity) => {
      if (!scopeId) return i
      const yours = i.projectIds.includes(scopeId)
      return { ...i, yours, projectIds: yours ? [scopeId] : [], otherProjects: i.projectIds.filter((id) => id !== scopeId).length, lastCheck: i.lastCheck && { at: i.lastCheck.at, ok: i.lastCheck.ok } }
    }
    /** A Captain changes only an identity that no other project uses. */
    const mayChange = (i: Identity) => {
      if (!scopeId) return
      if (i.isDefault) throw outOfScope("the Default identity is every project's fallback, so only the Coordinator changes it")
      if (i.projectIds.some((id) => id !== scopeId)) throw outOfScope(`the ${i.name} identity is used by other projects too`)
    }
    /**
     * Only Cody lets the Coordinator see more of a project, in Settings › Identities or the project's settings. Through
     * these tools an identity can be set to show status only, but never back: a model can't undo the seal.
     */
    const keepSealed = (what: string) =>
      new Error(owner(`Only Cody can let the Coordinator see more: ${what}. Cody does that in Settings › Identities (Coordinator sees) or in the project's settings.`))
    const mayLoosen = (i: Identity, sees: CoordinatorSees | undefined) => {
      if (i.coordinatorSees === "status" && sees === "everything") throw keepSealed(`the ${i.name} identity shows the Coordinator its projects' status only`)
    }
    /** Give a project an identity: its runner has to fit, and no turn of it may be running (it'd switch accounts halfway). */
    const assignProject = (ref: string, identityId: string): string => {
      const p = project(ref)
      const from = identities.of(p.id)
      const to = identities.require(identityId)
      if (from.id !== to.id && from.coordinatorSees === "status" && to.coordinatorSees !== "status") {
        throw keepSealed(`${p.name} shows the Coordinator its status only (the ${from.name} identity), and the ${to.name} identity shows everything`)
      }
      const r = assignChecked(identities, store, p, identityId)
      if (r.changed) {
        const updated = store.getProject(p.id)
        if (updated) hub.broadcast({ type: "project", project: updated })
        tasks.schedule()
      }
      return r.line
    }
    /** detect_identities and import_detected_identity: a Captain maps its own project only. */
    const detect = async (online: boolean) =>
      detectFor(identities, detector, scopeId ? [ownProject()] : store.listProjects(), { online, scope: scopeId ?? "", defaultIsGh: deps.settings?.credentials.source("githubToken") === "gh" })
    const runnersInput = z.array(z.enum(RUNNERS)).min(1).nullable().optional().describe("Where its projects may run: box (Upstash), local (this computer), gpu (RunPod), docker. null: every runner.")
    const authorInput = z
      .object({ name: z.string(), email: z.string() })
      .nullable()
      .optional()
      .describe("The git author its commits get, e.g. {name: \"Ada Lovelace\", email: \"ada@acme.dev\"}. Use one of the account's verified emails, or GitHub won't link the commits to it. null: Settings' GIT_USER_NAME / GIT_USER_EMAIL.")
    const fieldsInput = {
      color: z.enum(IDENTITY_COLORS).optional(),
      owners: z.array(z.string()).optional().describe('GitHub owners (users and orgs) whose repos it\'s for, e.g. ["acme-corp"].'),
      author: authorInput,
      runners: runnersInput,
      coordinator_sees: z.enum(COORDINATOR_SEES).optional().describe(
          "everything (default), or status: the Coordinator gets only the status of its projects' tasks (title, state, PR), not their replies, questions, notes or artifacts; their Captains still see everything. You can set status, but only Cody sets it back to everything, in Settings › Identities.",
        ),
    }
    const refsInput = {
      github_token_ref: z.string().optional().describe("gh:<login>: the token gh keeps on this computer for that account (detect_identities lists them). The server reads it. Never pass a token itself: a pasted one goes in Settings › Identities."),
      token_owner: z.string().optional().describe("The owner (user or org) that token is for. Leave it out for every owner the identity serves."),
      signing_key_ref: z
        .string()
        .nullable()
        .optional()
        .describe("Its commit signing key: file:~/.ssh/<key> (a key file without a passphrase in ~/.ssh; Box Yard keeps an encrypted copy) or agent:<SHA256 fingerprint> (a key only this computer's SSH agent or 1Password holds, so its projects run only here). null removes it. Never pass a key itself."),
      signing_program: z.string().nullable().optional().describe("For an agent key, the program git signs with, as a full path (1Password: /Applications/1Password.app/Contents/MacOS/op-ssh-sign)."),
      require_signed: z.boolean().optional().describe("Stop a push when one of its commits isn't signed by the identity's key."),
    }
    type FieldsArgs = { color?: IdentityColor; owners?: string[]; author?: { name: string; email: string } | null; runners?: Runner[] | null; coordinator_sees?: CoordinatorSees }
    type RefsArgs = { github_token_ref?: string; token_owner?: string; signing_key_ref?: string | null; signing_program?: string | null; require_signed?: boolean }
    const fieldsOf = (a: FieldsArgs & { name?: string }) =>
      Object.fromEntries(Object.entries({ name: a.name, color: a.color, owners: a.owners, author: a.author, runners: a.runners, coordinatorSees: a.coordinator_sees }).filter(([, v]) => v !== undefined))
    const refsOf = (a: RefsArgs): IdentityRefs => ({ githubTokenRef: a.github_token_ref, tokenOwner: a.token_owner, signingKeyRef: a.signing_key_ref, signingProgram: a.signing_program, requireSigned: a.require_signed })

    server.registerTool(
      "list_identities",
      {
        description:
          "Every identity: the GitHub account (login) it acts as, the owners it serves, its git author (and whether that email is verified on the account), signing key fingerprint, Claude login kind, runners, what the Coordinator sees, the projects that use it and its last test. Never a token or key: those show as fingerprints. " +
          "Each project has exactly one identity; the Default identity is Settings › Credentials (env vars, saved values, gh's account)." +
          (scopeId ? " yours marks your project's; other projects that use one show only as a count." : ""),
        inputSchema: {},
      },
      guarded(async () => okCompact({ identities: identities.list().map(identityView), ...(scopeId ? { yours: identities.idOf(scopeId) } : {}) })),
    )

    server.registerTool(
      "detect_identities",
      {
        description:
          "Read this computer's GitHub and git setup and propose identities, with the evidence: the accounts gh is signed in to, the global git author, each includeIf block's author, signing key and repo owners, and ~/.ssh/config hosts for GitHub. " +
          "online (the default) also asks GitHub, with each account's own token, for its orgs, verified emails, SSH keys and push access to each project's repo, so projects map to the right account. " +
          (scopeId ? "It maps your project only. " : "It maps every project. ") +
          "Proposals name references (tokenRef gh:…, signing ref file:… or agent:…), never values. Changes nothing: propose a setup to Cody in one message, and import only after Cody says yes. " +
          "Use it when a clone, fetch or push fails with 401, 403 or 404, or when Cody asks about GitHub accounts.",
        inputSchema: { online: z.boolean().optional().describe("Ask GitHub too (default true). false reads this computer only.") },
      },
      guarded(async (a: { online?: boolean }) => {
        const d = await detect(a.online ?? true)
        return okCompact({
          ...d,
          next: owner(
            d.proposals.length
              ? "Nothing changed. Tell Cody in one message which identity each project should use and why (logins, owners, author, signing key), then call import_detected_identity for each one Cody agrees to."
              : "Nothing changed, and there's nothing to import: see notes.",
          ),
        })
      }),
    )

    server.registerTool(
      "import_detected_identity",
      {
        description:
          "Turn one of detect_identities' proposals into an identity, only after Cody agreed to it: the server reads the account's token from gh and the signing key by reference again, checks the token with GitHub, keeps both encrypted, and gives the identity the proposal's projects. " +
          "When Box Yard has an identity for that login already, it's updated instead. Override any of the proposal's choices with the other fields. A signing key detection warned about (it also logs this computer in to servers) is left out unless you name one. " +
          (scopeId ? "You can give it your own project only." : "projects: the projects to move (ids or names); the proposal's when left out."),
        inputSchema: {
          login: z.string().describe("The gh account of the proposal (its login)."),
          name: z.string().optional().describe("Its name in Box Yard (the login when left out)."),
          ...fieldsInput,
          signing_key_ref: refsInput.signing_key_ref,
          signing_program: refsInput.signing_program,
          require_signed: refsInput.require_signed,
          projects: z.array(z.string()).optional().describe(scopeId ? "Your project, or [] to move none." : "Projects to give it; [] moves none."),
        },
      },
      guarded(async (a: { login: string; name?: string; projects?: string[]; signing_key_ref?: string | null; signing_program?: string | null; require_signed?: boolean } & FieldsArgs) => {
        const detection = detector.recent(scopeId ?? "") ?? (await detect(true))
        const proposal = detection.proposals.find((p) => p.login.toLowerCase() === a.login.toLowerCase())
        // A Captain's default is its own project, whoever ran the detection.
        const projects = a.projects ?? (scopeId ? (proposal?.projects ?? []).filter((p) => p.id === scopeId).map((p) => p.id) : undefined)
        const r = await importDetected(
          identities,
          detector,
          detection,
          { login: a.login, name: a.name, color: a.color, owners: a.owners, author: a.author, runners: a.runners, coordinatorSees: a.coordinator_sees, signingKeyRef: a.signing_key_ref, signingProgram: a.signing_program, requireSigned: a.require_signed, projects },
          assignProject,
          {
            mayUpdate: (i) => {
              mayChange(i)
              mayLoosen(i, a.coordinator_sees)
            },
          },
        )
        return ok({ identity: identityView(r.identity), created: r.created, done: r.lines, next: "test_identity checks it with GitHub (tokens, push access, author email, signing key)." })
      }),
    )

    server.registerTool(
      "create_identity",
      {
        description:
          "Make an identity, only when Cody asked for it: a name, the owners it serves, a git author, runners, and by reference a GitHub token (github_token_ref gh:<login>) and a signing key (signing_key_ref). The server reads and checks each reference itself; when one can't be read, nothing is made. " +
          "For an account on this computer, import_detected_identity does all of this from a proposal. A token or key Cody wants to paste goes in Settings › Identities, never through you.",
        inputSchema: { name: z.string().describe('Its name, e.g. "Acme".'), ...fieldsInput, ...refsInput },
      },
      guarded(async (a: { name: string } & FieldsArgs & RefsArgs) => {
        const r = await createWithRefs(identities, detector, fieldsOf(a), refsOf(a))
        return ok({ identity: identityView(r.identity), done: r.lines, next: "assign_identity gives a project this identity; test_identity checks it with GitHub." })
      }),
    )

    server.registerTool(
      "update_identity",
      {
        description:
          "Change an identity: its fields, and by reference its token (github_token_ref) or signing key (signing_key_ref; null removes it). remove_token drops the token for one owner (\"\" for the every-owner one); remove_claude drops its own Claude login. " +
          (scopeId ? "You can change only an identity no other project uses (not Default)." : "The Default identity keeps its name, and its token and Claude login are Settings › Credentials."),
        inputSchema: {
          identity: z.string().describe("Identity id or name."),
          name: z.string().optional(),
          ...fieldsInput,
          ...refsInput,
          remove_token: z.string().optional().describe('Remove the token for this owner ("" for the every-owner one).'),
          remove_claude: z.boolean().optional().describe("Remove its own Claude login, so its projects use the global one."),
        },
      },
      guarded(async (a: { identity: string; name?: string; remove_token?: string; remove_claude?: boolean } & FieldsArgs & RefsArgs) => {
        const i = identity(a.identity)
        mayChange(i)
        mayLoosen(i, a.coordinator_sees)
        const fields = fieldsOf(a)
        const done: string[] = []
        if (Object.keys(fields).length) {
          identities.update(i.id, fields)
          done.push(`Changed ${Object.keys(fields).join(", ")}.`)
        }
        if (a.remove_token !== undefined) {
          identities.removeToken(i.id, a.remove_token)
          done.push(`Removed the token for ${a.remove_token || "every owner"}.`)
        }
        if (a.remove_claude) {
          identities.removeClaude(i.id)
          done.push("Removed its Claude login.")
        }
        done.push(...(await applyRefs(identities, detector, i.id, refsOf(a))))
        return ok({ identity: identityView(identities.require(i.id)), done: done.length ? done : ["Nothing to change."] })
      }),
    )

    server.registerTool(
      "delete_identity",
      {
        description:
          "Remove an identity and its saved token, key and Claude login. Refused while projects use it, unless move_projects_to_default moves them to the Default identity first. " +
          (scopeId ? "You can remove only an identity no other project uses." : ""),
        inputSchema: { identity: z.string().describe("Identity id or name."), move_projects_to_default: z.boolean().optional() },
      },
      guarded(async (a: { identity: string; move_projects_to_default?: boolean }) => {
        const i = identity(a.identity)
        mayChange(i)
        if (a.move_projects_to_default && i.projectIds.length && i.coordinatorSees === "status" && identities.require(DEFAULT_IDENTITY_ID).coordinatorSees !== "status") {
          throw keepSealed(`the ${i.name} identity shows the Coordinator its projects' status only, and Default shows everything`)
        }
        const { movedProjectIds } = identities.delete(i.id, { moveProjects: a.move_projects_to_default })
        for (const id of movedProjectIds) {
          const p = store.getProject(id)
          if (p) hub.broadcast({ type: "project", project: p })
        }
        if (movedProjectIds.length) tasks.schedule()
        return ok({ deleted: i.name, movedToDefault: movedProjectIds.map((id) => store.getProject(id)?.name ?? id) })
      }),
    )

    server.registerTool(
      "assign_identity",
      {
        description:
          "Give a project an identity, when Cody asked for it or agreed: its next turns use that account's token, author, signing key and Claude login. The identity has to allow the project's runner, and no task of the project may be running (wait for it to rest). Resting tasks move to the identity's boxes on their next turn.",
        inputSchema: {
          project: z.string().optional().describe(scopeId ? "Your project (the default)." : "Project id or name."),
          identity: z.string().describe("Identity id or name (Default for the global credentials)."),
        },
      },
      guarded(async (a: { project?: string; identity: string }) => {
        if (!a.project && !scopeId) return fail("Name the project.")
        return ok({ done: assignProject(a.project ?? ownProject().id, identity(a.identity).id) })
      }),
    )

    server.registerTool(
      "test_identity",
      {
        description:
          "Check an identity with GitHub: each token (whose it is, scopes, expiry), push access to " +
          (scopeId ? "your project's repo" : "each of its projects' repos") +
          " (404, SAML SSO and read-only show as problems), whether its author email is verified on the account, and whether its signing key is on GitHub as a signing key. Never shows a secret." +
          (scopeId ? " You can test your project's identity only." : " The result is saved as its last test."),
        inputSchema: { identity: z.string().optional().describe(scopeId ? "Your project's identity (the default)." : "Identity id or name.") },
      },
      guarded(async (a: { identity?: string }) => {
        if (!a.identity && !scopeId) return fail("Name the identity.")
        const i = a.identity ? identity(a.identity) : identities.of(scopeId!)
        if (scopeId && i.id !== identities.idOf(scopeId)) throw outOfScope(`test_identity checks your project's identity (${identities.of(scopeId).name})`)
        const r = await identities.test(i.id, testRepos(store, i, scopeId), { save: !scopeId })
        return ok({ identity: i.name, ok: r.ok, lines: r.lines })
      }),
    )
  }

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
      // The rendered prompt can hold the task's {summary}.
      prompt: statusOnly(r.projectId ?? (r.taskId ? store.getTask(r.taskId)?.projectId : null)) ? STATUS_ONLY_FIELD : preview(r.prompt, 400, "see the hook's runs in the app"),
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
        include_agent_wakes: z
          .boolean()
          .optional()
          .describe("task.finished: also fire for turns only another agent's message_agent started that changed nothing (no new PR, merge, failure or question). Off by default"),
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
            includeAgentWakes: f.include_agent_wakes,
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
        const report = await tasks.cleanBox(a.box, { kind: "coordinator" })
        return ok({ started: true, box: report.boxId, next: "Call pool_status in a minute to see what it freed." })
      }),
    ),
  )

  server.registerTool(
    "turn_timings",
    {
      description:
        "Where the time of Coordinator, Captain and task turns goes: p50/p95/max per role and per stage (queue wait, task setup, CLI start-up with process start and MCP connect, " +
        "time to first token, model steps, tool calls, the tail after the result, CLI wall and total), the share of prompt tokens read from cache, the slowest tools, and the newest turns with their stages and tokens. " +
        "Turns are kept 30 days. Use it before and after a speed change, or to answer \"why was that reply slow\"." +
        (scopeId ? " As a Captain you see your own turns and your project's tasks." : " A status-only project's turns count in the percentiles but stay out of the tool list and the recent turns."),
      inputSchema: {
        role: z.enum(TURN_ROLES as [TurnRole, ...TurnRole[]]).optional().describe("Only coordinator, captain or task turns"),
        project: z.string().optional().describe("Project name or id"),
        task: z.string().optional().describe("Task id or title: only that task's turns"),
        days: z.number().min(0.05).max(30).optional().describe("How far back (default 7)"),
        recent: z.number().int().min(0).max(50).optional().describe("How many of the newest turns to list (default 10)"),
        kind: z.string().optional().describe("turn (default), compact, summary or context: compaction passes are runs of their own"),
      },
    },
    safe(async (a: { role?: TurnRole; project?: string; task?: string; days?: number; recent?: number; kind?: string }) => {
      const t = a.task ? task(a.task) : null
      // A Captain sees its own turns and its tasks', never the Coordinator's.
      if (scopeId && a.role === "coordinator") throw outOfScope("the Coordinator's turns")
      const projectId = t?.projectId ?? projectFilter(a.project)
      const report = timingReport((f) => store.listTurnTimings(f), { role: a.role, projectId, taskId: t?.id, kind: a.kind?.trim() || undefined, days: a.days, recent: a.recent, hidden: (r) => statusOnly(r.projectId) })
      const projectName = (id: string | null) => (id ? (store.getProject(id)?.name ?? id) : undefined)
      const q = (x: Quantiles | null | undefined) => (x ? `p50 ${formatMs(x.p50)} · p95 ${formatMs(x.p95)} · max ${formatMs(x.max)} (n ${x.n})` : undefined)
      const ms = (n: number | null) => (n === null ? undefined : formatMs(n))
      return ok({
        days: report.days,
        turns: report.summary.turns,
        by_role: Object.fromEntries(
          Object.entries(report.summary.byRole).map(([role, r]) => [
            role,
            {
              turns: r.turns,
              cache_read_share: r.cacheReadShare ?? undefined,
              model_step: q(r.modelStepMs),
              ...Object.fromEntries(TURN_STAGES.filter((s) => r.stages[s.key]).map((s) => [s.label, q(r.stages[s.key])])),
            },
          ]),
        ),
        slowest_tools: report.summary.tools.map((x) => `${x.name}: ${formatMs(x.totalMs)} in ${x.n} calls, ${q(x)}`),
        recent: report.recent.map((r) => ({
          id: r.id,
          ended: ago(r.endedAt),
          role: r.role,
          project: projectName(r.projectId),
          task: r.taskId ?? undefined,
          trigger: r.trigger ?? undefined,
          effort: r.effort ?? undefined,
          ok: r.ok,
          total: formatMs(r.totalMs),
          stages: Object.fromEntries(
            (["queueMs", "setupMs", "startupMs", "mcpMs", "firstTokenMs", "modelMs", "toolMs", "tailMs"] as const).filter((k) => r[k] !== null).map((k) => [k.replace(/Ms$/, ""), ms(r[k])]),
          ),
          calls: `${r.modelCalls} model, ${r.toolCalls} tool${r.slowestTool ? ` (slowest ${r.slowestTool.name} ${formatMs(r.slowestTool.ms)})` : ""}`,
          tokens: r.tokens,
        })),
        ...(report.hiddenTurns ? { status_only_turns: report.hiddenTurns } : {}),
      })
    }),
  )

  server.registerTool(
    "box_history",
    {
      description:
        "The box history log, newest first: every box created, resized (from → to, with the migration target), deleted, lost (the provider reports it gone), cleaned up or cleared (with freed bytes), size changes and orphan sweeps, " +
        "with who did it (Cody, the Coordinator or a Captain with their reason, the resize migration, the failed-resize cleanup, the janitor, the orphan sweep, the provider) and the projects and tasks on the box. " +
        "Deleted boxes stay in it (90 days). Use it to answer \"where did my box go\"." +
        (scopeId ? " As a Captain you see only events about your project's boxes." : ""),
      inputSchema: {
        box: z.string().optional().describe("Box id; includes the other box of its resizes"),
        type: z.enum(BOX_EVENT_TYPES.map((t) => t.key) as [BoxEventType, ...BoxEventType[]]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    safe(async (a: { box?: string; type?: BoxEventType; limit?: number }) => {
      const filter = { boxId: a.box?.trim() || undefined, type: a.type, limit: a.limit ?? 20 }
      const events = tasks.history.list({ ...filter, projectId: scopeId ?? undefined })
      if (scopeId && filter.boxId && !events.length && tasks.history.list({ ...filter, limit: 1 }).length) {
        throw outOfScope(`box ${filter.boxId} never hosted project "${ownProject().name}"`)
      }
      const projectName = (id: string) => store.getProject(id)?.name
      return ok(
        events.map((e) => ({
          at: new Date(e.at).toISOString(),
          ago: ago(e.at),
          box: e.boxId,
          ...(e.boxName && e.boxName !== e.boxId ? { name: e.boxName } : {}),
          event: e.type,
          by: owner(boxActorLabel(e, projectName)),
          reason: e.reason ?? undefined,
          size: e.fromSize && e.toSize ? `${e.fromSize} → ${e.toSize}` : (e.size ?? undefined),
          other_box: e.relatedBoxId ?? undefined,
          projects: e.projects.length ? e.projects.map((p) => projectName(p.id) ?? p.name) : undefined,
          tasks: e.taskIds.length ? e.taskIds : undefined,
          freed_mb: e.freedBytes !== null ? mb(e.freedBytes) : undefined,
          detail: e.detail ?? undefined,
        })),
      )
    }),
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

  server.registerTool(
    "snapshot_box",
    {
      description:
        "Save a box as its project's snapshot, so every new box Box Yard makes for the project starts from it (the repo mirror, node_modules in the box's dependency cache, the npm cache, toolchains, browsers, system packages) instead of from scratch. " +
        "Use it once a setup or scaffold task has a box fully set up and its turn is over, before you fan out many tasks to new boxes. " +
        "The box itself isn't changed: Box Yard snapshots it, strips a scratch copy of every workspace, login, token, temp file and log, saves that as the snapshot and deletes the copy. It replaces the project's previous snapshot. " +
        "Refused while agents run on the box (wait until it's idle). Runs in the background, a few minutes for a big disk; you get a notice when it's saved, and boxes made before then start without it. " +
        "New boxes of the snapshot's size or bigger use it; list_projects shows it. " +
        owner("Cody can clear or replace it in the project's Settings. ") +
        (scopeId ? "As a Captain you can only snapshot a box your project's tasks live on, for your project." : "Pass project when the box holds more than one project's work."),
      inputSchema: {
        box: z.string().describe("Box id, from pool_status (the box the setup task ran on)"),
        project: z.string().optional().describe("Project id or name; defaults to your project (Captain) or the box's only project"),
        reason: z.string().trim().min(3).max(500).optional().describe("Why, in one sentence for the box history (e.g. \"Scaffold task set up the repo, npm ci and headless Chrome\")."),
      },
    },
    safe(async (a: { box: string; project?: string; reason?: string }) => {
      const box = store.getBox(a.box)
      if (!box) return fail(`No box "${a.box}". Use pool_status.`)
      const on = tasks.projectsOnBox(box.id)
      const named = a.project ? project(a.project) : scopeId ? ownProject() : on.length === 1 ? store.getProject(on[0]!) : null
      if (!named) {
        const names = on.map((id) => store.getProject(id)?.name ?? id)
        return fail(names.length ? `Box ${box.id} holds work of ${names.join(", ")}: say which project with project.` : `Box ${box.id} holds no project's work: snapshot a box a setup task ran on.`)
      }
      if (!on.includes(named.id)) {
        if (scopeId) throw outOfScope(`box ${box.id} doesn't host project "${named.name}"`)
        return fail(`Box ${box.id} doesn't hold ${named.name}'s work: snapshot a box its tasks ran on.`)
      }
      const by = scopeId ? ({ kind: "captain", projectId: scopeId } as const) : ({ kind: "coordinator" } as const)
      const job = await tasks.snapshotBox(box.id, named.id, { by, reason: a.reason ?? null })
      return ok({
        started: true,
        project: named.name,
        box: job.boxId,
        size: job.size,
        ...(named.snapshot ? { replaces: named.snapshot.id } : {}),
        next: `You'll get a notice when it's saved (list_projects shows progress). Fan out after that: boxes made before then start without it. New ${named.name} boxes of ${job.size} or bigger will start from it.`,
      })
    }),
  )

  // ---------------------------------------------------------------- deleting boxes
  // The same safety check as Box Yard's own cleanups (server/boxDelete.ts), strict for MCP callers: no stopping
  // agents and no override (Cody has those on the Boxes page). A Captain only reaches boxes holding nothing but its
  // own project's work.
  const deleter: BoxActor = scopeId ? { kind: "captain", projectId: scopeId } : { kind: "coordinator" }
  const projectName = (id: string) => store.getProject(id)?.name ?? id
  /** A box id, GPU pod id or Docker container id this caller may delete. */
  const deletableBox = (ref: string): string => {
    const id = ref.trim()
    if (!isGpuBox(id) && !isDockerBox(id) && !store.getBox(id) && !tasks.history.boxIds().includes(id)) throw new Error(`No box "${ref}". Use pool_status.`)
    if (scopeId && !tasks.onlyProjectOn(id, scopeId)) {
      const on = tasks.projectsOnBox(id).map(projectName)
      throw outOfScope(`box ${id} ${on.length ? `holds work of ${on.join(", ")}` : "holds no work of your project"}, and a Captain can only delete a box that holds nothing but its own project's`)
    }
    return id
  }
  const SAFETY =
    "Safety check first, the same as Box Yard's own cleanups: refused while an agent runs or a task is queued on it, and while any workspace has uncommitted or unpushed work, unless that task's PR is merged and its branch fully pushed. " +
    "Every workspace is archived first (a merged, fully pushed one needs no archive). RunPod network volumes and project snapshots are never touched. " +
    owner("You can't stop agents or override the check: tell Cody what holds the box, and Cody can delete it anyway from the Boxes page. ")

  server.registerTool(
    "delete_box",
    {
      description:
        "Delete one worker box at its provider, terminate a RunPod GPU pod (runpod-<project>[-n]; terminated, never just stopped, and its network volume stays), or delete a project's Docker container (docker-<project>) with its workspace volume (the image stays). " +
        SAFETY +
        "The tasks on it keep working: each restores from its archive on its next turn, on another box, a new pod or a new container. The box history records it as deleted by you, with your reason. " +
        "To clear out many boxes, use delete_idle_boxes (dry run first)." +
        (scopeId ? " As a Captain you can only delete a box that holds nothing but your project's work." : ""),
      inputSchema: {
        box: z.string().describe("Box id from pool_status, a GPU pod's runpod-… id or a Docker container's docker-… id"),
        reason: z.string().trim().min(3).max(500).describe("Why, in one sentence for the box history (e.g. \"Idle since tiny-town's last PR merged\")."),
      },
    },
    safe(async (a: { box: string; reason: string }) => {
      const id = deletableBox(a.box)
      const r = await tasks.destroyBox(id, { actor: deleter, reason: a.reason })
      if (r.alreadyGone) return ok(`${id} is already gone (deleted earlier, or at the provider): nothing left to delete. box_history has what happened to it.`)
      return ok({
        [r.kind === "pod" ? "terminated" : "deleted"]: r.label === id ? id : `${r.label} (${id})`,
        ...(r.kind === "pod" ? { volume: "kept" } : r.kind === "container" ? { volume: "deleted with it (its workspaces were archived first)" } : {}),
        archived: r.archived.length ? r.archived : undefined,
        no_archive_needed: r.fromGitHub.length ? r.fromGitHub.map((t) => `${t} (PR merged, nothing unpushed)`) : undefined,
        next: "Its tasks restore from their archive on their next turn. box_history has the row.",
      })
    }),
  )

  server.registerTool(
    "delete_idle_boxes",
    {
      description:
        "Find idle boxes (and RunPod GPU pods) and delete them, after the same safety check as delete_box on each. " +
        "dry_run (the default) changes nothing: it lists each box it would delete with what happens to its tasks, and each box it skips with why. Show Cody that list before deleting when Cody hasn't asked for it outright. " +
        "With dry_run: false and a reason it deletes those boxes (each is checked again first) and says what it deleted, what failed and what it skipped. " +
        SAFETY +
        (scopeId ? "As a Captain you only see boxes that hold nothing but your project's work." : "With project, only boxes holding nothing but that project's work; without it, every running box."),
      inputSchema: {
        project: z.string().optional().describe(scopeId ? "Your project (the default)" : "Project id or name: only boxes holding nothing but its work"),
        dry_run: z.boolean().optional().describe("Default true: only report what it would delete and why each other box is skipped"),
        reason: z.string().trim().min(3).max(500).optional().describe("Required when dry_run is false: why, in one sentence for each box's history"),
      },
    },
    safe(async (a: { project?: string; dry_run?: boolean; reason?: string }) => {
      const projectId = projectFilter(a.project)
      const dry = a.dry_run !== false
      if (!dry && !a.reason) return fail("Give a reason when dry_run is false; it goes in each box's history.")
      const ids = await tasks.deleteCandidates(projectId)
      const scope = projectId ? `${projectName(projectId)}-only` : "running"
      if (!ids.length) return ok(`No ${scope} boxes to look at.`)
      const checked = await mapLimit(ids, 4, async (id) => {
        try {
          return { id, contents: await tasks.boxContents(id), error: null }
        } catch (err) {
          return { id, contents: null, error: errorMessage(err) }
        }
      })
      const go = checked.filter((x) => x.contents && !x.contents.refusals.length)
      const skipped = checked
        .filter((x) => !x.contents || x.contents.refusals.length)
        .map((x) => (x.contents ? `${boxHead(x.contents, projectName)}: ${x.contents.refusals.join("; ")}` : `${x.id}: couldn't check it (${x.error})`))
      if (dry) {
        return ok({
          dry_run: true,
          summary: `Would delete ${go.length} of ${ids.length} ${scope} ${ids.length === 1 ? "box" : "boxes"}; ${skipped.length} skipped.`,
          would_delete: go.map((x) => boxSummary(x.contents!, projectName)),
          skipped,
          next: go.length ? "To delete them, call delete_idle_boxes again with dry_run: false and a reason. Each box is checked again first." : undefined,
        })
      }
      const done = await mapLimit(go, 3, async (x) => {
        try {
          const r = await tasks.destroyBox(x.id, { actor: deleter, reason: a.reason })
          return { ok: r.alreadyGone ? `${x.id} (already gone at the provider)` : boxSummary(x.contents!, projectName) }
        } catch (err) {
          return { failed: `${boxHead(x.contents!, projectName)}: ${errorMessage(err).replace(/\n- /g, "; ").replace(/:\s*;/, ":")}` }
        }
      })
      const deleted = done.flatMap((d) => (d.ok ? [d.ok] : []))
      const failed = done.flatMap((d) => (d.failed ? [d.failed] : []))
      return ok({
        summary: `Deleted ${deleted.length} of ${ids.length} ${scope} ${ids.length === 1 ? "box" : "boxes"}${failed.length ? `; ${failed.length} failed` : ""}; ${skipped.length} skipped.`,
        deleted,
        failed: failed.length ? failed : undefined,
        skipped: skipped.length ? skipped : undefined,
        next: "Their tasks restore from their archive on their next turn. box_history (type deleted) lists each with your reason.",
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
  const thread = deps.threads?.callerForToken(bearer)
  if (thread) return thread
  const projectId = deps.captains?.projectForToken(bearer)
  return projectId ? { kind: "captain", projectId } : null
}

/**
 * Stateless Streamable HTTP endpoint: a fresh server per request. `handshakes` hears each Coordinator and Captain
 * request's JSON-RPC methods and times, for their turns' start-up timings.
 */
export function mcpHandler(deps: McpDeps, token: string, handshakes?: McpHandshakes) {
  return async (req: Request, res: Response) => {
    const at = Date.now()
    const caller = callerFor(deps, token, req.headers.authorization)
    if (!caller) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null })
      return
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").end()
      return
    }
    // Side threads (readOnly callers) run beside the chat's turns: their handshakes aren't the turn's.
    const key = caller.readOnly ? null : caller.kind === "coordinator" ? "coordinator" : `captain:${caller.projectId}`
    if (handshakes && key) {
      const body = req.body as unknown
      const methods = (Array.isArray(body) ? body : [body]).map((m) => (m && typeof m === "object" ? String((m as { method?: unknown }).method ?? "") : ""))
      if (methods.some((m) => m === "initialize" || m === "server/discover" || m === "tools/list")) res.on("finish", () => handshakes.saw(key, methods, at, Date.now()))
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
