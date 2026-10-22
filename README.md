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

**`deploy-box`** creates or updates a box named `box-yard-orchestrator`, uploads the app, installs Claude Code, builds, and prints a public URL and password. Run it again to ship changes. Your data and password are kept. `npm run deploy:box -- --logs` tails the server log, and `-- --restart` restarts the server without redeploying.

- On a paid Upstash plan the box is keep-alive. On the free plan keep-alive isn't allowed, so it falls back to a normal box: while agents are running or queued, the server holds its own box awake, and when the yard is idle it lets go. Opening the URL wakes a paused box, and the init command restarts the server, which picks running agents back up.
- Talk to a deployed yard from the terminal with `YARD_URL=<url> YARD_PASSWORD=<password> npx tsx scripts/yardctl.ts say "..."` (also `status`, `wait`, `task <id>`, `chat`, `reset`).

**`deploy-vps`** copies the app and `.env` over SSH, installs Docker if needed, and runs `docker compose up -d --build`. Data lives in the `box-yard-data` volume.

## How it works

**Orchestrator.** Each chat message runs `claude -p` with `--resume <session>`, so the conversation keeps its context across messages and restarts. The orchestrator gets Box Yard's MCP tools (`create_project`, `create_task`, `send_to_task`, `wait_for_tasks`, `list_tasks`, `list_inbox`, `get_preview_url`, `create_artifact`, `save_note`, `pool_status`, and more) at `/mcp`. Every turn starts with a snapshot of the agents that are busy right now, so it never works from stale memory.

**Routing.** For each request the orchestrator decides where the work goes:

| Request | What happens |
| --- | --- |
| Follow-up on work an agent did ("close those issues", "fix that PR") | `send_to_task` to that agent. Its Claude session resumes with full context, restored from the archive if it was parked. |
| Follow-up while that agent is mid-turn | Same call. The message is queued and goes out as soon as the turn ends, in the same session. |
| New, independent work in a known project | `create_task`: a fresh session on the project's box. `related_tasks` passes along earlier outcomes. |
| A repo with no project yet | `create_project`, then `create_task`. One project per repo. |
| Several repos or independent pieces | One task each, all started at once. |

`list_tasks` takes a `query`, so even a fresh orchestrator session finds the agent that did related work. For quick work it calls `wait_for_tasks` and answers in the same reply. For long work it ends its turn. When an agent finishes, fails, asks something or opens a PR, a notice lands in the chat and the orchestrator wakes up on its own to tell you, and to start the next step of what you asked for (`BOXYARD_ORCHESTRATOR_AUTOWAKE=0` turns this off). Notices from an agent that's still mid-turn wait for its end-of-turn notice, so you get one report.

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

**Box pool.** The free plan allows about 5 boxes, so Box Yard runs a pool. `BOX_POOL_MAX` (default 5) caps how many boxes exist, and `BOX_SLOTS` (default 2) sets how many agents run at once in one box. The defaults allow 10 agents at a time, and further work waits in a queue. `BOX_MAX_AGENTS` optionally caps agents across all boxes. These are defaults: edit them live in Settings (or from the Boxes page). Lowering a limit never stops running work; it just holds back new work until usage drops. Placement keeps a project together:

1. A task goes to a box that already hosts its project (each box keeps a bare mirror of the project's repo, so later clones come from local disk).
2. Otherwise an empty box.
3. Otherwise, while the pool has room, a new box is made for that project and reserved for it.
4. Once the pool is full, projects share boxes, picking the least loaded one.

A project whose box has all its slots busy gets a second box while there's room. Tasks stay on the box they started on. If that box is busy and the task's archive is current, the task can move to a free box.

**Nothing gets lost.**
- Every transcript line, question, PR, preview, note and artifact is stored in SQLite.
- After every turn, the task folder (repo, Claude session, event log) is archived to the server's disk.
- If a box disappears, its tasks are restored from their archives onto another box. A turn that dies mid-run is retried with a "you were interrupted, check where things stand" message, up to two times.
- If a Claude session can't be found, the agent starts a fresh one with a recap of the conversation.
- When the server restarts, it reattaches to turns that are still running inside boxes.

**Agents talk to each other.** Agents can call `list_agents` and `message_agent` (optionally waiting for a reply), `save_note` and `read_notes` for project memory that every future agent sees, and `ask_user` to ask you. Messages go through the orchestrator, because boxes can't reach each other directly. Agent-to-agent messages are rate limited to stop loops.

**Previews and artifacts.** An agent starts a dev server on its own port range (`$PORT` to `$PORT+9`) and calls `report_preview`. Box Yard then asks the box for a public URL (`getPublicURL`). For files, `publish_artifact` copies the file to the server, and Box Yard hosts it at `/artifacts/...`. The agent gets the final URL back right away, so it can pass the link on.

**Pull requests.** When a turn ends on a task with a PR, Box Yard asks GitHub for its state. A merged PR marks the task done. A closed one means there's nothing left to review.

**Schedules.** A schedule is a cron job inside a project: a name, a 5-field cron expression (or `@hourly`, `@daily`, `@weekly`, `@monthly`), a time zone and a prompt. Each time it fires, Box Yard starts an ordinary task in that project, so you watch the run live like any other task. The Schedules page shows a live tail of a run that is going, plus each schedule's run history. The prompt for each run also says how the previous run ended, so runs can build on each other. Create, pause, run now and delete schedules from the Schedules page, a project page, or the orchestrator chat (`create_schedule`, `list_schedules`, `update_schedule`, `run_schedule_now`, `delete_schedule`).

- The server's own timer checks for due schedules every 15 seconds (`BOXYARD_SCHEDULER_TICK_MS`).
- If the server was down when runs were due, it starts one catch-up run when it comes back, and tells the agent how many runs it missed. Set a schedule's missed-runs option to "skip" to drop them instead.
- A new run is skipped while the previous run is still going, unless the schedule allows overlap. The reason shows on the schedule card.
- Optional: with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` (and `QSTASH_NEXT_SIGNING_KEY`) plus `BOXYARD_PUBLIC_URL`, each schedule is also created in Upstash QStash, which POSTs to `/qstash/schedules/<id>`. That request wakes a paused orchestrator box, so runs happen on time. Box Yard checks the QStash signature, and the local timer and QStash can't both start the same run.
- New schedules use `BOXYARD_TIMEZONE`, or the server's time zone if that isn't set.

**Context usage, compaction and settings.**
- Every task's header and the orchestrator panel show how full the Claude context window is (`84k / 1m · 8%`), updated after each model call. The number is the last call's input + cache + output tokens; the window comes from the CLI.
- **Compact** summarises a session in place. For a task it runs `/compact` as its own turn on the resumed session (right after the current turn if one is running, and before any queued messages). For the orchestrator it first asks the orchestrator to write a summary, saves that, then runs `/compact`.
- **Orchestrator compaction log.** Each orchestrator compaction (button or auto) writes `<data>/orchestrator/compactions/<UTC time>.md` (for example `2026-10-22T18-40-05Z.md`): frontmatter (timestamp, session id, model, trigger, tokens before and after) and four sections (decisions and preferences, projects and repos, ongoing work, open threads). The orchestrator's system prompt gives it the folder path and tells it to read the newest files when it needs history it no longer has. It gets `Read` access to that folder only. If the summary can't be written, nothing is compacted and the chat shows why.
- **Auto-compact.** The orchestrator's threshold (percent of the window, or tokens) is checked by Box Yard between turns, not by the CLI, so the summary is always written first. Turning it off leaves only the CLI's own last-resort compaction near the window limit (no log file). Box agents use the CLI's `--autocompact <tokens>` when a custom threshold is set.
- **Settings** (gear icon at the top of the orchestrator panel): model and effort (`low`, `medium`, `high`, `xhigh`, `max`) for the orchestrator and for box agents, plus the auto-compact thresholds. Box agent effort can be "Let the orchestrator decide": `create_task` and `send_to_task` then take an `effort` param (low for one-command chores, high for real coding, and so on); in a fixed mode that param doesn't exist. Defaults are `claude-opus-5-5` with `high`. `ORCHESTRATOR_MODEL` and `WORKER_MODEL` override the defaults, and values saved in the UI override both. Settings are stored in SQLite and read at the start of every turn.

**Usage and costs.**
- Every headless Claude Code run that reports result JSON is recorded in SQLite (`claude_usage`): input, cache write, cache read and output tokens, duration, model/session metadata and `total_cost_usd`. Task agent rows are tied to their task and project; orchestrator chat/compaction rows are tracked separately. Task cards show their accumulated Claude cost and tokens, and the Usage & costs page shows totals by task, project, orchestrator and time window (today, 7 days, 30 days).
- Box Yard also meters worker boxes in SQLite. When the Upstash Box API exposes real size, keep-alive or usage fields, those are used; otherwise active CPU time is estimated from periods where a turn is running, uptime is derived from the box row, and disk is probed from the box filesystem. Estimated rows are labeled as estimates in the UI.
- Default Upstash Box rates are configurable in Settings → Usage & costs: active CPU hour (Small $0.10, Medium $0.20, Large $0.40), keep-alive month (Small $8, Medium $16, Large $32), and storage ($0.10/GB-month, including snapshots). Box cards show size, active time, disk use and estimated cost.
- Optional budgets in Settings → Usage & costs warn at 80% of the daily or 30-day limit. When a configured limit is exceeded, new agent turns stay queued until the budget window resets or you raise the budget; running turns are not stopped and the orchestrator chat can still tell you what happened.

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

## Verified against real services

Checked on 2026-10-22 with a real Upstash Box account (free plan), a Claude Code OAuth token and a GitHub token, with the orchestrator deployed in its own box:

- **Box API** (`npx tsx scripts/smoke-box.ts`): create (about 5 s, Claude Code and `gh` preinstalled), exec, file write/read, env vars, a real `claude -p` turn in a box, cloning a private repo, public URLs. `scripts/boxes.ts` lists, deletes and runs commands in boxes.
- **Pausing.** Over 20 minutes, no box paused, idle or not, and a background process kept running the whole time. So agent turns survive a dropped exec connection. Keep-alive needs a paid plan.
- **Cancelling an exec stream does not stop its process in the box.** Holds are written to end on their own.
- **End-to-end scenarios through the deployed orchestrator:**
  - Issues opened on several repos in parallel, one project and one box each.
  - "Close those issues" resumed the agents that opened them.
  - A follow-up sent mid-turn was queued into the same session.
  - New work in a known project got a fresh agent on the project's box.
  - A new repo got its own box. With the pool full, it shared a box.
  - An agent's question was relayed and the answer passed back.
  - A draft PR was opened and then closed, and its branch deleted.
  - Artifacts were published with working links.
  - The server was restarted mid-turn and the agent was picked back up.
  - With the orchestrator session reset, a follow-up still found the right agent.
- **Not yet checked live:** QStash schedules (only run against a fake), Upstash Redis as the event bus (the file log was used), and archive restore onto a different box after a box is lost (covered by the local tests).
