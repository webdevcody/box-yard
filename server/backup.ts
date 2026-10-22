import { Box } from "@upstash/box"
import { execFile } from "node:child_process"
import type { Config } from "./config.js"
import { checkpoint, type DB } from "./db.js"
import { errorMessage } from "./util/retry.js"

const PREFIX = "box-yard-auto"
const KEEP = 3

/**
 * When Box Yard itself runs in an Upstash Box, snapshot that box every few
 * hours. The SQLite file already lives on the box's persistent disk; the
 * snapshots are the off-box copy to restore from if the box is ever lost
 * (`npm run deploy:box -- --from-snapshot <id>`).
 */
export function startSelfSnapshots(c: Config, db: DB): (() => void) | null {
  if (!c.selfBoxId || !c.upstashBoxApiKey || c.selfSnapshotHours <= 0) return null
  const run = async () => {
    try {
      checkpoint(db)
      const box = await Box.get(c.selfBoxId, { apiKey: c.upstashBoxApiKey })
      const snap = await box.snapshot({ name: `${PREFIX}-${new Date().toISOString().replace(/[:.]/g, "-")}` })
      console.log(`[box-yard] self snapshot ${snap.id} (${Math.round(snap.size_bytes / 1e6)} MB)`)
      const old = (await box.listSnapshots())
        .filter((s) => s.name.startsWith(PREFIX) && s.status === "ready")
        .sort((a, b) => b.created_at - a.created_at)
        .slice(KEEP)
      for (const s of old) await box.deleteSnapshot(s.id).catch(() => {})
    } catch (err) {
      console.warn(`[box-yard] self snapshot failed: ${errorMessage(err)}`)
    }
  }
  const timer = setInterval(run, c.selfSnapshotHours * 3600_000)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * On a box without keep-alive (the free plan), the box pauses when idle. While
 * Box Yard has work in flight (agents running or queued, the orchestrator
 * mid-turn, schedules due soon with no QStash to wake us), hold an exec stream
 * open on our own box so it stays up. When the work is done the stream closes
 * and the box may pause; its public URL wakes it again, and the init command
 * restarts the server, which reattaches to running agents.
 */
export function startSelfHold(c: Config, isBusy: () => boolean): (() => void) | null {
  if (!c.selfBoxId || !c.upstashBoxApiKey || !c.selfHold) return null
  // Cancelling an exec stream does not stop the process in the box, so the hold
  // command ends by itself after 10 minutes (it's reopened while still busy),
  // and we kill it by its marker when the work is done. We run inside that box.
  const MARKER = "boxyard-self-hold"
  const killHolds = () => execFile("pkill", ["-f", MARKER], () => {})
  let active = false
  let opening = false
  let stopped = false
  killHolds() // leftovers from a previous server process
  const open = async () => {
    opening = true
    try {
      const box = await Box.get(c.selfBoxId, { apiKey: c.upstashBoxApiKey })
      const run = await box.exec.stream(`bash -c ": ${MARKER}; for i in \$(seq 1 40); do sleep 15; echo .; done"`)
      active = true
      console.log("[box-yard] work in flight: holding this box awake")
      void (async () => {
        try {
          for await (const _chunk of run) if (stopped || !active) break
        } catch {}
        active = false
      })()
    } catch (err) {
      console.warn(`[box-yard] self hold failed: ${errorMessage(err)}`)
    } finally {
      opening = false
    }
  }
  const tick = () => {
    if (stopped) return
    const busy = isBusy()
    if (busy && !active && !opening) void open()
    if (!busy && active) {
      active = false
      console.log("[box-yard] idle: releasing the box so it can pause")
      killHolds()
    }
  }
  const timer = setInterval(tick, 10_000)
  timer.unref()
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
    killHolds()
  }
}
