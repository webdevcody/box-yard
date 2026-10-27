import * as crypto from "node:crypto"
import type { Server } from "node:http"
import type { Request } from "express"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Auth, clientKeys } from "../server/auth.js"
import { createBoxYard } from "../server/app.js"
import { openDb } from "../server/db.js"
import { CLIENT_LIMITS, LoginLimiter, waitText } from "../server/loginLimit.js"
import { Store } from "../server/store.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>()
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) }
})

const PW = "lantern-gravel-quokka-sonnet"
const MIN = 60_000

function clock(start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, tick: (ms: number) => void (t += ms) }
}

function fakeReq(ip: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: ip } } as unknown as Request
}

function auth(password = PW) {
  const c = clock()
  const logs: string[] = []
  const a = new Auth(password, new Store(openDb(tmpDir())), { now: c.now, log: (l) => void logs.push(l) })
  return { a, c, logs }
}

describe("LoginLimiter", () => {
  it("lets a few failures through, then waits longer after each", () => {
    const c = clock()
    const l = new LoginLimiter(CLIENT_LIMITS, c.now)
    for (let i = 0; i < 3; i++) {
      expect(l.blocked("ip")).toBeNull()
      l.fail("ip")
    }
    // The 3rd failure starts the waits: 1 s, then 2 s, 4 s…
    expect(l.blocked("ip")).toMatchObject({ retryAfterMs: 1000, locked: false, message: "Too many attempts, try again in 1 second." })
    c.tick(1000)
    expect(l.blocked("ip")).toBeNull()
    l.fail("ip")
    expect(l.blocked("ip")?.retryAfterMs).toBe(2000)
    c.tick(2000)
    l.fail("ip")
    expect(l.blocked("ip")?.retryAfterMs).toBe(4000)
    // Other clients aren't held back.
    expect(l.blocked("other")).toBeNull()
  })

  it("locks a client out after 10 failures in the window, then starts it over", () => {
    const c = clock()
    const l = new LoginLimiter(CLIENT_LIMITS, c.now)
    let last
    for (let i = 0; i < 10; i++) {
      c.tick(31_000)
      expect(l.blocked("ip")).toBeNull()
      last = l.fail("ip")
    }
    expect(last).toMatchObject({ failures: 10, blocked: { locked: true, retryAfterMs: 15 * MIN, message: "Too many attempts, try again in 15 minutes." } })
    c.tick(14 * MIN + 1)
    expect(l.blocked("ip")?.message).toBe("Too many attempts, try again in 1 minute.")
    c.tick(MIN)
    expect(l.blocked("ip")).toBeNull()
    expect(l.failures("ip")).toBe(0)
  })

  it("forgets failures older than the window, and a success clears them", () => {
    const c = clock()
    const l = new LoginLimiter(CLIENT_LIMITS, c.now)
    for (let i = 0; i < 5; i++) l.fail("ip")
    c.tick(15 * MIN + 1)
    expect(l.failures("ip")).toBe(0)
    expect(l.blocked("ip")).toBeNull()
    for (let i = 0; i < 5; i++) l.fail("ip")
    expect(l.blocked("ip")).not.toBeNull()
    l.succeed("ip")
    expect(l.blocked("ip")).toBeNull()
    expect(l.failures("ip")).toBe(0)
  })

  it("remembers at most maxClients, dropping the stalest", () => {
    const l = new LoginLimiter({ ...CLIENT_LIMITS, maxClients: 3 })
    for (const ip of ["a", "b", "c", "d"]) l.fail(ip)
    expect(["a", "b", "c", "d"].map((ip) => l.failures(ip))).toEqual([0, 1, 1, 1])
  })

  it("rounds waits up", () => {
    expect(waitText(1)).toBe("1 second")
    expect(waitText(29_001)).toBe("30 seconds")
    expect(waitText(59_999)).toBe("1 minute")
    expect(waitText(60_000)).toBe("1 minute")
    expect(waitText(60_001)).toBe("2 minutes")
  })
})

describe("Auth", () => {
  it("compares hashes in constant time, whatever the length typed", () => {
    const { a } = auth()
    const spy = vi.mocked(crypto.timingSafeEqual)
    for (const typed of [PW, "x", PW + "x", ""]) {
      spy.mockClear()
      expect(a.check(typed)).toBe(typed === PW)
      expect(spy).toHaveBeenCalledTimes(1)
      const [x, y] = spy.mock.calls[0]! as [Buffer, Buffer]
      expect([x.length, y.length]).toEqual([32, 32])
    }
  })

  it("locks a client out after 10 wrong passwords, refuses even the right one unchecked, and lets it in after the lockout", () => {
    const { a, c, logs } = auth()
    const req = fakeReq("100.64.1.2")
    for (let i = 1; i <= 10; i++) {
      c.tick(31_000)
      const r = a.attempt(req, "wrong guess")
      expect(r.ok).toBe(false)
      if (i < 10) expect(r).toEqual({ ok: false, blocked: null })
      else expect(r).toMatchObject({ ok: false, blocked: { locked: true, message: "Too many attempts, try again in 15 minutes." } })
    }
    expect(logs.filter((l) => l.startsWith("[box-yard] failed login from 100.64.1.2"))).toHaveLength(10)
    expect(logs.at(-1)).toMatch(/100\.64\.1\.2 is locked out of logging in for 15 min/)
    expect(logs.join("\n")).not.toContain("wrong guess")

    const spy = vi.mocked(crypto.timingSafeEqual)
    spy.mockClear()
    expect(a.attempt(req, PW)).toMatchObject({ ok: false, blocked: { locked: true } })
    expect(spy).not.toHaveBeenCalled()
    // Another device logs in fine meanwhile.
    expect(a.attempt(fakeReq("100.64.9.9"), PW)).toEqual({ ok: true })

    c.tick(15 * MIN)
    expect(a.attempt(req, PW)).toEqual({ ok: true })
  })

  it("never counts successful logins, and a success resets the client's failures", () => {
    const { a, c } = auth()
    const req = fakeReq("192.168.1.5")
    for (let i = 0; i < 50; i++) expect(a.attempt(req, PW)).toEqual({ ok: true })
    for (let i = 0; i < 3; i++) a.attempt(req, "typo")
    expect(a.attempt(req, PW)).toMatchObject({ ok: false, blocked: { locked: false } })
    c.tick(1000)
    expect(a.attempt(req, PW)).toEqual({ ok: true })
    expect(a.clients.failures("192.168.1.5")).toBe(0)
    expect(a.attempt(req, "typo")).toEqual({ ok: false, blocked: null })
  })

  it("counts wrong Bearer passwords like wrong logins", () => {
    const { a } = auth()
    const req = fakeReq("10.0.0.7", { authorization: "Bearer nope" })
    for (let i = 0; i < 3; i++) expect(a.isAuthed(req)).toBe(false)
    expect(a.clients.failures("10.0.0.7")).toBe(3)
    expect(a.isAuthed(fakeReq("10.0.0.7", { authorization: `Bearer ${PW}` }))).toBe(false)
    expect(a.isAuthed(fakeReq("10.0.0.8", { authorization: `Bearer ${PW}` }))).toBe(true)
  })

  it("keys clients by the last X-Forwarded-For hop, and also limits the connecting address", () => {
    expect(clientKeys(fakeReq("::ffff:127.0.0.1"))).toEqual({ client: "127.0.0.1", peer: "127.0.0.1" })
    expect(clientKeys(fakeReq("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toEqual({ client: "203.0.113.9", peer: "10.0.0.1" })
    // One address making up a new X-Forwarded-For for every guess still runs into the per-address limit.
    const { a, c } = auth()
    const forged = (i: number) => fakeReq("198.51.100.4", { "x-forwarded-for": `10.9.${i >> 8}.${i & 255}` })
    for (let i = 0; i < 100; i++) {
      c.tick(5000)
      expect(a.attempt(forged(i), "guess").ok).toBe(false)
    }
    expect(a.peers.failures("198.51.100.4")).toBe(100)
    expect(a.attempt(forged(500), PW)).toMatchObject({ ok: false, blocked: { locked: true } })
  })

  it("issues a new long random session token per login, signed, expiring, and ended by a password change", () => {
    const store = new Store(openDb(tmpDir()))
    const c = clock()
    const a = new Auth(PW, store, { now: c.now })
    const t1 = a.token()
    const t2 = a.token()
    expect(t1).not.toBe(t2)
    expect(t1.split(".")[0]!.length).toBeGreaterThanOrEqual(43)
    expect(a.validSession(t1)).toBe(true)
    const [n, i, mac] = t1.split(".")
    expect(a.validSession(`${n}x.${i}.${mac}`)).toBe(false)
    expect(a.validSession(`${n}.${i}.${mac!.slice(0, -2)}AA`)).toBe(false)
    expect(a.validSession(`${n}.${i}`)).toBe(false)
    expect(a.validSession(undefined)).toBe(false)
    // The old deterministic cookie (an HMAC of the password) is no longer a session.
    expect(a.validSession(crypto.createHmac("sha256", store.getKv("cookie_secret")!).update(`box-yard:${PW}`).digest("hex"))).toBe(false)
    // Same secret, new password: old sessions end.
    expect(new Auth("plum orbit velvet tuesday", store, { now: c.now }).validSession(t1)).toBe(false)
    c.tick(91 * 24 * 60 * MIN)
    expect(a.validSession(t1)).toBe(false)
  })
})

describe("POST /api/login", () => {
  const servers: { server: Server; stop: () => void }[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.stop()
      s.server.close()
    }
  })

  async function start() {
    const port = await freePort()
    const yard = createBoxYard(testConfig({ port, password: PW }), { webDir: "/nonexistent" })
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    servers.push({ server, stop: () => yard.stop() })
    return `http://127.0.0.1:${port}`
  }
  const login = (base: string, password: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ password }) })

  it("sets an httpOnly, SameSite=Lax session cookie, Secure only over https", async () => {
    const base = await start()
    const res = await login(base, PW)
    expect(res.status).toBe(200)
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toMatch(/^by_session=[A-Za-z0-9_-]{43}\.[a-z0-9]+\.[A-Za-z0-9_-]{43};/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).not.toMatch(/Secure/)
    const again = (await login(base, PW)).headers.get("set-cookie")!
    expect(again.split(";")[0]).not.toBe(cookie.split(";")[0])
    expect((await fetch(`${base}/api/projects`, { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200)
    expect((await login(base, PW, { "X-Forwarded-Proto": "https" })).headers.get("set-cookie")).toMatch(/; Secure/)
  })

  it("slows a client down after a few wrong passwords with a clear message, leaving other clients alone", async () => {
    const base = await start()
    const me = { "X-Forwarded-For": "100.64.0.10" }
    for (let i = 0; i < 3; i++) {
      const bad = await login(base, "wrong guess", me)
      expect(bad.status).toBe(401)
      expect((await bad.json()).error).toBe("Wrong password.")
    }
    const held = await login(base, PW, me)
    expect(held.status).toBe(429)
    expect(held.headers.get("retry-after")).toBe("1")
    expect((await held.json()).error).toMatch(/^Too many attempts, try again in 1 second\.$/)
    expect((await login(base, PW, { "X-Forwarded-For": "100.64.0.11" })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 1050))
    expect((await login(base, PW, me)).status).toBe(200)
  })
})
