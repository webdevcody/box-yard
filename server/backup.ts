import { Box } from "@upstash/box"
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
