#!/usr/bin/env node
// Corrected usage for today and the last 7 days, split by category, next to what was logged.
// Read-only: it backs up the database to a temp file and migrates the copy.
//
//   npm run build && node scripts/usage-audit.mjs [dataDir]    (default: $BOXYARD_DATA_DIR or ./data)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const dist = path.resolve(import.meta.dirname, "../dist/server/server")
if (!fs.existsSync(path.join(dist, "store.js"))) {
  console.error("Build first: npm run build")
  process.exit(1)
}
const { openDb } = await import(path.join(dist, "db.js"))
const { Store } = await import(path.join(dist, "store.js"))
const { SettingsStore } = await import(path.join(dist, "settings.js"))

const dataDir = path.resolve(process.argv[2] ?? process.env.BOXYARD_DATA_DIR ?? "./data")
const src = path.join(dataDir, "box-yard.sqlite")
if (!fs.existsSync(src)) {
  console.error(`No database at ${src}`)
  process.exit(1)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-audit-"))
const live = new Database(src, { readonly: true, fileMustExist: true })
// What was logged before the fix: claude_usage.cost_usd summed per run (or reported_cost_usd once migrated).
const hasReported = live.prepare("SELECT 1 FROM pragma_table_info('claude_usage') WHERE name = 'reported_cost_usd'").get()
const loggedRows = live
  .prepare(`SELECT u.source, u.project_id AS projectId, t.schedule_id AS scheduleId, u.started_at AS startedAt, ${hasReported ? "u.reported_cost_usd" : "u.cost_usd"} AS logged
            FROM claude_usage u LEFT JOIN tasks t ON t.id = u.task_id`)
  .all()
await live.backup(path.join(tmp, "box-yard.sqlite"))
live.close()

const store = new Store(openDb(tmp))
const settings = new SettingsStore(store, {}).get()
const now = Date.now()
const midnight = new Date(now)
midnight.setHours(0, 0, 0, 0)
const weekStart = new Date(midnight)
weekStart.setDate(weekStart.getDate() - 6)

const category = (r) => (r.source === "task" ? (r.scheduleId ? "schedules" : "agents") : r.source === "captain" || r.projectId ? "captains" : "coordinator")
const cats = ["coordinator", "captains", "agents", "schedules", "boxes"]
const usd = (n) => `$${n.toFixed(2)}`.padStart(10)

console.log(`Data: ${src}  (time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone})\n`)
for (const [label, from] of [["Today", midnight.getTime()], ["Last 7 days", weekStart.getTime()]]) {
  const p = store.usagePeriod(from, now, settings.costRates)
  const logged = Object.fromEntries(cats.map((c) => [c, 0]))
  for (const r of loggedRows) if (r.startedAt >= from && r.startedAt < now) logged[category(r)] += r.logged
  logged.boxes = p.categories.boxes.costUsd
  console.log(`${label} (since ${new Date(from).toLocaleString()})`)
  console.log(`  ${"".padEnd(14)}${"corrected".padStart(10)}${"logged".padStart(10)}  turns`)
  for (const c of cats) console.log(`  ${c.padEnd(14)}${usd(p.categories[c].costUsd)}${usd(logged[c])}  ${c === "boxes" ? "" : p.categories[c].turns}`)
  console.log(`  ${"total".padEnd(14)}${usd(p.totalCostUsd)}${usd(cats.reduce((a, c) => a + logged[c], 0))}\n`)
}
fs.rmSync(tmp, { recursive: true, force: true })
