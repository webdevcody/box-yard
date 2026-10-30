import type { Store, TaskRow } from "./store.js"
import type { BoxProvider } from "./providers/types.js"
import { providerOf, q } from "./providers/types.js"
import { errorMessage } from "./util/retry.js"
import type { TaskStatus } from "../shared/types.js"
import { formatBytes, type DiskSpace } from "../shared/disk.js"
import { pushedCheck, pushedVerdict } from "./janitor.js"

// Task folders on Cody's own computers: this one (the local runner) and his SSH machines. Neither is a `boxes` row,
// so the box janitor's sweeps (routine build cleanup, low-disk, idle box deletion, retention parking) never see them
// (shared/runner.ts, shared/machines.ts). This cleans them with Settings of their own, since a laptop's disk isn't a
// throwaway box: build output goes once a task's work is pushed, the oldest finished folders leave past Task folders
// kept, and a low disk frees the oldest finished folders first. A folder with anything uncommitted, stashed or
// unpushed is never touched, and one leaves only with a fresh archive (or, done with a merged PR, with GitHub holding
// all of it). Repo mirrors are never touched here, so objects task clones borrow (gitShare.ts) stay.

/** How often maintain() looks at each computer. */
export const OWN_UPKEEP_MS = 2 * 60_000
/** After a low-disk run that couldn't get back above the floor, don't run another for this long. */
export const OWN_LOW_DISK_COOLDOWN_MS = 10 * 60_000
/** A folder whose work wasn't all pushed is checked again after this long (or as soon as the task is active again). */
export const OWN_RECHECK_MS = 30 * 60_000
const GB = 1024 ** 3

/**
 * Statuses whose folders may be cleaned. Never running, starting or queued ones, and never one waiting for an answer
 * (needs_input, waiting): those are mid-work.
 */
export const OWN_CLEANUP_STATUSES: TaskStatus[] = ["done", "idle", "pr_ready", "failed"]

export interface OwnCleanupSettings {
  /** Task folders kept per computer. 0 = no limit. */
  foldersKept: number
  buildCleanup: boolean
  buildCleanupIdleHours: number
  /** 0 = off. */
  minFreeGb: number
}

/** A task's live previews (a dev server in its folder): only a done one's build output and folder may go then. */
const hasPreviews = (r: TaskRow) => r.previews_json !== "[]" && r.previews_json !== ""

/**
 * Folders on `boxId` that may be cleaned, done ones first, then least recently active: resting in OWN_CLEANUP_STATUSES,
 * no turn, nothing queued (`wantsTurn`), and no live preview unless done.
 */
export function ownCleanupOrder(rows: TaskRow[], boxId: string, wantsTurn: (r: TaskRow) => boolean): TaskRow[] {
  return rows
    .filter((r) => r.box_id === boxId && cleanable(r, wantsTurn))
    .sort((a, b) => Number(b.status === "done") - Number(a.status === "done") || a.last_active_at - b.last_active_at)
}

function cleanable(r: TaskRow, wantsTurn: (r: TaskRow) => boolean): boolean {
  return !r.current_turn_id && OWN_CLEANUP_STATUSES.includes(r.status) && !wantsTurn(r) && (r.status === "done" || !hasPreviews(r))
}

/** Whose build output is due: a done task's at once, another resting one's after `idleHours`. */
export function buildsDue(rows: TaskRow[], boxId: string, idleHours: number, now: number, wantsTurn: (r: TaskRow) => boolean): TaskRow[] {
  return ownCleanupOrder(rows, boxId, wantsTurn).filter((r) => r.status === "done" || (idleHours > 0 && now - r.last_active_at >= idleHours * 60 * 60_000))
}

/** What the cleanup needs from the task manager. */
export interface OwnCleanupHost {
  store: Store
  provider: BoxProvider
  settings(): OwnCleanupSettings
  stopped(): boolean
  /** df where the box's task folders are (fresh), or null if it can't tell. */
  probe(boxId: string): Promise<DiskSpace | null>
  taskDir(boxId: string, taskId: string): string
  installRunner(boxId: string): Promise<string>
  wantsTurn(row: TaskRow): boolean
  /** A turn-end archive or a box cleanup is working on this task right now. */
  occupied(taskId: string): boolean
  /** Archive the task's folder (on this computer too, which keeps none otherwise). */
  archive(taskId: string): Promise<void>
  hasFreshArchive(row: TaskRow): boolean
  park(taskId: string, boxId: string, note: string): Promise<void>
  dropPushed(taskId: string, boxId: string): Promise<void>
  /** "this computer", "SSH machine tower". */
  where(boxId: string): string
}

export class OwnCleanup {
  /** Tasks whose folder a step is working in right now; they don't start a turn until it's done. */
  private busy = new Set<string>()
  private running = new Set<string>()
  private lowDiskAt = new Map<string, number>()
  /** Per task: the last_active_at its build output was looked at, and when to look again (Infinity: it's done). */
  private looked = new Map<string, { activeAt: number; until: number }>()

  constructor(private readonly host: OwnCleanupHost) {}

  isBusy(taskId: string) {
    return this.busy.has(taskId)
  }

  /** One pass on a computer: build output that's due, then Task folders kept, then the low-disk floor. */
  async upkeep(boxId: string, now = Date.now()): Promise<void> {
    if (this.running.has(boxId)) return
    this.running.add(boxId)
    try {
      const s = this.host.settings()
      if (s.buildCleanup) {
        const rows = this.host.store.listTaskRows({ boxId })
        for (const r of buildsDue(rows, boxId, s.buildCleanupIdleHours, now, (x) => this.host.wantsTurn(x))) {
          if (this.host.stopped()) return
          const seen = this.looked.get(r.id)
          if (seen && seen.activeAt === r.last_active_at && now < seen.until) continue
          await this.stripBuilds(boxId, r.id, now)
        }
      }
      if (s.foldersKept > 0) await this.trimFolders(boxId, s.foldersKept)
      if (s.minFreeGb > 0) await this.lowDisk(boxId, s.minFreeGb * GB, now)
    } catch (err) {
      console.warn(`[box-yard] cleanup on ${this.host.where(boxId)}: ${errorMessage(err)}`)
    } finally {
      this.running.delete(boxId)
    }
  }

  /** Re-read under the busy mark: still on this computer, resting and wanting nothing. */
  private stillCleanable(boxId: string, taskId: string): TaskRow | null {
    const row = this.host.store.getTaskRow(taskId)
    return row && row.box_id === boxId && cleanable(row, (x) => this.host.wantsTurn(x)) && !this.host.occupied(taskId) ? row : null
  }

  private async withBusy<T>(taskId: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy.has(taskId) || this.host.occupied(taskId)) return null
    this.busy.add(taskId)
    try {
      return await fn()
    } finally {
      this.busy.delete(taskId)
    }
  }

  private async exec(boxId: string, cmd: string) {
    const res = await providerOf(this.host.provider, boxId).exec(boxId, cmd)
    if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim().slice(-300) || `exit ${res.exitCode}`)
    return res.stdout
  }

  /** "yes", or why its folder holds work GitHub doesn't have. */
  private async pushed(boxId: string, taskId: string) {
    return pushedVerdict(await this.exec(boxId, pushedCheck(`${this.host.taskDir(boxId, taskId)}/work`)).catch((err) => `no check failed: ${errorMessage(err)}`))
  }

  /**
   * Remove a task's git-ignored dependency and build output (`clean <dir> builds`) once everything in it is pushed.
   * Returns the dirs removed, or null when it was left alone.
   */
  async stripBuilds(boxId: string, taskId: string, now = Date.now()): Promise<string[] | null> {
    return this.withBusy(taskId, async () => {
      const row = this.stillCleanable(boxId, taskId)
      if (!row) return null
      const verdict = await this.pushed(boxId, taskId)
      if (verdict !== "yes") {
        this.looked.set(taskId, { activeAt: row.last_active_at, until: now + OWN_RECHECK_MS })
        return null
      }
      const provider = providerOf(this.host.provider, boxId)
      const runner = await this.host.installRunner(boxId)
      const dir = this.host.taskDir(boxId, taskId)
      const out = await this.exec(boxId, `[ -d ${q(dir + "/work")} ] || exit 0; ${q(provider.nodeBin)} ${q(runner)} clean ${q(dir)} builds`)
      this.looked.set(taskId, { activeAt: row.last_active_at, until: Infinity })
      const dirs = out.split("\n").filter(Boolean)
      if (dirs.length) console.log(`[box-yard] freed build output of ${taskId} on ${this.host.where(boxId)}: ${dirs.join(", ")}`)
      return dirs
    })
  }

  /**
   * Take a finished folder off the computer, only when everything in it is pushed (checked before and again right
   * before it goes). It's archived first, so its next message restores it with its session; a done task with a
   * merged PR whose archive can't be made leaves without one (GitHub has it all; it resumes from a recap).
   */
  async removeFolder(boxId: string, taskId: string, why: string): Promise<boolean> {
    const done = await this.withBusy(taskId, async () => {
      if (!this.stillCleanable(boxId, taskId)) return false
      if ((await this.pushed(boxId, taskId)) !== "yes") return false
      const before = this.host.store.getTaskRow(taskId)
      if (before && !this.host.hasFreshArchive(before)) await this.host.archive(taskId).catch(() => {})
      if (this.host.stopped()) return false
      const row = this.stillCleanable(boxId, taskId)
      if (!row || (await this.pushed(boxId, taskId)) !== "yes") return false
      if (this.host.hasFreshArchive(row)) {
        await this.host.park(taskId, boxId, `Workspace parked in the archive ${why}. It comes back on the next message.`)
        return true
      }
      if (row.status === "done" && row.pr_state === "merged") {
        await this.host.dropPushed(taskId, boxId)
        return true
      }
      return false
    })
    if (done) {
      this.looked.delete(taskId)
      console.log(`[box-yard] removed the folder of ${taskId} from ${this.host.where(boxId)} ${why}`)
    }
    return Boolean(done)
  }

  /** More folders than Task folders kept: the oldest finished ones leave until it fits (or nothing else may go). */
  private async trimFolders(boxId: string, kept: number) {
    const rows = this.host.store.listTaskRows({ boxId })
    let excess = rows.length - kept
    if (excess <= 0) return
    for (const r of ownCleanupOrder(rows, boxId, (x) => this.host.wantsTurn(x))) {
      if (excess <= 0 || this.host.stopped()) return
      if (await this.removeFolder(boxId, r.id, `to keep at most ${kept} task folders on ${this.host.where(boxId)}`)) excess--
    }
  }

  /**
   * Below the floor: free the build output of every folder that may be cleaned (oldest finished first), then remove the
   * oldest finished folders, re-measuring after each, until there is `need` free again.
   */
  private async lowDisk(boxId: string, need: number, now: number) {
    if (now - (this.lowDiskAt.get(boxId) ?? 0) < OWN_LOW_DISK_COOLDOWN_MS) return
    let space = await this.host.probe(boxId)
    if (!space || space.freeBytes >= need) return
    this.lowDiskAt.set(boxId, now)
    const where = this.host.where(boxId)
    console.log(`[box-yard] ${where} is low on disk: ${formatBytes(space.freeBytes)} free, under the ${formatBytes(need)} Settings keeps free`)
    const enough = async () => {
      space = (await this.host.probe(boxId)) ?? space
      return Boolean(space && space.freeBytes >= need)
    }
    const order = () => ownCleanupOrder(this.host.store.listTaskRows({ boxId }), boxId, (x) => this.host.wantsTurn(x))
    for (const r of order()) {
      if (this.host.stopped()) return
      const seen = this.looked.get(r.id)
      if (seen?.activeAt === r.last_active_at && seen.until === Infinity) continue
      if ((await this.stripBuilds(boxId, r.id, now))?.length && (await enough())) {
        this.lowDiskAt.delete(boxId)
        return
      }
    }
    for (const r of order()) {
      if (this.host.stopped()) return
      if ((await this.removeFolder(boxId, r.id, `to free disk on ${where}`)) && (await enough())) {
        this.lowDiskAt.delete(boxId)
        return
      }
    }
    console.warn(`[box-yard] ${where} is still low on disk (${formatBytes(space?.freeBytes ?? 0)} free): no other task folder may be cleaned safely`)
  }
}
