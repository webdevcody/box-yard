import type { Hub } from "./hub.js"
import type { Store, TaskRow } from "./store.js"
import type { TaskEvent, TaskManager } from "./tasks.js"
import type { HookInput, HookPatch, HookStore } from "./hookStore.js"
import { hookTemplate, hookTemplates } from "./hookTemplates.js"
import { BadRequestError, ConflictError, NotFoundError } from "./store.js"
import { prNumber } from "./prs.js"
import { preview } from "./replies.js"
import { isQuietRun } from "../shared/quiet.js"
import { withOwner } from "../shared/owner.js"
import {
  ACTION_INFO,
  TRIGGER_INFO,
  hookMismatch,
  renderHookTemplate,
  shortSha,
  type Hook,
  type HookGuard,
  type HookRun,
  type HookSubject,
  type HookTemplateView,
  type HookWithLastRun,
  type HookVars,
  type TaskSource,
} from "../shared/hooks.js"
import type { Project, Task } from "../shared/types.js"

/**
 * The hook engine. It listens on the task event bus (TaskManager.subscribe, the same events that become
 * Captain and Coordinator notices) and runs every enabled hook whose trigger and filters match.
 *
 * Guards, in order:
 * - Fire once: a hook fires once per (hook, task, event, key), where the key is the PR's head commit for
 *   task.pr_ready (a new push fires again, the same commit never does), the PR for pr.merged, and the
 *   turn that ended for the other events.
 * - Loop guard: a hook doesn't fire on a turn its own prompt started, or on a task it created (directly or
 *   down a chain of hook-made tasks), unless the hook allows it (allowSelfTrigger).
 * - Caps: each hook fires at most maxFiresPerTask times per task, and all hooks together at most
 *   `taskCap.max` times per task per window.
 * - Rate limit: at most `rateLimit.max` fires across the yard per window.
 * A guarded fire is logged as skipped (once per key and reason) and noted on the task's transcript.
 *
 * Every fire goes through the normal paths (TaskManager.sendInput/createTask, CaptainManager.send, the
 * Coordinator's queue), so box slots and Upstash limits apply as usual. Each one shows on the task's
 * transcript (labelled "Hook: <name>") and as a notice to both the project's Captain and the Coordinator,
 * so neither starts the same work in parallel.
 */
export interface HookTuning {
  rateLimit: { max: number; windowMs: number }
  taskCap: { max: number; windowMs: number }
}

export const DEFAULT_HOOK_TUNING: HookTuning = {
  rateLimit: { max: 30, windowMs: 10 * 60_000 },
  taskCap: { max: 10, windowMs: 24 * 60 * 60_000 },
}

export interface HookEngineDeps {
  store: Store
  hooks: HookStore
  tasks: TaskManager
  hub: Hub
  /** Send a hook's prompt to a project's Captain. */
  messageCaptain: (projectId: string, content: string, meta: HookMeta) => void
  /** Send a hook's prompt to the Coordinator chat. */
  messageCoordinator: (content: string, meta: HookMeta) => void
  /** What Box Yard calls its human (Settings.ownerName). */
  ownerName?: () => string | undefined
  now?: () => number
}

/** What a hook's message carries, so every transcript can label it "Hook: <name>". */
export interface HookMeta {
  source: "hook"
  hookId: string
  hookName: string
  trigger: Hook["trigger"]
  taskId: string
  [key: string]: unknown
}

/** A task's own source column, as the hook filters name it. */
export function taskSource(row: Pick<TaskRow, "source" | "schedule_id">): TaskSource | null {
  const s = row.source
  if (row.schedule_id || s === "schedule") return "schedule"
  if (!s) return null
  if (s === "cody") return "cody"
  if (s === "orchestrator") return "coordinator"
  if (s.startsWith("captain:")) return "captain"
  if (s.startsWith("hook:")) return "hook"
  return null
}

export function prLabels(row: Pick<TaskRow, "pr_labels_json">): string[] {
  try {
    const v = JSON.parse(row.pr_labels_json ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** The template variables for a task. */
export function hookVars(task: Task, row: Pick<TaskRow, "pr_head_sha">, project: Project | null): HookVars {
  return {
    task_id: task.id,
    task_title: task.title,
    project: project?.name ?? task.projectId,
    pr_number: String(prNumber(task.prUrl) ?? ""),
    pr_url: task.prUrl ?? "",
    branch: task.branch ?? "",
    head_sha: row.pr_head_sha ?? "",
    status: task.status,
    summary: task.summary ?? "",
  }
}

/**
 * What makes one fire of a hook on a task distinct, or null when the event can't be told apart from one
 * already handled (a pr_ready with no known head commit and no push this turn).
 */
export function fireKey(event: TaskEvent, row: Pick<TaskRow, "pr_head_sha" | "pr_url">): string | null {
  if (event.type === "task.pr_ready") {
    if (row.pr_head_sha) return `sha:${row.pr_head_sha}`
    return event.sawPr && event.turnId ? `turn:${event.turnId}` : null
  }
  if (event.type === "pr.merged") return `merged:${row.pr_url ?? ""}`
  return `turn:${event.turnId ?? "none"}`
}

/** How a hook names itself to the agent, Captain or Coordinator it messages. */
export function hookLabel(hook: Pick<Hook, "name" | "trigger" | "createdBy">, ownerName?: string) {
  return `Message from the Box Yard hook "${hook.name}" (an automation that runs on "${TRIGGER_INFO[hook.trigger].label}", set up by ${hook.createdBy}; ${withOwner("not a new message from Cody", ownerName)})`
}

export class HookEngine {
  readonly tuning: HookTuning = structuredClone(DEFAULT_HOOK_TUNING)
  private unsubscribe: (() => void) | null = null
  private readonly now: () => number

  constructor(private readonly deps: HookEngineDeps) {
    this.now = deps.now ?? Date.now
  }

  start() {
    this.unsubscribe ??= this.deps.tasks.subscribe((event) => void this.handle(event))
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  // ---------------------------------------------------------------- management (REST and MCP)

  /** Global hooks (projectId null), one project's, or every hook (undefined), with each one's newest run. */
  list(filter: { projectId?: string | null } = {}): HookWithLastRun[] {
    const list = this.deps.hooks.list(filter)
    const last = this.deps.hooks.lastRuns(list.map((h) => h.id))
    return list.map((h) => ({ ...h, lastRun: last.get(h.id) ?? null }))
  }

  /** By id, or by name among global hooks (null), one project's, or all (undefined). */
  find(ref: string, scope?: string | null): Hook | null {
    return this.deps.hooks.find(ref, scope)
  }

  get(id: string): Hook {
    const hook = this.deps.hooks.get(id)
    if (!hook) throw new NotFoundError(`Hook ${id} not found`)
    return hook
  }

  create(input: HookInput): Hook {
    this.checkScope(input.projectId, input.filters?.projectId)
    const hook = this.deps.hooks.create(input)
    this.deps.hub.broadcast({ type: "hook", hook })
    return hook
  }

  update(id: string, patch: HookPatch): Hook {
    const before = this.get(id)
    if (patch.filters) this.checkScope(before.projectId, patch.filters.projectId)
    const hook = this.deps.hooks.update(id, patch)
    this.deps.hub.broadcast({ type: "hook", hook })
    return hook
  }

  remove(id: string) {
    this.get(id)
    this.deps.hooks.delete(id)
    this.deps.hub.broadcast({ type: "hook.deleted", hookId: id })
  }

  runs(filter: Parameters<HookStore["listRuns"]>[0] = {}): HookRun[] {
    return this.deps.hooks.listRuns(filter)
  }

  templates(): HookTemplateView[] {
    return hookTemplates().map((t) => ({
      key: t.key,
      description: t.description,
      name: t.draft.name,
      trigger: t.draft.trigger,
      action: t.draft.action,
      filters: t.draft.filters ?? {},
      prompt: t.draft.prompt,
      maxFiresPerTask: t.draft.maxFiresPerTask ?? 3,
    }))
  }

  /** Create a hook from a built-in template. It starts off unless `enabled` says otherwise. */
  fromTemplate(key: string, scope: { projectId: string | null; createdBy: string; enabled?: boolean; name?: string; prompt?: string }): Hook {
    const t = hookTemplate(key)
    if (!t) throw new BadRequestError(`No hook template "${key}". Templates: ${hookTemplates().map((x) => x.key).join(", ")}.`)
    return this.create({
      ...t.draft,
      projectId: scope.projectId,
      createdBy: scope.createdBy,
      enabled: scope.enabled ?? false,
      ...(scope.name?.trim() ? { name: scope.name } : {}),
      ...(scope.prompt?.trim() ? { prompt: scope.prompt } : {}),
    })
  }

  /** Project hooks belong to an existing project; a project filter only makes sense on a global hook. */
  private checkScope(projectId: string | null, filterProject: string | null | undefined) {
    if (projectId && !this.deps.store.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
    if (filterProject && !this.deps.store.getProject(filterProject)) throw new NotFoundError(`Project ${filterProject} not found`)
    if (projectId && filterProject && filterProject !== projectId) throw new BadRequestError("A project hook only sees its own project's tasks; leave the project filter empty.")
  }

  // ---------------------------------------------------------------- firing

  /** Run every matching hook for one task event. Returns the runs it logged (fired, skipped or failed). */
  handle(event: TaskEvent): HookRun[] {
    const { store, hooks } = this.deps
    const row = store.getTaskRow(event.taskId)
    if (!row) return []
    const candidates = hooks.listFor(row.project_id)
    if (!candidates.length) return []
    const task = store.taskFromRow(row)
    const project = store.getProject(row.project_id)
    const subject: HookSubject = {
      trigger: event.type,
      projectId: row.project_id,
      title: row.title,
      prompt: row.prompt,
      source: taskSource(row),
      status: row.status,
      prUrl: row.pr_url,
      prState: row.pr_state,
      prLabels: prLabels(row),
      quiet: isQuietRun(task),
    }
    const key = fireKey(event, row)
    if (!key) return []
    const origin = new Set([...event.originHookIds, ...hooks.lineage(row.id)])
    const runs: HookRun[] = []
    for (const hook of candidates) {
      if (hookMismatch(hook, subject)) continue
      // Fire once: anything but a guard's skip settles this event for this hook.
      const prior = hooks.runFor(hook.id, row.id, event.type, key)
      if (prior.some((r) => r.status !== "skipped" || !r.guard)) continue
      const prompt = renderHookTemplate(hook.prompt, hookVars(task, row, project))
      const blocked = this.blocked(hook, row.id, origin)
      if (blocked) {
        // The same guard again for the same event isn't logged twice.
        if (prior.some((r) => r.guard === blocked.guard)) continue
        runs.push(this.skip(hook, task, row, event, key, prompt, blocked))
        continue
      }
      runs.push(this.fire(hook, task, row, project, event, key, prompt))
    }
    return runs
  }

  /** Which guard stops this fire and why, or null. */
  private blocked(hook: Hook, taskId: string, origin: Set<string>): { guard: HookGuard; reason: string } | null {
    const { hooks } = this.deps
    const now = this.now()
    if (origin.has(hook.id) && !hook.allowSelfTrigger) return { guard: "loop", reason: "Skipped by the loop guard: this hook's own prompt started this work." }
    if (hooks.firesFor(hook.id, taskId) >= hook.maxFiresPerTask) {
      return { guard: "hook_cap", reason: `Skipped: this hook already fired ${hook.maxFiresPerTask} time${hook.maxFiresPerTask === 1 ? "" : "s"} for this task, its limit.` }
    }
    const cap = this.tuning.taskCap
    if (hooks.taskFiresSince(taskId, now - cap.windowMs) >= cap.max) {
      return { guard: "task_cap", reason: `Skipped: hooks already fired ${cap.max} times for this task in ${windowLabel(cap.windowMs)}.` }
    }
    const rate = this.tuning.rateLimit
    if (hooks.firesSince(now - rate.windowMs) >= rate.max) {
      return { guard: "rate_limit", reason: `Skipped by the rate limit: hooks fired ${rate.max} times across the yard in ${windowLabel(rate.windowMs)}.` }
    }
    return null
  }

  private base(hook: Hook, task: Task, row: TaskRow, event: TaskEvent, key: string, prompt: string) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      hookProjectId: hook.projectId,
      projectId: task.projectId,
      taskId: task.id,
      taskTitle: task.title,
      event: event.type,
      fireKey: key,
      headSha: row.pr_head_sha,
      action: hook.action,
      prompt,
      targetTaskId: null as string | null,
    }
  }

  private skip(hook: Hook, task: Task, row: TaskRow, event: TaskEvent, key: string, prompt: string, blocked: { guard: HookGuard; reason: string }): HookRun {
    const run = this.deps.hooks.addRun({ ...this.base(hook, task, row, event, key, prompt), status: "skipped", guard: blocked.guard, result: blocked.reason })
    this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) didn't fire. ${blocked.reason}`, hook, run)
    this.deps.hub.broadcast({ type: "hook.run", run })
    return run
  }

  private fire(hook: Hook, task: Task, row: TaskRow, project: Project | null, event: TaskEvent, key: string, prompt: string): HookRun {
    const { hooks, tasks, hub } = this.deps
    // Logged before acting, so the fire counts toward the caps even if the action throws.
    let run = hooks.addRun({ ...this.base(hook, task, row, event, key, prompt), status: "fired", result: "Firing…" })
    const meta: HookMeta = { source: "hook", hookId: hook.id, hookName: hook.name, trigger: hook.trigger, taskId: task.id, hookRunId: run.id }
    const labelled = `${hookLabel(hook, this.deps.ownerName?.())}:\n\n${prompt}`
    const pr = task.prUrl ? ` (PR #${prNumber(task.prUrl) ?? "?"}${row.pr_head_sha ? ` at ${shortSha(row.pr_head_sha)}` : ""})` : ""
    try {
      let result: string
      let target: string | null = null
      if (hook.action === "send_to_task" && hook.template === "pr_merge") {
        // The merge template takes the Merge PR button's path: its pending guard, merge_requested event and 🚢 notices.
        const by = { source: `hook:${hook.id}` as const, who: `hook "${hook.name}"`, prompt, hook: { queued: labelled, meta } }
        try {
          tasks.requestMerge(task.id, by)
        } catch (err) {
          if (!(err instanceof ConflictError || err instanceof BadRequestError)) throw err
          run = hooks.updateRun(run.id, { status: "skipped", result: `Skipped: ${err.message}` })
          this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) didn't ask for a merge: ${err.message}`, hook, run)
          hub.broadcast({ type: "hook.run", run })
          return run
        }
        target = task.id
        result = `Asked the agent to merge${pr}.`
      } else if (hook.action === "send_to_task") {
        // Like send_to_task: queued while the agent is busy, resumed (from its archive if needed) when it rests.
        tasks.sendInput(task.id, prompt, `hook:${hook.id}`, [], null, { queued: labelled, meta })
        target = task.id
        result = `Sent to the task's agent${pr}.`
        this.notice(hook, task, `sent to the agent${pr}: ${preview(prompt, 240, "see the task transcript")}`, meta)
      } else if (hook.action === "message_captain") {
        this.deps.messageCaptain(task.projectId, prompt, meta)
        result = `Sent to the ${project?.name ?? "project"} Captain.`
        this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) messaged the ${project?.name ?? "project"} Captain: ${preview(prompt, 400, "see the Captain tab")}`, hook, run)
        this.notice(hook, task, `messaged the Captain${pr}: ${preview(prompt, 240, "see the Captain tab")}`, meta)
      } else if (hook.action === "message_coordinator") {
        this.deps.messageCoordinator(prompt, meta)
        result = "Sent to the Coordinator."
        this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) messaged the Coordinator: ${preview(prompt, 400, "see the Coordinator chat")}`, hook, run)
        this.notice(hook, task, `messaged the Coordinator${pr}: ${preview(prompt, 240, "see the Coordinator chat")}`, meta)
      } else {
        const title = renderHookTemplate(hook.taskTitle ?? hook.name, hookVars(task, row, project)).slice(0, 120).trim() || hook.name
        const created = tasks.createTask({ projectId: task.projectId, title, prompt, source: `hook:${hook.id}` })
        target = created.id
        result = `Started task "${created.title}" (${created.id}).`
        this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) started [${created.title}](/tasks/${created.id}).`, hook, run)
        this.notice(hook, task, `started a new task [${created.title}](/tasks/${created.id}): ${preview(prompt, 200, "see the new task")}`, meta)
      }
      run = hooks.updateRun(run.id, { result, targetTaskId: target })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      run = hooks.updateRun(run.id, { status: "failed", result: `Failed: ${message}` })
      this.transcript(task.id, `Hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) failed to ${ACTION_INFO[hook.action].label.toLowerCase()}: ${message}`, hook, run)
    }
    hub.broadcast({ type: "hook.run", run })
    return run
  }

  private transcript(taskId: string, content: string, hook: Hook, run: HookRun) {
    if (!this.deps.store.getTaskRow(taskId)) return
    const msg = this.deps.store.addTaskMessage(taskId, "event", content, { kind: "hook", hookId: hook.id, hookName: hook.name, hookRunId: run.id, status: run.status })
    this.deps.hub.broadcast({ type: "task.message", message: msg })
  }

  /** "[Box Yard updates]" for both the Captain and the Coordinator. It doesn't wake either: they read it on their next turn. */
  private notice(hook: Hook, task: Task, what: string, meta: HookMeta) {
    this.deps.tasks.notice(`🪝 **${task.title}** hook "${hook.name}" (${TRIGGER_INFO[hook.trigger].label}) ${what}`, { ...meta, kind: "hook" }, { coordinator: true, wake: false })
  }
}

function windowLabel(ms: number) {
  const min = Math.round(ms / 60_000)
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (min < 90) return `${min} min`
  const h = Math.round(min / 60)
  return h % 24 === 0 ? `${h / 24 === 1 ? "a day" : `${h / 24} days`}` : `${h} h`
}
