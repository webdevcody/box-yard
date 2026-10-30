import os from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Connector, ConnectorTest, ConnectorTool } from "../../shared/connectors.js"

/** What a connector signs in with, for one connection: never stored, never logged. */
export interface ConnectorCreds {
  /** The token (or OAuth access token): a header for a remote server, `tokenEnv` for a command. */
  token: string | null
  /** A command's secret env vars. */
  env: Record<string, string>
}

export interface ProbeResult {
  test: ConnectorTest
  /** The server turned the credentials down (401/403): sign in again, or a new token. */
  unauthorized: boolean
}

const MAX_TOOLS = 200

/** The header a remote server gets its token in. */
export function authHeaders(c: Pick<Connector, "header">, token: string | null): Record<string, string> {
  return token ? { [c.header.name]: `${c.header.prefix}${token}` } : {}
}

/** The env a command connector runs with: the basics (PATH, HOME), its own vars, its secrets and its token. Never Box Yard's env. */
export function commandEnv(c: Pick<Connector, "env" | "tokenEnv">, creds: ConnectorCreds): Record<string, string> {
  return { ...getDefaultEnvironment(), ...c.env, ...creds.env, ...(c.tokenEnv && creds.token ? { [c.tokenEnv]: creds.token } : {}) }
}

/**
 * Connect to a connector the way a session would and list its tools: Settings' Test button. A command runs on this
 * computer, with only its own env. Errors come back redacted and short.
 */
export async function probeConnector(c: Connector, creds: ConnectorCreds, o: { redact: (text: string) => string; timeoutMs?: number; now?: () => number }): Promise<ProbeResult> {
  const at = o.now?.() ?? Date.now()
  const headers = authHeaders(c, creds.token)
  let stderr = ""
  let transport: Transport
  if (c.kind === "stdio") {
    const t = new StdioClientTransport({ command: c.command!, args: c.args, env: commandEnv(c, creds), cwd: os.tmpdir(), stderr: "pipe" })
    t.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    transport = t
  } else if (c.kind === "sse") {
    transport = new SSEClientTransport(new URL(c.url!), {
      requestInit: { headers },
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) },
    })
  } else {
    transport = new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers } })
  }
  const client = new Client({ name: "box-yard", version: "1" }, { capabilities: {} })
  const timeoutMs = o.timeoutMs ?? (c.kind === "stdio" ? 60_000 : 20_000)
  let timer: NodeJS.Timeout | undefined
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport)
        const out: ConnectorTool[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10 && out.length < MAX_TOOLS; page++) {
          const r = await client.listTools(cursor ? { cursor } : {})
          for (const t of r.tools) out.push({ name: t.name.slice(0, 120), description: o.redact((t.description ?? "").replace(/\s+/g, " ").trim()).slice(0, 300) })
          cursor = r.nextCursor
          if (!cursor) break
        }
        return out.slice(0, MAX_TOOLS)
      })(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs))),
    ])
    return { test: { at, ok: true, tools, error: null }, unauthorized: false }
  } catch (err) {
    const code = (err as { code?: unknown }).code
    const text = err instanceof Error ? err.message || err.name : String(err)
    const unauthorized = code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|invalid[_ ]token/i.test(text)
    const tail = stderr.trim().split("\n").slice(-3).join(" ")
    const error = o.redact(`${text}${tail && c.kind === "stdio" ? ` (it said: ${tail})` : ""}`).replace(/\s+/g, " ").slice(0, 400)
    return { test: { at, ok: false, tools: [], error }, unauthorized }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}
