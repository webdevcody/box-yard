import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { TURN_SH } from "./turnProcess.js"

/** Who holds a data folder: `<dataDir>/server.lock`. */
export interface DataLockHolder {
  pid: number
  /** "<boot>|<start>" of that process (by_boot/by_start in server/turnProcess.ts), so a reused pid isn't taken for it. */
  ident: string | null
  host: string
  port: number
  at: number
}

export interface DataLock {
  /** Remove the lock, if it is still this process's. */
  release(): void
}

export class DataDirLockedError extends Error {
  constructor(
    readonly holder: DataLockHolder,
    readonly dataDir: string,
  ) {
    super(
      `Another Box Yard (pid ${holder.pid}, http://${holder.host}:${holder.port}, started ${new Date(holder.at).toLocaleString()}) is using the data folder ${dataDir}. ` +
        `Stop it first, or point BOXYARD_DATA_DIR at another folder. Two servers on one database would both run every task.`,
    )
  }
}

/** A process's "<boot>|<start>", or null when this system can't say. */
export function processIdent(pid: number): string | null {
  try {
    const out = execFileSync("sh", ["-c", `${TURN_SH}\nprintf '%s|%s' "$(by_boot)" "$(by_start "$1")"`, "sh", String(pid)], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return /\|./.test(out) ? out : null
  } catch {
    return null
  }
}

/** Whether the lock's holder is still the process that took it (alive, same boot and start time). */
function holds(holder: DataLockHolder): boolean {
  try {
    process.kill(holder.pid, 0)
  } catch {
    // Gone, or (EPERM) another user's process has that pid now: no Box Yard holds this folder.
    return false
  }
  if (!holder.ident) return true
  const now = processIdent(holder.pid)
  return now === null || now === holder.ident
}

function readHolder(file: string): DataLockHolder | null {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")) as DataLockHolder
    return typeof h?.pid === "number" ? h : null
  } catch {
    return null
  }
}

/**
 * One Box Yard per data folder. Two servers on one database would both poll every running turn, start every queued
 * task and apply the same events twice, so the second one doesn't start. A lock left by a server that's gone (killed,
 * or the machine restarted) is taken over. One that's still held is waited on for `waitMs` first: on a restart the
 * old server may still be shutting down.
 */
export async function lockDataDir(dataDir: string, where: { host: string; port: number }, opts: { waitMs?: number } = {}): Promise<DataLock> {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, "server.lock")
  const me: DataLockHolder = { pid: process.pid, ident: processIdent(process.pid), host: where.host, port: where.port, at: Date.now() }
  const until = Date.now() + (opts.waitMs ?? 10_000)
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(me), { flag: "wx" })
      if (readHolder(file)?.pid === process.pid) break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
    const holder = readHolder(file)
    // Unreadable: another server is writing it right now, or one died mid-write a while ago.
    const torn = !holder && Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 2_000
    if (torn || (holder && (holder.pid === process.pid || !holds(holder)))) {
      // This process's own (a restart in place), or its server is gone: take it over.
      fs.rmSync(file, { force: true })
      continue
    }
    if (!holder) {
      await new Promise((r) => setTimeout(r, 100))
      continue
    }
    if (Date.now() >= until) throw new DataDirLockedError(holder, dataDir)
    await new Promise((r) => setTimeout(r, 200))
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      if (readHolder(file)?.pid === process.pid) fs.rmSync(file, { force: true })
    },
  }
}
