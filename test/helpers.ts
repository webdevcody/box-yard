import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import http from "node:http"
import { config as baseConfig, type Config } from "../server/config.js"

export const FAKE_CLAUDE = `${process.execPath} ${path.resolve("scripts/fake-claude.mjs")}`

export function tmpDir(prefix = "box-yard-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = tmpDir()
  return {
    ...baseConfig,
    dataDir,
    host: "127.0.0.1",
    password: "",
    provider: "local",
    upstashBoxApiKey: "",
    redisUrl: "",
    redisToken: "",
    claudeOauthToken: "",
    anthropicApiKey: "",
    githubToken: "",
    elevenlabsApiKey: "",
    openaiApiKey: "",
    ttsProvider: "",
    claudeBin: FAKE_CLAUDE,
    mock: true,
    maxBoxes: 2,
    slotsPerBox: 2,
    maxResidentPerBox: 12,
    boxIdleDeleteMinutes: 0,
    pollMs: 150,
    orchestratorAutoWake: false,
    archiveWorkspaces: true,
    selfBoxId: "",
    // Local boxes live on this machine's disk; don't let a nearly full dev disk hold tasks back.
    diskMinFreeMb: 0,
    ...overrides,
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`)
}

/** A tiny in-memory stand-in for the Upstash Redis REST API (just what Box Yard uses). */
export function fakeRedis(): Promise<{ url: string; token: string; close: () => void; streams: Map<string, [string, string[]][]> }> {
  const token = "test-token"
  const kv = new Map<string, string>()
  const streams = new Map<string, [string, string[]][]>()
  let seq = 0
  const run = (cmd: string[]): unknown => {
    const [name, ...a] = cmd
    switch (name!.toUpperCase()) {
      case "SET":
        kv.set(a[0]!, a[1]!)
        return "OK"
      case "GET":
        return kv.get(a[0]!) ?? null
      case "DEL":
        return Number(kv.delete(a[0]!)) + Number(streams.delete(a[0]!))
      case "XADD": {
        const key = a[0]!
        const star = a.indexOf("*")
        const fields = a.slice(star + 1)
        const id = `${Date.now()}-${seq++}`
        const list = streams.get(key) ?? []
        list.push([id, fields])
        streams.set(key, list)
        return id
      }
      case "XRANGE": {
        const [key, start, , , count] = a
        const list = streams.get(key!) ?? []
        const cmp = (x: string, y: string) => {
          const [a1, a2] = x.split("-").map(Number)
          const [b1, b2] = y.split("-").map(Number)
          return a1! - b1! || a2! - b2!
        }
        let out = list
        if (start && start !== "-") {
          const exclusive = start.startsWith("(")
          const from = exclusive ? start.slice(1) : start
          out = list.filter(([id]) => (exclusive ? cmp(id, from) > 0 : cmp(id, from) >= 0))
        }
        return out.slice(0, Number(count ?? 1000))
      }
      default:
        throw new Error(`unsupported ${name}`)
    }
  }
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }))
        return
      }
      try {
        const parsed = JSON.parse(body)
        const out = req.url?.endsWith("/pipeline")
          ? (parsed as string[][]).map((c) => ({ result: run(c) }))
          : { result: run(parsed as string[]) }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ error: (err as Error).message }))
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ url: `http://127.0.0.1:${port}`, token, close: () => server.close(), streams })
    }),
  )
}
