import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { BOX_CREATE_CONCURRENCY, EFFORTS, SIZE_DEFAULTS, WORKER_SIZES, type Effort, type WorkerSize } from "../shared/types.js"
import { DEFAULT_NOTE_BUDGET } from "../shared/notes.js"
import { defaultHost } from "./bind.js"

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

/** A folder from an env value, with a leading `~` meaning the home folder (.env files don't expand it). */
export function homePath(value: string) {
  return path.resolve(value.replace(/^~(?=[/\\]|$)/, os.homedir()))
}

/** `dir` with the home folder shown as `~`, for the UI. */
export function tildePath(dir: string) {
  const home = os.homedir()
  return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir
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
const fakeCodex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-codex.mjs")
const fakeCodexSrc = path.resolve(process.cwd(), "scripts/fake-codex.mjs")

export type ProviderName = "upstash" | "local"

export const config = {
  port: int("PORT", 3000),
  /** HOST, or 127.0.0.1 with no password and 0.0.0.0 with one (server/bind.ts). */
  host: defaultHost(env),
  /** BOXYARD_ALLOW_OPEN=1: start on a non-loopback HOST even with no password. */
  allowOpen: env.BOXYARD_ALLOW_OPEN === "1",
  dataDir: path.resolve(env.BOXYARD_DATA_DIR ?? "./data"),
  /**
   * Where agents of "Runs on: This computer" projects work, a folder per task. Not under the data folder: that's
   * `./data` in Box Yard's own checkout, and Claude Code reads every CLAUDE.md above the folder it runs in, so Box
   * Yard's own agent rules would reach every other project's agents.
   */
  localDir: homePath(env.BOXYARD_LOCAL_DIR?.trim() || "~/boxyard-workspaces"),
  /** Shared password for the web UI. Empty means no login, so the server stays on localhost unless HOST and BOXYARD_ALLOW_OPEN say otherwise. */
  password: env.BOXYARD_PASSWORD ?? "",
  /** Public URL of this server, used in links handed to agents. */
  publicUrl: env.BOXYARD_PUBLIC_URL ?? "",

  provider: (env.BOX_PROVIDER ?? (env.UPSTASH_BOX_API_KEY && !mock ? "upstash" : "local")) as ProviderName,
  /** BOX_PROVIDER as set; empty means new boxes are Upstash boxes once a key is set (env or Settings › Credentials). */
  boxProvider: env.BOX_PROVIDER?.trim() ?? "",
  upstashBoxApiKey: env.UPSTASH_BOX_API_KEY ?? "",
  workerSnapshotId: env.WORKER_SNAPSHOT_ID ?? "",
  workerRuntime: env.WORKER_RUNTIME ?? "node",
  workerSize: size,

  /** Largest file Cody can attach to a message, in MB. */
  maxUploadMb: int("BOXYARD_MAX_UPLOAD_MB", 20),

  /**
   * The box ceiling: most worker boxes alive at once, a safety stop (Settings › Advanced). The daily cloud limit is
   * what keeps spend in check; boxes are made as work needs them.
   */
  maxBoxes: int("BOX_POOL_MAX", 50),
  /** Worker boxes created at the same time when many tasks wait for one. */
  boxCreateConcurrency: int("BOX_CREATE_CONCURRENCY", BOX_CREATE_CONCURRENCY.default),
  /** Max agents running at once across all boxes. 0 = no cap beyond boxes x slots. */
  maxAgents: int("BOX_MAX_AGENTS", 0),
  /** Local runner: most agents of "This computer" projects running at once on this machine (their own queue, apart from box slots). */
  localAgents: int("BOXYARD_LOCAL_AGENTS", 2),
  /** Claude turns that may run at the same time inside one box. */
  slotsPerBox: int("BOX_SLOTS", sizeDefaults.slotsPerBox),
  /** Task folders kept in one box before old, finished ones are evicted. */
  maxResidentPerBox: int("BOX_MAX_RESIDENT", sizeDefaults.maxResidentPerBox),
  /** Delete a worker box after this many minutes with no running turn (once every workspace on it is archived). 0 = never. */
  boxIdleDeleteMinutes: int("BOX_IDLE_DELETE_MINUTES", 30),
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
  /** Placement skips a box with more than this % of its memory in use while agents run there. 0 = off. */
  memoryMaxUsedPercent: int("BOXYARD_MEMORY_MAX_USED_PERCENT", 80),
  /** ...or with less than this much memory free (MB). 0 = off. */
  memoryMinFreeMb: int("BOXYARD_MEMORY_MIN_FREE_MB", 1024),
  /** ...or with a 1-minute load average above this many times its CPUs. 0 = off. */
  loadMaxPerCpu: num("BOXYARD_LOAD_MAX_PER_CPU", 2),
  /** Box repo mirrors are partial clones (blob:none) unless a project says otherwise. */
  gitPartialClone: (env.BOXYARD_GIT_PARTIAL_CLONE ?? "1") !== "0",
  /** Push each repo task's branch, and its uncommitted work to a hidden ref, at the end of every turn. */
  gitPushAtTurnEnd: (env.BOXYARD_GIT_PUSH_AT_TURN_END ?? "1") !== "0",
  /** Remove a resting task's git-ignored build output once it has been idle this many minutes. 0 = off. */
  buildCleanupIdleMinutes: int("BOXYARD_BUILD_CLEANUP_IDLE_MINUTES", 15),

  redisUrl: env.UPSTASH_REDIS_REST_URL ?? "",
  redisToken: env.UPSTASH_REDIS_REST_TOKEN ?? "",

  claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  /** Codex's ChatGPT login (the whole ~/.codex/auth.json, or it base64-encoded) and API key (docs/codex.md). Optional. */
  codexAuthJson: env.CODEX_AUTH_JSON ?? "",
  codexApiKey: env.CODEX_API_KEY ?? "",
  githubToken: env.GITHUB_TOKEN ?? "",
  /** RunPod GPU pods (Settings › RunPod GPU, docs/runpod.md). Optional. */
  runpodApiKey: env.RUNPOD_API_KEY ?? "",
  /** The docker CLI for Docker projects (docs/docker.md); empty: found on PATH or where Docker Desktop puts it. */
  dockerBin: env.DOCKER_BIN?.trim() ?? "",
  /**
   * The key identity secrets are encrypted with (server/identity/secretBox.ts): 32 bytes as hex or base64, or any
   * passphrase. Empty: a random key in <data dir>/secret.key, made on first use.
   */
  secretKey: env.BOXYARD_SECRET_KEY ?? "",
  gitUserName: env.GIT_USER_NAME ?? "Box Yard Agent",
  gitUserEmail: env.GIT_USER_EMAIL ?? "box-yard@users.noreply.github.com",

  mock,
  /** Mock mode only: seed a heavy dataset (long chat, long task thread, many tasks) for UI performance testing. */
  mockHeavy: mock && env.BOXYARD_MOCK_HEAVY === "1",
  /** Claude binary used by the orchestrator (and by local workers). */
  claudeBin: mock ? `${process.execPath} ${fs.existsSync(fakeClaude) ? fakeClaude : fakeClaudeSrc}` : (env.CLAUDE_BIN ?? "claude"),
  /** Codex binary for agents set to run on Codex (docs/codex.md); mock mode uses a stand-in. */
  codexBin: mock ? `${process.execPath} ${fs.existsSync(fakeCodex) ? fakeCodex : fakeCodexSrc}` : (env.CODEX_BIN ?? "codex"),
  /** What Box Yard calls its human in prompts and labels; empty means the Settings default ("Cody"). */
  ownerName: env.BOXYARD_OWNER_NAME?.trim() ?? "",
  orchestratorModel: env.ORCHESTRATOR_MODEL ?? "",
  /** Wake the orchestrator when a task finishes or needs Cody, so it reports back on its own. */
  orchestratorAutoWake: (env.BOXYARD_ORCHESTRATOR_AUTOWAKE ?? "1") !== "0",
  workerModel: env.WORKER_MODEL ?? "",
  /** Per-project Captains' model and effort; empty means the Settings default. */
  captainModel: env.CAPTAIN_MODEL?.trim() ?? "",
  captainEffort: envEffort(env.CAPTAIN_EFFORT),
  /** The notes budget when Settings › Max notes doesn't set one. */
  notesMaxCount: int("BOXYARD_NOTES_MAX", DEFAULT_NOTE_BUDGET.maxNotes),
  notesMaxTokens: int("BOXYARD_NOTES_MAX_TOKENS", DEFAULT_NOTE_BUDGET.maxTokens),

  /** Text-to-speech keys (Settings › Voice); a key saved in the UI wins. They never reach the browser. */
  elevenlabsApiKey: env.ELEVENLABS_API_KEY?.trim() ?? "",
  openaiApiKey: env.OPENAI_API_KEY?.trim() ?? "",
  /** browser | elevenlabs | openai; empty means the Settings default (browser). */
  ttsProvider: env.TTS_PROVIDER?.trim().toLowerCase() ?? "",
  /** Overridable for tests and proxies. */
  elevenlabsBaseUrl: env.ELEVENLABS_BASE_URL?.trim() || "https://api.elevenlabs.io",
  openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",

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

/** Problems that stop Box Yard from doing real work, shown in the UI. Pass the credentials in effect (env or saved). */
/** `claudeLogin`: this computer's own `claude` is signed in, and agents run here, so no token is needed. */
export function configProblems(c: Config = config, opts: { claudeLogin?: boolean } = {}): string[] {
  const problems: string[] = []
  if (c.mock || /fake-claude/.test(c.claudeBin)) return problems
  if (!c.claudeOauthToken && !c.anthropicApiKey && !opts.claudeLogin) {
    problems.push("Claude isn't signed in: add a subscription token (`claude setup-token`) or an Anthropic API key in Settings › Credentials, or set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.")
  }
  if (c.provider === "upstash" && !c.upstashBoxApiKey) {
    problems.push("BOX_PROVIDER is upstash but there's no Upstash Box API key: add one in Settings › Credentials, or set UPSTASH_BOX_API_KEY.")
  }
  if (c.qstashToken && !qstashEnabled(c)) {
    problems.push("QSTASH_TOKEN is set but schedules still use the local timer: QStash also needs BOXYARD_PUBLIC_URL and QSTASH_CURRENT_SIGNING_KEY.")
  }
  if (!c.githubToken) {
    problems.push("No GitHub token, so agents can't push branches or open pull requests: add one in Settings › Credentials, or set GITHUB_TOKEN.")
  }
  return problems
}
