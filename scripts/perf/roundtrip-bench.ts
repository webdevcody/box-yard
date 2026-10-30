// Box Yard's own overhead on a Coordinator → Captain → reply round trip, with fake-claude standing in for the model.
// Every model step is near zero here, so what's left is Box Yard: queues and wake debounces, process start, the MCP
// handshake and tool calls, and the hops between the Coordinator and a Captain. Rerun it before and after a change.
//
//   npx tsx scripts/perf/roundtrip-bench.ts [rounds=8] [--port 4001] [--json out.json] [--claude "<cmd>"] [--keep]
//     [--message "status {i} [fyi]"] [--exit-ms 700]
//
// --message is what Cody asks the Captain ({i} is the trip number); with [fyi] fake-claude's Captain marks its reply FYI.
// --exit-ms holds fake-claude between its result line and exiting, like the real CLI's 400–1,000 ms exit tail.
//
// It runs its own server (in a temp data dir, on --port) and never touches a live one.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { config as baseConfig, type Config } from "../../server/config.js"
import { createBoxYard } from "../../server/app.js"
import { buildMcpServer } from "../../server/mcp.js"
import { formatMs, quantiles, TURN_STAGES, type TurnTiming } from "../../shared/turnTimings.js"
import type { ChatMessage, Project } from "../../shared/types.js"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const port = Number(opt("--port") ?? 4001)
const jsonOut = opt("--json")
const claudeBin = opt("--claude") ?? `${process.execPath} ${path.resolve("scripts/fake-claude.mjs")}`
const keep = args.includes("--keep") ? (args.splice(args.indexOf("--keep"), 1), true) : false
const message = opt("--message") ?? "status {i}"
const exitMs = opt("--exit-ms")
if (exitMs) process.env.FAKE_CLAUDE_EXIT_MS = exitMs
const rounds = Number(args[0] ?? 8)
process.env.FAKE_CLAUDE_WORD_MS ??= "1"

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-bench-"))
const c: Config = {
  ...baseConfig,
  dataDir,
  localDir: path.join(dataDir, "local-workspaces"),
  host: "127.0.0.1",
  port,
  password: "",
  provider: "local",
  upstashBoxApiKey: "",
  redisUrl: "",
  redisToken: "",
  claudeOauthToken: "",
  anthropicApiKey: "",
  githubToken: "",
  elevenlabsApiKey: "",
  openaiApiKey: "",
  ttsProvider: "",
  claudeBin,
  mock: true,
  orchestratorAutoWake: true,
  selfBoxId: "",
  diskMinFreeMb: 0,
  memoryMaxUsedPercent: 0,
  memoryMinFreeMb: 0,
  loadMaxPerCpu: 0,
}

const yard = createBoxYard(c, { webDir: "/nonexistent" })
const server = await new Promise<Server>((resolve) => {
  const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
})
await yard.start()
const base = `http://127.0.0.1:${port}`

async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}
async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 60_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const idle = async (p: Project) => {
  await until(async () => !(await call<{ busy: boolean }>("GET", "/api/orchestrator")).busy, "Coordinator idle")
  await until(async () => !(await call<{ busy: boolean }>("GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle")
}

interface Trip {
  /** Cody's message posted → the Captain's reply notice on the Coordinator chat. */
  toCaptainReplyMs: number
  /** → the Coordinator's automatic turn on that reply ended (null: the reply didn't wake it). */
  toCoordinatorDoneMs: number | null
  /** → every Coordinator and Captain turn of the trip ended, and no wake is pending. */
  toQuietMs: number
  coordinator: TurnTiming
  captain: TurnTiming
  wake: TurnTiming | null
}

const p = await call<Project>("POST", "/api/projects", { name: "demo" })
// One warm-up trip: the first spawn of anything is slower (disk cache, JIT), as after a restart.
const trips: Trip[] = []
for (let i = 0; i <= rounds; i++) {
  await idle(p)
  const before = new Set(yard.store.listTurnTimings({ since: 0, limit: 10_000 }).map((t) => t.id))
  const notices = new Set(yard.store.listChat(1000).map((m) => m.id))
  const t0 = Date.now()
  await call("POST", "/api/chat", { content: `tell captain demo: ${message.replaceAll("{i}", String(i))}` })
  const notice = await until(() => yard.store.listChat(1000).find((m: ChatMessage) => !notices.has(m.id) && m.role === "notice" && m.meta?.captain === true && m.meta?.replyTo), "the Captain's reply")
  // The automatic Coordinator turn the reply wakes, then quiet.
  const fresh = () => yard.store.listTurnTimings({ since: t0 - 1000, limit: 100 }).filter((t) => !before.has(t.id))
  // A reply that wakes the Coordinator does so within its debounce; one that doesn't is done once both are idle.
  const wakeBy = notice.createdAt + yard.orchestrator.tuning.wakeDebounceMs + 3000
  const rows = await until(() => {
    const r = fresh()
    const captainDone = r.some((t) => t.role === "captain")
    return captainDone && (r.some((t) => t.role === "coordinator" && t.trigger === "updates") || Date.now() > wakeBy) ? r : null
  }, "the Coordinator's wake on the reply, or its debounce passing", 30_000)
  await idle(p)
  const wake = rows.find((t) => t.role === "coordinator" && t.trigger === "updates") ?? null
  const ends = fresh().map((t) => t.endedAt)
  const trip: Trip = {
    toCaptainReplyMs: notice.createdAt - t0,
    toCoordinatorDoneMs: wake ? wake.endedAt - t0 : null,
    toQuietMs: Math.max(...ends) - t0,
    coordinator: rows.find((t) => t.role === "coordinator" && t.trigger === "cody")!,
    captain: rows.find((t) => t.role === "captain")!,
    wake,
  }
  if (i > 0) trips.push(trip)
  process.stderr.write(`trip ${i}${i ? "" : " (warm-up)"}: reply ${trip.toCaptainReplyMs} ms, ${wake ? `wake done ${trip.toCoordinatorDoneMs} ms` : "no wake"}, quiet ${trip.toQuietMs} ms\n`)
}

// buildMcpServer runs on every /mcp request: the handshake makes ~3 and each tool call 1.
const deps = { store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, publicUrl: () => "", scheduler: yard.scheduler, captains: yard.captains, settings: yard.settings, uploads: null as never }
const build: number[] = []
const list: number[] = []
for (let i = 0; i < 60; i++) {
  const s0 = performance.now()
  const mcp = buildMcpServer(deps, i % 2 ? { kind: "captain", projectId: p.id } : { kind: "coordinator" })
  build.push(performance.now() - s0)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "bench", version: "0" })
  await client.connect(b)
  const l0 = performance.now()
  await client.listTools()
  list.push(performance.now() - l0)
  await client.close()
  await mcp.close()
}

const q = (v: (number | null | undefined)[]) => quantiles(v)
const line = (label: string, v: (number | null | undefined)[]) => {
  const x = q(v)
  return x ? `| ${label} | ${formatMs(x.p50)} | ${formatMs(x.p95)} | ${formatMs(x.max)} | ${x.n} |` : `| ${label} | – | – | – | 0 |`
}
const stageRows = (label: string, rows: (TurnTiming | null)[]) =>
  TURN_STAGES.filter((s) => rows.some((r) => r?.[s.key] !== null && r?.[s.key] !== undefined)).map((s) => line(`${label}: ${s.label}`, rows.map((r) => r?.[s.key])))
const toolRows = (label: string, rows: TurnTiming[]) => {
  const by = new Map<string, number[]>()
  for (const r of rows) for (const s of r.steps) if (s.k === "tool") by.set(s.name ?? "?", [...(by.get(s.name ?? "?") ?? []), s.ms])
  return [...by].map(([name, ms]) => line(`${label} tool ${name}`, ms))
}

const out = [
  `Round trips: ${trips.length} (after one warm-up), claude = ${claudeBin.includes("fake-claude") ? "fake-claude" : claudeBin}, message "${message}"${exitMs ? `, exit tail ${exitMs} ms` : ""}`,
  `Coordinator woken on the reply: ${trips.filter((t) => t.wake).length} of ${trips.length}`,
  "",
  "| Stage | p50 | p95 | max | n |",
  "|---|---:|---:|---:|---:|",
  line("Cody → the Captain's reply on the Coordinator chat", trips.map((t) => t.toCaptainReplyMs)),
  line("Cody → the Coordinator's wake on it done", trips.map((t) => t.toCoordinatorDoneMs)),
  line("Cody → all turns done (quiet)", trips.map((t) => t.toQuietMs)),
  ...stageRows("Coordinator (Cody)", trips.map((t) => t.coordinator)),
  ...toolRows("Coordinator", trips.map((t) => t.coordinator)),
  ...stageRows("Captain", trips.map((t) => t.captain)),
  ...stageRows("Coordinator wake (updates)", trips.map((t) => t.wake)),
  line("buildMcpServer (per /mcp request)", build),
  line("tools/list in memory", list),
].join("\n")
console.log(out)
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ trips, buildMcpServerMs: build, toolsListMs: list }, null, 2))

yard.stop()
await new Promise((r) => server.close(() => r(null)))
if (keep) console.error(`Data kept in ${dataDir}`)
else fs.rmSync(dataDir, { recursive: true, force: true })
process.exit(0)
