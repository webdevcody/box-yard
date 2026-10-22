import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

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

const env = process.env

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
  workerSize: (env.WORKER_SIZE ?? "small") as "small" | "medium" | "large",

  /** Max worker boxes alive at once (the free plan allows about 5). */
  maxBoxes: int("BOX_POOL_MAX", 5),
  /** Claude turns that may run at the same time inside one box. */
  slotsPerBox: int("BOX_SLOTS", 2),
  /** Task folders kept in one box before old, finished ones are evicted. */
  maxResidentPerBox: int("BOX_MAX_RESIDENT", 12),
  /** Delete a worker box after this many minutes with no running turn. 0 = never. */
  boxIdleDeleteMinutes: int("BOX_IDLE_DELETE_MINUTES", 0),

  redisUrl: env.UPSTASH_REDIS_REST_URL ?? "",
  redisToken: env.UPSTASH_REDIS_REST_TOKEN ?? "",

  claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  githubToken: env.GITHUB_TOKEN ?? "",
  gitUserName: env.GIT_USER_NAME ?? "Box Yard Agent",
  gitUserEmail: env.GIT_USER_EMAIL ?? "box-yard@users.noreply.github.com",

  mock,
  /** Claude binary used by the orchestrator (and by local workers). */
  claudeBin: mock ? `${process.execPath} ${fs.existsSync(fakeClaude) ? fakeClaude : fakeClaudeSrc}` : (env.CLAUDE_BIN ?? "claude"),
  orchestratorModel: env.ORCHESTRATOR_MODEL ?? "",
  /** Wake the orchestrator when a task finishes or needs Cody, so it reports back on its own. */
  orchestratorAutoWake: (env.BOXYARD_ORCHESTRATOR_AUTOWAKE ?? "1") !== "0",
  workerModel: env.WORKER_MODEL ?? "",

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
