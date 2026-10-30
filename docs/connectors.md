# External MCP connectors

A connector is an external MCP server that Box Yard passes into some of its Claude Code sessions: Gmail, Notion, Linear, Slack, or any server you point it at. Cody adds, signs in, scopes and removes connectors in Settings › Connectors. No model can change one. The Coordinator and Captains can only list them, with `list_connectors`.

Connectors carry account access, so the rules below start from the smallest exposure. The design note behind them, with the options considered and the threat model, is in the PR that added this page.

## A connector

| Field | What it does |
| --- | --- |
| Name | The MCP server name sessions see, so its tools are `mcp__<name>__*`. Lowercase letters, digits, `-` and `_`, starting with a letter, without `__`. It must be unique (`my-app` and `my_app` count as the same) and can't be `boxyard` |
| Label | What Settings shows ("Gmail") |
| Kind | `http` (Streamable HTTP), `sse` (the older HTTP+SSE transport) or `stdio` (a command) |
| URL | For `http` and `sse`. Must be `https`, or plain `http` only to this computer (`localhost`, `127.0.0.1`, `[::1]`). It can't hold a user name or password |
| Command, args, env | For `stdio`. `env` holds the vars that aren't secret; secret ones are saved separately (below). The command runs with only the basics of the environment (`PATH`, `HOME`, …) plus its own vars, never Box Yard's |
| Auth | `none`, `oauth`, `token` (an API key or token: a header for a remote server, the `tokenEnv` var for a command) or `env` (a command's secret env vars only) |
| Header | The header a token goes in, `Authorization: Bearer …` by default |
| Scope | Who gets it (see [Scope](#scope)) |
| Status | `connected`, `needs_auth` (never signed in, or the provider refused the refresh token: sign in again), `error` (the last test or refresh failed, with the reason) or `untested` |
| Last test | When it was tested, and the tools it listed or the error |

## Secrets

- **Values only go in.** A connector's token, OAuth tokens, OAuth client secret and secret env vars are typed only into Settings, and stored in `connector_secrets` encrypted with Box Yard's secret key (`secret.key` or `BOXYARD_SECRET_KEY`, the same as identities: see docs/identities.md › Secrets).
- No API response, event or MCP tool result ever holds one: they show the secret's name, a fingerprint (the first 12 hex digits of its sha256), whether this server's key can read it, and when an access token expires.
- **Only access tokens leave the server.** An OAuth connector's refresh token and client secret are used by the server alone, to sign in and refresh. A session only ever gets the short-lived access token.
- **Every secret is redacted.** Each connector secret in effect joins the redaction list for transcripts and errors, and so does every value replaced or removed while the server runs. An echoed token becomes `[redacted]`.
- **An edit never moves a secret.** Changing a connector's kind, auth, URL, command or args, or its OAuth client or issuer, drops its saved secrets and sign-in, and it needs signing in again. A token is never sent to a new host or program by an edit. (Cody's own OAuth client secret stays unless the client itself changed.)
- `list_connectors` shows a remote server's host only, never its path or query, because some servers put a key in the path.

## Scope

Each connector says who gets it:

- **Sessions:** the Coordinator, Captains and/or agents. Side threads never get a connector: they're read-only.
- **Projects** (for Captains and agents): every project, or chosen ones.
- **Runners** (for agents): this computer, Docker, Upstash boxes, RunPod.

**The default is the Coordinator only.** The Coordinator has no shell and runs on this computer. Agents, other projects and remote runners are each an explicit choice.

**Status-only projects.** A connector the Coordinator uses never reaches a status-only project's Captain or agents (see docs/identities.md › Coordinator sees: status only). It would be a channel: a sealed agent writes to Notion, then the Coordinator reads Notion.

- With "every project", status-only projects are skipped, and the connector lists them in `sealedSkipped`.
- Choosing one explicitly is refused on Save, with the reason.

**Boxes.** An agent can read everything on its Upstash box. So the connectors that reach a project's agents on boxes are part of the box wall: two projects share a pool box only when they have the same identity *and* the same box connectors. A project with no box connectors keeps its key as it was.

## Signing in with OAuth

Box Yard follows the MCP authorization spec, using the MCP SDK's helpers:

1. **Discovery.** Ask the server without a token, and read `WWW-Authenticate`'s `resource_metadata` and `scope`. Then fetch the protected resource metadata (RFC 9728) and the authorization server's metadata (RFC 8414 or OpenID).
   - The resource metadata must describe this server.
   - The authorization server's `issuer` must be the address it was fetched from (one trailing `/` aside).
   - It must list PKCE `S256`.
   - Every endpoint must be `https` (or loopback).
   - A connector can name its authorization server instead (`oauth.issuer`, as Google's presets do), and then it isn't discovered.
2. **Client.**
   - With dynamic registration (RFC 7591), Box Yard registers itself as a public client ("Box Yard", `token_endpoint_auth_method: none`). The registration is kept per issuer and redirect address.
   - A provider without registration (Google, Slack) uses Cody's own OAuth client: its id on the connector (`clientKind` `desktop` or `web`), and its secret saved like any other.
3. **Authorize.** The sign-in page opens in a new tab, with:
   - PKCE S256;
   - a `state` of 32 random bytes, single use and good for ten minutes;
   - `resource` (RFC 8707) for a discovered server;
   - the scopes: the connector's own, else the server's challenge, else its `scopes_supported`;
   - the connector's extra parameters (Google's `access_type=offline` and `prompt=consent`).
4. **Callback.**
   - Box Yard checks the `state`, the connector (unchanged since the start), and `iss` (RFC 9207: required when the provider says it sends one).
   - It exchanges the code with the verifier, which never left the server, stores the tokens encrypted, and runs a Test.
5. **Refresh.**
   - When a session starts with the connector, or it's tested, an access token with less than 45 minutes left (2 for a test) is refreshed first. Nothing refreshes in the background.
   - Refreshes run one at a time per connector. That matters for providers whose refresh tokens rotate, such as Notion, which revokes the grant if an old one is replayed.
   - A refused refresh token (`invalid_grant`, `invalid_client`) drops the tokens and sets `needs_auth`.

### Where the redirect lands

The provider sends the browser back to `<origin>/api/connectors/oauth/callback`. The origin depends on where Box Yard is open:

- **At an `https` or loopback address** (on the Mac at `http://localhost:4000`, or over Tailscale Serve at `https://<mac>.<tailnet>.ts.net`): the provider returns to that address and the sign-in finishes by itself.
  - On an iPhone, run `tailscale serve --bg 4000` on the Mac and open Box Yard at the `https://….ts.net` address.
- **At a plain-http address elsewhere** (`http://100.x.y.z:4000`, a MagicDNS name): providers refuse to redirect there. So Box Yard returns to `http://127.0.0.1:<port>/api/connectors/oauth/callback`. On the Mac that loads. On a phone it doesn't, and Cody copies the address from the browser's address bar into the sign-in dialog (paste-back).
- **A Desktop OAuth client** (Google) always returns to loopback, since Google accepts any loopback port without registering it. **A Web client** needs Box Yard on `https`, with that exact callback address registered at the provider.

The sign-in returns only to an address the request came in on (its `Origin` or `Host`) or `BOXYARD_PUBLIC_URL`, never to one taken from the body alone.

**The callback page needs no Box Yard login.** A home-screen Box Yard on an iPhone doesn't share cookies with Safari, where the provider's page opens. The `state` is the gate instead: made by a logged-in Sign in, single use, ten minutes, and useless without the verifier held on the server. The page sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a CSP that allows no script. It shows only an escaped message, never the code or a token.

## Test

Test connects the way a session would, with its token, OAuth access token or secret env vars, and lists the server's tools (up to 200).

- A command runs on this computer with only its own env, and is given 60 seconds; a remote server gets 20.
- A `401` or `403` from a server sets `needs_auth`. Any other failure sets `error`, with a redacted reason (and the last lines a command printed).

## MCP tools

`list_connectors` (the Coordinator and Captains): each connector's name, `mcp__<name>__*`, server host or command name, auth, status and detail, its sign-in state, secret names with fingerprints, and its last test's tool names.

- The Coordinator also sees whom each one reaches.
- A Captain sees only the connectors that reach its project, whether it and its agents get each (`yours`), and other projects only as a count.
- The whole result is also run through the connectors' secret values.

No tool adds, changes, signs in or removes a connector.

## API

All under `/api`, behind the login, except the callback.

| Route | What it does |
| --- | --- |
| `GET /connectors` | Every connector (no values) |
| `POST /connectors` | Add one (`ConnectorInput` in `shared/connectors.ts`) |
| `PATCH /connectors/:id` | Change it. An edit that moves it drops its secrets (above) |
| `DELETE /connectors/:id` | Remove it and its secrets |
| `PUT` / `DELETE /connectors/:id/token` | Its token, `{ value }` |
| `PUT` / `DELETE /connectors/:id/client-secret` | Cody's own OAuth client's secret, `{ value }` |
| `PUT` / `DELETE /connectors/:id/env/:name` | A command's secret env var, `{ value }` |
| `POST /connectors/:id/oauth/start` | `{ origin? }` → `{ authorizeUrl, redirectUri, mode: "redirect" \| "paste", signInHost, note }` |
| `GET /connectors/oauth/callback` | Where the provider returns (public, state-gated) |
| `POST /connectors/oauth/complete` | Paste-back: `{ url }`, the address the provider's page ended up on |
| `POST /connectors/:id/sign-out` | Forget its OAuth tokens |
| `POST /connectors/:id/test` | Connect and list its tools; sets its status |

Every change is broadcast as a `connectors` event with the full list (no values).

## Coming next

- **Sessions.** The Coordinator's and Captains' MCP configs, and agents' turns (through `task.json`, as identities' credentials go), get the connectors that reach them. The configs name each secret as `${VAR}` and never hold a value. Until then, a connector can be added, signed in and tested, but no session gets it.
- **Presets.** Gmail and Google Calendar (a small server Box Yard ships, given only the Google access token), Notion, Linear and Slack.
- **Settings › Connectors.**
