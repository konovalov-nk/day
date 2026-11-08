PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  catalog TEXT NOT NULL DEFAULT 'personal',
  source TEXT NOT NULL DEFAULT 'local',
  source_id TEXT,
  spec_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (catalog, source_id)
);

CREATE TABLE IF NOT EXISTS goal_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'inbox',
  urgency TEXT,
  importance TEXT,
  goal_id INTEGER REFERENCES goals(id),
  source TEXT NOT NULL DEFAULT 'local',
  source_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS task_goals (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, goal_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'local',
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  recurrence_until TEXT,
  reminder_minutes INTEGER,
  kind TEXT NOT NULL DEFAULT 'appointment',
  task_id INTEGER REFERENCES tasks(id),
  session_id INTEGER,
  status TEXT NOT NULL DEFAULT 'confirmed',
  external_revision TEXT,
  series_id INTEGER,
  cancelled_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  goal_id INTEGER REFERENCES goals(id),
  event_id INTEGER REFERENCES events(id),
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  actual_start TEXT,
  actual_end TEXT,
  state TEXT NOT NULL DEFAULT 'planned',
  plan_revision INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_plan_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, revision)
);

CREATE TABLE IF NOT EXISTS progress_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  session_id INTEGER REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'progress',
  summary TEXT NOT NULL,
  artifact TEXT,
  created_at TEXT NOT NULL,
  operation_id TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  bucket TEXT NOT NULL,
  event_id TEXT NOT NULL,
  host TEXT,
  device TEXT,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  app TEXT,
  project TEXT,
  tmux_session TEXT,
  tmux_window TEXT,
  tmux_pane TEXT,
  url TEXT,
  idle INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  received_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, bucket, event_id)
);

CREATE TABLE IF NOT EXISTS coverage_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  device TEXT,
  watcher TEXT,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  match_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER REFERENCES observations(id),
  session_id INTEGER REFERENCES sessions(id),
  task_id INTEGER REFERENCES tasks(id),
  goal_id INTEGER REFERENCES goals(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  rule_id INTEGER,
  rule_version INTEGER,
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  method TEXT NOT NULL,
  model_version TEXT,
  uncertainty REAL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  author TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (note_id, revision)
);

CREATE TABLE IF NOT EXISTS note_links (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  PRIMARY KEY (note_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  change_text TEXT,
  metric TEXT NOT NULL,
  metric_version INTEGER NOT NULL DEFAULT 1,
  baseline_start TEXT NOT NULL,
  baseline_end TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_notes (
  experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (experiment_id, note_id)
);

CREATE TABLE IF NOT EXISTS experiment_conclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER REFERENCES goals(id),
  goal_slug TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  period_date TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  calculation_version INTEGER NOT NULL DEFAULT 1,
  thresholds_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  coverage REAL,
  final_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  UNIQUE (goal_slug, period_date, snapshot_hash)
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  ac_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  value REAL,
  threshold REAL,
  coverage REAL,
  evidence_json TEXT NOT NULL,
  UNIQUE (evaluation_id, ac_id)
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  last_checkpoint TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  checkpoint TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS capture_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorial_state (
  step TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions (task_id, planned_start);
CREATE INDEX IF NOT EXISTS idx_observations_time ON observations (start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_coverage_time ON coverage_intervals (start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_attributions_time ON attributions (start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_attributions_observation ON attributions (observation_id);
CREATE INDEX IF NOT EXISTS idx_attributions_current ON attributions (superseded_by, status);
CREATE INDEX IF NOT EXISTS idx_progress_task_time ON progress_entries (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_time ON notes (created_at);
CREATE INDEX IF NOT EXISTS idx_evaluations_period ON evaluations (goal_slug, period_date);
