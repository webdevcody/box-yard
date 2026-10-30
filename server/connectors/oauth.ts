import { randomBytes } from "node:crypto"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js"
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { OAUTH_CALLBACK_PATH, type Connector, type ConnectorSignIn } from "../../shared/connectors.js"
import { BadRequestError } from "../store.js"
import { checkServerUrl, isLoopbackHost, type Connectors, type OAuthState } from "./connectors.js"

/** How long a started sign-in waits for its callback. */
export const SIGN_IN_TTL_MS = 10 * 60_000
/** A session starting with less than this left on its access token gets a fresh one (docs/connectors.md › Refresh). */
export const SESSION_TOKEN_MIN_MS = 45 * 60_000
/** Authorization parameters Box Yard sets itself, which a connector's own parameters may not change. */
const RESERVED_PARAMS = new Set(["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method", "resource"])
/** The provider's answers that mean the sign-in is gone: Cody signs in again. */
const SIGNED_OUT_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"])

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

interface Pending {
  connectorId: string
  /** What the connector looked like at the start: a sign-in finishing after an edit is refused. */
  shape: string
  codeVerifier: string
  redirectUri: string
  authServer: string
  metadata: AuthorizationServerMetadata
  client: OAuthClientInformationMixed
  resource: string | undefined
  at: number
}

/** The token a server or provider gave, never kept beyond the store. */
const expiry = (t: OAuthTokens, now: number) => (typeof t.expires_in === "number" && t.expires_in > 0 ? now + t.expires_in * 1000 : null)

/** Tolerates one trailing "/" (an issuer is often advertised without one). */
const sameIssuer = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")

const errorCode = (err: unknown): string | null => {
  const code = (err as { errorCode?: unknown })?.errorCode
  return typeof code === "string" ? code : null
}

/**
 * Signing a connector in with OAuth (docs/connectors.md › Signing in), and keeping its access token fresh. Discovery,
 * registration and PKCE are the MCP SDK's; this decides the redirect address, checks every endpoint is https, holds a
 * started sign-in's verifier in memory for ten minutes, single use, and stores what the provider gives through
 * Connectors (encrypted). No token leaves here except as accessToken()'s value, for a session's MCP config or a test.
 */
export class ConnectorSignIns {
  private readonly pending = new Map<string, Pending>()
  private readonly refreshing = new Map<string, Promise<string | null>>()
  private readonly fetchFn: FetchLike

  constructor(
    private readonly d: {
      connectors: Connectors
      /** Box Yard's own port: the loopback address a paste-back sign-in returns to. */
      port: number
      /** BOXYARD_PUBLIC_URL, an origin sign-in may return to besides the one the browser is on. */
      publicUrl?: string
      redact: (text: string) => string
      fetch?: FetchLike
      now?: () => number
    },
  ) {
    const base = d.fetch ?? ((url, init) => fetch(url, init))
    // Every OAuth request goes to https (or this computer), and gives up after 15 seconds.
    this.fetchFn = (url, init) => {
      const u = new URL(String(url instanceof Request ? url.url : url))
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return Promise.reject(new Error(`Box Yard only signs in over https, and ${u.origin} isn't.`))
      return base(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) })
    }
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  /**
   * Start signing a connector in. `origin` is the address the browser is on (or BOXYARD_PUBLIC_URL's): an https or
   * loopback one gets the provider's redirect back by itself; any other (plain http over Tailscale or a LAN, an
   * iPhone) returns to this computer's loopback address, which Cody copies from the address bar and pastes back.
   */
  async start(id: string, origin: string, requestOrigins: string[]): Promise<ConnectorSignIn> {
    const c = this.d.connectors.require(id)
    const state = this.d.connectors.oauthState(id)
    if (c.auth !== "oauth" || !state) throw new BadRequestError(`${c.label} doesn't sign in with OAuth.`)
    const { redirectUri, mode, note } = this.redirectFor(state, origin, requestOrigins)
    try {
      const found = await this.discover(c, state)
      const client = await this.client(c, state, found.authServer, found.metadata, redirectUri)
      const scope = state.scopes.length ? state.scopes.join(" ") : found.scope
      const key = randomBytes(32).toString("base64url")
      const { authorizationUrl, codeVerifier } = await startAuthorization(found.authServer, { metadata: found.metadata, clientInformation: client, redirectUrl: redirectUri, scope, state: key, resource: found.resource })
      for (const [k, v] of Object.entries(state.authParams)) if (!RESERVED_PARAMS.has(k)) authorizationUrl.searchParams.set(k, v)
      this.prune()
      // One sign-in at a time per connector: a newer start replaces an older one.
      for (const [k, p] of this.pending) if (p.connectorId === id) this.pending.delete(k)
      this.pending.set(key, { connectorId: id, shape: shapeOf(c), codeVerifier, redirectUri, authServer: found.authServer, metadata: found.metadata, client, resource: found.resource, at: this.now() })
      this.d.connectors.saveOAuthState(id, { authServer: found.authServer, metadata: found.metadata as unknown as Record<string, unknown>, resource: found.resource ?? null })
      return { authorizeUrl: authorizationUrl.href, redirectUri, mode, signInHost: authorizationUrl.host, note }
    } catch (err) {
      if (err instanceof BadRequestError) throw err
      throw new BadRequestError(`Couldn't start signing in to ${c.label}: ${this.message(err)}`)
    }
  }

  /**
   * Finish a sign-in from the address the provider sent the browser back to: the callback route's own query, or
   * one Cody pasted. The state must be one start() made in the last ten minutes, and it's used up either way.
   */
  async finish(params: URLSearchParams): Promise<Connector> {
    const key = params.get("state") ?? ""
    const p = this.pending.get(key)
    if (!p) throw new BadRequestError("That sign-in isn't one Box Yard started, or it's been used already. Start again from Settings › Connectors.")
    this.pending.delete(key)
    if (this.now() - p.at > SIGN_IN_TTL_MS) throw new BadRequestError("That sign-in took longer than ten minutes. Start again from Settings › Connectors.")
    const c = this.d.connectors.get(p.connectorId)
    if (!c) throw new BadRequestError("That connector was deleted while you were signing in.")
    if (shapeOf(c) !== p.shape) throw new BadRequestError(`${c.label} was changed while you were signing in, so the sign-in was for something else. Start again.`)
    const error = params.get("error")
    if (error) {
      const why = params.get("error_description")
      throw new BadRequestError(`${c.label}'s sign-in didn't finish: ${this.d.redact(`${error}${why ? ` (${why})` : ""}`).slice(0, 300)}`)
    }
    // RFC 9207: the provider that answered names itself, so a sign-in can't be finished with another's code.
    const iss = params.get("iss")
    const issRequired = (p.metadata as { authorization_response_iss_parameter_supported?: boolean }).authorization_response_iss_parameter_supported === true
    if (iss ? !sameIssuer(iss, p.metadata.issuer) : issRequired) throw new BadRequestError(`${c.label}'s sign-in came back from the wrong provider. Start again.`)
    const code = params.get("code")
    if (!code) throw new BadRequestError("That address has no sign-in code in it: paste the whole address the browser ended up on.")
    let tokens: OAuthTokens
    try {
      tokens = await exchangeAuthorization(p.authServer, { metadata: p.metadata, clientInformation: p.client, authorizationCode: code, codeVerifier: p.codeVerifier, redirectUri: p.redirectUri, resource: p.resource, fetchFn: this.fetchFn })
    } catch (err) {
      throw new BadRequestError(`${c.label}'s provider didn't accept the sign-in: ${this.message(err)}`)
    }
    const now = this.now()
    // A sign-in without a refresh token replaces the old one too: it may be another client's or account's.
    if (!tokens.refresh_token) this.d.connectors.removeSecret(c.id, "refresh_token")
    this.d.connectors.saveTokens(
      c.id,
      { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null, expiresAt: expiry(tokens, now) },
      { grantedScopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : null, redirectUri: p.redirectUri, signedInAt: now },
    )
    this.d.connectors.setStatus(c.id, "connected", null)
    return this.d.connectors.require(c.id)
  }

  /** A pasted address (or just its query) → its parameters. */
  static pasted(text: string): URLSearchParams {
    const t = text.trim()
    try {
      return new URL(t).searchParams
    } catch {
      return new URLSearchParams(t.startsWith("?") ? t.slice(1) : t)
    }
  }

  /**
   * A connector's access token, refreshed first when it has less than `minValidMs` left. null when it has none or
   * it ran out and can't be refreshed (the status then says to sign in again).
   */
  async accessToken(id: string, minValidMs = SESSION_TOKEN_MIN_MS): Promise<string | null> {
    const c = this.d.connectors.get(id)
    if (!c || c.auth !== "oauth") return null
    const token = this.d.connectors.secret(id, "access_token")
    const expires = c.oauth?.expiresAt ?? null
    if (token && (expires === null || expires - this.now() > minValidMs)) return token
    if (c.oauth?.refreshable) return this.refresh(id)
    if (token && expires !== null && expires > this.now()) return token
    if (c.status !== "needs_auth") this.d.connectors.setStatus(id, "needs_auth", token ? "The sign-in ran out and there's no refresh token: sign in again." : null)
    return null
  }

  /** Refresh a connector's access token; one refresh per connector at a time (a rotating refresh token is used once). */
  refresh(id: string): Promise<string | null> {
    const running = this.refreshing.get(id)
    if (running) return running
    const p = this.doRefresh(id).finally(() => this.refreshing.delete(id))
    this.refreshing.set(id, p)
    return p
  }

  private async doRefresh(id: string): Promise<string | null> {
    const c = this.d.connectors.get(id)
    const state = this.d.connectors.oauthState(id)
    const refreshToken = this.d.connectors.secret(id, "refresh_token")
    if (!c || !state || !refreshToken) return null
    const stillValid = () => {
      const t = this.d.connectors.secret(id, "access_token")
      const exp = this.d.connectors.get(id)?.oauth?.expiresAt ?? null
      return t && (exp === null || exp > this.now() + 60_000) ? t : null
    }
    try {
      let authServer = state.authServer
      let metadata = state.metadata as unknown as AuthorizationServerMetadata | undefined
      if (!authServer || !metadata) {
        const found = await this.discover(c, state)
        authServer = found.authServer
        metadata = found.metadata
      }
      const client = this.storedClient(c, state)
      if (!client) throw Object.assign(new Error("its OAuth client is gone"), { errorCode: "invalid_client" })
      const tokens = await refreshAuthorization(authServer, { metadata, clientInformation: client, refreshToken, resource: state.resource ?? undefined, fetchFn: this.fetchFn })
      this.d.connectors.saveTokens(id, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token && tokens.refresh_token !== refreshToken ? tokens.refresh_token : null, expiresAt: expiry(tokens, this.now()) }, {})
      this.d.connectors.setStatus(id, "connected", null)
      return tokens.access_token
    } catch (err) {
      const code = errorCode(err)
      if (code && SIGNED_OUT_ERRORS.has(code)) {
        this.d.connectors.signOut(id, `${c.label}'s provider refused to renew the sign-in (${code}): sign in again.`)
        return null
      }
      this.d.connectors.setStatus(id, "error", `Couldn't renew the sign-in: ${this.message(err)}`)
      return stillValid()
    }
  }

  // ---------- helpers ----------

  private redirectFor(state: OAuthState, origin: string, requestOrigins: string[]): { redirectUri: string; mode: "redirect" | "paste"; note: string | null } {
    let o: URL
    try {
      o = new URL(origin)
    } catch {
      throw new BadRequestError("The sign-in needs the address you're using Box Yard at.")
    }
    // Only an address this request came in on (or BOXYARD_PUBLIC_URL): a sign-in never returns to another host.
    const allowed = new Set([...requestOrigins, this.d.publicUrl].filter((x): x is string => !!x).map((x) => safeOrigin(x)))
    if (!allowed.has(o.origin)) throw new BadRequestError(`${o.origin} isn't the address this request came in on, so a sign-in can't return there.`)
    const callback = (base: string) => `${base}${OAUTH_CALLBACK_PATH}`
    const loopback = isLoopbackHost(o.hostname)
    const paste = { redirectUri: callback(`http://127.0.0.1:${this.d.port}`), mode: "paste" as const }
    if (state.clientKind === "web") {
      if (o.protocol !== "https:") throw new BadRequestError("A Web OAuth client returns to an https address only. Open Box Yard at its https address (Tailscale Serve's, or BOXYARD_PUBLIC_URL) and sign in from there, or use a Desktop client.")
      return { redirectUri: callback(o.origin), mode: "redirect", note: null }
    }
    if (state.clientKind === "desktop") {
      if (loopback) return { redirectUri: callback(o.origin), mode: "redirect", note: null }
      return { ...paste, note: "A Desktop OAuth client returns to this computer's own address, which won't open on this device: when the page doesn't load, copy its address and paste it here." }
    }
    if (o.protocol === "https:" || loopback) return { redirectUri: callback(o.origin), mode: "redirect", note: null }
    return { ...paste, note: "Box Yard is on plain http here, so the provider returns to this computer's own address, which won't open on this device: when the page doesn't load, copy its address and paste it here. Opening Box Yard over https (Tailscale Serve) skips this." }
  }

  /** Where to sign in: the configured issuer (Google's), or what the MCP server names (RFC 9728), with the resource to ask for. */
  private async discover(c: Connector, state: OAuthState): Promise<{ authServer: string; metadata: AuthorizationServerMetadata; resource: string | undefined; scope: string | undefined }> {
    let authServer: string
    let metadata: AuthorizationServerMetadata | undefined
    let resource: string | undefined
    let scope: string | undefined
    if (state.issuer) {
      authServer = checkServerUrl(state.issuer, "The authorization server").href
      metadata = await discoverAuthorizationServerMetadata(authServer, { fetchFn: this.fetchFn })
    } else {
      if (!c.url) throw new BadRequestError("Give the authorization server (issuer): a command can't be asked where to sign in.")
      const challenge = await this.challenge(c)
      scope = challenge.scope
      const info = await discoverOAuthServerInfo(c.url, { resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: this.fetchFn })
      authServer = checkServerUrl(info.authorizationServerUrl, "The authorization server").href
      metadata = info.authorizationServerMetadata
      if (info.resourceMetadata) {
        // RFC 9728: the metadata must be about this server, or another server's could send the token elsewhere.
        if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(c.url), configuredResource: info.resourceMetadata.resource })) throw new BadRequestError(`${c.label}'s server describes another resource (${info.resourceMetadata.resource}), so Box Yard won't sign in for it.`)
        resource = info.resourceMetadata.resource
        scope ??= info.resourceMetadata.scopes_supported?.join(" ") || undefined
      }
      // The MCP spec: name the server the token is for, every time (RFC 8707).
      resource ??= resourceUrlFromServerUrl(c.url).href
    }
    if (!metadata) throw new BadRequestError(`${new URL(authServer).host} doesn't describe its OAuth endpoints, so Box Yard can't sign in there. Use a token instead, if the server takes one.`)
    // RFC 8414 § 3.3: the metadata is about the server it was fetched from (one trailing "/" aside: Google's).
    if (!metadata.issuer || !sameIssuer(metadata.issuer, authServer)) throw new BadRequestError(`${new URL(authServer).host}'s OAuth metadata names another issuer (${metadata.issuer || "none"}), so Box Yard won't sign in there.`)
    // The MCP spec: no PKCE (S256) said, no sign-in.
    if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new BadRequestError(`${new URL(authServer).host} doesn't say it supports PKCE (S256), which signing in needs.`)
    for (const [what, url] of [
      ["sign-in page", metadata.authorization_endpoint],
      ["token endpoint", metadata.token_endpoint],
      ["registration endpoint", metadata.registration_endpoint],
    ] as const)
      if (url) checkServerUrl(url, `Its ${what}`)
    return { authServer, metadata, resource, scope }
  }

  /** What the server says when asked without a token (RFC 9728 § 5.1): where its metadata is, and the scope it wants. */
  private async challenge(c: Connector): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    try {
      const res =
        c.kind === "sse"
          ? await this.fetchFn(c.url!, { headers: { Accept: "text/event-stream" } })
          : await this.fetchFn(c.url!, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "box-yard", version: "1" } } }),
            })
      void res.body?.cancel().catch(() => {})
      if (res.status !== 401 && res.status !== 403) return {}
      const p = extractWWWAuthenticateParams(res)
      return { resourceMetadataUrl: p.resourceMetadataUrl, scope: p.scope }
    } catch {
      return {}
    }
  }

  /** The OAuth client to sign in with: Cody's own, or one Box Yard registers (RFC 7591) for this provider and redirect. */
  private async client(c: Connector, state: OAuthState, authServer: string, metadata: AuthorizationServerMetadata, redirectUri: string): Promise<OAuthClientInformationMixed> {
    if (state.clientKind !== "dynamic") {
      if (!state.clientId) throw new BadRequestError("Give your OAuth client's id first.")
      const secret = this.d.connectors.secret(c.id, "client_secret")
      return { client_id: state.clientId, ...(secret ? { client_secret: secret } : {}) }
    }
    const reg = state.registration
    if (reg && reg.issuer === authServer && reg.redirectUri === redirectUri) {
      const secret = this.d.connectors.secret(c.id, "dcr_client_secret")
      return { client_id: reg.clientId, ...(secret ? { client_secret: secret } : {}) }
    }
    if (!metadata.registration_endpoint) throw new BadRequestError(`${new URL(authServer).host} doesn't let apps register themselves. Make an OAuth client there and pick "My own client".`)
    const info = await registerClient(authServer, {
      metadata,
      // application_type: the MCP spec asks for it, native for a loopback redirect (RFC 7591, OpenID registration).
      clientMetadata: { client_name: "Box Yard", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: isLoopbackHost(new URL(redirectUri).hostname) ? "native" : "web" } as OAuthClientMetadata,
      fetchFn: this.fetchFn,
    })
    // A registration for another redirect or provider is forgotten with its secret.
    this.d.connectors.removeSecret(c.id, "dcr_client_secret")
    if (info.client_secret) this.d.connectors.saveSecret(c.id, "dcr_client_secret", info.client_secret)
    this.d.connectors.saveOAuthState(c.id, { registration: { issuer: authServer, redirectUri, clientId: info.client_id, at: this.now() } })
    return { client_id: info.client_id, ...(info.client_secret ? { client_secret: info.client_secret } : {}) }
  }

  /** The client the last sign-in used, for a refresh. */
  private storedClient(c: Connector, state: OAuthState): OAuthClientInformationMixed | null {
    if (state.clientKind === "dynamic") {
      if (!state.registration) return null
      const secret = this.d.connectors.secret(c.id, "dcr_client_secret")
      return { client_id: state.registration.clientId, ...(secret ? { client_secret: secret } : {}) }
    }
    if (!state.clientId) return null
    const secret = this.d.connectors.secret(c.id, "client_secret")
    return { client_id: state.clientId, ...(secret ? { client_secret: secret } : {}) }
  }

  private prune() {
    const now = this.now()
    for (const [k, p] of this.pending) if (now - p.at > SIGN_IN_TTL_MS) this.pending.delete(k)
  }

  /** An error, without a secret in it, short enough for a status line. */
  private message(err: unknown): string {
    const text = err instanceof Error ? err.message || err.name : String(err)
    return this.d.redact(text).replace(/\s+/g, " ").slice(0, 300)
  }
}

const safeOrigin = (u: string) => {
  try {
    return new URL(u).origin
  } catch {
    return u
  }
}

/** What a sign-in is for: the server or program, and the client. */
const shapeOf = (c: Connector) => JSON.stringify([c.kind, c.url, c.command, c.args, c.auth, c.oauth?.clientKind, c.oauth?.issuer, c.oauth?.clientKind === "dynamic" ? null : c.oauth?.clientId])
