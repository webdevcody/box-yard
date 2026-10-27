# Project identities

An identity is who acts for a project: a GitHub account (one or more tokens), the git author its commits carry, the key that signs them, a Claude login, and the runners its agents may use. Each project has exactly one. Use identities when one Box Yard works for several GitHub accounts: a personal one, a work one, a client's org.

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
| Signing key | An SSH key that signs every commit a turn makes, and optionally `requireSigned` (see [Signing](#signing)) |
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

On the local runner, a project on any identity but Default is walled off from this computer's own git and `gh` setup:

- it uses only Box Yard's git credential helper: the helpers in `~/.gitconfig` are skipped for it;
- its turns, and Box Yard's own git work for it, get a git config and a `gh` folder of the identity's own, in `<local dir>/.boxyard/identities/<id>/` (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GH_CONFIG_DIR`), so `~/.gitconfig`'s name, email, signing key, `includeIf` rules and hooks, and the `gh` login, don't reach it. The repo's own `.git/config` still applies.

Default projects keep this computer's setup, as before.

## Signing

An identity can sign every commit its turns make with an SSH key (git 2.34 or later, and `ssh-keygen`, on the runner). There are two kinds:

- **A key file** (`kind: "file"`). Paste a private key without a passphrase; Box Yard keeps it encrypted like a token and shows only its public key and fingerprint (`SHA256:…`). Make one for the identity with `ssh-keygen -t ed25519 -N "" -f acme-signing`, and add `acme-signing.pub` to the GitHub account as a **signing key** (Settings › SSH and GPG keys) so GitHub marks the commits Verified. It works on every runner.
- **A key in this computer's agent** (`kind: "agent"`). Give the public key (`ssh-add -L`, or 1Password's), and, for 1Password, its `program` (`/Applications/1Password.app/Contents/MacOS/op-ssh-sign`). The private key never leaves the agent, so this identity's projects run **only on the local runner**: setting such a key is refused while a project of it runs elsewhere, and so is moving one off this computer. Without a `program`, `SSH_AUTH_SOCK` has to be set in Box Yard's own environment.

How a turn signs:

- A key file goes to the box for one turn as `signing.key` beside `task.json` (never in it, and never in an archive). The runner moves it to a fresh 0700 folder in the box's temp dir, `boxyard-sign-<task id>`, and removes that folder when the turn ends.
- git gets `gpg.format=ssh`, `user.signingKey` and `commit.gpgSign=true` from the env (`GIT_CONFIG_COUNT`), which beats any repo or global config and reaches only the turn's processes: the repo's `.git/config` is never changed, and Box Yard's own work-in-progress snapshots stay unsigned.
- When a turn can't sign (the key can't be read with this server's secret key, the program is gone, git is too old), its commits go unsigned and the task says why: "This turn's commits aren't signed: …".

**`requireSigned`** stops unsigned commits leaving the box:

- In the turn, a pre-push hook refuses a push carrying any commit the identity's key didn't sign and that no remote has yet, and names them. The repo's own hooks (`.git/hooks`, husky's `core.hooksPath`) still run.
- It holds when signing can't be set up too: then the turn's pushes are stopped, and the task says so.
- At the turn's end, Box Yard checks the branch the same way and leaves it off origin when a commit isn't signed: "Turn-end push: the Acme identity requires signed commits, and its key (SHA256:…) didn't sign 1a2b3c4, so the branch wasn't pushed". The work-in-progress ref still carries the work, so nothing is lost; re-sign with `git rebase --force-rebase --gpg-sign origin/main` and push.
- It's a guard against mistakes, not a lock: an agent can skip a hook with `git push --no-verify`. To make it a lock, turn on "Require signed commits" in the repo's GitHub branch protection.

Not covered yet: GPG keys; commits Box Yard makes through GitHub's API (the screenshots on `boxyard-assets`) aren't signed; a repo cloned over SSH (`git@github.com:…`) still reaches this computer's SSH keys on the local runner, since only HTTPS goes through the identity's token.

## Secrets

- **Encrypted at rest.** Tokens and Claude logins are stored with AES-256-GCM. The key is `BOXYARD_SECRET_KEY` when it's set (64 hex characters, 32 bytes in base64, or any passphrase, hashed), else a random key in `<data dir>/secret.key` (mode 0600), made on first use. The key is never in the database: a copy of `box-yard.sqlite` alone holds no usable token.
- **Back up the key with the database.** Without it, identities keep their names, logins and fingerprints, but each token and Claude login shows `readable: false` and turns don't get it until it's saved again.
- **Write-only.** Values go in through the API and never come out: the API, the web app and the model see logins, owners, emails, scopes, expiry and a fingerprint (the first 12 hex of the value's sha256).
- **Kept out of transcripts.** Every credential value in effect (Settings › Credentials' and the identities', a signing key also line by line) is replaced with `[redacted]` in task, Captain and Coordinator messages before they're saved or shown, so an agent that prints its env leaves no token behind. Any private key block, known or not and even cut off, becomes `[redacted private key]`. Cody's own messages are kept as written. API errors are redacted the same way.
- **Kept from `claude`.** `BOXYARD_SECRET_KEY` is removed from the env of the Coordinator and the Captains, and the local runner already strips every `BOXYARD_*` var from agents.

## Boxes

Tasks of two identities never share an Upstash box: an agent can read everything on its box, including other workspaces' `task.json`. A box remembers the identity it was made for, a project of the same identity shares it, and a resting task on a box of another identity moves when nothing would be lost. A project with its own token or Claude login in its env has a set of its own, as before.

So each identity in use needs boxes of its own. When the pool is at Max boxes and none is that identity's, its tasks wait and say so: raise Max boxes, or let idle boxes go.

Docker containers, GPU pods and the local runner are outside the wall: each already belongs to one project, or to this computer.

## Runners

An identity's runners are checked when a project is given the identity or a new "Runs on", when a task asks for its own runner, and when an identity's runners change (refused while a project of it runs elsewhere). A task pinned to a runner before its identity stopped allowing it waits and says why; it never runs there.

## Set up from this computer

The Coordinator (or a project's Captain) can set identities up from what this computer already uses, so nobody has to work out which token, email and key go with which repo. It's how the Coordinator answers a clone, fetch or push that fails with 401, 403 or 404, or a question about GitHub accounts: it runs `detect_identities`, proposes the whole setup to Cody in one message, and imports only what Cody agrees to.

**What detection reads.** Read-only; it changes nothing:

- `gh auth status`: the github.com accounts `gh` is signed in to, the active one, its git protocol, token scopes and where gh keeps the token. Another host (GitHub Enterprise) is noted, not proposed.
- `git config --global --includes`: the global author and signing setup, and each `includeIf` block's file (`user.*`, `gpg.*`, `commit.gpgsign`, `core.sshCommand`; credential helpers by name only).
- For an `includeIf "gitdir:…"` block, the `origin` remotes of the repos under its folder (three levels down, 400 folders at most, each `.git/config` read as text), so the block's repo owners are known.
- `~/.ssh/config`'s hosts that reach GitHub, the public keys beside `~/.ssh` key files (or `ssh-keygen -y` without a passphrase), and fingerprints of the keys `core.sshCommand -i` pushes with.
- **Online** (the default), for each account it asks GitHub with that account's own `gh` token, read on the server and never returned: `GET /user`, `/user/orgs`, `/user/emails`, the account's SSH and signing keys, and `GET /repos/:owner/:name` for each project's repo (push access, 404, SAML SSO). `online: false` skips GitHub.

The env it runs `gh`, `git` and `ssh-keygen` with drops `GH_TOKEN`, `GITHUB_TOKEN`, the enterprise tokens, `GH_HOST`, `GIT_DIR` and `GIT_CONFIG_*`, and never prompts.

**What it proposes.** One identity per github.com account:

- An `includeIf` block goes with the account whose verified emails hold its email, whose GitHub keys hold its SSH or signing key, or whose login or orgs own its repos. The active account takes the global author.
- A project goes to the account that can push to its repo (online), or that owns it (offline); a project on Default stays there when Default's token is that account already. Projects nothing clearly matches stay where they are, with the reason.
- A token is named `gh:github.com:<login>` and a signing key `file:~/.ssh/<key>` or `agent:SHA256:…`. A proposal holds no value.

**Importing.** `import_detected_identity` reads the token from `gh` and the key by reference again, on the server, and checks the token with GitHub before saving it, encrypted. An identity Box Yard already has for the login is updated instead. Then the proposal's projects move to it, each only while it has no task running.

**What a reference may name.**

- `gh:<login>` (or `gh:<host>:<login>`): an account `gh` is signed in to here.
- `file:<path>`: a key file without a passphrase, in `~/.ssh` (symlinks resolved) or the one a git config here names as `user.signingkey`; at most 16 KB and a private key. A key this computer also logs in to SSH servers with (`~/.ssh/id_*`, an `IdentityFile`, a `core.sshCommand -i` key) is refused for an identity whose projects may run on boxes, since each box would hold a copy: make a signing key of its own (`ssh-keygen -t ed25519 -N "" -C box-yard-signing -f ~/.ssh/box_yard_signing`), or keep its projects on this computer (`runners: ["local"]`).
- `agent:<SHA256:… or public key>`: a key in a git config here, in `~/.ssh/*.pub` or in the SSH agent (`ssh-add -L`). Its identity runs only on the local runner.

A token or key itself is never taken through a tool: it goes in Settings › Identities. Tool errors never repeat what was passed in, and any token or key shape in one is redacted.

### MCP tools

| Tool | What it does | A Captain |
| --- | --- | --- |
| `list_identities` | Every identity: login, owners, author and its email check, signing fingerprint, Claude login kind, runners, projects, last test | Sees every identity, but only its own project in them (others as a count) |
| `detect_identities` | Reads this computer (and GitHub, online) and proposes identities with the evidence. Changes nothing | Maps its own project only |
| `import_detected_identity` | A proposal becomes an identity, or updates the one for that login, and gets the proposal's projects | Gives it its own project only |
| `create_identity` | A new identity, with a token and signing key by reference. Nothing is made when a reference can't be read | Yes |
| `update_identity` | Fields, references, `remove_token`, `remove_claude` | Only an identity no other project uses, never Default |
| `delete_identity` | Removes it; `move_projects_to_default` moves its projects first | Same as update |
| `assign_identity` | Gives a project an identity: the runner has to fit and no task may be running | Its own project only |
| `test_identity` | Checks with GitHub: each token (whose, scopes, expiry), push access to its projects' repos, the author email, the signing key. Saved as the last test | Its own project's identity, for its own repo; not saved |

To try detection on this computer: `npm run test:detect` (read-only and offline; it prints logins, owners, emails and fingerprints only).

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
| `PUT /api/identities/:id/signing` | `{ kind: "file", privateKey, requireSigned? }` or `{ kind: "agent", publicKey, program?, requireSigned? }` | Save its signing key (replaces the old one) |
| `PATCH /api/identities/:id/signing` | `{ requireSigned }` | Turn `requireSigned` on or off |
| `DELETE /api/identities/:id/signing` | | Stop signing |
| `PATCH /api/projects/:id` | `{ identityId }` | Give a project an identity (also on `POST /api/projects`) |

Every change is broadcast as an `identities` event.

## Coming next

- Settings › Identities in the web app (with "Import from this computer"), an identity picker on each project, and badges.
- The Coordinator's `status` view of an identity's projects.
- GPG signing keys.
