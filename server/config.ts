import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { EFFORTS, SIZE_DEFAULTS, WORKER_SIZES, type Effort, type WorkerSize } from "../shared/types.js"

/** Load a .env file into process.env without overriding real env vars. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "")
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"))

function int(name: string, fallback: number) {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function num(name: string, fallback: number) {
  const n = Number.parseFloat(process.env[name] ?? "")
  return Number.isFinite(n) ? n : fallback
}

function workerSize(name: string, fallback: WorkerSize): WorkerSize {
  const v = process.env[name]
  return v && (WORKER_SIZES as readonly string[]).includes(v) ? (v as WorkerSize) : fallback
}

/** An effort level from an env value; empty (use the Settings default) when unset or unknown. */
export function envEffort(value: string | undefined): Effort | "" {
  const v = value?.trim().toLowerCase()
  return v && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : ""
}

const env = process.env
const size = workerSize("WORKER_SIZE", "small")
const sizeDefaults = SIZE_DEFAULTS[size]

/** Mock mode: a fake `claude` drives everything, so no keys are needed. */
const mock = env.BOXYARD_MOCK === "1"
const fakeClaude = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-claude.mjs")
const fakeClaudeSrc = path.resolve(process.cwd(), "scripts/fake-claude.mjs")

export type ProviderName = "upstash" | "local"

export const config = {
  port: int("PORT", 3000),
  host: env.HOST ?? "0.0.0.0",
  dataDir: path.resolve(env.BOXYARD_DATA_DIR ?? "./data"),
  /** Shared password for the web UI. Empty means no login (fine on localhost). */
  password: env.BOXYARD_PASSWORD ?? "",
  /** Public URL of this server, used in links handed to agents. */
  publicUrl: env.BOXYARD_PUBLIC_URL ?? "",

  provider: (env.BOX_PROVIDER ?? (env.UPSTASH_BOX_API_KEY && !mock ? "upstash" : "local")) as ProviderName,
  upstashBoxApiKey: env.UPSTASH_BOX_API_KEY ?? "",
  workerSnapshotId: env.WORKER_SNAPSHOT_ID ?? "",
  workerRuntime: env.WORKER_RUNTIME ?? "node",
  workerSize: size,

  /** Largest file Cody can attach to a message, in MB. */
  maxUploadMb: int("BOXYARD_MAX_UPLOAD_MB", 20),

  /** Max worker boxes alive at once (the free plan allows about 5). */
  maxBoxes: int("BOX_POOL_MAX", 5),
  /** Max agents running at once across all boxes. 0 = no cap beyond boxes x slots. */
  maxAgents: int("BOX_MAX_AGENTS", 0),
  /** Claude turns that may run at the same time inside one box. */
  slotsPerBox: int("BOX_SLOTS", sizeDefaults.slotsPerBox),
  /** Task folders kept in one box before old, finished ones are evicted. */
  maxResidentPerBox: int("BOX_MAX_RESIDENT", sizeDefaults.maxResidentPerBox),
  /** Delete a worker box after this many minutes with no running turn. 0 = never. */
  boxIdleDeleteMinutes: int("BOX_IDLE_DELETE_MINUTES", 0),
  /** Park archived resting task folders from boxes after this many idle days. 0 = keep folders. */
  workspaceRetentionDays: int("BOXYARD_WORKSPACE_RETENTION_DAYS", 7),
  /** Prune orphan and long-done archives after this many days. 0 = keep archives. */
  archiveRetentionDays: int("BOXYARD_ARCHIVE_RETENTION_DAYS", 7),
  /** Keep the archive of any task touched within this many days, whatever archiveRetentionDays says. 0 = no extra protection. */
  archiveKeepTouchedDays: int("BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS", 30),
  /** A new workspace needs at least this much free disk on its box (MB)... */
  diskMinFreeMb: int("BOXYARD_DISK_MIN_FREE_MB", 1024),
  /** ...and at least this many times its repo's last clone size. */
  diskCloneFactor: num("BOXYARD_DISK_CLONE_FACTOR", 2),

  redisUrl: env.UPSTASH_REDIS_REST_URL ?? "",
  redisToken: env.UPSTASH_REDIS_REST_TOKEN ?? "",

  claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  githubToken: env.GITHUB_TOKEN ?? "",
  gitUserName: env.GIT_USER_NAME ?? "Box Yard Agent",
  gitUserEmail: env.GIT_USER_EMAIL ?? "box-yard@users.noreply.github.com",

  mock,
  /** Mock mode only: seed a heavy dataset (long chat, long task thread, many tasks) for UI performance testing. */
  mockHeavy: mock && env.BOXYARD_MOCK_HEAVY === "1",
  /** Claude binary used by the orchestrator (and by local workers). */
  claudeBin: mock ? `${process.execPath} ${fs.existsSync(fakeClaude) ? fakeClaude : fakeClaudeSrc}` : (env.CLAUDE_BIN ?? "claude"),
  orchestratorModel: env.ORCHESTRATOR_MODEL ?? "",
  /** Wake the orchestrator when a task finishes or needs Cody, so it reports back on its own. */
  orchestratorAutoWake: (env.BOXYARD_ORCHESTRATOR_AUTOWAKE ?? "1") !== "0",
  workerModel: env.WORKER_MODEL ?? "",
  /** Per-project Captains' model and effort; empty means the Settings default. */
  captainModel: env.CAPTAIN_MODEL?.trim() ?? "",
  captainEffort: envEffort(env.CAPTAIN_EFFORT),

  /** Poll interval for worker events. */
  pollMs: int("BOXYARD_POLL_MS", 1500),
  /** Archive each task folder after every turn so it can move to another box. */
  archiveWorkspaces: (env.BOXYARD_ARCHIVE ?? "1") !== "0",
  archiveMaxMb: int("BOXYARD_ARCHIVE_MAX_MB", 60),

  /** Time zone new schedules use unless one is given. */
  defaultTimezone: env.BOXYARD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  /** How often the in-process scheduler looks for due schedules. */
  schedulerTickMs: int("BOXYARD_SCHEDULER_TICK_MS", 15_000),
  /** Optional: Upstash QStash also triggers schedules (needs BOXYARD_PUBLIC_URL). */
  qstashUrl: env.QSTASH_URL ?? "https://qstash.upstash.io",
  qstashToken: env.QSTASH_TOKEN ?? "",
  qstashCurrentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY ?? "",
  qstashNextSigningKey: env.QSTASH_NEXT_SIGNING_KEY ?? "",

  /** When running inside a box: its id, so it can snapshot itself. */
  selfBoxId: env.BOXYARD_SELF_BOX_ID ?? "",
  selfSnapshotHours: int("BOXYARD_SELF_SNAPSHOT_HOURS", 6),
  /** Keep our own (non keep-alive) box awake while work is in flight. */
  selfHold: env.BOXYARD_SELF_HOLD === "1",
}

export type Config = typeof config

/** QStash triggers schedules only when it can reach us and we can check its signature. */
export function qstashEnabled(c: Config = config) {
  return Boolean(!c.mock && c.qstashToken && c.qstashCurrentSigningKey && c.publicUrl)
}

export function redisEnabled(c: Config = config) {
  return Boolean(c.redisUrl && c.redisToken)
}

/** Problems that stop Box Yard from doing real work, shown in the UI. */
export function configProblems(c: Config = config): string[] {
  const problems: string[] = []
  if (c.mock || /fake-claude/.test(c.claudeBin)) return problems
  if (!c.claudeOauthToken && !c.anthropicApiKey) {
    problems.push("Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.")
  }
  if (c.provider === "upstash" && !c.upstashBoxApiKey) {
    problems.push("BOX_PROVIDER is upstash but UPSTASH_BOX_API_KEY is missing.")
  }
  if (c.qstashToken && !qstashEnabled(c)) {
    problems.push("QSTASH_TOKEN is set but schedules still use the local timer: QStash also needs BOXYARD_PUBLIC_URL and QSTASH_CURRENT_SIGNING_KEY.")
  }
  if (!c.githubToken) {
    problems.push("GITHUB_TOKEN is missing, so agents can't push branches or open pull requests.")
  }
  return problems
}
