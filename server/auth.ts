import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import type { Store } from "./store.js"

const COOKIE = "by_session"

/** Optional shared-password login. With no password set, everything is open (localhost use). */
export class Auth {
  private secret: string

  constructor(
    private readonly password: string,
    store: Store,
  ) {
    let secret = store.getKv("cookie_secret")
    if (!secret) {
      secret = randomBytes(32).toString("hex")
      store.setKv("cookie_secret", secret)
    }
    this.secret = secret
  }

  get enabled() {
    return Boolean(this.password)
  }

  private token() {
    return createHmac("sha256", this.secret).update(`box-yard:${this.password}`).digest("hex")
  }

  check(password: string) {
    const a = Buffer.from(password)
    const b = Buffer.from(this.password)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  isAuthed(req: Request) {
    if (!this.enabled) return true
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "")
    if (bearer && this.check(bearer)) return true
    const cookie = parseCookies(req.headers.cookie)[COOKIE]
    return Boolean(cookie) && cookie === this.token()
  }

  login(res: Response, secure: boolean) {
    res.cookie(COOKIE, this.token(), {
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: 1000 * 60 * 60 * 24 * 90,
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

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}
