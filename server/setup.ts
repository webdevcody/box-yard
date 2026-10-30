// GET /api/setup and the Test buttons behind POST /api/setup/test/:key: what's missing before Box Yard can do real
// work, and a cheap live check of each credential. Nothing here returns or logs a secret: every message goes
// through redact().
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Box } from "@upstash/box"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import { credentialValueFor, redact, type CodexLogin, type CredentialStore } from "./credentials.js"
import { codexExecArgs, CodexStream, isRefreshOf, seedCodexAuth } from "./codex.js"
import type { SettingsStore } from "./settings.js"
import { providerMessage } from "./tts.js"
import { checkLocal, type LocalCheckResult } from "./localCheck.js"
import { authorFallbacks } from "./gitAuthor.js"
import { CREDENTIAL_INFO, type CredentialKey, type CredentialTest, type LocalCheck, type RecentRepos, type SetupStatus } from "../shared/setup.js"
import { SETUP_RUNNERS, type Runner } from "../shared/runner.js"
import type { GpuProvider } from "../shared/gpu.js"
import { DOCKER_NEEDS_CLAUDE_KEY, DOCKER_NEEDS_CODEX_KEY } from "../shared/docker.js"
import { CODEX_ON_MACHINES } from "../shared/machines.js"
import type { AgentCli } from "../shared/agentCli.js"

export const CHECK_TIMEOUT_MS = 15_000
/** A real `claude` call takes a few seconds to start. */
export const CLAUDE_CHECK_TIMEOUT_MS = 60_000
/** And a `codex exec` one a little longer: it loads its model list first. */
export const CODEX_CHECK_TIMEOUT_MS = 90_000

export interface SetupDeps {
  c: Config
  store: Store
  credentials: CredentialStore
  settings: SettingsStore
  /** Where new boxes are made right now. */
  provider: () => string
  /** Stand-ins for tests: the Upstash Box API, the Anthropic API, GitHub's API. */
  listBoxes?: (apiKey: string) => Promise<{ status?: string }[]>
  fetch?: typeof fetch
  githubFetch?: typeof fetch
  anthropicBaseUrl?: string
  timeoutMs?: number
  /** Stand-in for looking at this computer's tools and logins (tests). */
  localCheck?: () => Promise<LocalCheckResult>
  /** Why Docker containers can't start now (Docker missing or stopped), or null (DockerService.problem). */
  dockerProblem?: () => Promise<string | null>
  /** Why tasks can't be sent to SSH machines at all (none is set up), or null. Which one a task takes is placement's. */
  machinesProblem?: () => string | null
}

/** The setup choice of where agents run, in its own kv entry. */
const RUNNER_KV = "setup_runner"
/** What's missing on a first run before the owner picks This computer or Upstash boxes. */
export const NO_RUNNER_CHOICE = "a choice of where agents run"
/** A look at this computer's tools and logins is reused this long. */
export const LOCAL_CHECK_TTL_MS = 60_000

/** Mock mode, or a fake `claude` standing in for the real one: nothing needs a key. */
export const isMockRun = (c: Pick<Config, "mock" | "claudeBin">) => c.mock || /fake-claude/.test(c.claudeBin)

export class Setup {
  private local: { result: LocalCheckResult; at: number } | null = null
  private checking: Promise<boolean> | null = null

  constructor(private readonly d: SetupDeps) {
    // With agents on this computer (or in Docker containers on it), its `gh auth` login stands in for a GitHub token nobody set.
    d.credentials.setGhFallback(() => (this.onThisComputer() ? (this.local?.result.ghToken ?? "") : ""))
  }

  /** The setup choice runs agents on this computer: in its own folders ("local") or in Docker containers on it. */
  onThisComputer(): boolean {
    const choice = this.runnerChoice()
    return choice === "local" || choice === "docker"
  }

  /** Where the owner chose to run agents, or null before they chose (and on installs from before the choice). */
  runnerChoice(): Runner | null {
    const v = this.d.store.getKv(RUNNER_KV)
    return (SETUP_RUNNERS as readonly string[]).includes(v ?? "") ? (v as Runner) : null
  }

  /** What new projects run on: the setup choice, else Upstash boxes, as before the choice existed. */
  defaultRunner(): Runner {
    return this.runnerChoice() ?? "box"
  }

  /** Save the choice. Projects that exist keep running where they do; only new ones follow it. */
  setRunner(runner: unknown) {
    if (!(SETUP_RUNNERS as readonly unknown[]).includes(runner)) throw new BadRequestError(`runner must be ${SETUP_RUNNERS.join(" or ")}`)
    this.d.store.setKv(RUNNER_KV, runner as Runner)
  }

  /** The last look at this computer, when agents run here. */
  localCheck(): LocalCheck | null {
    return this.runnerChoice() === "local" ? (this.local?.result.check ?? null) : null
  }

  /**
   * Look at this computer's tools and logins again, unless the last look is under a minute old (`force` skips
   * that). Resolves true when anything the status shows changed. Calls made meanwhile share one look.
   */
  refreshLocal(force = false): Promise<boolean> {
    if (!force && this.local && Date.now() - this.local.at < LOCAL_CHECK_TTL_MS) return Promise.resolve(false)
    if (this.checking) return this.checking
    const look = this.d.localCheck ?? (() => checkLocal({ claudeBin: this.d.c.claudeBin, codexBin: this.d.c.codexBin, fakeClaude: isMockRun(this.d.c) }))
    this.checking = look()
      .then((result) => {
        const before = this.local
        this.local = { result, at: Date.now() }
        const strip = (r?: LocalCheckResult) => (r ? JSON.stringify({ ...r.check, checkedAt: 0, gh: Boolean(r.ghToken) }) : "")
        return strip(before?.result) !== strip(result)
      })
      .catch(() => false)
      .finally(() => (this.checking = null))
    return this.checking
  }

  /**
   * Why a task asked to run on `runner` (a per-task runs_on) can't, in plain words, or null when it can. "local" needs
   * this computer's `claude`, signed in or with a Claude key; "box" needs Upstash boxes (a key, or
   * BOX_PROVIDER=local); "docker" needs Docker running and a Claude key (a container can't use this computer's
   * login). Mock mode needs none. Never a reason to run it somewhere else instead. `claudeKey` says whether the task's
   * turns get a Claude key (TaskManager.turnCredentials: its project's, its identity's or Settings'); omitted, it's
   * whether Settings › Credentials has one. "gpu" needs the key of `gpuCloud` (the project's GPU cloud), or of
   * either cloud when there's no project to ask.
   */
  async runnerProblem(runner: Runner, claudeKey?: boolean, cli: AgentCli = "claude", gpuCloud?: GpuProvider): Promise<string | null> {
    const { c, credentials } = this.d
    // SSH machines say for themselves whether they have a Claude login (placement waits for one with the reason).
    if (runner === "ssh") {
      if (cli === "codex") return `${CODEX_ON_MACHINES}: run it with Claude Code there, or with Codex on another runner`
      return this.d.machinesProblem ? this.d.machinesProblem() : "SSH machines aren't available on this Box Yard"
    }
    // Docker first: mock mode's containers are folders and always "run", but a stand-in Docker may not.
    const docker = runner !== "docker" ? null : this.d.dockerProblem ? await this.d.dockerProblem() : "Docker containers aren't available on this Box Yard"
    if (c.mock || docker) return docker
    const creds = credentials.status()
    if (runner === "gpu") {
      const runpod = creds.runpodApiKey.state === "set"
      const vast = creds.vastApiKey.state === "set"
      if (gpuCloud === "vast") return vast ? null : "Vast.ai GPU isn't set up: add a Vast.ai API key in Settings › Credentials"
      if (gpuCloud === "runpod" || !vast) return runpod ? null : "RunPod GPU isn't set up: add a RunPod API key in Settings › RunPod GPU"
      return null
    }
    if (runner === "box") {
      return c.boxProvider === "local" || creds.upstashBoxApiKey.state === "set" ? null : "Upstash boxes aren't set up: add an Upstash Box API key in Settings › Credentials"
    }
    if (cli === "codex") {
      const codexKey = claudeKey ?? (creds.codexAuthJson.state === "set" || creds.codexApiKey.state === "set")
      if (runner === "docker") return codexKey ? null : DOCKER_NEEDS_CODEX_KEY
      await this.refreshLocal()
      const local = this.local?.result.check
      if (!local) return "Box Yard couldn't check this computer's tools (codex --version didn't answer)"
      if (!local.tools.find((t) => t.key === "codex")?.found) return `Codex isn't installed on this computer (\`${c.codexBin} --version\` failed). Install it (npm i -g @openai/codex), then try again`
      if (local.codexLogin === false && !codexKey) return "Codex on this computer isn't signed in: run `codex login`, or add a Codex login in Settings › Credentials"
      return null
    }
    const keySet = claudeKey ?? (creds.claudeOauthToken.state === "set" || creds.anthropicApiKey.state === "set")
    if (runner === "docker") return keySet ? null : DOCKER_NEEDS_CLAUDE_KEY
    await this.refreshLocal()
    const local = this.local?.result.check
    if (!local) return "Box Yard couldn't check this computer's tools (claude --version didn't answer)"
    if (!local.tools.find((t) => t.key === "claude")?.found) return `Claude Code isn't installed on this computer (\`${c.claudeBin} --version\` failed). Install it, then try again`
    if (local.claudeLogin === false && !keySet) return "Claude Code on this computer isn't signed in: run `claude` and log in, or add a Claude key in Settings › Credentials"
    return null
  }

  status(): SetupStatus {
    const { c, credentials } = this.d
    const mock = isMockRun(c)
    const creds = credentials.status()
    const set = (k: CredentialKey) => creds[k].state === "set"
    const choice = this.runnerChoice()
    const onComputer = choice === "local"
    const local = this.localCheck()
    // "This computer" and Docker containers on it need no box at all, so no Upstash key.
    const boxesRequired = !mock && c.boxProvider !== "local" && !onComputer && choice !== "docker"
    // A container can't use this computer's `claude` login: Docker needs a key.
    const claudeSet = set("claudeOauthToken") || set("anthropicApiKey") || (onComputer && local?.claudeLogin === true)
    // The Coordinator runs on this server, so the server's own `codex login` works for it wherever agents run.
    const codexSet = set("codexAuthJson") || set("codexApiKey") || local?.codexLogin === true
    // The Coordinator needs a sign-in for the CLI it runs on; agents set to the other one say so when they start.
    const coordinatorCli = this.d.settings.get().orchestratorCli
    const missing: string[] = []
    // Before the choice, a box key isn't the only way: "This computer" needs none.
    if (boxesRequired && !set("upstashBoxApiKey")) missing.push(choice === null ? NO_RUNNER_CHOICE : CREDENTIAL_INFO.upstashBoxApiKey.label)
    if (onComputer && !mock && local && coordinatorCli === "claude" && !local.tools.find((t) => t.key === "claude")?.found) missing.push("Claude Code on this computer")
    if (!mock && coordinatorCli === "claude" && !claudeSet) missing.push("Claude sign-in")
    if (!mock && coordinatorCli === "codex" && !codexSet) missing.push("Codex sign-in")
    const restart: string[] = []
    if (c.boxProvider === "local" && !mock && set("upstashBoxApiKey")) {
      restart.push("BOX_PROVIDER=local keeps every box on the server's machine. Unset it and restart Box Yard to use Upstash boxes.")
    }
    const info = this.d.settings.info()
    return {
      ready: missing.length === 0,
      missing,
      mock,
      credentials: creds,
      boxes: { provider: this.d.provider(), required: boxesRequired },
      claude: {
        required: !mock,
        state: claudeSet ? "set" : "unset",
        using: set("anthropicApiKey") ? "anthropicApiKey" : set("claudeOauthToken") ? "claudeOauthToken" : null,
      },
      codex: {
        required: !mock && coordinatorCli === "codex",
        state: codexSet ? "set" : "unset",
        using: set("codexAuthJson") ? "codexAuthJson" : set("codexApiKey") ? "codexApiKey" : null,
      },
      github: { state: creds.githubToken.state },
      owner: { name: info.settings.ownerName, source: info.sources.ownerName },
      runner: { choice, default: choice ?? "box" },
      upstash: { available: mock || c.boxProvider === "local" || set("upstashBoxApiKey") },
      local,
      restart,
      authorFallbacks: authorFallbacks(this.d.store).flatMap((r) => {
        const project = this.d.store.getProject(r.projectId)
        if (!project) return []
        return [{ ...r, project: project.name, task: this.d.store.getTaskRow(r.taskId)?.title ?? r.taskId }]
      }),
    }
  }

  /**
   * The repos the GitHub token in effect pushed to most recently, newest first, for the prompts Zen suggests once
   * setup is done. Empty without a token, in mock mode, or when GitHub can't be asked: the prompts then keep their
   * <owner/repo> placeholder, so nothing here is worth an error.
   */
  async recentRepos(limit = 3): Promise<RecentRepos> {
    const token = this.d.credentials.get("githubToken")
    if (isMockRun(this.d.c) || !token) return { repos: [] }
    try {
      const res = await this.request(this.d.githubFetch, "https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=20", { headers: githubHeaders(token) }, "GitHub")
      if (!res.ok) return { repos: [] }
      const list = (await res.json()) as unknown
      if (!Array.isArray(list)) return { repos: [] }
      const repos = list
        .filter((r) => typeof r?.full_name === "string" && !r.archived && !r.disabled)
        .map((r) => r.full_name as string)
      return { repos: repos.slice(0, limit) }
    } catch {
      return { repos: [] }
    }
  }

  /** A cheap live check of `key`: the value typed in the form when there is one, else the one in effect. */
  async test(key: CredentialKey, typed?: string): Promise<CredentialTest> {
    let value = this.d.credentials.get(key)
    if (typed !== undefined && typed.trim()) {
      const parsed = credentialValueFor(key).safeParse(typed)
      if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
      value = parsed.data
    }
    const started = Date.now()
    const secrets = [...this.d.credentials.secrets(), value]
    const done = (ok: boolean, message: string): CredentialTest => ({ ok, message: redact(message, secrets), ms: Date.now() - started })
    if (!value) return done(false, `Nothing to test yet: paste the ${CREDENTIAL_INFO[key].label} first.`)
    try {
      const message = await this.check(key, value)
      return done(true, message)
    } catch (err) {
      return done(false, (err as Error)?.message ?? String(err))
    }
  }

  private check(key: CredentialKey, value: string): Promise<string> {
    if (key === "upstashBoxApiKey") return this.checkBoxes(value)
    if (key === "anthropicApiKey") return this.checkAnthropic(value)
    if (key === "claudeOauthToken") return this.checkClaude({ CLAUDE_CODE_OAUTH_TOKEN: value })
    if (key === "codexAuthJson") return this.checkCodex({ kind: "chatgpt", auth: value })
    if (key === "codexApiKey") return this.checkCodex({ kind: "api_key", key: value })
    if (key === "runpodApiKey") return this.checkRunPod(value)
    if (key === "vastApiKey") return this.checkVast(value)
    return this.checkGitHub(value)
  }

  private get timeoutMs() {
    return this.d.timeoutMs ?? CHECK_TIMEOUT_MS
  }

  /** List the account's boxes. */
  private async checkBoxes(apiKey: string): Promise<string> {
    const list = this.d.listBoxes ?? ((k: string) => Box.list({ apiKey: k }))
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Upstash didn't answer within ${Math.round(this.timeoutMs / 1000)} s.`)), this.timeoutMs)
    })
    try {
      const boxes = await Promise.race([list(apiKey), timeout])
      const live = boxes.filter((b) => b?.status !== "deleted").length
      return `Works: Upstash accepted the key and listed ${live} box${live === 1 ? "" : "es"} on the account.`
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      const message = (err as Error)?.message ?? String(err)
      if (status === 401 || status === 403) throw new Error(`Upstash rejected the key (HTTP ${status}): ${message}`)
      if (status) throw new Error(`Upstash answered HTTP ${status}: ${message}`)
      throw new Error(/didn't answer/.test(message) ? message : `Can't reach Upstash: ${causeOf(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** List the account's network volumes: free, and it needs the same read access starting pods does. */
  private async checkRunPod(apiKey: string): Promise<string> {
    const res = await this.request(this.d.fetch, "https://api.runpod.io/v2/network-volumes", { headers: { Authorization: `Bearer ${apiKey}` } }, "RunPod")
    const body = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`RunPod ${res.status === 401 || res.status === 403 ? "rejected the key" : "failed"} (HTTP ${res.status}): ${providerMessage(body) || res.statusText}`)
    return "Works: RunPod accepted the key."
  }

  /** GET /users/current/: the account the key belongs to (free; it never rents anything). */
  private async checkVast(apiKey: string): Promise<string> {
    const res = await this.request(this.d.fetch, "https://console.vast.ai/api/v0/users/current/", { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }, "Vast.ai")
    const body = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`Vast.ai ${res.status === 401 || res.status === 403 ? "rejected the key" : "failed"} (HTTP ${res.status}): ${providerMessage(body) || res.statusText}`)
    let credit: number | null = null
    try {
      const u = JSON.parse(body) as { credit?: unknown; balance?: unknown }
      const v = u.credit ?? u.balance
      if (typeof v === "number" && Number.isFinite(v)) credit = v
    } catch {}
    return credit === null ? "Works: Vast.ai accepted the key." : `Works: Vast.ai accepted the key ($${credit.toFixed(2)} credit).`
  }

  /** GET /v1/models: free, and it fails the same way a real call would with a bad key. */
  private async checkAnthropic(apiKey: string): Promise<string> {
    const base = (this.d.anthropicBaseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")
    const res = await this.request(this.d.fetch, `${base}/v1/models?limit=1`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } }, "the Anthropic API")
    const body = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`The Anthropic API ${res.status === 401 || res.status === 403 ? "rejected the key" : "failed"} (HTTP ${res.status}): ${providerMessage(body) || res.statusText}`)
    return "Works: the Anthropic API accepted the key."
  }

  /** GET /user: who the token belongs to. */
  private async checkGitHub(token: string): Promise<string> {
    const res = await this.request(
      this.d.githubFetch,
      "https://api.github.com/user",
      { headers: githubHeaders(token) },
      "GitHub",
    )
    const body = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`GitHub ${res.status === 401 || res.status === 403 ? "rejected the token" : "failed"} (HTTP ${res.status}): ${providerMessage(body) || res.statusText}`)
    let login = ""
    try {
      login = String(JSON.parse(body)?.login ?? "")
    } catch {}
    // Classic tokens list their scopes; fine-grained ones don't, and their repo permissions can only be seen by using them.
    const scopes = res.headers.get("x-oauth-scopes")
    const classic = scopes !== null ? ` Classic token scopes: ${scopes.trim() || "none"}${/(^|,\s*)repo(\s*,|$)/.test(scopes) ? "" : " (agents need repo)"}.` : ""
    return `Works: signed in to GitHub${login ? ` as @${login}` : ""}.${classic}`
  }

  private async request(f: typeof fetch | undefined, url: string, init: RequestInit, who: string): Promise<Response> {
    try {
      return await (f ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (err) {
      const name = (err as Error)?.name
      if (name === "TimeoutError" || name === "AbortError") throw new Error(`${who[0]!.toUpperCase()}${who.slice(1)} didn't answer within ${Math.round(this.timeoutMs / 1000)} s.`)
      throw new Error(`Can't reach ${who}: ${causeOf(err)}`)
    }
  }

  /** A one-word reply from the same `codex` agents run, logged in with only `login`. */
  private async checkCodex(login: CodexLogin): Promise<string> {
    const r = await codexLoginCheck(this.d.c.codexBin, login, this.d.timeoutMs ?? CODEX_CHECK_TIMEOUT_MS)
    // The check may have refreshed the ChatGPT tokens: keep the new ones, the old refresh token is spent.
    if (r.refreshed) this.d.credentials.adoptCodexAuth(r.refreshed)
    if (!r.ok) throw new Error(r.text)
    return login.kind === "chatgpt" ? "Works: Codex answered using this ChatGPT login." : "Works: Codex answered using this API key."
  }

  /** A one-word reply from the same `claude` the Coordinator runs, logged in with only `login`. */
  private async checkClaude(login: Record<string, string>): Promise<string> {
    const r = await claudeLoginCheck(this.d.c.claudeBin, login, this.d.timeoutMs ?? CLAUDE_CHECK_TIMEOUT_MS)
    if (!r.ok) throw new Error(r.text)
    return "Works: Claude answered using this token."
  }
}

const githubHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "box-yard", "X-GitHub-Api-Version": "2022-11-28" })

const causeOf = (err: unknown) => {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause
  return cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err)
}

/** Env vars that would log `claude` in some other way and hide whether `login` works. */
const OTHER_LOGINS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

/**
 * Run `claude -p` once with a tiny prompt, logged in only with `login`, in a throwaway config dir (so a `claude` login
 * on the server's machine can't make a bad token pass). Resolves with the CLI's own error text when it fails.
 */
export function claudeLoginCheck(claudeBin: string, login: Record<string, string>, timeoutMs = CLAUDE_CHECK_TIMEOUT_MS): Promise<{ ok: boolean; text: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-claude-check-"))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (OTHER_LOGINS.includes(k) || k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
  Object.assign(env, { DISABLE_AUTOUPDATER: "1", CLAUDE_CONFIG_DIR: dir }, login)
  const [bin, ...pre] = claudeBin.split(" ")
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, text: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(dir, { recursive: true, force: true })
      resolve({ ok, text })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin!, [...pre, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns", "1"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      return finish(false, `Couldn't start claude (${claudeBin}): ${(err as Error).message}`)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(false, `Claude didn't answer within ${Math.round(timeoutMs / 1000)} s.`)
    }, timeoutMs)
    let out = ""
    let err = ""
    let result: { is_error?: boolean; result?: string; subtype?: string } | null = null
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line.startsWith("{")) continue
        try {
          const ev = JSON.parse(line)
          if (ev?.type === "result") result = ev
        } catch {}
      }
    })
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2000)))
    child.on("error", (e) => finish(false, `Couldn't start claude (${claudeBin}): ${e.message}. Install it on the server: npm i -g @anthropic-ai/claude-code`))
    child.on("close", (code) => {
      if (result && !result.is_error) return finish(true, String(result.result ?? ""))
      const text = (result?.result || err.trim().split("\n").slice(-3).join(" ") || `claude exited with code ${code}`).trim()
      finish(false, `Claude said: ${text}`)
    })
    child.stdin!.on("error", () => {})
    child.stdin!.end("Reply with the single word OK.")
  })
}

/** Env vars that would log `codex` in some other way and hide whether `login` works. */
const OTHER_CODEX_LOGINS = ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME"]

/**
 * Run `codex exec` once with a tiny prompt, logged in only with `login`, in a throwaway CODEX_HOME (so this machine's
 * own `codex login` can't make a bad one pass). Resolves with Codex's own error text when it fails, and with the login
 * file as Codex left it when it refreshed the tokens (the caller keeps that copy: the old refresh token is spent).
 */
export function codexLoginCheck(codexBin: string, login: CodexLogin, timeoutMs = CODEX_CHECK_TIMEOUT_MS): Promise<{ ok: boolean; text: string; refreshed: string | null }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-codex-check-"))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of OTHER_CODEX_LOGINS) delete env[k]
  env.CODEX_HOME = home
  if (login.kind === "chatgpt") seedCodexAuth(home, login.auth)
  else env.CODEX_API_KEY = login.key
  const [bin, ...pre] = codexBin.split(" ")
  const args = [...pre, ...codexExecArgs({ resume: null, model: null, effort: "low", instructions: "", manager: true, webSearch: false })]
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, text: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let refreshed: string | null = null
      try {
        const after = fs.readFileSync(path.join(home, "auth.json"), "utf8")
        if (login.kind === "chatgpt" && isRefreshOf(login.auth, after)) refreshed = after
      } catch {}
      fs.rmSync(home, { recursive: true, force: true })
      resolve({ ok, text, refreshed })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin!, args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      return finish(false, `Couldn't start codex (${codexBin}): ${(err as Error).message}`)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(false, `Codex didn't answer within ${Math.round(timeoutMs / 1000)} s.`)
    }, timeoutMs)
    const stream = new CodexStream()
    let out = ""
    let err = ""
    let said = ""
    let failure: string | null = null
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        for (const m of stream.push(line)) {
          if (m.type === "assistant") said += (m.message?.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("")
          if (m.type === "result" && m.is_error) failure = String(m.result)
        }
      }
    })
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2000)))
    child.on("error", (e) => finish(false, `Couldn't start codex (${codexBin}): ${e.message}. Install it on the server: npm i -g @openai/codex`))
    child.on("close", (code) => {
      if (code === 0 && stream.sawResult && !failure) return finish(true, said.trim())
      const last = err.trim().split("\n").filter((l) => !/models_manager|WARN|INFO/.test(l)).slice(-3).join(" ")
      finish(false, `Codex said: ${(failure || stream.lastError || last || `codex exited with code ${code}`).trim()}`)
    })
    child.stdin!.on("error", () => {})
    child.stdin!.end("Reply with the single word OK.")
  })
}
