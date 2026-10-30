import type { Connector } from "../../shared/connectors.js"
import type { DB } from "../db.js"
import type { SecretBox } from "../identity/secretBox.js"
import { BadRequestError } from "../store.js"
import { Connectors } from "./connectors.js"
import { ConnectorSignIns } from "./oauth.js"
import { probeConnector, type ConnectorCreds } from "./probe.js"

/** A Test connection's access token must last at least this long. */
const TEST_TOKEN_MIN_MS = 2 * 60_000

/**
 * External MCP connectors (docs/connectors.md), put together: the store, OAuth sign-in and Test. The routes and the
 * session builders use this; only creds() hands out a secret, and only to code that puts it in a connection.
 */
export class ConnectorService {
  readonly store: Connectors
  readonly signIns: ConnectorSignIns
  private readonly redact: (text: string) => string
  private readonly testing = new Map<string, Promise<Connector>>()

  constructor(d: {
    db: DB
    secrets: SecretBox
    statusOnly: (projectId: string) => boolean
    projectExists: (projectId: string) => boolean
    projectName: (projectId: string) => string | null
    port: number
    publicUrl?: string
    /** Every secret Box Yard knows (connectors' included) out of a text. */
    redact: (text: string) => string
    fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
    now?: () => number
  }) {
    this.redact = d.redact
    this.store = new Connectors({ db: d.db, secrets: d.secrets, statusOnly: d.statusOnly, projectExists: d.projectExists, projectName: d.projectName })
    this.signIns = new ConnectorSignIns({ connectors: this.store, port: d.port, publicUrl: d.publicUrl, redact: d.redact, fetch: d.fetch, now: d.now })
  }

  /**
   * What a connection to this connector signs in with, refreshing an OAuth token that has less than `minValidMs`
   * left. null when it needs a sign-in, a token or a secret env var it doesn't have (then it's left out).
   */
  async creds(c: Connector, minValidMs?: number): Promise<ConnectorCreds | null> {
    const env = c.kind === "stdio" ? this.store.secretEnv(c.id) : {}
    if (c.kind === "stdio" && Object.keys(env).length !== this.store.secretEnvNames(c.id).length) return null
    if (c.auth === "oauth") {
      const token = await this.signIns.accessToken(c.id, minValidMs)
      return token ? { token, env } : null
    }
    if (c.auth === "token") {
      const token = this.store.secret(c.id, "token")
      return token ? { token, env } : null
    }
    return { token: null, env }
  }

  /** Settings' Test: connect and list its tools, and set its status from the answer. One test per connector at a time. */
  test(id: string): Promise<Connector> {
    const running = this.testing.get(id)
    if (running) return running
    const p = this.runTest(id).finally(() => this.testing.delete(id))
    this.testing.set(id, p)
    return p
  }

  private async runTest(id: string): Promise<Connector> {
    const c = this.store.require(id)
    const creds = await this.creds(c, TEST_TOKEN_MIN_MS)
    if (!creds) {
      const missing = this.store.secretEnvNames(c.id).length && c.kind === "stdio" && Object.keys(this.store.secretEnv(c.id)).length !== this.store.secretEnvNames(c.id).length
      const why = missing ? "A secret env var can't be read with this server's secret key: save it again." : c.auth === "oauth" ? "Not signed in: press Sign in." : "No token saved yet."
      this.store.setTest(id, { at: Date.now(), ok: false, tools: [], error: why })
      this.store.setStatus(id, missing ? "error" : "needs_auth", why)
      return this.store.require(id)
    }
    const { test, unauthorized } = await probeConnector(this.store.require(id), creds, { redact: this.redact })
    this.store.setTest(id, test)
    if (test.ok) this.store.setStatus(id, "connected", null)
    else if (unauthorized && (c.auth === "oauth" || c.auth === "token")) this.store.setStatus(id, "needs_auth", `The server turned the ${c.auth === "oauth" ? "sign-in" : "token"} down: ${test.error}`)
    else this.store.setStatus(id, "error", test.error)
    return this.store.require(id)
  }

  /** The callback's (or a pasted address's) parameters → a signed-in connector, tested in the background. */
  async finishSignIn(params: URLSearchParams): Promise<Connector> {
    const c = await this.signIns.finish(params)
    void this.test(c.id).catch(() => {})
    return c
  }

  /** Save the token, client secret or a secret env var Cody typed in Settings. */
  saveSecret(id: string, which: "token" | "client_secret" | { env: string }, value: unknown): Connector {
    const name = typeof which === "string" ? which : `env:${which.env}`
    if (typeof which !== "string" && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(which.env)) throw new BadRequestError("An env var name is letters, digits and _ (not starting with a digit).")
    this.store.saveSecret(id, name, value)
    return this.store.require(id)
  }
}
