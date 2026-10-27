// What GitHub says about a token, for identities: whose it is (GET /user), its scopes and expiry (response headers),
// and the account's verified emails (GET /user/emails, when the token may read them). Nothing here logs or returns a
// token; errors name the HTTP status, never the request.

export type GithubFetch = typeof fetch

const API = "https://api.github.com"

export interface GithubTokenInfo {
  login: string
  id: number
  name: string | null
  /** A classic token's scopes (X-OAuth-Scopes); null for a fine-grained token, which lists none. */
  scopes: string[] | null
  /** Epoch ms, from GitHub-Authentication-Token-Expiration; null when it doesn't expire. */
  expiresAt: number | null
}

export class GithubTokenError extends Error {}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" })

/** "2026-11-01 00:00:00 UTC" (GitHub's format) as epoch ms. */
export function parseGithubExpiry(v: string | null): number | null {
  if (!v) return null
  const ms = Date.parse(v.replace(" UTC", "Z").replace(" ", "T"))
  return Number.isFinite(ms) ? ms : null
}

/** Whose token this is. Throws GithubTokenError with a sentence for Cody when GitHub refuses it. */
export async function githubTokenInfo(token: string, f: GithubFetch = fetch): Promise<GithubTokenInfo> {
  let res: Response
  try {
    res = await f(`${API}/user`, { headers: headers(token), signal: AbortSignal.timeout(15_000) })
  } catch (err) {
    throw new GithubTokenError(`Couldn't reach GitHub to check the token (${err instanceof Error ? err.name : "network error"}).`)
  }
  if (res.status === 401) throw new GithubTokenError("GitHub doesn't accept this token (401): it's wrong, revoked or expired.")
  if (!res.ok) throw new GithubTokenError(`GitHub answered ${res.status} when checking the token.`)
  const body = (await res.json().catch(() => null)) as { login?: unknown; id?: unknown; name?: unknown } | null
  if (typeof body?.login !== "string" || typeof body.id !== "number") throw new GithubTokenError("GitHub's answer for this token has no login.")
  const scopes = res.headers.get("x-oauth-scopes")
  return {
    login: body.login,
    id: body.id,
    name: typeof body.name === "string" ? body.name : null,
    scopes: scopes === null ? null : scopes.split(",").map((s) => s.trim()).filter(Boolean),
    expiresAt: parseGithubExpiry(res.headers.get("github-authentication-token-expiration")),
  }
}

/** The account's verified emails, or null when the token may not read them (no user:email scope). */
export async function githubVerifiedEmails(token: string, f: GithubFetch = fetch): Promise<string[] | null> {
  const res = await f(`${API}/user/emails`, { headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as { email?: unknown; verified?: unknown }[] | null
  if (!Array.isArray(body)) return null
  return body.filter((e) => e.verified === true && typeof e.email === "string").map((e) => (e.email as string).toLowerCase())
}

/** GitHub's noreply addresses for an account, which count as its own: `<id>+<login>@…` and the older `<login>@…`. */
export const noreplyEmails = (login: string, id: number) => [`${id}+${login}@users.noreply.github.com`.toLowerCase(), `${login}@users.noreply.github.com`.toLowerCase()]
