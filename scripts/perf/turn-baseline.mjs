#!/usr/bin/env node
// The live baseline for Coordinator ↔ Captain speed, from data Box Yard already keeps (before turn_timings existed):
// claude_usage runs, chat_messages and captain_messages timestamps, and the CLI's session logs. Read-only: it opens the
// database read-only and never writes to it or to the session logs.
//
//   node scripts/perf/turn-baseline.mjs [dataDir] [--days 14] [--sessions ~/.claude/projects] [--split 2026-10-28T12:00Z ...] [--json out.json]
//
// dataDir defaults to $BOXYARD_DATA_DIR or ./data (it reads <dataDir>/box-yard.sqlite; a .backup copy works too).
// --split: dates to compare before and after (a settings change, such as captainEffort or the auto-compact threshold).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const args = process.argv.slice(2)
const take = (name) => {
  const out = []
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) out.push(args.splice(i, 2)[1])
  return out
}
const days = Number(take("--days")[0] ?? 14)
const sessionsDir = take("--sessions")[0] ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects")
const splits = take("--split").map((s) => ({ label: s, at: Date.parse(s) }))
const jsonOut = take("--json")[0]
const dataDir = path.resolve(args[0] ?? process.env.BOXYARD_DATA_DIR ?? "./data")
const file = fs.existsSync(dataDir) && fs.statSync(dataDir).isFile() ? dataDir : path.join(dataDir, "box-yard.sqlite")
if (!fs.existsSync(file)) {
  console.error(`No database at ${file}`)
  process.exit(1)
}
const db = new Database(file, { readonly: true, fileMustExist: true })
const since = Date.now() - days * 86_400_000

// ---------------------------------------------------------------- helpers

const json = (s) => {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}
function q(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const at = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v.at(-1), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }
}
const fmt = (ms) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`)
const row = (label, v) => {
  const x = q(v)
  return x ? `| ${label} | ${fmt(x.p50)} | ${fmt(x.p95)} | ${fmt(x.mean)} | ${x.n} |` : `| ${label} | – | – | – | 0 |`
}
const HEAD = ["| | p50 | p95 | mean | n |", "|---|---:|---:|---:|---:|"]
const out = []
const data = { file, days, splits }

// ---------------------------------------------------------------- runs (claude_usage)

const runs = db
  .prepare(
    `SELECT id, source, run_kind AS kind, project_id AS projectId, session_id AS sessionId, model, started_at AS startedAt, ended_at AS endedAt,
            duration_ms AS cliMs, input_tokens AS input, cache_creation_input_tokens AS cacheWrite, cache_read_input_tokens AS cacheRead, output_tokens AS output
     FROM claude_usage WHERE started_at >= ? AND source IN ('orchestrator', 'captain') ORDER BY started_at`,
  )
  .all(since)
  .map((r) => ({ ...r, wallMs: r.endedAt - r.startedAt, prompt: r.input + r.cacheWrite + r.cacheRead }))
data.runs = runs.length

out.push(`# Coordinator ↔ Captain baseline (live data, last ${days} days)`, "", `Database: ${file}`, "")
out.push("## Runs (claude_usage)", "", "wall = server spawn → process exit; CLI = the CLI's own duration_ms; overhead = wall − CLI (start-up, MCP connect, exit).", "")
out.push(...HEAD)
for (const source of ["orchestrator", "captain"]) {
  for (const kind of [...new Set(runs.filter((r) => r.source === source).map((r) => r.kind))]) {
    const mine = runs.filter((r) => r.source === source && r.kind === kind)
    const who = source === "orchestrator" ? "Coordinator" : "Captain"
    out.push(row(`${who} ${kind}: wall`, mine.map((r) => r.wallMs)))
    out.push(row(`${who} ${kind}: CLI`, mine.map((r) => r.cliMs || null)))
    out.push(row(`${who} ${kind}: overhead`, mine.map((r) => (r.cliMs ? r.wallMs - r.cliMs : null))))
  }
}
out.push("")
out.push("Prompt tokens per run (input + cache read + cache write, summed over the run's API calls) and the share read from cache:", "")
out.push("| | prompt p50 | prompt p95 | cache read share | cache write per run p50 | output p50 | n |", "|---|---:|---:|---:|---:|---:|---:|")
for (const source of ["orchestrator", "captain"]) {
  const mine = runs.filter((r) => r.source === source && r.kind === "turn")
  const p = q(mine.map((r) => r.prompt))
  const read = mine.reduce((n, r) => n + r.cacheRead, 0)
  const all = mine.reduce((n, r) => n + r.prompt, 0)
  if (p)
    out.push(
      `| ${source === "orchestrator" ? "Coordinator" : "Captain"} | ${Math.round(p.p50 / 1000)}k | ${Math.round(p.p95 / 1000)}k | ${all ? ((read / all) * 100).toFixed(1) : "–"}% | ${Math.round((q(mine.map((r) => r.cacheWrite))?.p50 ?? 0) / 1000)}k | ${q(mine.map((r) => r.output))?.p50 ?? "–"} | ${p.n} |`,
    )
}
out.push("")

// ---------------------------------------------------------------- what each run waited for

const chat = db
  .prepare("SELECT id, role, meta_json AS meta, created_at AS at FROM chat_messages WHERE created_at >= ? ORDER BY created_at")
  .all(since - 3_600_000)
  .map((m) => ({ ...m, meta: json(m.meta) }))
const inbound = db
  .prepare("SELECT id, project_id AS projectId, role, meta_json AS meta, created_at AS at FROM captain_messages WHERE created_at >= ? ORDER BY created_at")
  .all(since - 3_600_000)
  .map((m) => ({ ...m, meta: json(m.meta) }))

/** The oldest message a run answered: the first one after the previous run of the same agent ended. */
function trigger(run, prev, messages) {
  const from = prev ? prev.endedAt : run.startedAt - 600_000
  return messages.find((m) => m.at > from && m.at <= run.startedAt) ?? null
}
const kindOf = (m, coordinator) =>
  !m ? "none" : m.role === "notice" ? "update" : m.meta?.scheduleId ? "schedule" : m.meta?.source === "hook" ? "hook" : coordinator ? "cody" : (m.meta?.source ?? "cody")

const waits = []
const coordRuns = runs.filter((r) => r.source === "orchestrator" && r.kind === "turn")
coordRuns.forEach((r, i) => {
  const m = trigger(
    r,
    coordRuns[i - 1],
    chat.filter((x) => x.role === "user" || x.role === "notice"),
  )
  waits.push({ who: "Coordinator", run: r, by: kindOf(m, true), queueMs: m ? r.startedAt - m.at : null, totalMs: m ? r.endedAt - m.at : null })
})
for (const pid of [...new Set(runs.filter((r) => r.source === "captain").map((r) => r.projectId))]) {
  const mine = runs.filter((r) => r.source === "captain" && r.kind === "turn" && r.projectId === pid)
  const msgs = inbound.filter((m) => m.projectId === pid && (m.role === "user" || m.role === "notice"))
  mine.forEach((r, i) => {
    const m = trigger(r, mine[i - 1], msgs)
    waits.push({ who: "Captain", run: r, by: kindOf(m, false), queueMs: m ? r.startedAt - m.at : null, totalMs: m ? r.endedAt - m.at : null })
  })
}
out.push("## Queue: asked for → run started", "", "By what woke the run. An update is a task or Captain notice; its wait includes the wake debounce (Coordinator 4 s, Captain 3 s).", "")
out.push(...HEAD)
for (const who of ["Coordinator", "Captain"]) {
  for (const by of [...new Set(waits.filter((w) => w.who === who).map((w) => w.by))].sort()) {
    const w = waits.filter((x) => x.who === who && x.by === by)
    out.push(row(`${who}, from ${by}: queue`, w.map((x) => x.queueMs)))
    out.push(row(`${who}, from ${by}: asked → done`, w.map((x) => x.totalMs)))
  }
}
out.push("")

// ---------------------------------------------------------------- round trips

// send_to_captain / ask_captain → the Captain's run → its reply notice on the Coordinator chat → the Coordinator's run on it.
const trips = []
for (const sent of inbound.filter((m) => m.role === "user" && m.meta?.source === "coordinator" && m.at >= since)) {
  const cap = runs.find((r) => r.source === "captain" && r.kind === "turn" && r.projectId === sent.projectId && r.startedAt >= sent.at - 50)
  const notice = chat.find((m) => m.role === "notice" && Array.isArray(m.meta?.replyTo) && m.meta.replyTo.includes(sent.id))
  const wake = notice ? coordRuns.find((r) => r.startedAt >= notice.at - 50) : null
  trips.push({
    tool: sent.meta?.tool ?? "?",
    captainQueueMs: cap ? cap.startedAt - sent.at : null,
    captainWallMs: cap ? cap.wallMs : null,
    toReplyMs: notice ? notice.at - sent.at : null,
    wakeQueueMs: notice && wake ? wake.startedAt - notice.at : null,
    wakeWallMs: wake ? wake.wallMs : null,
    toDoneMs: wake ? wake.endedAt - sent.at : null,
  })
}
data.trips = trips
out.push("## Round trips: Coordinator → Captain → reply → Coordinator", "", `${trips.length} messages the Coordinator sent a Captain (send_to_captain, ask_captain).`, "")
out.push(...HEAD)
out.push(row("sent → Captain run starts", trips.map((t) => t.captainQueueMs)))
out.push(row("Captain run (wall)", trips.map((t) => t.captainWallMs)))
out.push(row("sent → reply on the Coordinator chat", trips.map((t) => t.toReplyMs)))
out.push(row("reply → Coordinator run starts", trips.map((t) => t.wakeQueueMs)))
out.push(row("Coordinator run on the reply (wall)", trips.map((t) => t.wakeWallMs)))
out.push(row("sent → Coordinator done with the reply", trips.map((t) => t.toDoneMs)))
out.push("")

// Cody → the Coordinator's first reply.
const replies = []
for (const m of chat.filter((x) => x.role === "user" && !x.meta?.scheduleId && x.meta?.source !== "hook" && x.at >= since)) {
  const r = chat.find((x) => x.at > m.at && x.role === "assistant")
  if (r && r.at - m.at < 30 * 60_000) replies.push(r.at - m.at)
}
out.push("## Cody → the Coordinator's reply", "", ...HEAD, row("message → first reply", replies), "")

// ---------------------------------------------------------------- before / after a change

if (splits.length) {
  out.push("## Before and after", "", "| Change | Runs | wall p50 before → after | CLI p50 before → after | prompt p50 before → after | n before / after |", "|---|---|---|---|---|---|")
  for (const s of splits) {
    for (const source of ["orchestrator", "captain"]) {
      const mine = runs.filter((r) => r.source === source && r.kind === "turn")
      const a = mine.filter((r) => r.startedAt < s.at)
      const b = mine.filter((r) => r.startedAt >= s.at)
      const p = (v, k) => fmt(q(v.map((r) => r[k]))?.p50)
      const tok = (v) => `${Math.round((q(v.map((r) => r.prompt))?.p50 ?? 0) / 1000)}k`
      out.push(`| ${s.label} | ${source === "orchestrator" ? "Coordinator" : "Captain"} | ${p(a, "wallMs")} → ${p(b, "wallMs")} | ${p(a, "cliMs")} → ${p(b, "cliMs")} | ${tok(a)} → ${tok(b)} | ${a.length} / ${b.length} |`)
    }
    for (const kind of ["summary", "compact"]) {
      const mine = runs.filter((r) => r.kind === kind)
      const a = mine.filter((r) => r.startedAt < s.at)
      const b = mine.filter((r) => r.startedAt >= s.at)
      if (mine.length) out.push(`| ${s.label} | ${kind} passes | ${fmt(q(a.map((r) => r.wallMs))?.p50)} → ${fmt(q(b.map((r) => r.wallMs))?.p50)} | | | ${a.length} / ${b.length} |`)
    }
  }
  out.push("")
}

// ---------------------------------------------------------------- model steps (session logs)

/** tool_result or prompt → the next assistant message's first line, per API call, with its context and cache use. */
function sessionSteps(f) {
  const steps = []
  let lastUser = null
  let lastAssistant = null
  const seen = new Set()
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.isSidechain || !r.timestamp) continue
    const at = Date.parse(r.timestamp)
    if (r.type === "user") {
      if (lastUser === null) lastUser = { at, idle: lastAssistant === null ? null : at - lastAssistant }
      continue
    }
    if (r.type !== "assistant") continue
    const m = r.message ?? {}
    lastAssistant = at
    if (seen.has(m.id) || m.model === "<synthetic>") continue
    seen.add(m.id)
    const u = m.usage ?? {}
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (lastUser) steps.push({ ms: at - lastUser.at, idleBefore: lastUser.idle, ctx, write: u.cache_creation_input_tokens ?? 0, at })
    lastUser = null
  }
  return steps
}
function findSession(id) {
  if (!id || !fs.existsSync(sessionsDir)) return null
  for (const d of fs.readdirSync(sessionsDir)) {
    const f = path.join(sessionsDir, d, `${id}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}
const steps = { Coordinator: [], Captain: [] }
for (const [who, source] of [
  ["Coordinator", "orchestrator"],
  ["Captain", "captain"],
]) {
  for (const id of new Set(runs.filter((r) => r.source === source).map((r) => r.sessionId))) {
    const f = findSession(id)
    if (f) steps[who].push(...sessionSteps(f).filter((s) => s.at >= since))
  }
}
data.steps = { Coordinator: steps.Coordinator.length, Captain: steps.Captain.length }
out.push("## Model steps (session logs)", "", `From ${sessionsDir}. A step: the prompt or a tool result → the first line of the next reply (prefill, thinking, the first block).`, "")
if (!steps.Coordinator.length && !steps.Captain.length) out.push("No session logs found for these runs (pass --sessions).", "")
else {
  out.push(...HEAD)
  for (const who of ["Coordinator", "Captain"]) {
    const s = steps[who]
    if (!s.length) continue
    for (const [lo, hi] of [
      [0, 50e3],
      [50e3, 100e3],
      [100e3, 150e3],
      [150e3, 200e3],
      [200e3, 1e9],
    ])
      out.push(row(`${who}, context ${lo / 1000}k–${hi < 1e9 ? `${hi / 1000}k` : "…"}`, s.filter((x) => x.ctx >= lo && x.ctx < hi).map((x) => x.ms)))
    // The prompt cache lives 5 minutes: a turn after a longer idle writes its whole prefix again.
    out.push(row(`${who}, first step after ≤ 5 min idle`, s.filter((x) => x.idleBefore !== null && x.idleBefore <= 300_000).map((x) => x.ms)))
    out.push(row(`${who}, first step after > 5 min idle`, s.filter((x) => x.idleBefore !== null && x.idleBefore > 300_000).map((x) => x.ms)))
    const cold = s.filter((x) => x.idleBefore !== null && x.idleBefore > 300_000)
    if (cold.length) out.push(`| ${who}: cache written on those cold steps (p50) | ${Math.round((q(cold.map((x) => x.write))?.p50 ?? 0) / 1000)}k tokens | | | ${cold.length} |`)
  }
  out.push("")
}

console.log(out.join("\n"))
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ...data, waits: waits.map((w) => ({ who: w.who, by: w.by, queueMs: w.queueMs, totalMs: w.totalMs, wallMs: w.run.wallMs, cliMs: w.run.cliMs, prompt: w.run.prompt })), steps }, null, 2))
db.close()
