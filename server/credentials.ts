import { z } from "zod"
import type { Config } from "./config.js"
import { BadRequestError, type Store } from "./store.js"
import { CREDENTIAL_INFO, CREDENTIAL_KEYS, type CredentialKey, type CredentialSource, type CredentialStatus } from "../shared/setup.js"

/** Saved values live in their own kv entry, like the TTS keys, so nothing that returns settings can include them. */
const KV = "credentials"

export const credentialValue = z
  .string()
  .trim()
  .min(8, "That looks too short to be a key or token")
  .max(2000, "That's too long to be a key or token")
  .regex(/^[\x21-\x7e]+$/, "Keys and tokens have no spaces or special characters")

export const credentialsPatch = z
  .object(Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, credentialValue.nullable()])) as Record<CredentialKey, z.ZodNullable<typeof credentialValue>>)
  .partial()
  .strict()

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
    return this.env[k]?.trim() ?? ""
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

  /** Every secret in effect, for redact(). */
  secrets(): string[] {
    return CREDENTIAL_KEYS.flatMap((k) => [this.envValue(k), this.saved()[k] ?? "", this.fallback(k)]).filter(Boolean)
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
  /\bgh[opsu]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]

/** `text` with every known secret, and anything shaped like a key or token, replaced by "[redacted]". */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  // Longest first, so a secret that contains another is replaced whole.
  for (const s of [...new Set(secrets.filter((s) => s && s.length >= 6))].sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]")
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m, word?: string) => (typeof word === "string" && /^(bearer|token)$/i.test(word) ? `${word} [redacted]` : "[redacted]"))
  return out
}
