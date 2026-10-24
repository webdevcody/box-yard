import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

export type DB = Database.Database

/**
 * Migrations run in order, once each. Never edit a shipped migration; add a new one.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    repo TEXT,
    base_branch TEXT NOT NULL DEFAULT 'main',
    env_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX projects_name ON projects(name COLLATE NOCASE);

  CREATE TABLE project_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX project_notes_project ON project_notes(project_id, created_at);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    box_id TEXT,
    session_id TEXT NOT NULL,
    session_started INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    pr_url TEXT,
    previews_json TEXT NOT NULL DEFAULT '[]',
    question TEXT,
    summary TEXT,
    error TEXT,
    turn_count INTEGER NOT NULL DEFAULT 0,
    port_base INTEGER,
    event_cursor TEXT,
    current_turn_id TEXT,
    turn_flags_json TEXT NOT NULL DEFAULT '{}',
    env_json TEXT NOT NULL DEFAULT '{}',
    archive_path TEXT,
    last_archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, created_at);
  CREATE INDEX tasks_status ON tasks(status);

  CREATE TABLE task_inputs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_inputs_task ON task_inputs(task_id, created_at);

  CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_messages_task ON task_messages(task_id, created_at);

  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta_json TEXT,
    seen_by_orchestrator INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chat_messages_created ON chat_messages(created_at);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE boxes (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    catch_up TEXT NOT NULL DEFAULT 'once',
    allow_overlap INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_task_id TEXT,
    last_skip_reason TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    qstash_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_due ON schedules(enabled, next_run_at);

  ALTER TABLE tasks ADD COLUMN schedule_id TEXT;
  CREATE INDEX tasks_schedule ON tasks(schedule_id, created_at);
  `,
  // Files attached to a queued input, as a JSON array of upload ids.
  `
  ALTER TABLE task_inputs ADD COLUMN attachments TEXT;
  `,
  `
  -- Schedules can target the orchestrator chat instead of a project, so project_id becomes nullable.
  CREATE TABLE schedules_new (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL DEFAULT 'project',
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    catch_up TEXT NOT NULL DEFAULT 'once',
    allow_overlap INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_task_id TEXT,
    last_skip_reason TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    qstash_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO schedules_new (id, target, project_id, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, last_run_at, last_task_id, last_skip_reason, run_count, qstash_id, created_at, updated_at)
    SELECT id, 'project', project_id, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, last_run_at, last_task_id, last_skip_reason, run_count, qstash_id, created_at, updated_at FROM schedules;
  DROP TABLE schedules;
  ALTER TABLE schedules_new RENAME TO schedules;
  CREATE INDEX schedules_due ON schedules(enabled, next_run_at);

  -- One row per orchestrator-schedule run: queued until the orchestrator is free, then running, then done or failed.
  CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'scheduled',
    prompt TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    chat_message_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id, created_at);
  `,
  `
  ALTER TABLE tasks ADD COLUMN context_tokens INTEGER;
  ALTER TABLE tasks ADD COLUMN context_window INTEGER;
  ALTER TABLE tasks ADD COLUMN compact_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN compacting INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN compact_prev_status TEXT;
  ALTER TABLE tasks ADD COLUMN effort TEXT;
  `,
  `
  -- Task finished / needs-you notifications for toasts and the sidebar's Recent list.
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project_name TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_recent ON notifications(created_at);
  CREATE INDEX notifications_task ON notifications(task_id);
  `,
  `
  -- Live pull request state, polled from GitHub: open, draft, merged or closed (NULL until first checked).
  ALTER TABLE tasks ADD COLUMN pr_state TEXT;
  ALTER TABLE tasks ADD COLUMN pr_merged_at INTEGER;
  ALTER TABLE tasks ADD COLUMN pr_merged_by TEXT;
  `,
  `
  -- Per-task routing choice and per-turn ledger for cost attribution.
  ALTER TABLE tasks ADD COLUMN model TEXT;
  ALTER TABLE tasks ADD COLUMN routing_rule TEXT;
  ALTER TABLE tasks ADD COLUMN routing_reason TEXT;

  CREATE TABLE task_turns (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    model TEXT,
    effort TEXT,
    routing_rule TEXT,
    routing_reason TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    cost_usd REAL,
    error TEXT
  );
  CREATE INDEX task_turns_task ON task_turns(task_id, started_at);
  `,
  `
  -- Durable context snapshots written before orchestrator/task compactions.
  -- These rows intentionally do not cascade from tasks: compaction history must
  -- remain readable after a task or workspace archive is deleted.
  CREATE TABLE orchestrator_compactions (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    trigger TEXT NOT NULL,
    tokens_before INTEGER,
    tokens_after INTEGER,
    markdown_path TEXT NOT NULL,
    json_path TEXT NOT NULL,
    markdown TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX orchestrator_compactions_at ON orchestrator_compactions(at);

  CREATE TABLE orchestrator_compaction_tasks (
    compaction_id TEXT NOT NULL REFERENCES orchestrator_compactions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    branch TEXT,
    pr_url TEXT,
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    last_active_at INTEGER NOT NULL,
    PRIMARY KEY (compaction_id, task_id)
  );
  CREATE INDEX orchestrator_compaction_tasks_task ON orchestrator_compaction_tasks(task_id, compaction_id);

  CREATE TABLE task_compactions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    status_before TEXT,
    status_after TEXT,
    tokens_before INTEGER,
    tokens_after INTEGER,
    summary TEXT NOT NULL,
    archive_path TEXT,
    archive_available INTEGER NOT NULL DEFAULT 0,
    archive_note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_compactions_task ON task_compactions(task_id, at);
  CREATE INDEX task_compactions_session ON task_compactions(session_id, at);
  `,
  `
  -- Claude Code result usage and costs, one row per headless CLI run that reports usage.
  CREATE TABLE claude_usage (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    run_kind TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    turn_id TEXT,
    session_id TEXT,
    model TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    raw_usage_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX claude_usage_task ON claude_usage(task_id, started_at);
  CREATE INDEX claude_usage_project ON claude_usage(project_id, started_at);
  CREATE INDEX claude_usage_started ON claude_usage(started_at);

  ALTER TABLE boxes ADD COLUMN size TEXT NOT NULL DEFAULT 'small';
  ALTER TABLE boxes ADD COLUMN keep_alive INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boxes ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boxes ADD COLUMN last_metered_at INTEGER;
  ALTER TABLE boxes ADD COLUMN disk_bytes INTEGER;
  ALTER TABLE boxes ADD COLUMN disk_updated_at INTEGER;
  ALTER TABLE boxes ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'estimated';

  -- Periodic box cost ledger. It lets the Usage page answer today / 7d / 30d
  -- without trying to reconstruct historic active time from the current box row.
  CREATE TABLE box_usage_intervals (
    id TEXT PRIMARY KEY,
    box_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    keep_alive INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    active_ms INTEGER NOT NULL DEFAULT 0,
    uptime_ms INTEGER NOT NULL DEFAULT 0,
    disk_bytes INTEGER,
    source TEXT NOT NULL DEFAULT 'estimated'
  );
  CREATE INDEX box_usage_intervals_time ON box_usage_intervals(ended_at);
  CREATE INDEX box_usage_intervals_box ON box_usage_intervals(box_id, ended_at);
  `,
  `
  -- One durable transcript per project captain. Captains are lazily created from
  -- projects, so the table only stores their chat history and unread notices.
  CREATE TABLE captain_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta_json TEXT,
    seen_by_captain INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX captain_messages_project ON captain_messages(project_id, created_at);
  CREATE INDEX captain_messages_unseen ON captain_messages(project_id, seen_by_captain);
  `,
  `
  -- The CLI's total_cost_usd is the session's running total: a resumed session starts
  -- from what its transcript saved, so summing it per run counted every earlier turn
  -- again. Keep what the CLI reported in reported_cost_usd and make cost_usd the
  -- run's own share (the step from the session's previous report).
  -- Spend also outlives its task or project now (ON DELETE SET NULL, not CASCADE).
  CREATE TABLE claude_usage_new (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    run_kind TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    turn_id TEXT,
    session_id TEXT,
    model TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    reported_cost_usd REAL NOT NULL DEFAULT 0,
    -- 1 when cost_usd is estimated from tokens: a resumed session's first logged run,
    -- whose report also carried spend from before Box Yard logged that session.
    cost_estimated INTEGER NOT NULL DEFAULT 0,
    raw_usage_json TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO claude_usage_new
    (id, source, run_kind, task_id, project_id, turn_id, session_id, model, started_at, ended_at, duration_ms,
     input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, raw_usage_json)
    SELECT id, source, run_kind, task_id, project_id, turn_id, session_id, model, started_at, ended_at, duration_ms,
     input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, cost_usd, raw_usage_json
    FROM claude_usage ORDER BY ended_at, rowid;
  DROP TABLE claude_usage;
  ALTER TABLE claude_usage_new RENAME TO claude_usage;
  CREATE INDEX claude_usage_task ON claude_usage(task_id, started_at);
  CREATE INDEX claude_usage_project ON claude_usage(project_id, started_at);
  CREATE INDEX claude_usage_started ON claude_usage(started_at);
  CREATE INDEX claude_usage_session ON claude_usage(session_id, ended_at);

  -- Older Captain rows were logged as orchestrator rows with a project id. Name them
  -- as Captain rows so they stay Captain spend if their project is deleted.
  UPDATE claude_usage SET source = 'captain' WHERE source = 'orchestrator' AND project_id IS NOT NULL;

  WITH steps AS (
    SELECT id, reported_cost_usd AS r,
      LAG(reported_cost_usd) OVER (PARTITION BY session_id ORDER BY ended_at, started_at, rowid) AS p
    FROM claude_usage WHERE session_id IS NOT NULL AND reported_cost_usd > 0
  )
  UPDATE claude_usage SET cost_usd = CASE WHEN steps.p IS NULL OR steps.r < steps.p THEN steps.r ELSE steps.r - steps.p END
  FROM steps WHERE steps.id = claude_usage.id;

  -- A session's first logged run still carries everything the session spent before
  -- usage was logged, when that run resumed an older session: the Coordinator's
  -- session, /compact and /context runs, and tasks that had turns before. Charge
  -- those runs their tokens at the model's rate from the exact rows instead.
  -- (Captain sessions started after usage logging, so their first runs are exact.)
  CREATE TEMP TABLE usage_firsts AS
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ended_at, started_at, rowid) AS n
      FROM claude_usage WHERE session_id IS NOT NULL AND reported_cost_usd > 0
    ) WHERE n = 1;
  CREATE TEMP TABLE usage_rates AS
    SELECT COALESCE(model, '') AS model, SUM(cost_usd) / SUM(total_tokens) AS rate
    FROM claude_usage WHERE total_tokens > 0 AND id NOT IN (SELECT id FROM usage_firsts)
    GROUP BY COALESCE(model, '') HAVING SUM(cost_usd) > 0;
  INSERT INTO usage_rates
    SELECT '*', SUM(cost_usd) / SUM(total_tokens) FROM claude_usage
    WHERE total_tokens > 0 AND id NOT IN (SELECT id FROM usage_firsts) HAVING SUM(cost_usd) > 0;
  UPDATE claude_usage SET cost_estimated = 1, cost_usd = MIN(cost_usd, total_tokens * COALESCE(
      (SELECT rate FROM usage_rates r WHERE r.model = COALESCE(claude_usage.model, '')),
      (SELECT rate FROM usage_rates r WHERE r.model = '*'), 0))
  WHERE id IN (SELECT id FROM usage_firsts)
    AND (run_kind != 'turn'
      OR (source = 'orchestrator' AND project_id IS NULL)
      OR (source = 'task' AND (SELECT COUNT(*) FROM task_turns tt WHERE tt.task_id = claude_usage.task_id AND tt.started_at < claude_usage.started_at) >= 2))
    AND (total_tokens = 0 OR EXISTS (SELECT 1 FROM usage_rates));
  DROP TABLE usage_firsts;
  DROP TABLE usage_rates;
  `,
  `
  -- What the agent reported about a run: 'noop' for a schedule run that found nothing to do (shared/quiet.ts).
  ALTER TABLE tasks ADD COLUMN outcome TEXT;
  `,
  `
  -- Low-disk handling: why a queued task is held back (e.g. waiting for disk cleanup on a box),
  -- and each box's free/total space from df, for placement and the Boxes page.
  ALTER TABLE tasks ADD COLUMN wait_reason TEXT;
  ALTER TABLE boxes ADD COLUMN disk_free_bytes INTEGER;
  ALTER TABLE boxes ADD COLUMN disk_total_bytes INTEGER;
  ALTER TABLE boxes ADD COLUMN disk_checked_at INTEGER;
  `,
  `
  -- "Merge PR" button: the pending merge request (JSON: prNumber, prUrl, requestedAt, deliveredAt, inputId).
  ALTER TABLE tasks ADD COLUMN merge_request_json TEXT;
  `,
  `
  -- Box resize: a project's preferred size for new boxes, and notifications about a box rather than a task
  -- (a resize the Coordinator or a Captain made), so task_id becomes optional.
  ALTER TABLE projects ADD COLUMN box_size TEXT;
  CREATE TABLE notifications_new (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project_name TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    box_id TEXT,
    href TEXT
  );
  INSERT INTO notifications_new (id, task_id, project_id, title, project_name, status, summary, created_at, read_at)
    SELECT id, task_id, project_id, title, project_name, status, summary, created_at, read_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_new RENAME TO notifications;
  CREATE INDEX notifications_recent ON notifications(created_at);
  CREATE INDEX notifications_task ON notifications(task_id);
  `,
  `
  -- Hooks (shared/hooks.ts, server/hooks.ts): automations on task events. project_id NULL is a global
  -- (Coordinator) hook; otherwise the project's Captain owns it.
  CREATE TABLE hooks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    action TEXT NOT NULL,
    task_title TEXT,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    allow_self_trigger INTEGER NOT NULL DEFAULT 0,
    max_fires_per_task INTEGER NOT NULL DEFAULT 3,
    template TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX hooks_project ON hooks(project_id, created_at);

  -- The audit log: every time a hook matched an event, what it sent and what happened. fire_key makes a
  -- fire happen once per (hook, task, event, head commit or turn).
  CREATE TABLE hook_runs (
    id TEXT PRIMARY KEY,
    hook_id TEXT REFERENCES hooks(id) ON DELETE SET NULL,
    hook_name TEXT NOT NULL,
    -- The hook's own scope when it ran (NULL: a global hook), so a Captain only reads its own hooks' runs.
    hook_project_id TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    task_title TEXT,
    event TEXT NOT NULL,
    fire_key TEXT NOT NULL,
    head_sha TEXT,
    action TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    -- Set when a guard (loop, hook_cap, task_cap, rate_limit) held a fire back; a later event may still fire.
    guard TEXT,
    result TEXT NOT NULL,
    target_task_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX hook_runs_hook ON hook_runs(hook_id, task_id, event, fire_key);
  CREATE INDEX hook_runs_project ON hook_runs(project_id, created_at);
  CREATE INDEX hook_runs_created ON hook_runs(created_at);
  CREATE INDEX hook_runs_target ON hook_runs(target_task_id);

  -- Who started a task (cody, orchestrator, captain:<project>, schedule, hook:<hook>), for hook filters,
  -- and its PR's head commit and labels, for hook idempotency and label filters.
  ALTER TABLE tasks ADD COLUMN source TEXT;
  ALTER TABLE tasks ADD COLUMN pr_head_sha TEXT;
  ALTER TABLE tasks ADD COLUMN pr_labels_json TEXT;
  `,
  `
  -- Shared git objects: a project's own choice of partial-clone (blob:none) box mirrors. NULL uses Settings.
  ALTER TABLE projects ADD COLUMN partial_clone INTEGER;
  `,
  `
  -- Curated project notes (server/notes.ts): who last edited a note and when.
  ALTER TABLE project_notes ADD COLUMN updated_at INTEGER;
  ALTER TABLE project_notes ADD COLUMN updated_by TEXT;
  -- A project's own notes budget; NULL uses Settings' (notesMaxCount / notesMaxTokens).
  ALTER TABLE projects ADD COLUMN notes_max_count INTEGER;
  ALTER TABLE projects ADD COLUMN notes_max_tokens INTEGER;

  -- Notes agents suggest with suggest_note. They never reach a prompt by themselves: the project's Captain
  -- accepts one as a note, merges it into one, or rejects it in the notes retro after the task.
  CREATE TABLE note_suggestions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    task_title TEXT NOT NULL,
    content TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    note_id TEXT,
    resolved_by TEXT,
    reason TEXT,
    -- When a retro handed it to the Captain (each suggestion goes out once).
    retro_at INTEGER,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX note_suggestions_project ON note_suggestions(project_id, status, created_at);
  CREATE INDEX note_suggestions_task ON note_suggestions(task_id, status);
  `,
  `
  -- Git-first archives: a project's own choice of pushing at turn end (NULL uses Settings), each task's last push,
  -- and free space on a box's root disk (/tmp, HOME) when it isn't the workspace disk.
  ALTER TABLE projects ADD COLUMN push_at_turn_end INTEGER;
  ALTER TABLE tasks ADD COLUMN push_state_json TEXT;
  ALTER TABLE boxes ADD COLUMN root_free_bytes INTEGER;
  ALTER TABLE boxes ADD COLUMN root_total_bytes INTEGER;
  `,
]

export function openDb(dataDir: string, file = "box-yard.sqlite"): DB {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(file === ":memory:" ? file : path.join(dataDir, file))
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  migrate(db)
  return db
}

/** Apply pending migrations, up to `upTo` of them (tests stop early to seed old-shaped rows). */
export function migrate(db: DB, upTo = MIGRATIONS.length) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
  const row = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null }
  const current = row.v ?? 0
  for (let i = current; i < Math.min(upTo, MIGRATIONS.length); i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!)
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, Date.now())
    })()
  }
}

/** Flush the WAL into the main file so a disk snapshot captures everything. */
export function checkpoint(db: DB) {
  db.pragma("wal_checkpoint(TRUNCATE)")
}
