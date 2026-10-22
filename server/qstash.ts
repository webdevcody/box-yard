import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { errorMessage } from "./util/retry.js"

/**
 * Minimal Upstash QStash client: create and delete cron schedules that POST
 * to a Box Yard URL, and verify the signature QStash puts on each delivery.
 *
 * QStash is optional. It keeps schedules firing when the server's own timer
 * can't (for example while the orchestrator's box is paused), because the
 * HTTP request from QStash wakes the server up.
 */
export class QStash {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://qstash.upstash.io",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
      body: init.body,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`QStash ${method} ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}`)
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /**
   * Create or replace the schedule `id` so QStash POSTs `body` to `destination`
   * on `cron` (5 plain fields) in time zone `timezone`.
   */
  async upsertSchedule(input: { id: string; destination: string; cron: string; timezone: string; body: string }): Promise<string> {
    const cron = input.timezone && input.timezone !== "UTC" ? `CRON_TZ=${input.timezone} ${input.cron}` : input.cron
    const out = await this.request("POST", `/v2/schedules/${input.destination}`, {
      headers: {
        "Upstash-Cron": cron,
        "Upstash-Schedule-Id": input.id,
        "Upstash-Retries": "3",
        "Content-Type": "application/json",
      },
      body: input.body,
    })
    return typeof out.scheduleId === "string" ? out.scheduleId : input.id
  }

  async deleteSchedule(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/v2/schedules/${encodeURIComponent(id)}`)
    } catch (err) {
      // Already gone is fine.
      if (!/\(404\)/.test(errorMessage(err))) throw err
    }
  }
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const unpad = (s: string) => s.replace(/=+$/, "")

/**
 * Check an `Upstash-Signature` header: a HS256 JWT signed with the current or
 * next signing key, issued by Upstash, for this exact URL and body.
 * Returns null when valid, else the reason it isn't.
 */
export function verifyQStashSignature(input: {
  signature: string | undefined
  body: string
  url: string
  keys: string[]
  now?: number
}): string | null {
  const { signature, body, url } = input
  if (!signature) return "missing Upstash-Signature header"
  const keys = input.keys.filter(Boolean)
  if (!keys.length) return "QStash signing keys are not configured"
  const parts = signature.split(".")
  if (parts.length !== 3) return "malformed signature"
  const [header, payload, sig] = parts as [string, string, string]
  const signed = `${header}.${payload}`
  const good = keys.some((key) => {
    const expected = Buffer.from(b64url(createHmac("sha256", key).update(signed).digest()))
    const given = Buffer.from(unpad(sig))
    return expected.length === given.length && timingSafeEqual(expected, given)
  })
  if (!good) return "bad signature"
  let claims: { iss?: string; sub?: string; exp?: number; nbf?: number; body?: string }
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return "unreadable claims"
  }
  const nowS = Math.floor((input.now ?? Date.now()) / 1000)
  if (claims.iss !== "Upstash") return "wrong issuer"
  if (claims.sub !== url) return `signed for ${claims.sub}, not ${url}`
  if (typeof claims.exp === "number" && nowS > claims.exp + 60) return "signature expired"
  if (typeof claims.nbf === "number" && nowS < claims.nbf - 60) return "signature not valid yet"
  const bodyHash = b64url(createHash("sha256").update(body).digest())
  if (unpad(claims.body ?? "") !== bodyHash) return "body does not match signature"
  return null
}

/** Make a signature the way QStash does. Used by tests and the local fake. */
export function signLikeQStash(input: { key: string; url: string; body: string; now?: number }): string {
  const nowS = Math.floor((input.now ?? Date.now()) / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: "Upstash",
        sub: input.url,
        exp: nowS + 300,
        nbf: nowS,
        iat: nowS,
        jti: `jwt_${nowS}`,
        body: b64url(createHash("sha256").update(input.body).digest()),
      }),
    ),
  )
  const sig = b64url(createHmac("sha256", input.key).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}
