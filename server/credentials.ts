import { z } from "zod"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import { redactPrivateKeys, redactValues } from "./redact.js"
import { CREDENTIAL_INFO, CREDENTIAL_KEYS, type CredentialKey, type CredentialSource, type CredentialStatus } from "../shared/setup.js"
import { codexAuthSecrets, isCodexAuth, isRefreshOf, parseCodexAuth } from "./codex.js"

/** Saved values live in their own kv entry, like the TTS keys, so nothing that returns settings can include them. */
const KV = "credentials"
/**
 * The Codex ChatGPT login as Codex last refreshed it (a box's or this server's copy, taken back after a run). Its
 * refresh token replaces the one pasted in, which may be spent: Codex rotates it on every refresh.
 */
const CODEX_REFRESHED_KV = "codex_auth_refreshed"

export const credentialValue = z
  .string()
  .trim()
  .min(8, "That looks too short to be a key or token")
  .max(2000, "That's too long to be a key or token")
  .regex(/^[\x21-\x7e]+$/, "Keys and tokens have no spaces or special characters")

/** The Codex login file (~/.codex/auth.json): JSON, so it has spaces; kept minified. */
export const codexAuthValue = z
  .string()
  .trim()
  .max(50_000, "That's too long to be a Codex auth.json")
  .transform((text, ctx) => {
    const auth = parseCodexAuth(text)
    if (isCodexAuth(auth)) return auth.text
    ctx.addIssue({ code: "custom", message: auth.error })
    return z.NEVER
  })

/** The validator for a value of credential `k`. */
export const credentialValueFor = (k: CredentialKey) => (k === "codexAuthJson" ? codexAuthValue : credentialValue)

export const credentialsPatch = z
  .object(Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, credentialValueFor(k).nullable()])) as unknown as Record<CredentialKey, z.ZodNullable<z.ZodType<string>>>)
  .partial()
  .strict()

/** The login Box Yard hands Codex: the ChatGPT login file, or an API key (CODEX_API_KEY). */
export type CodexLogin = { kind: "chatgpt"; auth: string } | { kind: "api_key"; key: string }

/**
 * The Upstash Box API key, Claude credentials and GitHub token. The env var always wins (UPSTASH_BOX_API_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN, read into Config at startup); otherwise the value saved
 * in Settings › Credentials applies. Everything that uses one reads it here on each use, so a saved value takes
 * effect without a restart. Values stay on the server: status() reports only set/unset and the source.
 */
export class CredentialStore {
  private cache: Partial<Record<CredentialKey, string>> | null = null
  private readonly listeners = new Set<() => void>()
  /** The GitHub token of this computer's `gh auth` login, used only when nothing else is set (Setup decides when). */
  private ghFallback: () => string = () => ""

  constructor(
    private readonly store: Store,
    private readonly env: Partial<Pick<Config, CredentialKey>>,
  ) {}

  private saved(): Partial<Record<CredentialKey, string>> {
    if (this.cache) return this.cache
    let parsed: Partial<Record<CredentialKey, string>> = {}
    try {
      const raw = JSON.parse(this.store.getKv(KV) ?? "{}")
      for (const k of CREDENTIAL_KEYS) if (typeof raw?.[k] === "string" && raw[k]) parsed[k] = raw[k]
    } catch {
      parsed = {}
    }
    this.cache = parsed
    return parsed
  }

  private envValue(k: CredentialKey): string {
    const v = this.env[k]?.trim() ?? ""
    // CODEX_AUTH_JSON may hold the file base64-encoded, which survives env files and quoting better.
    if (k === "codexAuthJson" && v && !v.startsWith("{")) {
      const decoded = Buffer.from(v, "base64").toString("utf8").trim()
      return decoded.startsWith("{") ? decoded : v
    }
    return v
  }

  private fallback(k: CredentialKey): string {
    return k === "githubToken" ? this.ghFallback().trim() : ""
  }

  /** Where a missing GitHub token comes from instead: `gh auth token` while agents run on this computer. */
  setGhFallback(fn: () => string) {
    this.ghFallback = fn
  }

  /** The value to use (server-side only), or "" when none is set. */
  get(k: CredentialKey): string {
    return this.envValue(k) || this.saved()[k] || this.fallback(k)
  }

  source(k: CredentialKey): CredentialSource | null {
    return this.envValue(k) ? "env" : this.saved()[k] ? "saved" : this.fallback(k) ? "gh" : null
  }

  status(): Record<CredentialKey, CredentialStatus> {
    return Object.fromEntries(
      CREDENTIAL_KEYS.map((k) => {
        const source = this.source(k)
        return [k, { state: source ? "set" : "unset", source }]
      }),
    ) as Record<CredentialKey, CredentialStatus>
  }

  /** Every value in effect, for building a Config-shaped view (configProblems). */
  values(): Record<CredentialKey, string> {
    return Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, this.get(k)])) as Record<CredentialKey, string>
  }

  /** Env vars a `claude` process logs in with: whichever Claude credentials are set. */
  claudeEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    const oauth = this.get("claudeOauthToken")
    const key = this.get("anthropicApiKey")
    if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth
    if (key) env.ANTHROPIC_API_KEY = key
    return env
  }

  /**
   * The Codex ChatGPT login file in effect: the one set (env or Settings), or the copy Codex refreshed from it since,
   * when that copy is the same account's and newer. "" when none is set.
   */
  codexAuth(): string {
    const set = this.get("codexAuthJson")
    if (!set) return ""
    const refreshed = this.store.getKv(CODEX_REFRESHED_KV) ?? ""
    return refreshed && isRefreshOf(set, refreshed) ? refreshed : set
  }

  /**
   * Keep `text` (an auth.json a Codex run refreshed) when it's the login in effect, refreshed later; anything else
   * (another account, an older copy, a file that isn't a login) is ignored. Returns whether it was kept.
   */
  adoptCodexAuth(text: string): boolean {
    const current = this.codexAuth()
    const next = parseCodexAuth(text.trim())
    if (!current || !isCodexAuth(next) || !isRefreshOf(current, next.text)) return false
    this.store.setKv(CODEX_REFRESHED_KV, next.text)
    return true
  }

  /** The login Codex runs get: the ChatGPT login when it's set (no per-call charges), else the API key, else none. */
  codexLogin(): CodexLogin | null {
    const auth = this.codexAuth()
    if (auth) return { kind: "chatgpt", auth }
    const key = this.get("codexApiKey")
    return key ? { kind: "api_key", key } : null
  }

  /** Every secret in effect, for redact(). */
  secrets(): string[] {
    const values = CREDENTIAL_KEYS.flatMap((k) => [this.envValue(k), this.saved()[k] ?? "", this.fallback(k)]).filter(Boolean)
    // A login file's tokens show up on their own (an error that quotes one), never the file as a whole.
    const codex = [this.get("codexAuthJson"), this.store.getKv(CODEX_REFRESHED_KV) ?? ""].flatMap(codexAuthSecrets)
    return [...values, ...codex]
  }

  /** Save or forget values. A credential its env var sets can't be changed here: the env var would still win. */
  update(patch: unknown) {
    const parsed = credentialsPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
    const next = { ...this.saved() }
    for (const [k, v] of Object.entries(parsed.data) as [CredentialKey, string | null | undefined][]) {
      if (v === undefined) continue
      if (this.envValue(k)) throw new BadRequestError(`${CREDENTIAL_INFO[k].env} is set on the server, and it always wins. Change it there.`)
      if (v === null) delete next[k]
      else next[k] = v
    }
    this.store.setKv(KV, Object.keys(next).length ? JSON.stringify(next) : null)
    // A new (or forgotten) ChatGPT login starts over: the refreshed copy belonged to the old one.
    if (parsed.data.codexAuthJson !== undefined) this.store.setKv(CODEX_REFRESHED_KV, null)
    this.cache = null
    for (const fn of this.listeners) fn()
  }

  /** Called after every update(). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** Shapes keys and tokens take, redacted even when we don't know the value (an error that echoes a typed key). */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\brpa_[A-Za-z0-9]{16,}/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]

/** `text` with every known secret, and anything shaped like a key or token, replaced by "[redacted]". */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = redactPrivateKeys(redactValues(text, secrets))
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m, word?: string) => (typeof word === "string" && /^(bearer|token)$/i.test(word) ? `${word} [redacted]` : "[redacted]"))
  return out
}
