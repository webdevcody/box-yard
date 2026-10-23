# Box Yard

One chat that runs a yard of Claude Code agents, each working inside an [Upstash Box](https://upstash.com/docs/box).

You tell the **Coordinator** what you want. It sets up **projects** (with or without a GitHub repo) and routes project work to each project's **Captain**. Captains start and follow up on **tasks**. Each task is a headless Claude Code agent with its own folder in a worker box. Agents ask you questions, message each other, open pull requests, share preview URLs and publish files. All of it shows up live in the web app. Box Yard itself can run in a box too, so you can close your laptop and the yard keeps working.

```
 ┌──────────── web app (React + TanStack Query, live over SSE) ───────────┐
 │  projects sidebar · task cards · inbox · global Coordinator chat       │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ REST + SSE
 ┌───────────────────────────────▼────────────────────────────────────────┐
 │ Box Yard server (Node + SQLite)                                        │
 │  Coordinator + per-project Captains = `claude -p --resume` + MCP tools │
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
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code login for the Coordinator, Captains and every agent. Run `claude setup-token` to get one. `ANTHROPIC_API_KEY` works too. |
| `UPSTASH_BOX_API_KEY` | Worker boxes. Without it, agents run in folders on this machine (`BOX_PROVIDER=local`). |
| `GITHUB_TOKEN` | Clone private repos, push branches, open PRs. A fine-grained token with Contents and Pull requests (read/write) is enough. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional. A faster event bus between boxes and Box Yard. |
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

**Coordinator.** Each top-level chat message runs `claude -p` with `--resume <session>`, so the conversation keeps its context across messages and restarts. The Coordinator gets Box Yard's MCP tools at `/mcp`. It handles cross-project requests and routes project-scoped work to Captains with `send_to_captain`, `ask_captain` and `wait_for_captain`.

**Captains.** Each project has one Captain: its own persistent Claude session, project notes, task history and compaction history. Captains are created lazily on first use and have no running process while idle. A Captain owns `create_task`, `send_to_task`, `wait_for_tasks`, model/effort routing and project-local follow-up for its project. Task events wake that project's Captain first; the Captain decides whether to report a concise update back to the Coordinator.

**Routing.** For each request the Coordinator and Captains decide where the work goes:

| Request | What happens |
| --- | --- |
| Follow-up on work an agent did ("close those issues", "fix that PR") | The Coordinator routes to the project's Captain, which uses `send_to_task` on that agent. Its Claude session resumes with full context, restored from the archive if it was parked. |
| Follow-up while that agent is mid-turn | Same call. The message is queued and goes out as soon as the turn ends, in the same session. |
| New, independent work in a known project | The Captain uses `create_task`: a fresh session on the project's box. `related_tasks` passes along earlier outcomes. |
| A repo with no project yet | The Coordinator uses `create_project`, then routes the work to the new Captain. One project per repo. |
| Several repos or independent pieces | The Coordinator fans out to multiple Captains; each Captain starts one or more tasks in its project. |

`list_tasks` takes a `query`, so even a fresh Captain session finds the agent that did related work. For quick work the Captain calls `wait_for_tasks` and answers in the same reply. For long work it ends its turn. When an agent finishes, fails, asks something or opens a PR, the project's Captain wakes up, checks whether a project-local next step is needed, and reports a concise result upward when Cody or the Coordinator should hear it.

**Model/effort routing.** Box agent model and effort can be routed per task without adding UI controls. Put YAML in `<data-dir>/routing.yaml` (or `routing.yml`), or paste the same YAML into Settings → Box agents → Routing YAML. See [`docs/routing.example.yaml`](docs/routing.example.yaml) for a starter config with `fallback`, optional `defaults`, per-project defaults and semantic rules. The orchestrator reads the merged rules in its system prompt and passes `model`, `effort`, `routing_rule` and `routing_reason` to `create_task` or `send_to_task`. A task shows its current route as a small read-only label, and Box Yard records the model/effort/rule on the task plus every turn in `task_turns` so cost tracking can attribute usage later.

A task is not stuck on its first route. `send_to_task` accepts a new model and effort for the next turn, so a Haiku/low task can resume the same Claude session with Sonnet or Opus. `set_task_model` changes the next-turn route without sending a message. The orchestrator prompt tells it to escalate failed or looping tasks when the routing rules call for it.

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

**Box pool.** Box Yard runs a pool of worker boxes. `WORKER_SIZE` chooses the Upstash size for newly created boxes (`small`, `medium`, or `large`). `BOX_POOL_MAX` (default 5) caps how many boxes exist, and `BOX_SLOTS` sets how many agents run at once in one box. When you have not overridden it, slots default by size: small 1, medium 2, large 4 (and resident task folders per box: small 3, medium 8, large 18). **Upgrading:** before size-based defaults every box ran 2 agents and kept 12 folders, so an install on the default `small` size now has less per-box capacity. Settings → Boxes & limits shows the effective values per size, and the Boxes page shows a one-time notice; set `BOX_SLOTS`/`BOX_MAX_RESIDENT` or pick a larger size to restore the old capacity. `BOX_MAX_AGENTS` optionally caps agents across all boxes. These are defaults: edit them live in Settings (or from the Boxes page). Lowering a limit never stops running work; it just holds back new work until usage drops. Placement keeps a project together:

1. A task goes to a box that already hosts its project (each box keeps a bare mirror of the project's repo, so later clones come from local disk).
2. Otherwise an empty box.
3. Otherwise, while the pool has room, a new box is made for that project and reserved for it.
4. Once the pool is full, projects share boxes, picking the least loaded one.

A project whose box has all its slots busy gets a second box while there's room. Tasks stay on the box they started on. If that box is busy and the task's archive is current, the task can move to a free box.

**Nothing gets lost.**
- Every transcript line, question, PR, preview, note and artifact is stored in SQLite.
- After every turn, the task folder (repo, Claude session, event log) is archived to the server's disk.
- After a task rests and has a fresh archive, Box Yard removes generated folders that archives skip anyway (`node_modules`, `.next`, build output and caches). After `BOXYARD_WORKSPACE_RETENTION_DAYS` idle days (default 7), the whole task folder is parked off the box and restored from the archive on the next message.
- `BOX_MAX_RESIDENT` limits how many task folders one box keeps before parking old archived ones. When you have not overridden it, the default follows the worker size: small 3, medium 8, large 18.
- `BOXYARD_ARCHIVE_RETENTION_DAYS` (default 7) prunes orphan archives and archives for long-done tasks. It never prunes the archive of a task with an open or unmerged PR, or of a task touched in the last `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS` (default 30). A done task whose archive was pruned can still take a follow-up: it starts a new Claude session from a recap (summary, branch, PR, recent messages) on a fresh checkout of its branch, or the base branch if the branch is gone. `BOX_IDLE_DELETE_MINUTES` can retire idle boxes once every resident workspace has a fresh archive.
- Each box keeps bare repo mirrors under `.boxyard/repos` for fast clones. Mirrors with no resident task or project owner are pruned during maintenance.
- If a box disappears, its tasks are restored from their archives onto another box. A turn that dies mid-run is retried with a "you were interrupted, check where things stand" message, up to two times.
- If a Claude session can't be found, the agent starts a fresh one with a recap of the conversation.
- When the server restarts, it reattaches to turns that are still running inside boxes.

**Agents talk to each other.** Agents can call `list_agents` and `message_agent` (optionally waiting for a reply), `save_note` and `read_notes` for project memory that every future agent sees, and `ask_user` to ask you. Messages go through Box Yard, because boxes can't reach each other directly. Agent-to-agent messages are rate limited to stop loops.

**Previews and artifacts.** An agent starts a dev server on its own port range (`$PORT` to `$PORT+9`) and calls `report_preview`. Box Yard then asks the box for a public URL (`getPublicURL`). For files, `publish_artifact` copies the file to the server, and Box Yard hosts it at `/artifacts/...`. The agent gets the final URL back right away, so it can pass the link on.

**Pull requests.** When a turn ends on a task with a PR, Box Yard asks GitHub for its state. A merged PR marks the task done. A closed one means there's nothing left to review.

**Schedules.** A schedule is a cron job inside a project or in the Coordinator chat: a name, a 5-field cron expression (or `@hourly`, `@daily`, `@weekly`, `@monthly`), a time zone and a prompt. Project schedules start an ordinary task in that project, so you watch the run live like any other task. Coordinator schedules inject a prompt into the top-level chat for cross-project digests and reminders (internally they still use target `"orchestrator"` for compatibility). Create, pause, run now and delete schedules from the Schedules page, a project page, or the Coordinator chat (`create_schedule`, `list_schedules`, `update_schedule`, `run_schedule_now`, `delete_schedule`).

- The server's own timer checks for due schedules every 15 seconds (`BOXYARD_SCHEDULER_TICK_MS`).
- If the server was down when runs were due, it starts one catch-up run when it comes back, and tells the agent how many runs it missed. Set a schedule's missed-runs option to "skip" to drop them instead.
- A new run is skipped while the previous run is still going, unless the schedule allows overlap. The reason shows on the schedule card.
- Optional: with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` (and `QSTASH_NEXT_SIGNING_KEY`) plus `BOXYARD_PUBLIC_URL`, each schedule is also created in Upstash QStash, which POSTs to `/qstash/schedules/<id>`. That request wakes a paused Box Yard box, so runs happen on time. Box Yard checks the QStash signature, and the local timer and QStash can't both start the same run.
- New schedules use `BOXYARD_TIMEZONE`, or the server's time zone if that isn't set.

**Context usage, compaction and settings.**
- Every task's header and the Coordinator/Captain panels show how full the Claude context window is (`84k / 1m · 8%`), updated after each model call. The number is the last call's input + cache + output tokens; the window comes from the CLI.
- **Compact** summarises a session in place. For a task it runs `/compact` as its own turn on the resumed session (right after the current turn if one is running, and before any queued messages). For the Coordinator and Captains, Box Yard first asks the session to write a durable summary, saves that, then runs `/compact`.
- **Coordinator compaction history.** Each Coordinator compaction (button or auto) writes `<data>/orchestrator/compactions/<UTC time>.md` (for example `2026-10-22T18-40-05Z.md`): frontmatter (timestamp, session id, model, trigger, tokens before and after, linked task ids) and four sections (decisions and preferences, projects and repos, ongoing work, open threads). Next to it, Box Yard writes a `.json` sidecar and a SQLite record with structured metadata for tasks active or referenced since the previous compaction: title, status, project, branch, PR URL, session id and a short "what happened" summary. The `/compactions` page browses these records, and the Coordinator can call `list_compactions`, `read_compaction` and `find_compactions_by_task` through MCP when it needs history it no longer has. If the summary can't be written, nothing is compacted and the chat shows why.
- **Captain compaction logs.** Captain compactions write `<data>/captains/<project id>/compactions/<UTC time>.md`, so each project's history is tracked independently and keyed by its task ids in the summary. The Captain's system prompt gives it the folder path and tells it to read the newest files when it needs history it no longer has. The project page shows these summaries read-only.
- **Task compaction history.** Each task `/compact` turn also creates a SQLite summary keyed by task id and Claude session id. It records before/after token counts, status, the latest useful transcript context and whether the workspace archive it pointed at was available. These summaries are self-contained; archive cleanup can remove raw workspace/session tarballs later, but the compaction row remains and records when an archive is known to have been removed.
- **Auto-compact.** The Coordinator and Captain threshold (percent of the window, or tokens) is checked by Box Yard between turns, not by the CLI, so the summary is always written first. Turning it off leaves only the CLI's own last-resort compaction near the window limit (no log file). Box agents use the CLI's `--autocompact <tokens>` when a custom threshold is set.
- **Settings** (gear icon at the top of the Coordinator panel): model and effort (`low`, `medium`, `high`, `xhigh`, `max`) for the Coordinator, for the project Captains and for box agents, optional Routing YAML for per-task choices, auto-compact thresholds, worker size, pool limits and storage retention. `create_task`, `send_to_task` and `set_task_model` take optional `model` and `effort` params (picked from the routing rules, or low for one-command chores, high for real coding, and so on); a task's own model and effort override the box agent defaults. Defaults are `claude-opus-5-5` with `high`, for Captains too; Captains wake on every project event, so their separate model and effort are the knob for Captain cost. `ORCHESTRATOR_MODEL`, `WORKER_MODEL`, `CAPTAIN_MODEL`, `CAPTAIN_EFFORT`, `WORKER_SIZE`, `BOX_POOL_MAX`, `BOX_SLOTS`, `BOX_MAX_AGENTS`, `BOX_MAX_RESIDENT`, `BOX_IDLE_DELETE_MINUTES`, `BOXYARD_WORKSPACE_RETENTION_DAYS`, `BOXYARD_ARCHIVE_RETENTION_DAYS` and `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS` override the defaults, and values saved in the UI override env. Settings are stored in SQLite and read at the start of every turn or scheduler placement.

**Usage and costs.**
- Every headless Claude Code run that reports result JSON is recorded in SQLite (`claude_usage`): input, cache write, cache read and output tokens, duration, model/session metadata and `total_cost_usd`. Task agent rows are tied to their task and project; Coordinator chat/compaction rows and project Captain rows (`source = 'captain'`) are tracked separately; older Captain rows, logged as orchestrator usage with a project id, still count on the Captains line. Task cards show their accumulated Claude cost and tokens, and the Usage & costs page shows totals by task, project, Coordinator, Captains and time window (today, 7 days, 30 days).
- Box Yard also meters worker boxes in SQLite. When the Upstash Box API exposes real size, keep-alive or usage fields, those are used; otherwise active CPU time is estimated from periods where a turn is running, uptime is derived from the box row, and disk is probed from the box filesystem. Estimated rows are labeled as estimates in the UI.
- Default Upstash Box rates are configurable in Settings → Usage & costs: active CPU hour (Small $0.10, Medium $0.20, Large $0.40), keep-alive month (Small $8, Medium $16, Large $32), and storage ($0.10/GB-month, including snapshots). Box cards show size, active time, disk use and estimated cost.
- Optional budgets in Settings → Usage & costs warn at 80% of the daily or 30-day limit. When a configured limit is exceeded, new agent turns stay queued until the budget window resets or you raise the budget; running turns are not stopped and the orchestrator chat can still tell you what happened.

**Event bus.** The worker runner appends every event to `events.jsonl` in the box. If Upstash Redis is configured, it also adds the event to a Redis stream. Events carry sequence numbers, so the server can read either source without duplicates. If Redis misses something, the server falls back to the file.

### Where the SQLite data lives when Box Yard runs in a box

The database is a normal SQLite file (WAL mode) on the Box Yard box's own disk, at `/workspace/home/box-yard-data`. Box disks persist across pauses and redeploys, so this is the primary copy. For an off-box copy, the server snapshots its own box every 6 hours (`BOXYARD_SELF_SNAPSHOT_HOURS`) and keeps the last 3 snapshots. It checkpoints the WAL before each snapshot. If the box is ever lost, restore it with `npm run deploy:box -- --from-snapshot <id>`.

Redis is only the message bus. It never holds the source of truth, so losing it loses nothing.

## Development

```bash
./yard dev          # API on :3000 with reload, web on :5173
npm test            # unit + end-to-end tests (fake claude, local boxes, fake Redis)
npm run typecheck
npm run worker-snapshot   # bake Claude Code into a snapshot -> WORKER_SNAPSHOT_ID for fast box starts
```

The mock Claude (`scripts/fake-claude.mjs`) speaks the same headless protocol and calls the real MCP tools. In the Coordinator chat, try `create project demo`, then `task demo: Haiku -- write a haiku [artifact]`, or `schedule demo "*/5 * * * *": Haiku drop -- write a haiku [artifact]`. Worker prompts react to `[ask]`, `[fail]`, `[slow]`, `[preview]`, `[artifact]`, `[note]` and `[agent:<taskId>]`.

| Path | What's there |
| --- | --- |
| `server/` | API, SQLite store, task manager, Coordinator/Captains, MCP tools, box providers (`upstash`, `local`) |
| `runner/box-runner.mjs` | Copied into each worker box. Runs turns and serves the agent's MCP tools, with no dependencies. |
| `web/` | The React app |
| `scripts/` | Deploy scripts and the fake Claude |

## Verified against real services

Checked on 2026-10-22 with a real Upstash Box account (free plan), a Claude Code OAuth token and a GitHub token, with Box Yard deployed in its own box:

- **Box API** (`npx tsx scripts/smoke-box.ts`): create (about 5 s, Claude Code and `gh` preinstalled), exec, file write/read, env vars, a real `claude -p` turn in a box, cloning a private repo, public URLs. `scripts/boxes.ts` lists, deletes and runs commands in boxes.
- **Pausing.** Over 20 minutes, no box paused, idle or not, and a background process kept running the whole time. So agent turns survive a dropped exec connection. Keep-alive needs a paid plan.
- **Cancelling an exec stream does not stop its process in the box.** Holds are written to end on their own.
- **End-to-end scenarios through the deployed Coordinator:**
  - Issues opened on several repos in parallel, one project and one box each.
  - "Close those issues" resumed the agents that opened them.
  - A follow-up sent mid-turn was queued into the same session.
  - New work in a known project got a fresh agent on the project's box.
  - A new repo got its own box. With the pool full, it shared a box.
  - An agent's question was relayed and the answer passed back.
  - A draft PR was opened and then closed, and its branch deleted.
  - Artifacts were published with working links.
  - The server was restarted mid-turn and the agent was picked back up.
  - With the Coordinator session reset, a follow-up still found the right agent.
- **Not yet checked live:** QStash schedules (only run against a fake), Upstash Redis as the event bus (the file log was used), and archive restore onto a different box after a box is lost (covered by the local tests).
