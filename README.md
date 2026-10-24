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
- Talk to a deployed yard from the terminal with `YARD_URL=<url> YARD_PASSWORD=<password> npx tsx scripts/yardctl.ts say "..."` (also `status`, `wait`, `task <id>`, `chat`).

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

**Model/effort routing.** Box agent model and effort can be routed per task without adding UI controls. Put YAML in `<data-dir>/routing.yaml` (or `routing.yml`), or paste the same YAML into Settings → Box agents → Routing YAML. See [`docs/routing.example.yaml`](docs/routing.example.yaml) for a starter config with `fallback`, optional `defaults`, per-project defaults and semantic rules. The Coordinator and Captains read the merged rules in their system prompt and pass `model`, `effort`, `routing_rule` and `routing_reason` to `create_task` or `send_to_task` only when a `rules` entry matches or you ask for a specific model. A task shows its own route as a small read-only label, and Box Yard records the model/effort/rule of every turn in `task_turns` so cost tracking can attribute usage later.

Box Yard resolves each turn's model and effort when the turn starts (model and effort separately, first match wins), so a change to Settings or the YAML reaches existing tasks from their next turn:

1. The task's own choice: `model`/`effort` passed to `create_task`, `send_to_task` or `set_task_model`. Only these are stored on the task.
2. The routing YAML's `projects` entry for the task's project (by id, name or repo).
3. Settings → Box agents → Model and Effort, when saved there or set by `WORKER_MODEL`. Effort "Let the Coordinator decide" sets none.
4. The routing YAML's `defaults`, then its `fallback`.
5. The built-in default: `claude-opus-5-5` at `high`.

A task is not stuck on its first route. `send_to_task` accepts a new model and effort for the next turn, so a Haiku/low task can resume the same Claude session with Sonnet or Opus. `set_task_model` changes the next-turn route without sending a message. The orchestrator prompt tells it to escalate failed or looping tasks when the routing rules call for it.

**Tasks and turns.** A task's agent runs one headless turn per incoming message (`claude -p --session-id` the first time, then `--resume`). Messages that arrive while it's busy wait in a queue and go out together in the next turn. The same goes for the Coordinator and the Captains. In every chat, a message sent mid-turn shows at once at the bottom, under the live turn, labelled "Queued". When the turn that reads it starts, it moves to that point, so it sits right after the reply it was typed over and right before the reply that answers it. It stays there after a reload (`meta.queuedAt` keeps when it was sent). Each task's Claude config lives in its own folder (`CLAUDE_CONFIG_DIR`), so the session moves with the task.

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
- After every turn of a repo project, Box Yard pushes the task's branch (fast-forward only, never forced) and its uncommitted work, untracked files that aren't ignored included, to a hidden ref on origin, `refs/boxyard/wip/<task>`. It never commits in the task's repo or touches its index or HEAD. The archive then holds only what git can't carry: the Claude session, the event log, runner state and git-ignored files, so a box can be deleted at any time without losing code. Restore clones the branch, then puts the uncommitted work back, staged and unstaged as they were. The hidden ref is deleted once nothing is uncommitted, when the task closes and when it's deleted. `BOXYARD_GIT_PUSH_AT_TURN_END` (default on; also in Settings › Boxes & limits, and per project) turns it off. Without write access to the repo, the push is skipped quietly and the task's details say why.
- Without that push (it's off or failed, or the project has no repo), the whole task folder (repo, Claude session, event log) is archived to the server's disk. The archive streams off the box over the exec connection (tar → base64 → the server), so it needs no free space on the box: a box whose work disk is full can still be archived, resized, cleared or deleted. A folder over `BOXYARD_ARCHIVE_MAX_MB` (default 60, compressed) keeps only the Claude session, the event log and git history, with uncommitted work saved as a commit on `refs/boxyard/wip`. That snapshot is built in `/tmp` or on the work disk (separate disks on Upstash), whichever has more room, and never written into the repo. If even that is over the cap (a heavy history, e.g. a clone from before tasks shared the box mirror), the archive leaves out the history GitHub already has: it keeps HEAD, the branches, a `git bundle` of only the commits not on GitHub (per the box mirror's and the clone's remote-tracking refs), the uncommitted work (staged and unstaged) and the Claude session. Restore clones from the box mirror or GitHub and puts the rest back; if a commit can't be found, the restore fails with a message instead of losing it. Resize, Delete box and Clear box don't archive a done task whose PR is merged and that holds nothing unpushed: GitHub has it, so it resumes from a recap.
- Archives leave regenerable output out by name (`node_modules`, `dist`, `build`, `.cache`, `.next`, test reports like `playwright-report` and `test-results`, tool caches); tracked files in those folders are checked out again on restore. A git-first archive also leaves out the ignored scratch folders `tmp`, `.tmp`, `shots`, `perf` and `traces` (perf and test captures).
- Restores never send one file over the box's upload limit (Upstash Box: 100 MB per file): a bigger archive or attachment goes up in parts of at most 90 MB and is joined on the box, so `BOXYARD_ARCHIVE_MAX_MB` can be raised past it. A restore that fails is tried once more (not when the box refused the upload for its size). After that the task restarts from a recap on a fresh checkout of its branch, with the uncommitted work its last turn pushed put back, instead of failing every start. The archive that didn't restore is kept on the server as `archives/<task>.unrestored.tgz` (pruned like an orphan after `BOXYARD_ARCHIVE_RETENTION_DAYS`), and the Captain gets a notice.
- Once a task has rested for `BOXYARD_BUILD_CLEANUP_IDLE_MINUTES` (default 15, 0 = off; also in Settings › Boxes & limits), Box Yard removes its git-ignored build output: `node_modules`, `.next`, `dist`, `.cache`, `tmp`, perf and test captures. Only folders git ignores and doesn't track go, so uncommitted work is never touched. What it frees shows up in the box's cleanup report. After `BOXYARD_WORKSPACE_RETENTION_DAYS` idle days (default 7), the whole task folder is parked off the box and restored from the archive on the next message.
- `BOX_MAX_RESIDENT` limits how many task folders one box keeps before parking old archived ones. When you have not overridden it, the default follows the worker size: small 3, medium 8, large 18.
- `BOXYARD_ARCHIVE_RETENTION_DAYS` (default 7) prunes orphan archives and archives for long-done tasks. It never prunes the archive of a task with an open or unmerged PR, or of a task touched in the last `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS` (default 30). A done task whose archive was pruned can still take a follow-up: it starts a new Claude session from a recap (summary, branch, PR, recent messages) on a fresh checkout of its branch, or the base branch if the branch is gone. `BOX_IDLE_DELETE_MINUTES` can retire idle boxes once every resident workspace has a fresh archive.
- Each box keeps one bare mirror per repo under `.boxyard/repos`. Task checkouts borrow its git objects (`git clone --reference`, no `--dissociate`), so a task folder holds its working tree, its index and only the objects it made or fetched itself. Each task still has its own branch, config and GitHub remote. By default mirrors are partial clones (`--filter=blob:none`): old versions of files are fetched from GitHub when `git log -p`, blame or a checkout needs them. Turn that off in Settings (`BOXYARD_GIT_PARTIAL_CLONE=0`) or per project for repos whose agents dig through history a lot.
  - A mirror never prunes objects while a task folder borrows from it, and it's never removed while one does. Routine upkeep gives mirrors a light `git gc --auto` every few hours.
  - Archives stay restorable anywhere: they carry the task's own objects plus a small pack of borrowed objects GitHub no longer reaches (after a force-push or a deleted branch). A restore re-creates the box's mirror and points the clone at it.
  - Mirrors with no resident task, no project owner and no task folder borrowing from them are pruned during maintenance.
- Before a new workspace lands on a box, Box Yard checks its free disk with `df`. It needs the larger of `BOXYARD_DISK_MIN_FREE_MB` (default 1024) and `BOXYARD_DISK_CLONE_FACTOR` (default 2) × the repo's last clone size. A box short on room is skipped: the task goes to another box with room, or to a new box if the pool allows. Meanwhile the low box is cleaned up in the background. A task waits only when nothing else can take it, and then it shows "Waiting for disk cleanup on <box>" instead of failing. Cleanup first removes stale temp folders: Box Yard's archive stages and test leftovers that nothing touched in 30 minutes, in `/tmp` and `.boxyard/tmp`. Then it runs in safe steps and stops once there is room: partial clones and failed setups, npm/pip/tmp caches, git-ignored `node_modules`/build output of resting tasks, `git gc` of shared mirrors, then parking archived done workspaces. When the work disk is nearly full (under 100 MB free), two steps go first: Claude's session temp files (shell snapshots, debug logs, file-history; never transcripts) and leftover restore files, then done workspaces whose PR is merged and that hold nothing unpushed (clean `git status`, no stash, no commit missing from a remote). Those go without an archive because GitHub has everything; each removal is logged and the task resumes from a recap. Cleanup never touches uncommitted work. If a setup still runs out of space (ENOSPC, "No space left on device", git's "Out of diskspace" or "write error"), Box Yard cleans that box up and retries once, on another box if one has room. Only then does the task fail, with a message saying so. The Boxes page shows free/total disk per box, what each cleanup freed, and a **Clean up now** button. When the root disk (`/tmp` and home) is a separate one, it shows that too; while it's low (under 512 MB or a tenth free), stale temp folders and caches are swept from it every 10 minutes.
- If a resize fails, the box it made for the move is deleted (and the resize report says so). If the provider won't delete it yet, it stays on the Boxes page as "Deleting" and Box Yard retries. Boxes at the provider that Box Yard has no record of are swept every hour.
- If a box disappears, its tasks are restored from their archives onto another box. A turn that dies mid-run is retried with a "you were interrupted, check where things stand" message, up to two times.
- If a Claude session can't be found, the agent starts a fresh one with a recap of the conversation.
- When the server restarts, it reattaches to turns that are still running inside boxes.

**Agents talk to each other.** Agents can call `list_agents` and `message_agent` (optionally waiting for a reply), `suggest_note` and `read_notes` for project notes, and `ask_user` to ask you. Mid-turn, `message_captain` sends their project's Captain a scope question, a conflict or an out-of-brief bug without ending the turn, optionally waiting up to 60 s for the answer; the Captain replies with `reply_to_agent` or `send_to_task`. Messages go through Box Yard, because boxes can't reach each other directly. Agent-to-agent and agent-to-Captain messages are rate limited to stop loops.

**Project notes.** Each project keeps a small, curated set of lasting rules that every agent starts with: box gotchas, your decisions and preferences, and facts that aren't in the code. Agents can't write notes. They suggest one with `suggest_note` and say why. When a task's PR merges, or a task without one ends done, the project's Captain gets a notes retro with the task's suggestions and resolves every one itself: it accepts a suggestion, merges it into a note, or rejects it, with a one-line reason. Nothing waits for you. The project's Notes tab shows the notes and a read-only history of recent suggestions, and you can still add, edit or delete notes by hand. Prompts include notes up to a budget: Settings › Coordinator › Max notes (default 25 notes, about 4k tokens), which a project can override on its Settings tab. Over budget, agents get the newest notes that fit and the Captain is asked to prune. Settings › Coordinator › Notes retro turns the retro off.

**Previews and artifacts.** An agent starts a dev server on its own port range (`$PORT` to `$PORT+9`) and calls `report_preview`. Box Yard then asks the box for a public URL (`getPublicURL`). For files, `publish_artifact` copies the file to the server, and Box Yard hosts it at `/artifacts/...`. The agent gets the final URL back right away, so it can pass the link on.

**Pull requests.** When a turn ends on a task with a PR, Box Yard asks GitHub for its state. A merged PR marks the task done. A closed one means there's nothing left to review.

**Schedules.** A schedule is a cron job inside a project or in the Coordinator chat: a name, a 5-field cron expression (or `@hourly`, `@daily`, `@weekly`, `@monthly`), a time zone and a prompt. Project schedules start an ordinary task in that project, so you watch the run live like any other task. Coordinator schedules inject a prompt into the top-level chat for cross-project digests and reminders (internally they still use target `"orchestrator"` for compatibility). Create, pause, run now and delete schedules from the Schedules page, a project page, or the Coordinator chat (`create_schedule`, `list_schedules`, `update_schedule`, `run_schedule_now`, `delete_schedule`).

- The server's own timer checks for due schedules every 15 seconds (`BOXYARD_SCHEDULER_TICK_MS`).
- If the server was down when runs were due, it starts one catch-up run when it comes back, and tells the agent how many runs it missed. Set a schedule's missed-runs option to "skip" to drop them instead.
- A new run is skipped while the previous run is still going, unless the schedule allows overlap. The reason shows on the schedule card.
- Optional: with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` (and `QSTASH_NEXT_SIGNING_KEY`) plus `BOXYARD_PUBLIC_URL`, each schedule is also created in Upstash QStash, which POSTs to `/qstash/schedules/<id>`. That request wakes a paused Box Yard box, so runs happen on time. Box Yard checks the QStash signature, and the local timer and QStash can't both start the same run.
- New schedules use `BOXYARD_TIMEZONE`, or the server's time zone if that isn't set.

**Hooks.** A hook is an automation on task events, so routine follow-ups happen without anyone watching. It runs on `task.finished`, `task.pr_ready` (a PR was opened or pushed and the turn ended), `task.failed`, `task.needs_input`, `pr.merged` or `schedule.run_finished`. It then sends a prompt template to the same task, to the project's Captain or to the Coordinator, or starts a new task. `{task_id}`, `{task_title}`, `{project}`, `{pr_number}`, `{pr_url}`, `{branch}`, `{head_sha}`, `{status}` and `{summary}` are filled in when it fires. Filters narrow it by project, title or prompt regex, who started the task, and PR labels (with an exclude list such as `no-automerge`). Draft PRs and quiet no-op runs are skipped unless a hook includes them. Global hooks belong to the Coordinator (Settings › Hooks), and project hooks belong to the project's Captain (the project's Hooks tab). Both can be managed from chat with `create_hook`, `list_hooks`, `update_hook`, `delete_hook` and `list_hook_runs`, and a Captain's tools only reach its own project's hooks.
- The built-in **On PR ready → merge** template sends the Merge PR button's standard merge message once per head commit. It goes through the button's path, so it never runs while another merge of that PR is pending. New hooks start off.
- A hook fires once per event: per head commit for `task.pr_ready`, per PR for `pr.merged`, and per turn otherwise. It never fires on a turn its own prompt started, or on a task it created, unless it allows that. Each hook fires at most N times per task (3 by default), all hooks together at most 10 times per task a day, and at most 30 times across the yard every 10 minutes.
- Every fire goes through the normal queue, so box slots and limits apply. It shows on the task's transcript as "Hook: <name>", reaches both the Captain and the Coordinator as a 🪝 update, and is logged with its rendered prompt under Recent runs (`GET /api/hooks/runs`).

**Context usage, compaction and settings.**
- Every task's header and the Coordinator/Captain panels show how full the Claude context window is (`84k / 1m · 8%`), updated after each model call. The number is the last call's input + cache + output tokens; the window comes from the CLI.
- **Compact** summarises a session in place. For a task it runs `/compact` as its own turn on the resumed session (right after the current turn if one is running, and before any queued messages). For the Coordinator and Captains, Box Yard first asks the session to write a durable summary, saves that, then runs `/compact`.
- **Coordinator compaction history.** Each Coordinator compaction (button or auto) writes `<data>/orchestrator/compactions/<UTC time>.md` (for example `2026-10-22T18-40-05Z.md`): frontmatter (timestamp, session id, model, trigger, tokens before and after, linked task ids) and four sections (decisions and preferences, projects and repos, ongoing work, open threads). Next to it, Box Yard writes a `.json` sidecar and a SQLite record with structured metadata for tasks active or referenced since the previous compaction: title, status, project, branch, PR URL, session id and a short "what happened" summary. The `/compactions` page browses these records, and the Coordinator can call `list_compactions`, `read_compaction` and `find_compactions_by_task` through MCP when it needs history it no longer has. If the summary can't be written, nothing is compacted and the chat shows why.
- **Captain compaction logs.** Captain compactions write `<data>/captains/<project id>/compactions/<UTC time>.md`, so each project's history is tracked independently and keyed by its task ids in the summary. The Captain's system prompt gives it the folder path and tells it to read the newest files when it needs history it no longer has. The project page shows these summaries read-only.
- **Task compaction history.** Each task `/compact` turn also creates a SQLite summary keyed by task id and Claude session id. It records before/after token counts, status, the latest useful transcript context and whether the workspace archive it pointed at was available. These summaries are self-contained; archive cleanup can remove raw workspace/session tarballs later, but the compaction row remains and records when an archive is known to have been removed.
- **Auto-compact.** The Coordinator and Captain threshold (percent of the window, or tokens) is checked by Box Yard between turns, not by the CLI, so the summary is always written first. Turning it off leaves only the CLI's own last-resort compaction near the window limit (no log file). Box agents use the CLI's `--autocompact <tokens>` when a custom threshold is set.
- **Settings** (gear icon at the top of the Coordinator panel): model and effort (`low`, `medium`, `high`, `xhigh`, `max`) for the Coordinator, for the project Captains and for box agents, optional Routing YAML for per-task choices, auto-compact thresholds, worker size, pool limits and storage retention. `create_task`, `send_to_task` and `set_task_model` take optional `model` and `effort` params (picked from the routing rules, or low for one-command chores, high for real coding, and so on); a task's own model and effort override the box agent defaults. Defaults are `claude-opus-5-5` with `high`, for Captains too; Captains wake on every project event, so their separate model and effort are the knob for Captain cost. `ORCHESTRATOR_MODEL`, `WORKER_MODEL`, `CAPTAIN_MODEL`, `CAPTAIN_EFFORT`, `WORKER_SIZE`, `BOX_POOL_MAX`, `BOX_SLOTS`, `BOX_MAX_AGENTS`, `BOX_MAX_RESIDENT`, `BOX_IDLE_DELETE_MINUTES`, `BOXYARD_WORKSPACE_RETENTION_DAYS`, `BOXYARD_ARCHIVE_RETENTION_DAYS`, `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS`, `BOXYARD_DISK_MIN_FREE_MB`, `BOXYARD_DISK_CLONE_FACTOR`, `BOXYARD_GIT_PUSH_AT_TURN_END`, `BOXYARD_NOTES_MAX` and `BOXYARD_NOTES_MAX_TOKENS` override the defaults, and values saved in the UI override env. Settings are stored in SQLite and read at the start of every turn or scheduler placement.

**Usage and costs.**
- Every headless Claude Code run that reports result JSON is recorded in SQLite (`claude_usage`): input, cache write, cache read and output tokens, duration and model/session metadata. The CLI's `total_cost_usd` is the session's running total (a resumed session starts from the total its transcript saved), so it is kept as `reported_cost_usd` and each run is charged `cost_usd`, the step from the session's previous report. A resumed session's first logged run (its report also holds spend from before Box Yard logged it) is charged its tokens at the model's recent rate instead and marked `cost_estimated`. Task agent rows are tied to their task and project; Coordinator rows have no project; Captain rows are `source = 'captain'`. Spend stays when a task or project is deleted.
- The Usage page has one period selector (today, 7 days, 30 days or a custom range; `?period=&from=&to=`). It splits the period total into Coordinator, Captains, agents, schedule runs and boxes, charts spend per day (per hour for today), and breaks it down by project, task, model and source. Every breakdown sums to the period total. The API is `GET /api/usage?from=<ms>&to=<ms>` (the response's `period`); without `from` it returns the older all-time report.
- `npm run build && node scripts/usage-audit.mjs <data-dir>` prints corrected spend for today and 7 days by category next to what was logged, from a copy of the database.
- Box Yard also meters worker boxes in SQLite. When the Upstash Box API exposes real size, keep-alive or usage fields, those are used; otherwise active CPU time is estimated from periods where a turn is running, uptime is derived from the box row, and disk is probed from the box filesystem. Estimated rows are labeled as estimates in the UI.
- Default Upstash Box rates are configurable in Settings → Usage: active CPU hour (Small $0.10, Medium $0.20, Large $0.40), keep-alive month (Small $8, Medium $16, Large $32), and storage ($0.10/GB-month, including snapshots). Box cards show size, active time, disk use and estimated cost.
- Optional budgets in Settings → Usage warn at 80% of the daily or 30-day limit. When a configured limit is exceeded, new agent turns stay queued until the budget window resets or you raise the budget; running turns are not stopped and the orchestrator chat can still tell you what happened.

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

The mock Claude (`scripts/fake-claude.mjs`) speaks the same headless protocol and calls the real MCP tools. In the Coordinator chat, try `create project demo`, then `task demo: Haiku -- write a haiku [artifact]`, or `schedule demo "*/5 * * * *": Haiku drop -- write a haiku [artifact]`. Worker prompts react to `[ask]`, `[fail]`, `[slow]`, `[hang]`, `[preview]`, `[artifact]`, `[note]`, `[noop]`, `[pr]` (end the turn without mark_done, like an agent waiting on PR review) and `[agent:<taskId>]`. With `FAKE_GH_STATE` set to a file, the Merge PR message makes the worker stand in for `gh pr merge` by writing `{"state":"MERGED"}` there.

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
