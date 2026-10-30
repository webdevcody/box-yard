import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

// Stand-ins for connectors' outside world (docs/connectors.md › Testing): an OAuth authorization server, an MCP server
// that wants its bearer token, and (test/fake-mcp-stdio.mjs) a command that wants a secret env var. No real provider,
// account or OAuth app is ever involved.

export const FAKE_MCP_STDIO = path.resolve("test/fake-mcp-stdio.mjs")

const listen = (app: express.Express) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })

const b64url = (b: Buffer) => b.toString("base64url")

export interface FakeOAuthOptions {
  /** Seconds an access token lasts (default 3600). */
  expiresIn?: number
  /** Leave registration out of the metadata (a provider like Google). */
  noRegistration?: boolean
  /** Rotate the refresh token on every refresh (Notion does). Default true. */
  rotate?: boolean
  /** Metadata overrides (to test what Box Yard refuses). */
  metadata?: Record<string, unknown>
  /** A pre-registered client (Cody's own) and its secret. */
  ownClient?: { id: string; secret: string }
}

/**
 * An OAuth 2.1 authorization server (metadata, registration, authorize, token with PKCE, refresh with rotation) and,
 * on another port, an MCP server whose tools need one of its access tokens. Everything it issued is kept, so a test
 * can check no token ended up somewhere it shouldn't.
 */
export async function fakeOAuth(o: FakeOAuthOptions = {}) {
  const as = express()
  const mcp = express()
  as.use(express.urlencoded({ extended: false }))
  as.use(express.json())
  mcp.use(express.json())
  const asSrv = await listen(as)
  const mcpSrv = await listen(mcp)
  const issuer = asSrv.url
  const resource = `${mcpSrv.url}/mcp`
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>()
  if (o.ownClient) clients.set(o.ownClient.id, { redirectUris: [], secret: o.ownClient.secret })
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource?: string; scope?: string }>()
  const access = new Map<string, { expires: number; scope?: string }>()
  const refresh = new Map<string, { clientId: string; resource?: string; scope?: string }>()
  const issued: string[] = []
  const state = { refreshCount: 0, tokenCalls: 0, refuseRefresh: false, authorizeQueries: [] as URLSearchParams[], registrations: [] as Record<string, unknown>[], mcpAuthHeaders: [] as string[] }

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(o.noRegistration ? {} : { registration_endpoint: `${issuer}/register` }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
    ...o.metadata,
  }
  as.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (_req, res) => void res.json(metadata))
  as.post("/register", (req, res) => {
    state.registrations.push(req.body)
    const id = `client_${randomBytes(6).toString("hex")}`
    clients.set(id, { redirectUris: req.body.redirect_uris ?? [] })
    res.status(201).json({ client_id: id, redirect_uris: req.body.redirect_uris, token_endpoint_auth_method: "none" })
  })
  as.get("/authorize", (req, res) => {
    const q = new URLSearchParams(req.query as Record<string, string>)
    state.authorizeQueries.push(q)
    const client = clients.get(q.get("client_id") ?? "")
    const redirectUri = q.get("redirect_uri") ?? ""
    if (!client) return void res.status(400).send("unknown client")
    if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) return void res.status(400).send("redirect_uri not registered")
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return void res.status(400).send("PKCE required")
    const code = `code_${randomBytes(12).toString("hex")}`
    codes.set(code, { clientId: q.get("client_id")!, challenge: q.get("code_challenge")!, redirectUri, resource: q.get("resource") ?? undefined, scope: q.get("scope") ?? undefined })
    const back = new URL(redirectUri)
    back.searchParams.set("code", code)
    back.searchParams.set("state", q.get("state") ?? "")
    back.searchParams.set("iss", issuer)
    res.redirect(302, back.href)
  })
  const mint = (clientId: string, resource: string | undefined, scope: string | undefined) => {
    const at = `fake_at_${randomBytes(16).toString("hex")}`
    const rt = `fake_rt_${randomBytes(16).toString("hex")}`
    access.set(at, { expires: Date.now() + (o.expiresIn ?? 3600) * 1000, scope })
    refresh.set(rt, { clientId, resource, scope })
    issued.push(at, rt)
    return { access_token: at, token_type: "Bearer", expires_in: o.expiresIn ?? 3600, refresh_token: rt, ...(scope ? { scope } : {}) }
  }
  as.post("/token", (req, res) => {
    state.tokenCalls++
    const b = req.body as Record<string, string>
    const client = clients.get(b.client_id ?? "")
    if (!client) return void res.status(401).json({ error: "invalid_client" })
    if (client.secret && b.client_secret !== client.secret) return void res.status(401).json({ error: "invalid_client" })
    if (b.grant_type === "authorization_code") {
      const c = codes.get(b.code ?? "")
      codes.delete(b.code ?? "")
      if (!c || c.clientId !== b.client_id) return void res.status(400).json({ error: "invalid_grant", error_description: "unknown code" })
      if (c.redirectUri !== b.redirect_uri) return void res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" })
      if (b64url(createHash("sha256").update(b.code_verifier ?? "").digest()) !== c.challenge) return void res.status(400).json({ error: "invalid_grant", error_description: "PKCE verifier mismatch" })
      if (c.resource !== b.resource) return void res.status(400).json({ error: "invalid_target" })
      return void res.json(mint(c.clientId, c.resource, c.scope))
    }
    if (b.grant_type === "refresh_token") {
      state.refreshCount++
      const r = refresh.get(b.refresh_token ?? "")
      if (state.refuseRefresh || !r || r.clientId !== b.client_id) return void res.status(400).json({ error: "invalid_grant", error_description: "refresh token revoked" })
      const t = mint(r.clientId, r.resource, r.scope)
      if (o.rotate === false) {
        refresh.delete(t.refresh_token)
        return void res.json({ ...t, refresh_token: undefined })
      }
      refresh.delete(b.refresh_token!)
      return void res.json(t)
    }
    res.status(400).json({ error: "unsupported_grant_type" })
  })

  const challenge = `Bearer resource_metadata="${mcpSrv.url}/.well-known/oauth-protected-resource/mcp", scope="read"`
  mcp.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (_req, res) =>
    void res.json({ resource, authorization_servers: [issuer], scopes_supported: ["read", "write"] }),
  )
  mcp.all("/mcp", async (req, res) => {
    const auth = req.headers.authorization ?? ""
    state.mcpAuthHeaders.push(auth)
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    const t = access.get(token)
    if (!t || t.expires < Date.now()) return void res.status(401).set("WWW-Authenticate", challenge).json({ error: "invalid_token" })
    if (req.method !== "POST") return void res.status(405).end()
    const server = new McpServer({ name: "fake-remote", version: "1" })
    server.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }))
    server.registerTool("whoami", { description: "Who the token is for" }, async () => ({ content: [{ type: "text", text: "fake user" }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => void transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  return {
    issuer,
    mcpUrl: resource,
    metadata,
    state,
    /** Every access and refresh token it gave out. */
    issued,
    /** Follow an authorize URL the way the browser would, to the address the provider sends it back to. */
    async authorize(authorizeUrl: string): Promise<string> {
      const r = await fetch(authorizeUrl, { redirect: "manual" })
      const loc = r.headers.get("location")
      if (!loc) throw new Error(`authorize answered ${r.status}: ${await r.text()}`)
      return loc
    },
    /** Make every live access token stale (the next use needs a refresh). */
    expireAll() {
      for (const t of access.values()) t.expires = 0
    },
    close() {
      asSrv.server.close()
      mcpSrv.server.close()
    },
  }
}
