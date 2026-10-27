# Project identities

An identity is who acts for a project: a GitHub account (one or more tokens), the git author its commits carry, a Claude login, and the runners its agents may use. Each project has exactly one. Use identities when one Box Yard works for several GitHub accounts: a personal one, a work one, a client's org.

Every project starts on the **Default** identity, which is Settings › Credentials: nothing changes for a project until it's given another identity.

## The Default identity

- Its GitHub token and Claude login are the ones in Settings › Credentials (or `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` on the server). They're edited there, not on the identity, so each value has one place.
- It keeps its name and can't be removed. It may have an author of its own.
- When the database is migrated, every existing project is put on it.

## An identity of its own

| Field | What it does |
| --- | --- |
| Name, colour | Unique (case doesn't count). The colour tells identities apart in lists |
| GitHub login | Set by the first token saved: GitHub's `GET /user` says whose it is. Every token of an identity must be the same account |
| Tokens | One per owner (`acme`), or one for every owner (`""`). A turn gets the token for its repo's owner, else the every-owner one. An identity with no token gives its turns **none**, never the global one, so a push can't silently go out as another account |
| Owners | The users or orgs it works for (shown on the identity; matching is by token owner) |
| Author | `name` and `email` for every commit. Checked against the account's verified emails when the token may read them (`emailCheck`: `verified`, `unverified`, `unknown`); a GitHub noreply address counts as verified |
| Claude login | An API key or an OAuth token (`claude setup-token`). Without one, the identity uses the global login |
| Runners | The runners its projects may use (`box`, `local`, `gpu`, `docker`), or every runner |
| Coordinator sees | `everything` or `status`. Stored now; enforced in a later change |

## What a turn gets

From strongest to weakest:

1. The task's own env vars, then the project's own (`GITHUB_TOKEN`, `GH_TOKEN`, a Claude var, `GIT_AUTHOR_*`). These still win, as before identities.
2. The project's identity: its token for the repo's owner (else its every-owner token), its author, its Claude login.
3. For the Default identity only: Settings › Credentials.

Each turn gets exactly one Claude var, and its GitHub token in both `GITHUB_TOKEN` and `GH_TOKEN`. The author goes in `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`, which beat any `user.name` a repo sets. The runner drops every credential var the turn mustn't use from its own env first.

Box Yard's own git work for the project (clones, fetches, the turn-end push, PR checks, branch cleanup) uses the same token. A project's Captain runs on its identity's Claude login.

On the local runner, a project on any identity but Default uses only Box Yard's git credential helper: the helpers in this computer's `~/.gitconfig` (and so its `gh` login) are skipped for it.

## Secrets

- **Encrypted at rest.** Tokens and Claude logins are stored with AES-256-GCM. The key is `BOXYARD_SECRET_KEY` when it's set (64 hex characters, 32 bytes in base64, or any passphrase, hashed), else a random key in `<data dir>/secret.key` (mode 0600), made on first use. The key is never in the database: a copy of `box-yard.sqlite` alone holds no usable token.
- **Back up the key with the database.** Without it, identities keep their names, logins and fingerprints, but each token and Claude login shows `readable: false` and turns don't get it until it's saved again.
- **Write-only.** Values go in through the API and never come out: the API, the web app and the model see logins, owners, emails, scopes, expiry and a fingerprint (the first 12 hex of the value's sha256).
- **Kept out of transcripts.** Every credential value in effect (Settings › Credentials' and the identities') is replaced with `[redacted]` in task, Captain and Coordinator messages before they're saved or shown, so an agent that prints its env leaves no token behind. Cody's own messages are kept as written. API errors are redacted the same way.
- **Kept from `claude`.** `BOXYARD_SECRET_KEY` is removed from the env of the Coordinator and the Captains, and the local runner already strips every `BOXYARD_*` var from agents.

## Boxes

Tasks of two identities never share an Upstash box: an agent can read everything on its box, including other workspaces' `task.json`. A box remembers the identity it was made for, a project of the same identity shares it, and a resting task on a box of another identity moves when nothing would be lost. A project with its own token or Claude login in its env has a set of its own, as before.

So each identity in use needs boxes of its own. When the pool is at Max boxes and none is that identity's, its tasks wait and say so: raise Max boxes, or let idle boxes go.

Docker containers, GPU pods and the local runner are outside the wall: each already belongs to one project, or to this computer.

## Runners

An identity's runners are checked when a project is given the identity or a new "Runs on", when a task asks for its own runner, and when an identity's runners change (refused while a project of it runs elsewhere). A task pinned to a runner before its identity stopped allowing it waits and says why; it never runs there.

## API

| Route | Body | What it does |
| --- | --- | --- |
| `GET /api/identities` | | Every identity, Default first |
| `POST /api/identities` | `{ name, color?, owners?, author?, runners?, coordinatorSees? }` | A new identity, without secrets |
| `PATCH /api/identities/:id` | the same fields | Edit; Default keeps its name |
| `DELETE /api/identities/:id[?moveProjects=1]` | | Remove. 409 while projects use it, unless they move to Default |
| `PUT /api/identities/:id/tokens` | `{ owner, token }` | Save a token after GitHub accepts it (`owner: ""` for every owner) |
| `DELETE /api/identities/:id/tokens?owner=` | | Forget the owner's token |
| `PUT /api/identities/:id/claude` | `{ kind: "api_key" \| "oauth_token", value }` | Save its Claude login |
| `DELETE /api/identities/:id/claude` | | Back to the global login |
| `PATCH /api/projects/:id` | `{ identityId }` | Give a project an identity (also on `POST /api/projects`) |

Every change is broadcast as an `identities` event.

## Coming next

- Commit signing: an SSH (or GPG) key per identity, `requireSigned` checked before every push, and this computer's own git config kept away from identity projects on the local runner.
- MCP tools (`list_identities`, `create_identity`, `detect_identities`, …), so the Coordinator can find the GitHub accounts, emails and keys this computer already uses and set identities up without a value ever passing through the model.
- Settings › Identities in the web app, an identity picker on each project, and badges.
- The Coordinator's `status` view of an identity's projects.
