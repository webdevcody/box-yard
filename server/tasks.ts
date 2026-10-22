import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store, TaskRow, TurnFlags } from "./store.js"
import { BadRequestError, NotFoundError, cloneUrl, githubSlug } from "./store.js"
import type { BoxProvider } from "./providers/types.js"
import { q } from "./providers/types.js"
import { EventReader, parseCursor, redisEventsKey, type Cursor, type WorkerEvent } from "./bus.js"
import type { Redis } from "./redis.js"
import type { Artifacts } from "./artifacts.js"
import { MAX_ARTIFACT_BYTES } from "./artifacts.js"
import {
  firstTurnPrompt,
  followupPrompt,
  recapPrompt,
  workerSystemPrompt,
  type DirectoryEntry,
} from "./prompts.js"
import type { BoxInfo, PreviewLink, Task, TaskStatus } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"

const RUNNER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner/box-runner.mjs")
const RUNNER_FALLBACK = path.resolve(process.cwd(), "runner/box-runner.mjs")

/** Statuses a task can sit in between turns. */
const RESTING: TaskStatus[] = ["idle", "pr_ready", "done", "failed", "needs_input", "waiting"]
const PORT_BASE = 4000
const MAX_INTERRUPTS = 2
const STALL_MS = 45_000
const START_TIMEOUT_MS = 15 * 60_000
const BOX_RETRY_MS = 60_000
const AGENT_MSG_LIMIT = 20 // per sender, per 10 minutes

export interface TaskManagerDeps {
  config: Config
  store: Store
  provider: BoxProvider
  hub: Hub
  redis: Redis | null
  artifacts: Artifacts
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
  private readonly reader: EventReader

  private timers: NodeJS.Timeout[] = []
  private scheduling = false
  private rescheduleWanted = false
  private polling = false
  private holds = new Map<string, AbortController>()
  private lastEventAt = new Map<string, number>()
  private pollFailures = new Map<string, number>()
  private stopRequested = new Set<string>()
  private creatingBoxes = 0
  private lastBoxError: { at: number; message: string } | null = null
  private agentMsgLog = new Map<string, number[]>()
  private archiving = new Set<string>()
  private directoryTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(deps: TaskManagerDeps) {
    this.c = deps.config
    this.store = deps.store
    this.provider = deps.provider
    this.hub = deps.hub
    this.redis = deps.redis
    this.artifacts = deps.artifacts
    this.reader = new EventReader(deps.provider, deps.redis)
    fs.mkdirSync(path.join(this.c.dataDir, "archives"), { recursive: true })
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
    this.schedule()
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    if (this.emitBoxesTimer) clearTimeout(this.emitBoxesTimer)
    if (this.directoryTimer) clearTimeout(this.directoryTimer)
    for (const h of this.holds.values()) h.abort()
    this.holds.clear()
  }

  /** After a restart: re-attach to running turns and requeue half-started ones. */
  private recover() {
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
      const known = new Set(this.store.listBoxes().map((b) => b.id))
      const ids = await this.provider.listIds(label)
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
  }): Task {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
    if (!input.title.trim()) throw new BadRequestError("title is required")
    if (!input.prompt.trim()) throw new BadRequestError("prompt is required")
    const task = this.store.createTask({
      ...input,
      branch: project.repo ? `boxyard/${slugify(input.title)}-${randomUUID().slice(0, 4)}` : null,
    })
    this.store.addTaskMessage(task.id, "user", input.prompt, { kind: "task_prompt" })
    this.emitTask(task.id)
    this.publishDirectory()
    this.schedule()
    return this.store.getTask(task.id)!
  }

  sendInput(taskId: string, content: string, source: "cody" | "orchestrator" | "system" | `agent:${string}` = "cody"): Task {
    const row = this.requireRow(taskId)
    if (!content.trim()) throw new BadRequestError("message is empty")
    this.store.queueInput(row.id, source, content.trim())
    if (source === "cody" || source === "orchestrator") {
      const msg = this.store.addTaskMessage(row.id, "user", content.trim(), { source })
      this.hub.broadcast({ type: "task.message", message: msg })
    }
    const patch: Parameters<Store["updateTask"]>[1] = { lastActiveAt: Date.now() }
    if (row.status === "needs_input" && source !== "system" && !source.startsWith("agent:")) patch.question = null
    if (!row.current_turn_id && RESTING.includes(row.status)) {
      patch.status = "queued"
      patch.error = null
    }
    this.store.updateTask(row.id, patch)
    this.emitTask(row.id)
    this.schedule()
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
      this.store.updateTask(row.id, { status: row.turn_count > 0 ? "idle" : "failed", error: row.turn_count > 0 ? null : "Stopped before it started." })
    }
    this.addEvent(row.id, "Stopped by Cody.")
    this.emitTask(row.id)
    return this.store.getTask(row.id)!
  }

  /** Finish a task: stop it, archive it, free its box folder. */
  async closeTask(taskId: string): Promise<Task> {
    const row = this.requireRow(taskId)
    if (row.current_turn_id) await this.stopTask(taskId)
    this.store.clearInputs(row.id)
    this.store.updateTask(row.id, { status: "done", question: null })
    this.addEvent(row.id, "Closed. Its workspace was archived and its box slot freed.")
    this.emitTask(row.id)
    void this.evictWhenSettled(row.id)
    this.publishDirectory()
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
    if (row.box_id) await this.removeTaskDir(row.box_id, row.id).catch(() => {})
    if (row.archive_path) fs.rmSync(row.archive_path, { force: true })
    if (this.redis) await this.redis.cmd("DEL", redisEventsKey(row.id)).catch(() => {})
    this.store.deleteTask(row.id)
    this.hub.broadcast({ type: "task.deleted", taskId: row.id })
    this.publishDirectory()
    this.schedule()
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

  boxes(): BoxInfo[] {
    return this.store.listBoxes().map((b) => {
      const residents = this.store.listTaskRows({ boxId: b.id })
      return {
        id: b.id,
        provider: b.provider,
        status: b.status,
        slots: this.c.slotsPerBox,
        runningTurns: residents.filter((r) => r.current_turn_id).length,
        residentTasks: residents.map((r) => r.id),
        createdAt: b.created_at,
        lastUsedAt: b.last_used_at,
      }
    })
  }

  async destroyBox(boxId: string) {
    const box = this.store.getBox(boxId)
    if (!box) throw new NotFoundError(`Box ${boxId} not found`)
    for (const row of this.store.listTaskRows({ boxId })) {
      if (row.current_turn_id) await this.killTurn(row).catch(() => {})
    }
    await this.loseBox(boxId, "Box deleted by Cody.")
    await this.provider.destroy(boxId).catch((err) => console.warn(`destroy ${boxId}: ${errorMessage(err)}`))
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
    const waiting = this.store
      .listTaskRows()
      .filter((r) => !r.current_turn_id && (r.status === "queued" || (r.status !== "failed" && this.store.hasInputs(r.id))))
      .filter((r) => r.status !== "starting" && r.status !== "working")
      .sort((a, b) => a.last_active_at - b.last_active_at)

    let unplaced = 0
    for (const row of waiting) {
      const boxId = await this.place(row)
      if (!boxId) {
        if (row.status !== "queued") {
          this.store.updateTask(row.id, { status: "queued" })
          this.emitTask(row.id)
        }
        if (!row.box_id || this.store.getBox(row.box_id)?.status !== "ready") unplaced++
        continue
      }
      const turnId = randomUUID()
      // Reserve the slot before any await so parallel passes see it taken.
      this.store.updateTask(row.id, { status: "starting", boxId, currentTurnId: turnId, error: null })
      this.store.touchBox(boxId)
      this.emitTask(row.id)
      void this.launch(row.id, boxId, turnId)
    }

    // Grow the pool when work is waiting and there is room.
    const boxes = this.store.listBoxes()
    const freeSoon = this.creatingBoxes * this.c.slotsPerBox
    const recentlyFailed = this.lastBoxError && Date.now() - this.lastBoxError.at < BOX_RETRY_MS
    if (unplaced > freeSoon && boxes.length + this.creatingBoxes < this.c.maxBoxes && !recentlyFailed) {
      const want = Math.min(Math.ceil((unplaced - freeSoon) / this.c.slotsPerBox), this.c.maxBoxes - boxes.length - this.creatingBoxes)
      for (let i = 0; i < want; i++) void this.createBox()
    }
  }

  /** Pick a box for a task's next turn, or null to wait. */
  private async place(row: TaskRow): Promise<string | null> {
    if (row.box_id) {
      const box = this.store.getBox(row.box_id)
      if (box?.status === "ready") {
        if (this.runningOn(box.id) < this.c.slotsPerBox) return box.id
        // Its box is busy. Move to a free box if the archive is fresh enough.
        const fresh = row.archive_path && (row.last_archived_at ?? 0) >= row.last_active_at - 1000 && fs.existsSync(row.archive_path)
        if (!fresh) return null
        const other = this.pickBox(row.id, box.id)
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
    const boxId = this.pickBox(row.id)
    return boxId ? this.assign(row.id, boxId) : null
  }

  private pickBox(taskId: string, exclude?: string): string | null {
    const candidates = this.store
      .listBoxes()
      .filter((b) => b.status === "ready" && b.id !== exclude)
      .map((b) => {
        const residents = this.store.listTaskRows({ boxId: b.id })
        return { id: b.id, running: residents.filter((r) => r.current_turn_id).length, residents: residents.length }
      })
      .filter((b) => b.running < this.c.slotsPerBox)
      .sort((a, b) => a.running - b.running || a.residents - b.residents)
    for (const b of candidates) {
      if (b.residents < this.c.maxResidentPerBox || this.evictOne(b.id, taskId)) return b.id
    }
    return null
  }

  /** Give a task a home on a box, with its own block of preview ports. */
  private assign(taskId: string, boxId: string): string {
    const used = new Set(
      this.store
        .listTaskRows({ boxId })
        .map((r) => r.port_base)
        .filter((p): p is number => p !== null),
    )
    let port = PORT_BASE
    while (used.has(port)) port += 10
    this.store.updateTask(taskId, { boxId, portBase: port })
    return boxId
  }

  /** Free a folder on a full box by removing the least recently used, archived, resting task. */
  private evictOne(boxId: string, forTaskId: string): boolean {
    const victim = this.store
      .listTaskRows({ boxId })
      .filter(
        (r) =>
          r.id !== forTaskId &&
          !r.current_turn_id &&
          RESTING.includes(r.status) &&
          r.archive_path &&
          (r.last_archived_at ?? 0) >= r.last_active_at - 1000,
      )
      .sort((a, b) => a.last_active_at - b.last_active_at)[0]
    if (!victim) return false
    this.store.updateTask(victim.id, { boxId: null, portBase: null, previews: [] })
    void this.removeTaskDir(boxId, victim.id).catch(() => {})
    this.addEvent(victim.id, `Workspace parked in the archive to make room on box ${boxId}. It comes back on the next message.`)
    this.emitTask(victim.id)
    return true
  }

  private async createBox() {
    this.creatingBoxes++
    const placeholder = `creating-${randomUUID().slice(0, 8)}`
    this.store.upsertBox({ id: placeholder, provider: this.provider.name, status: "creating", created_at: Date.now(), last_used_at: Date.now() })
    this.emitBoxes()
    try {
      const id = await this.provider.create({ labels: ["boxyard", this.installLabel()] })
      this.store.removeBox(placeholder)
      this.store.upsertBox({ id, provider: this.provider.name, status: "ready", created_at: Date.now(), last_used_at: Date.now() })
      this.lastBoxError = null
      console.log(`[box-yard] created box ${id}`)
    } catch (err) {
      this.store.removeBox(placeholder)
      const message = `Couldn't create a worker box: ${errorMessage(err)}`
      console.error(`[box-yard] ${message}`)
      if (!this.lastBoxError || this.lastBoxError.message !== message) this.notice(`⚠️ ${message}. Retrying in a minute.`)
      this.lastBoxError = { at: Date.now(), message }
      setTimeout(() => this.schedule(), BOX_RETRY_MS).unref()
    } finally {
      this.creatingBoxes--
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
    try {
      await this.provider.wake(boxId)
      const project = this.store.getProject(row.project_id)
      if (!project) throw new Error("Project was deleted")

      const check = await this.provider.exec(boxId, `[ -d ${q(dir + "/work")} ] && echo present || echo missing`)
      if (check.exitCode !== 0) throw new Error(`box not responding: ${check.stderr.slice(-300)}`)
      if (check.stdout.includes("missing")) await this.prepareWorkspace(row, boxId, dir)
      row = this.requireRow(taskId)

      const inputs = this.store.peekInputs(taskId)
      const firstTurn = !row.session_started
      const directory = this.directory()
      const notes = this.store.listNotes(project.id)
      const prompt = firstTurn
        ? firstTurnPrompt({ task: row, notes, directory, extraInputs: inputs.length ? [followupPrompt(inputs)] : [] })
        : followupPrompt(inputs.length ? inputs : [{ source: "system", content: "Continue." }])

      const runnerPath = `${this.provider.root(boxId)}/.boxyard/box-runner.mjs`
      await this.provider.writeFile(boxId, runnerPath, this.runnerSource())
      await this.provider.writeFile(boxId, `${dir}/task.json`, JSON.stringify(this.taskJson(row, project, boxId), null, 2))
      await this.provider.writeFile(
        boxId,
        `${dir}/turn.json`,
        JSON.stringify({
          turnId,
          prompt,
          sessionId: row.session_id,
          resume: !firstTurn,
          systemPrompt: workerSystemPrompt({ project, task: row, branch: row.branch, port: row.port_base ?? PORT_BASE }),
          directory,
          notes: notes.map((n) => ({ author: n.author, content: n.content })),
          recap: recapPrompt(this.store.getTask(taskId)!, this.store.listTaskMessages(taskId, 60)),
        }),
      )

      if (this.stopRequested.has(taskId)) throw new StoppedBeforeStart()

      // setsid (where it exists; macOS has none) + nohup: the turn survives a
      // dropped exec connection. The runner writes turn.pid itself.
      const start = await this.provider.exec(
        boxId,
        `cd ${q(dir)} && ([ -f turn.pid ] && kill -TERM -- -$(cat turn.pid) 2>/dev/null; rm -f turn.pid; true) && ($(command -v setsid || true) nohup ${q(this.provider.nodeBin)} ${q(runnerPath)} turn ${q(dir)} >> runner.log 2>&1 < /dev/null &) && for i in $(seq 1 50); do [ -f turn.pid ] && break; sleep 0.2; done; [ -f turn.pid ] && cat turn.pid || (tail -n 20 runner.log; exit 1)`,
      )
      if (start.exitCode !== 0) throw new Error(`runner did not start: ${(start.stdout + start.stderr).slice(-800)}`)

      this.store.deleteInputs(inputs.map((i) => i.id))
      const flags = this.store.turnFlags(row)
      this.store.updateTask(taskId, {
        status: "working",
        sessionStarted: true,
        turnCount: row.turn_count + 1,
        turnFlags: { interrupts: flags.interrupts } as TurnFlags,
        lastActiveAt: Date.now(),
        question: null,
      })
      this.lastEventAt.set(taskId, Date.now())
      this.emitTask(taskId)
      this.publishDirectory()
      this.holdOpen(taskId, boxId)
      if (this.stopRequested.has(taskId)) await this.killTurn(this.requireRow(taskId)).catch(() => {})
    } catch (err) {
      const stopped = err instanceof StoppedBeforeStart
      this.stopRequested.delete(taskId)
      const message = errorMessage(err)
      if (!stopped) console.error(`[box-yard] launch ${taskId} on ${boxId} failed: ${message}`)
      const current = this.store.getTaskRow(taskId)
      if (!current) return
      this.store.updateTask(taskId, {
        status: stopped ? "idle" : "failed",
        currentTurnId: null,
        error: stopped ? null : `Couldn't start the agent: ${message}`,
      })
      if (!stopped) {
        this.addEvent(taskId, `Couldn't start the agent: ${message}`)
        this.notice(`❌ **${current.title}** couldn't start: ${message}`)
        const health = await this.provider.health(boxId).catch(() => "unknown" as const)
        if (health === "gone" || health === "error") await this.loseBox(boxId, `Box ${boxId} is ${health}.`)
      }
      this.emitTask(taskId)
      this.schedule()
    }
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
      model: this.c.workerModel || undefined,
      port: row.port_base ?? PORT_BASE,
      baseBranch: project.baseBranch,
      github: { slug: githubSlug(project.repo) },
      redis: this.redis ? { url: this.c.redisUrl, token: this.c.redisToken, key: redisEventsKey(row.id) } : null,
    }
  }

  /** Fresh folder for a task: restore its archive, or clone its repo. */
  private async prepareWorkspace(row: TaskRow, boxId: string, dir: string) {
    const root = this.provider.root(boxId)
    if (row.archive_path && fs.existsSync(row.archive_path)) {
      const remote = `${root}/.boxyard/restore-${row.id}.tgz`
      await this.provider.uploadFile(boxId, row.archive_path, remote)
      const res = await this.provider.exec(
        boxId,
        `mkdir -p ${q(root + "/tasks")} && tar xzf ${q(remote)} -C ${q(root + "/tasks")} && rm -f ${q(remote)} && mkdir -p ${q(dir + "/work")} && rm -f ${q(dir + "/turn.pid")}`,
      )
      if (res.exitCode !== 0) throw new Error(`restoring workspace failed: ${res.stderr.slice(-500)}`)
      // The restored events log keeps its own seq numbers; restart the byte offset.
      const cursor = parseCursor(row.event_cursor)
      const size = await this.provider.exec(boxId, `wc -c < ${q(dir + "/events.jsonl")} 2>/dev/null || echo 0`)
      this.store.updateTask(row.id, { eventCursor: JSON.stringify({ ...cursor, offset: Number.parseInt(size.stdout.trim(), 10) || 0 }) })
      this.addEvent(row.id, `Workspace restored on box ${boxId}.`)
      return
    }

    const project = this.store.getProject(row.project_id)!
    const steps = [`mkdir -p ${q(dir)}`, `rm -rf ${q(dir + "/work")}`]
    if (project.repo) {
      const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f`
      const token = this.store.projectEnv(project.id).GITHUB_TOKEN ?? this.c.githubToken
      steps.push(
        `cd ${q(dir)}`,
        `GITHUB_TOKEN=${q(token)} GIT_TERMINAL_PROMPT=0 git -c credential.helper=${q(helper)} clone ${q(cloneUrl(project.repo))} work`,
        `cd work`,
        `(git checkout ${q(project.baseBranch)} 2>/dev/null || true)`,
        `git config credential.helper ${q(helper)}`,
        `git config user.name ${q(this.c.gitUserName)}`,
        `git config user.email ${q(this.c.gitUserEmail)}`,
      )
      if (row.branch) steps.push(`(git checkout ${q(row.branch)} 2>/dev/null || git checkout -b ${q(row.branch)})`)
    } else {
      steps.push(`mkdir -p ${q(dir + "/work")}`)
    }
    const res = await this.provider.exec(boxId, steps.join(" && "))
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).replace(/x-access-token:[^@\s]+/g, "x-access-token:***").slice(-800)
      throw new Error(project.repo ? `git clone of ${project.repo} failed: ${detail}` : `workspace setup failed: ${detail}`)
    }
    this.store.updateTask(row.id, { eventCursor: null })
    this.addEvent(row.id, project.repo ? `Cloned ${project.repo} on box ${boxId}${row.branch ? `, branch ${row.branch}` : ""}.` : `Workspace ready on box ${boxId}.`)
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

  private async applyEvents(taskId: string, events: WorkerEvent[], cursor: Cursor) {
    for (const ev of events) {
      this.lastEventAt.set(taskId, Date.now())
      try {
        await this.apply(taskId, ev)
      } catch (err) {
        console.error(`[box-yard] applying ${ev.t} for ${taskId} failed: ${errorMessage(err)}`)
      }
    }
    if (this.store.getTaskRow(taskId)) {
      this.store.updateTask(taskId, { eventCursor: JSON.stringify(cursor) })
    }
  }

  /** Apply one worker event to the task. Exposed for tests. */
  async apply(taskId: string, ev: WorkerEvent) {
    const row = this.store.getTaskRow(taskId)
    if (!row) return
    const flags = this.store.turnFlags(row)
    const say = (role: "assistant" | "tool" | "event" | "agent", content: string, meta: Record<string, unknown> | null = null) => {
      const msg = this.store.addTaskMessage(taskId, role, content, meta)
      this.hub.broadcast({ type: "task.message", message: msg })
    }

    switch (ev.t) {
      case "turn_start":
      case "log":
        return
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
        say("event", `Asked Cody: ${question}`, { kind: "question" })
        return this.emitTask(taskId)
      }
      case "message_agent":
        return this.deliverAgentMessage(row, String(ev.to), String(ev.message ?? ""), Boolean(ev.expectReply))
      case "note": {
        const note = this.store.addNote(row.project_id, `agent: ${row.title}`, String(ev.content ?? ""))
        say("event", `Saved a project note: ${note.content}`)
        const project = this.store.getProject(row.project_id)
        if (project) this.hub.broadcast({ type: "project", project })
        return this.publishNotes(row.project_id)
      }
      case "pr": {
        const url = String(ev.url ?? "")
        const first = row.pr_url !== url
        this.store.updateTask(taskId, { prUrl: url, branch: String(ev.branch ?? row.branch ?? "") || row.branch, turnFlags: { ...flags, sawPr: true } })
        say("event", `${first ? "Opened" : "Updated"} pull request: ${url}`, { kind: "pr", url })
        if (first) this.notice(`🔀 **${row.title}** opened a pull request: ${url}`)
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
            title: String(ev.title ?? path.basename(String(ev.path))),
            filename: path.basename(String(ev.path)),
            data,
            projectId: row.project_id,
            taskId,
          })
          this.hub.broadcast({ type: "artifact", artifact })
          say("event", `Published artifact: ${artifact.title}`, { kind: "artifact", url: artifact.url, artifactId: artifact.id })
        } catch (err) {
          say("event", `Couldn't fetch artifact ${ev.path}: ${errorMessage(err)}`)
        }
        return
      }
      case "done":
        this.store.updateTask(taskId, { turnFlags: { ...flags, done: String(ev.summary ?? "Done.") } })
        return
      case "turn_end":
        return this.finishTurn(row, ev)
      default:
        return
    }
  }

  private finishTurn(row: TaskRow, ev: WorkerEvent) {
    if (ev.turnId && row.current_turn_id && ev.turnId !== row.current_turn_id) return // stale event from an older turn
    if (!row.current_turn_id) return
    const flags = this.store.turnFlags(row)
    const stopped = Boolean(ev.stopped) || this.stopRequested.has(row.id)
    this.stopRequested.delete(row.id)
    this.holds.get(row.id)?.abort()
    this.holds.delete(row.id)

    let status: TaskStatus
    let error: string | null = null
    if (stopped) status = row.pr_url ? "pr_ready" : "idle"
    else if (!ev.ok) {
      status = "failed"
      error = String(ev.error ?? "The agent exited with an error.")
    } else if (flags.asked) status = "needs_input"
    else if (flags.done) status = "done"
    else if (flags.waitingOn?.length) status = "waiting"
    else if (row.pr_url) status = "pr_ready"
    else status = "idle"

    const result = typeof ev.result === "string" ? ev.result : null
    this.store.updateTask(row.id, {
      status,
      error,
      currentTurnId: null,
      summary: flags.done ?? (result ? result.slice(0, 4000) : row.summary),
      sessionId: typeof ev.sessionId === "string" ? ev.sessionId : undefined,
      lastActiveAt: Date.now(),
      question: status === "needs_input" ? (flags.asked ?? null) : null,
      turnFlags: { interrupts: 0 },
    })
    if (row.box_id) this.store.touchBox(row.box_id)

    const cost = typeof ev.costUsd === "number" ? ` · $${ev.costUsd.toFixed(3)}` : ""
    this.addEvent(row.id, `Turn ${row.turn_count} ${stopped ? "stopped" : status === "failed" ? "failed" : "finished"}${cost}.`)
    if (status === "needs_input") this.notice(`🙋 **${row.title}** needs you: ${flags.asked}`, { taskId: row.id })
    else if (status === "done") this.notice(`✅ **${row.title}** is done: ${(flags.done ?? "").slice(0, 300)}`, { taskId: row.id })
    else if (status === "failed") this.notice(`❌ **${row.title}** failed: ${(error ?? "").slice(0, 300)}`, { taskId: row.id })
    else if (status === "pr_ready" && row.status !== "pr_ready" && !flags.sawPr) {
      this.notice(`🔀 **${row.title}** has a PR ready: ${row.pr_url}`, { taskId: row.id })
    }

    this.emitTask(row.id)
    this.publishDirectory()
    void this.archive(row.id).finally(() => this.schedule())
    this.schedule()
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
      this.store.queueInput(from.id, "system", `Your message to ${to} was not delivered because you sent too many agent messages recently. Ask Cody with ask_user if you are stuck.`)
      return
    }
    log.push(now)
    this.agentMsgLog.set(from.id, log)

    if (/^(cody|user|human|orchestrator)$/i.test(to)) {
      say(from.id, `→ Cody: ${message}`, { to: "cody" })
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

  /** Copy the task folder (repo, Claude session, event log) to the orchestrator's disk. */
  async archive(taskId: string) {
    if (!this.c.archiveWorkspaces || this.archiving.has(taskId)) return
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id) return
    this.archiving.add(taskId)
    const boxId = row.box_id
    const tmp = `/tmp/boxyard-archive-${taskId}.tgz`
    try {
      const root = `${this.provider.root(boxId)}/tasks`
      const excludes = [
        "node_modules", ".next", ".turbo", ".cache", ".venv", "__pycache__", "target",
        `${taskId}/task.json`, `${taskId}/turn.pid`, `${taskId}/events.lock`, `${taskId}/mcp.json`,
      ]
        .map((e) => `--exclude=${q(e)}`)
        .join(" ")
      const max = this.c.archiveMaxMb * 1024 * 1024
      let res = await this.provider.exec(boxId, `cd ${q(root)} && tar czf ${tmp} ${excludes} ${q(taskId)} 2>/dev/null; wc -c < ${tmp}`)
      let size = Number.parseInt(res.stdout.trim().split("\n").pop() ?? "", 10)
      let partial = false
      if (!Number.isFinite(size)) throw new Error(`tar failed: ${res.stderr.slice(-300)}`)
      if (size > max) {
        // Too big: keep the Claude session, the log and git history (with any
        // uncommitted work stashed into a WIP commit on a side ref).
        partial = true
        res = await this.provider.exec(
          boxId,
          `cd ${q(root + "/" + taskId + "/work")} 2>/dev/null && [ -d .git ] && (git add -A && git -c user.name=box-yard -c user.email=box-yard@local commit -qm "box-yard: wip snapshot" --no-verify && git update-ref refs/boxyard/wip HEAD && git reset -q HEAD~1) >/dev/null 2>&1; cd ${q(root)} && tar czf ${tmp} ${excludes} ${q(taskId + "/claude")} ${q(taskId + "/events.jsonl")} $( [ -d ${q(taskId + "/work/.git")} ] && echo ${q(taskId + "/work/.git")}) 2>/dev/null; wc -c < ${tmp}`,
        )
        size = Number.parseInt(res.stdout.trim().split("\n").pop() ?? "", 10)
        if (!Number.isFinite(size) || size > max) throw new Error(`workspace is too large to archive (${Math.round(size / 1e6)} MB)`)
      }
      const data = await this.provider.readFile(boxId, tmp)
      const file = path.join(this.c.dataDir, "archives", `${taskId}.tgz`)
      fs.writeFileSync(`${file}.tmp`, data)
      fs.renameSync(`${file}.tmp`, file)
      if (this.store.getTaskRow(taskId)) {
        this.store.updateTask(taskId, { archivePath: file, lastArchivedAt: Date.now() })
        if (partial) this.addEvent(taskId, "Workspace was too big to archive whole; saved the Claude session and git history (uncommitted work is on refs/boxyard/wip).")
      }
    } catch (err) {
      console.warn(`[box-yard] archive ${taskId} failed: ${errorMessage(err)}`)
    } finally {
      await this.provider.exec(boxId, `rm -f ${tmp}`).catch(() => {})
      this.archiving.delete(taskId)
    }
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
    await this.archive(taskId)
    const row = this.store.getTaskRow(taskId)
    if (!row?.box_id || row.current_turn_id || row.status !== "done") return
    if (this.c.archiveWorkspaces && !row.archive_path) return // keep the folder if we have no copy
    const boxId = row.box_id
    this.store.updateTask(taskId, { boxId: null, portBase: null, previews: [] })
    await this.removeTaskDir(boxId, taskId).catch(() => {})
    this.emitTask(taskId)
    this.emitBoxes()
  }

  // ------------------------------------------------------------------ health

  /** Find stalled turns, dead processes and lost boxes; trim idle boxes. */
  async maintain() {
    if (this.stopped) return
    const now = Date.now()
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
    if (this.c.boxIdleDeleteMinutes > 0) {
      for (const box of this.store.listBoxes()) {
        if (box.status !== "ready") continue
        if (now - box.last_used_at < this.c.boxIdleDeleteMinutes * 60_000) continue
        const residents = this.store.listTaskRows({ boxId: box.id })
        if (residents.some((r) => r.current_turn_id || this.store.hasInputs(r.id))) continue
        if (residents.some((r) => !r.archive_path)) continue
        console.log(`[box-yard] deleting idle box ${box.id}`)
        await this.loseBox(box.id, "Box retired after being idle; workspaces are archived.", true)
        await this.provider.destroy(box.id).catch(() => {})
      }
    }
    this.schedule()
  }

  /** The turn died. Requeue it (a couple of times) so the agent can carry on. */
  private interrupt(row: TaskRow, reason: string) {
    const flags = this.store.turnFlags(row)
    const interrupts = (flags.interrupts ?? 0) + 1
    this.holds.get(row.id)?.abort()
    if (interrupts > MAX_INTERRUPTS) {
      this.store.updateTask(row.id, { status: "failed", currentTurnId: null, error: `Interrupted: ${reason}`, turnFlags: { interrupts: 0 } })
      this.addEvent(row.id, `Turn interrupted (${reason}). Gave up after ${MAX_INTERRUPTS} retries.`)
      this.notice(`❌ **${row.title}** was interrupted: ${reason}`, { taskId: row.id })
    } else {
      this.store.queueInput(row.id, "system", `Your previous turn was interrupted (${reason}). Check where things stand (git status, files) and continue the task.`)
      this.store.updateTask(row.id, { status: "queued", currentTurnId: null, turnFlags: { interrupts } })
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

  private addEvent(taskId: string, content: string) {
    if (!this.store.getTaskRow(taskId)) return
    const msg = this.store.addTaskMessage(taskId, "event", content)
    this.hub.broadcast({ type: "task.message", message: msg })
  }

  /** A line in the orchestrator chat; the orchestrator reads it on its next turn. */
  notice(content: string, meta: Record<string, unknown> | null = null) {
    const msg = this.store.addChat("notice", content, meta)
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
