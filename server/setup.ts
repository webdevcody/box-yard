// GET /api/setup and the Test buttons behind POST /api/setup/test/:key: what's missing before Box Yard can do real
// work, and a cheap live check of each credential. Nothing here returns or logs a secret: every message goes
// through redact().
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Box } from "@upstash/box"
import type { Config } from "./config.js"
import { BadRequestError } from "./store.js"
import { credentialValue, redact, type CredentialStore } from "./credentials.js"
import type { SettingsStore } from "./settings.js"
import { providerMessage } from "./tts.js"
import { CREDENTIAL_INFO, type CredentialKey, type CredentialTest, type RecentRepos, type SetupStatus } from "../shared/setup.js"

export const CHECK_TIMEOUT_MS = 15_000
/** A real `claude` call takes a few seconds to start. */
export const CLAUDE_CHECK_TIMEOUT_MS = 60_000

export interface SetupDeps {
  c: Config
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
}

/** Mock mode, or a fake `claude` standing in for the real one: nothing needs a key. */
export const isMockRun = (c: Pick<Config, "mock" | "claudeBin">) => c.mock || /fake-claude/.test(c.claudeBin)

export class Setup {
  constructor(private readonly d: SetupDeps) {}

  status(): SetupStatus {
    const { c, credentials } = this.d
    const mock = isMockRun(c)
    const creds = credentials.status()
    const set = (k: CredentialKey) => creds[k].state === "set"
    const boxesRequired = !mock && c.boxProvider !== "local"
    const claudeSet = set("claudeOauthToken") || set("anthropicApiKey")
    const missing: string[] = []
    if (boxesRequired && !set("upstashBoxApiKey")) missing.push(CREDENTIAL_INFO.upstashBoxApiKey.label)
    if (!mock && !claudeSet) missing.push("Claude sign-in")
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
      github: { state: creds.githubToken.state },
      owner: { name: info.settings.ownerName, source: info.sources.ownerName },
      restart,
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
      const parsed = credentialValue.safeParse(typed)
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
