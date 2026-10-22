import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

export type DB = Database.Database

/**
 * Migrations run in order, once each. Never edit a shipped migration; add a new one.
 */
const MIGRATIONS: string[] = [
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

export function migrate(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
  const row = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null }
  const current = row.v ?? 0
  for (let i = current; i < MIGRATIONS.length; i++) {
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
