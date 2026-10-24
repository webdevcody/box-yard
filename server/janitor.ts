import type { Store, TaskRow } from "./store.js"
import type { Hub } from "./hub.js"
import type { BoxProvider } from "./providers/types.js"
import { q } from "./providers/types.js"
import { errorMessage } from "./util/retry.js"
import { RESTING_STATUSES } from "../shared/types.js"
import { CLEANUP_STEPS, CLEAR_STEPS, EMERGENCY_FREE_BYTES, EMERGENCY_STEPS, type BoxCleanup, type CleanupReason, type CleanupStepKey, type CleanupStepReport, type DiskSpace } from "../shared/disk.js"

/** After a low-disk cleanup that couldn't reach its target, don't run another for this long (unless a launch hit ENOSPC). */
const COOLDOWN_MS = 10 * 60_000
const kvKey = (boxId: string) => `box_cleanup:${boxId}`
/**
 * Claude Code's per-session scratch in a task's config dir (claude/): shell snapshots, env, debug logs, paste and
 * file-history caches, config backups. A resume needs none of them; the transcripts in projects/ are never touched.
 */
export const SESSION_TEMP_DIRS = ["shell-snapshots", "session-env", "debug", "statsig", "paste-cache", "file-history", "backups"]
/** What the pushed check prints first; "yes" or "no <why>" follows. */
const PUSHED_MARK = "boxyard-pushed="

/**
 * Prints whether a work folder holds anything GitHub doesn't: one repo (no nested ones), nothing uncommitted or
 * stashed, and no commit on HEAD or any local branch that isn't on a remote branch. Always exits 0.
 */
export function pushedCheck(work: string): string {
  const no = (why: string) => `{ echo "${PUSHED_MARK}no ${why}"; exit 0; }`
  return [
    `cd ${q(work)} 2>/dev/null || ${no("no work folder")}`,
    `[ -e .git ] && [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ] || ${no("not a git repo")}`,
    `[ -z "$(find . -mindepth 2 -maxdepth 6 -name .git -print -quit 2>/dev/null)" ] || ${no("it holds more than one repo")}`,
    `s=$(git --no-optional-locks status --porcelain 2>/dev/null) || ${no("git status failed")}`,
    `[ -z "$s" ] || ${no("uncommitted changes")}`,
    `[ -z "$(git stash list 2>/dev/null)" ] || ${no("stashed changes")}`,
    `n=$(git rev-list --count HEAD --branches --not --remotes 2>/dev/null) || ${no("couldn't compare with origin")}`,
    `[ "$n" = 0 ] || ${no(`$n unpushed commits`)}`,
    `echo "${PUSHED_MARK}yes"`,
  ].join("\n")
}

/** What the janitor needs from the task manager. */
export interface JanitorHost {
  store: Store
  provider: BoxProvider
  hub: Hub
  /** df on the box's work disk (fresh, not cached), or null if it can't tell. */
  probe(boxId: string): Promise<DiskSpace | null>
  taskDir(boxId: string, taskId: string): string
  /** Put the current runner script on the box; returns its path. */
  installRunner(boxId: string): Promise<string>
  hasFreshArchive(row: TaskRow): boolean
  archive(taskId: string): Promise<void>
  /** Why a task has no fresh archive: "archive task_x: <reason>". */
  archiveProblem(taskId: string): string
  /** Remove a resting task's folder from its box; it comes back from the archive on its next message. */
  park(taskId: string, boxId: string, note: string): Promise<void>
  /** Remove a done task's folder without an archive (GitHub has all of it); it comes back from a recap. */
  dropPushed(taskId: string, boxId: string): Promise<void>
  /** Repo mirror folder names (in .boxyard/repos) some task on the box still needs; with `owner`, also the box's own project's. */
  mirrorsToKeep(boxId: string, owner?: boolean): Set<string>
  /** A run ended (ok or not). */
  finished(report: BoxCleanup): void
}

export interface CleanupOptions {
  reason: CleanupReason
  /** Stop once this much is free. Null runs every safe step (Clean up now). */
  target: number | null
  /** Done workspaces are only parked while free space is below this. */
  parkBelow: number
  /**
   * Clear box: archive and remove every workspace that isn't running (any status), then leftovers, caches and
   * every repo mirror nothing on the box needs. A workspace whose archive can't be made stays.
   */
  clear?: boolean
  /** Runs first, inside the report: a throw fails the run before any step (e.g. agents that won't stop). */
  before?: () => Promise<void>
}

/**
 * Why a folder in a box's tasks/ is safe to delete outright, or null to keep it.
 * Only folders whose work can't be lost: tasks Box Yard no longer knows, tasks
 * that live on another box now and have an archive (or never started a session),
 * and tasks here whose setup failed before their first turn.
 */
export function staleTaskDir(row: TaskRow | null, boxId: string, freshArchive: boolean): string | null {
  if (!row) return "unknown task"
  if (row.current_turn_id || row.status === "starting" || row.status === "working") return null
  if (row.box_id !== boxId) return freshArchive || !row.session_started ? "moved off this box" : null
  if (row.status === "failed" && !row.session_started) return "setup failed before its first turn"
  return null
}

/** Resting tasks whose dependency and build dirs may go, done ones first, then least recently active. */
export function buildCleanupOrder(rows: TaskRow[], boxId: string, hasInputs: (id: string) => boolean): TaskRow[] {
  return rows
    .filter((r) => r.box_id === boxId && !r.current_turn_id && RESTING_STATUSES.includes(r.status) && !hasInputs(r.id))
    .sort((a, b) => Number(b.status === "done") - Number(a.status === "done") || a.last_active_at - b.last_active_at)
}

/** Done tasks whose folders may be parked in the archive, least recently active first. */
/** Every workspace on a box that Clear box archives and removes: all but running ones, least recently active first. */
export function clearOrder(rows: TaskRow[], boxId: string): TaskRow[] {
  return rows.filter((r) => r.box_id === boxId && !r.current_turn_id && r.status !== "starting" && r.status !== "working").sort((a, b) => a.last_active_at - b.last_active_at)
}

/** Done tasks with a merged PR, whose folders may go without an archive once they hold nothing unpushed. Oldest first. */
export function mergedOrder(rows: TaskRow[], boxId: string, hasInputs: (id: string) => boolean): TaskRow[] {
  return parkOrder(rows, boxId, hasInputs).filter((r) => r.pr_state === "merged")
}

export function parkOrder(rows: TaskRow[], boxId: string, hasInputs: (id: string) => boolean): TaskRow[] {
  return rows
    .filter((r) => r.box_id === boxId && !r.current_turn_id && r.status === "done" && !hasInputs(r.id))
    .sort((a, b) => a.last_active_at - b.last_active_at)
}

/**
 * Frees disk on a worker box in safe, graduated steps (CLEANUP_STEPS), measuring
 * each step with df and stopping as soon as there is enough room. It never
 * deletes a task's uncommitted work: dependency/build dirs go only when git
 * ignores them (the runner's `clean` mode), and a done workspace leaves the box
 * only once its archive is fresh.
 */
export class BoxJanitor {
  private running = new Map<string, Promise<BoxCleanup>>()
  private reports = new Map<string, BoxCleanup>()
  /** Tasks whose folder a step is working in right now; they don't start a turn until it's done. */
  private busy = new Set<string>()

  constructor(private readonly host: JanitorHost) {}

  isRunning(boxId: string) {
    return this.running.has(boxId)
  }

  isBusy(taskId: string) {
    return this.busy.has(taskId)
  }

  /** The running cleanup on a box, or its last one. */
  current(boxId: string): BoxCleanup | null {
    const mem = this.reports.get(boxId)
    if (mem) return mem
    const raw = this.host.store.getKv(kvKey(boxId))
    if (!raw) return null
    try {
      const saved = JSON.parse(raw) as BoxCleanup
      this.reports.set(boxId, saved)
      return saved
    } catch {
      return null
    }
  }

  forget(boxId: string) {
    this.reports.delete(boxId)
    this.host.store.setKv(kvKey(boxId), null)
  }

  /**
   * Make sure a box gets cleaned for a placement that needs `target` free. Starts
   * a run unless one is going or a recent one already did all it could.
   * Returns what the caller should tell the waiting task.
   */
  ensure(boxId: string, target: number, reason: CleanupReason = "low-disk", force = false): "running" | "exhausted" {
    if (this.running.has(boxId)) return "running"
    const last = this.current(boxId)
    const recent = last?.finishedAt && Date.now() - last.finishedAt < COOLDOWN_MS
    if (!force && recent && last && last.reason !== "manual" && !last.enough && (last.targetFreeBytes ?? 0) >= target) return "exhausted"
    void this.run(boxId, { reason, target, parkBelow: target })
    return "running"
  }

  /** Start a cleanup (or join the running one). Resolves with its report. */
  run(boxId: string, opts: CleanupOptions): Promise<BoxCleanup> {
    const going = this.running.get(boxId)
    if (going) return going
    const report: BoxCleanup = {
      boxId,
      reason: opts.reason,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      targetFreeBytes: opts.target,
      freeBefore: null,
      freeAfter: null,
      totalBytes: null,
      freedBytes: 0,
      steps: [],
      enough: false,
      error: null,
    }
    this.publish(report)
    const p = this.steps(report, opts)
      .catch((err) => {
        report.status = "failed"
        report.error = errorMessage(err)
        console.warn(`[box-yard] cleanup on ${boxId} failed: ${report.error}`)
      })
      .then(() => {
        if (report.status === "running") report.status = "done"
        report.finishedAt = Date.now()
        this.running.delete(boxId)
        this.publish(report)
        this.host.finished(report)
        return report
      })
    this.running.set(boxId, p)
    return p
  }

  /** The current report, broadcast and saved so the Boxes page shows it after a reload. */
  private publish(report: BoxCleanup) {
    const copy = { ...report, steps: report.steps.map((s) => ({ ...s, removed: [...s.removed] })) }
    this.reports.set(report.boxId, copy)
    if (copy.status !== "running") this.host.store.setKv(kvKey(report.boxId), JSON.stringify(copy))
    this.host.hub.broadcast({ type: "box.cleanup", cleanup: copy })
  }

  private async steps(report: BoxCleanup, opts: CleanupOptions) {
    const boxId = report.boxId
    if (opts.before) await opts.before()
    const start = await this.host.probe(boxId)
    report.freeBefore = start?.freeBytes ?? null
    report.totalBytes = start?.totalBytes ?? null
    let free = start?.freeBytes ?? null
    const enough = () => opts.target !== null && free !== null && free >= opts.target
    /** Re-measure; returns bytes freed since the last measurement. */
    const measure = async () => {
      const now = await this.host.probe(boxId)
      if (!now) return 0
      report.totalBytes = now.totalBytes
      const freed = free === null ? 0 : Math.max(0, now.freeBytes - free)
      free = now.freeBytes
      report.freeAfter = free
      return freed
    }
    report.freeAfter = free
    report.enough = enough()

    // Nearly full: first the steps that need no room, so the rest (runner install, git gc, archives) can work.
    const emergency = !opts.clear && free !== null && free < EMERGENCY_FREE_BYTES
    for (const step of opts.clear ? CLEAR_STEPS : emergency ? [...EMERGENCY_STEPS, ...CLEANUP_STEPS] : CLEANUP_STEPS) {
      const entry: CleanupStepReport = { key: step.key, label: step.label, freedBytes: 0, removed: [], skipped: null }
      report.steps.push(entry)
      if (enough()) {
        entry.skipped = "enough room already"
        continue
      }
      if (step.key === "archive" && free !== null && free >= (opts.target ?? opts.parkBelow)) {
        entry.skipped = "enough room without parking workspaces"
        continue
      }
      try {
        // A step that works task by task measures after each one, so it stops once there's room.
        entry.skipped = await this.step(step.key, boxId, entry, opts, async () => {
          entry.freedBytes += await measure()
          return enough()
        })
      } catch (err) {
        entry.skipped = `failed: ${errorMessage(err).slice(0, 200)}`
      }
      entry.freedBytes += await measure()
      report.freedBytes += entry.freedBytes
      if (entry.freedBytes > 0 || entry.removed.length) console.log(`[box-yard] cleanup ${boxId} ${step.key}: freed ${entry.freedBytes} bytes (${entry.removed.join(", ") || "-"})`)
      this.publish(report)
    }
    report.enough = opts.target === null ? true : enough()
  }

  /** Run one step. `progress` re-measures and says whether there is enough room now. Returns a skip reason, or null. */
  private async step(key: CleanupStepKey, boxId: string, entry: CleanupStepReport, opts: CleanupOptions, progress: () => Promise<boolean>): Promise<string | null> {
    const { store, provider } = this.host
    const root = provider.root(boxId)
    const rows = () => store.listTaskRows()
    const onBox = () => rows().filter((r) => r.box_id === boxId)
    const exec = async (cmd: string) => {
      const res = await provider.exec(boxId, cmd)
      if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim().slice(-300) || `exit ${res.exitCode}`)
      return res.stdout
    }
    const cloning = () => onBox().some((r) => r.status === "starting")

    switch (key) {
      case "temp": {
        // Marked busy so no turn starts in these folders meanwhile; re-checked under the mark.
        const resting = onBox().filter((r) => !r.current_turn_id && RESTING_STATUSES.includes(r.status) && !this.busy.has(r.id))
        for (const r of resting) this.busy.add(r.id)
        let out: string
        try {
          const idle = resting.filter((r) => {
            const row = store.getTaskRow(r.id)
            return row?.box_id === boxId && !row.current_turn_id && RESTING_STATUSES.includes(row.status)
          })
          const dirs = idle.flatMap((r) => SESSION_TEMP_DIRS.map((d) => q(`${this.host.taskDir(boxId, r.id)}/claude/${d}`)))
          const parts = dirs.length ? [`for d in ${dirs.join(" ")}; do [ -e "$d" ] && rm -rf "$d" && echo "$d"; done`] : []
          // A restore in progress belongs to a starting task.
          if (!cloning()) parts.push(`find ${q(root + "/.boxyard")} -maxdepth 1 -name 'restore-*.tgz' -print -delete 2>/dev/null`)
          // Archive leftovers in the box's /tmp (local boxes share this machine's /tmp, so not there). Archives in flight are newer.
          if (provider.name !== "local") parts.push(`find /tmp -maxdepth 1 \\( -name 'boxyard-archive-*' -o -name 'boxyard-wip.*' \\) -mmin +30 -print -exec rm -rf {} + 2>/dev/null`)
          out = await exec(`${parts.join("; ")}; true`)
        } finally {
          for (const r of resting) this.busy.delete(r.id)
        }
        const gone = out.split("\n").filter(Boolean)
        const session = gone.filter((l) => l.includes("/claude/"))
        const tasks = new Set(session.map((l) => resting.find((r) => l.includes(`/${r.id}/claude/`))?.id).filter(Boolean))
        if (session.length) entry.removed.push(`session temp files of ${tasks.size} ${tasks.size === 1 ? "task" : "tasks"}`)
        const other = gone.length - session.length
        if (other) entry.removed.push(`${other} restore/archive temp ${other === 1 ? "file" : "files"}`)
        return gone.length ? null : "no temp files"
      }

      case "merged": {
        const order = mergedOrder(rows(), boxId, (id) => store.hasInputs(id))
        if (!order.length) return "no done tasks with a merged PR on this box"
        const kept: string[] = []
        for (const candidate of order) {
          this.busy.add(candidate.id)
          try {
            const row = store.getTaskRow(candidate.id)
            if (!row || row.box_id !== boxId || row.current_turn_id || row.status !== "done" || row.pr_state !== "merged" || store.hasInputs(row.id)) continue
            if (this.host.hasFreshArchive(row)) {
              // Nothing to lose either way; parking keeps the Claude session too.
              await this.host.park(row.id, boxId, `Workspace parked in the archive to free disk on box ${boxId}. It comes back on the next message.`)
              entry.removed.push(`${row.id} (archived)`)
            } else {
              const out = await exec(pushedCheck(`${this.host.taskDir(boxId, row.id)}/work`))
              const verdict = out.split("\n").find((l) => l.startsWith(PUSHED_MARK))?.slice(PUSHED_MARK.length) ?? "no check failed"
              if (verdict !== "yes") {
                kept.push(`${row.id} (${verdict.replace(/^no /, "")})`)
                continue
              }
              await this.host.dropPushed(row.id, boxId)
              entry.removed.push(`${row.id} (PR merged, nothing unpushed)`)
            }
          } finally {
            this.busy.delete(candidate.id)
          }
          if (await progress()) break
        }
        return kept.length && !entry.removed.length ? `kept ${kept.join(", ")}` : null
      }

      case "partials": {
        const out = await exec(`ls -1 ${q(root + "/tasks")} 2>/dev/null; true`)
        for (const name of out.split("\n").map((s) => s.trim())) {
          if (!/^[\w-]+$/.test(name)) continue
          // Re-read right before deleting: the task may have just been placed here.
          const row = store.getTaskRow(name)
          const why = staleTaskDir(row, boxId, Boolean(row && this.host.hasFreshArchive(row)))
          if (!why) continue
          await exec(`rm -rf ${q(this.host.taskDir(boxId, name))}`)
          if (row && row.box_id === boxId) store.updateTask(row.id, { boxId: null, portBase: null, previews: [] }, { touch: false })
          entry.removed.push(`${name} (${why})`)
        }
        // Half-written packs from a clone or fetch that died, and restore/archive temp files.
        const tmp = await exec(
          [
            `find ${q(root + "/.boxyard/repos")} ${q(root + "/tasks")} -type f -name 'tmp_pack_*' -mmin +5 -print -delete 2>/dev/null`,
            `find ${q(root + "/.boxyard")} -maxdepth 1 -name 'restore-*.tgz' -mmin +30 -print -delete 2>/dev/null`,
            `find /tmp -maxdepth 1 -name 'boxyard-archive-*.tgz' -mmin +30 -print -delete 2>/dev/null`,
            "true",
          ].join("; "),
        )
        const n = tmp.split("\n").filter(Boolean).length
        if (n) entry.removed.push(`${n} temp ${n === 1 ? "file" : "files"}`)
        if (!cloning()) {
          // A mirror git can't read is what a clone that ran out of space leaves behind.
          const broken = await exec(
            `[ -d ${q(root + "/.boxyard/repos")} ] || exit 0; for d in ${q(root + "/.boxyard/repos")}/*.git; do [ -e "$d" ] || continue; git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || { rm -rf "$d"; basename "$d"; }; done; true`,
          )
          for (const b of broken.split("\n").filter(Boolean)) entry.removed.push(`broken mirror ${b}`)
        }
        return null
      }

      case "caches": {
        // Local boxes are folders on this machine: its caches and /tmp belong to the host, not the box.
        if (provider.name === "local") return "local boxes share this machine's caches"
        const agents = onBox().some((r) => r.current_turn_id)
        const parts = [
          // Files nobody has written for two days; a running agent's temp files are newer.
          "find /tmp -xdev -mindepth 1 -type f -mtime +1 -delete 2>/dev/null",
          "find /tmp -xdev -mindepth 1 -type d -empty -mmin +60 -delete 2>/dev/null",
        ]
        // An npm install mid-turn would trip over its cache vanishing, so package caches wait for idle boxes.
        if (!agents) parts.unshift(`rm -rf "$HOME/.npm/_cacache" "$HOME/.npm/_npx" "$HOME/.cache/pip" "$HOME/.cache/yarn" "$HOME/.yarn/berry/cache" "$HOME/.cache/pnpm" "$HOME/.local/share/pnpm/store" 2>/dev/null`)
        await exec(`${parts.join("; ")}; true`)
        entry.removed.push(...(agents ? ["old /tmp files (package caches kept: agents are running)"] : ["npm, pip, yarn and pnpm caches", "old /tmp files"]))
        return null
      }

      case "builds": {
        const order = buildCleanupOrder(rows(), boxId, (id) => store.hasInputs(id))
        if (!order.length) return "no resting tasks on this box"
        const runner = await this.host.installRunner(boxId)
        for (const candidate of order) {
          this.busy.add(candidate.id)
          try {
            // Re-check under the busy mark: a turn may have started meanwhile.
            const row = store.getTaskRow(candidate.id)
            if (!row || row.box_id !== boxId || row.current_turn_id || !RESTING_STATUSES.includes(row.status) || store.hasInputs(row.id)) continue
            const dir = this.host.taskDir(boxId, row.id)
            const out = await exec(`[ -d ${q(dir + "/work")} ] || exit 0; ${q(provider.nodeBin)} ${q(runner)} clean ${q(dir)}`)
            const n = out.split("\n").filter(Boolean).length
            if (n) entry.removed.push(`${row.id}: ${n} ${n === 1 ? "dir" : "dirs"}`)
          } finally {
            this.busy.delete(candidate.id)
          }
          if (await progress()) break
        }
        return null
      }

      case "git": {
        if (cloning()) return "a task is cloning on this box"
        const keep = [...this.host.mirrorsToKeep(boxId, !opts.clear)].join(" ")
        const repos = `${root}/.boxyard/repos`
        const out = await exec(
          `[ -d ${q(repos)} ] || exit 0; for d in ${q(repos)}/*.git; do [ -e "$d" ] || continue; b=$(basename "$d"); case " ${keep} " in *" $b "*) git -C "$d" gc --prune=now --quiet >/dev/null 2>&1 && echo "gc $b";; *) rm -rf "$d" && echo "removed $b";; esac; done; true`,
        )
        entry.removed.push(...out.split("\n").filter(Boolean))
        return null
      }

      case "archive": {
        if (opts.clear) return this.archiveAll(boxId, entry)
        const order = parkOrder(rows(), boxId, (id) => store.hasInputs(id))
        if (!order.length) return "no done workspaces on this box"
        for (const candidate of order) {
          if (!this.host.hasFreshArchive(candidate)) await this.host.archive(candidate.id)
          const row = store.getTaskRow(candidate.id)
          // Only with a fresh archive: it holds the workspace, uncommitted work included.
          if (!row || row.box_id !== boxId || row.current_turn_id || row.status !== "done" || store.hasInputs(row.id) || !this.host.hasFreshArchive(row)) continue
          await this.host.park(row.id, boxId, `Workspace parked in the archive to free disk on box ${boxId}. It comes back on the next message.`)
          entry.removed.push(row.id)
          if (await progress()) break
        }
        return null
      }
    }
  }

  /** Clear box's first step: archive each workspace that isn't running, then take it off the box. */
  private async archiveAll(boxId: string, entry: CleanupStepReport): Promise<string | null> {
    const { store } = this.host
    const order = clearOrder(store.listTaskRows(), boxId)
    if (!order.length) return "no workspaces on this box"
    const kept: string[] = []
    for (const candidate of order) {
      this.busy.add(candidate.id)
      try {
        if (!this.host.hasFreshArchive(candidate)) await this.host.archive(candidate.id)
        const row = store.getTaskRow(candidate.id)
        if (!row || row.box_id !== boxId || row.current_turn_id) continue
        // A task that never ran a turn has nothing to lose; everything else leaves only with a fresh archive.
        if (row.session_started && !this.host.hasFreshArchive(row)) {
          kept.push(row.id)
          continue
        }
        await this.host.park(row.id, boxId, `Workspace archived and removed when Cody cleared box ${boxId}. It comes back from the archive on the next message.`)
        entry.removed.push(row.id)
      } finally {
        this.busy.delete(candidate.id)
      }
    }
    return kept.length ? `kept ${kept.join(", ")}: couldn't archive ${kept.length === 1 ? "it" : "them"} (${kept.map((id) => this.host.archiveProblem(id)).join("; ")})` : null
  }
}
