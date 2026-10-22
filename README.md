# Box Yard

One chat that runs a yard of Claude Code agents, each working inside an [Upstash Box](https://upstash.com/docs/box).

You tell the **orchestrator** what you want. It sets up **projects** (with or without a GitHub repo) and starts **tasks**. Each task is a headless Claude Code agent with its own folder in a worker box. Agents ask you questions, message each other, open pull requests, share preview URLs and publish files. All of it shows up live in the web app. Box Yard itself can run in a box too, so you can close your laptop and the yard keeps working.

```
 ┌──────────── web app (React + TanStack Query, live over SSE) ───────────┐
 │  projects sidebar · task cards · inbox · global orchestrator chat      │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ REST + SSE
 ┌───────────────────────────────▼────────────────────────────────────────┐
 │ Box Yard server (Node + SQLite)                                        │
 │  orchestrator = `claude -p --resume` + Box Yard MCP tools              │
 │  task manager = box pool, queue, turns, archives, agent messaging      │
 └──────┬──────────────────────────────────────────────▲──────────────────┘
        │ Box API: create box, write files, start turn │ events (Redis stream,
        ▼                                              │  or the box's event log)
 ┌─────────────── worker box (up to BOX_POOL_MAX) ─────┴──────────────────┐
 │ tasks/<id>/work     repo clone or scratch folder                       │
 │ tasks/<id>/claude   that agent's Claude session (moves with the task)  │
 │ box-runner.mjs      runs `claude -p --resume <session>` per message,   │
 │                     plus an MCP server: ask_user, message_agent,       │
 │                     create_pull_request, report_preview, ...           │
 └────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
git clone https://github.com/webdevcody/box-yard && cd box-yard

./yard demo     # no keys needed: a fake Claude drives everything, agents run in local folders
./yard local    # the real thing on http://localhost:3000 (fill in .env first)
```

`./yard local` creates `.env` from `.env.example` the first time. The keys:

| Variable | What it's for |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code login for the orchestrator and every agent. Run `claude setup-token` to get one. `ANTHROPIC_API_KEY` works too. |
| `UPSTASH_BOX_API_KEY` | Worker boxes. Without it, agents run in folders on this machine (`BOX_PROVIDER=local`). |
| `GITHUB_TOKEN` | Clone private repos, push branches, open PRs. A fine-grained token with Contents and Pull requests (read/write) is enough. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional. A faster event bus between boxes and the orchestrator. |
| `BOXYARD_PASSWORD` | Web UI password. Leave it empty on localhost, and always set it when the app is public. |

Requirements are Node 20+ and git. `./yard local` installs the Claude Code CLI if it's missing.

## Deploy

```bash
./yard deploy-box              # run Box Yard inside its own Upstash Box (keep-alive)
./yard deploy-vps root@1.2.3.4 # run it on your server with Docker (HTTPS if BOXYARD_DOMAIN is set)
```

**`deploy-box`** creates or updates a box named `box-yard-orchestrator`, uploads the app, installs Claude Code, builds, and prints a public URL and password. The box is keep-alive, and an init command restarts the server whenever the box resumes. Run it again to ship changes. Your data is kept. `npm run deploy:box -- --logs` tails the server log.

**`deploy-vps`** copies the app and `.env` over SSH, installs Docker if needed, and runs `docker compose up -d --build`. Data lives in the `box-yard-data` volume.

## How it works

**Orchestrator.** Each chat message runs `claude -p` with `--resume <session>`, so the conversation keeps its context across messages and restarts. The orchestrator gets Box Yard's MCP tools (`create_project`, `create_task`, `send_to_task`, `list_inbox`, `get_preview_url`, `create_artifact`, `save_note`, `pool_status`, and more) at `/mcp`. Task updates such as questions, PRs, finished work and failures appear in the chat as notices. The orchestrator also reads them at the start of its next turn.

**Tasks and turns.** A task's agent runs one headless turn per incoming message (`claude -p --session-id` the first time, then `--resume`). Messages that arrive while it's busy wait in a queue and go out together in the next turn. Each task's Claude config lives in its own folder (`CLAUDE_CONFIG_DIR`), so the session moves with the task.

**Statuses.** A task is in one of these states:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for a box slot. |
| `starting` | Its box is being prepared. |
| `working` | A turn is running. |
| `needs_input` | The agent asked you something. It shows in the Inbox. |
| `waiting` | The agent is waiting on a reply from another agent. |
| `idle` | The last turn ended and nothing is pending. |
| `pr_ready` | The agent opened a pull request. |
| `done` | The agent or you marked it finished. |
| `failed` | Something broke. Retry with a click. |

**Box pool.** The free plan allows about 5 boxes, so Box Yard runs a pool. `BOX_POOL_MAX` (default 5) caps how many boxes exist, and `BOX_SLOTS` (default 2) sets how many agents run at once in one box. The defaults allow 10 agents at a time, and further work waits in a queue. Tasks stay on the box they started on. If that box is busy and the task's archive is current, the task can move to a free box. Idle boxes pause on their own.

**Nothing gets lost.**
- Every transcript line, question, PR, preview, note and artifact is stored in SQLite.
- After every turn, the task folder (repo, Claude session, event log) is archived to the server's disk.
- If a box disappears, its tasks are restored from their archives onto another box. A turn that dies mid-run is retried with a "you were interrupted, check where things stand" message, up to two times.
- If a Claude session can't be found, the agent starts a fresh one with a recap of the conversation.
- When the server restarts, it reattaches to turns that are still running inside boxes.

**Agents talk to each other.** Agents can call `list_agents` and `message_agent` (optionally waiting for a reply), `save_note` and `read_notes` for project memory that every future agent sees, and `ask_user` to ask you. Messages go through the orchestrator, because boxes can't reach each other directly. Agent-to-agent messages are rate limited to stop loops.

**Previews and artifacts.** An agent starts a dev server on its own port range (`$PORT` to `$PORT+9`) and calls `report_preview`. Box Yard then asks the box for a public URL (`getPublicURL`). For files, `publish_artifact` copies the file to the server, and Box Yard hosts it at `/artifacts/...`.

**Schedules.** A schedule is a cron job inside a project: a name, a 5-field cron expression (or `@hourly`, `@daily`, `@weekly`, `@monthly`), a time zone and a prompt. Each time it fires, Box Yard starts an ordinary task in that project, so you watch the run live like any other task. The Schedules page shows a live tail of a run that is going, plus each schedule's run history. The prompt for each run also says how the previous run ended, so runs can build on each other. Create, pause, run now and delete schedules from the Schedules page, a project page, or the orchestrator chat (`create_schedule`, `list_schedules`, `update_schedule`, `run_schedule_now`, `delete_schedule`).

- The server's own timer checks for due schedules every 15 seconds (`BOXYARD_SCHEDULER_TICK_MS`).
- If the server was down when runs were due, it starts one catch-up run when it comes back, and tells the agent how many runs it missed. Set a schedule's missed-runs option to "skip" to drop them instead.
- A new run is skipped while the previous run is still going, unless the schedule allows overlap. The reason shows on the schedule card.
- Optional: with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` (and `QSTASH_NEXT_SIGNING_KEY`) plus `BOXYARD_PUBLIC_URL`, each schedule is also created in Upstash QStash, which POSTs to `/qstash/schedules/<id>`. That request wakes a paused orchestrator box, so runs happen on time. Box Yard checks the QStash signature, and the local timer and QStash can't both start the same run.
- New schedules use `BOXYARD_TIMEZONE`, or the server's time zone if that isn't set.

**Event bus.** The worker runner appends every event to `events.jsonl` in the box. If Upstash Redis is configured, it also adds the event to a Redis stream. Events carry sequence numbers, so the server can read either source without duplicates. If Redis misses something, the server falls back to the file.

### Where the SQLite data lives when the orchestrator runs in a box

The database is a normal SQLite file (WAL mode) on the orchestrator box's own disk, at `/workspace/home/box-yard-data`. Box disks persist across pauses and redeploys, so this is the primary copy. For an off-box copy, the server snapshots its own box every 6 hours (`BOXYARD_SELF_SNAPSHOT_HOURS`) and keeps the last 3 snapshots. It checkpoints the WAL before each snapshot. If the box is ever lost, restore it with `npm run deploy:box -- --from-snapshot <id>`.

Redis is only the message bus. It never holds the source of truth, so losing it loses nothing.

## Development

```bash
./yard dev          # API on :3000 with reload, web on :5173
npm test            # unit + end-to-end tests (fake claude, local boxes, fake Redis)
npm run typecheck
npm run worker-snapshot   # bake Claude Code into a snapshot -> WORKER_SNAPSHOT_ID for fast box starts
```

The mock Claude (`scripts/fake-claude.mjs`) speaks the same headless protocol and calls the real MCP tools. In the orchestrator chat, try `create project demo`, then `task demo: Haiku -- write a haiku [artifact]`, or `schedule demo "*/5 * * * *": Haiku drop -- write a haiku [artifact]`. Worker prompts react to `[ask]`, `[fail]`, `[slow]`, `[preview]`, `[artifact]`, `[note]` and `[agent:<taskId>]`.

| Path | What's there |
| --- | --- |
| `server/` | API, SQLite store, task manager, orchestrator, MCP tools, box providers (`upstash`, `local`) |
| `runner/box-runner.mjs` | Copied into each worker box. Runs turns and serves the agent's MCP tools, with no dependencies. |
| `web/` | The React app |
| `scripts/` | Deploy scripts and the fake Claude |

## Untested against real services

This version was built without live keys, so the following has run only against the fake Claude and local boxes. Check it first with real accounts:

- **Box API behavior.** Upstash Box calls follow the `@upstash/box` 0.7.10 type definitions: `exec`, `files`, `getPublicURL`, `snapshot`, `keepAlive` and `setInitCommand`. Their real behavior hasn't been confirmed.
- **Background processes and pausing.** It's unconfirmed whether a background process survives a dropped exec connection. While a turn runs, Box Yard holds an exec stream open so the box doesn't pause.
- **QStash.** The schedule calls (`POST /v2/schedules/<url>` with `Upstash-Cron` and `Upstash-Schedule-Id`) and the signature check follow QStash's docs. They have only run against a fake.
- **Claude CLI.** The `claude` flags were checked against the real CLI, but no real model turn ran.
