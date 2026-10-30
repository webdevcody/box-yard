# Codex

Box Yard's agents can run on OpenAI's [Codex CLI](https://developers.openai.com/codex/cli) as well as Claude Code. Claude Code stays the default everywhere; pick Codex where you want it:

| What | Where you pick it |
| --- | --- |
| The Coordinator | Settings › Coordinator › Agent |
| Every project's Captain | Settings › Coordinator › Captains › Agent |
| A project's task agents | Project › Settings › Agent (or Settings › Box agents › Agent for every project that doesn't pick one) |
| One task | `agent: "codex"` on `create_task` / `create_tasks`, or a `gpt-*` / `o*` model, which picks Codex on its own |

A task keeps the agent it started on, so changing a project's Agent only changes its new tasks. The Coordinator and Captains switch from their next turn: their old session belongs to the other CLI, so the next turn starts a new one with a recap of the conversation, the same way as when a session goes missing.

## Logging in

Codex needs a login wherever it runs. Box Yard hands it one of these, first match wins:

1. **A project's own `CODEX_API_KEY`** in its env (or a task's). That project's tasks then get boxes of their own, like a project with its own Claude login.
2. **Settings › Credentials › Codex ChatGPT login.** Uses your ChatGPT plan. Run `codex login` on a computer with a browser, then paste the whole of `~/.codex/auth.json`. On the server you can set `CODEX_AUTH_JSON` instead (the file, or it base64-encoded).
3. **Settings › Credentials › OpenAI API key for Codex** (`CODEX_API_KEY` on the server). Pay per use. When both are set, Box Yard uses the ChatGPT login.
4. **Nothing set, on this computer:** agents running here (Runs on: This computer) and the Coordinator use this computer's own `codex login` (`~/.codex`). Boxes, RunPod pods and Docker containers can't, so they need one of the above.

The Test button next to each runs a real one-word `codex exec` with only that login.

### The ChatGPT login is refreshed, so Box Yard keeps the newest copy

Codex refreshes a ChatGPT login's tokens when they're about a week old, and the refresh token it replaces stops working. A copy of `auth.json` pasted on several machines would leave all but one with a spent token. So Box Yard keeps the login itself:

- Each turn gets the current copy as `codex-auth.json` in its task folder. The runner moves it into the task's own Codex home (`<task>/codex/auth.json`, mode 600), unless the copy already there is the same account refreshed later: the newer one always wins.
- When the turn ends, Box Yard reads that file back and keeps it if Codex refreshed it, for every later turn, box and Captain. The Coordinator's own runs use `<data>/codex` and are taken back the same way.
- Task archives never include the login, and box snapshots strip `~/.codex/auth.json`.

Two turns that both refresh at the same moment (a week-old login, two agents starting at once) can still race: the loser's turn fails with "refresh token was already used", and the next turn gets the winner's tokens. If you run many Codex agents at once, an API key avoids the question.

Project identities (docs/identities.md) have no Codex login of their own yet: a Codex task in a project with a non-Default identity uses Settings' Codex login, with the identity's GitHub token and git author as usual.

## How a Codex agent runs

**Task agents** run `codex exec --json` on their box through `runner/box-runner.mjs`, with:

- Box Yard's tools (ask_user, create_pull_request, mark_done…) as an MCP server, approved to run without asking.
- `--dangerously-bypass-approvals-and-sandbox`, the same footing as Claude Code's `bypassPermissions`: the box is the sandbox. On This computer that means unsandboxed, as with Claude Code.
- `--ignore-user-config`, so a `~/.codex/config.toml` on the box or this computer (its MCP servers, its model) doesn't leak in, and ChatGPT apps, plugins and computer use switched off.
- The task's own Codex home in its folder (`<task>/codex`), so its sessions move with the task between boxes. Each turn resumes the thread Codex named on the first one.

Codex is installed the first time a Codex task lands on an Upstash box or RunPod pod (`npm install -g @openai/codex`); Box Yard's Docker image and server image already have it. On This computer it's yours to install.

Codex isn't supported on SSH machines yet ([Machines › Codex](machines.md#codex)): a Codex task asked to run on one is refused, and nothing is installed there.

**The Coordinator and Captains** run `codex exec` on the server with Box Yard's MCP tools over HTTP (the token comes through an env var, never the command line), a read-only sandbox, and no shell: they act through Box Yard's tools, and a shell could read Box Yard's data folder past what a status-only project allows. Images you attach are attached to the message; small text files come inline.

**Side threads** on a Codex chat start from the chat's summary and its messages up to the highlight (Codex can't fork a session at a message), and stay read-only through their own MCP token.

## What's different from Claude Code

| | Claude Code | Codex |
| --- | --- | --- |
| Model | Settings › Model, routing, the task's model | Settings › Codex model (empty: Codex's default). A task's or routing's model is used when it's an OpenAI one; a Claude model gives way to the Codex model |
| Effort | `--effort` | `model_reasoning_effort` (same levels) |
| Context meter | from each API call | from the session's rollout file, at the end of each turn |
| Compact (task) | Box Yard runs `/compact` | Codex compacts on its own; Settings › Box agents › Auto-compact sets `model_auto_compact_token_limit`. The Compact button refuses |
| Compact (Coordinator, Captain) | summary, then `/compact` | summary, then the next turn starts a new session from it |
| Cost | the CLI's `total_cost_usd` | not reported (tokens are) |
| Streaming replies | word by word | a message at a time |

## Trying it without an OpenAI account

`scripts/fake-codex.mjs` speaks `codex exec --json` and does the work with `scripts/fake-claude.mjs`, so every fake-claude prompt marker works. Mock mode (`./yard demo`) uses it, and so do the tests (`test/codex*.test.ts`):

```sh
CODEX_BIN="node scripts/fake-codex.mjs" npm run dev
```
