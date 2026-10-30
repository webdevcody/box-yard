# External MCP connectors: design

*Box Yard task `task_c908818ea2e4`, 30 Oct 2026. Status: draft for review; the build is going ahead on it.*

Cody's request: "add support for adding in external MCP connectors, I should be able to easily install and authenticate, for example Gmail."

This note covers the options, the OAuth redirect plan, what reaches boxes, and the threat model. Credentials are involved, so every choice below starts from the smallest exposure.

---

## 1. What a connector is

A connector is an external MCP server that Box Yard passes into some of its Claude Code sessions. There are two kinds:

| Kind | Config | Where it runs |
| --- | --- | --- |
| **Remote** (`http`, or legacy `sse`) | URL | The provider's servers. The session connects over HTTPS and sends a bearer token |
| **Command** (`stdio`) | command, args, env | Next to the session: on this computer for the Coordinator and Captains, and on the runner for agents |

Each connector has:

- **A name**, which becomes the MCP server name (`gmail`), so its tools are `mcp__gmail__*`. It must be a lowercase slug, unique, and never `boxyard`.
- **Auth**, one of four:
  - `none`
  - `oauth`: the MCP OAuth flow (discovery plus dynamic registration), or a provider's own OAuth client for Google
  - `token`: an API key or token sent as a header, `Authorization: Bearer …` by default
  - `env`: secret env vars for a command
- **Scope** (see §3).
- **Status**: `connected`, `needs_auth` (never signed in, or the refresh token was refused), `error` (the last test or refresh failed, with the reason), or `untested`. Each status also keeps the last test's tool list.

### Storage

- `connectors` holds non-secret fields only: name, kind, URL, command and args, non-secret env, scope, OAuth metadata (issuer, endpoints, client id, scopes, resource, the redirect URI used), status and the last test.
- `connector_secrets` holds the secrets: access token, refresh token, API key, the OAuth client secret, and each secret env var. They are encrypted with the same `SecretBox` (AES-256-GCM, `secret.key` or `BOXYARD_SECRET_KEY`) as identity secrets (#164). The table stores a fingerprint, `expires_at` and the granted scopes.
- **Values only go in.** No API route, MCP tool or event ever returns a secret; the API returns fingerprints only.

### Presets

The Settings › Connectors "Add" menu has one-click presets. Each fills in the URL or command, the auth type, the OAuth endpoints and the default scopes. §6 has the details.

| Preset | Server | Auth |
| --- | --- | --- |
| Gmail | Box Yard's built-in Google server (§6), a command | Google OAuth, with Cody's own Google OAuth client |
| Google Calendar | Box Yard's built-in Google server (§6), a command | Google OAuth, with Cody's own Google OAuth client |
| Notion | `https://mcp.notion.com/mcp` (official, remote) | MCP OAuth with dynamic registration |
| Linear | `https://mcp.linear.app/mcp` (official, remote) | MCP OAuth with dynamic registration, or an API key |
| Slack | `https://mcp.slack.com/mcp` (official, remote) | OAuth with Cody's own Slack app (Slack has no dynamic registration) |
| Custom | URL or command | auto-detected (a `401` with `WWW-Authenticate` means OAuth), token, env or none |

---

## 2. Options for getting a token to a session

| | **A. Direct** (chosen) | **B. Gateway** | **C. Claude Code's own OAuth** |
| --- | --- | --- | --- |
| How | Box Yard writes the session's MCP config with `Authorization: Bearer ${BOXYARD_CONNECTOR_GMAIL}`. The value comes through the env: the claude process env for server-side sessions, `task.json`'s env for agents | Sessions point at `boxyard/connectors/<id>/mcp`. Box Yard proxies each call and adds the real token | Let `claude` run `/mcp` sign-in itself |
| Refresh tokens leave the server | **Never**: only the short-lived access token goes out | Never | Yes, into each session's config dir |
| Works on Upstash boxes and RunPod | Yes | Only when boxes can reach Box Yard (a public URL). Today workers never call the server | No: headless `-p` can't sign in |
| Mid-turn token expiry | Possible past the access token's lifetime (Google: 1 h, Notion: about 8 h). Box Yard refreshes before every turn, so each turn starts with ≥ 45 min left. Later, Claude Code's `headersHelper` (re-run on a 401) can renew remote connectors mid-session | None | n/a |
| Code size | Small: reuses `turnCredentials` and `task.json` | Large: a Streamable HTTP and SSE reverse proxy plus a stdio bridge | n/a |

**Decision: A now, B later as an option for the local runner and Docker.**

- Option A follows the brief: one credential path (`server/turnCredentials.ts`), with `task.json` as the only per-turn secret carrier.
- Verified with `claude -p` 2.1.293: `${VAR}` expands in `--mcp-config` files (`url`, `headers`, `command`, `args`, `env`), not only in `.mcp.json`. Claude Code blanks a fixed list of its own credential names there (`ANTHROPIC_API_KEY`, …), which Box Yard's `BOXYARD_CONNECTOR_*` names avoid.
- The MCP config files Box Yard and the runner write hold **references only** (`${VAR}`), never values. So `mcp.json` in a task folder (which is on the Docker volume and in archive excludes) and `orchestrator-mcp.json` carry no secret.
- Option B is the next step if long agent turns lose Gmail mid-turn often enough to matter, or if API keys should stop reaching local agents at all.

### What each session gets

| Session | MCP config | Where the secret is | Who can read it |
| --- | --- | --- | --- |
| Coordinator, Captain | `orchestrator-mcp.json` / `captains/<p>/mcp.json` (0600) with `${VAR}` refs | The `claude` process env (never the server's own env) | Nobody in the session: the Coordinator and Captains have no Bash, and `Read` is limited to their compaction and upload folders |
| Side threads | none | none | Threads are read-only and get no connectors |
| Agent on any runner | `mcp.json` written by the runner, with `${VAR}` refs | `task.json` `env` (tmpfs on Docker; on disk elsewhere, as GitHub tokens are today) | The agent (`env`, `bypassPermissions`), and on a pool box the other workspaces on that box, which is why the box wall below exists |

For OAuth connectors an agent only ever sees the **access token**. The refresh token and the client secret stay in the server process.

---

## 3. Scope

Each connector says who gets it:

- **Sessions**: Coordinator, Captains, agents (any of them).
- **Projects** (for Captains and agents): all, or chosen ones.
- **Runners** (for agents): this computer, Docker, Upstash boxes, RunPod.

**Defaults: the Coordinator only, and for agents (if ticked later) this computer only.** This is the safest start:

- The Coordinator has no shell, can't read env or config files, and runs on Cody's machine.
- Turning on Captains, agents or remote runners is an explicit choice. The form explains the exposure next to each tickbox.

The Coordinator also needs `mcp__<name>` in its `--allowedTools`, since it runs with `dontAsk`. Captains need the same. Agents use `bypassPermissions`.

### Identity walls

A connector scoped to some projects must never reach a box or session of another identity, or of an out-of-scope project:

- **Upstash pool boxes**: an agent can read everything on its box. So the box wall key (`credentialSet`) gains a suffix naming the connectors that reach the project's agents on boxes (`identity:idn_x+con:<hash>`).
  - Two projects share a box only when they have the same identity **and** the same box connectors.
  - A project with no box connectors keeps today's key, so existing boxes stay valid.
  - When a connector's scope changes, resting tasks move the same way they do after an identity change.
- **Docker containers and RunPod pods** already belong to one project.
- **Captains** belong to one project. A Captain gets only the connectors scoped to its project.
- **The local runner**: every local agent runs as Cody's user and can read every task folder on this computer, which is the same as GitHub tokens today (docs/identities.md says the local runner is outside the wall). So "agents on this computer" means *any local agent can read this connector's access token while an in-scope turn runs*. The UI says so next to the tickbox.

### Status-only identities

- **A connector the Coordinator uses never reaches a status-only project's Captain or agents.** Such a connector would be a channel: a sealed agent writes to Notion, then the Coordinator reads Notion. So:
  - with "all projects", sealed projects are skipped at delivery, and the card says which ones;
  - choosing a sealed project explicitly on a Coordinator connector is refused on Save, with the reason.
- `list_connectors` returns names, kinds, scope, status, tool names and fingerprints. That is no project content, so it is safe for the Coordinator.

---

## 4. OAuth sign-in and where the redirect lands

### Flow

The flow follows the MCP authorization spec, using the SDK's `discoverOAuthServerInfo`, `registerClient`, `startAuthorization`, `exchangeAuthorization` and `refreshAuthorization`:

1. **Discovery.**
   - Probe the server: a `401` with `WWW-Authenticate: Bearer resource_metadata=…`, else `/.well-known/oauth-protected-resource` (RFC 9728).
   - Then fetch the authorization server metadata (RFC 8414, then OIDC).
2. **Client.**
   - Use dynamic client registration (RFC 7591) as a public client (`token_endpoint_auth_method: none`, `application_type` native or web, name "Box Yard"). The registration is kept per issuer and redirect URI.
   - The 2026-07-28 MCP spec deprecates registration in favour of client ID metadata documents (CIMD). CIMD needs an https URL the provider fetches from the internet, which a tailnet-only Box Yard can't serve, so Box Yard uses registration where offered (Notion and Linear do) and Cody's own client elsewhere.
   - For a provider without registration (Google), Cody's own client id and secret are entered once on the connector. The secret is encrypted.
3. **Authorize.**
   - PKCE S256 (a server whose metadata doesn't list S256 is refused, as the spec asks), `state` (32 random bytes, single use, 10 min), and `resource` (RFC 8707) on both the authorize and token requests.
   - The metadata's `issuer` must be the server it was fetched from (one trailing `/` tolerated: Google's resource metadata adds one).
   - Scopes come from the preset, from `WWW-Authenticate`'s `scope`, or from `scopes_supported`.
   - For Google, add `access_type=offline&prompt=consent` so a refresh token comes back.
4. **Callback.**
   - Box Yard exchanges the code with the verifier, which never left the server.
   - It checks `iss` when the server sends one (RFC 9207, mix-up defence), stores the tokens encrypted, runs a Test (tools/list), and broadcasts the new status.
5. **Refresh.**
   - Before every session start that uses the connector, and on Test: refresh when < 45 min of the access token is left. Nothing refreshes in the background, so a connector nobody uses gets no new tokens.
   - Refreshes are serialised per connector. That matters for Notion, whose refresh tokens rotate on every use and whose grant is revoked if an old one is replayed.
   - A rotated refresh token replaces the old one.
   - `invalid_grant` (or `invalid_client`) means `needs_auth`: the tokens are dropped, and `list_connectors` shows it, so the Coordinator can tell Cody.

### Where the redirect lands

Cody uses Box Yard from his iPhone over Tailscale with a password, often as a home-screen web app. Three facts shape the plan:

- OAuth 2.1 servers only accept `https://` redirect URIs, or `http://` on loopback. A plain `http://cody-mac:4000/…` (MagicDNS) or `http://100.x.y.z:4000/…` is usually refused.
- On iOS, a home-screen web app doesn't share cookies with Safari. The provider's sign-in page opens in Safari, so when the callback lands there it isn't logged in to Box Yard.
- The callback must not need Box Yard's login. Instead it is gated by the `state`: unguessable, single use, made by a logged-in "Sign in" press, and useless without the PKCE verifier held on the server.

The redirect URI Box Yard uses, in order:

1. **The browser's own origin when it's `https://` or loopback**: `<origin>/api/connectors/oauth/callback`.
   - This covers Box Yard on the Mac itself (`http://localhost:4000`) and **Tailscale Serve**: `tailscale serve --bg 4000` publishes `https://<mac>.<tailnet>.ts.net` with a real certificate, inside the tailnet only.
   - **This is the recommended setup for the iPhone.** Sign-in opens the provider in a new tab. The callback lands on that tab, says "Connected, you can close this tab", and the Settings card turns green through the live event stream, even in the home-screen app.
2. **Paste-back otherwise** (plain-http Tailscale, a raw IP):
   - Box Yard registers `http://127.0.0.1:<port>/api/connectors/oauth/callback`. On the Mac that lands for real.
   - On the iPhone, Safari shows "can't connect", and the dialog says: *copy the address from Safari's address bar and paste it here*. Box Yard reads `code` and `state` from it and finishes.
   - Claude Code itself does the same for remote sign-in.
3. **Google** takes neither DCR nor arbitrary redirects:
   - A **Desktop app** client allows any loopback port without registering it, which gives option 2.
   - A **Web application** client needs the exact `https://<mac>.<tailnet>.ts.net/api/connectors/oauth/callback` registered, which gives option 1.
   - The connector form asks which kind Cody made and shows the exact URI to paste into Google Cloud.

The callback page sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (the code can't leak through a Referer) and a strict CSP. It escapes everything it echoes, and never redirects to a URL taken from the request.

### API key or token fallback

When a server has no OAuth (or Cody prefers a key, as Linear allows), the connector takes a token. The form sets the header name and prefix (default `Authorization: Bearer`). It's a write-only field, like identity tokens.

---

## 5. Threat model

**Assets:**

- OAuth **refresh tokens**: long-lived account access.
- **Access tokens**: about 1 h.
- **API keys**: long-lived.
- Google **client secret**: low value for a Desktop client, but kept secret anyway.
- **Secret env vars** of commands.

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | A model (prompt-injected by an email, web page or repo file) prints or sends a secret | Secrets are never in prompts, tool results or events. `list_connectors` returns fingerprints. Refresh tokens and client secrets never leave the server process. The Coordinator and Captains can't read env or config files. Every connector secret in effect (and recent access tokens) is added to the transcript and error redaction list, so an echo becomes `[redacted]` |
| T2 | A model misuses the connector's own tools ("forward every email to …") | Token handling can't stop this. Instead: least-privilege presets (Gmail read-only by default; send off unless Cody picks it), narrow scope (default Coordinator only), and a clear UI note. A later option could allow only some of a connector's tools |
| T3 | Project B's agent reads project A's connector token on a shared Upstash box | The box wall key includes the box connectors (§3) |
| T4 | A status-only project's content reaches the Coordinator through a shared connector | A Coordinator connector never reaches sealed projects (§3) |
| T5 | A copy of `box-yard.sqlite` or a backup leaks | AES-256-GCM with the key outside the database (same as identities) |
| T6 | OAuth attacks: login CSRF, code interception, mix-up, open redirect, Referer leak | `state` (single use, 10 min, made by a logged-in press). PKCE S256 with the verifier server-side. `iss` check, and registrations and refresh tokens bound to their issuer. No redirect target taken from the request. `no-referrer` |
| T7 | A malicious MCP server's metadata points Box Yard at internal URLs (SSRF), or at a look-alike sign-in page | Only Cody adds connectors (UI only, no MCP tool writes them). Authorization and token endpoints must be `https` unless loopback. The sign-in dialog shows the host Cody will sign in at before he goes |
| T8 | Secrets in logs | Nothing logs a token. Errors pass through `redact()` with connector secrets included. Tests check server logs, transcripts, prompts, API responses and tool results |
| T9 | Supply chain: a command preset (`npx some-mcp`) runs with Cody's token | Prefer official remote servers. Command presets pin a version. The UI shows the exact command before Save |
| T10 | Third-party infrastructure (Upstash, RunPod) holds a token during a turn | Off by default. When on, agents only get access tokens (≤ 1 h) for OAuth connectors, and a token on `task.json` lives only for the turn. Documented |
| T11 | The Coordinator changes a connector's scope to widen its own reach | No MCP tool changes connectors. Only Settings writes them, and only on Save (Cody's draft rule) |

### Trade-off for tokens on boxes, in one line

An agent can use, and read, any token it's given. On remote runners the token sits on someone else's machine for the turn. So Box Yard sends only short-lived access tokens there, walls boxes by connector set, keeps refresh tokens home, and leaves remote runners off until Cody ticks them.

---

## 6. Gmail and the other presets

### Gmail and Google Calendar: a small built-in server

What exists today (researched 30 Oct 2026):

- **Google's official remote servers** (`gmailmcp.googleapis.com/mcp/v1`, `calendarmcp.googleapis.com/mcp/v1`) take a Google access token as a bearer, but:
  - they're in a Developer Preview programme only;
  - they need a Web client with Google's "AI agent" flag;
  - Gmail has no send tool;
  - it's unclear whether @gmail.com accounts can use them.
- **Community servers** do their own OAuth with Cody's client id and secret, and keep their own refresh tokens on disk:
  - GongRzhe/Gmail-MCP-Server is archived;
  - shinzo-labs/gmail-mcp wants `CLIENT_SECRET` and `REFRESH_TOKEN` in env, which would put the refresh token in every session;
  - taylorwilsdon/workspace-mcp (active) can take a bearer token, but only as a separate HTTP service Cody would run.

**Decision: Box Yard ships a small Google MCP server of its own** (`runner/google-mcp.mjs`):

- **What it is.** Plain Node with no dependencies, like `box-runner.mjs`. It reads only `GOOGLE_ACCESS_TOKEN` from its env and calls the Gmail and Calendar REST APIs.
- **Who holds what.** Box Yard does the Google sign-in and refresh itself, and hands the server only the 1-hour access token.
- **Why.** No `npx`, no third-party code holding Cody's mail, no refresh token outside the server. It runs as a command connector: on this computer for the Coordinator and Captains, and written next to the runner for agents.
- **Tools.**
  - Gmail: search, read a message or thread, list labels, create a draft, send, and change labels (archive, mark read).
  - Calendar: list calendars, list events, create, update and delete an event.

  A tool whose scope wasn't granted returns "needs the … scope: add it in Settings › Connectors and sign in again".
- **Default scopes are read-only:** `gmail.readonly` and `calendar.readonly`. "Drafts and send" (`gmail.compose`, which also allows sending), "Labels and archive" (`gmail.modify`) and "Edit events" (`calendar.events`) are opt-in ticks on the connector.

**Google's OAuth:**

- No dynamic registration or CIMD. Each person makes an OAuth client in Google Cloud once.
- A **Desktop app** client accepts any loopback redirect (`http://127.0.0.1:<port>/…`) without registering it. That's the simplest choice:
  - on the Mac, sign-in lands by itself;
  - on the iPhone, it's paste-back.
- A **Web application** client needs the exact https redirect. `ts.net` is on the Public Suffix List, so `https://<mac>.<tailnet>.ts.net/api/connectors/oauth/callback` should be accepted (not yet tried).
- Gmail's read, compose and modify scopes are "restricted". A public app would need Google verification plus a yearly security assessment. **Personal use is exempt**, so the app stays unverified and Cody clicks through "Google hasn't verified this app" once.
- **Publish the app "In production"**, not Testing. In Testing, Google expires refresh tokens after 7 days, which would mean signing in every week.
- `access_type=offline&prompt=consent` makes Google return a refresh token every sign-in.

### The others

- **Notion:** `https://mcp.notion.com/mcp`. MCP OAuth with dynamic registration and S256. Access tokens last about 8 h, and refresh tokens rotate on every use (180-day absolute and 30-day idle limits).
- **Linear:** `https://mcp.linear.app/mcp`. MCP OAuth with dynamic registration, or a personal API key as `Authorization: Bearer` (the simplest preset).
- **Slack:** `https://mcp.slack.com/mcp`. No dynamic registration.
  - Cody makes a Slack app (MCP feature on, user scopes, and an **https** redirect URL), and it signs in as a confidential client.
  - It needs Tailscale Serve: Slack refuses plain-http redirects, reportedly even to localhost.
  - Workspace admins may have to approve it.
- **Custom:** any URL or command. OAuth is detected from a `401` with `WWW-Authenticate`; otherwise use a token, env vars or none.

---

## 7. Plan (stacked PRs, each labelled `no-automerge`, merged in this order)

1. **Connectors core**:
   - migration, `ConnectorStore` with encrypted secrets, REST API, OAuth (discovery, DCR, PKCE, callback, paste-back, refresh), Test (tools/list over HTTP, SSE and stdio);
   - `list_connectors` MCP tool, redaction, `docs/connectors.md`;
   - tests with a fake OAuth server and fake HTTP and stdio MCP servers.
2. **Wiring**:
   - connectors into Coordinator and Captain MCP configs and `--allowedTools`, and into agents via `turnCredentials`, `task.json` and the runner's `mcp.json` (`${VAR}` refs);
   - scope checks, the box wall suffix, status-only rules;
   - e2e tests with the fake Claude CLI, showing that secrets reach the MCP server and nowhere else.
3. **Google server and presets**:
   - `runner/google-mcp.mjs` (Gmail and Calendar), written next to the runner for agents that get it;
   - `shared/connectorPresets.ts` (Gmail, Google Calendar, Notion, Linear, Slack);
   - Gmail setup steps in `docs/connectors.md`;
   - tests against a fake Gmail and Calendar API.
4. **Settings › Connectors UI**:
   - presets, add and edit as drafts, Sign in (new tab or paste-back), token field, scope pickers, status, and Test listing tools;
   - composite mock-mode screenshot (desktop and mobile).

## 8. Testing

- A fake OAuth server (metadata, DCR, PKCE check, code exchange, refresh with rotation, `invalid_grant`).
- A fake Streamable HTTP MCP server that requires the bearer token, and a fake stdio MCP server that requires an env secret.
- The fake Claude CLI gets a marker to call a connector's tool, so e2e runs prove the right sessions get the right connectors.
- Explicit tests that no secret appears in prompts (fake-claude session files), task, Captain or Coordinator transcripts, server logs, API responses, SSE events or MCP tool results.
- No real Google or other accounts, and no real OAuth apps.
