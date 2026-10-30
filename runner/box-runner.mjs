#!/usr/bin/env node
// Box Yard worker runner. Copied into every worker box and run there with plain
// Node (no npm install). It has three modes:
//
//   node box-runner.mjs turn  <taskDir>  run one headless Claude turn for a task
//   node box-runner.mjs mcp   <taskDir>  stdio MCP server Claude uses to talk back
//   node box-runner.mjs clean <taskDir>  delete regenerable dirs from a resting work/
//   node box-runner.mjs deps  <taskDir> restore|save   the dependency cache step of a turn, on its own
//
// Every event goes into <taskDir>/events.jsonl, and also into an Upstash Redis
// stream when task.json has Redis credentials. Each event has a `seq` number so
// the orchestrator can mix both sources without duplicates.
//
// Layout of <taskDir>:
//   task.json     task settings written by the orchestrator (env, repo, redis)
//   turn.json     the turn to run (prompt, session id, resume flag)
//   work/         the agent's working directory (repo clone or scratch space)
//   claude/       CLAUDE_CONFIG_DIR, so the session transcript lives with the task
//   events.jsonl  append-only event log
//   turn.pid      pid of the running turn (it leads a process group of its own)
//   run.json      the running turn's record: pid, process identity, turn id, events offset
//   signing.key   the identity's signing key for the next turn, when Box Yard keeps it; the turn takes it away

import { spawn, spawnSync, execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

const RUNNER_VERSION = "2"
const [, , mode, taskDirArg] = process.argv

if (!mode || !taskDirArg) {
  console.error("usage: box-runner.mjs <turn|mcp|clean|deps> <taskDir>")
  process.exit(2)
}

const taskDir = path.resolve(taskDirArg)
const task = mode === "clean" || mode === "deps" ? {} : readJson(path.join(taskDir, "task.json"))

/** Box Yard's built-in text says "Cody"; swap in the configured owner name (same rule as shared/owner.ts). */
function owner(text) {
  const name = typeof task.ownerName === "string" ? task.ownerName.trim() : ""
  return name && name !== "Cody" ? text.replace(/\bCody\b/g, () => name) : text
}
/** Tool definitions with every description run through owner(). */
function namedTools(value) {
  if (Array.isArray(value)) return value.map(namedTools)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "description" && typeof v === "string" ? owner(v) : namedTools(v)]))
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (fallback !== undefined) return fallback
    throw new Error(`Can't read ${file}: ${err.message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Event log. A mkdir lock keeps seq numbers and file order in step even though
// the turn runner and the MCP server are separate processes.

const eventsFile = path.join(taskDir, "events.jsonl")
const seqFile = path.join(taskDir, "events.seq")
const lockDir = path.join(taskDir, "events.lock")

async function withLock(fn) {
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      // A crashed writer can leave the lock behind. Break it after 10s.
      if (Date.now() - started > 10_000) {
        try {
          fs.rmdirSync(lockDir)
        } catch {}
      }
      await sleep(15)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {}
  }
}

async function redis(command) {
  if (!task.redis?.url || !task.redis?.token) return null
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(task.redis.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${task.redis.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
      return body.result
    } catch (err) {
      lastErr = err
      await sleep(250 * 2 ** attempt)
    }
  }
  // The event is still in events.jsonl; the orchestrator falls back to it.
  process.stderr.write(`[box-yard] redis failed: ${lastErr?.message}\n`)
  return null
}

async function emit(event) {
  return withLock(async () => {
    const prev = Number.parseInt(fs.existsSync(seqFile) ? fs.readFileSync(seqFile, "utf8") : "0", 10) || 0
    const seq = prev + 1
    fs.writeFileSync(seqFile, String(seq))
    const full = { seq, ts: Date.now(), turnId: currentTurnId(), ...event }
    const line = JSON.stringify(full)
    fs.appendFileSync(eventsFile, line + "\n")
    if (task.redis?.key) await redis(["XADD", task.redis.key, "MAXLEN", "~", "5000", "*", "e", line])
    return full
  })
}

function currentTurnId() {
  return readJson(path.join(taskDir, "turn.json"), {}).turnId ?? null
}

const clip = (s, n) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "")
  return str.length > n ? `${str.slice(0, n)}…` : str
}

// ---------------------------------------------------------------------------
// Turn mode

let activeChild = null
let stopping = false

// `kill -TERM -<pid>` from the orchestrator stops the turn: end Claude, then
// still write turn_end so the task doesn't look stuck.
process.on("SIGTERM", () => {
  if (mode !== "turn" || stopping) return
  stopping = true
  try {
    activeChild?.kill("SIGTERM")
  } catch {}
  setTimeout(() => {
    try {
      activeChild?.kill("SIGKILL")
    } catch {}
  }, 5000).unref()
})

// The same lines as by_boot/by_start in server/turnProcess.ts: the machine's boot, and when a process started (clock
// ticks since boot on Linux, ps's start time elsewhere). Box Yard compares them with what run.json says, so a pid the
// system hands out again after a reboot or a box resume isn't taken for this turn.
const IDENT_SH = String.raw`by_boot() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.bootsessionuuid 2>/dev/null || true; }
by_start() { if [ -r "/proc/$1/stat" ]; then sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20; else LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; fi; }
printf '%s|%s' "$(by_boot)" "$(by_start "$1")"`

function processIdent(pid) {
  try {
    const ident = execFileSync("sh", ["-c", IDENT_SH, "sh", String(pid)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
    return /^[^|"\\\n]*\|[^"\\\n]+$/.test(ident) ? ident : null
  } catch {
    return null
  }
}

/** The process group `pid` is in, or null when this system can't say. */
function groupOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]) || null
  } catch {}
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || null
  } catch {
    return null
  }
}

/**
 * A turn leads a process group of its own, Claude and its tools in it, so Box Yard can stop all of it with one
 * `kill -- -<pid>`, and a server stopping (Ctrl-C in its terminal, an upgrade) never reaches it. Box Yard starts it
 * under setsid where there is one; where there isn't (macOS) it starts again here as a new session.
 */
function leadOwnGroup() {
  if (process.env.BOXYARD_RUNNER_DETACHED === "1") {
    delete process.env.BOXYARD_RUNNER_DETACHED
    return true
  }
  const group = groupOf(process.pid)
  if (group === null || group === process.pid) return true
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BOXYARD_RUNNER_DETACHED: "1" },
  })
  child.unref()
  return false
}

/**
 * The turn's run record, so a Box Yard that restarts while it runs can find it again: which process this is (pid,
 * with the boot and its start time), its turn, and where its events start in events.jsonl. run.json goes first and
 * turn.pid after it, so a turn.pid always has its record. Both stay behind after the turn (see the end of runTurn).
 */
function writeRunRecord(turn) {
  let eventsOffset = 0
  try {
    eventsOffset = fs.statSync(eventsFile).size
  } catch {}
  const record = {
    pid: process.pid,
    ident: processIdent(process.pid),
    turnId: turn.turnId ?? null,
    startedAt: Date.now(),
    events: "events.jsonl",
    eventsOffset,
    log: "runner.log",
    runner: RUNNER_VERSION,
  }
  const tmp = path.join(taskDir, `run.json.${process.pid}`)
  fs.writeFileSync(tmp, JSON.stringify(record))
  fs.renameSync(tmp, path.join(taskDir, "run.json"))
  fs.writeFileSync(path.join(taskDir, "turn.pid"), String(process.pid))
}

async function runTurn() {
  const turn = readJson(path.join(taskDir, "turn.json"))
  writeRunRecord(turn)
  // While the machine sleeps the wall clock runs on and the monotonic one doesn't: the gap is time asleep (sleptMs).
  const clocks = { wall: Date.now(), mono: performance.now() }
  // Answers to message_captain waits that ran out last turn; their replies come as this turn's messages.
  for (const f of fs.readdirSync(taskDir)) if (/^captain-reply-.*\.json$/.test(f)) fs.rmSync(path.join(taskDir, f), { force: true })
  await emit({ t: "turn_start", runner: RUNNER_VERSION })
  prepareIdentityHome()
  const unsigned = setupSigning()
  if (unsigned) await emit({ t: "signing", ok: false, error: unsigned })

  const mcpConfigFile = path.join(taskDir, "mcp.json")
  fs.writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        boxyard: { type: "stdio", command: process.execPath, args: [process.argv[1], "mcp", taskDir] },
      },
    }),
  )

  // Dependencies back from the box's cache, and a word on what changed in work/ while the task rested.
  const workDir = path.join(taskDir, "work")
  let prompt = turn.prompt
  if (!turn.compact) {
    const restored = depsStep(depsRestore, turn.deps, workDir)
    if (restored && restored.action !== "miss") await emit({ t: "deps", ...restored })
    const note = workspaceNote(restored?.action === "restored")
    if (note) prompt = `${note}\n\n${prompt}`
  }

  let sessionId = turn.sessionId
  // Runner start → the CLI's spawn (signing, MCP config, dependency restore): the box side of a task's setup.
  const preSpawnMs = Date.now() - clocks.wall
  let attempt = await runClaude({ turn, sessionId, resume: turn.resume, prompt, mcpConfigFile })

  // The session file can go missing (fresh box, lost archive). Start a new
  // session that carries a recap instead of failing the task.
  if (!stopping && attempt.exitCode !== 0 && turn.resume && /no conversation found|session.*not found/i.test(attempt.errorText)) {
    sessionId = randomUUID()
    await emit({ t: "session_reset", sessionId, reason: "Previous Claude session was not found on this box." })
    attempt = await runClaude({ turn, sessionId, resume: false, prompt: `${turn.recap ?? ""}\n\n---\n\n${prompt}`.trim(), mcpConfigFile })
  }

  const ok = stopping || (attempt.exitCode === 0 && !attempt.result?.is_error)
  if (!turn.compact && !stopping) {
    const saved = depsStep(depsSave, turn.deps, workDir)
    if (saved) await emit({ t: "deps", ...saved })
  }
  let usage = attempt.usage
  if (turn.compact && ok && !stopping) {
    // /compact prints no usage of its own; ask the session what it holds now.
    usage = (await contextReport(sessionId, turn.model || task.model)) ?? null
  }
  await emit({
    t: "turn_end",
    startedAt: attempt.startedAt,
    stopped: stopping,
    exitCode: attempt.exitCode,
    ok,
    result: attempt.result?.result ?? null,
    costUsd: attempt.result?.total_cost_usd ?? null,
    durationMs: attempt.result?.duration_ms ?? null,
    numTurns: attempt.result?.num_turns ?? null,
    sessionId,
    // Whether this turn continued its session; the CLI's total_cost_usd then includes earlier turns.
    resumed: Boolean(turn.resume) && sessionId === turn.sessionId,
    compact: Boolean(turn.compact),
    usage,
    resultUsage: attempt.result?.usage ?? null,
    error: ok ? null : clip(attempt.errorText || attempt.result?.result || `claude exited with code ${attempt.exitCode}`, 2000),
    sleptMs: Math.max(0, Math.round(Date.now() - clocks.wall - (performance.now() - clocks.mono))),
    // Where the turn's time went (shared/turnTimings.ts), on the box's clock: the server adds its side.
    timing: attempt.timing ? { ...attempt.timing, preSpawnMs, runnerStartedAt: clocks.wall } : null,
  })
  // turn.pid and run.json stay behind on purpose: the orchestrator checks the
  // process with them, and a fast turn must not finish before it sees it started.
}

function claudeEnv() {
  const claudeConfigDir = path.join(taskDir, "claude")
  const isolate = task.isolateConfig !== false
  return {
    ...turnBaseEnv(),
    ...(isolate ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    IS_SANDBOX: "1",
    DISABLE_AUTOUPDATER: "1",
    PORT: String(task.port ?? 4000),
    BOXYARD_TASK_ID: task.taskId,
    BOXYARD_TASK_DIR: taskDir,
  }
}

/**
 * The runner's own environment with the turn's credentials: task.unsetEnv first drops the ones this turn mustn't use
 * (a box's env can still hold another login, see server/turnCredentials.ts), then task.env sets its own.
 */
function turnBaseEnv() {
  const env = { ...process.env }
  for (const k of task.unsetEnv ?? []) delete env[k]
  const base = { ...env, ...task.env }
  return { ...base, ...signingEnv(base) }
}

// ---------------------------------------------------------------------------
// Commit signing (docs/identities.md). task.json's `signing` says how this task's identity signs; a key Box Yard
// keeps arrives as signing.key for one turn. The turn moves it to a 0700 folder outside the task (no archive takes
// it), or into the box's memory when it has a tmpfs for secrets (task.json `secretsDir`, Docker's). git gets its
// signing settings from env (GIT_CONFIG_COUNT), so they reach this turn's processes and nothing else, and the folder
// and key are removed when the turn ends. With requireSigned, core.hooksPath points at hooks that stop a push of
// commits its key didn't sign and otherwise run the repo's own hooks (in the folder: the tmpfs is noexec).

const signingDir = path.join(os.tmpdir(), `boxyard-sign-${task.taskId ?? "none"}`)
const signingKeyFile = path.join(taskDir, "signing.key")
/** The private key while the turn signs with it. */
const signingKeyPath = task.secretsDir ? path.join(task.secretsDir, `sign-${task.taskId ?? "none"}.key`) : path.join(signingDir, "key")
const allowedSigners = path.join(signingDir, "allowed_signers")
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
/** Every hook git runs from core.hooksPath on this side of a push. */
const GIT_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "pre-auto-gc", "reference-transaction", "sendemail-validate", "post-index-change",
]

/**
 * Get the turn's signing ready. Returns why its commits won't be signed, or null (signed, or no key to sign with).
 * With requireSigned, the push guard goes in even when signing can't: the turn's commits then can't be pushed.
 */
function setupSigning() {
  cleanupSigning()
  let key = null
  try {
    key = fs.readFileSync(signingKeyFile, "utf8")
  } catch {}
  takeDelivered(signingKeyFile)
  const s = task.signing
  if (!s) return null
  const problem = signingProblem(s, key)
  if (problem && !s.requireSigned) return problem
  const stopped = problem && `${problem}; the ${s.identity} identity requires signed commits, so this turn's pushes are stopped`
  try {
    // Not recursive, and just after removing it: a folder someone else made first (a shared /tmp) is refused,
    // never written into.
    fs.mkdirSync(signingDir, { mode: 0o700 })
    if (!problem) {
      if (s.kind === "file") fs.writeFileSync(signingKeyPath, key, { mode: 0o600, flag: "wx" })
      fs.writeFileSync(path.join(signingDir, "signs"), "")
    }
    if (s.requireSigned) writeSigningHooks(s)
    // Last: signingEnv takes this file as the sign that the folder is ready.
    fs.writeFileSync(allowedSigners, `box-yard namespaces="git" ${s.publicKey}\n`)
  } catch (err) {
    cleanupSigning()
    return stopped || `the folder for its signing key couldn't be made (${err.path ?? signingDir}: ${err.code ?? err.message})`
  }
  return stopped || null
}

function signingProblem(s, key) {
  if (s.problem) return s.problem
  if (s.kind === "file" && !key) return `the ${s.identity} identity's signing key didn't reach this box`
  const version = /git version (\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "")
  if (!version || Number(version[1]) * 1000 + Number(version[2]) < 2034) return `git on this box ${version ? `is ${version[1]}.${version[2]}, and ` : ""}can't sign with SSH keys before 2.34`
  if (s.program) {
    try {
      fs.accessSync(s.program, fs.constants.X_OK)
    } catch {
      return `the signing program ${s.program} isn't on this computer`
    }
  } else if (spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error?.code === "ENOENT") return "this box has no ssh-keygen, which git signs with"
  else if (s.kind === "agent" && !{ ...process.env, ...task.env }.SSH_AUTH_SOCK) return "no SSH agent reaches this runner (SSH_AUTH_SOCK isn't set in Box Yard's environment)"
  return null
}

function writeSigningHooks(s) {
  const hooks = path.join(signingDir, "hooks")
  fs.mkdirSync(hooks, { recursive: true, mode: 0o700 })
  // The repo's own hooks folder, as git would find it without Box Yard's core.hooksPath.
  const own = (name) => `by_own="$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks 2>/dev/null)/${name}"`
  for (const name of GIT_HOOKS) {
    if (name === "pre-push") continue
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n# Box Yard's core.hooksPath for this turn (requireSigned): the repo's own hook still runs.\n${own(name)}\n[ -x "$by_own" ] || exit 0\nexec "$by_own" "$@"\n`, { mode: 0o755 })
  }
  const refused = path.join(signingDir, "push-refused.txt")
  fs.writeFileSync(
    refused,
    `box-yard: the ${s.identity} identity requires signed commits, and this push has commits its key (${s.fingerprint}) didn't sign. Nothing was pushed.\n` +
      `box-yard: sign them again, e.g. git rebase --force-rebase --gpg-sign origin/${task.baseBranch || "main"}, then push. The commits:\n`,
  )
  fs.writeFileSync(
    path.join(hooks, "pre-push"),
    [
      "#!/bin/sh",
      "# Box Yard (requireSigned): stop a push of commits the identity's key didn't sign, then run the repo's own pre-push.",
      `by_in=$(mktemp "\${TMPDIR:-/tmp}/boxyard-push.XXXXXX") || exit 1`,
      `cat > "$by_in"`,
      `by_bad=`,
      `while read -r by_lref by_lsha by_rref by_rsha; do`,
      `  case "$by_lsha" in *[!0]*) ;; *) continue ;; esac`,
      `  case "$by_rref" in refs/boxyard/*) continue ;; esac`,
      `  by_not=; case "$by_rsha" in *[!0]*) git cat-file -e "$by_rsha^{commit}" 2>/dev/null && by_not="^$by_rsha" ;; esac`,
      `  by_bad="$by_bad$(git -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile=${shq(allowedSigners)} log --format='%h %G?' "$by_lsha" $by_not --not --remotes 2>/dev/null | awk '$2 != "G" { n++; if (n <= 10) printf " %s", $1 }')"`,
      `done < "$by_in"`,
      `if [ -n "$by_bad" ]; then rm -f "$by_in"; cat ${shq(refused)} >&2; echo "box-yard:$by_bad" >&2; exit 1; fi`,
      own("pre-push"),
      `if [ -x "$by_own" ]; then "$by_own" "$@" < "$by_in"; by_s=$?; else by_s=0; fi`,
      `rm -f "$by_in"`,
      `exit $by_s`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
}

/** The git config that signs this turn's commits, as GIT_CONFIG_* env added after any `env` already has. */
function signingEnv(env) {
  const s = task.signing
  if (!s || !fs.existsSync(allowedSigners)) return {}
  const signs = fs.existsSync(path.join(signingDir, "signs"))
  const pairs = [
    ...(signs
      ? [
          ["gpg.format", "ssh"],
          ["user.signingKey", s.kind === "file" ? signingKeyPath : `key::${s.publicKey}`],
          ["commit.gpgSign", "true"],
          ...(s.program ? [["gpg.ssh.program", s.program]] : []),
        ]
      : []),
    ["gpg.ssh.allowedSignersFile", allowedSigners],
    ...(s.requireSigned ? [["core.hooksPath", path.join(signingDir, "hooks")]] : []),
  ]
  const n = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0)
  const out = { GIT_CONFIG_COUNT: String(n + pairs.length) }
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k
    out[`GIT_CONFIG_VALUE_${n + i}`] = v
  })
  return out
}

function cleanupSigning() {
  for (const p of [signingDir, signingKeyPath]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Remove a file Box Yard delivered to the task folder. In a box with a tmpfs for secrets it's a link to the copy kept
 * there (DockerProvider.writeFile), which goes too; a link anywhere else is only unlinked.
 */
function takeDelivered(file) {
  let held = null
  try {
    if (task.secretsDir && fs.lstatSync(file).isSymbolicLink()) {
      const real = fs.realpathSync(file)
      if (path.dirname(real) === fs.realpathSync(task.secretsDir)) held = real
    }
  } catch {}
  fs.rmSync(file, { force: true })
  if (held) fs.rmSync(held, { force: true })
}

/** On this computer, an identity's own git and gh config folders (task.json identityHome), made on first use. */
function prepareIdentityHome() {
  if (!task.identityHome) return
  try {
    fs.mkdirSync(path.join(task.identityHome, "gh"), { recursive: true, mode: 0o700 })
  } catch {}
}

/** Tokens in the context after one API call: its prompt side plus what it just wrote. */
function contextTokensOf(u) {
  if (!u) return null
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n > 0 ? n : null
}

function contextWindowOf(modelUsage) {
  let best = null
  for (const v of Object.values(modelUsage ?? {})) if (typeof v?.contextWindow === "number" && v.contextWindow > (best ?? 0)) best = v.contextWindow
  return best
}

const AMOUNT = { "": 1, k: 1e3, m: 1e6 }
function parseAmount(str) {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(str.trim())
  return m ? Math.round(Number(m[1]) * AMOUNT[m[2].toLowerCase()]) : null
}

/** `claude -p "/context"` on the session: its "Tokens: 84k / 1m (8%)" line, or null if anything is off. */
function contextReport(sessionId, model) {
  return new Promise((resolve) => {
    const args = [...(task.claudeArgs ?? []), "-p", "--resume", sessionId]
    if (model) args.push("--model", model)
    const child = spawn(task.claudeBin || "claude", [...args], { cwd: path.join(taskDir, "work"), env: claudeEnv(), stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000)
    child.stdout.on("data", (d) => (out += d))
    child.on("error", () => resolve(null))
    child.on("close", () => {
      clearTimeout(timer)
      const m = /Tokens:?\**\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(out)
      const tokens = m && parseAmount(m[1])
      const window = m && parseAmount(m[2])
      resolve(tokens && window ? { tokens, window } : null)
    })
    child.stdin.on("error", () => {})
    child.stdin.end("/context")
  })
}

/**
 * The CLI run's timings (shared/turnTimings.ts TurnClockReading) for turn_end, with the stdio MCP server's handshake
 * (mcp-handshake.json, from this run's MCP process) as processMs and mcpMs. Never throws: timings are optional.
 */
function turnTimingOf(clock, ok) {
  try {
    const reading = clock.finish(ok)
    const h = readJson(path.join(taskDir, "mcp-handshake.json"), null)
    const mine = h && typeof h.initializeAt === "number" && h.initializeAt >= reading.startedAt && h.initializeAt <= (clock.ready ?? reading.endedAt)
    return {
      ...reading,
      processMs: mine ? h.initializeAt - reading.startedAt : null,
      mcpMs: mine && typeof h.readyAt === "number" ? h.readyAt - h.initializeAt : null,
    }
  } catch {
    return null
  }
}

function runClaude({ turn, sessionId, resume, prompt, mcpConfigFile }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const clock = new TurnClock(startedAt)
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigFile,
      "--append-system-prompt",
      turn.systemPrompt ?? "",
    ]
    if (resume) args.push("--resume", sessionId)
    else args.push("--session-id", sessionId)
    const model = turn.model || task.model
    if (model) args.push("--model", model)
    if (turn.effort) args.push("--effort", turn.effort)
    if (turn.autocompact) args.push("--autocompact", String(turn.autocompact))

    const workDir = path.join(taskDir, "work")
    const claudeConfigDir = path.join(taskDir, "claude")
    // Keep the session transcript inside the task folder so it moves with the
    // task between boxes. Local runs that rely on the user's own `claude`
    // login turn this off, since that login lives in the default config dir.
    const isolate = task.isolateConfig !== false
    if (isolate) fs.mkdirSync(claudeConfigDir, { recursive: true })

    const child = spawn(task.claudeBin || "claude", [...(task.claudeArgs ?? []), ...args], {
      cwd: workDir,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })

    activeChild = child
    let result = null
    let usage = null
    let stderr = ""
    let buf = ""
    let pending = Promise.resolve()
    const queue = (fn) => (pending = pending.then(fn).catch((e) => process.stderr.write(`${e.stack}\n`)))

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          queue(() => emit({ t: "log", text: clip(line, 1000) }))
          continue
        }
        if (msg.type === "result") result = msg
        clock.line(msg)
        const tokens = msg.type === "assistant" && msg.message?.model !== "<synthetic>" ? contextTokensOf(msg.message?.usage) : null
        if (tokens && tokens !== usage?.tokens) {
          usage = { tokens, window: usage?.window ?? null }
          queue(() => emit({ t: "usage", tokens, window: usage.window }))
        }
        for (const ev of translate(msg)) queue(() => emit(ev))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000)
    })
    child.on("error", (err) => {
      stderr += `\n${err.message}`
    })
    child.on("close", (code, signal) => {
      if (buf.trim()) {
        try {
          const msg = JSON.parse(buf)
          if (msg.type === "result") result = msg
          clock.line(msg)
          for (const ev of translate(msg)) queue(() => emit(ev))
        } catch {}
        buf = ""
      }
      pending.then(() => {
        const window = contextWindowOf(result?.modelUsage)
        if (usage && window) usage.window = window
        // Killed by a signal: 128 + its number, as a shell says it (137 for SIGKILL, what a box's out-of-memory killer sends).
        const killed = code === null && signal ? `claude was killed (${signal})` : ""
        const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)
        const timing = turnTimingOf(clock, exitCode === 0 && !result?.is_error)
        resolve({ exitCode, startedAt, result, usage, timing, errorText: [stderr.trim(), result?.is_error ? result.result : "", killed].filter(Boolean).join("\n") })
      })
    })

    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

/** Turn one Claude stream-json message into zero or more compact events. */
function translate(msg) {
  const out = []
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text?.trim()) out.push({ t: "assistant", text: block.text })
      // Box Yard's own tools emit their own, richer events.
      if (block.type === "tool_use" && !String(block.name).startsWith("mcp__boxyard__")) {
        out.push({ t: "tool", name: block.name, input: clip(block.input, 400) })
      }
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("") : block.content
        out.push({ t: "tool_error", text: clip(text, 400) })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// TurnClock: a copy of server/turnTimings.ts's TurnClock (the box never calls the server, so the turn is timed here).
// test/turn-timings.test.ts runs both on the same streams; change them together.

const TURN_TIMING_MAX_STEPS = 300

class TurnClock {
  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt
    this.readyAt = null
    this.mcpStatus = null
    this.firstTokenAt = null
    this.resultAt = null
    this.stepStart = null
    this.stepLast = null
    this.lastToolEnd = null
    this.open = new Map()
    this.ids = new Set()
    this.steps = []
    this.dropped = 0
    this.toolSpans = []
    this.result = null
    this.contextTokens = null
  }

  get ready() {
    return this.readyAt
  }

  line(msg, at = Date.now()) {
    if (!msg || typeof msg !== "object" || msg.parent_tool_use_id) return
    if (msg.type === "system" && msg.subtype === "init") {
      if (this.readyAt !== null) return
      this.readyAt = at
      if (Array.isArray(msg.mcp_servers) && msg.mcp_servers.length) {
        this.mcpStatus = msg.mcp_servers.map((s) => `${s?.name ?? "?"}: ${s?.status ?? "?"}`).join(", ")
      }
      return
    }
    if (msg.type === "stream_event") {
      if (this.firstTokenAt === null && msg.event?.type === "content_block_delta") this.firstTokenAt = at
      return
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      if (msg.message.model === "<synthetic>") return
      if (this.firstTokenAt === null) this.firstTokenAt = at
      if (typeof msg.message.id === "string") this.ids.add(msg.message.id)
      const u = msg.message.usage
      if (u) {
        const n = (clockNum(u.input_tokens) ?? 0) + (clockNum(u.cache_creation_input_tokens) ?? 0) + (clockNum(u.cache_read_input_tokens) ?? 0) + (clockNum(u.output_tokens) ?? 0)
        if (n > 0) this.contextTokens = n
      }
      if (this.stepStart === null) this.stepStart = this.lastToolEnd ?? this.readyAt ?? this.startedAt
      this.stepLast = at
      for (const b of msg.message.content) {
        if (b?.type === "tool_use" && typeof b.id === "string") this.open.set(b.id, { name: clockToolName(b.name), at })
      }
      return
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== "tool_result") continue
        const call = this.open.get(b.tool_use_id)
        if (!call) continue
        this.closeModel()
        this.open.delete(b.tool_use_id)
        this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
        this.toolSpans.push([call.at, at])
        this.lastToolEnd = at
      }
      return
    }
    if (msg.type === "result") {
      this.resultAt = at
      this.result = msg
      this.closeModel()
    }
  }

  push(step) {
    if (this.steps.length < TURN_TIMING_MAX_STEPS) this.steps.push(step)
    else this.dropped++
  }

  closeModel() {
    if (this.stepStart === null || this.stepLast === null) return
    this.push({ k: "model", at: this.stepStart - this.startedAt, ms: Math.max(0, this.stepLast - this.stepStart) })
    this.stepStart = null
    this.stepLast = null
  }

  finish(ok, at = Date.now()) {
    this.closeModel()
    for (const call of this.open.values()) {
      this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
      this.toolSpans.push([call.at, at])
    }
    this.open.clear()
    const r = this.result
    const u = r?.usage ?? {}
    const steps = this.steps
    return {
      startedAt: this.startedAt,
      endedAt: at,
      startupMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      mcpStatus: this.mcpStatus,
      firstTokenMs: this.firstTokenAt === null ? null : this.firstTokenAt - (this.readyAt ?? this.startedAt),
      modelMs: steps.reduce((n, s) => (s.k === "model" ? n + s.ms : n), 0),
      toolMs: clockUnionMs(this.toolSpans),
      modelCalls: this.ids.size || steps.filter((s) => s.k === "model").length,
      toolCalls: this.toolSpans.length,
      tailMs: this.resultAt === null ? null : Math.max(0, at - this.resultAt),
      wallMs: Math.max(0, at - this.startedAt),
      cliMs: clockNum(r?.duration_ms),
      apiMs: clockNum(r?.duration_api_ms),
      numTurns: clockNum(r?.num_turns),
      inputTokens: clockNum(u.input_tokens) ?? 0,
      outputTokens: clockNum(u.output_tokens) ?? 0,
      cacheReadTokens: clockNum(u.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: clockNum(u.cache_creation_input_tokens) ?? 0,
      cacheWrite1hTokens: clockNum(u.cache_creation?.ephemeral_1h_input_tokens) ?? 0,
      contextTokens: this.contextTokens,
      ok,
      steps,
      stepsDropped: this.dropped,
    }
  }
}

function clockNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function clockToolName(name) {
  return String(name ?? "?").replace(/^mcp__boxyard__/, "")
}

function clockUnionMs(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  for (const [a, b] of s) {
    if (b <= end) continue
    total += b - Math.max(a, end)
    end = b
  }
  return total
}

// end TurnClock

// ---------------------------------------------------------------------------
// MCP mode: newline-delimited JSON-RPC over stdio.

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "The rule, in one or two sentences." },
    why: { type: "string", description: "What a future agent would get wrong without it." },
  },
  required: ["content", "why"],
}

const TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask Cody (the human) a question when you need a decision, credentials, or information you cannot find. After calling this, end your turn; the answer arrives as your next message.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "One clear question, with the options if there are any." } },
      required: ["question"],
    },
  },
  {
    name: "list_agents",
    description: "List the other Box Yard agents (tasks), their projects and status, so you can coordinate with them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_agent",
    description:
      "Send a message to another agent by task id. Set expect_reply to true if you need an answer; then end your turn and the reply will arrive as your next message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Task id of the other agent (from list_agents)." },
        message: { type: "string" },
        expect_reply: { type: "boolean", default: false },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "message_captain",
    description:
      "Message your project's Captain (the agent that runs this project for Cody) without ending your turn: a scope or project question, a conflict with another task, or a bug you found outside your brief. " +
      "By default it returns at once and you keep working; any reply arrives as your next message. Set wait_seconds (at most 60) to wait briefly for the answer: it returns as soon as the Captain replies. " +
      "Use ask_user instead when only Cody can decide, and message_agent to talk to another agent. Limited to 5 messages per 10 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained: what you found or need, and the options if there are any." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "0 (default): don't wait. Up to 60: wait that long for the reply." },
      },
      required: ["message"],
    },
  },
  {
    name: "suggest_note",
    description:
      "Suggest a lasting rule for the project's notes, which every future agent in this project starts with. The project's Captain curates them when your task is finished, so this is a suggestion, not a save. " +
      "Only for environment or box gotchas, Cody's decisions and preferences, and project facts that aren't in the code. Run logs, merge reports and code tours go in the PR description instead.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: "save_note",
    description: "Old name of suggest_note: suggests a project note for the Captain to curate. Use suggest_note.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: "read_notes",
    description: "Read the project's notes: the lasting rules Cody and the project's Captain keep.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_pull_request",
    description:
      "Push the current branch and open a GitHub pull request; if one is open, update its title and body. Commit your changes first. Screenshots: publish them with publish_artifact and put their /artifacts/ links in the body; this copies them to the repo's boxyard-assets branch so GitHub shows them.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown summary of the change and how it was tested. Images can link /artifacts/ URLs from publish_artifact." },
        draft: { type: "boolean", default: false },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "report_preview",
    description:
      "Tell Box Yard a server is listening on a port so it can give Cody a public preview URL. Start the server in the background first (nohup ... &) and bind 0.0.0.0. Use $PORT to $PORT+9.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "integer" }, label: { type: "string" } },
      required: ["port"],
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a file you made (report, image, HTML page, PDF, zip...) so Box Yard hosts it for Cody. Max 25 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working directory, or absolute." },
        title: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "mark_done",
    description:
      'Mark the task finished, with a short summary of the outcome. Use when no PR is needed or after the PR is up and nothing is left. For a scheduled run that found nothing to do and changed nothing (no commits, PR, artifact, preview or question), pass outcome "noop" so Box Yard files it as a quiet run instead of notifying Cody.',
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string", enum: ["noop"], description: 'Only "noop": this run found nothing to do and changed nothing.' },
      },
      required: ["summary"],
    },
  },
]

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: path.join(taskDir, "work"), env: turnBaseEnv(), maxBuffer: 10 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
  })
}

async function liveDirectory() {
  if (task.redis?.url) {
    const raw = await redis(["GET", "boxyard:directory"])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).directory ?? []
}

async function liveNotes() {
  if (task.redis?.url) {
    const raw = await redis(["GET", `boxyard:notes:${task.projectId}`])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).notes ?? []
}

async function callTool(name, args = {}) {
  switch (name) {
    case "ask_user": {
      if (!args.question?.trim()) return text("question is required", true)
      await emit({ t: "ask_user", question: args.question.trim() })
      return text(owner("Your question was sent to Cody. End your turn now; the answer will arrive as your next message."))
    }
    case "list_agents": {
      const agents = (await liveDirectory()).filter((a) => a.id !== task.taskId)
      if (!agents.length) return text("No other agents right now.")
      return text(agents.map((a) => `- ${a.id} | ${a.title} | project: ${a.project} | ${a.status}`).join("\n"))
    }
    case "message_agent": {
      if (!args.to || !args.message) return text("to and message are required", true)
      if (args.to === task.taskId) return text("That's you.", true)
      await emit({ t: "message_agent", to: String(args.to), message: String(args.message), expectReply: Boolean(args.expect_reply) })
      return text(
        args.expect_reply
          ? "Message sent. End your turn now; the reply will arrive as your next message."
          : "Message sent.",
      )
    }
    case "message_captain":
      return messageCaptain(args)
    case "suggest_note":
    case "save_note": {
      if (!args.content?.trim()) return text("content is required", true)
      if (!args.why?.trim()) return text("why is required: what would a future agent get wrong without this note?", true)
      await emit({ t: "note", content: args.content.trim(), why: args.why.trim() })
      return text("Suggested. The project's Captain decides whether it becomes a note when your task is finished.")
    }
    case "read_notes": {
      const notes = await liveNotes()
      if (!notes.length) return text("No notes yet.")
      return text(notes.map((n) => `- (${n.author}) ${n.content}`).join("\n"))
    }
    case "create_pull_request":
      return createPullRequest(args)
    case "report_preview": {
      const port = Number(args.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return text("port must be an integer 1-65535", true)
      await emit({ t: "preview", port, label: args.label ? String(args.label) : `Port ${port}` })
      return text(owner(`Preview registered for port ${port}. Box Yard will show Cody the public URL. Keep the server running.`))
    }
    case "publish_artifact": {
      const p = path.resolve(path.join(taskDir, "work"), String(args.path ?? ""))
      let stat
      try {
        stat = fs.statSync(p)
      } catch {
        return text(`File not found: ${p}`, true)
      }
      if (!stat.isFile()) return text(`${p} is not a file`, true)
      if (stat.size > 25 * 1024 * 1024) return text("File is over 25 MB; compress or split it.", true)
      // Same rules as the server's safeFilename, so the URL we hand out is the real one.
      const filename = path.basename(p).replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120) || "file"
      const id = `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      const url = `${task.publicUrl ? task.publicUrl.replace(/\/$/, "") : ""}/artifacts/${id}/${encodeURIComponent(filename)}`
      // sha256: create_pull_request only copies the file to GitHub while it's still what was published.
      const sha256 = createHash("sha256").update(fs.readFileSync(p)).digest("hex")
      await emit({ t: "artifact", id, path: p, title: args.title ? String(args.title) : path.basename(p), size: stat.size, sha256 })
      return text(`Published ${filename}. Box Yard will host it at ${url} (live within a few seconds). Share that link.`)
    }
    case "mark_done": {
      const summary = String(args.summary ?? "").trim() || "Done."
      if (args.outcome === undefined || args.outcome === null || args.outcome === "") {
        await emit({ t: "done", summary })
        return text("Marked done. End your turn.")
      }
      if (args.outcome !== "noop") return text('outcome must be "noop" (or left out)', true)
      // Box Yard checks the noop mark against what the run did; commits are only visible from here.
      await emit({ t: "done", summary, outcome: "noop", commits: await unpushedWork() })
      return text("Marked done as a no-op run. Box Yard hides it unless the run changed something. End your turn.")
    }
    default:
      return text(`Unknown tool ${name}`, true)
  }
}

// message_captain limits. The server (shared/captain.ts) enforces the same numbers.
const CAPTAIN_MSG_LIMIT = 5
const CAPTAIN_MSG_WINDOW_MS = 10 * 60_000
const CAPTAIN_WAIT_MAX_SECONDS = 60
const captainSentFile = path.join(taskDir, "captain-sent.json")
/** Where the server writes the Captain's answer to a waiting message_captain (or why it wasn't delivered). */
const captainReplyFile = (id) => path.join(taskDir, `captain-reply-${id}.json`)

async function messageCaptain(args) {
  const message = String(args.message ?? "").trim()
  if (!message) return text("message is required", true)
  const wait = Math.max(0, Math.min(CAPTAIN_WAIT_MAX_SECONDS, Math.round(Number(args.wait_seconds ?? 0)) || 0))
  const now = Date.now()
  const sent = readJson(captainSentFile, []).filter((t) => typeof t === "number" && now - t < CAPTAIN_MSG_WINDOW_MS)
  if (sent.length >= CAPTAIN_MSG_LIMIT) {
    const free = Math.max(1, Math.ceil((Math.min(...sent) + CAPTAIN_MSG_WINDOW_MS - now) / 60_000))
    return text(
      owner(
        `Not sent: you already sent the Captain ${CAPTAIN_MSG_LIMIT} messages in the last 10 minutes (the limit). Try again in about ${free} min, put it in your final message, or use ask_user if you need Cody.`,
      ),
      true,
    )
  }
  fs.writeFileSync(captainSentFile, JSON.stringify([...sent, now]))
  const id = `cmsg_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  await emit({ t: "message_captain", id, message, wait })
  if (!wait) return text("Sent to your project's Captain. Keep working; if it replies, the reply arrives as your next message.")

  const file = captainReplyFile(id)
  const deadline = Date.now() + wait * 1000
  while (Date.now() < deadline) {
    const answer = readJson(file, null)
    if (answer && typeof answer.status === "string") {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      if (answer.status === "reply") {
        await emit({ t: "captain_reply_taken", id, inputId: answer.inputId ?? null })
        return text(`The Captain replied:\n\n${answer.text ?? ""}`)
      }
      if (answer.status === "no_reply") {
        return text(
          `The Captain read your message and ended its turn without replying to you, so carry on (or end your turn if you're blocked; a later reply still arrives as your next message). Its turn ended with:\n\n${answer.text || "(nothing)"}`,
        )
      }
      return text(`Not delivered: ${answer.text ?? "the Captain couldn't take it"}`, true)
    }
    await sleep(400)
  }
  await emit({ t: "captain_wait_end", id })
  return text(`No reply within ${wait} s. The Captain still has your message; its reply arrives as your next message. Keep working, or end your turn if you're blocked on it.`)
}

/** Commits on any local branch that aren't on origin's base branch, or null outside a git repo. */
async function unpushedWork() {
  const base = task.baseBranch || "main"
  const res = await sh("git", ["rev-list", "--count", "--branches", "--not", `refs/remotes/origin/${base}`])
  if (res.code !== 0) return null
  const n = Number(res.stdout.trim())
  return Number.isFinite(n) ? n : null
}

/** GitHub's REST API with the task's token. `task.github.apiUrl` points it elsewhere (tests). */
function githubApi(token) {
  const base = (task.github?.apiUrl || "https://api.github.com").replace(/\/$/, "")
  return async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "box-yard",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}: ${data.message ?? "request failed"} ${JSON.stringify(data.errors ?? "")}`), { status: res.status })
    return data
  }
}

// ---------------------------------------------------------------------------
// PR screenshots. A published artifact's link (/artifacts/art_…/shot.png) is Box Yard's: GitHub can't reach it, and
// it's behind Box Yard's login. So create_pull_request copies each file a PR body links to onto the repo's
// boxyard-assets branch (never the base branch) and points the link there, where GitHub shows it.

const ASSETS_BRANCH = "boxyard-assets"
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i
/** A relative /artifacts/ link, or one on any host (BOXYARD_PUBLIC_URL, or github.com where a relative link landed). Sentence punctuation after it isn't part of it. */
const ARTIFACT_LINK = /(?<![\w.\-/:])(?:https?:\/\/[^\s/)"'`<>\]]+)?\/artifacts\/(art_[a-z0-9]+)\/([^\s)"'`<>\]]*[^\s)"'`<>\].,;:!?])/gi
/** Code: a fenced block or an inline span. Links written there are about the link, so they stay as written. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/

/** Artifacts this task published: id to { path, size, sha256 } from the event log. */
function publishedArtifacts() {
  const out = new Map()
  let raw = ""
  try {
    raw = fs.readFileSync(eventsFile, "utf8")
  } catch {
    return out
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"artifact"')) continue
    try {
      const e = JSON.parse(line)
      if (e.t === "artifact" && e.id && e.path) out.set(e.id, e)
    } catch {}
  }
  return out
}

const assetName = (name) => {
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {}
  return decoded.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file"
}

/**
 * Commit files onto the assets branch through GitHub's git API, so the agent's clone isn't touched. The ref only
 * moves forward: when another agent got there first, it starts again from the new tip.
 */
async function pushAssets(gh, slug, files) {
  const ref = `heads/${ASSETS_BRANCH}`
  const blobs = []
  for (const f of files) {
    const blob = await gh("POST", `/repos/${slug}/git/blobs`, { content: fs.readFileSync(f.file).toString("base64"), encoding: "base64" })
    blobs.push({ path: f.repoPath, mode: "100644", type: "blob", sha: blob.sha })
  }
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    let tip = null
    try {
      tip = (await gh("GET", `/repos/${slug}/git/ref/${ref}`)).object.sha
    } catch (err) {
      if (err.status !== 404) throw err
    }
    const baseTree = tip ? (await gh("GET", `/repos/${slug}/git/commits/${tip}`)).tree.sha : null
    const tree = await gh("POST", `/repos/${slug}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: blobs })
    if (tree.sha === baseTree) return
    const commit = await gh("POST", `/repos/${slug}/git/commits`, {
      message: `Screenshots for task ${task.taskId}`,
      tree: tree.sha,
      parents: tip ? [tip] : [],
    })
    try {
      if (tip) await gh("PATCH", `/repos/${slug}/git/refs/${ref}`, { sha: commit.sha, force: false })
      else await gh("POST", `/repos/${slug}/git/refs`, { ref: `refs/${ref}`, sha: commit.sha })
      return
    } catch (err) {
      // 422: the branch moved (or was just made) under us.
      if (err.status !== 422) throw err
      lastErr = err
    }
  }
  throw lastErr
}

/** The file still holds what was published (older events have no sha256, so their size stands in). */
function unchanged(e) {
  try {
    const data = fs.readFileSync(e.path)
    return e.sha256 ? createHash("sha256").update(data).digest("hex") === e.sha256 : data.length === e.size
  } catch {
    return false
  }
}

/** The PR body with every link to an artifact this task published pointed at its copy on the assets branch, and notes on any it couldn't move. */
async function hostArtifacts(gh, slug, body) {
  // split() with a capture group: odd parts are code.
  const parts = body.split(CODE)
  const links = parts.flatMap((part, i) => (i % 2 ? [] : [...part.matchAll(ARTIFACT_LINK)]))
  if (!links.length) return { body, notes: [] }
  const known = publishedArtifacts()
  const files = new Map()
  const missing = new Set()
  for (const [, id, name] of links) {
    if (files.has(id) || missing.has(id)) continue
    const e = known.get(id)
    if (!e || !unchanged(e)) missing.add(id)
    else files.set(id, { file: e.path, repoPath: `${task.taskId}/${id}/${assetName(name)}` })
  }
  const notes = []
  if (files.size) {
    try {
      await pushAssets(gh, slug, [...files.values()])
    } catch (err) {
      notes.push(`Couldn't copy the PR's files to the ${ASSETS_BRANCH} branch (${clip(err.message, 300)}), so their Box Yard links stay, and GitHub can't show them.`)
      files.clear()
    }
  }
  if (missing.size) {
    notes.push(`GitHub can't show ${[...missing].join(", ")}: this task didn't publish it, or the file is gone or has changed since. Publish the file again with publish_artifact, use the new link, and call create_pull_request again.`)
  }
  const rewrite = (link, id) => {
    const f = files.get(id)
    if (!f) return link
    const url = `https://github.com/${slug}/blob/${ASSETS_BRANCH}/${f.repoPath.split("/").map(encodeURIComponent).join("/")}`
    // ?raw=true serves the file itself, which an image needs; other files open on GitHub's file page.
    return IMAGE_FILE.test(f.repoPath) ? `${url}?raw=true` : url
  }
  const out = parts.map((part, i) => (i % 2 ? part : part.replace(ARTIFACT_LINK, rewrite))).join("")
  if (files.size) notes.unshift(`Copied ${files.size} file${files.size === 1 ? "" : "s"} to the ${ASSETS_BRANCH} branch so GitHub shows ${files.size === 1 ? "it" : "them"}.`)
  return { body: out, notes }
}

async function createPullRequest(args) {
  const slug = task.github?.slug
  const token = task.env?.GITHUB_TOKEN
  if (!slug) return text("This project has no GitHub repo, so there is nothing to open a PR against.", true)
  if (!token) return text(owner("GITHUB_TOKEN is not set for this task; ask Cody with ask_user."), true)

  const branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  if (!branch || branch === "HEAD") return text("Not on a branch. Create one with git checkout -b.", true)
  if (branch === task.baseBranch) return text(`You're on ${task.baseBranch}. Create a feature branch and commit there.`, true)
  const dirty = (await sh("git", ["status", "--porcelain"])).stdout.trim()
  if (dirty) return text(`You have uncommitted changes:\n${clip(dirty, 1500)}\nCommit them first.`, true)

  const push = await sh("git", ["push", "-u", "origin", branch])
  if (push.code !== 0) return text(`git push failed:\n${clip(push.stderr || push.stdout, 2000)}`, true)

  const gh = githubApi(token)
  try {
    const { body, notes } = await hostArtifacts(gh, slug, String(args.body ?? ""))
    const fields = { title: String(args.title), body: `${body}\n\n---\n_Opened by a Box Yard agent (task ${task.taskId})._` }
    const owner = slug.split("/")[0]
    const open = await gh("GET", `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    let pr = Array.isArray(open) ? open[0] : null
    let created = false
    if (pr) {
      // Calling it again updates the PR: the new title and body replace the old ones.
      pr = await gh("PATCH", `/repos/${slug}/pulls/${pr.number}`, fields)
    } else {
      pr = await gh("POST", `/repos/${slug}/pulls`, { ...fields, head: branch, base: task.baseBranch, draft: Boolean(args.draft) })
      created = true
    }
    // The commit just pushed, so Box Yard hooks fire once per head commit (task.pr_ready).
    const headSha = (await sh("git", ["rev-parse", "HEAD"])).stdout.trim()
    await emit({ t: "pr", url: pr.html_url, number: pr.number, branch, ...(/^[0-9a-f]{40}$/.test(headSha) ? { headSha } : {}) })
    return text([`${created ? "Opened" : "Updated (pushed to, with this title and body)"} PR #${pr.number}: ${pr.html_url}`, ...notes].join("\n"))
  } catch (err) {
    return text(String(err.message), true)
  }
}

function serveMcp() {
  let buf = ""
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        continue
      }
      handle(req).then(
        (result) => req.id !== undefined && result !== undefined && send({ jsonrpc: "2.0", id: req.id, result }),
        (err) => req.id !== undefined && send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } }),
      )
    }
  })
  process.stdin.on("end", () => process.exit(0))

  // When this MCP process was spawned and its handshake ran, for the turn's timings (turnTimingOf).
  const handshake = { pid: process.pid, spawnedAt: Math.round(performance.timeOrigin), initializeAt: null, readyAt: null }
  const noteHandshake = () => {
    try {
      fs.writeFileSync(path.join(taskDir, "mcp-handshake.json"), JSON.stringify(handshake))
    } catch {}
  }

  async function handle(req) {
    switch (req.method) {
      case "initialize":
        handshake.initializeAt ??= Date.now()
        return {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "boxyard", version: RUNNER_VERSION },
        }
      case "ping":
        return {}
      case "tools/list":
        if (handshake.readyAt === null) {
          handshake.readyAt = Date.now()
          noteHandshake()
        }
        return { tools: namedTools(TOOLS) }
      case "tools/call":
        return callTool(req.params?.name, req.params?.arguments ?? {})
      default:
        if (req.id === undefined) return undefined // notification
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 })
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace cleanup. Runs between turns to free disk on resting tasks. It must
// never destroy source: inside a git repo it only deletes directories git
// reports as ignored *and* untracked, and only when their name is on the list.
// Outside any repo it can't tell source from output, so it only deletes the
// few names that are always generated (a committed `build/` or `dist/` is real
// source in plenty of repos; a `node_modules/` never is).

const CLEAN_IN_REPO = new Set([
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", "target", ".venv", "__pycache__",
  // Scratch space and perf/test captures (e.g. shots/perf/*.jsonl, Playwright reports, traces).
  "tmp", ".tmp", "shots", "perf", "traces", "playwright-report", "test-results",
])
const CLEAN_OUTSIDE_REPO = new Set(["node_modules", "__pycache__"])
const CLEAN_MAX_DEPTH = 6

function gitOut(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

async function cleanRepo(repo, removed) {
  // --directory collapses a fully untracked dir into one "dir/" entry, so a
  // dir that holds any tracked file is never listed as a whole.
  const out = await gitOut(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
  if (out === null) return // git missing or broken repo: leave it alone
  for (const entry of out.split("\0")) {
    if (!entry.endsWith("/")) continue
    const rel = entry.slice(0, -1)
    if (!CLEAN_IN_REPO.has(path.basename(rel))) continue
    // Belt and braces: re-check that git tracks nothing under it.
    const tracked = await gitOut(repo, ["ls-files", "-z", "--", rel])
    if (tracked !== "") continue
    const abs = path.join(repo, rel)
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue
    fs.rmSync(abs, { recursive: true, force: true })
    removed.push(abs)
  }
}

async function cleanDir(dir, depth, removed) {
  if (fs.existsSync(path.join(dir, ".git"))) return cleanRepo(dir, removed)
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue // skips symlinks too
    const abs = path.join(dir, e.name)
    if (CLEAN_OUTSIDE_REPO.has(e.name)) {
      fs.rmSync(abs, { recursive: true, force: true })
      removed.push(abs)
    } else if (depth < CLEAN_MAX_DEPTH) {
      await cleanDir(abs, depth + 1, removed)
    }
  }
}

async function cleanWorkspace() {
  const work = path.join(taskDir, "work")
  if (!fs.existsSync(work)) return
  const removed = []
  await cleanDir(work, 0, removed)
  for (const p of removed) console.log(path.relative(work, p))
  if (removed.length) {
    // The next turn's prompt says what went (workspaceNote), so the agent reinstalls before it runs anything.
    const file = path.join(taskDir, "cleaned.json")
    const dirs = new Set(readJson(file, { dirs: [] }).dirs)
    for (const p of removed) dirs.add(path.relative(work, p))
    fs.writeFileSync(file, JSON.stringify({ dirs: [...dirs] }))
  }
}

// ---------------------------------------------------------------------------
// Dependency cache (opt-in: turn.json `deps`, from Settings › Dependency cache or
// the project's override). One store per box, next to the task folders so hard
// links work (/tmp is another filesystem there, and reflinks cost full quota):
//
//   <deps.dir>/npm/<key>/node_modules   read-only files, hard-linked into tasks
//   <deps.dir>/npm/<key>/meta.json      size, last use, a sentinel file
//
// The key is the lockfile plus what makes an install differ (Node ABI, platform,
// libc). Before a turn, a task with a package-lock.json and no node_modules gets
// the tree for its key in well under a second. After a turn, a node_modules that
// matches its lockfile (npm's own node_modules/.package-lock.json) is saved.
// Files are chmod a-w, so a task writing into one fails loudly instead of
// changing every task's copy; npm itself replaces files, it never writes in place.

const DEPS_VERSION = 1
/** Top-level node_modules entries tools write per task (vite, vitest, prisma's generated client); never shared. */
const DEPS_NPM_SKIP = new Set([".cache", ".vite", ".vitest", ".prisma", ".tmp", ".boxyard-deps.json"])

function depsKeyNpm(lockText) {
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl"
  const parts = [`v${DEPS_VERSION}`, lockText, process.versions.modules, process.platform, process.arch, process.platform === "linux" ? glibc : ""]
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

/** Why a work/ dir's npm tree can't use the cache, or null. A root lockfile whose packages all live under ./node_modules. */
function npmUnsupported(lock) {
  const pkgs = lock?.packages
  if (!pkgs || typeof pkgs !== "object") return "lockfile has no packages map (lockfileVersion < 2)"
  for (const k of Object.keys(pkgs)) if (k.includes("node_modules/") && !k.startsWith("node_modules/")) return `nested node_modules (${k})`
  return null
}

/** Whether node_modules holds exactly what package-lock.json asks for, going by npm's hidden lockfile. */
function npmTreeMatches(lock, hidden) {
  const want = lock.packages
  const have = hidden?.packages
  if (!have) return false
  for (const [k, v] of Object.entries(want)) {
    if (k === "") continue
    const h = have[k]
    if (!h) {
      if (v.optional) continue // not installed on this platform
      return false
    }
    if ((h.version ?? h.resolved) !== (v.version ?? v.resolved)) return false
  }
  return Object.keys(have).every((k) => k in want)
}

/** Node ABIs node-gyp built addons for (build/config.gypi), so a tree built by another Node isn't keyed as ours. */
function gypAbis(nm) {
  const abis = new Set()
  const look = (dir) => {
    const gypi = path.join(dir, "build", "config.gypi")
    if (!fs.existsSync(gypi)) return
    const m = fs.readFileSync(gypi, "utf8").match(/"node_module_version":\s*(\d+)/)
    abis.add(m ? m[1] : "?")
  }
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const abs = path.join(nm, e.name)
    if (e.name.startsWith("@")) for (const s of fs.readdirSync(abs, { withFileTypes: true })) s.isDirectory() && look(path.join(abs, s.name))
    else look(abs)
  }
  return abis
}

/** Copy a tree as hard links (dirs are new, files shared). `readOnly` chmods each file a-w. Returns files and bytes. */
function linkTree(src, dst, { skip = new Set(), readOnly = false } = {}) {
  const stats = { files: 0, bytes: 0, sentinel: null }
  const walk = (from, to, top) => {
    fs.mkdirSync(to)
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (top && skip.has(e.name)) continue
      const a = path.join(from, e.name)
      const b = path.join(to, e.name)
      if (e.isDirectory()) walk(a, b, false)
      else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), b)
      else if (e.isFile()) {
        const st = fs.statSync(a)
        if (readOnly && st.mode & 0o222) fs.chmodSync(a, st.mode & ~0o222)
        fs.linkSync(a, b)
        stats.files++
        stats.bytes += st.size
        stats.sentinel ??= path.relative(dst, b)
      }
    }
  }
  walk(src, dst, true)
  return stats
}

function readLock(work) {
  const text = fs.readFileSync(path.join(work, "package-lock.json"), "utf8")
  return { text, lock: JSON.parse(text) }
}

function touchMeta(entry, patch = {}) {
  const file = path.join(entry, "meta.json")
  const meta = { ...readJson(file, {}), ...patch, lastUsed: Date.now() }
  fs.writeFileSync(file, JSON.stringify(meta))
  return meta
}

/** Before a turn: hard-link the cached node_modules into work/ when it's missing. */
function depsRestore(deps, work) {
  if (!deps?.npm || !deps.dir) return null
  if (!fs.existsSync(path.join(work, "package-lock.json")) || fs.lstatSync(path.join(work, "node_modules"), { throwIfNoEntry: false })) return null
  const started = Date.now()
  const { text, lock } = readLock(work)
  if (npmUnsupported(lock)) return null
  const key = depsKeyNpm(text)
  const entry = path.join(deps.dir, "npm", key)
  if (!fs.existsSync(path.join(entry, "node_modules"))) return { ecosystem: "npm", action: "miss", key }
  const dst = path.join(work, "node_modules")
  try {
    const { files } = linkTree(path.join(entry, "node_modules"), dst)
    fs.writeFileSync(path.join(dst, ".boxyard-deps.json"), JSON.stringify({ ecosystem: "npm", key }))
    touchMeta(entry)
    return { ecosystem: "npm", action: "restored", key, files, ms: Date.now() - started }
  } catch (err) {
    fs.rmSync(dst, { recursive: true, force: true })
    return { ecosystem: "npm", action: "failed", key, error: clip(String(err?.message ?? err), 300) }
  }
}

/** After a turn: save a node_modules that matches its lockfile, then keep the store under deps.maxMb. */
function depsSave(deps, work) {
  if (!deps?.npm || !deps.dir) return null
  const nm = path.join(work, "node_modules")
  if (!fs.existsSync(path.join(work, "package-lock.json")) || !fs.lstatSync(nm, { throwIfNoEntry: false })?.isDirectory()) return null
  const { text, lock } = readLock(work)
  const skipped = (reason) => ({ ecosystem: "npm", action: "skipped", reason })
  const unsupported = npmUnsupported(lock)
  if (unsupported) return skipped(unsupported)
  if (!npmTreeMatches(lock, readJson(path.join(nm, ".package-lock.json"), null))) return skipped("node_modules doesn't match package-lock.json")
  const abis = [...gypAbis(nm)].filter((a) => a !== process.versions.modules)
  if (abis.length) return skipped(`native addons built for another Node (ABI ${abis.join(", ")})`)
  const key = depsKeyNpm(text)
  const store = path.join(deps.dir, "npm")
  const entry = path.join(store, key)
  if (fs.existsSync(path.join(entry, "node_modules"))) {
    touchMeta(entry)
    return { ecosystem: "npm", action: "present", key }
  }
  const started = Date.now()
  fs.mkdirSync(store, { recursive: true })
  const tmp = path.join(store, `.${key}.${process.pid}.tmp`)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp)
    const stats = linkTree(nm, path.join(tmp, "node_modules"), { skip: DEPS_NPM_SKIP, readOnly: true })
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ ecosystem: "npm", key, node: process.version, createdAt: Date.now(), lastUsed: Date.now(), files: stats.files, bytes: stats.bytes, sentinel: stats.sentinel }))
    fs.renameSync(tmp, entry) // another task saving the same key first: keep theirs
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!fs.existsSync(path.join(entry, "node_modules"))) return { ecosystem: "npm", action: "failed", key, error: clip(String(err?.message ?? err), 300) }
  }
  fs.writeFileSync(path.join(nm, ".boxyard-deps.json"), JSON.stringify({ ecosystem: "npm", key }))
  const evicted = depsPrune(deps, key)
  return { ecosystem: "npm", action: "saved", key, ms: Date.now() - started, ...(evicted.length ? { evicted } : {}) }
}

/**
 * Evict least recently used entries until the store fits deps.maxMb. An entry a task still links (its sentinel file
 * has more than one link) frees nothing, so it stays.
 */
function depsPrune(deps, keep) {
  const store = path.join(deps.dir, "npm")
  const entries = fs
    .readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ dir: path.join(store, e.name), meta: readJson(path.join(store, e.name, "meta.json"), {}) }))
  let total = entries.reduce((n, e) => n + (e.meta.bytes ?? 0), 0)
  const budget = (deps.maxMb ?? 2048) * 1024 * 1024
  const evicted = []
  for (const e of entries.sort((a, b) => (a.meta.lastUsed ?? 0) - (b.meta.lastUsed ?? 0))) {
    if (total <= budget) break
    if (e.meta.key === keep) continue
    const sentinel = e.meta.sentinel && fs.statSync(path.join(e.dir, "node_modules", e.meta.sentinel), { throwIfNoEntry: false })
    if (sentinel && sentinel.nlink > 1) continue
    fs.rmSync(e.dir, { recursive: true, force: true })
    total -= e.meta.bytes ?? 0
    evicted.push(path.basename(e.dir))
  }
  return evicted
}

/** What Box Yard did to work/ while the task rested, for the start of the next prompt. */
function workspaceNote(restored) {
  const file = path.join(taskDir, "cleaned.json")
  const cleaned = readJson(file, { dirs: [] }).dirs.filter((d) => !(restored && d === "node_modules"))
  fs.rmSync(file, { force: true })
  const lines = []
  if (restored) lines.push(`Box Yard restored node_modules from this box's dependency cache (it matches package-lock.json), so there's no need to run npm ci or npm install unless you change dependencies.`)
  if (cleaned.length) lines.push(`While this task was idle, Box Yard removed build output to free disk: ${cleaned.map((d) => `work/${d}`).join(", ")}. Reinstall or rebuild before you run tests or the app.`)
  return lines.length ? `[Box Yard] ${lines.join(" ")}` : ""
}

/** A cache step never fails a turn: errors come back as a "failed" result. */
function depsStep(fn, deps, work) {
  try {
    return fn(deps, work)
  } catch (err) {
    return { ecosystem: "npm", action: "failed", error: clip(String(err?.message ?? err), 300) }
  }
}

// ---------------------------------------------------------------------------

if (mode === "turn" && !leadOwnGroup()) {
  // The turn runs on in the copy that leads its own group; that one writes turn.pid.
  process.exit(0)
} else if (mode === "turn") {
  // No terminal to hang up, but a stray SIGHUP mustn't end a turn either (nohup's ignore doesn't outlive a re-exec).
  process.on("SIGHUP", () => {})
  runTurn().then(
    () => {
      cleanupSigning()
      process.exit(0)
    },
    async (err) => {
      cleanupSigning()
      try {
        await emit({ t: "turn_end", exitCode: 1, ok: false, error: `runner crashed: ${err?.stack ?? err}` })
      } catch {}
      process.exit(1)
    },
  )
} else if (mode === "mcp") {
  serveMcp()
} else if (mode === "deps") {
  const deps = readJson(path.join(taskDir, "turn.json"), {}).deps
  const fn = process.argv[4] === "save" ? depsSave : depsRestore
  console.log(JSON.stringify(depsStep(fn, deps, path.join(taskDir, "work"))))
} else if (mode === "clean") {
  cleanWorkspace().then(
    () => process.exit(0),
    (err) => {
      console.error(`clean failed: ${err?.stack ?? err}`)
      process.exit(1)
    },
  )
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
