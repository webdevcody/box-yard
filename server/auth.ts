import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import type { Store } from "./store.js"
import { CLIENT_LIMITS, LoginLimiter, PEER_LIMITS, type Blocked } from "./loginLimit.js"

const COOKIE = "by_session"
const SESSION_MS = 1000 * 60 * 60 * 24 * 90

/** SHA-256 of the NFKC form, so the comparison is always 32 bytes against 32 and a phone's é matches the .env's. */
const digest = (s: string) => createHash("sha256").update(s.normalize("NFKC"), "utf8").digest()

export type LoginResult = { ok: true } | { ok: false; blocked: Blocked | null }

/**
 * Optional shared-password login. With no password set, everything is open (localhost use).
 *
 * A session cookie is `<random 32 bytes>.<issued at>.<HMAC>`, signed with a secret kept in the database and the
 * password's hash: it outlives restarts, every login gets a new one, and changing the password ends them all.
 * Password checks (the login form and a Bearer header) go through the per-client and per-address limiters.
 */
export class Auth {
  private secret: string
  private readonly hash: Buffer
  private readonly now: () => number
  private readonly log: (line: string) => void
  readonly clients: LoginLimiter
  readonly peers: LoginLimiter

  constructor(
    private readonly password: string,
    store: Store,
    opts: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    let secret = store.getKv("cookie_secret")
    if (!secret) {
      secret = randomBytes(32).toString("hex")
      store.setKv("cookie_secret", secret)
    }
    this.secret = secret
    this.hash = digest(password)
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((line) => console.warn(line))
    this.clients = new LoginLimiter(CLIENT_LIMITS, this.now)
    this.peers = new LoginLimiter(PEER_LIMITS, this.now)
  }

  get enabled() {
    return Boolean(this.password)
  }

  /** Constant time: both sides are hashed first, so neither the length nor the content leaks through timing. */
  check(password: string) {
    return timingSafeEqual(digest(password), this.hash)
  }

  /** A password try from `req`: refused unchecked while the client is held back, and counted when wrong. */
  attempt(req: Request, password: string): LoginResult {
    const { client, peer } = clientKeys(req)
    const held = this.clients.blocked(client) ?? this.peers.blocked(peer)
    if (held) return { ok: false, blocked: held }
    if (this.check(password)) {
      this.clients.succeed(client)
      return { ok: true }
    }
    const { failures, blocked } = this.clients.fail(client)
    const peerFail = this.peers.fail(peer)
    const window = Math.round(this.clients.opts.windowMs / 60_000)
    this.log(`[box-yard] failed login from ${client}${peer !== client ? ` via ${peer}` : ""} (${failures} in ${window} min)`)
    if (blocked?.locked) this.log(`[box-yard] ${client} is locked out of logging in for ${Math.round(this.clients.opts.lockMs / 60_000)} min`)
    if (peerFail.blocked?.locked) this.log(`[box-yard] every login through ${peer} is locked out for ${Math.round(this.peers.opts.lockMs / 60_000)} min: ${peerFail.failures} failures`)
    return { ok: false, blocked: blocked?.locked ? blocked : peerFail.blocked?.locked ? peerFail.blocked : null }
  }

  private sign(nonce: string, issued: string) {
    return createHmac("sha256", this.secret).update(`box-yard-session:${nonce}.${issued}:`).update(this.hash).digest()
  }

  /** A new random session token. */
  token() {
    const nonce = randomBytes(32).toString("base64url")
    const issued = this.now().toString(36)
    return `${nonce}.${issued}.${this.sign(nonce, issued).toString("base64url")}`
  }

  validSession(token: string | undefined) {
    const [nonce, issued, mac, extra] = token?.split(".") ?? []
    if (!nonce || !issued || !mac || extra !== undefined) return false
    const at = parseInt(issued, 36)
    if (!Number.isFinite(at) || at > this.now() + 60_000 || this.now() - at > SESSION_MS) return false
    const given = Buffer.from(mac, "base64url")
    const want = this.sign(nonce, issued)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  isAuthed(req: Request) {
    if (!this.enabled) return true
    if (this.validSession(parseCookies(req.headers.cookie)[COOKIE])) return true
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "")
    return Boolean(bearer) && this.attempt(req, bearer!).ok
  }

  login(res: Response, secure: boolean) {
    res.cookie(COOKIE, this.token(), {
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: SESSION_MS,
    })
  }

  logout(res: Response) {
    res.clearCookie(COOKIE)
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.isAuthed(req)) return next()
      res.status(401).json({ error: "Log in first." })
    }
  }
}

/**
 * Who is trying. `client` is the address the nearest proxy saw (the last X-Forwarded-For entry, which a client can't
 * forge behind a proxy, unlike the first one Express's req.ip picks), else the connection's. `peer` is always the
 * connection's own address.
 */
export function clientKeys(req: Request) {
  const peer = req.socket?.remoteAddress?.replace(/^::ffff:/, "") || "unknown"
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1)
  return { client: forwarded || peer, peer }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A malformed cookie from some other app on this host: ignore it.
    }
  }
  return out
}
